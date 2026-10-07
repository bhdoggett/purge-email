use crate::{error::AppError, secrets, state::TokenCache};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Service {
    Gmail,
    Jev,
}

/// Validates `raw` and returns the service plus the parsed URL that must be the one sent.
pub fn parse_allowed(raw: &str) -> Result<(Service, url::Url), AppError> {
    let refuse = || AppError::HostNotAllowed(raw.to_string());
    let url = url::Url::parse(raw).map_err(|_| refuse())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(refuse());
    }
    match url.host_str() {
        Some("gmail.googleapis.com") => Ok((Service::Gmail, url)),
        Some("api.typesafe.ai") => Ok((Service::Jev, url)),
        _ => Err(refuse()),
    }
}

/// The app only labels mail. Refuses any Gmail request that would trash, spam or delete it.
pub fn refuse_destructive_gmail(method: &str, url: &url::Url, body: Option<&str>) -> Result<(), AppError> {
    let refuse = || AppError::Invalid("The app never trashes or deletes email.".to_string());
    if method.eq_ignore_ascii_case("DELETE") {
        return Err(refuse());
    }
    let last = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    if ["trash", "batchDelete"].contains(&last) {
        return Err(refuse());
    }
    if let Some(body) = body {
        let json: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        let adds = json.get("addLabelIds").and_then(|v| v.as_array());
        if adds.is_some_and(|ids| ids.iter().any(|id| matches!(id.as_str(), Some("TRASH") | Some("SPAM")))) {
            return Err(refuse());
        }
    }
    Ok(())
}

#[cfg(test)]
fn check_url(raw: &str) -> Result<Service, AppError> {
    parse_allowed(raw).map(|(s, _)| s)
}

#[derive(Deserialize)]
pub struct ApiRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

#[tauri::command]
pub async fn api_request(req: ApiRequest, cache: tauri::State<'_, TokenCache>) -> Result<ApiResponse, AppError> {
    let (service, url) = parse_allowed(&req.url)?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| AppError::Invalid(e.to_string()))?;
    if service == Service::Gmail {
        refuse_destructive_gmail(&req.method, &url, req.body.as_deref())?;
    }

    // Gmail gets one retry with a forced token refresh after a 401.
    for attempt in 0..2 {
        let auth = match service {
            Service::Jev => format!("Bearer {}", secrets::get_jev()?),
            Service::Gmail => format!("Bearer {}", cache.access_token(attempt == 1).await?),
        };
        let mut rb = cache.http.request(method.clone(), url.clone());
        for (k, v) in &req.headers {
            if !k.eq_ignore_ascii_case("authorization") && !k.eq_ignore_ascii_case("host") {
                rb = rb.header(k, v);
            }
        }
        rb = rb.header(AUTHORIZATION, auth);
        if let Some(body) = &req.body {
            rb = rb.body(body.clone());
        }
        let res = rb.send().await?;
        let status = res.status().as_u16();
        if status == 401 && service == Service::Gmail && attempt == 0 {
            continue;
        }
        let headers = res
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
            .collect();
        let body = res.text().await?;
        return Ok(ApiResponse { status, headers, body });
    }
    Err(AppError::SignInExpired)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_gmail_and_typesafe_over_https() {
        assert_eq!(check_url("https://gmail.googleapis.com/gmail/v1/users/me/profile").unwrap(), Service::Gmail);
        assert_eq!(check_url("https://api.typesafe.ai/v1/systemone").unwrap(), Service::Jev);
    }

    #[test]
    fn refuses_other_hosts_and_plain_http() {
        for url in [
            "http://gmail.googleapis.com/gmail/v1/users/me/profile",
            "https://evil.example.com/",
            "https://gmail.googleapis.com.evil.example.com/",
            "https://api.typesafe.ai@evil.example.com/",
            "https://gmail.googleapis.com:8443/",
            "https://:p@gmail.googleapis.com/",
            "not a url",
        ] {
            assert!(matches!(check_url(url), Err(AppError::HostNotAllowed(_))), "{url}");
        }
    }

    #[test]
    fn refuses_gmail_trash_and_delete() {
        let base = "https://gmail.googleapis.com/gmail/v1/users/me";
        let url = |p: &str| url::Url::parse(&format!("{base}{p}")).unwrap();
        let refused = |m: &str, p: &str, b: Option<&str>| matches!(refuse_destructive_gmail(m, &url(p), b), Err(AppError::Invalid(_)));
        assert!(refused("POST", "/messages/abc/trash", None));
        assert!(refused("POST", "/threads/abc/trash", None));
        assert!(refused("DELETE", "/messages/abc", None));
        assert!(refused("POST", "/messages/batchDelete", Some(r#"{"ids":["a"]}"#)));
        assert!(refused("POST", "/messages/batchModify", Some(r#"{"ids":["a"],"addLabelIds":["TRASH"]}"#)));
        assert!(refused("POST", "/messages/batchModify", Some(r#"{"ids":["a"],"addLabelIds":["SPAM"]}"#)));

        assert!(!refused("POST", "/messages/batchModify", Some(r#"{"ids":["a"],"addLabelIds":["Label_1"]}"#)));
        assert!(!refused("POST", "/messages/batchModify", Some(r#"{"ids":["a"],"removeLabelIds":["Label_1"]}"#)));
        assert!(!refused("GET", "/messages?q=older_than%3A10y", None));
        assert!(!refused("POST", "/labels", Some(r#"{"name":"purge"}"#)));
    }
}

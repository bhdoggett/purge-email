use crate::{error::AppError, secrets, state::TokenCache};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Service {
    Gmail,
    Jev,
}

pub fn check_url(raw: &str) -> Result<Service, AppError> {
    let refuse = || AppError::HostNotAllowed(raw.to_string());
    let url = url::Url::parse(raw).map_err(|_| refuse())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(refuse());
    }
    match url.host_str() {
        Some("gmail.googleapis.com") => Ok(Service::Gmail),
        Some("api.typesafe.ai") => Ok(Service::Jev),
        _ => Err(refuse()),
    }
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
    let service = check_url(&req.url)?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| AppError::Invalid(e.to_string()))?;

    // Gmail gets one retry with a forced token refresh after a 401.
    for attempt in 0..2 {
        let auth = match service {
            Service::Jev => format!("Bearer {}", secrets::get_jev()?),
            Service::Gmail => format!("Bearer {}", cache.access_token(attempt == 1).await?),
        };
        let mut rb = cache.http.request(method.clone(), &req.url);
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
            "not a url",
        ] {
            assert!(matches!(check_url(url), Err(AppError::HostNotAllowed(_))), "{url}");
        }
    }
}

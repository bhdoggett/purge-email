use crate::{error::AppError, google, secrets, state::TokenCache};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

fn random_string(len: usize) -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(len).map(char::from).collect()
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Parses `GET /?code=...&state=... HTTP/1.1` into query pairs. Returns None for other paths.
fn parse_callback(request: &str) -> Option<Vec<(String, String)>> {
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    if pairs.iter().any(|(k, _)| k == "code" || k == "error") { Some(pairs) } else { None }
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, page: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

/// Waits for the callback whose `state` matches. Anything else (stray requests, idle or reset
/// sockets, mismatched state) is dropped and the listener keeps waiting.
async fn wait_for_callback(listener: &TcpListener, state: &str) -> Vec<(String, String)> {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]);
        match parse_callback(&request) {
            Some(pairs) if pairs.iter().any(|(k, v)| k == "state" && v == state) => {
                let failed = pairs.iter().any(|(k, _)| k == "error");
                let page = if failed {
                    "<html><body style=\"font-family:system-ui;padding:40px\"><h2>Sign-in was not completed.</h2><p>Return to Purge Email.</p></body></html>"
                } else {
                    "<html><body style=\"font-family:system-ui;padding:40px\"><h2>Done.</h2><p>You can close this tab and return to Purge Email.</p></body></html>"
                };
                respond(&mut stream, "200 OK", page).await;
                return pairs;
            }
            _ => respond(&mut stream, "404 Not Found", "").await,
        }
    }
}

#[tauri::command]
pub async fn google_sign_in(app: tauri::AppHandle, cache: tauri::State<'_, TokenCache>) -> Result<String, AppError> {
    let client = secrets::get_google_client()?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| AppError::Network(e.to_string()))?;
    let port = listener.local_addr().map_err(|e| AppError::Network(e.to_string()))?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_string(64);
    let state = random_string(24);

    let mut auth = url::Url::parse(AUTH_URL).expect("valid auth url");
    auth.query_pairs_mut()
        .append_pair("client_id", &client.client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", google::SCOPE)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", &state);
    app.opener()
        .open_url(auth.as_str(), None::<&str>)
        .map_err(|e| AppError::Network(e.to_string()))?;

    let pairs = tokio::time::timeout(Duration::from_secs(300), wait_for_callback(&listener, &state))
        .await
        .map_err(|_| AppError::SignInTimeout)?;
    let get = |k: &str| pairs.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    if let Some(err) = get("error") {
        return Err(AppError::Google { code: err, message: "Google declined the sign-in".into() });
    }
    let code = get("code").ok_or_else(|| AppError::Invalid("missing code".into()))?;

    let res = cache
        .http
        .post(google::TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(google::oauth_error(&body));
    }
    let tokens: google::TokenResponse = serde_json::from_str(&body).map_err(|_| AppError::Invalid("Unexpected token response from Google".into()))?;
    let refresh = tokens.refresh_token.ok_or_else(|| AppError::Invalid("Google returned no refresh token".into()))?;

    let profile = cache.http.get(PROFILE_URL).bearer_auth(&tokens.access_token).send().await?;
    let pstatus = profile.status().as_u16();
    let pbody = profile.text().await?;
    if !(200..300).contains(&pstatus) {
        return Err(google::api_error(pstatus, &pbody));
    }
    let email = serde_json::from_str::<serde_json::Value>(&pbody)
        .ok()
        .and_then(|v| v["emailAddress"].as_str().map(str::to_string))
        .ok_or_else(|| AppError::Invalid("profile has no emailAddress".into()))?;

    secrets::set(secrets::GMAIL_REFRESH, &refresh)?;
    secrets::set(secrets::GMAIL_EMAIL, &email)?;
    cache.store(tokens.access_token, Duration::from_secs(tokens.expires_in)).await;
    Ok(email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn parses_callback_and_ignores_favicon() {
        let pairs = parse_callback("GET /?code=abc&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert!(pairs.contains(&("code".into(), "abc".into())));
        assert!(parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n").is_none());
    }
}

use crate::{error::AppError, secrets};
use serde::Deserialize;
use std::time::Duration;

pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
    error_description: Option<String>,
}

/// Turns a non-2xx OAuth token response into an AppError.
pub fn oauth_error(body: &str) -> AppError {
    match serde_json::from_str::<OAuthError>(body) {
        Ok(e) if e.error == "invalid_grant" => AppError::SignInExpired,
        Ok(e) => AppError::Google { code: e.error, message: e.error_description.unwrap_or_default() },
        Err(_) => AppError::Google { code: "unknown".into(), message: body.to_string() },
    }
}

/// Reads a Google API error body and returns its most specific reason, such as
/// "accessNotConfigured" or "SERVICE_DISABLED".
pub fn api_error(status: u16, body: &str) -> AppError {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let err = &v["error"];
    let reason = err["details"][0]["reason"]
        .as_str()
        .or_else(|| err["errors"][0]["reason"].as_str())
        .or_else(|| err["status"].as_str())
        .unwrap_or("unknown");
    let message = err["message"].as_str().unwrap_or(body);
    AppError::Google { code: reason.to_string(), message: format!("{status}: {message}") }
}

pub async fn refresh_access_token(http: &reqwest::Client) -> Result<(String, Duration), AppError> {
    let client = secrets::get_google_client()?;
    let refresh = secrets::get(secrets::GMAIL_REFRESH)?.ok_or(AppError::SignInExpired)?;
    let res = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(oauth_error(&body));
    }
    let t: TokenResponse = serde_json::from_str(&body).map_err(|_| AppError::Invalid("Unexpected token response from Google".into()))?;
    Ok((t.access_token, Duration::from_secs(t.expires_in)))
}

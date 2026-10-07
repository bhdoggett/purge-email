use crate::error::AppError;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.purge-email";
pub const JEV: &str = "jev";
pub const GOOGLE_CLIENT: &str = "google_client";
pub const GMAIL_REFRESH: &str = "gmail_refresh_token";
pub const GMAIL_EMAIL: &str = "gmail_email";

fn entry(name: &str) -> Result<keyring::Entry, AppError> {
    Ok(keyring::Entry::new(SERVICE, name)?)
}

pub fn set(name: &str, value: &str) -> Result<(), AppError> {
    entry(name)?.set_password(value)?;
    Ok(())
}

pub fn get(name: &str) -> Result<Option<String>, AppError> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(name: &str) -> Result<(), AppError> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn get_jev() -> Result<String, AppError> {
    get(JEV)?.ok_or_else(|| AppError::NotConfigured("jev".into()))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: String,
}

pub fn get_google_client() -> Result<GoogleClient, AppError> {
    let raw = get(GOOGLE_CLIENT)?.ok_or_else(|| AppError::NotConfigured("google_client".into()))?;
    serde_json::from_str(&raw).map_err(|_| AppError::Invalid("Saved Google client is malformed".into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    jev: bool,
    google_client: bool,
    gmail_email: Option<String>,
}

#[tauri::command]
pub fn save_secret(kind: String, value: String) -> Result<(), AppError> {
    let value = value.trim();
    match kind.as_str() {
        JEV => {
            if value.is_empty() {
                return Err(AppError::Invalid("Jev key is empty".into()));
            }
            set(JEV, value)
        }
        GOOGLE_CLIENT => {
            let client: GoogleClient =
                serde_json::from_str(value).map_err(|e| AppError::Invalid(e.to_string()))?;
            if !client.client_id.ends_with(".apps.googleusercontent.com") {
                return Err(AppError::Invalid("Client ID should end with .apps.googleusercontent.com".into()));
            }
            set(GOOGLE_CLIENT, value)
        }
        other => Err(AppError::Invalid(format!("unknown secret kind {other}"))),
    }
}

#[tauri::command]
pub fn secrets_status() -> Result<Status, AppError> {
    Ok(Status {
        jev: get(JEV)?.is_some(),
        google_client: get(GOOGLE_CLIENT)?.is_some(),
        gmail_email: if get(GMAIL_REFRESH)?.is_some() { get(GMAIL_EMAIL)? } else { None },
    })
}

#[tauri::command]
pub async fn sign_out(cache: tauri::State<'_, crate::state::TokenCache>) -> Result<(), AppError> {
    delete(GMAIL_REFRESH)?;
    delete(GMAIL_EMAIL)?;
    cache.clear().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_secrets(cache: tauri::State<'_, crate::state::TokenCache>) -> Result<(), AppError> {
    for name in [JEV, GOOGLE_CLIENT, GMAIL_REFRESH, GMAIL_EMAIL] {
        delete(name)?;
    }
    cache.clear().await;
    Ok(())
}

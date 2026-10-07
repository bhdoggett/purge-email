use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "dev.purge-email";
pub const JEV: &str = "jev";
pub const GOOGLE_CLIENT: &str = "google_client";
pub const GMAIL_REFRESH: &str = "gmail_refresh_token";
pub const GMAIL_EMAIL: &str = "gmail_email";

/// All secrets live in ONE Keychain item, read once per launch and cached in memory.
/// macOS asks for permission per item and per build, so one item means one prompt
/// instead of one per secret (and none on repeat reads).
const VAULT: &str = "vault";
/// Older builds stored each secret as its own item; read once to migrate.
const LEGACY: [&str; 4] = [JEV, GOOGLE_CLIENT, GMAIL_REFRESH, GMAIL_EMAIL];

static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn entry(name: &str) -> Result<keyring::Entry, AppError> {
    Ok(keyring::Entry::new(SERVICE, name)?)
}

fn read_item(name: &str) -> Result<Option<String>, AppError> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_vault(map: &HashMap<String, String>) -> Result<(), AppError> {
    let json = serde_json::to_string(map).map_err(|e| AppError::Keychain(e.to_string()))?;
    entry(VAULT)?.set_password(&json)?;
    Ok(())
}

fn load_vault() -> Result<HashMap<String, String>, AppError> {
    if let Some(raw) = read_item(VAULT)? {
        return serde_json::from_str(&raw).map_err(|_| AppError::Keychain("Saved keys are unreadable".into()));
    }
    // First run after upgrading: fold the old per-secret items into the vault, then remove them.
    let mut map = HashMap::new();
    for name in LEGACY {
        if let Some(v) = read_item(name)? {
            map.insert(name.to_string(), v);
        }
    }
    if !map.is_empty() {
        write_vault(&map)?;
        for name in LEGACY {
            let _ = entry(name).map(|e| e.delete_credential());
        }
    }
    Ok(map)
}

/// Runs `f` on the cached vault, loading it from the Keychain on first use.
fn with_vault<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> Result<T, AppError> {
    let mut guard = CACHE.lock().map_err(|_| AppError::Keychain("Key cache is unavailable".into()))?;
    if guard.is_none() {
        *guard = Some(load_vault()?);
    }
    Ok(f(guard.as_mut().expect("vault loaded")))
}

pub fn set(name: &str, value: &str) -> Result<(), AppError> {
    let mut guard = CACHE.lock().map_err(|_| AppError::Keychain("Key cache is unavailable".into()))?;
    let mut map = match guard.take() {
        Some(m) => m,
        None => load_vault()?,
    };
    map.insert(name.to_string(), value.to_string());
    let result = write_vault(&map);
    *guard = Some(map);
    result
}

pub fn get(name: &str) -> Result<Option<String>, AppError> {
    with_vault(|m| m.get(name).cloned())
}

pub fn delete(name: &str) -> Result<(), AppError> {
    let mut guard = CACHE.lock().map_err(|_| AppError::Keychain("Key cache is unavailable".into()))?;
    let mut map = match guard.take() {
        Some(m) => m,
        None => load_vault()?,
    };
    let existed = map.remove(name).is_some();
    let result = if existed { write_vault(&map) } else { Ok(()) };
    *guard = Some(map);
    result
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

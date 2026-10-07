use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "dev.purge-email";
pub const JEV: &str = "jev";
pub const GOOGLE_CLIENT: &str = "google_client";
pub const GMAIL_REFRESH: &str = "gmail_refresh_token";
pub const GMAIL_EMAIL: &str = "gmail_email";
/// Base64 AES-256 key the web view uses to encrypt email data in IndexedDB.
pub const LOCAL_DATA_KEY: &str = "local_data_key";
/// Removed by sign out; the local data key stays so saved scan data remains readable.
const SIGN_IN_SECRETS: [&str; 2] = [GMAIL_REFRESH, GMAIL_EMAIL];
/// Removed by a full reset.
const ALL_SECRETS: [&str; 5] = [JEV, GOOGLE_CLIENT, GMAIL_REFRESH, GMAIL_EMAIL, LOCAL_DATA_KEY];

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

/// Runs `f` on the vault and saves it when `f` reports a change. If saving fails the
/// cache is put back as it was, so it never holds something the Keychain doesn't.
fn modify_vault<T>(f: impl FnOnce(&mut HashMap<String, String>) -> (T, bool)) -> Result<T, AppError> {
    let mut guard = CACHE.lock().map_err(|_| AppError::Keychain("Key cache is unavailable".into()))?;
    let before = match guard.take() {
        Some(m) => m,
        None => load_vault()?,
    };
    let mut map = before.clone();
    let (out, changed) = f(&mut map);
    if changed {
        if let Err(e) = write_vault(&map) {
            *guard = Some(before);
            return Err(e);
        }
    }
    *guard = Some(map);
    Ok(out)
}

/// Returns the local data key, adding a new random one to `vault` if missing (true when added).
fn ensure_data_key(vault: &mut HashMap<String, String>) -> (String, bool) {
    if let Some(k) = vault.get(LOCAL_DATA_KEY) {
        return (k.clone(), false);
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    let key = STANDARD.encode(bytes);
    vault.insert(LOCAL_DATA_KEY.to_string(), key.clone());
    (key, true)
}

/// Removes `names` from `vault`; true if anything was there.
fn remove_all(vault: &mut HashMap<String, String>, names: &[&str]) -> bool {
    names.iter().fold(false, |changed, name| vault.remove(*name).is_some() || changed)
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
    modify_vault(|m| ((), remove_all(m, &SIGN_IN_SECRETS)))?;
    cache.clear().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_secrets(cache: tauri::State<'_, crate::state::TokenCache>) -> Result<(), AppError> {
    modify_vault(|m| ((), remove_all(m, &ALL_SECRETS)))?;
    cache.clear().await;
    Ok(())
}

/// The key for encrypting email data at rest, created on first use. Returns only this key.
#[tauri::command]
pub fn local_data_key() -> Result<String, AppError> {
    modify_vault(ensure_data_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_data_key_is_created_once_and_then_reused() {
        let mut vault = HashMap::from([(JEV.to_string(), "jev-secret".to_string())]);
        let (first, created) = ensure_data_key(&mut vault);
        assert!(created);
        assert_eq!(STANDARD.decode(&first).unwrap().len(), 32);
        assert_eq!(vault.get(LOCAL_DATA_KEY), Some(&first));
        let (second, created) = ensure_data_key(&mut vault);
        assert!(!created);
        assert_eq!(first, second);
        assert_ne!(first, "jev-secret");
        assert_ne!(ensure_data_key(&mut HashMap::new()).0, first, "keys are random");
    }

    #[test]
    fn clearing_secrets_drops_the_local_data_key_but_sign_out_keeps_it() {
        assert!(ALL_SECRETS.contains(&LOCAL_DATA_KEY));
        assert!(!SIGN_IN_SECRETS.contains(&LOCAL_DATA_KEY));
        let mut vault = HashMap::new();
        for name in ALL_SECRETS {
            vault.insert(name.to_string(), "v".to_string());
        }
        let mut signed_out = vault.clone();
        assert!(remove_all(&mut signed_out, &SIGN_IN_SECRETS));
        assert!(signed_out.contains_key(LOCAL_DATA_KEY));
        assert!(remove_all(&mut vault, &ALL_SECRETS));
        assert!(vault.is_empty());
        assert!(!remove_all(&mut vault, &ALL_SECRETS));
    }
}

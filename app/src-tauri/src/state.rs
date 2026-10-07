use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct TokenCache {
    pub http: reqwest::Client,
    inner: Mutex<Option<(String, Instant)>>,
}

impl TokenCache {
    pub fn new() -> Self {
        Self { http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client"), inner: Mutex::new(None) }
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = None;
    }

    pub async fn store(&self, token: String, ttl: Duration) {
        *self.inner.lock().await = Some((token, Instant::now() + ttl));
    }

    /// Returns a cached token that is valid for at least another minute.
    pub async fn cached(&self) -> Option<String> {
        let guard = self.inner.lock().await;
        match &*guard {
            Some((t, exp)) if Instant::now() + Duration::from_secs(60) < *exp => Some(t.clone()),
            _ => None,
        }
    }
}

impl TokenCache {
    /// Returns a usable access token, refreshing it when missing, near expiry, or `force` is set.
    pub async fn access_token(&self, force: bool) -> Result<String, crate::error::AppError> {
        if !force {
            if let Some(t) = self.cached().await {
                return Ok(t);
            }
        }
        let (token, ttl) = crate::google::refresh_access_token(&self.http).await?;
        self.store(token.clone(), ttl).await;
        Ok(token)
    }
}

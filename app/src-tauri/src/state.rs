use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct TokenCache {
    pub http: reqwest::Client,
    inner: Mutex<Option<(String, Instant)>>,
}

impl TokenCache {
    pub fn new() -> Self {
        Self { http: reqwest::Client::new(), inner: Mutex::new(None) }
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

use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct TokenCache {
    pub http: reqwest::Client,
    inner: Mutex<Option<(String, Instant)>>,
}

/// Shared HTTP client. Timeouts make a stalled connection fail as `AppError::Network`
/// (which the Gmail client retries) instead of hanging forever.
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .expect("http client")
}

impl TokenCache {
    pub fn new() -> Self {
        Self { http: build_http_client(), inner: Mutex::new(None) }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stalled_server_times_out_as_network_error() {
        // A listener that accepts but never answers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        });
        let client = reqwest::Client::builder().timeout(Duration::from_millis(200)).build().unwrap();
        let err = client.get(format!("http://{addr}/")).send().await.unwrap_err();
        assert!(err.is_timeout());
        let app: crate::error::AppError = err.into();
        assert!(matches!(app, crate::error::AppError::Network(_)));
        // The real client builds with timeouts configured.
        let _ = build_http_client();
    }
}

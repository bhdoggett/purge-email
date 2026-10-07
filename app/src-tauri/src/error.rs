use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AppError {
    #[error("Google sign-in expired")]
    SignInExpired,
    #[error("Sign-in window timed out")]
    SignInTimeout,
    #[error("Missing credential: {0}")]
    NotConfigured(String),
    #[error("Host not allowed: {0}")]
    HostNotAllowed(String),
    #[error("Google error {code}: {message}")]
    Google { code: String, message: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Keychain error: {0}")]
    Keychain(String),
    #[error("Invalid input: {0}")]
    Invalid(String),
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keychain(e.to_string())
    }
}

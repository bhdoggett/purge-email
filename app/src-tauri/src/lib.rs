mod error;
mod google;
mod oauth;
mod proxy;
mod secrets;
mod state;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state::TokenCache::new())
        .invoke_handler(tauri::generate_handler![
            secrets::save_secret,
            secrets::secrets_status,
            secrets::sign_out,
            secrets::clear_secrets,
            proxy::api_request,
            oauth::google_sign_in,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

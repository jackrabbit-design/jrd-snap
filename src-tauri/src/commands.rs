use crate::settings::{self, CredentialStore, Credentials, KeyringCredentialStore, UploadSettings};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_upload_settings(app: AppHandle) -> UploadSettings {
    settings::load_settings(&app.path().app_config_dir().unwrap())
}

#[tauri::command]
pub fn save_upload_settings(app: AppHandle, settings: UploadSettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_settings(&dir, &settings)
}

#[tauri::command]
pub fn save_credentials(access_key_id: String, secret_access_key: String) -> Result<(), String> {
    KeyringCredentialStore.set(&Credentials { access_key_id, secret_access_key })
}

#[tauri::command]
pub fn has_credentials() -> bool {
    KeyringCredentialStore.get().is_some()
}

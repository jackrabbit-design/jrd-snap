use crate::capture::{self, CaptureRect};
use crate::settings::{
    self, CredentialStore, Credentials, HotkeySettings, KeyringCredentialStore, UploadSettings,
};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_upload_settings(app: AppHandle) -> Result<UploadSettings, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(settings::load_settings(&dir))
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

#[tauri::command]
pub fn get_hotkey_settings(app: AppHandle) -> Result<HotkeySettings, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(settings::load_hotkeys(&dir))
}

#[tauri::command]
pub fn save_hotkey_settings(app: AppHandle, hotkeys: HotkeySettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_hotkeys(&dir, &hotkeys)?;
    crate::register_shortcuts(&app)
}

#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn capture_full_screen() -> Result<Vec<u8>, String> {
    capture::capture_full_screen_png()
}

#[tauri::command]
pub fn capture_area(rect: CaptureRect) -> Result<Vec<u8>, String> {
    capture::capture_area_png(rect)
}

use crate::capture::{self, CaptureRect};
use crate::filename;
use crate::object_key::build_object_key;
use crate::settings::{
    self, CredentialStore, Credentials, HotkeySettings, KeyringCredentialStore, UploadSettings,
};
use crate::upload::{build_public_url, upload_object};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size};

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

    // Size/position the overlay to cover the primary monitor explicitly rather
    // than using native `fullscreen`, which triggers a macOS Space transition
    // and can force the window visible even when created with `visible: false`.
    if let Some(monitor) = win.primary_monitor().map_err(|e| e.to_string())? {
        let position = monitor.position();
        let size = monitor.size();
        win.set_position(Position::Physical(PhysicalPosition::new(position.x, position.y)))
            .map_err(|e| e.to_string())?;
        win.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)))
            .map_err(|e| e.to_string())?;
    }

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

#[tauri::command]
pub async fn upload_file(app: AppHandle, bytes: Vec<u8>, extension: String) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let settings = settings::load_settings(&config_dir);
    let creds = KeyringCredentialStore
        .get()
        .ok_or("no upload credentials configured — open Settings and add them")?;

    let name = filename::generate_filename(settings.filename_prefix.as_deref(), &extension);
    let key = build_object_key(settings.key_prefix.as_deref(), &name);
    let content_type = if extension == "png" { "image/png" } else { "application/octet-stream" };

    upload_object(&settings, &creds, &key, bytes, content_type).await?;

    Ok(build_public_url(&settings, &key))
}

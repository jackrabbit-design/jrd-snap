use crate::capture::{self, CaptureRect};
use crate::filename;
use crate::object_key::build_object_key;
use crate::recording::{self, CaptureRegion, RecordingState};
use crate::settings::{
    self, CredentialStore, Credentials, HotkeySettings, KeyringCredentialStore, UploadSettings,
};
use crate::upload::{build_public_url, upload_object};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State};

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

// Size/position the overlay to cover the primary monitor explicitly rather
// than using native `fullscreen`, which triggers a macOS Space transition
// and can force the window visible even when created with `visible: false`.
fn resize_overlay_to_monitor(win: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(monitor) = win.primary_monitor().map_err(|e| e.to_string())? {
        let position = monitor.position();
        let size = monitor.size();
        win.set_position(Position::Physical(PhysicalPosition::new(position.x, position.y)))
            .map_err(|e| e.to_string())?;
        win.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    crate::discard_any_active_recording(&app);
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    resize_overlay_to_monitor(&win)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("overlay", "overlay-mode", serde_json::json!({ "purpose": "screenshot" }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_overlay_for_recording(app: AppHandle, area: bool) -> Result<(), String> {
    crate::discard_any_active_recording(&app);
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    resize_overlay_to_monitor(&win)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("overlay", "overlay-mode", serde_json::json!({ "purpose": "record", "area": area }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn capture_full_screen(app: AppHandle) -> Result<Vec<u8>, String> {
    crate::discard_any_active_recording(&app);
    capture::capture_full_screen_png()
}

#[tauri::command]
pub fn capture_area(app: AppHandle, rect: CaptureRect) -> Result<Vec<u8>, String> {
    crate::discard_any_active_recording(&app);
    capture::capture_area_png(rect)
}

async fn upload_bytes(app: &AppHandle, bytes: Vec<u8>, extension: &str) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let settings = settings::load_settings(&config_dir);
    let creds = KeyringCredentialStore
        .get()
        .ok_or("no upload credentials configured — open Settings and add them")?;

    let name = filename::generate_filename(settings.filename_prefix.as_deref(), extension);
    let key = build_object_key(settings.key_prefix.as_deref(), &name);
    let content_type = match extension {
        "png" => "image/png",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    };

    upload_object(&settings, &creds, &key, bytes, content_type).await?;

    Ok(build_public_url(&settings, &key))
}

#[tauri::command]
pub async fn upload_file(app: AppHandle, bytes: Vec<u8>, extension: String) -> Result<String, String> {
    upload_bytes(&app, bytes, &extension).await
}

#[tauri::command]
pub async fn trim_and_upload(
    app: AppHandle,
    input_path: String,
    in_point: f64,
    out_point: f64,
) -> Result<String, String> {
    let input = std::path::PathBuf::from(&input_path);
    let output = std::env::temp_dir().join(format!("pxl-trimmed-{}.mp4", std::process::id()));
    crate::trim::trim_video(&input, &output, in_point, out_point)?;
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    let url = upload_bytes(&app, bytes, "mp4").await?;
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&input);
    Ok(url)
}

#[tauri::command]
pub fn start_recording_command(
    state: State<RecordingState>,
    region: Option<CaptureRegion>,
    mic_enabled: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("a recording is already in progress".to_string());
    }
    let output_path = std::env::temp_dir().join(format!("pxl-recording-{}.mp4", std::process::id()));
    let child = recording::start_recording(region, mic_enabled, &output_path)?;
    *guard = Some((child, output_path.clone()));
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn stop_recording_command(state: State<RecordingState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let (child, _path) = guard.take().ok_or("no recording in progress")?;
    recording::stop_recording(child)
}

#[tauri::command]
pub fn reopen_last_capture(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("editor").ok_or("editor window missing")?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

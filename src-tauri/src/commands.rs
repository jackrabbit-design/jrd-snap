use crate::capture::{self, CaptureRect};
use crate::filename;
use crate::object_key::build_object_key;
use crate::recording::{self, CaptureRegion, RecordingState};
use crate::settings::{
    self, CredentialStore, Credentials, HotkeySettings, KeyringCredentialStore, UploadSettings,
};
use crate::upload::{build_public_url, upload_object};
use tauri::{AppHandle, Emitter, Manager, Position, Size, State};

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
    crate::tray::update_tray_accelerators(&app, &hotkeys);
    crate::register_shortcuts(&app)
}

// Finds the index (into both `app.available_monitors()` and, by assumption,
// `xcap::Monitor::all()`) of whichever monitor contains the given point —
// e.g. the cursor position, or the overlay window's own position once it's
// been placed on a monitor. Falls back to the primary monitor's index if the
// point doesn't land on any of them (should only happen at a rounding edge
// case). Deliberately uses only Tauri's own monitor APIs for this geometry
// check — they're self-consistent physical-pixel coordinates guaranteed to
// match `set_position`/`set_size`, unlike `xcap::Monitor`'s x/y/width/height
// (whose units vary by platform, e.g. points on macOS) which don't line up
// with Tauri's coordinates on secondary/differently-scaled monitors.
pub(crate) fn monitor_index_at(app: &AppHandle, x: i32, y: i32) -> Result<usize, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if let Some(index) = monitors.iter().position(|m| {
        let pos = m.position();
        let size = m.size();
        x >= pos.x && x < pos.x + size.width as i32 && y >= pos.y && y < pos.y + size.height as i32
    }) {
        return Ok(index);
    }
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    Ok(match primary {
        Some(primary) => monitors
            .iter()
            .position(|m| m.position() == primary.position() && m.size() == primary.size())
            .unwrap_or(0),
        None => 0,
    })
}

// Size/position the overlay to cover whichever monitor the cursor is
// currently on, explicitly, rather than using native `fullscreen` (which
// triggers a macOS Space transition and can force the window visible even
// when created with `visible: false`) or always the primary monitor (which
// left area-selection and full-screen capture unusable on any other
// display).
fn resize_overlay_to_monitor(win: &tauri::WebviewWindow) -> Result<(), String> {
    let app = win.app_handle();
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let index = monitor_index_at(app, cursor.x as i32, cursor.y as i32)?;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors.get(index).ok_or("no monitor found")?;
    win.set_position(Position::Physical(*monitor.position()))
        .map_err(|e| e.to_string())?;
    win.set_size(Size::Physical(*monitor.size()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    crate::discard_any_active_recording(&app);
    crate::set_capture_tray_icon(&app, crate::CaptureIconState::Progress);
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    resize_overlay_to_monitor(&win)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("overlay", "overlay-mode", serde_json::json!({ "purpose": "screenshot" }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_overlay_for_recording(app: AppHandle) -> Result<(), String> {
    crate::discard_any_active_recording(&app);
    crate::set_capture_tray_icon(&app, crate::CaptureIconState::Progress);
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    resize_overlay_to_monitor(&win)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("overlay", "overlay-mode", serde_json::json!({ "purpose": "record" }))
        .map_err(|e| e.to_string())
}

// Called by the frontend at the explicit cancel points that don't otherwise
// reach the backend (Escape, clicking without dragging, the record confirm
// panel's Cancel button) — everything else that ends a capture (upload
// success, editor closed unsaved, a start/stop/crash failure) reverts the
// icon on its own from the Rust side that already handles that event.
#[tauri::command]
pub fn reset_capture_icon(app: AppHandle) {
    crate::set_capture_tray_icon(&app, crate::CaptureIconState::Default);
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn capture_full_screen(app: AppHandle) -> Result<Vec<u8>, String> {
    crate::discard_any_active_recording(&app);
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let index = monitor_index_at(&app, cursor.x as i32, cursor.y as i32)?;
    capture::capture_full_screen_png(index)
}

#[tauri::command]
pub fn capture_area(app: AppHandle, rect: CaptureRect) -> Result<Vec<u8>, String> {
    crate::discard_any_active_recording(&app);
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let index = monitor_index_at(&app, cursor.x as i32, cursor.y as i32)?;
    capture::capture_area_png(rect, index)
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

    crate::flash_success_tray_icon(app);
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
    // A random suffix, not the process id — the pid is constant for the
    // whole session, so a second trim in one session would otherwise reuse
    // the exact same filename.
    let output = std::env::temp_dir().join(format!("snap-trimmed-{}.mp4", nanoid::nanoid!(8)));
    crate::trim::trim_video(&input, &output, in_point, out_point)?;
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    let url = upload_bytes(&app, bytes, "mp4").await?;
    let _ = std::fs::remove_file(&output);
    Ok(url)
}

#[tauri::command]
pub fn start_recording_command(
    app: AppHandle,
    state: State<RecordingState>,
    region: Option<CaptureRegion>,
    mic_enabled: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("a recording is already in progress".to_string());
    }
    // A random suffix, not the process id — the pid is constant for the
    // whole session, so a second recording would otherwise reuse the exact
    // same filename as the first (which is deliberately left on disk after
    // upload, for Reopen Last Capture). ffmpeg has no `-y` overwrite flag
    // here and its stdin is piped (non-interactive), so writing to an
    // existing path makes it refuse and exit almost immediately — which the
    // crash monitor then (correctly, but misleadingly) reports as a crash.
    let output_path =
        std::env::temp_dir().join(format!("snap-recording-{}.mp4", nanoid::nanoid!(8)));
    let child = match recording::start_recording(region, mic_enabled, &output_path) {
        Ok(child) => child,
        Err(e) => {
            crate::notify_capture_failed(&app, &format!("failed to start recording: {e}"));
            crate::set_capture_tray_icon(&app, crate::CaptureIconState::Default);
            return Err(e);
        }
    };
    *guard = Some((child, output_path.clone()));
    drop(guard);
    crate::set_recording_tray_state(&app, true);
    if let Some(region) = region {
        crate::show_recording_controls(&app, region);
    }
    let handle_monitor = app.clone();
    let monitor_path = output_path.clone();
    std::thread::spawn(move || {
        crate::monitor_recording_for_crash(&handle_monitor, monitor_path);
    });
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
    win.set_focus().map_err(|e| e.to_string())?;
    crate::set_capture_tray_icon(&app, crate::CaptureIconState::Progress);
    Ok(())
}

// Reads a recording/trimmed video file's bytes so the frontend can build a
// `blob:` URL for the `<video>` preview. This deliberately avoids Tauri's
// `asset://` protocol + `convertFileSrc` — in dev mode the app is served
// from a plain `http://localhost:1420` origin, and WebKit refuses to load a
// custom-scheme resource from that origin ("Unsafe attempt to load URL"),
// even with the asset protocol's scope correctly configured. `blob:` URLs
// have no such restriction and work identically in dev and production.
#[tauri::command]
pub fn read_video_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LastCapturePayload {
    Image { png_base64: String },
    Video { path: String },
}

// The editor window is created once and never destroyed (hidden on close),
// so its "editor-load-image"/"editor-load-video" listeners are normally
// live well before any capture happens. As a fallback for the case where the
// editor's very first show races its own listener registration, the editor
// calls this once on mount to pull whatever was last captured, rather than
// relying solely on the one-shot emit.
#[tauri::command]
pub fn get_last_capture(app: AppHandle) -> Option<LastCapturePayload> {
    let state = app.state::<crate::LastCaptureState>();
    let guard = state.0.lock().unwrap();
    guard.as_ref().map(|c| match c {
        crate::LastCapture::Image { png_base64 } => {
            LastCapturePayload::Image { png_base64: png_base64.clone() }
        }
        crate::LastCapture::Video { path } => {
            LastCapturePayload::Video { path: path.to_string_lossy().to_string() }
        }
    })
}

#[tauri::command]
pub fn record_capture_history(app: AppHandle, kind: String, url: String, thumbnail: String) {
    crate::record_capture_history(&app, kind, url, thumbnail);
}

#[tauri::command]
pub fn get_capture_history(app: AppHandle) -> Vec<crate::CaptureHistoryEntry> {
    let state = app.state::<crate::CaptureHistoryState>();
    let history = state.0.lock().unwrap();
    history.iter().cloned().collect()
}

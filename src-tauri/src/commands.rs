use crate::capture::{self, CaptureRect};
use crate::filename;
use crate::object_key::build_object_key;
use crate::recording::{self, CaptureRegion, RecordingState};
use crate::settings::{
    self, CredentialStore, Credentials, HotkeySettings, KeyringCredentialStore, UploadSettings,
};
use crate::upload::{build_public_url, upload_object};
use tauri::{
    AppHandle, Emitter, Manager, Position, Size, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

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
    KeyringCredentialStore.set(&Credentials {
        access_key_id,
        secret_access_key,
    })
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

const OVERLAY_LABEL_PREFIX: &str = "overlay-";

fn overlay_label(index: usize) -> String {
    format!("{OVERLAY_LABEL_PREFIX}{index}")
}

// The reverse of `overlay_label` — an overlay window's own label directly
// encodes which monitor it covers, so once we know *which* overlay window
// the user actually interacted with, no further coordinate math is needed
// to figure out the target monitor.
fn overlay_monitor_index(window: &WebviewWindow) -> Result<usize, String> {
    window
        .label()
        .strip_prefix(OVERLAY_LABEL_PREFIX)
        .and_then(|n| n.parse::<usize>().ok())
        .ok_or_else(|| format!("window \"{}\" is not an overlay window", window.label()))
}

// Creates (or repositions, if left over from a previous show) one overlay
// window per currently-connected monitor, so area capture/recording can be
// started from anywhere — a hotkey, or a tray menu item, whose click
// necessarily happens on whichever monitor has the menu bar, giving no
// usable signal for "which monitor does the user actually want". Showing
// the crosshair overlay on every monitor at once (the same approach macOS's
// own screenshot tool uses) sidesteps needing to guess at all: whichever
// window the user actually drags in decides the target monitor.
pub(crate) fn ensure_overlay_windows(app: &AppHandle) -> Result<Vec<WebviewWindow>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let mut windows = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.iter().enumerate() {
        let label = overlay_label(index);
        let win = match app.get_webview_window(&label) {
            Some(win) => win,
            None => WebviewWindowBuilder::new(
                app,
                &label,
                WebviewUrl::App("index.html#/overlay".into()),
            )
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
        };
        win.set_position(Position::Physical(*monitor.position()))
            .map_err(|e| e.to_string())?;
        win.set_size(Size::Physical(*monitor.size()))
            .map_err(|e| e.to_string())?;
        windows.push(win);
    }
    // A monitor was unplugged since the last time overlays were shown —
    // close its now-stale window instead of leaving it around forever.
    for (label, win) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) && !windows.iter().any(|w| *w.label() == label) {
            let _ = win.close();
        }
    }
    Ok(windows)
}

fn hide_all_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            let _ = win.hide();
        }
    }
}

fn show_overlays(app: &AppHandle, purpose: &str) -> Result<(), String> {
    crate::discard_any_active_recording(app);
    crate::set_capture_tray_icon(app, crate::CaptureIconState::Progress);
    let windows = ensure_overlay_windows(app)?;
    for win in &windows {
        win.show().map_err(|e| e.to_string())?;
    }
    // Only one window can actually hold keyboard focus — best-effort give
    // it to whichever monitor the cursor happens to be on (correct for the
    // common hotkey-triggered case; for a tray-triggered one it'll land on
    // the menu-bar's monitor, but Escape still works from any of them once
    // that window is clicked).
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(index) = monitor_index_at(app, cursor.x as i32, cursor.y as i32) {
            if let Some(win) = windows.get(index) {
                let _ = win.set_focus();
            }
        }
    }
    app.emit("overlay-mode", serde_json::json!({ "purpose": purpose }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    show_overlays(&app, "screenshot")
}

#[tauri::command]
pub fn show_overlay_for_recording(app: AppHandle) -> Result<(), String> {
    show_overlays(&app, "record")
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
    hide_all_overlays(&app);
    Ok(())
}

// Called once the user has actually drawn a selection on one monitor's
// overlay — every other monitor's overlay is no longer relevant at that
// point, so hide them instead of leaving them dimming the rest of the
// screen through the rest of the record flow.
#[tauri::command]
pub fn hide_other_overlays(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    for (label, win) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) && label != *window.label() {
            win.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Replaces the old `overlay-selection` event (which only ever came from a
// single, always-primary-monitor overlay window) — `window` is
// auto-supplied by Tauri as whichever overlay window actually invoked this,
// so the target monitor is read directly off its label rather than guessed
// at from cursor or window position.
#[tauri::command]
pub fn submit_area_capture(window: WebviewWindow, rect: CaptureRect) -> Result<(), String> {
    let app = window.app_handle();
    let index = overlay_monitor_index(&window)?;
    match capture::capture_area_png(rect, index) {
        Ok(bytes) => {
            crate::open_editor_with_png(app, bytes);
            Ok(())
        }
        Err(e) => {
            crate::notify_capture_failed(app, &e);
            crate::set_capture_tray_icon(app, crate::CaptureIconState::Default);
            Err(e)
        }
    }
}

// Invoked from the editor window itself (via its "add screenshot" tool) —
// `window` is auto-supplied as the editor window, so hiding it (to keep it
// out of the way of, and out of, the next capture) and showing the overlay
// happen together as one atomic step from the frontend's perspective.
#[tauri::command]
pub fn start_floating_capture(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    show_overlays(&window.app_handle(), "floating")
}

// Mirrors submit_area_capture, but adds the result as a floating image on
// top of whatever's already in the editor instead of replacing it, and
// re-shows the editor window that start_floating_capture hid.
#[tauri::command]
pub fn submit_floating_capture(window: WebviewWindow, rect: CaptureRect) -> Result<(), String> {
    let app = window.app_handle();
    let index = overlay_monitor_index(&window)?;
    match capture::capture_area_png(rect, index) {
        Ok(bytes) => {
            crate::add_floating_image_to_editor(app, bytes);
            Ok(())
        }
        Err(e) => {
            crate::notify_capture_failed(app, &e);
            crate::set_capture_tray_icon(app, crate::CaptureIconState::Default);
            crate::restore_editor_window(app);
            Err(e)
        }
    }
}

// Called by the overlay on Escape / a too-small drag while in "floating"
// mode — nothing was captured, so just undo start_floating_capture's hide.
#[tauri::command]
pub fn cancel_floating_capture(app: AppHandle) -> Result<(), String> {
    crate::restore_editor_window(&app);
    Ok(())
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
pub async fn upload_file(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
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
pub fn save_bytes_to_path(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

// Trims straight to the user's chosen destination — unlike trim_and_upload,
// there's no upload step needing the bytes afterward, so this skips the
// temp-file-then-read dance entirely.
#[tauri::command]
pub fn save_trimmed_video(
    input_path: String,
    in_point: f64,
    out_point: f64,
    save_path: String,
) -> Result<(), String> {
    let input = std::path::PathBuf::from(&input_path);
    let output = std::path::PathBuf::from(&save_path);
    crate::trim::trim_video(&input, &output, in_point, out_point)
}

#[tauri::command]
pub fn start_recording_command(
    window: WebviewWindow,
    state: State<RecordingState>,
    region: Option<CaptureRegion>,
    mic_enabled: bool,
) -> Result<String, String> {
    let app = window.app_handle();
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
    // `window` is whichever overlay window the user actually drew the
    // region on — its own label directly encodes the target monitor, so
    // there's no need to guess from cursor or window position (which,
    // triggered from the tray menu, would always land on the menu bar's
    // monitor). Without this, recording always used whichever screen
    // capture device avfoundation happened to list first while cropping
    // with coordinates meant for a different monitor, producing an
    // out-of-bounds crop that could hang ffmpeg on stop instead of actually
    // finishing the recording.
    let monitor_index = overlay_monitor_index(&window).unwrap_or(0);
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let tauri_monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let tauri_size = tauri_monitors.get(monitor_index).map(|m| *m.size());
    // Retina/HiDPI displays report a scale_factor > 1.0 (e.g. 2.0) — passed
    // through so start_recording can scale the captured video back down to
    // 1x before encoding, matching the size it'll actually be viewed at
    // instead of uploading it at 2x/3x the necessary resolution.
    let scale_factor = tauri_monitors
        .get(monitor_index)
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    eprintln!(
        "start_recording_command: region={region:?}, monitor_index={monitor_index}, tauri_size={tauri_size:?}, scale_factor={scale_factor}, {}",
        capture::monitor_debug_info(monitor_index).unwrap_or_else(|e| format!("monitor_debug_info failed: {e}"))
    );
    let child = match recording::start_recording(
        region,
        mic_enabled,
        &output_path,
        monitor_index,
        scale_factor,
    ) {
        Ok(child) => child,
        Err(e) => {
            crate::notify_capture_failed(app, &format!("failed to start recording: {e}"));
            crate::set_capture_tray_icon(app, crate::CaptureIconState::Default);
            return Err(e);
        }
    };
    *guard = Some((child, output_path.clone(), std::time::Instant::now()));
    drop(guard);
    crate::set_recording_tray_state(app, true);
    if let Some(region) = region {
        crate::show_recording_controls(app, region, (origin.x, origin.y));
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
    let (child, _path, started_at) = guard.take().ok_or("no recording in progress")?;
    recording::stop_recording(child, started_at)
}

// Called once a loaded video's natural dimensions are known, so the editor
// window opens sized to fit the video (scaled to the current screen) instead
// of always the fixed default size, which could force scrolling for large
// recordings or leave a lot of empty space for small ones.
#[tauri::command]
pub fn resize_editor_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("editor")
        .ok_or("editor window missing")?;
    // Deliberately not re-centering: NSWindow's center() centers on the
    // *main* screen rather than the window's own screen if the window isn't
    // considered fully settled at that exact moment (e.g. right after a
    // resize) — which silently relocated the editor window to the primary
    // monitor instead of wherever it actually was (e.g. a recording started
    // on a secondary monitor), making it look like the window never opened.
    // Resizing in place avoids that risk entirely.
    win.set_size(Size::Logical(tauri::LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reopen_last_capture(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("editor")
        .ok_or("editor window missing")?;
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
        crate::LastCapture::Image { png_base64 } => LastCapturePayload::Image {
            png_base64: png_base64.clone(),
        },
        crate::LastCapture::Video { path } => LastCapturePayload::Video {
            path: path.to_string_lossy().to_string(),
        },
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

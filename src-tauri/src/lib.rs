// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod tray;
mod capture;
mod filename;
mod object_key;
mod settings;
mod commands;
mod upload;
mod recording;
mod trim;

use tauri::{Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, Position, Size};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureIconState {
    Default,
    Progress,
    Success,
}

fn icon_filename(state: CaptureIconState) -> &'static str {
    match state {
        CaptureIconState::Default => "std-32.png",
        CaptureIconState::Progress => "progress-32.png",
        CaptureIconState::Success => "success-32.png",
    }
}

// Bumped by every call to set_capture_tray_icon, so the delayed "success ->
// default" revert (below) can tell whether it's still the most recent icon
// change by the time its 3 seconds are up, or whether a newer capture has
// since taken over — in which case reverting would incorrectly stomp on
// that newer capture's own progress icon.
static ICON_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn set_capture_tray_icon(app: &tauri::AppHandle, state: CaptureIconState) -> u64 {
    let generation = ICON_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let Ok(resource_dir) = app.path().resource_dir() else {
        eprintln!("failed to resolve resource dir for tray icon");
        return generation;
    };
    let path = resource_dir.join("icons").join(icon_filename(state));
    match tauri::image::Image::from_path(&path) {
        Ok(image) => {
            let tray = app.state::<tauri::tray::TrayIcon<tauri::Wry>>();
            if let Err(e) = tray.set_icon(Some(image)) {
                eprintln!("failed to set tray icon: {e}");
            }
        }
        Err(e) => eprintln!("failed to load tray icon {}: {e}", path.display()),
    }
    generation
}

// Shows the success icon, then reverts to the default icon after 3 seconds —
// unless a newer capture has already changed the icon again by then.
pub(crate) fn flash_success_tray_icon(app: &tauri::AppHandle) {
    let generation = set_capture_tray_icon(app, CaptureIconState::Success);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if ICON_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == generation {
            set_capture_tray_icon(&handle, CaptureIconState::Default);
        }
    });
}

pub(crate) fn register_shortcuts(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let hotkeys = settings::load_hotkeys(&dir);
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.on_shortcut(hotkeys.capture_area.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-capture-area", ()).ok();
        }
    })
    .map_err(|e| format!("capture_area shortcut \"{}\": {e}", hotkeys.capture_area))?;
    gs.on_shortcut(hotkeys.capture_full.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-capture-full", ()).ok();
        }
    })
    .map_err(|e| format!("capture_full shortcut \"{}\": {e}", hotkeys.capture_full))?;
    gs.on_shortcut(hotkeys.record_area.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-record-area", ()).ok();
        }
    })
    .map_err(|e| format!("record_area shortcut \"{}\": {e}", hotkeys.record_area))?;
    Ok(())
}

pub(crate) fn notify_capture_failed(app: &tauri::AppHandle, e: &str) {
    eprintln!("capture failed: {e}");
    if let Err(e) = app
        .notification()
        .builder()
        .title("Snap")
        .body(format!("Capture failed: {e}"))
        .show()
    {
        eprintln!("failed to show capture-failed notification: {e}");
    }
}

pub(crate) fn discard_any_active_recording(app: &tauri::AppHandle) {
    let state = app.state::<recording::RecordingState>();
    let entry = state.0.lock().unwrap().take();
    if let Some((child, path, started_at)) = entry {
        let _ = recording::stop_recording(child, started_at);
        let _ = std::fs::remove_file(&path);
        set_recording_tray_state(app, false);
        hide_recording_controls(app);
    }
}

// Positions and shows the small floating "Stop Recording" button window just
// below the region being recorded. This is a separate, normal (non-click-
// through) window rather than a button on the (click-through) overlay
// window — a click-through window never receives the mouse-enter/leave
// events needed to toggle click-through off over just the button, so the
// button would be unclickable if it lived there instead.
pub(crate) fn show_recording_controls(
    app: &tauri::AppHandle,
    region: recording::CaptureRegion,
    origin: (i32, i32),
) {
    let Some(win) = app.get_webview_window("recording-controls") else {
        eprintln!("recording-controls window missing");
        return;
    };
    // `region.x`/`region.y` are relative to the overlay window the user drew
    // the selection in (see OverlayApp.tsx), not the desktop's global
    // coordinate space that `set_position` expects — `origin` is that
    // overlay window's own on-screen position (still showing, over the
    // target monitor, at the moment the caller reads it), giving the
    // monitor's global origin to offset by.
    let (origin_x, origin_y) = origin;
    let width = region.width as i32;
    let height = 100i32;
    let x = origin_x + region.x;
    let y = origin_y + region.y + region.height as i32 + 12;
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    let _ = win.set_size(Size::Physical(PhysicalSize::new(width as u32, height as u32)));
    let _ = win.show();
}

pub(crate) fn hide_recording_controls(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("recording-controls") {
        let _ = win.hide();
    }
}

// Clicking the tray icon (to open its menu) is often the only way back to a
// window once the dock icon is hidden (Accessory activation policy) and a
// fullscreen app on another Space has focus. `set_focus()` alone asks macOS
// to switch to the window's Space, but that Space-switch is unreliable over
// a fullscreen app — it silently no-ops as often as it works, which is why
// this previously took several clicks to "catch". Marking the window
// visible-on-all-workspaces first (NSWindowCollectionBehavior::
// CanJoinAllSpaces) sidesteps the whole problem: the window can then be
// ordered to the front of whatever Space is already active, no space-switch
// required. Limited to the windows that hold real content a user would want
// back; "overlay" (transient capture UI) and "recording-controls" (a small
// floating control, not something to get "lost" behind another app) are
// deliberately excluded.
pub(crate) fn raise_open_windows(app: &tauri::AppHandle) {
    for label in ["editor", "settings", "history"] {
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                let _ = win.set_visible_on_all_workspaces(true);
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

pub(crate) fn set_recording_tray_state(app: &tauri::AppHandle, recording: bool) {
    let items = app.state::<crate::tray::TrayMenuItems>();
    let _ = items.stop_recording.set_enabled(recording);
    let _ = items.record_area.set_enabled(!recording);
}

/// Polls the recording's ffmpeg process every 500ms. If it's still the
/// active recording (nobody has called stop/discard) and it exits on its
/// own, that's a crash: notify, reset the tray, and discard the resulting
/// file (it's necessarily incomplete/corrupt, so no editor should open for
/// it, per the design spec's crash-handling requirement).
pub(crate) fn monitor_recording_for_crash(app: &tauri::AppHandle, expected_path: std::path::PathBuf) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let state = app.state::<recording::RecordingState>();
        let mut guard = state.0.lock().unwrap();
        match guard.as_mut() {
            None => return, // stopped or discarded elsewhere — normal exit, nothing to do
            Some((_child, path, _started_at)) if *path != expected_path => return, // superseded by a different recording
            Some((child, _path, _started_at)) => match child.as_inner_mut().try_wait() {
                Ok(None) => continue, // still running, poll again
                Ok(Some(_)) | Err(_) => {
                    // Process exited on its own (or we can't even check) without
                    // anyone calling stop/discard — that's a crash.
                    let _ = guard.take();
                    drop(guard);
                    let _ = std::fs::remove_file(&expected_path);
                    notify_capture_failed(app, "recording process exited unexpectedly");
                    set_recording_tray_state(app, false);
                    hide_recording_controls(app);
                    set_capture_tray_icon(app, CaptureIconState::Default);
                    return;
                }
            },
        }
    }
}

pub enum LastCapture {
    Image { png_base64: String },
    Video { path: std::path::PathBuf },
}

pub struct LastCaptureState(pub std::sync::Mutex<Option<LastCapture>>);

impl Default for LastCaptureState {
    fn default() -> Self {
        LastCaptureState(std::sync::Mutex::new(None))
    }
}

pub(crate) fn set_reopen_enabled(app: &tauri::AppHandle, enabled: bool) {
    let items = app.state::<crate::tray::TrayMenuItems>();
    let _ = items.reopen_last_capture.set_enabled(enabled);
}

pub(crate) fn open_editor_with_video(app: &tauri::AppHandle, video_path: &std::path::Path) {
    let state = app.state::<LastCaptureState>();
    *state.0.lock().unwrap() = Some(LastCapture::Video { path: video_path.to_path_buf() });
    set_reopen_enabled(app, true);
    if let Some(win) = app.get_webview_window("editor") {
        if let Err(e) = win.show() {
            eprintln!("failed to show editor window: {e}");
        }
        if let Err(e) = win.set_focus() {
            eprintln!("failed to focus editor window: {e}");
        }
        if let Err(e) = app.emit_to("editor", "editor-load-video", video_path.to_string_lossy().to_string()) {
            eprintln!("failed to emit editor-load-video: {e}");
        }
    } else {
        eprintln!("editor window missing");
    }
}

pub(crate) fn open_editor_with_png(app: &tauri::AppHandle, png_bytes: Vec<u8>) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let state = app.state::<LastCaptureState>();
    *state.0.lock().unwrap() = Some(LastCapture::Image { png_base64: b64.clone() });
    set_reopen_enabled(app, true);
    if let Some(win) = app.get_webview_window("editor") {
        if let Err(e) = win.show() {
            eprintln!("failed to show editor window: {e}");
        }
        if let Err(e) = win.set_focus() {
            eprintln!("failed to focus editor window: {e}");
        }
        if let Err(e) = app.emit_to("editor", "editor-load-image", b64) {
            eprintln!("failed to emit editor-load-image: {e}");
        }
    } else {
        eprintln!("editor window missing");
    }
}

const CAPTURE_HISTORY_LIMIT: usize = 6;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHistoryEntry {
    pub id: String,
    pub kind: String,
    pub url: String,
    pub thumbnail: String,
    pub timestamp_ms: u64,
}

pub struct CaptureHistoryState(pub std::sync::Mutex<std::collections::VecDeque<CaptureHistoryEntry>>);

impl Default for CaptureHistoryState {
    fn default() -> Self {
        CaptureHistoryState(std::sync::Mutex::new(std::collections::VecDeque::new()))
    }
}

// Session-only, like LastCaptureState — never persisted to disk, matching
// the app's existing privacy stance. The frontend generates the thumbnail
// (client-side, from whatever it already has in memory for the upload) and
// hands it here alongside the resulting URL; this just keeps the bounded
// most-recent-6 list and notifies the history window if it's open.
pub(crate) fn record_capture_history(app: &tauri::AppHandle, kind: String, url: String, thumbnail: String) {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let state = app.state::<CaptureHistoryState>();
    let mut history = state.0.lock().unwrap();
    history.push_front(CaptureHistoryEntry { id: nanoid::nanoid!(8), kind, url, thumbnail, timestamp_ms });
    history.truncate(CAPTURE_HISTORY_LIMIT);
    let snapshot: Vec<CaptureHistoryEntry> = history.iter().cloned().collect();
    drop(history);
    let _ = app.emit_to("history", "capture-history-updated", snapshot);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::get_upload_settings,
            commands::save_upload_settings,
            commands::save_credentials,
            commands::has_credentials,
            commands::get_hotkey_settings,
            commands::save_hotkey_settings,
            commands::show_overlay,
            commands::show_overlay_for_recording,
            commands::hide_overlay,
            commands::hide_other_overlays,
            commands::submit_area_capture,
            commands::capture_full_screen,
            commands::capture_area,
            commands::upload_file,
            commands::trim_and_upload,
            commands::start_recording_command,
            commands::stop_recording_command,
            commands::reopen_last_capture,
            commands::resize_editor_window,
            commands::get_last_capture,
            commands::read_video_base64,
            commands::record_capture_history,
            commands::get_capture_history,
            commands::reset_capture_icon,
        ])
        .manage(recording::RecordingState::default())
        .manage(LastCaptureState::default())
        .manage(CaptureHistoryState::default())
        .setup(|app| {
            // Menubar-only app — no Dock icon, no Cmd+Tab entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::build_tray(app.handle())?;

            // Create (but don't show) the per-monitor overlay windows now,
            // rather than lazily on first use. Each is a fresh webview that
            // needs a moment to load and register its own event listeners
            // — creating them on first use and emitting "overlay-mode"
            // straight after meant that very first click could fire the
            // event before the brand-new window's listener was ready,
            // silently losing it and leaving the overlay stuck on its
            // default ("screenshot") purpose even when recording was
            // requested. Creating them eagerly at startup gives them the
            // entire rest of the launch sequence to finish loading.
            if let Err(e) = commands::ensure_overlay_windows(app.handle()) {
                eprintln!("failed to pre-create overlay windows: {e}");
            }

            let handle_ffmpeg = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = recording::ensure_ffmpeg() {
                    eprintln!("ffmpeg setup failed: {e}");
                    notify_capture_failed(
                        &handle_ffmpeg,
                        &format!("ffmpeg setup failed — recording will not work: {e}"),
                    );
                }
            });

            if let Err(e) = register_shortcuts(app.handle()) {
                eprintln!("failed to register global shortcuts: {e}");
            }

            // Closing the settings/editor/history windows via the native
            // close button would otherwise destroy them, so the next tray
            // click/capture could never find or re-show them. Hide instead.
            for label in ["settings", "history"] {
                if let Some(win) = app.get_webview_window(label) {
                    let win_to_hide = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win_to_hide.hide();
                        }
                    });
                }
            }

            // The editor gets the same prevent-close-hide-instead treatment,
            // plus: closing it via the native button (as opposed to a
            // successful upload, which hides it itself from the frontend)
            // means whatever capture was open is being abandoned unsaved —
            // revert the tray icon back to default rather than leaving it
            // stuck on "in progress" forever.
            if let Some(win) = app.get_webview_window("editor") {
                let win_to_hide = win.clone();
                let handle_editor_close = app.handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_to_hide.hide();
                        set_capture_tray_icon(&handle_editor_close, CaptureIconState::Default);
                    }
                });
            }

            let handle = app.handle().clone();
            app.listen("trigger-capture-full", move |_event| {
                discard_any_active_recording(&handle);
                set_capture_tray_icon(&handle, CaptureIconState::Progress);
                // The full-screen hotkey captures instantly with no overlay
                // to read a position from, so use wherever the cursor is —
                // that's the monitor the user is actually looking at.
                let result = handle
                    .cursor_position()
                    .map_err(|e| e.to_string())
                    .and_then(|cursor| commands::monitor_index_at(&handle, cursor.x as i32, cursor.y as i32))
                    .and_then(capture::capture_full_screen_png);
                match result {
                    Ok(bytes) => open_editor_with_png(&handle, bytes),
                    Err(e) => {
                        notify_capture_failed(&handle, &e);
                        set_capture_tray_icon(&handle, CaptureIconState::Default);
                    }
                }
            });

            let handle2 = app.handle().clone();
            app.listen("trigger-capture-area", move |_event| {
                if let Err(e) = commands::show_overlay(handle2.clone()) {
                    eprintln!("show_overlay failed: {e}");
                }
            });

            // Area-selection capture used to be finished via an
            // "overlay-selection" event listened for on a single, always-
            // primary-monitor overlay window here. Overlays are now created
            // dynamically, one per monitor (see `commands::show_overlays`),
            // so that flow is instead a plain command
            // (`commands::submit_area_capture`) invoked directly from
            // whichever overlay window the user actually used — Tauri
            // supplies that specific window to the handler automatically,
            // which a window-scoped event listener registered once here
            // upfront couldn't do for windows that don't exist yet.

            let handle4 = app.handle().clone();
            app.listen("trigger-record-area", move |_event| {
                if let Err(e) = commands::show_overlay_for_recording(handle4.clone()) {
                    eprintln!("show_overlay_for_recording failed: {e}");
                }
            });

            let handle7 = app.handle().clone();
            app.listen("trigger-stop-recording", move |_event| {
                let state = handle7.state::<recording::RecordingState>();
                let entry = state.0.lock().unwrap().take();
                if let Some((child, output_path, started_at)) = entry {
                    set_recording_tray_state(&handle7, false);
                    hide_recording_controls(&handle7);
                    match recording::stop_recording(child, started_at) {
                        Ok(()) => open_editor_with_video(&handle7, &output_path),
                        Err(e) => {
                            notify_capture_failed(&handle7, &format!("failed to stop recording: {e}"));
                            set_capture_tray_icon(&handle7, CaptureIconState::Default);
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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
        .title("pxl")
        .body(format!("Capture failed: {e}"))
        .show()
    {
        eprintln!("failed to show capture-failed notification: {e}");
    }
}

pub(crate) fn discard_any_active_recording(app: &tauri::AppHandle) {
    let state = app.state::<recording::RecordingState>();
    let entry = state.0.lock().unwrap().take();
    if let Some((child, path)) = entry {
        let _ = recording::stop_recording(child);
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
pub(crate) fn show_recording_controls(app: &tauri::AppHandle, region: recording::CaptureRegion) {
    let Some(win) = app.get_webview_window("recording-controls") else {
        eprintln!("recording-controls window missing");
        return;
    };
    let width = 180i32;
    let height = 56i32;
    let x = region.x + (region.width as i32 - width) / 2;
    let y = region.y + region.height as i32 + 12;
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    let _ = win.set_size(Size::Physical(PhysicalSize::new(width as u32, height as u32)));
    let _ = win.show();
}

pub(crate) fn hide_recording_controls(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("recording-controls") {
        let _ = win.hide();
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
            Some((_child, path)) if *path != expected_path => return, // superseded by a different recording
            Some((child, _path)) => match child.as_inner_mut().try_wait() {
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
            commands::capture_full_screen,
            commands::capture_area,
            commands::upload_file,
            commands::trim_and_upload,
            commands::start_recording_command,
            commands::stop_recording_command,
            commands::reopen_last_capture,
            commands::get_last_capture,
            commands::read_video_base64,
        ])
        .manage(recording::RecordingState::default())
        .manage(LastCaptureState::default())
        .setup(|app| {
            tray::build_tray(app.handle())?;

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

            // Closing the settings/editor windows via the native close button
            // would otherwise destroy them, so the next tray click/capture
            // could never find or re-show them. Hide instead.
            for label in ["settings", "editor"] {
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

            let handle = app.handle().clone();
            app.listen("trigger-capture-full", move |_event| {
                discard_any_active_recording(&handle);
                match capture::capture_full_screen_png() {
                    Ok(bytes) => open_editor_with_png(&handle, bytes),
                    Err(e) => notify_capture_failed(&handle, &e),
                }
            });

            let handle2 = app.handle().clone();
            app.listen("trigger-capture-area", move |_event| {
                if let Err(e) = commands::show_overlay(handle2.clone()) {
                    eprintln!("show_overlay failed: {e}");
                }
            });

            if let Some(overlay_window) = app.get_webview_window("overlay") {
                let handle3 = app.handle().clone();
                overlay_window.listen("overlay-selection", move |event| {
                    match serde_json::from_str::<capture::CaptureRect>(event.payload()) {
                        Ok(rect) => match capture::capture_area_png(rect) {
                            Ok(bytes) => open_editor_with_png(&handle3, bytes),
                            Err(e) => notify_capture_failed(&handle3, &e),
                        },
                        Err(e) => eprintln!("failed to parse overlay-selection payload: {e}"),
                    }
                });
            } else {
                eprintln!("overlay window missing; overlay-selection listener not registered");
            }

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
                if let Some((child, output_path)) = entry {
                    set_recording_tray_state(&handle7, false);
                    hide_recording_controls(&handle7);
                    match recording::stop_recording(child) {
                        Ok(()) => open_editor_with_video(&handle7, &output_path),
                        Err(e) => notify_capture_failed(
                            &handle7,
                            &format!("failed to stop recording: {e}"),
                        ),
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

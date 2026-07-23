// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod tray;
mod capture;
mod filename;
mod object_key;
mod settings;
mod commands;
mod upload;
mod recording;

use tauri::{Emitter, Listener, Manager};
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
    gs.on_shortcut(hotkeys.record_full.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-record-full", ()).ok();
        }
    })
    .map_err(|e| format!("record_full shortcut \"{}\": {e}", hotkeys.record_full))?;
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

pub(crate) fn set_recording_tray_state(app: &tauri::AppHandle, recording: bool) {
    let items = app.state::<crate::tray::TrayMenuItems>();
    let _ = items.stop_recording.set_enabled(recording);
    let _ = items.record_area.set_enabled(!recording);
    let _ = items.record_full.set_enabled(!recording);
}

pub(crate) fn open_editor_with_video(app: &tauri::AppHandle, video_path: &std::path::Path) {
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
            commands::start_recording_command,
            commands::stop_recording_command,
        ])
        .manage(recording::RecordingState::default())
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
                if let Err(e) = commands::show_overlay_for_recording(handle4.clone(), true) {
                    eprintln!("show_overlay_for_recording failed: {e}");
                }
            });

            let handle5 = app.handle().clone();
            app.listen("trigger-record-full", move |_event| {
                if let Err(e) = commands::show_overlay_for_recording(handle5.clone(), false) {
                    eprintln!("show_overlay_for_recording failed: {e}");
                }
            });

            if let Some(overlay_window) = app.get_webview_window("overlay") {
                let handle6 = app.handle().clone();
                overlay_window.listen("record-confirmed", move |event| {
                    #[derive(serde::Deserialize)]
                    struct RecordConfirmed {
                        region: Option<recording::CaptureRegion>,
                        #[serde(rename = "micEnabled")]
                        mic_enabled: bool,
                    }
                    match serde_json::from_str::<RecordConfirmed>(event.payload()) {
                        Ok(confirmed) => {
                            let state = handle6.state::<recording::RecordingState>();
                            let output_path = std::env::temp_dir()
                                .join(format!("pxl-recording-{}.mp4", std::process::id()));
                            match recording::start_recording(
                                confirmed.region,
                                confirmed.mic_enabled,
                                &output_path,
                            ) {
                                Ok(child) => {
                                    *state.0.lock().unwrap() = Some((child, output_path));
                                    set_recording_tray_state(&handle6, true);
                                }
                                Err(e) => notify_capture_failed(
                                    &handle6,
                                    &format!("failed to start recording: {e}"),
                                ),
                            }
                        }
                        Err(e) => eprintln!("failed to parse record-confirmed payload: {e}"),
                    }
                });
            }

            let handle7 = app.handle().clone();
            app.listen("trigger-stop-recording", move |_event| {
                let state = handle7.state::<recording::RecordingState>();
                let entry = state.0.lock().unwrap().take();
                if let Some((child, output_path)) = entry {
                    match recording::stop_recording(child) {
                        Ok(()) => {
                            set_recording_tray_state(&handle7, false);
                            open_editor_with_video(&handle7, &output_path);
                        }
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

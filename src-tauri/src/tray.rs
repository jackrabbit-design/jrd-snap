use crate::settings::{self, HotkeySettings};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

pub struct TrayMenuItems {
    pub capture_area: MenuItem<tauri::Wry>,
    pub capture_full: MenuItem<tauri::Wry>,
    pub record_area: MenuItem<tauri::Wry>,
    pub stop_recording: MenuItem<tauri::Wry>,
    pub reopen_last_capture: MenuItem<tauri::Wry>,
}

// Loaded once here at startup and again whenever hotkeys are saved
// (update_tray_accelerators) — kept in its own function so both call sites
// stay in sync on where the current hotkeys come from.
fn current_hotkeys(app: &AppHandle) -> HotkeySettings {
    app.path()
        .app_config_dir()
        .map(|dir| settings::load_hotkeys(&dir))
        .unwrap_or_default()
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let hotkeys = current_hotkeys(app);
    let capture_area = MenuItem::with_id(app, "capture_area", "Capture Area", true, Some(&hotkeys.capture_area))?;
    let capture_full =
        MenuItem::with_id(app, "capture_full", "Capture Full Screen", true, Some(&hotkeys.capture_full))?;
    let record_area = MenuItem::with_id(app, "record_area", "Record Area", true, Some(&hotkeys.record_area))?;
    let stop_recording = MenuItem::with_id(app, "stop_recording", "Stop Recording", false, None::<&str>)?;
    let reopen_last_capture = MenuItem::with_id(app, "reopen_last_capture", "Reopen Last Capture", false, None::<&str>)?;
    let recent_captures = MenuItem::with_id(app, "recent_captures", "Recent Captures", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &capture_area,
            &capture_full,
            &record_area,
            &stop_recording,
            &reopen_last_capture,
            &recent_captures,
            &settings,
            &quit,
        ],
    )?;

    app.manage(TrayMenuItems {
        capture_area: capture_area.clone(),
        capture_full: capture_full.clone(),
        record_area: record_area.clone(),
        stop_recording: stop_recording.clone(),
        reopen_last_capture: reopen_last_capture.clone(),
    });

    let tray_icon = TrayIconBuilder::new()
        .menu(&menu)
        .icon(app.default_window_icon().unwrap().clone())
        .on_tray_icon_event(|tray, event| {
            // On macOS, a left click on the tray icon fires mouseDown, which
            // synchronously calls performClick to pop open the attached menu
            // — a blocking call for as long as the menu is tracking. The
            // corresponding mouseUp essentially never reaches us in that
            // flow (the button already consumed the whole click), so this
            // has to fire on Down, before the menu's blocking call.
            if let tauri::tray::TrayIconEvent::Click {
                button_state: tauri::tray::MouseButtonState::Down,
                ..
            } = event
            {
                crate::raise_open_windows(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture_area" => {
                if let Err(e) = crate::commands::show_overlay(app.clone()) {
                    eprintln!("show_overlay failed: {e}");
                }
            }
            "capture_full" => {
                crate::discard_any_active_recording(app);
                crate::set_capture_tray_icon(app, crate::CaptureIconState::Progress);
                let result = app
                    .cursor_position()
                    .map_err(|e| e.to_string())
                    .and_then(|cursor| crate::commands::monitor_index_at(app, cursor.x as i32, cursor.y as i32))
                    .and_then(crate::capture::capture_full_screen_png);
                match result {
                    Ok(bytes) => crate::open_editor_with_png(app, bytes),
                    Err(e) => {
                        crate::notify_capture_failed(app, &e);
                        crate::set_capture_tray_icon(app, crate::CaptureIconState::Default);
                    }
                }
            }
            "record_area" => {
                if let Err(e) = crate::commands::show_overlay_for_recording(app.clone()) {
                    eprintln!("show_overlay_for_recording failed: {e}");
                }
            }
            "stop_recording" => {
                app.emit("trigger-stop-recording", ()).ok();
            }
            "reopen_last_capture" => {
                if let Err(e) = crate::commands::reopen_last_capture(app.clone()) {
                    eprintln!("reopen_last_capture failed: {e}");
                }
            }
            "recent_captures" => {
                if let Some(win) = app.get_webview_window("history") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "open_settings" => {
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                let state = app.state::<crate::recording::RecordingState>();
                if let Some((child, _path, started_at)) = state.0.lock().unwrap().take() {
                    let _ = crate::recording::stop_recording(child, started_at);
                }
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    app.manage(tray_icon);

    Ok(())
}

// Menu item accelerators are just a display hint — they don't do the actual
// key handling (that's tauri-plugin-global-shortcut, wired up separately in
// register_shortcuts) — but they need to be kept in sync by hand whenever
// hotkeys are saved, since the menu items were built once at startup with
// whatever the hotkeys were then.
pub(crate) fn update_tray_accelerators(app: &AppHandle, hotkeys: &HotkeySettings) {
    let items = app.state::<TrayMenuItems>();
    let _ = items.capture_area.set_accelerator(Some(&hotkeys.capture_area));
    let _ = items.capture_full.set_accelerator(Some(&hotkeys.capture_full));
    let _ = items.record_area.set_accelerator(Some(&hotkeys.record_area));
}

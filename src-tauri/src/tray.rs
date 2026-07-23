use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

pub struct TrayMenuItems {
    pub record_area: MenuItem<tauri::Wry>,
    pub record_full: MenuItem<tauri::Wry>,
    pub stop_recording: MenuItem<tauri::Wry>,
    pub reopen_last_capture: MenuItem<tauri::Wry>,
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture_area = MenuItem::with_id(app, "capture_area", "Capture Area", true, None::<&str>)?;
    let capture_full = MenuItem::with_id(app, "capture_full", "Capture Full Screen", true, None::<&str>)?;
    let record_area = MenuItem::with_id(app, "record_area", "Record Area", true, None::<&str>)?;
    let record_full = MenuItem::with_id(app, "record_full", "Record Screen", true, None::<&str>)?;
    let stop_recording = MenuItem::with_id(app, "stop_recording", "Stop Recording", false, None::<&str>)?;
    let reopen_last_capture = MenuItem::with_id(app, "reopen_last_capture", "Reopen Last Capture", false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &capture_area,
            &capture_full,
            &record_area,
            &record_full,
            &stop_recording,
            &reopen_last_capture,
            &settings,
            &quit,
        ],
    )?;

    app.manage(TrayMenuItems {
        record_area: record_area.clone(),
        record_full: record_full.clone(),
        stop_recording: stop_recording.clone(),
        reopen_last_capture: reopen_last_capture.clone(),
    });

    TrayIconBuilder::new()
        .menu(&menu)
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture_area" => {
                if let Err(e) = crate::commands::show_overlay(app.clone()) {
                    eprintln!("show_overlay failed: {e}");
                }
            }
            "capture_full" => match crate::capture::capture_full_screen_png() {
                Ok(bytes) => crate::open_editor_with_png(app, bytes),
                Err(e) => crate::notify_capture_failed(app, &e),
            },
            "record_area" => {
                if let Err(e) = crate::commands::show_overlay_for_recording(app.clone(), true) {
                    eprintln!("show_overlay_for_recording failed: {e}");
                }
            }
            "record_full" => {
                if let Err(e) = crate::commands::show_overlay_for_recording(app.clone(), false) {
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
            "open_settings" => {
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

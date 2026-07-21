use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture_area = MenuItem::with_id(app, "capture_area", "Capture Area", true, None::<&str>)?;
    let capture_full = MenuItem::with_id(app, "capture_full", "Capture Full Screen", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&capture_area, &capture_full, &settings, &quit])?;

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
                Err(e) => eprintln!("capture_full_screen_png failed: {e}"),
            },
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

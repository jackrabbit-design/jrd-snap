// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod tray;
mod filename;
mod object_key;
mod settings;
mod commands;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::get_upload_settings,
            commands::save_upload_settings,
            commands::save_credentials,
            commands::has_credentials,
            commands::get_hotkey_settings,
            commands::save_hotkey_settings,
            commands::show_overlay,
            commands::hide_overlay,
        ])
        .setup(|app| {
            tray::build_tray(app.handle())?;
            if let Err(e) = register_shortcuts(app.handle()) {
                eprintln!("failed to register global shortcuts: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

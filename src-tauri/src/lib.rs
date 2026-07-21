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

pub(crate) fn register_shortcuts(app: &tauri::AppHandle) {
    let hotkeys = settings::load_hotkeys(&app.path().app_config_dir().unwrap());
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let _ = gs.on_shortcut(hotkeys.capture_area.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-capture-area", ()).ok();
        }
    });
    let _ = gs.on_shortcut(hotkeys.capture_full.as_str(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            app.emit("trigger-capture-full", ()).ok();
        }
    });
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
        ])
        .setup(|app| {
            tray::build_tray(app.handle())?;
            register_shortcuts(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

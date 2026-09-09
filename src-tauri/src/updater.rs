use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

fn notify(app: &AppHandle, body: impl Into<String>) {
    let _ = app.notification().builder().title("Snap").body(body.into()).show();
}

// Triggered by the tray menu's "Check for Updates" item. Runs on the async
// runtime rather than blocking the (synchronous) tray menu event handler.
// macOS has no way to relaunch the app after installing an update (unlike
// Windows, where the plugin's installer handles restarting) — so the best
// this can do is tell the user to quit and reopen it themselves once done.
pub fn check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(e) => {
                eprintln!("updater unavailable: {e}");
                notify(&app, format!("Update check failed: {e}"));
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("update download/install failed: {e}");
                    notify(&app, format!("Failed to install update {version}: {e}"));
                    return;
                }
                notify(&app, format!("Updated to {version} — quit and reopen Snap to finish"));
            }
            Ok(None) => notify(&app, "You're already on the latest version"),
            Err(e) => {
                eprintln!("update check failed: {e}");
                notify(&app, format!("Update check failed: {e}"));
            }
        }
    });
}

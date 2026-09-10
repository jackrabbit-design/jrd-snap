use crate::notify::notify;
use std::time::Duration;
use tauri::{menu::MenuItem, AppHandle};
use tauri_plugin_updater::UpdaterExt;

const DAILY_CHECK_INITIAL_DELAY: Duration = Duration::from_secs(10);
const DAILY_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

// Runs for the lifetime of the app: a short delay after launch (so it
// doesn't compete with startup work), then a check roughly once a day for
// as long as Snap stays running. Deliberately silent — no notification, no
// disabling the menu item — unlike the verbose manual-click flow below,
// since a routine background check finding nothing shouldn't interrupt
// anyone. When it does find something, it only relabels the menu item;
// the actual download/install still only happens if the user clicks it
// (reusing check_for_updates below, since the item's id never changes).
pub fn start_daily_check(app: AppHandle, menu_item: MenuItem<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DAILY_CHECK_INITIAL_DELAY).await;
        loop {
            if let Ok(updater) = app.updater() {
                if let Ok(Some(update)) = updater.check().await {
                    let _ = menu_item.set_text(format!("Update Available ({})", update.version));
                }
            }
            tokio::time::sleep(DAILY_CHECK_INTERVAL).await;
        }
    });
}

// Triggered by the tray menu's "Check for Updates" item. Runs on the async
// runtime rather than blocking the (synchronous) tray menu event handler.
// macOS has no way to relaunch the app after installing an update (unlike
// Windows, where the plugin's installer handles restarting) — so the best
// this can do is tell the user to quit and reopen it themselves once done.
//
// The menu item itself doubles as status feedback: relabeled and disabled
// for the duration of the check/download so a click always shows something
// happened immediately, rather than waiting on a notification that might
// not arrive for several seconds (or be missed under Focus/DND).
pub fn check_for_updates(app: AppHandle, menu_item: MenuItem<tauri::Wry>) {
    let _ = menu_item.set_enabled(false);
    let _ = menu_item.set_text("Checking for Updates…");
    notify(&app, "Checking for updates…");

    tauri::async_runtime::spawn(async move {
        let reset_menu_item = |text: &str| {
            let _ = menu_item.set_text(text);
            let _ = menu_item.set_enabled(true);
        };

        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(e) => {
                eprintln!("updater unavailable: {e}");
                notify(&app, format!("Update check failed: {e}"));
                reset_menu_item("Check for Updates…");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let _ = menu_item.set_text(format!("Downloading update {version}…"));
                notify(&app, format!("Downloading update {version}…"));
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("update download/install failed: {e}");
                    notify(&app, format!("Failed to install update {version}: {e}"));
                    reset_menu_item("Check for Updates…");
                    return;
                }
                notify(&app, format!("Updated to {version} — quit and reopen Snap to finish"));
                // Left disabled (unlike the other outcomes) — the update is
                // already downloaded and installed, so re-running the check
                // now would be a no-op until the user actually restarts.
                let _ = menu_item.set_text("Restart Snap to finish updating");
            }
            Ok(None) => {
                notify(&app, "You're already on the latest version");
                reset_menu_item("Check for Updates…");
            }
            Err(e) => {
                eprintln!("update check failed: {e}");
                notify(&app, format!("Update check failed: {e}"));
                reset_menu_item("Check for Updates…");
            }
        }
    });
}

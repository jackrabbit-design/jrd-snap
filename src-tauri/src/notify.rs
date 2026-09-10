use std::sync::Once;
use tauri::AppHandle;

static SET_APPLICATION: Once = Once::new();

// tauri-plugin-notification's `show()` spawns a detached async task and
// discards whatever the underlying notify-rust call returns, so a caller can
// never tell whether a notification actually reached the user — exactly the
// "hit or miss, no error, no pattern" symptom this is meant to fix. Calling
// notify-rust directly instead gives us the real Result to log.
pub fn notify(app: &AppHandle, body: impl Into<String>) {
    SET_APPLICATION.call_once(|| {
        let identifier = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        if let Err(e) = notify_rust::set_application(&identifier) {
            eprintln!("notify: set_application({identifier}) failed: {e}");
        }
    });

    if let Err(e) = notify_rust::Notification::new()
        .summary("Snap")
        .body(&body.into())
        .show()
    {
        eprintln!("notify: show failed: {e}");
    }
}

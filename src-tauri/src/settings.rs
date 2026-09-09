use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Provider {
    S3,
    Spaces,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadSettings {
    pub provider: Provider,
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub custom_domain: Option<String>,
    pub key_prefix: Option<String>,
    pub filename_prefix: Option<String>,
}

impl Default for UploadSettings {
    fn default() -> Self {
        UploadSettings {
            provider: Provider::S3,
            bucket: String::new(),
            region: String::new(),
            endpoint: None,
            custom_domain: None,
            key_prefix: None,
            filename_prefix: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

pub trait CredentialStore {
    fn get(&self) -> Option<Credentials>;
    fn set(&self, creds: &Credentials) -> Result<(), String>;
}

pub struct KeyringCredentialStore;

const KEYRING_SERVICE: &str = "Snap";
const KEYRING_USER: &str = "upload-credentials";

impl CredentialStore for KeyringCredentialStore {
    fn get(&self) -> Option<Credentials> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
        let raw = entry.get_password().ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn set(&self, creds: &Credentials) -> Result<(), String> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
        let raw = serde_json::to_string(&(&creds.access_key_id, &creds.secret_access_key))
            .map_err(|e| e.to_string())?;
        entry.set_password(&raw).map_err(|e| e.to_string())
    }
}

// serde_json::from_str above expects the same shape we serialize; give
// Credentials a manual (de)serialization via a tuple to avoid needing
// #[derive(Serialize, Deserialize)] on the public struct's field names
// leaking into the keychain blob format.
impl Serialize for Credentials {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (&self.access_key_id, &self.secret_access_key).serialize(s)
    }
}

impl<'de> Deserialize<'de> for Credentials {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (access_key_id, secret_access_key) = <(String, String)>::deserialize(d)?;
        Ok(Credentials {
            access_key_id,
            secret_access_key,
        })
    }
}

const SETTINGS_FILE: &str = "upload_settings.json";

pub fn load_settings(config_dir: &Path) -> UploadSettings {
    let path = config_dir.join(SETTINGS_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(config_dir: &Path, settings: &UploadSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let path = config_dir.join(SETTINGS_FILE);
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettings {
    pub capture_area: String,
    pub capture_full: String,
    pub record_area: String,
}

impl Default for HotkeySettings {
    // Ctrl+D/Ctrl+R collide with common OS/browser shortcuts on Windows, so
    // the non-macOS defaults add Alt to stay clear of them.
    #[cfg(target_os = "macos")]
    fn default() -> Self {
        HotkeySettings {
            capture_area: "Control+D".into(),
            capture_full: "Control+Shift+D".into(),
            record_area: "Control+R".into(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn default() -> Self {
        HotkeySettings {
            capture_area: "Control+Alt+D".into(),
            capture_full: "Control+Shift+D".into(),
            record_area: "Control+Alt+R".into(),
        }
    }
}

const HOTKEYS_FILE: &str = "hotkey_settings.json";

pub fn load_hotkeys(config_dir: &Path) -> HotkeySettings {
    let path = config_dir.join(HOTKEYS_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_hotkeys(config_dir: &Path, hotkeys: &HotkeySettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let path = config_dir.join(HOTKEYS_FILE);
    let raw = serde_json::to_string_pretty(hotkeys).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[test]
    fn missing_config_file_returns_default_settings() {
        let dir = tempdir();
        let settings = load_settings(dir.path());
        assert_eq!(settings, UploadSettings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let settings = UploadSettings {
            provider: Provider::Spaces,
            bucket: "my-bucket".into(),
            region: "nyc3".into(),
            endpoint: Some("nyc3.digitaloceanspaces.com".into()),
            custom_domain: Some("cdn.example.com".into()),
            key_prefix: Some("team-chris".into()),
            filename_prefix: Some("chris".into()),
        };
        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded, settings);
    }

    // In-memory fake standing in for the OS keychain, so this test suite
    // doesn't touch the real Keychain/Credential Manager.
    struct FakeCredentialStore {
        store: Mutex<HashMap<&'static str, Credentials>>,
    }

    impl FakeCredentialStore {
        fn new() -> Self {
            FakeCredentialStore {
                store: Mutex::new(HashMap::new()),
            }
        }
    }

    impl CredentialStore for FakeCredentialStore {
        fn get(&self) -> Option<Credentials> {
            self.store
                .lock()
                .unwrap()
                .get("upload-credentials")
                .cloned()
        }
        fn set(&self, creds: &Credentials) -> Result<(), String> {
            self.store
                .lock()
                .unwrap()
                .insert("upload-credentials", creds.clone());
            Ok(())
        }
    }

    #[test]
    fn credential_store_set_then_get_round_trips() {
        let store = FakeCredentialStore::new();
        assert!(store.get().is_none());
        let creds = Credentials {
            access_key_id: "AKIA...".into(),
            secret_access_key: "secret".into(),
        };
        store.set(&creds).unwrap();
        assert_eq!(store.get(), Some(creds));
    }

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn missing_hotkeys_file_returns_defaults() {
        let dir = tempdir();
        assert_eq!(load_hotkeys(dir.path()), HotkeySettings::default());
    }

    #[test]
    fn save_then_load_hotkeys_round_trips() {
        let dir = tempdir();
        let hotkeys = HotkeySettings {
            capture_area: "CommandOrControl+Shift+9".into(),
            capture_full: "CommandOrControl+Shift+8".into(),
            record_area: "CommandOrControl+Shift+7".into(),
        };
        save_hotkeys(dir.path(), &hotkeys).unwrap();
        assert_eq!(load_hotkeys(dir.path()), hotkeys);
    }
}

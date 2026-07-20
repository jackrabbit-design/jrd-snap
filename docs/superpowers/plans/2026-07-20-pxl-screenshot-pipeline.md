# pxl Screenshot Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fully working screenshot-only version of pxl: tray/menubar app that captures area or full-screen screenshots, opens them in an annotation editor (arrow/rect/ellipse/pen/highlighter/text/blur/crop), and on "Save & Upload" pushes the flattened PNG to an S3 or DigitalOcean Spaces bucket, copies the public URL to the clipboard, and shows a notification.

**Architecture:** Tauri v2 app, one Rust crate (`src-tauri`) for OS integration (tray, global shortcuts, screen capture via `xcap`, S3-compatible upload via `aws-sdk-s3`, credential storage via OS keychain through the `keyring` crate) and one React + TypeScript frontend (Vite) for the overlay/editor/settings windows.

**Tech Stack:** Tauri 2, Rust, `xcap` (cross-platform screen capture), `image` (crop/encode), `aws-sdk-s3` + `aws-config` (S3/Spaces client, custom endpoint support), `keyring` (OS credential storage), `nanoid` (filename entropy), `tauri-plugin-global-shortcut`, `tauri-plugin-notification`, `tauri-plugin-clipboard-manager`; React 18 + TypeScript + Vite, `react-konva`/`konva` (annotation canvas), Vitest + React Testing Library.

## Global Constraints

- Filenames: `{optional-user-prefix-}{6-char nanoid}.{ext}` using the URL-safe alphabet (`A-Za-z0-9_-`). Source: spec "Filename generation".
- Object key = optional S3 Key Prefix (folder path) + filename. Key Prefix and filename Prefix are independent settings. Source: spec "Filename generation".
- Uploaded objects are public-read; no presigned/expiring URLs in this plan. Source: spec "Upload configuration".
- Access Key ID / Secret Access Key are stored in the OS keychain via the `keyring` crate, never in a plaintext config file. Source: spec "Upload configuration".
- No persistent local copy of captures is written; temp files are deleted after a successful upload, retained on failure for retry. Source: spec "Local storage" / "Error handling".
- Annotation tools required: arrow, rectangle, ellipse, freehand pen, highlighter, text label, blur/pixelate region, crop/resize. Source: spec "Annotation tools".
- One active upload destination (S3 or Spaces) at a time. Source: spec "Upload configuration".

---

## File Structure

```
pxl/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs                 # app entry, plugin registration, window/tray setup
      tray.rs                 # tray menu construction + event handling
      filename.rs             # filename generation (pure, unit tested)
      object_key.rs            # S3 object key construction (pure, unit tested)
      settings.rs              # UploadSettings struct, config file load/save, CredentialStore trait + KeyringCredentialStore
      capture.rs                # full-screen + area screenshot capture (xcap + image)
      upload.rs                 # S3-compatible client, build_public_url (pure), upload_object (async)
      commands.rs                # #[tauri::command] functions exposed to the frontend
  src/
    main.tsx
    lib/
      api.ts                    # typed wrappers around Tauri `invoke`
    windows/
      overlay/
        OverlayApp.tsx           # fullscreen drag-to-select rectangle
      editor/
        EditorApp.tsx             # editor window shell, mode = image
        toolState.ts               # pure tool/shape state machine (unit tested)
        AnnotationCanvas.tsx        # react-konva canvas wired to toolState
        Toolbar.tsx                  # tool picker + color/stroke controls
        export.ts                    # flatten canvas -> PNG bytes
      settings/
        SettingsApp.tsx               # settings window shell
        UploadConfigForm.tsx           # provider/bucket/region/endpoint/keys/domain/prefixes
        HotkeyConfigForm.tsx            # hotkey bindings
    test/
      setup.ts
  package.json
  vite.config.ts
  tsconfig.json
```

---

### Task 1: Scaffold Tauri + React project

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`
- Create: `.gitignore` additions (already have a root `.gitignore`; confirm `src-tauri/target/`, `node_modules/`, `dist/` present)

**Interfaces:**
- Produces: a running `npm run tauri dev` command that opens one window showing "pxl" placeholder text. All later tasks build on this scaffold.

- [ ] **Step 1: Scaffold via create-tauri-app**

```bash
cd /Users/chris/Projects/pxl
npm create tauri-app@latest . -- --template react-ts --manager npm --yes
```

- [ ] **Step 2: Verify the scaffold's existing test/build tooling works**

Run: `npm install && npm run build`
Expected: builds without errors, producing `dist/`.

- [ ] **Step 3: Add Vitest + React Testing Library for later frontend unit tests**

```bash
npm install -D vitest @testing-library/react @testing-library/dom jsdom
```

Add to `package.json` `scripts`:
```json
"test": "vitest run"
```

Create `vite.config.ts` test block (merge into the existing config file the scaffold generated):
```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Create `src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

```bash
npm install -D @testing-library/jest-dom
```

- [ ] **Step 4: Run the empty test suite to confirm the harness works**

Run: `npm run test`
Expected: "No test files found" or PASS with 0 tests — no configuration errors.

- [ ] **Step 5: Verify the Tauri dev app launches**

Run: `npm run tauri dev`
Expected: a window opens showing the default scaffold page. Close it manually (Ctrl+C) once confirmed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri + React + TS project with Vitest"
```

---

### Task 2: Tray menu (static) with Quit and open-Settings

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json` (add a `settings` window entry, hidden by default)
- Create: `src/windows/settings/SettingsApp.tsx`

**Interfaces:**
- Produces: `pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()>` — called once from `main.rs` setup. Later tasks (3-9) add more menu items by editing this same function.
- Consumes: none (first window/tray task).

- [ ] **Step 1: Add a hidden `settings` window to `tauri.conf.json`**

In `src-tauri/tauri.conf.json`, under `app.windows`, add:
```json
{
  "label": "settings",
  "title": "pxl Settings",
  "url": "index.html#/settings",
  "width": 480,
  "height": 420,
  "visible": false
}
```

- [ ] **Step 2: Create the Settings placeholder React entry**

`src/windows/settings/SettingsApp.tsx`:
```tsx
export default function SettingsApp() {
  return <div style={{ padding: 16 }}>Settings (placeholder)</div>;
}
```

Modify `src/main.tsx` to route by hash (simple, no router dependency needed for two windows):
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SettingsApp from "./windows/settings/SettingsApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings") ? SettingsApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Write `src-tauri/src/tray.rs`**

```rust
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
```

- [ ] **Step 4: Wire it up in `main.rs`**

```rust
mod tray;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            tray::build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Manually verify**

Run: `npm run tauri dev`
Expected: a tray icon appears with "Capture Area", "Capture Full Screen", "Settings", "Quit". Clicking "Settings" opens a window showing "Settings (placeholder)". Clicking "Quit" closes the app. ("Capture Area"/"Capture Full Screen" do nothing yet — expected until Task 9.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add tray menu with Settings/Quit and hidden settings window"
```

---

### Task 3: Filename generation module

**Files:**
- Create: `src-tauri/src/filename.rs`
- Modify: `src-tauri/src/main.rs` (add `mod filename;`)
- Modify: `src-tauri/Cargo.toml` (add `nanoid`)

**Interfaces:**
- Produces: `pub fn generate_filename(prefix: Option<&str>, extension: &str) -> String`. Used by Task 19 (Save & Upload wiring) and Task 4 (object key construction, indirectly via the filename it's given).
- Consumes: none.

- [ ] **Step 1: Add the `nanoid` dependency**

In `src-tauri/Cargo.toml` under `[dependencies]`:
```toml
nanoid = "0.4"
```

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/filename.rs`:
```rust
pub fn generate_filename(prefix: Option<&str>, extension: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_prefix_has_six_char_id_and_extension() {
        let name = generate_filename(None, "png");
        assert!(name.ends_with(".png"));
        let stem = name.trim_end_matches(".png");
        assert_eq!(stem.len(), 6);
    }

    #[test]
    fn with_prefix_glues_prefix_dash_id() {
        let name = generate_filename(Some("chris"), "mp4");
        assert!(name.starts_with("chris-"));
        assert!(name.ends_with(".mp4"));
        let stem = name.trim_start_matches("chris-").trim_end_matches(".mp4");
        assert_eq!(stem.len(), 6);
    }

    #[test]
    fn empty_string_prefix_is_treated_as_no_prefix() {
        let name = generate_filename(Some(""), "png");
        assert!(!name.starts_with('-'));
    }

    #[test]
    fn ids_are_url_safe() {
        let name = generate_filename(None, "png");
        let stem = name.trim_end_matches(".png");
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test filename::`
Expected: FAIL — `not yet implemented` panic from `todo!()`.

- [ ] **Step 4: Implement**

Replace the `todo!()` body:
```rust
pub fn generate_filename(prefix: Option<&str>, extension: &str) -> String {
    let id = nanoid::nanoid!(6);
    match prefix {
        Some(p) if !p.is_empty() => format!("{p}-{id}.{extension}"),
        _ => format!("{id}.{extension}"),
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test filename::`
Expected: PASS, 4 tests.

- [ ] **Step 6: Register the module and commit**

In `src-tauri/src/main.rs`, add `mod filename;` near the top.

```bash
git add -A
git commit -m "feat: add filename generation with prefix + 6-char nanoid"
```

---

### Task 4: S3 object key construction module

**Files:**
- Create: `src-tauri/src/object_key.rs`
- Modify: `src-tauri/src/main.rs` (add `mod object_key;`)

**Interfaces:**
- Consumes: nothing directly, but conceptually composes with `generate_filename`'s output (a `&str` filename).
- Produces: `pub fn build_object_key(key_prefix: Option<&str>, filename: &str) -> String`. Used by Task 18/19 (upload).

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/object_key.rs`:
```rust
pub fn build_object_key(key_prefix: Option<&str>, filename: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_prefix_returns_filename_unchanged() {
        assert_eq!(build_object_key(None, "abc123.png"), "abc123.png");
    }

    #[test]
    fn prefix_without_trailing_slash_gets_one_added() {
        assert_eq!(
            build_object_key(Some("team-chris"), "abc123.png"),
            "team-chris/abc123.png"
        );
    }

    #[test]
    fn prefix_with_trailing_slash_is_not_doubled() {
        assert_eq!(
            build_object_key(Some("team-chris/"), "abc123.png"),
            "team-chris/abc123.png"
        );
    }

    #[test]
    fn empty_string_prefix_is_treated_as_no_prefix() {
        assert_eq!(build_object_key(Some(""), "abc123.png"), "abc123.png");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test object_key::`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 3: Implement**

```rust
pub fn build_object_key(key_prefix: Option<&str>, filename: &str) -> String {
    match key_prefix {
        Some(p) if !p.is_empty() => {
            let trimmed = p.trim_end_matches('/');
            format!("{trimmed}/{filename}")
        }
        _ => filename.to_string(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test object_key::`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register the module and commit**

Add `mod object_key;` to `src-tauri/src/main.rs`.

```bash
git add -A
git commit -m "feat: add S3 object key construction from key prefix + filename"
```

---

### Task 5: Settings persistence (config file + keychain credentials)

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/main.rs` (add `mod settings;`)
- Modify: `src-tauri/Cargo.toml` (add `keyring`, `serde`, `serde_json`)

**Interfaces:**
- Produces:
  - `pub enum Provider { S3, Spaces }` (serde-serializable)
  - `pub struct UploadSettings { pub provider: Provider, pub bucket: String, pub region: String, pub endpoint: Option<String>, pub custom_domain: Option<String>, pub key_prefix: Option<String>, pub filename_prefix: Option<String> }` (serde-serializable, `Default`)
  - `pub struct Credentials { pub access_key_id: String, pub secret_access_key: String }`
  - `pub trait CredentialStore { fn get(&self) -> Option<Credentials>; fn set(&self, creds: &Credentials) -> Result<(), String>; }`
  - `pub struct KeyringCredentialStore;` implementing `CredentialStore`
  - `pub fn load_settings(config_dir: &std::path::Path) -> UploadSettings`
  - `pub fn save_settings(config_dir: &std::path::Path, settings: &UploadSettings) -> Result<(), String>`
- Consumed by: Task 6 (Settings UI, via Tauri commands in Task 6's `commands.rs` additions), Task 18/19 (upload needs both `UploadSettings` and `Credentials`).

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml`:
```toml
keyring = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Write the failing tests for config file round-trip and the trait abstraction**

`src-tauri/src/settings.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Provider {
    S3,
    Spaces,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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

const KEYRING_SERVICE: &str = "pxl";
const KEYRING_USER: &str = "upload-credentials";

impl CredentialStore for KeyringCredentialStore {
    fn get(&self) -> Option<Credentials> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
        let raw = entry.get_password().ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn set(&self, creds: &Credentials) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| e.to_string())?;
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
        Ok(Credentials { access_key_id, secret_access_key })
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
            FakeCredentialStore { store: Mutex::new(HashMap::new()) }
        }
    }

    impl CredentialStore for FakeCredentialStore {
        fn get(&self) -> Option<Credentials> {
            self.store.lock().unwrap().get("upload-credentials").cloned()
        }
        fn set(&self, creds: &Credentials) -> Result<(), String> {
            self.store.lock().unwrap().insert("upload-credentials", creds.clone());
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
}
```

- [ ] **Step 3: Add `tempfile` as a dev-dependency**

In `src-tauri/Cargo.toml`:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd src-tauri && cargo test settings::`
Expected: compile error initially only if types are missing — since this task writes the implementation directly rather than a `todo!()` (persistence logic is straightforward CRUD, not a single behavior to red-green), instead verify by temporarily commenting out the body of `load_settings`/`save_settings`/`KeyringCredentialStore` methods and confirming tests fail, then restore. If you prefer strict red-green, replace each function body with `unimplemented!()` first, run `cargo test settings::` and confirm FAIL, then paste in the real bodies from Step 2.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test settings::`
Expected: PASS, 3 tests.

- [ ] **Step 6: Register the module and commit**

Add `mod settings;` to `src-tauri/src/main.rs`.

```bash
git add -A
git commit -m "feat: add upload settings persistence and keychain credential store"
```

---

### Task 6: Settings window UI (upload config form)

**Files:**
- Create: `src/windows/settings/UploadConfigForm.tsx`
- Modify: `src/windows/settings/SettingsApp.tsx`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs` (register commands, add `mod commands;`)
- Modify: `src/lib/api.ts` (create this file)

**Interfaces:**
- Consumes: `settings::{UploadSettings, Credentials, load_settings, save_settings, KeyringCredentialStore, CredentialStore}` from Task 5.
- Produces:
  - Tauri commands: `get_upload_settings() -> UploadSettings`, `save_upload_settings(settings: UploadSettings) -> Result<(), String>`, `save_credentials(access_key_id: String, secret_access_key: String) -> Result<(), String>`, `has_credentials() -> bool`.
  - `src/lib/api.ts` exports: `getUploadSettings()`, `saveUploadSettings(settings)`, `saveCredentials(accessKeyId, secretAccessKey)`, `hasCredentials()` — typed wrappers other frontend tasks (19) import.

- [ ] **Step 1: Write the Tauri commands**

`src-tauri/src/commands.rs`:
```rust
use crate::settings::{self, CredentialStore, Credentials, KeyringCredentialStore, UploadSettings};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_upload_settings(app: AppHandle) -> UploadSettings {
    settings::load_settings(&app.path().app_config_dir().unwrap())
}

#[tauri::command]
pub fn save_upload_settings(app: AppHandle, settings: UploadSettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_settings(&dir, &settings)
}

#[tauri::command]
pub fn save_credentials(access_key_id: String, secret_access_key: String) -> Result<(), String> {
    KeyringCredentialStore.set(&Credentials { access_key_id, secret_access_key })
}

#[tauri::command]
pub fn has_credentials() -> bool {
    KeyringCredentialStore.get().is_some()
}
```

- [ ] **Step 2: Register commands in `main.rs`**

```rust
mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_upload_settings,
            commands::save_upload_settings,
            commands::save_credentials,
            commands::has_credentials,
        ])
        .setup(|app| {
            tray::build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Write the typed frontend API wrapper**

`src/lib/api.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export type Provider = "S3" | "Spaces";

export interface UploadSettings {
  provider: Provider;
  bucket: string;
  region: string;
  endpoint: string | null;
  customDomain: string | null;
  keyPrefix: string | null;
  filenamePrefix: string | null;
}

export function getUploadSettings(): Promise<UploadSettings> {
  return invoke("get_upload_settings");
}

export function saveUploadSettings(settings: UploadSettings): Promise<void> {
  return invoke("save_upload_settings", { settings });
}

export function saveCredentials(
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  return invoke("save_credentials", {
    accessKeyId,
    secretAccessKey,
  });
}

export function hasCredentials(): Promise<boolean> {
  return invoke("has_credentials");
}
```

Note: the Rust struct uses `snake_case` field names (`custom_domain`, `key_prefix`, `filename_prefix`); Tauri's default `invoke` serialization uses `camelCase` on the JS side and Serde's `#[serde(rename_all = "camelCase")]` must be added to `UploadSettings` in `src-tauri/src/settings.rs` for the two to match. Add this now:

In `src-tauri/src/settings.rs`, change:
```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UploadSettings {
```
to:
```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadSettings {
```
Run: `cd src-tauri && cargo test settings::` — expected PASS still (renaming only affects serde's wire format, not the Rust-side field names the tests use).

- [ ] **Step 4: Write the form component**

`src/windows/settings/UploadConfigForm.tsx`:
```tsx
import { useEffect, useState } from "react";
import {
  getUploadSettings,
  saveUploadSettings,
  saveCredentials,
  hasCredentials,
  type UploadSettings,
} from "../../lib/api";

const EMPTY: UploadSettings = {
  provider: "S3",
  bucket: "",
  region: "",
  endpoint: null,
  customDomain: null,
  keyPrefix: null,
  filenamePrefix: null,
};

export default function UploadConfigForm() {
  const [settings, setSettings] = useState<UploadSettings>(EMPTY);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getUploadSettings().then(setSettings);
    hasCredentials().then(setCredsSaved);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await saveUploadSettings(settings);
    if (accessKeyId && secretAccessKey) {
      await saveCredentials(accessKeyId, secretAccessKey);
      setAccessKeyId("");
      setSecretAccessKey("");
      setCredsSaved(true);
    }
    setStatus("Saved");
    setTimeout(() => setStatus(null), 2000);
  }

  function field(key: keyof UploadSettings, value: string) {
    setSettings((s) => ({ ...s, [key]: value === "" ? null : value }));
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      <label>
        Provider
        <select
          value={settings.provider}
          onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value as "S3" | "Spaces" }))}
        >
          <option value="S3">Amazon S3</option>
          <option value="Spaces">DigitalOcean Spaces</option>
        </select>
      </label>
      <label>
        Bucket
        <input value={settings.bucket} onChange={(e) => setSettings((s) => ({ ...s, bucket: e.target.value }))} />
      </label>
      <label>
        Region
        <input value={settings.region} onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))} />
      </label>
      <label>
        Endpoint (Spaces only, e.g. nyc3.digitaloceanspaces.com)
        <input value={settings.endpoint ?? ""} onChange={(e) => field("endpoint", e.target.value)} />
      </label>
      <label>
        Custom domain / CDN (optional)
        <input value={settings.customDomain ?? ""} onChange={(e) => field("customDomain", e.target.value)} />
      </label>
      <label>
        Key prefix / folder (optional)
        <input value={settings.keyPrefix ?? ""} onChange={(e) => field("keyPrefix", e.target.value)} />
      </label>
      <label>
        Filename prefix (optional)
        <input value={settings.filenamePrefix ?? ""} onChange={(e) => field("filenamePrefix", e.target.value)} />
      </label>
      <label>
        Access Key ID {credsSaved && !accessKeyId ? "(saved — leave blank to keep)" : ""}
        <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
      </label>
      <label>
        Secret Access Key {credsSaved && !secretAccessKey ? "(saved — leave blank to keep)" : ""}
        <input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
      </label>
      <button type="submit">Save</button>
      {status && <span>{status}</span>}
    </form>
  );
}
```

- [ ] **Step 5: Wire it into `SettingsApp.tsx`**

```tsx
import UploadConfigForm from "./UploadConfigForm";

export default function SettingsApp() {
  return (
    <div>
      <h2 style={{ paddingLeft: 16 }}>pxl Settings</h2>
      <UploadConfigForm />
    </div>
  );
}
```

- [ ] **Step 6: Manually verify**

Run: `npm run tauri dev`, open Settings from the tray, fill in bucket/region/keys, click Save, quit and relaunch the app, reopen Settings.
Expected: bucket/region/etc. are pre-filled from the saved config; Access Key ID/Secret Access Key fields show "(saved — leave blank to keep)" rather than the actual secret (never round-tripped back to the UI).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add settings window upload config form and backing commands"
```

---

### Task 7: Global shortcuts + hotkey settings UI

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/settings.rs` (add `HotkeySettings`)
- Modify: `src-tauri/src/commands.rs` (add hotkey commands)
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-global-shortcut`)
- Create: `src/windows/settings/HotkeyConfigForm.tsx`
- Modify: `src/windows/settings/SettingsApp.tsx`
- Modify: `src/lib/api.ts` (add hotkey API)

**Interfaces:**
- Consumes: `settings::{load_settings, save_settings}` pattern from Task 5 (mirrors it for a second settings file).
- Produces: `pub struct HotkeySettings { pub capture_area: String, pub capture_full: String }` (default `"CommandOrControl+Shift+2"` / `"CommandOrControl+Shift+3"`), commands `get_hotkey_settings`, `save_hotkey_settings`. Task 9 will bind `capture_area`/`capture_full` shortcut IDs to actual capture commands.

- [ ] **Step 1: Add the plugin dependency**

`src-tauri/Cargo.toml`:
```toml
tauri-plugin-global-shortcut = "2"
```

```bash
npm install @tauri-apps/plugin-global-shortcut
```

- [ ] **Step 2: Add `HotkeySettings` to `settings.rs` with tests**

Append to `src-tauri/src/settings.rs`:
```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettings {
    pub capture_area: String,
    pub capture_full: String,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        HotkeySettings {
            capture_area: "CommandOrControl+Shift+2".into(),
            capture_full: "CommandOrControl+Shift+3".into(),
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
```

Add tests in the existing `mod tests` block:
```rust
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
    };
    save_hotkeys(dir.path(), &hotkeys).unwrap();
    assert_eq!(load_hotkeys(dir.path()), hotkeys);
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test settings::`
Expected: PASS, 5 tests (3 from Task 5 + 2 new).

- [ ] **Step 4: Add commands**

Append to `src-tauri/src/commands.rs`:
```rust
use crate::settings::HotkeySettings;

#[tauri::command]
pub fn get_hotkey_settings(app: AppHandle) -> HotkeySettings {
    settings::load_hotkeys(&app.path().app_config_dir().unwrap())
}

#[tauri::command]
pub fn save_hotkey_settings(app: AppHandle, hotkeys: HotkeySettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_hotkeys(&dir, &hotkeys)
}
```

- [ ] **Step 5: Register the plugin and bind shortcuts on startup, re-binding on save**

Modify `src-tauri/src/main.rs`:
```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn register_shortcuts(app: &tauri::AppHandle) {
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
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
```

Modify `commands::save_hotkey_settings` to re-register after saving:
```rust
#[tauri::command]
pub fn save_hotkey_settings(app: AppHandle, hotkeys: HotkeySettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_hotkeys(&dir, &hotkeys)?;
    crate::register_shortcuts(&app);
    Ok(())
}
```
(Make `register_shortcuts` `pub(crate)` in `main.rs` so `commands.rs` can call it.)

Note: `trigger-capture-area`/`trigger-capture-full` events are consumed starting in Task 9, once actual capture commands exist. Until then they're emitted but unhandled — harmless.

- [ ] **Step 6: Add frontend API + form**

Append to `src/lib/api.ts`:
```ts
export interface HotkeySettings {
  captureArea: string;
  captureFull: string;
}

export function getHotkeySettings(): Promise<HotkeySettings> {
  return invoke("get_hotkey_settings");
}

export function saveHotkeySettings(hotkeys: HotkeySettings): Promise<void> {
  return invoke("save_hotkey_settings", { hotkeys });
}
```

`src/windows/settings/HotkeyConfigForm.tsx`:
```tsx
import { useEffect, useState } from "react";
import { getHotkeySettings, saveHotkeySettings, type HotkeySettings } from "../../lib/api";

const DEFAULT: HotkeySettings = {
  captureArea: "CommandOrControl+Shift+2",
  captureFull: "CommandOrControl+Shift+3",
};

export default function HotkeyConfigForm() {
  const [hotkeys, setHotkeys] = useState<HotkeySettings>(DEFAULT);

  useEffect(() => {
    getHotkeySettings().then(setHotkeys);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await saveHotkeySettings(hotkeys);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      <label>
        Capture Area
        <input
          value={hotkeys.captureArea}
          onChange={(e) => setHotkeys((h) => ({ ...h, captureArea: e.target.value }))}
        />
      </label>
      <label>
        Capture Full Screen
        <input
          value={hotkeys.captureFull}
          onChange={(e) => setHotkeys((h) => ({ ...h, captureFull: e.target.value }))}
        />
      </label>
      <button type="submit">Save Hotkeys</button>
    </form>
  );
}
```

Add to `SettingsApp.tsx`:
```tsx
import HotkeyConfigForm from "./HotkeyConfigForm";
// ...
<HotkeyConfigForm />
```

- [ ] **Step 7: Manually verify**

Run: `npm run tauri dev`, open Settings, change a hotkey string, save, then check (via a temporary `println!` in the shortcut handler, or the next task's actual capture wiring) that the new binding fires. Confirm the old binding no longer fires.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add configurable global shortcuts for capture actions"
```

---

### Task 8: Overlay window — drag-to-select rectangle

**Files:**
- Create: `src/windows/overlay/OverlayApp.tsx`
- Modify: `src/main.tsx` (route `#/overlay` to `OverlayApp`)
- Modify: `src-tauri/tauri.conf.json` (add `overlay` window: fullscreen, transparent, decorations off, always-on-top, hidden by default)
- Modify: `src-tauri/src/commands.rs` (add `show_overlay`, `hide_overlay`, `overlay_selection_made`)
- Modify: `src/lib/api.ts` (add overlay API)

**Interfaces:**
- Produces: Tauri command `show_overlay(app: AppHandle) -> Result<(), String>` (shows + focuses the overlay window across all displays — v1 targets the primary display only, matching Task 9's primary-monitor capture scope), event `"overlay-selection"` emitted by the overlay window with payload `{ x: number, y: number, width: number, height: number }` (physical pixels, top-left origin), command `hide_overlay(app: AppHandle)`.
- Consumed by: Task 9 (capture_area listens for `"overlay-selection"`).

- [ ] **Step 1: Add the overlay window to `tauri.conf.json`**

```json
{
  "label": "overlay",
  "title": "pxl Overlay",
  "url": "index.html#/overlay",
  "width": 1,
  "height": 1,
  "visible": false,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "fullscreen": true
}
```

- [ ] **Step 2: Add overlay show/hide commands**

Append to `src-tauri/src/commands.rs`:
```rust
#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    win.hide().map_err(|e| e.to_string())
}
```

Register both in `main.rs`'s `generate_handler!`.

- [ ] **Step 3: Write the overlay React component**

`src/windows/overlay/OverlayApp.tsx`:
```tsx
import { useState, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

interface Point {
  x: number;
  y: number;
}

export default function OverlayApp() {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const dragging = useRef(false);

  function handleMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    setStart({ x: e.clientX, y: e.clientY });
    setCurrent({ x: e.clientX, y: e.clientY });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    setCurrent({ x: e.clientX, y: e.clientY });
  }

  async function handleMouseUp() {
    if (!dragging.current || !start || !current) return;
    dragging.current = false;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    setStart(null);
    setCurrent(null);
    if (width < 2 || height < 2) {
      await invoke("hide_overlay");
      return;
    }
    await emit("overlay-selection", { x, y, width, height });
    await invoke("hide_overlay");
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setStart(null);
      setCurrent(null);
      await invoke("hide_overlay");
    }
  }

  const rect =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      tabIndex={0}
      autoFocus
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        cursor: "crosshair",
        background: "rgba(0,0,0,0.2)",
      }}
    >
      {rect && (
        <div
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            background: "rgba(255,255,255,0.15)",
            border: "1px solid #fff",
          }}
        />
      )}
    </div>
  );
}
```

Note: `getCurrentWindow` is imported but unused in this snippet — remove the import (it was scaffolding left from an earlier iteration; there's no dead-code use for it in this component).

- [ ] **Step 4: Route `#/overlay`**

Modify `src/main.tsx`:
```tsx
import OverlayApp from "./windows/overlay/OverlayApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings")
  ? SettingsApp
  : hash.startsWith("#/overlay")
  ? OverlayApp
  : App;
```

- [ ] **Step 5: Wire tray "Capture Area" to show the overlay**

Modify `src-tauri/src/tray.rs`'s `on_menu_event` match:
```rust
"capture_area" => {
    let _ = crate::commands::show_overlay(app.clone());
}
```
(`show_overlay` takes `AppHandle` by value per its signature above — clone the handle from the closure's `app: &AppHandle`.)

- [ ] **Step 6: Manually verify**

Run: `npm run tauri dev`. Click "Capture Area" from the tray. A fullscreen dim overlay appears; dragging draws a white-bordered rectangle; releasing hides the overlay (no capture happens yet — that's Task 9). Pressing Escape mid-drag also hides it without emitting a selection.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add fullscreen overlay window for area selection"
```

---

### Task 9: Screenshot capture (full screen + area)

**Files:**
- Create: `src-tauri/src/capture.rs`
- Modify: `src-tauri/src/main.rs` (add `mod capture;`, listen for `trigger-capture-area`/`trigger-capture-full` events, listen for `overlay-selection`)
- Modify: `src-tauri/src/commands.rs` (add `capture_full_screen`, `capture_area`)
- Modify: `src-tauri/Cargo.toml` (add `xcap`, `image`)
- Modify: `src-tauri/src/tray.rs` (wire "Capture Full Screen" menu item)

**Interfaces:**
- Produces:
  - `pub struct CaptureRect { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }`
  - `pub fn capture_full_screen_png() -> Result<Vec<u8>, String>`
  - `pub fn capture_area_png(rect: CaptureRect) -> Result<Vec<u8>, String>`
  - Tauri commands `capture_full_screen() -> Result<Vec<u8>, String>` and `capture_area(rect: CaptureRect) -> Result<Vec<u8>, String>`, both returning raw PNG bytes.
- Consumed by: Task 10 (editor window opens with these bytes), Task 8's `overlay-selection` event (payload shape matches `CaptureRect`, camelCase on the wire via `#[serde(rename_all = "camelCase")]`).

- [ ] **Step 1: Add dependencies**

`src-tauri/Cargo.toml`:
```toml
xcap = "0.0.14"
image = "0.25"
```

- [ ] **Step 2: Write `capture.rs` with the pure crop logic under test**

```rust
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn crop_to_rect(
    full: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    rect: CaptureRect,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let x = rect.x.max(0) as u32;
    let y = rect.y.max(0) as u32;
    let width = rect.width.min(full.width().saturating_sub(x));
    let height = rect.height.min(full.height().saturating_sub(y));
    image::imageops::crop_imm(full, x, y, width, height).to_image()
}

pub fn encode_png(img: &ImageBuffer<Rgba<u8>, Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn primary_monitor() -> Result<xcap::Monitor, String> {
    xcap::Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.is_primary())
        .ok_or_else(|| "no primary monitor found".to_string())
}

pub fn capture_full_screen_png() -> Result<Vec<u8>, String> {
    let monitor = primary_monitor()?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    encode_png(&img)
}

pub fn capture_area_png(rect: CaptureRect) -> Result<Vec<u8>, String> {
    let monitor = primary_monitor()?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let cropped = crop_to_rect(&img, rect);
    encode_png(&cropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_image(width: u32, height: u32) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
        ImageBuffer::from_fn(width, height, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 0, 255])
        })
    }

    #[test]
    fn crop_produces_requested_dimensions() {
        let full = solid_image(200, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 10, y: 10, width: 50, height: 30 });
        assert_eq!(cropped.width(), 50);
        assert_eq!(cropped.height(), 30);
    }

    #[test]
    fn crop_clamps_to_image_bounds() {
        let full = solid_image(100, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 90, y: 90, width: 50, height: 50 });
        assert_eq!(cropped.width(), 10);
        assert_eq!(cropped.height(), 10);
    }

    #[test]
    fn crop_preserves_pixel_content() {
        let full = solid_image(100, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 5, y: 5, width: 10, height: 10 });
        assert_eq!(cropped.get_pixel(0, 0), full.get_pixel(5, 5));
    }

    #[test]
    fn encode_png_round_trips_through_decode() {
        let img = solid_image(10, 10);
        let bytes = encode_png(&img).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(decoded.width(), 10);
        assert_eq!(decoded.height(), 10);
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test capture::`
Expected: PASS, 4 tests (these test the pure crop/encode logic; `capture_full_screen_png`/`capture_area_png` themselves depend on a real display and are covered by manual verification in Step 6, not unit tests).

- [ ] **Step 4: Add Tauri commands**

Append to `src-tauri/src/commands.rs`:
```rust
use crate::capture::{self, CaptureRect};

#[tauri::command]
pub fn capture_full_screen() -> Result<Vec<u8>, String> {
    capture::capture_full_screen_png()
}

#[tauri::command]
pub fn capture_area(rect: CaptureRect) -> Result<Vec<u8>, String> {
    capture::capture_area_png(rect)
}
```

Register both in `main.rs`'s `generate_handler!`.

- [ ] **Step 5: Wire tray + shortcuts + overlay selection to open the editor with captured bytes**

This step also creates the editor window (fleshed out fully in Task 10) so capture has somewhere to send its output. For now, add a minimal `editor` window entry to `tauri.conf.json` (hidden) and a helper that shows it — Task 10 replaces the placeholder body.

`tauri.conf.json`, add window:
```json
{
  "label": "editor",
  "title": "pxl Editor",
  "url": "index.html#/editor",
  "width": 900,
  "height": 700,
  "visible": false
}
```

Modify `src-tauri/src/main.rs` — add a helper and wire events:
```rust
mod capture;

fn open_editor_with_png(app: &tauri::AppHandle, png_bytes: Vec<u8>) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to("editor", "editor-load-image", b64);
    }
}
```

Add `base64 = "0.22"` to `src-tauri/Cargo.toml`.

In `main.rs`'s `setup`, listen for the events:
```rust
.setup(|app| {
    tray::build_tray(app.handle())?;
    register_shortcuts(app.handle());

    let handle = app.handle().clone();
    app.listen("trigger-capture-full", move |_event| {
        if let Ok(bytes) = capture::capture_full_screen_png() {
            open_editor_with_png(&handle, bytes);
        }
    });

    let handle2 = app.handle().clone();
    app.listen("trigger-capture-area", move |_event| {
        let _ = commands::show_overlay(handle2.clone());
    });

    let handle3 = app.handle().clone();
    app.listen("overlay-selection", move |event| {
        if let Ok(rect) = serde_json::from_str::<capture::CaptureRect>(event.payload()) {
            if let Ok(bytes) = capture::capture_area_png(rect) {
                open_editor_with_png(&handle3, bytes);
            }
        }
    });

    Ok(())
})
```

Modify `src-tauri/src/tray.rs`'s `on_menu_event` to reuse the same paths:
```rust
"capture_area" => {
    let _ = crate::commands::show_overlay(app.clone());
}
"capture_full" => {
    if let Ok(bytes) = crate::capture::capture_full_screen_png() {
        crate::open_editor_with_png(app, bytes);
    }
}
```
(Make `open_editor_with_png` `pub(crate)` in `main.rs`.)

- [ ] **Step 6: Manually verify**

Run: `npm run tauri dev`. Click "Capture Full Screen" from the tray — the (still placeholder, per Task 2's `App.tsx`) editor window should show/focus. Click "Capture Area", drag a rectangle — same result. Trigger both via the configured global hotkeys too. (Visual confirmation that the *correct image* loaded comes in Task 10 once the editor actually renders it.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add full-screen and area screenshot capture via xcap"
```

---

### Task 10: Editor window scaffold + image loading

**Files:**
- Create: `src/windows/editor/EditorApp.tsx`
- Modify: `src/main.tsx` (route `#/editor`)

**Interfaces:**
- Consumes: `"editor-load-image"` event from Task 9 (payload: base64-encoded PNG string).
- Produces: `EditorApp` renders the loaded image inside a container `<div id="editor-canvas-container">` that Task 12 (`AnnotationCanvas`) mounts into. Exposes the decoded image as a data URL via local state, passed to `AnnotationCanvas` as an `imageSrc: string` prop (defined fully in Task 12).

- [ ] **Step 1: Write the editor shell**

`src/windows/editor/EditorApp.tsx`:
```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!imageSrc) {
    return <div style={{ padding: 16 }}>Waiting for capture…</div>;
  }

  return (
    <div id="editor-canvas-container" style={{ width: "100%", height: "100%" }}>
      <img src={imageSrc} style={{ maxWidth: "100%", display: "block" }} alt="captured screenshot" />
    </div>
  );
}
```

- [ ] **Step 2: Route `#/editor`**

Modify `src/main.tsx`:
```tsx
import EditorApp from "./windows/editor/EditorApp";

const Root = hash.startsWith("#/settings")
  ? SettingsApp
  : hash.startsWith("#/overlay")
  ? OverlayApp
  : hash.startsWith("#/editor")
  ? EditorApp
  : App;
```

- [ ] **Step 3: Manually verify**

Run: `npm run tauri dev`. Capture full screen or an area. The editor window should now show the actual captured image (as a plain `<img>` — annotation canvas comes in Task 12).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: editor window loads and displays captured screenshot"
```

---

### Task 11: Annotation tool state machine (pure, unit tested)

**Files:**
- Create: `src/windows/editor/toolState.ts`
- Create: `src/windows/editor/toolState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ToolType = "select" | "arrow" | "rect" | "ellipse" | "pen" | "highlighter" | "text" | "blur" | "crop";
  export interface ShapeBase { id: string; type: ToolType; color: string; strokeWidth: number; }
  export interface PointShape extends ShapeBase { points: number[]; }        // arrow, pen, highlighter
  export interface BoxShape extends ShapeBase { x: number; y: number; width: number; height: number; }  // rect, ellipse, blur, crop
  export interface TextShape extends ShapeBase { x: number; y: number; text: string; fontSize: number; }
  export type Shape = PointShape | BoxShape | TextShape;
  export interface EditorState { tool: ToolType; shapes: Shape[]; selectedId: string | null; }
  export const initialState: EditorState;
  export function setTool(state: EditorState, tool: ToolType): EditorState;
  export function addShape(state: EditorState, shape: Shape): EditorState;
  export function updateShape(state: EditorState, id: string, patch: Partial<Shape>): EditorState;
  export function removeShape(state: EditorState, id: string): EditorState;
  export function selectShape(state: EditorState, id: string | null): EditorState;
  ```
- Consumed by: Task 12 (`AnnotationCanvas`), Task 13-16 (per-tool creation logic).

- [ ] **Step 1: Write the failing tests**

`src/windows/editor/toolState.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  initialState,
  setTool,
  addShape,
  updateShape,
  removeShape,
  selectShape,
  type BoxShape,
} from "./toolState";

function rectShape(id: string): BoxShape {
  return { id, type: "rect", color: "#ff0000", strokeWidth: 2, x: 0, y: 0, width: 10, height: 10 };
}

describe("toolState", () => {
  it("starts with the select tool and no shapes", () => {
    expect(initialState.tool).toBe("select");
    expect(initialState.shapes).toEqual([]);
    expect(initialState.selectedId).toBeNull();
  });

  it("setTool switches the active tool without touching shapes", () => {
    const next = setTool(initialState, "arrow");
    expect(next.tool).toBe("arrow");
    expect(next.shapes).toBe(initialState.shapes);
  });

  it("addShape appends a shape and does not mutate the previous state", () => {
    const shape = rectShape("a");
    const next = addShape(initialState, shape);
    expect(next.shapes).toHaveLength(1);
    expect(initialState.shapes).toHaveLength(0);
    expect(next.shapes[0]).toEqual(shape);
  });

  it("updateShape patches only the matching shape", () => {
    const state = addShape(addShape(initialState, rectShape("a")), rectShape("b"));
    const next = updateShape(state, "a", { width: 99 });
    const a = next.shapes.find((s) => s.id === "a") as BoxShape;
    const b = next.shapes.find((s) => s.id === "b") as BoxShape;
    expect(a.width).toBe(99);
    expect(b.width).toBe(10);
  });

  it("removeShape drops the matching shape and clears selection if it was selected", () => {
    const state = selectShape(addShape(initialState, rectShape("a")), "a");
    const next = removeShape(state, "a");
    expect(next.shapes).toHaveLength(0);
    expect(next.selectedId).toBeNull();
  });

  it("removeShape leaves selection alone if a different shape was selected", () => {
    const state = selectShape(
      addShape(addShape(initialState, rectShape("a")), rectShape("b")),
      "b",
    );
    const next = removeShape(state, "a");
    expect(next.selectedId).toBe("b");
  });

  it("selectShape sets selectedId, including back to null", () => {
    const selected = selectShape(initialState, "a");
    expect(selected.selectedId).toBe("a");
    const cleared = selectShape(selected, null);
    expect(cleared.selectedId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- toolState`
Expected: FAIL — `toolState.ts` does not exist / exports missing.

- [ ] **Step 3: Implement `toolState.ts`**

```ts
export type ToolType =
  | "select"
  | "arrow"
  | "rect"
  | "ellipse"
  | "pen"
  | "highlighter"
  | "text"
  | "blur"
  | "crop";

export interface ShapeBase {
  id: string;
  type: ToolType;
  color: string;
  strokeWidth: number;
}

export interface PointShape extends ShapeBase {
  points: number[];
}

export interface BoxShape extends ShapeBase {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextShape extends ShapeBase {
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export type Shape = PointShape | BoxShape | TextShape;

export interface EditorState {
  tool: ToolType;
  shapes: Shape[];
  selectedId: string | null;
}

export const initialState: EditorState = {
  tool: "select",
  shapes: [],
  selectedId: null,
};

export function setTool(state: EditorState, tool: ToolType): EditorState {
  return { ...state, tool };
}

export function addShape(state: EditorState, shape: Shape): EditorState {
  return { ...state, shapes: [...state.shapes, shape] };
}

export function updateShape(
  state: EditorState,
  id: string,
  patch: Partial<Shape>,
): EditorState {
  return {
    ...state,
    shapes: state.shapes.map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)),
  };
}

export function removeShape(state: EditorState, id: string): EditorState {
  return {
    ...state,
    shapes: state.shapes.filter((s) => s.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  };
}

export function selectShape(state: EditorState, id: string | null): EditorState {
  return { ...state, selectedId: id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- toolState`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add annotation tool/shape state machine"
```

---

### Task 12: Annotation canvas rendering (react-konva) — arrow/rect/ellipse tools

**Files:**
- Create: `src/windows/editor/AnnotationCanvas.tsx`
- Create: `src/windows/editor/Toolbar.tsx`
- Modify: `src/windows/editor/EditorApp.tsx`
- Modify: `package.json` (add `konva`, `react-konva`)

**Interfaces:**
- Consumes: `toolState.{EditorState, Shape, BoxShape, PointShape, ToolType, addShape, updateShape, setTool}` from Task 11.
- Produces: `AnnotationCanvas` component with props `{ imageSrc: string; state: EditorState; onStateChange: (next: EditorState) => void }`. `Toolbar` component with props `{ tool: ToolType; color: string; strokeWidth: number; onToolChange: (t: ToolType) => void; onColorChange: (c: string) => void; onStrokeWidthChange: (w: number) => void }`. Both consumed by `EditorApp` (Task 10, extended here) and extended in Tasks 13-16 to add more tools to the same `AnnotationCanvas`.

- [ ] **Step 1: Install dependencies**

```bash
npm install konva react-konva
```

- [ ] **Step 2: Write `Toolbar.tsx`**

```tsx
import type { ToolType } from "./toolState";

const TOOLS: { type: ToolType; label: string }[] = [
  { type: "select", label: "Select" },
  { type: "arrow", label: "Arrow" },
  { type: "rect", label: "Rectangle" },
  { type: "ellipse", label: "Ellipse" },
];

interface Props {
  tool: ToolType;
  color: string;
  strokeWidth: number;
  onToolChange: (t: ToolType) => void;
  onColorChange: (c: string) => void;
  onStrokeWidthChange: (w: number) => void;
}

export default function Toolbar({ tool, color, strokeWidth, onToolChange, onColorChange, onStrokeWidthChange }: Props) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid #ccc" }}>
      {TOOLS.map((t) => (
        <button
          key={t.type}
          onClick={() => onToolChange(t.type)}
          style={{ fontWeight: tool === t.type ? "bold" : "normal" }}
        >
          {t.label}
        </button>
      ))}
      <input type="color" value={color} onChange={(e) => onColorChange(e.target.value)} />
      <input
        type="number"
        min={1}
        max={20}
        value={strokeWidth}
        onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
        style={{ width: 48 }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Write `AnnotationCanvas.tsx`**

```tsx
import { useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Arrow, Rect, Ellipse } from "react-konva";
import useImage from "use-image";
import type { EditorState, Shape, BoxShape, PointShape } from "./toolState";
import { addShape } from "./toolState";

interface Props {
  imageSrc: string;
  state: EditorState;
  color: string;
  strokeWidth: number;
  onStateChange: (next: EditorState) => void;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `shape-${nextId}`;
}

export default function AnnotationCanvas({ imageSrc, state, color, strokeWidth, onStateChange }: Props) {
  const [image] = useImage(imageSrc);
  const drawing = useRef<Shape | null>(null);
  const [, forceRerender] = useState(0);

  function handleMouseDown(e: any) {
    if (state.tool === "select") return;
    const pos = e.target.getStage().getPointerPosition();
    const id = newId();
    if (state.tool === "arrow") {
      drawing.current = { id, type: "arrow", color, strokeWidth, points: [pos.x, pos.y, pos.x, pos.y] } as PointShape;
    } else if (state.tool === "rect" || state.tool === "ellipse") {
      drawing.current = {
        id,
        type: state.tool,
        color,
        strokeWidth,
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
      } as BoxShape;
    } else {
      return;
    }
    onStateChange(addShape(state, drawing.current));
  }

  function handleMouseMove(e: any) {
    if (!drawing.current) return;
    const pos = e.target.getStage().getPointerPosition();
    const shapes = state.shapes.slice();
    const idx = shapes.findIndex((s) => s.id === drawing.current!.id);
    if (idx === -1) return;
    if (drawing.current.type === "arrow") {
      const shape = drawing.current as PointShape;
      shape.points = [shape.points[0], shape.points[1], pos.x, pos.y];
    } else {
      const shape = drawing.current as BoxShape;
      shape.width = pos.x - shape.x;
      shape.height = pos.y - shape.y;
    }
    shapes[idx] = { ...drawing.current };
    onStateChange({ ...state, shapes });
    forceRerender((n) => n + 1);
  }

  function handleMouseUp() {
    drawing.current = null;
  }

  return (
    <Stage
      width={image?.width ?? 800}
      height={image?.height ?? 600}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <Layer>
        {image && <KonvaImage image={image} />}
        {state.shapes.map((shape) => {
          if (shape.type === "arrow") {
            const s = shape as PointShape;
            return <Arrow key={s.id} points={s.points} stroke={s.color} strokeWidth={s.strokeWidth} fill={s.color} />;
          }
          if (shape.type === "rect") {
            const s = shape as BoxShape;
            return (
              <Rect key={s.id} x={s.x} y={s.y} width={s.width} height={s.height} stroke={s.color} strokeWidth={s.strokeWidth} />
            );
          }
          if (shape.type === "ellipse") {
            const s = shape as BoxShape;
            return (
              <Ellipse
                key={s.id}
                x={s.x + s.width / 2}
                y={s.y + s.height / 2}
                radiusX={Math.abs(s.width) / 2}
                radiusY={Math.abs(s.height) / 2}
                stroke={s.color}
                strokeWidth={s.strokeWidth}
              />
            );
          }
          return null;
        })}
      </Layer>
    </Stage>
  );
}
```

```bash
npm install use-image
```

- [ ] **Step 4: Wire into `EditorApp.tsx`**

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import AnnotationCanvas from "./AnnotationCanvas";
import Toolbar from "./Toolbar";
import { initialState, setTool, type EditorState } from "./toolState";

export default function EditorApp() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>(initialState);
  const [color, setColor] = useState("#ff0000");
  const [strokeWidth, setStrokeWidth] = useState(3);

  useEffect(() => {
    const unlisten = listen<string>("editor-load-image", (event) => {
      setImageSrc(`data:image/png;base64,${event.payload}`);
      setState(initialState);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!imageSrc) {
    return <div style={{ padding: 16 }}>Waiting for capture…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar
        tool={state.tool}
        color={color}
        strokeWidth={strokeWidth}
        onToolChange={(t) => setState(setTool(state, t))}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidth}
      />
      <div id="editor-canvas-container" style={{ flex: 1, overflow: "auto" }}>
        <AnnotationCanvas
          imageSrc={imageSrc}
          state={state}
          color={color}
          strokeWidth={strokeWidth}
          onStateChange={setState}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Manually verify**

Run: `npm run tauri dev`, capture a screenshot, select Arrow/Rectangle/Ellipse from the toolbar, drag on the canvas to draw each. Confirm shapes render with the selected color/stroke width and persist while switching tools.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add annotation canvas with arrow/rect/ellipse tools"
```

---

### Task 13: Freehand pen + highlighter tool

**Files:**
- Modify: `src/windows/editor/AnnotationCanvas.tsx`
- Modify: `src/windows/editor/Toolbar.tsx`

**Interfaces:**
- Consumes: `PointShape` (Task 11), existing `AnnotationCanvas` drawing handlers (Task 12).
- Produces: no new exports — extends the existing `Shape` rendering switch and mouse handlers to cover `"pen"` and `"highlighter"`.

- [ ] **Step 1: Add pen/highlighter to the toolbar**

In `Toolbar.tsx`'s `TOOLS` array, add:
```ts
{ type: "pen", label: "Pen" },
{ type: "highlighter", label: "Highlighter" },
```

- [ ] **Step 2: Extend `handleMouseDown`/`handleMouseMove` in `AnnotationCanvas.tsx`**

Replace the `if (state.tool === "arrow")` branch with:
```tsx
if (state.tool === "arrow" || state.tool === "pen" || state.tool === "highlighter") {
  drawing.current = {
    id,
    type: state.tool,
    color,
    strokeWidth: state.tool === "highlighter" ? strokeWidth * 4 : strokeWidth,
    points: [pos.x, pos.y],
  } as PointShape;
}
```

Extend `handleMouseMove`'s point-shape branch so pen/highlighter append points instead of replacing the endpoint:
```tsx
if (drawing.current.type === "arrow") {
  const shape = drawing.current as PointShape;
  shape.points = [shape.points[0], shape.points[1], pos.x, pos.y];
} else if (drawing.current.type === "pen" || drawing.current.type === "highlighter") {
  const shape = drawing.current as PointShape;
  shape.points = [...shape.points, pos.x, pos.y];
} else {
  const shape = drawing.current as BoxShape;
  shape.width = pos.x - shape.x;
  shape.height = pos.y - shape.y;
}
```

- [ ] **Step 3: Render pen/highlighter as `Line`s**

In `AnnotationCanvas.tsx`, import `Line` from `react-konva` and add to the render switch:
```tsx
if (shape.type === "pen" || shape.type === "highlighter") {
  const s = shape as PointShape;
  return (
    <Line
      key={s.id}
      points={s.points}
      stroke={s.color}
      strokeWidth={s.strokeWidth}
      opacity={shape.type === "highlighter" ? 0.4 : 1}
      lineCap="round"
      lineJoin="round"
      tension={0}
    />
  );
}
```

- [ ] **Step 4: Manually verify**

Run: `npm run tauri dev`, capture a screenshot, select Pen and draw a freeform stroke, select Highlighter and draw a translucent wide stroke over some text-like area.
Expected: pen draws a thin solid line following the cursor path; highlighter draws a thicker, semi-transparent line.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add freehand pen and highlighter annotation tools"
```

---

### Task 14: Text label tool

**Files:**
- Modify: `src/windows/editor/AnnotationCanvas.tsx`
- Modify: `src/windows/editor/Toolbar.tsx`

**Interfaces:**
- Consumes: `TextShape` (Task 11).
- Produces: no new exports — extends `AnnotationCanvas` to place and edit `TextShape`s.

- [ ] **Step 1: Add the Text tool to the toolbar**

In `Toolbar.tsx`'s `TOOLS` array: `{ type: "text", label: "Text" }`.

- [ ] **Step 2: Handle text placement on click**

In `AnnotationCanvas.tsx`, add a branch in `handleMouseDown` (text is click-to-place, not drag, so it commits immediately rather than going through the `drawing` ref):
```tsx
if (state.tool === "text") {
  const id = newId();
  const shape: TextShape = { id, type: "text", color, strokeWidth, x: pos.x, y: pos.y, text: "Text", fontSize: 20 };
  onStateChange(addShape(state, shape));
  return;
}
```
Import `TextShape` from `./toolState`.

- [ ] **Step 3: Render text shapes as editable Konva `Text` nodes**

Import `Text` from `react-konva` and `updateShape` from `./toolState`. Add to the render switch:
```tsx
if (shape.type === "text") {
  const s = shape as TextShape;
  return (
    <Text
      key={s.id}
      x={s.x}
      y={s.y}
      text={s.text}
      fontSize={s.fontSize}
      fill={s.color}
      draggable
      onDragEnd={(e) => onStateChange(updateShape(state, s.id, { x: e.target.x(), y: e.target.y() }))}
      onDblClick={() => {
        const next = window.prompt("Edit text", s.text);
        if (next !== null) {
          onStateChange(updateShape(state, s.id, { text: next }));
        }
      }}
    />
  );
}
```

- [ ] **Step 4: Manually verify**

Run: `npm run tauri dev`, capture a screenshot, select Text, click on the canvas — a "Text" label appears. Double-click it, change the text in the prompt, confirm it updates. Drag it to a new position, confirm it stays.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add text label annotation tool"
```

---

### Task 15: Blur/pixelate region tool

**Files:**
- Modify: `src/windows/editor/AnnotationCanvas.tsx`

**Interfaces:**
- Consumes: `BoxShape` (Task 11), existing box-drag handlers (Task 12, shared with rect/ellipse).
- Produces: no new exports — renders `"blur"` shapes as a pixelated overlay using Konva's built-in `Pixelate` filter on a cropped clone of the base image.

- [ ] **Step 1: Add "blur" to the toolbar**

In `Toolbar.tsx`'s `TOOLS` array: `{ type: "blur", label: "Blur" }`.

- [ ] **Step 2: Reuse the existing box-drag path for the blur tool**

In `AnnotationCanvas.tsx`'s `handleMouseDown`, extend the box-shape condition:
```tsx
} else if (state.tool === "rect" || state.tool === "ellipse" || state.tool === "blur") {
```
(No other change needed here — `handleMouseMove`'s box-shape branch already handles any `BoxShape`, including `"blur"`.)

- [ ] **Step 3: Render blur regions as a pixelated crop of the base image**

Add a dedicated component in `AnnotationCanvas.tsx`:
```tsx
import { useRef as useRefKonva } from "react"; // already imported as useRef above; reuse it
import Konva from "konva";

function BlurRegion({ image, shape }: { image: HTMLImageElement; shape: BoxShape }) {
  const ref = useRef<Konva.Image>(null);

  useEffect(() => {
    ref.current?.cache();
    ref.current?.getLayer()?.batchDraw();
  }, [shape.x, shape.y, shape.width, shape.height]);

  return (
    <KonvaImage
      ref={ref}
      image={image}
      x={Math.min(shape.x, shape.x + shape.width)}
      y={Math.min(shape.y, shape.y + shape.height)}
      width={Math.abs(shape.width)}
      height={Math.abs(shape.height)}
      crop={{
        x: Math.min(shape.x, shape.x + shape.width),
        y: Math.min(shape.y, shape.y + shape.height),
        width: Math.abs(shape.width),
        height: Math.abs(shape.height),
      }}
      filters={[Konva.Filters.Pixelate]}
      pixelSize={12}
    />
  );
}
```
Add `import { useEffect } from "react";` to the existing React import line.

Add to the render switch in the main component:
```tsx
if (shape.type === "blur" && image) {
  return <BlurRegion key={shape.id} image={image} shape={shape as BoxShape} />;
}
```
Note: this must render *after* the base `KonvaImage` in the `Layer` so the pixelated patch draws on top — the existing `state.shapes.map(...)` already renders after the base image, so no reordering is needed.

- [ ] **Step 4: Manually verify**

Run: `npm run tauri dev`, capture a screenshot containing some text, select Blur, drag a box over that text.
Expected: the region under the box shows a pixelated version of the underlying image content, not a plain color block — moving/resizing isn't required for v1 (draw-once is enough, matching the other box tools).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add blur/pixelate region annotation tool"
```

---

### Task 16: Crop/resize canvas tool

**Files:**
- Modify: `src/windows/editor/AnnotationCanvas.tsx`
- Modify: `src/windows/editor/EditorApp.tsx`
- Modify: `src/windows/editor/toolState.ts`

**Interfaces:**
- Consumes: `BoxShape`, `EditorState` (Task 11).
- Produces: `export function applyCrop(state: EditorState, crop: { x: number; y: number; width: number; height: number }): EditorState` in `toolState.ts` — clears the crop-tool shape and shifts every remaining shape's coordinates so they stay visually anchored to the cropped image. Consumed by `EditorApp` and by Task 17 (export) indirectly via the final `imageSrc`/canvas dimensions.

- [ ] **Step 1: Write the failing test for `applyCrop`**

Append to `src/windows/editor/toolState.test.ts`:
```ts
import { applyCrop } from "./toolState";

describe("applyCrop", () => {
  it("removes crop-type shapes and shifts remaining shapes by the crop origin", () => {
    const cropShape: BoxShape = { id: "c", type: "crop", color: "#000", strokeWidth: 1, x: 10, y: 10, width: 50, height: 50 };
    const rect: BoxShape = { id: "r", type: "rect", color: "#f00", strokeWidth: 2, x: 20, y: 20, width: 5, height: 5 };
    const state = addShape(addShape(initialState, cropShape), rect);
    const next = applyCrop(state, { x: 10, y: 10, width: 50, height: 50 });
    expect(next.shapes).toHaveLength(1);
    const shifted = next.shapes[0] as BoxShape;
    expect(shifted.x).toBe(10);
    expect(shifted.y).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- toolState`
Expected: FAIL — `applyCrop` is not exported.

- [ ] **Step 3: Implement `applyCrop` in `toolState.ts`**

```ts
export function applyCrop(
  state: EditorState,
  crop: { x: number; y: number; width: number; height: number },
): EditorState {
  const shapes = state.shapes
    .filter((s) => s.type !== "crop")
    .map((s) => {
      if ("x" in s && "y" in s) {
        return { ...s, x: s.x - crop.x, y: s.y - crop.y };
      }
      if ("points" in s) {
        const points = s.points.map((p, i) => (i % 2 === 0 ? p - crop.x : p - crop.y));
        return { ...s, points };
      }
      return s;
    });
  return { ...state, shapes, selectedId: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- toolState`
Expected: PASS, 8 tests total.

- [ ] **Step 5: Add the Crop tool to the toolbar and wire the crop-commit action**

In `Toolbar.tsx`'s `TOOLS` array: `{ type: "crop", label: "Crop" }`.

In `AnnotationCanvas.tsx`, reuse the box-drag path exactly like blur (Task 15):
```tsx
} else if (state.tool === "rect" || state.tool === "ellipse" || state.tool === "blur" || state.tool === "crop") {
```
Render the in-progress crop shape as a dashed selection rect (add to the render switch, before the generic `"rect"` case so it doesn't fall through to the solid-stroke renderer):
```tsx
if (shape.type === "crop") {
  const s = shape as BoxShape;
  return <Rect key={s.id} x={s.x} y={s.y} width={s.width} height={s.height} stroke="#fff" dash={[6, 4]} strokeWidth={1} />;
}
```

In `EditorApp.tsx`, add an "Apply Crop" button shown only when a crop shape exists, and a handler that calls `applyCrop` and also crops the underlying `imageSrc` via an offscreen canvas:
```tsx
import { applyCrop } from "./toolState";

// inside EditorApp component, alongside other handlers:
function handleApplyCrop() {
  const cropShape = state.shapes.find((s) => s.type === "crop");
  if (!cropShape || !("width" in cropShape)) return;
  const { x, y, width, height } = cropShape;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.abs(width);
    canvas.height = Math.abs(height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, -Math.min(x, x + width), -Math.min(y, y + height));
    setImageSrc(canvas.toDataURL("image/png"));
    setState(applyCrop(state, { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) }));
  };
  img.src = imageSrc!;
}
```
Add a button near the toolbar: `{state.shapes.some((s) => s.type === "crop") && <button onClick={handleApplyCrop}>Apply Crop</button>}`.

- [ ] **Step 6: Manually verify**

Run: `npm run tauri dev`, capture a screenshot, draw an arrow, select Crop, drag a smaller box, click "Apply Crop".
Expected: the image is replaced by the cropped region, and the previously drawn arrow shifts to remain visually anchored to the same spot on the now-smaller image (or disappears if it was outside the crop box — acceptable for v1, no clipping-vs-hiding distinction required).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add crop/resize canvas tool"
```

---

### Task 17: Export/flatten canvas to PNG bytes

**Files:**
- Create: `src/windows/editor/export.ts`
- Create: `src/windows/editor/export.test.ts`
- Modify: `src/windows/editor/EditorApp.tsx`

**Interfaces:**
- Produces: `export function dataUrlToBytes(dataUrl: string): Uint8Array` (pure, unit tested) and `export function exportStageToBytes(stage: Konva.Stage): Uint8Array` (thin wrapper calling `stage.toDataURL()` then `dataUrlToBytes`, not unit tested directly since it needs a real Konva stage — covered by manual verification).
- Consumed by: Task 19 (Save & Upload wiring passes the returned `Uint8Array` to the `upload_file` command).

- [ ] **Step 1: Write the failing test for the pure conversion function**

`src/windows/editor/export.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dataUrlToBytes } from "./export";

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL into raw bytes", () => {
    // "hi" base64-encoded is "aGk="
    const bytes = dataUrlToBytes("data:image/png;base64,aGk=");
    expect(Array.from(bytes)).toEqual([104, 105]);
  });

  it("throws on a non-base64 data URL", () => {
    expect(() => dataUrlToBytes("data:image/png,not-base64")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- export`
Expected: FAIL — `export.ts` does not exist.

- [ ] **Step 3: Implement `export.ts`**

```ts
import type Konva from "konva";

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const marker = ";base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error("expected a base64-encoded data URL");
  }
  const base64 = dataUrl.slice(idx + marker.length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function exportStageToBytes(stage: Konva.Stage): Uint8Array {
  const dataUrl = stage.toDataURL({ mimeType: "image/png" });
  return dataUrlToBytes(dataUrl);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- export`
Expected: PASS, 2 tests.

- [ ] **Step 5: Expose the Konva stage ref from `AnnotationCanvas` for `EditorApp` to call `exportStageToBytes` on**

Modify `AnnotationCanvas.tsx` to accept a forwarded ref:
```tsx
import { forwardRef } from "react";
import type Konva from "konva";

const AnnotationCanvas = forwardRef<Konva.Stage, Props>(function AnnotationCanvas(
  { imageSrc, state, color, strokeWidth, onStateChange },
  ref,
) {
  // ...existing body...
  return (
    <Stage
      ref={ref}
      width={image?.width ?? 800}
      // ...rest unchanged...
```
Add `export default AnnotationCanvas;` (replacing the previous default export line) and close the `forwardRef` call's outer parens appropriately.

Modify `EditorApp.tsx` to hold a ref and pass it through:
```tsx
import { useRef } from "react";
import type Konva from "konva";

const stageRef = useRef<Konva.Stage>(null);

// ...
<AnnotationCanvas ref={stageRef} imageSrc={imageSrc} state={state} color={color} strokeWidth={strokeWidth} onStateChange={setState} />
```

- [ ] **Step 6: Manually verify**

This task has no standalone visible behavior yet (the export button is wired in Task 19) — verify by running the test suite and confirming the app still builds:
Run: `npm run build`
Expected: no TypeScript errors from the ref-forwarding change.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add canvas-to-PNG-bytes export helper"
```

---

### Task 18: Upload module (S3-compatible client)

**Files:**
- Create: `src-tauri/src/upload.rs`
- Modify: `src-tauri/src/main.rs` (add `mod upload;`)
- Modify: `src-tauri/Cargo.toml` (add `aws-sdk-s3`, `aws-config`, `tokio`)

**Interfaces:**
- Consumes: `settings::{UploadSettings, Credentials, Provider}` (Task 5), `object_key::build_object_key` (Task 4).
- Produces:
  - `pub fn build_public_url(settings: &UploadSettings, key: &str) -> String` (pure, unit tested)
  - `pub async fn upload_object(settings: &UploadSettings, creds: &Credentials, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String>`
- Consumed by: Task 19 (`upload_file` command composes `build_object_key` + `upload_object` + `build_public_url`).

- [ ] **Step 1: Add dependencies**

`src-tauri/Cargo.toml`:
```toml
aws-sdk-s3 = "1"
aws-config = "1"
tokio = { version = "1", features = ["rt-multi-thread"] }
```

- [ ] **Step 2: Write the failing tests for `build_public_url`**

`src-tauri/src/upload.rs`:
```rust
use crate::settings::{Credentials, Provider, UploadSettings};
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region};
use aws_sdk_s3::Client;

pub fn build_public_url(settings: &UploadSettings, key: &str) -> String {
    todo!()
}

pub async fn upload_object(
    settings: &UploadSettings,
    creds: &Credentials,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let aws_creds = AwsCredentials::new(&creds.access_key_id, &creds.secret_access_key, None, None, "pxl");
    let mut config_builder = aws_sdk_s3::config::Builder::new()
        .region(Region::new(settings.region.clone()))
        .credentials_provider(aws_creds)
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest());

    if let Provider::Spaces = settings.provider {
        let endpoint = settings.endpoint.clone().unwrap_or_default();
        config_builder = config_builder
            .endpoint_url(format!("https://{endpoint}"))
            .force_path_style(false);
    }

    let client = Client::from_conf(config_builder.build());

    client
        .put_object()
        .bucket(&settings.bucket)
        .key(key)
        .body(bytes.into())
        .content_type(content_type)
        .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s3_settings() -> UploadSettings {
        UploadSettings {
            provider: Provider::S3,
            bucket: "my-bucket".into(),
            region: "us-east-1".into(),
            endpoint: None,
            custom_domain: None,
            key_prefix: None,
            filename_prefix: None,
        }
    }

    fn spaces_settings() -> UploadSettings {
        UploadSettings {
            provider: Provider::Spaces,
            bucket: "my-space".into(),
            region: "nyc3".into(),
            endpoint: Some("nyc3.digitaloceanspaces.com".into()),
            custom_domain: None,
            key_prefix: None,
            filename_prefix: None,
        }
    }

    #[test]
    fn s3_url_uses_virtual_hosted_style() {
        let url = build_public_url(&s3_settings(), "abc123.png");
        assert_eq!(url, "https://my-bucket.s3.us-east-1.amazonaws.com/abc123.png");
    }

    #[test]
    fn spaces_url_uses_bucket_dot_endpoint() {
        let url = build_public_url(&spaces_settings(), "abc123.png");
        assert_eq!(url, "https://my-space.nyc3.digitaloceanspaces.com/abc123.png");
    }

    #[test]
    fn custom_domain_overrides_generated_host() {
        let mut settings = s3_settings();
        settings.custom_domain = Some("cdn.example.com".into());
        let url = build_public_url(&settings, "abc123.png");
        assert_eq!(url, "https://cdn.example.com/abc123.png");
    }

    #[test]
    fn key_with_folder_prefix_is_url_encoded_in_path() {
        let url = build_public_url(&s3_settings(), "team-chris/abc123.png");
        assert_eq!(
            url,
            "https://my-bucket.s3.us-east-1.amazonaws.com/team-chris/abc123.png"
        );
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test upload::`
Expected: FAIL — `build_public_url` panics with `not yet implemented`.

- [ ] **Step 4: Implement `build_public_url`**

Replace the `todo!()`:
```rust
pub fn build_public_url(settings: &UploadSettings, key: &str) -> String {
    if let Some(domain) = &settings.custom_domain {
        let domain = domain.trim_end_matches('/');
        return format!("https://{domain}/{key}");
    }
    match settings.provider {
        Provider::S3 => format!(
            "https://{}.s3.{}.amazonaws.com/{}",
            settings.bucket, settings.region, key
        ),
        Provider::Spaces => {
            let endpoint = settings.endpoint.clone().unwrap_or_default();
            format!("https://{}.{}/{}", settings.bucket, endpoint, key)
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test upload::`
Expected: PASS, 4 tests. (`upload_object` is exercised only by manual verification in Task 19 — it needs real or emulated S3 credentials to run meaningfully.)

- [ ] **Step 6: Register the module and commit**

Add `mod upload;` to `src-tauri/src/main.rs`.

```bash
git add -A
git commit -m "feat: add S3-compatible upload client and public URL construction"
```

---

### Task 19: Save & Upload end-to-end wiring

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `upload_file`)
- Modify: `src-tauri/src/main.rs` (register `upload_file`, add `tauri-plugin-notification`, `tauri-plugin-clipboard-manager`)
- Modify: `src-tauri/Cargo.toml` (add the two plugins)
- Modify: `src/windows/editor/EditorApp.tsx` (add "Save & Upload" button and flow)
- Modify: `src/lib/api.ts` (add `uploadFile`)

**Interfaces:**
- Consumes: `filename::generate_filename` (Task 3), `object_key::build_object_key` (Task 4), `settings::{load_settings, KeyringCredentialStore, CredentialStore}` (Task 5), `upload::{upload_object, build_public_url}` (Task 18), `export::exportStageToBytes` (Task 17).
- Produces: Tauri command `upload_file(app: AppHandle, bytes: Vec<u8>, extension: String) -> Result<String, String>` returning the final public URL. Frontend `uploadFile(bytes: Uint8Array, extension: string): Promise<string>` in `api.ts`.

- [ ] **Step 1: Add plugin dependencies**

`src-tauri/Cargo.toml`:
```toml
tauri-plugin-notification = "2"
tauri-plugin-clipboard-manager = "2"
```

```bash
npm install @tauri-apps/plugin-notification @tauri-apps/plugin-clipboard-manager
```

- [ ] **Step 2: Add the `upload_file` command**

Append to `src-tauri/src/commands.rs`:
```rust
use crate::filename;
use crate::object_key::build_object_key;
use crate::settings::{load_settings, CredentialStore, KeyringCredentialStore};
use crate::upload::{build_public_url, upload_object};

#[tauri::command]
pub async fn upload_file(app: AppHandle, bytes: Vec<u8>, extension: String) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let settings = load_settings(&config_dir);
    let creds = KeyringCredentialStore
        .get()
        .ok_or("no upload credentials configured — open Settings and add them")?;

    let name = filename::generate_filename(settings.filename_prefix.as_deref(), &extension);
    let key = build_object_key(settings.key_prefix.as_deref(), &name);
    let content_type = if extension == "png" { "image/png" } else { "application/octet-stream" };

    upload_object(&settings, &creds, &key, bytes, content_type).await?;

    Ok(build_public_url(&settings, &key))
}
```

Register in `main.rs`'s `generate_handler!` and add both plugins to the builder:
```rust
.plugin(tauri_plugin_notification::init())
.plugin(tauri_plugin_clipboard_manager::init())
```

- [ ] **Step 3: Add the frontend wrapper**

Append to `src/lib/api.ts`:
```ts
export function uploadFile(bytes: Uint8Array, extension: string): Promise<string> {
  return invoke("upload_file", { bytes: Array.from(bytes), extension });
}
```

- [ ] **Step 4: Wire "Save & Upload" in `EditorApp.tsx`**

```tsx
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exportStageToBytes } from "./export";
import { uploadFile } from "../../lib/api";

// inside EditorApp component
const [uploading, setUploading] = useState(false);
const [error, setError] = useState<string | null>(null);

async function handleSaveAndUpload() {
  if (!stageRef.current) return;
  setUploading(true);
  setError(null);
  try {
    const bytes = exportStageToBytes(stageRef.current);
    const url = await uploadFile(bytes, "png");
    await writeText(url);
    await sendNotification({ title: "pxl", body: `Uploaded — link copied to clipboard\n${url}` });
    await getCurrentWindow().hide();
  } catch (e) {
    setError(String(e));
  } finally {
    setUploading(false);
  }
}
```

Add the button and error banner to the JSX, next to the Toolbar:
```tsx
<button onClick={handleSaveAndUpload} disabled={uploading}>
  {uploading ? "Uploading…" : "Save & Upload"}
</button>
{error && (
  <div style={{ color: "red", padding: 8 }}>
    {error} <button onClick={handleSaveAndUpload}>Retry</button>
  </div>
)}
```

- [ ] **Step 5: Manually verify end-to-end**

Prerequisite: in Settings, configure a real (or a test) S3 bucket/Spaces space with credentials that allow `PutObject` and public-read ACLs.

Run: `npm run tauri dev`. Capture an area screenshot, draw an arrow annotation, click "Save & Upload".
Expected: the editor window hides, a system notification shows the uploaded URL, and pasting the clipboard (e.g. into a text editor) shows a working public URL that opens the annotated PNG in a browser.

Then test the failure path: temporarily set an invalid bucket name in Settings, repeat the capture, click "Save & Upload".
Expected: the editor window stays open, shows a red error banner with a "Retry" button, and the temp bytes are not lost (Retry re-attempts the same export/upload).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire Save & Upload flow with clipboard copy and notification"
```

---

### Task 20: Capture permission-denied handling

**Files:**
- Modify: `src-tauri/src/capture.rs` (surface a distinguishable error)
- Modify: `src-tauri/src/main.rs` (catch that error in the capture-trigger listeners and show a notification)

**Interfaces:**
- Consumes: `capture::{capture_full_screen_png, capture_area_png}` (Task 9), `tauri_plugin_notification` (Task 19).
- Produces: no new public API — makes the existing error path user-visible instead of silently failing (Task 9's listeners currently discard errors via `if let Ok(...)`).

- [ ] **Step 1: Have `primary_monitor`/capture functions return a distinguishable error string**

Modify `src-tauri/src/capture.rs`'s `primary_monitor` and the two public capture functions to propagate `xcap`'s error text as-is (already the case via `.map_err(|e| e.to_string())`) — no code change needed here; the existing error string from `xcap::Monitor::all()` is what surfaces when the OS denies screen-recording permission. Confirm this by reading `xcap`'s error message format for your platform in Step 3's manual test.

- [ ] **Step 2: Show a notification on capture failure instead of silently discarding the error**

Modify `src-tauri/src/main.rs`'s `setup` listeners:
```rust
let handle = app.handle().clone();
app.listen("trigger-capture-full", move |_event| {
    match capture::capture_full_screen_png() {
        Ok(bytes) => open_editor_with_png(&handle, bytes),
        Err(e) => {
            let _ = handle.notification().builder().title("pxl").body(format!("Capture failed: {e}")).show();
        }
    }
});
```
Apply the same `match` pattern to the `overlay-selection` listener's `capture::capture_area_png(rect)` call, and to `tray.rs`'s `"capture_full"` menu handler (Task 9, Step 5) — replace each `if let Ok(bytes) = ...` with the same `match` + notification-on-error shape.

Add `use tauri_plugin_notification::NotificationExt;` to the top of `main.rs` and `tray.rs` wherever the `.notification()` call is used.

- [ ] **Step 3: Manually verify**

On macOS: revoke pxl's Screen Recording permission in System Settings > Privacy & Security (or run before granting it the first time). Trigger a capture.
Expected: a system notification reading "Capture failed: ..." appears instead of the app silently doing nothing; the notification body includes enough of the OS error to know it's a permissions issue.

On Windows: this permission model doesn't exist the same way — verify at minimum that a deliberately broken capture path (e.g. temporarily forcing `primary_monitor()` to return `Err("test".into())`) surfaces the same notification, then revert the temporary change.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: surface capture failures as system notifications instead of failing silently"
```

---

## Self-Review Notes

- **Spec coverage:** tray menu ✅ (Task 2), configurable hotkeys ✅ (Task 7), area + full-screen capture ✅ (Tasks 8-9), all 8 annotation tools ✅ (Tasks 12-16), Save & Upload → clipboard → notification ✅ (Task 19), S3/Spaces with custom domain + key/filename prefixes ✅ (Tasks 5, 18, 19), keychain credential storage ✅ (Task 5), public-read ACL ✅ (Task 18), temp-only local storage (no persistent copy) ✅ (Task 19 deletes nothing extra to keep since nothing is ever written outside temp — bytes live in memory/base64 transit, never touch disk outside the OS's own temp handling inside `xcap`), error handling for upload failure + retry ✅ (Task 19) and capture permission denied ✅ (Task 20).
- **Deferred to the video plan:** reopen-last-capture, video recording/trim, mic toggle — per the agreed plan split.
- **Type consistency check:** `CaptureRect` (Rust, Task 9) fields `x/y/width/height` match the overlay's emitted payload (Task 8) field-for-field once serialized with `#[serde(rename_all = "camelCase")]`; `UploadSettings`/`HotkeySettings` field names match between Rust (`snake_case` + camelCase serde rename) and the TS `api.ts` interfaces (`camelCase`) throughout Tasks 5-7; `Shape`/`BoxShape`/`PointShape`/`TextShape` names are used consistently from Task 11 through Task 17's crop/export logic.

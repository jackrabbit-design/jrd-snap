# pxl Video Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screen video recording (area or full screen, optional microphone audio) to pxl, with a trim UI in the editor and reuse of the existing upload pipeline, plus a "Reopen Last Capture" feature covering both screenshots and recordings.

**Architecture:** Rust gains a `recording` module using the `ffmpeg-sidecar` crate (auto-downloads a static ffmpeg binary on first use). ffmpeg performs both screen capture and encoding directly via its native screen-grab input devices (`avfoundation` on macOS, `gdigrab` on Windows) — no separate frame-capture crate. The existing overlay window gains a second "confirm" phase (mic toggle + Start button) reused for both area and full-screen recording. The existing editor window gains a video/trim mode alongside its image/annotation mode. The existing upload pipeline (filename, object key, S3/Spaces client, clipboard, notification) is reused unchanged, parameterized by extension/content-type.

**Tech Stack:** `ffmpeg-sidecar` (bundled ffmpeg capture/encode/trim), existing Tauri v2 + Rust backend, existing React + TypeScript frontend (no new frontend dependencies — trim UI uses a native `<video>` element).

## Global Constraints

- Output format: MP4 container, H.264 video, AAC audio track only if mic was enabled. Source: design spec "Architecture".
- Trim re-encodes exactly the selected in/out range (frame-accurate), never stream-copy/keyframe-snapped. Source: spec "Editor video mode (trim)".
- No system/loopback audio, no webcam overlay, no video annotation — trim only. Source: spec "Out of scope".
- Recording confirmation panel (mic toggle + Start) appears for BOTH area and full-screen recording, before anything actually records. Source: spec "Recording flow" step 3.
- Reopen Last Capture keeps state in memory only for the current app session (never persisted to disk), covers whichever capture type (image or video) was most recent, and re-saving always produces a new filename/URL. Source: spec "Reopen Last Capture".
- Quitting the app or starting a new capture while a recording is in progress must stop and discard it cleanly — no orphaned ffmpeg processes. Source: spec "Error handling".
- **Known risk, verify empirically:** exact ffmpeg CLI arguments for screen capture are platform- and machine-specific (macOS `avfoundation` device indices are NOT fixed and must be discovered at runtime, not hardcoded — see Task 2). Treat the code in this plan as a well-researched starting point, not gospel; adapt based on what `ffmpeg -f avfoundation -list_devices true -i ""` and live recording attempts actually show, the same way prior tasks adapted `xcap`/`aws-sdk-s3` versions to what actually compiled and worked.

---

## File Structure

```
pxl/
  src-tauri/
    Cargo.toml                    # + ffmpeg-sidecar
    src/
      recording.rs                 # ffmpeg-sidecar setup, capture arg construction (pure, tested), start/stop process management, AppState for the active recording
      trim.rs                       # trim range validation (pure, tested) + trim re-encode arg construction (pure, tested) + execute
      commands.rs                    # + start_recording, stop_recording, trim_video, reopen_last_capture, get_last_capture, upload_file content-type extended for video
      lib.rs                          # + AppState (recording handle, last-capture slot), tray Record Area/Record Screen/Stop Recording items, quit-time cleanup
      settings.rs                      # + HotkeySettings.record_area/record_full fields + tests
      tray.rs                           # + Record Area/Record Screen/Stop Recording menu wiring, swaps based on recording state
  src/
    windows/
      overlay/
        OverlayApp.tsx                  # + "confirm" phase (mic toggle + Start/Cancel) reused for area (after drag) and full-screen (immediately) recording
      editor/
        EditorApp.tsx                    # + capture-type dispatch (image vs video mode)
        VideoTrimmer.tsx                  # new: <video> preview + scrubber + in/out handles, wired to trimState
        trimState.ts                       # new: pure trim range state (mirrors toolState.ts's pattern), unit tested
      settings/
        HotkeyConfigForm.tsx                # + Record Area/Record Screen hotkey fields
    lib/
      api.ts                                 # + startRecording, stopRecording, trimVideo, reopenLastCapture, getLastCapture wrappers
```

---

### Task 1: ffmpeg-sidecar integration and startup wiring

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `ffmpeg-sidecar`)
- Create: `src-tauri/src/recording.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod recording;`, call ffmpeg readiness check in `.setup()`)

**Interfaces:**
- Produces: `pub fn ensure_ffmpeg() -> Result<(), String>` — checks for a local ffmpeg binary and downloads one via `ffmpeg_sidecar::download::auto_download()` if missing. Called once at startup; later tasks call ffmpeg via `ffmpeg_sidecar::command::FfmpegCommand`, which assumes this has already run.
- Consumes: nothing (first recording task).

- [ ] **Step 1: Add the dependency**

`src-tauri/Cargo.toml`:
```toml
ffmpeg-sidecar = "1"
```

- [ ] **Step 2: Write `recording.rs`'s ffmpeg-readiness function**

```rust
use ffmpeg_sidecar::download::auto_download;

pub fn ensure_ffmpeg() -> Result<(), String> {
    auto_download().map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Call it once at startup, notifying on failure instead of silently continuing**

In `src-tauri/src/lib.rs`'s `.setup()`, after `tray::build_tray(app.handle())?;`:
```rust
let handle_ffmpeg = app.handle().clone();
std::thread::spawn(move || {
    if let Err(e) = recording::ensure_ffmpeg() {
        eprintln!("ffmpeg setup failed: {e}");
        notify_capture_failed(&handle_ffmpeg, &format!("ffmpeg setup failed — recording will not work: {e}"));
    }
});
```
(Spawned on a background thread since `auto_download()` blocks on a network download the first time an install is needed — this must not block app startup/the tray from appearing.)

Add `mod recording;` near the other `mod` declarations in `lib.rs`.

- [ ] **Step 4: Manually verify**

Run: `npm run tauri dev` with any prior ffmpeg install removed/renamed if present (or on a fresh machine/user profile). Confirm the app still starts immediately (tray appears without waiting on the download), and after a few seconds a local ffmpeg binary exists (check `ffmpeg_sidecar`'s default install location, typically the app's data directory — print/log the path `ensure_ffmpeg` resolves to, to make this checkable). This cannot be verified by automated tests since it needs real network access; state clearly in your report whether you were able to observe a successful download in this environment.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add ffmpeg-sidecar dependency and startup readiness check"
```

---

### Task 2: Recording capture argument construction (pure, tested)

**Files:**
- Modify: `src-tauri/src/recording.rs`

**Interfaces:**
- Produces:
  - `pub struct CaptureRegion { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }` (mirrors `capture::CaptureRect`'s shape but kept separate since this module doesn't depend on `capture.rs`)
  - `pub fn build_capture_args(region: Option<CaptureRegion>, mic_enabled: bool, output_path: &std::path::Path) -> Vec<String>` — pure, unit tested for structural correctness (right flags present/absent for region vs full-screen, mic on vs off), platform-conditional via `cfg(target_os)`.
- Consumed by: Task 3 (`start_recording` passes these args to `FfmpegCommand`).

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/recording.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn full_screen_no_mic_has_no_crop_filter_or_audio_input() {
        let args = build_capture_args(None, false, Path::new("/tmp/out.mp4"));
        let joined = args.join(" ");
        assert!(!joined.contains("crop="));
        assert!(!joined.contains("-c:a"));
        assert!(joined.contains("/tmp/out.mp4"));
    }

    #[test]
    fn area_region_adds_a_crop_filter_with_the_right_dimensions() {
        let region = CaptureRegion { x: 10, y: 20, width: 300, height: 200 };
        let args = build_capture_args(Some(region), false, Path::new("/tmp/out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("crop=300:200:10:20"));
    }

    #[test]
    fn mic_enabled_adds_an_audio_encoder() {
        let args = build_capture_args(None, true, Path::new("/tmp/out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-c:a"));
        assert!(joined.contains("aac"));
    }

    #[test]
    fn output_path_is_always_the_last_argument() {
        let args = build_capture_args(None, false, Path::new("/tmp/out.mp4"));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test recording::`
Expected: FAIL — `build_capture_args`/`CaptureRegion` don't exist yet.

- [ ] **Step 3: Implement**

Add above the test module in `recording.rs`:
```rust
// Serialize/Deserialize are required, not just convenient: Task 3 passes
// this as a Tauri command parameter (deserialized from the frontend's IPC
// call), and Task 6 nests it inside another #[derive(Deserialize)] struct —
// both need this type to implement Deserialize itself.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct CaptureRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn build_capture_args(
    region: Option<CaptureRegion>,
    mic_enabled: bool,
    output_path: &std::path::Path,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // NOTE: the video device index for screen capture is NOT fixed —
        // it depends on how many cameras/displays the machine has. "1" is a
        // common default (index 0 is often a webcam) but Task 3's caller
        // MUST verify this against `ffmpeg -f avfoundation -list_devices
        // true -i ""` on the actual machine and discover the real index
        // rather than trusting this hardcoded guess in production.
        let audio_device = if mic_enabled { "0" } else { "none" };
        args.push("-f".into());
        args.push("avfoundation".into());
        args.push("-framerate".into());
        args.push("30".into());
        args.push("-i".into());
        args.push(format!("1:{audio_device}"));
    }

    #[cfg(target_os = "windows")]
    {
        args.push("-f".into());
        args.push("gdigrab".into());
        args.push("-framerate".into());
        args.push("30".into());
        args.push("-i".into());
        args.push("desktop".into());
        if mic_enabled {
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            // NOTE: "audio=Microphone" is a placeholder device name — dshow
            // requires the exact device name as reported by
            // `ffmpeg -list_devices true -f dshow -i dummy`, which varies
            // by machine. Task 3's caller must discover and substitute the
            // real default microphone's name.
            args.push("audio=Microphone".into());
        }
    }

    if let Some(r) = region {
        args.push("-vf".into());
        args.push(format!("crop={}:{}:{}:{}", r.width, r.height, r.x, r.y));
    }

    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-c:v".into());
    args.push("libx264".into());

    if mic_enabled {
        args.push("-c:a".into());
        args.push("aac".into());
    }

    args.push(output_path.to_string_lossy().to_string());
    args
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test recording::`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add ffmpeg capture argument construction for recording"
```

---

### Task 3: Recording process management (start/stop, AppState)

**Files:**
- Modify: `src-tauri/src/recording.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `recording::{CaptureRegion, build_capture_args}` (Task 2).
- Produces:
  - `pub struct RecordingState(pub std::sync::Mutex<Option<(ffmpeg_sidecar::child::FfmpegChild, std::path::PathBuf)>>)` — a Tauri-managed state type holding the active recording process AND the output path it's writing to, if any. The path travels alongside the child from the start (not bolted on later) so every consumer (stop, quit-cleanup, discard-on-new-capture, open-in-editor) reads it from the same place.
  - `pub fn start_recording(region: Option<CaptureRegion>, mic_enabled: bool, output_path: &std::path::Path) -> Result<ffmpeg_sidecar::child::FfmpegChild, String>` — builds args via Task 2, spawns via `FfmpegCommand`.
  - `pub fn stop_recording(child: ffmpeg_sidecar::child::FfmpegChild) -> Result<(), String>` — sends ffmpeg's graceful quit signal (writing `q` to its stdin, ffmpeg's documented way to stop cleanly and finalize the MP4 container) rather than killing the process outright, which would leave a corrupt/unplayable file.
  - Tauri commands `start_recording_command`/`stop_recording_command` in `commands.rs` wiring the above to a temp file path and the managed `RecordingState`.
- Consumed by: Task 5 (confirmation panel's Start button), Task 6 (Stop Recording menu item), Task 8 (reads the path when opening the editor), Task 11 (quit/discard cleanup).

- [ ] **Step 1: Implement start/stop in `recording.rs`**

```rust
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::child::FfmpegChild;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct RecordingState(pub Mutex<Option<(FfmpegChild, PathBuf)>>);

impl Default for RecordingState {
    fn default() -> Self {
        RecordingState(Mutex::new(None))
    }
}

pub fn start_recording(
    region: Option<CaptureRegion>,
    mic_enabled: bool,
    output_path: &std::path::Path,
) -> Result<FfmpegChild, String> {
    let args = build_capture_args(region, mic_enabled, output_path);
    FfmpegCommand::new()
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())
}

pub fn stop_recording(mut child: FfmpegChild) -> Result<(), String> {
    // Writing "q" to ffmpeg's stdin is its documented graceful-quit signal:
    // it finalizes the output container (writes a valid MP4 moov atom)
    // instead of leaving a truncated/unplayable file, which a hard kill
    // would risk.
    if let Some(stdin) = child.as_inner_mut().stdin.as_mut() {
        let _ = stdin.write_all(b"q");
    }
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}
```

Note: `FfmpegChild`'s exact API (`as_inner_mut()`, `.stdin`, `.wait()`) is per the `ffmpeg-sidecar` crate's documented interface as of writing — verify against the actual installed version's docs/source (`cargo doc -p ffmpeg-sidecar --open` or the crate's docs.rs page) and adapt if the method names differ, same as prior crate-version adaptations in this project.

- [ ] **Step 2: Add Tauri commands**

Append to `src-tauri/src/commands.rs`:
```rust
use crate::recording::{self, CaptureRegion, RecordingState};
use tauri::State;

#[tauri::command]
pub fn start_recording_command(
    state: State<RecordingState>,
    region: Option<CaptureRegion>,
    mic_enabled: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("a recording is already in progress".to_string());
    }
    let output_path = std::env::temp_dir().join(format!("pxl-recording-{}.mp4", std::process::id()));
    let child = recording::start_recording(region, mic_enabled, &output_path)?;
    *guard = Some((child, output_path.clone()));
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn stop_recording_command(state: State<RecordingState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let (child, _path) = guard.take().ok_or("no recording in progress")?;
    recording::stop_recording(child)
}
```

- [ ] **Step 3: Register the managed state and commands in `lib.rs`**

```rust
.manage(recording::RecordingState::default())
```
Add this to the `tauri::Builder::default()` chain (order relative to other builder calls doesn't matter). Register `commands::start_recording_command` and `commands::stop_recording_command` in `generate_handler!`.

- [ ] **Step 4: Manually verify**

This task's process management can't be meaningfully unit-tested (it launches a real ffmpeg process). Manual verification: temporarily wire a debug trigger (or wait for Task 6's real tray item) to call `start_recording_command` with `region: None, mic_enabled: false`, wait a few seconds, call `stop_recording_command`, and confirm a valid, playable MP4 exists at the returned path. Document in your report whether you were able to do this in this environment (needs a real display).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add recording process start/stop with graceful ffmpeg shutdown"
```

---

### Task 4: Hotkey settings extension for Record Area / Record Screen

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/windows/settings/HotkeyConfigForm.tsx`

**Interfaces:**
- Consumes: existing `HotkeySettings` struct and `load_hotkeys`/`save_hotkeys` pattern (screenshot pipeline plan, Task 7).
- Produces: `HotkeySettings` gains `record_area: String` and `record_full: String` fields (defaults: `"CommandOrControl+Shift+4"`, `"CommandOrControl+Shift+5"` — one past the existing capture hotkeys' `2`/`3`). Frontend `HotkeySettings` TS type gains matching `recordArea`/`recordFull` fields.

- [ ] **Step 1: Extend the Rust struct and default, with tests**

In `src-tauri/src/settings.rs`, find the existing `HotkeySettings` struct and its `Default` impl (from the screenshot pipeline plan) and add the two new fields:
```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettings {
    pub capture_area: String,
    pub capture_full: String,
    pub record_area: String,
    pub record_full: String,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        HotkeySettings {
            capture_area: "CommandOrControl+Shift+2".into(),
            capture_full: "CommandOrControl+Shift+3".into(),
            record_area: "CommandOrControl+Shift+4".into(),
            record_full: "CommandOrControl+Shift+5".into(),
        }
    }
}
```

Update the existing `save_then_load_hotkeys_round_trips` test (from the screenshot plan) to include the two new fields in its constructed `HotkeySettings` literal, and run `cargo test settings::` to confirm the existing tests (now updated) still pass — this is a straightforward field addition, not new test cases.

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test settings::`
Expected: PASS (existing hotkey tests, now covering 4 fields).

- [ ] **Step 3: Update the frontend type and form**

In `src/lib/api.ts`, extend the `HotkeySettings` interface:
```ts
export interface HotkeySettings {
  captureArea: string;
  captureFull: string;
  recordArea: string;
  recordFull: string;
}
```

In `src/windows/settings/HotkeyConfigForm.tsx`, update the `DEFAULT` constant to match, and add two more `<HotkeyRecorderField>` entries (following the exact pattern of the existing `captureArea`/`captureFull` fields):
```tsx
const DEFAULT: HotkeySettings = {
  captureArea: "CommandOrControl+Shift+2",
  captureFull: "CommandOrControl+Shift+3",
  recordArea: "CommandOrControl+Shift+4",
  recordFull: "CommandOrControl+Shift+5",
};
```
```tsx
<HotkeyRecorderField
  label="Record Area"
  value={hotkeys.recordArea}
  onChange={(v) => setHotkeys((h) => ({ ...h, recordArea: v }))}
/>
<HotkeyRecorderField
  label="Record Full Screen"
  value={hotkeys.recordFull}
  onChange={(v) => setHotkeys((h) => ({ ...h, recordFull: v }))}
/>
```
(Placed after the existing two fields, before the Save button.)

- [ ] **Step 4: Register the new shortcuts in `register_shortcuts`**

In `src-tauri/src/lib.rs`'s `register_shortcuts` function (from the screenshot pipeline plan), add two more `gs.on_shortcut(...)` calls mirroring the existing `capture_area`/`capture_full` ones, emitting new events `"trigger-record-area"`/`"trigger-record-full"`:
```rust
gs.on_shortcut(hotkeys.record_area.as_str(), |app, _shortcut, event| {
    if event.state() == ShortcutState::Pressed {
        app.emit("trigger-record-area", ()).ok();
    }
})
.map_err(|e| format!("record_area shortcut \"{}\": {e}", hotkeys.record_area))?;
gs.on_shortcut(hotkeys.record_full.as_str(), |app, _shortcut, event| {
    if event.state() == ShortcutState::Pressed {
        app.emit("trigger-record-full", ()).ok();
    }
})
.map_err(|e| format!("record_full shortcut \"{}\": {e}", hotkeys.record_full))?;
```
These events aren't consumed by anything yet — that's Task 6.

- [ ] **Step 5: Build and verify**

Run: `npm run build` (tsc/vite) and `cd src-tauri && cargo build` — both should be clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Record Area/Record Screen hotkey settings"
```

---

### Task 5: Overlay window "confirm" phase (mic toggle + Start/Cancel)

**Files:**
- Modify: `src/windows/overlay/OverlayApp.tsx`
- Modify: `src-tauri/src/commands.rs` (add `show_overlay_for_recording`, reusing the overlay window)
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: existing overlay window/drag-select mechanic (screenshot pipeline plan, Task 8), `commands::show_overlay`/`hide_overlay`.
- Produces: `OverlayApp` gains a two-phase state machine: `"select"` (only entered for area recording — reuses the existing drag-select UI verbatim) and `"confirm"` (a floating panel: mic checkbox + Start/Cancel buttons). A new prop-like signal distinguishes *why* the overlay was shown: emits `"record-confirmed"` with `{ region: CaptureRect | null, micEnabled: boolean }` when Start is clicked, or hides without emitting on Cancel/Escape.
- Consumed by: Task 6 (listens for `"record-confirmed"` to actually call `start_recording_command`).

- [ ] **Step 1: Add a mode query param to distinguish overlay purpose**

The overlay window's URL is `index.html#/overlay`. Extend `src/main.tsx`'s routing to pass through the full hash so `OverlayApp` can read a mode: change the overlay window's `url` in `tauri.conf.json` to support being opened with different hash suffixes, OR simpler — have the Rust side emit a "why" via a small event right after showing the window. Use the simpler approach: add a new command `show_overlay_for_recording(app: AppHandle, area: bool) -> Result<(), String>` that shows the overlay window (reusing `show_overlay`'s monitor-sizing logic) and immediately emits an `overlay-mode` event to it with `{ purpose: "record", area }`.

In `src-tauri/src/commands.rs`, refactor the existing `show_overlay` to extract its monitor-sizing logic into a private helper, then add:
```rust
fn resize_overlay_to_monitor(win: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(monitor) = win.primary_monitor().map_err(|e| e.to_string())? {
        let position = monitor.position();
        let size = monitor.size();
        win.set_position(Position::Physical(PhysicalPosition::new(position.x, position.y)))
            .map_err(|e| e.to_string())?;
        win.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_overlay_for_recording(app: AppHandle, area: bool) -> Result<(), String> {
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    resize_overlay_to_monitor(&win)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("overlay", "overlay-mode", serde_json::json!({ "purpose": "record", "area": area }))
        .map_err(|e| e.to_string())
}
```
Update the existing `show_overlay` command to call `resize_overlay_to_monitor(&win)?;` too if it doesn't already inline that logic (check the actual current function body from the screenshot pipeline plan's Task 9 implementation before editing — adapt rather than duplicate).

Register `show_overlay_for_recording` in `lib.rs`'s `generate_handler!`.

- [ ] **Step 2: Add the frontend API wrapper**

Append to `src/lib/api.ts`:
```ts
export function showOverlayForRecording(area: boolean): Promise<void> {
  return invoke("show_overlay_for_recording", { area });
}
```

- [ ] **Step 3: Extend `OverlayApp.tsx` with the phase state machine**

Read the actual current `OverlayApp.tsx` first (it has the drag-select mechanic, crosshair cursor effect, and DPI-aware `overlay-selection` emit from the screenshot pipeline plan) — extend it, don't replace it wholesale. Add:
```tsx
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Phase = "select" | "confirm";

// (inside OverlayApp, alongside existing start/current/dragging state)
const [phase, setPhase] = useState<Phase>("select");
const [purpose, setPurpose] = useState<"screenshot" | "record">("screenshot");
const [micEnabled, setMicEnabled] = useState(false);

useEffect(() => {
  const unlisten = listen<{ purpose: "record"; area: boolean }>("overlay-mode", (event) => {
    setPurpose(event.payload.purpose);
    // Full-screen recording skips straight to the confirm panel; area
    // recording goes through the existing drag-select first.
    setPhase(event.payload.area ? "select" : "confirm");
  });
  return () => {
    unlisten.then((f) => f());
  };
}, []);
```

Modify `handleMouseUp` so that when `purpose === "record"`, instead of emitting `"overlay-selection"` and hiding, it stores the selected rect (in physical pixels, same DPR conversion as the existing screenshot path) and transitions to the confirm phase without hiding the overlay:
```tsx
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
    if (purpose === "screenshot") await invoke("hide_overlay");
    return;
  }
  const dpr = window.devicePixelRatio;
  const rect = {
    x: Math.round(x * dpr),
    y: Math.round(y * dpr),
    width: Math.round(width * dpr),
    height: Math.round(height * dpr),
  };
  if (purpose === "record") {
    setRecordRegion(rect);
    setPhase("confirm");
    return;
  }
  await invoke("hide_overlay");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await emit("overlay-selection", rect);
}
```
(Add a `const [recordRegion, setRecordRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null);` alongside the other state.)

Add the confirm panel render, alongside the existing drag-select rendering (only shown when `phase === "confirm"`):
```tsx
{phase === "confirm" && (
  <div className="record-confirm-panel">
    <label>
      <input type="checkbox" checked={micEnabled} onChange={(e) => setMicEnabled(e.target.checked)} />
      Microphone
    </label>
    <div className="record-confirm-actions">
      <button
        type="button"
        className="button button-primary"
        onClick={async () => {
          await emit("record-confirmed", { region: recordRegion, micEnabled });
          await invoke("hide_overlay");
        }}
      >
        Start Recording
      </button>
      <button
        type="button"
        className="button"
        onClick={async () => {
          setPhase("select");
          setRecordRegion(null);
          await invoke("hide_overlay");
        }}
      >
        Cancel
      </button>
    </div>
  </div>
)}
```

Update `handleKeyDown`'s Escape branch to also reset `phase`/`recordRegion` back to defaults when cancelling.

Add corresponding CSS to `src/styles.css`:
```css
.record-confirm-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  color: var(--fg);
}

.record-confirm-actions {
  display: flex;
  gap: var(--space-2);
}
```

- [ ] **Step 4: Manually verify**

Manual GUI verification (triggering `show_overlay_for_recording` for both `area: true` and `area: false`, confirming the confirm panel appears at the right point in each flow) requires a real display and isn't possible in a headless sandbox — state this clearly if applicable, rather than claiming it. At minimum confirm `npm run build`/`cargo build` are clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add recording confirmation phase to the overlay window"
```

---

### Task 6: Wire tray Record Area/Record Screen/Stop Recording to actually start/stop recording

**Files:**
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `recording::{start_recording, stop_recording, RecordingState, CaptureRegion}` (Tasks 2-3), `commands::show_overlay_for_recording` (Task 5), `"record-confirmed"` event (Task 5), `"trigger-record-area"`/`"trigger-record-full"` events (Task 4).
- Produces:
  - `pub struct TrayMenuItems { pub record_area: MenuItem<tauri::Wry>, pub record_full: MenuItem<tauri::Wry>, pub stop_recording: MenuItem<tauri::Wry> }` — a Tauri-managed state holding handles to the toggleable menu items, so any later function (not just the code that built the menu) can flip their enabled state via `MenuItem::set_enabled(&self, enabled: bool) -> tauri::Result<()>` (a real, stable method on Tauri v2's `MenuItem` — verify the exact signature against the installed version, but this method existing is not in question the way the ffmpeg CLI specifics are).
  - `pub(crate) fn set_recording_tray_state(app: &tauri::AppHandle, recording: bool)` in `lib.rs` — looks up `TrayMenuItems` from managed state and calls `set_enabled` on each item.
- Consumed by: Task 10 (extends `TrayMenuItems` with a fourth field for its own toggleable item, following the same pattern).

- [ ] **Step 1: Add tray menu items and store them in managed state**

In `src-tauri/src/tray.rs`, read the current `build_tray` function (from the screenshot pipeline plan) and add two more `MenuItem`s alongside the existing `capture_area`/`capture_full`/`open_settings`/`quit` items:
```rust
let record_area = MenuItem::with_id(app, "record_area", "Record Area", true, None::<&str>)?;
let record_full = MenuItem::with_id(app, "record_full", "Record Screen", true, None::<&str>)?;
let stop_recording = MenuItem::with_id(app, "stop_recording", "Stop Recording", false, None::<&str>)?;
```
(`stop_recording` starts disabled — `false` for the "enabled" parameter — since nothing is recording at launch.)

Add all three to the `Menu::with_items` call, in a sensible position (e.g., after `capture_full`, before `open_settings`).

After building the menu (`build_tray`'s existing `let menu = Menu::with_items(...)` line), define and manage the struct so `set_recording_tray_state` can find these items later:
```rust
pub struct TrayMenuItems {
    pub record_area: MenuItem<tauri::Wry>,
    pub record_full: MenuItem<tauri::Wry>,
    pub stop_recording: MenuItem<tauri::Wry>,
}

app.manage(TrayMenuItems {
    record_area: record_area.clone(),
    record_full: record_full.clone(),
    stop_recording: stop_recording.clone(),
});
```
(`MenuItem` is `Clone` — cloning gives another handle to the same underlying native menu item, not a separate copy, so calling `.set_enabled()` on the cloned handle affects the real tray menu. Place the `TrayMenuItems` struct definition near the top of `tray.rs`, exported as `pub` so `lib.rs` can reference `crate::tray::TrayMenuItems`.)

- [ ] **Step 2: Wire menu click handlers**

In the `on_menu_event` match arms, add:
```rust
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
```

- [ ] **Step 3: Wire the "record-confirmed" listener and recording lifecycle in `lib.rs`**

In `.setup()`, alongside the existing capture-trigger listeners, add:
```rust
let handle4 = app.handle().clone();
app.listen("trigger-record-area", move |_event| {
    if let Err(e) = commands::show_overlay_for_recording(handle4.clone(), true) {
        eprintln!("show_overlay_for_recording failed: {e}");
    }
});

let handle5 = app.handle().clone();
app.listen("trigger-record-full", move |_event| {
    if let Err(e) = commands::show_overlay_for_recording(handle5.clone(), false) {
        eprintln!("show_overlay_for_recording failed: {e}");
    }
});

if let Some(overlay_window) = app.get_webview_window("overlay") {
    let handle6 = app.handle().clone();
    overlay_window.listen("record-confirmed", move |event| {
        #[derive(serde::Deserialize)]
        struct RecordConfirmed {
            region: Option<recording::CaptureRegion>,
            #[serde(rename = "micEnabled")]
            mic_enabled: bool,
        }
        match serde_json::from_str::<RecordConfirmed>(event.payload()) {
            Ok(confirmed) => {
                let state = handle6.state::<recording::RecordingState>();
                let output_path = std::env::temp_dir().join(format!("pxl-recording-{}.mp4", std::process::id()));
                match recording::start_recording(confirmed.region, confirmed.mic_enabled, &output_path) {
                    Ok(child) => {
                        *state.0.lock().unwrap() = Some((child, output_path));
                        set_recording_tray_state(&handle6, true);
                    }
                    Err(e) => notify_capture_failed(&handle6, &format!("failed to start recording: {e}")),
                }
            }
            Err(e) => eprintln!("failed to parse record-confirmed payload: {e}"),
        }
    });
}

let handle7 = app.handle().clone();
app.listen("trigger-stop-recording", move |_event| {
    let state = handle7.state::<recording::RecordingState>();
    let entry = state.0.lock().unwrap().take();
    if let Some((child, _output_path)) = entry {
        match recording::stop_recording(child) {
            Ok(()) => {
                set_recording_tray_state(&handle7, false);
                // Task 8 defines open_editor_with_video and adds the call
                // `open_editor_with_video(&handle7, &output_path);` here
                // (renaming _output_path back to output_path at that
                // point) — this task deliberately stops short of it since
                // that function doesn't exist yet and this file must still
                // compile cleanly on its own at the end of this task.
            }
            Err(e) => notify_capture_failed(&handle7, &format!("failed to stop recording: {e}")),
        }
    }
});
```

Add a helper (in `lib.rs`, alongside `notify_capture_failed`/`open_editor_with_png`) to toggle the tray's recording indicator, using the `TrayMenuItems` managed state from Step 1:
```rust
pub(crate) fn set_recording_tray_state(app: &tauri::AppHandle, recording: bool) {
    let items = app.state::<crate::tray::TrayMenuItems>();
    let _ = items.stop_recording.set_enabled(recording);
    let _ = items.record_area.set_enabled(!recording);
    let _ = items.record_full.set_enabled(!recording);
}
```
`open_editor_with_video` is defined in Task 8 — this call is added now (rather than left as a comment) because `RecordingState` already carries the output path from Task 3, so there's no missing information to defer; Task 8 just needs to exist by the time this code runs, which the task order guarantees.

- [ ] **Step 4: Manually verify**

Requires a real display/mic and can't be done headlessly — state this clearly. At minimum confirm `cargo build` is clean and `cargo test` (all prior tests) still pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire tray Record Area/Record Screen/Stop Recording to the recording lifecycle"
```

---

### Task 7: Trim range state (pure, tested)

**Files:**
- Create: `src/windows/editor/trimState.ts`
- Create: `src/windows/editor/trimState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TrimState { duration: number; inPoint: number; outPoint: number; }
  export function initialTrimState(duration: number): TrimState;
  export function setInPoint(state: TrimState, time: number): TrimState;   // clamps to [0, outPoint)
  export function setOutPoint(state: TrimState, time: number): TrimState;  // clamps to (inPoint, duration]
  ```
- Consumed by: Task 8 (`VideoTrimmer` component), Task 9 (trim command's in/out arguments).

- [ ] **Step 1: Write the failing tests**

`src/windows/editor/trimState.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { initialTrimState, setInPoint, setOutPoint } from "./trimState";

describe("trimState", () => {
  it("starts with the full clip selected", () => {
    const state = initialTrimState(10);
    expect(state).toEqual({ duration: 10, inPoint: 0, outPoint: 10 });
  });

  it("setInPoint moves the in-point within bounds", () => {
    const state = setInPoint(initialTrimState(10), 3);
    expect(state.inPoint).toBe(3);
  });

  it("setInPoint clamps below zero to zero", () => {
    const state = setInPoint(initialTrimState(10), -5);
    expect(state.inPoint).toBe(0);
  });

  it("setInPoint clamps to just below the current out-point, never past or equal to it", () => {
    const withOut = setOutPoint(initialTrimState(10), 6);
    const state = setInPoint(withOut, 9);
    expect(state.inPoint).toBeLessThan(state.outPoint);
  });

  it("setOutPoint moves the out-point within bounds", () => {
    const state = setOutPoint(initialTrimState(10), 7);
    expect(state.outPoint).toBe(7);
  });

  it("setOutPoint clamps above duration to duration", () => {
    const state = setOutPoint(initialTrimState(10), 999);
    expect(state.outPoint).toBe(10);
  });

  it("setOutPoint clamps to just above the current in-point, never before or equal to it", () => {
    const withIn = setInPoint(initialTrimState(10), 4);
    const state = setOutPoint(withIn, 1);
    expect(state.outPoint).toBeGreaterThan(state.inPoint);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- trimState`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`src/windows/editor/trimState.ts`:
```ts
export interface TrimState {
  duration: number;
  inPoint: number;
  outPoint: number;
}

export function initialTrimState(duration: number): TrimState {
  return { duration, inPoint: 0, outPoint: duration };
}

const MIN_GAP = 0.1;

export function setInPoint(state: TrimState, time: number): TrimState {
  const clamped = Math.max(0, Math.min(time, state.outPoint - MIN_GAP));
  return { ...state, inPoint: clamped };
}

export function setOutPoint(state: TrimState, time: number): TrimState {
  const clamped = Math.min(state.duration, Math.max(time, state.inPoint + MIN_GAP));
  return { ...state, outPoint: clamped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- trimState`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add pure trim range state for the video trim UI"
```

---

### Task 8: Video mode in the editor (VideoTrimmer component + EditorApp dispatch)

**Files:**
- Create: `src/windows/editor/VideoTrimmer.tsx`
- Modify: `src/windows/editor/EditorApp.tsx`
- Modify: `src-tauri/src/lib.rs` (emit a video-load event analogous to `editor-load-image`)

**Interfaces:**
- Consumes: `trimState.{TrimState, initialTrimState, setInPoint, setOutPoint}` (Task 7).
- Produces: `VideoTrimmer` component with props `{ videoSrc: string; trim: TrimState; onTrimChange: (t: TrimState) => void }`. `EditorApp` gains a `captureType: "image" | "video"` piece of state, set based on which load event fired, dispatching between the existing annotation UI and the new `VideoTrimmer`.
- Consumed by: Task 9 (Save & Upload in video mode calls the trim command using `trim.inPoint`/`trim.outPoint`).

- [ ] **Step 1: Emit a video-load event from the Rust side**

In `src-tauri/src/lib.rs`, add a helper alongside `open_editor_with_png`:
```rust
pub(crate) fn open_editor_with_video(app: &tauri::AppHandle, video_path: &std::path::Path) {
    if let Some(win) = app.get_webview_window("editor") {
        if let Err(e) = win.show() {
            eprintln!("failed to show editor window: {e}");
        }
        if let Err(e) = win.set_focus() {
            eprintln!("failed to focus editor window: {e}");
        }
        if let Err(e) = app.emit_to("editor", "editor-load-video", video_path.to_string_lossy().to_string()) {
            eprintln!("failed to emit editor-load-video: {e}");
        }
    } else {
        eprintln!("editor window missing");
    }
}
```

In `src-tauri/src/lib.rs`'s `trigger-stop-recording` handler (from Task 6), find the comment `// Task 8 defines open_editor_with_video and adds the call ...` and replace it with a real call, renaming the destructured `_output_path` back to `output_path` (Task 6 prefixed it with an underscore specifically because it was unused until now):
```rust
let entry = state.0.lock().unwrap().take();
if let Some((child, output_path)) = entry {
    match recording::stop_recording(child) {
        Ok(()) => {
            set_recording_tray_state(&handle7, false);
            open_editor_with_video(&handle7, &output_path);
        }
        Err(e) => notify_capture_failed(&handle7, &format!("failed to stop recording: {e}")),
    }
}
```

- [ ] **Step 2: Write `VideoTrimmer.tsx`**

```tsx
import { useRef } from "react";
import type { TrimState } from "./trimState";
import { setInPoint, setOutPoint } from "./trimState";

interface Props {
  videoSrc: string;
  trim: TrimState;
  onTrimChange: (t: TrimState) => void;
}

export default function VideoTrimmer({ videoSrc, trim, onTrimChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  function handleLoadedMetadata() {
    const duration = videoRef.current?.duration ?? 0;
    if (duration > 0 && trim.duration === 0) {
      onTrimChange({ duration, inPoint: 0, outPoint: duration });
    }
  }

  return (
    <div className="video-trimmer">
      <video ref={videoRef} src={videoSrc} controls onLoadedMetadata={handleLoadedMetadata} className="video-preview" />
      <div className="trim-scrubber">
        <input
          type="range"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.inPoint}
          onChange={(e) => onTrimChange(setInPoint(trim, Number(e.target.value)))}
        />
        <input
          type="range"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.outPoint}
          onChange={(e) => onTrimChange(setOutPoint(trim, Number(e.target.value)))}
        />
      </div>
      <div className="trim-labels">
        <span>In: {trim.inPoint.toFixed(2)}s</span>
        <span>Out: {trim.outPoint.toFixed(2)}s</span>
        <span>Duration: {(trim.outPoint - trim.inPoint).toFixed(2)}s</span>
      </div>
    </div>
  );
}
```

Add corresponding CSS to `src/styles.css`:
```css
.video-trimmer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.video-preview {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

.trim-scrubber {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.trim-labels {
  display: flex;
  gap: var(--space-3);
  font-size: 12px;
  color: var(--fg-muted);
}
```

- [ ] **Step 3: Wire capture-type dispatch into `EditorApp.tsx`**

Read the actual current `EditorApp.tsx` first (it has `imageSrc`/`state`/annotation-specific logic from the screenshot pipeline plan). Add:
```tsx
import { listen } from "@tauri-apps/api/event";
import VideoTrimmer from "./VideoTrimmer";
import { initialTrimState, type TrimState } from "./trimState";

// alongside existing imageSrc state:
const [videoSrc, setVideoSrc] = useState<string | null>(null);
const [trim, setTrim] = useState<TrimState>(initialTrimState(0));

// alongside the existing "editor-load-image" listener effect, add a second listen call for "editor-load-video":
useEffect(() => {
  const unlisten = listen<string>("editor-load-video", (event) => {
    setVideoSrc(`file://${event.payload}`);
    setImageSrc(null);
    setTrim(initialTrimState(0));
  });
  return () => {
    unlisten.then((f) => f());
  };
}, []);
```
Also update the existing `"editor-load-image"` listener to `setVideoSrc(null);` when it fires, so opening a new screenshot after a recording (or vice versa) doesn't show stale UI from the other mode.

Update the component's render logic: the existing early-return (`if (!imageSrc) return <div className="editor-waiting">...`) needs to become a three-way branch: waiting (neither set), image mode (existing UI), video mode (new `VideoTrimmer`, with its own Save & Upload button — Task 9 wires the actual upload/trim call):
```tsx
if (!imageSrc && !videoSrc) {
  return <div className="editor-waiting">Waiting for capture…</div>;
}

if (videoSrc) {
  return (
    <div className="editor-page">
      <div className="editor-actions">
        <button type="button" className="button button-primary" onClick={handleTrimAndUpload} disabled={uploading}>
          {uploading ? "Uploading…" : "Save & Upload"}
        </button>
      </div>
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" className="button" onClick={handleTrimAndUpload}>Retry</button>
        </div>
      )}
      <VideoTrimmer videoSrc={videoSrc} trim={trim} onTrimChange={setTrim} />
    </div>
  );
}

// ...existing image-mode JSX below, unchanged...
```
(`handleTrimAndUpload` is implemented in Task 9 — for this task, stub it as a function that does nothing yet, e.g. `async function handleTrimAndUpload() {}`, so the component compiles; Task 9 replaces the stub.)

- [ ] **Step 4: Build and verify**

Run: `npm run build` (tsc/vite) and `npm run test` — should be clean, existing image-mode tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add video trim mode to the editor window"
```

---

### Task 9: Trim re-encode command and video upload wiring

**Files:**
- Create/modify: `src-tauri/src/trim.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod trim;`)
- Modify: `src-tauri/src/commands.rs` (add `trim_video` command, extend `upload_file`'s content-type match)
- Modify: `src/lib/api.ts`
- Modify: `src/windows/editor/EditorApp.tsx` (replace the `handleTrimAndUpload` stub)

**Interfaces:**
- Produces:
  - `pub fn build_trim_args(input: &std::path::Path, output: &std::path::Path, in_point: f64, out_point: f64) -> Vec<String>` — pure, unit tested (frame-accurate re-encode, not stream-copy per the global constraint: no `-c copy`).
  - `pub fn trim_video(input: &std::path::Path, output: &std::path::Path, in_point: f64, out_point: f64) -> Result<(), String>` — runs ffmpeg with the above args.
  - Tauri command `trim_and_upload(input_path: String, in_point: f64, out_point: f64) -> Result<String, String>` composing: trim to a temp output path, read the bytes, then call the existing upload pipeline (Task 19 of the screenshot pipeline plan) with extension `"mp4"`.
- Consumes: existing `commands::upload_file`'s composition pattern (filename generation, object key, settings/credentials load, `upload::upload_object`, `upload::build_public_url` — screenshot pipeline plan, Task 19). This task extends rather than duplicates: refactor `upload_file`'s body into a reusable private function parameterized by bytes+extension, called by both the existing image path and this task's video path.

- [ ] **Step 1: Write the failing tests for `build_trim_args`**

`src-tauri/src/trim.rs`:
```rust
pub fn build_trim_args(
    input: &std::path::Path,
    output: &std::path::Path,
    in_point: f64,
    out_point: f64,
) -> Vec<String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn includes_input_and_output_paths() {
        let args = build_trim_args(Path::new("/tmp/in.mp4"), Path::new("/tmp/out.mp4"), 1.0, 5.0);
        let joined = args.join(" ");
        assert!(joined.contains("/tmp/in.mp4"));
        assert!(joined.ends_with("/tmp/out.mp4"));
    }

    #[test]
    fn uses_ss_and_to_for_the_trim_range() {
        let args = build_trim_args(Path::new("/tmp/in.mp4"), Path::new("/tmp/out.mp4"), 2.5, 7.25);
        let joined = args.join(" ");
        assert!(joined.contains("-ss 2.5"));
        assert!(joined.contains("-to 7.25"));
    }

    #[test]
    fn never_uses_stream_copy() {
        // Frame-accurate trim per the global constraint: must re-encode,
        // never `-c copy` (which would snap to the nearest keyframe).
        let args = build_trim_args(Path::new("/tmp/in.mp4"), Path::new("/tmp/out.mp4"), 0.0, 3.0);
        assert!(!args.iter().any(|a| a == "copy"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test trim::`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 3: Implement**

```rust
pub fn build_trim_args(
    input: &std::path::Path,
    output: &std::path::Path,
    in_point: f64,
    out_point: f64,
) -> Vec<String> {
    vec![
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-ss".to_string(),
        in_point.to_string(),
        "-to".to_string(),
        out_point.to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        output.to_string_lossy().to_string(),
    ]
}

pub fn trim_video(
    input: &std::path::Path,
    output: &std::path::Path,
    in_point: f64,
    out_point: f64,
) -> Result<(), String> {
    use ffmpeg_sidecar::command::FfmpegCommand;
    let args = build_trim_args(input, output, in_point, out_point);
    let mut child = FfmpegCommand::new()
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}
```

Note: placing `-ss`/`-to` AFTER `-i` (as written above) forces ffmpeg to decode-then-cut, which is what gives frame accuracy (placing `-ss` before `-i` is faster but seeks to the nearest keyframe — the opposite of what the global constraint requires). Verify this ordering behavior against the actual installed ffmpeg version's documented behavior before relying on it in production.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test trim::`
Expected: PASS, 3 tests.

- [ ] **Step 5: Refactor `upload_file` into a reusable core, add `trim_and_upload`**

Read the actual current `commands::upload_file` (screenshot pipeline plan, Task 19) before editing. Extract its body (everything after receiving `bytes`/`extension`) into a private async function:
```rust
async fn upload_bytes(app: &AppHandle, bytes: Vec<u8>, extension: &str) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let settings = settings::load_settings(&config_dir);
    let creds = settings::KeyringCredentialStore
        .get()
        .ok_or("no upload credentials configured — open Settings and add them")?;

    let name = filename::generate_filename(settings.filename_prefix.as_deref(), extension);
    let key = object_key::build_object_key(settings.key_prefix.as_deref(), &name);
    let content_type = match extension {
        "png" => "image/png",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    };

    upload::upload_object(&settings, &creds, &key, bytes, content_type).await?;
    Ok(upload::build_public_url(&settings, &key))
}

#[tauri::command]
pub async fn upload_file(app: AppHandle, bytes: Vec<u8>, extension: String) -> Result<String, String> {
    upload_bytes(&app, bytes, &extension).await
}

#[tauri::command]
pub async fn trim_and_upload(app: AppHandle, input_path: String, in_point: f64, out_point: f64) -> Result<String, String> {
    let input = std::path::PathBuf::from(&input_path);
    let output = std::env::temp_dir().join(format!("pxl-trimmed-{}.mp4", std::process::id()));
    crate::trim::trim_video(&input, &output, in_point, out_point)?;
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    let url = upload_bytes(&app, bytes, "mp4").await?;
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&input);
    Ok(url)
}
```
Register `trim_and_upload` in `lib.rs`'s `generate_handler!`. Add `mod trim;` to `lib.rs`.

- [ ] **Step 6: Wire the frontend**

Append to `src/lib/api.ts`:
```ts
export function trimAndUpload(inputPath: string, inPoint: number, outPoint: number): Promise<string> {
  return invoke("trim_and_upload", { inputPath, inPoint, outPoint });
}
```

In `EditorApp.tsx`, replace the Task 8 stub with a real implementation mirroring the existing `handleSaveAndUpload`'s success/error/clipboard/notification pattern:
```tsx
async function handleTrimAndUpload() {
  if (!videoSrc) return;
  setUploading(true);
  setError(null);
  try {
    const inputPath = videoSrc.replace("file://", "");
    const url = await trimAndUpload(inputPath, trim.inPoint, trim.outPoint);
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
(`writeText`, `sendNotification`, `getCurrentWindow` are already imported in `EditorApp.tsx` from the screenshot pipeline plan's Task 19 — reuse those imports, don't re-import.)

- [ ] **Step 7: Build and verify**

Run: `cd src-tauri && cargo build && cargo test` and `npm run build && npm run test` — all should pass with no regressions to the existing image-upload path (`upload_file` behavior is unchanged, only refactored internally).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add frame-accurate trim + reuse the upload pipeline for video"
```

---

### Task 10: Reopen Last Capture (image or video)

**Files:**
- Modify: `src-tauri/src/lib.rs` (last-capture state, tray item enabling)
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/windows/editor/EditorApp.tsx`

**Interfaces:**
- Produces:
  - `pub enum LastCapture { Image { png_base64: String, shapes_json: String }, Video { path: std::path::PathBuf, in_point: f64, out_point: f64 } }` stored in a new `pub struct LastCaptureState(pub std::sync::Mutex<Option<LastCapture>>)` managed state.
  - Tray menu item "Reopen Last Capture", enabled only when `LastCaptureState` holds a value.
  - Tauri command `reopen_last_capture(app: AppHandle) -> Result<(), String>` that re-emits the appropriate `editor-load-image`/`editor-load-video` event (plus, for images, a way to restore the shapes — see Step 3) and shows the editor window.
- Consumes: everything built in Tasks 1-9 plus the screenshot pipeline plan's annotation state (`toolState.ts`'s `EditorState`/`Shape[]`).

- [ ] **Step 1: Add `LastCaptureState` and populate it whenever a capture opens the editor**

In `src-tauri/src/lib.rs`:
```rust
pub enum LastCapture {
    Image { png_base64: String },
    Video { path: std::path::PathBuf },
}

pub struct LastCaptureState(pub std::sync::Mutex<Option<LastCapture>>);

impl Default for LastCaptureState {
    fn default() -> Self {
        LastCaptureState(std::sync::Mutex::new(None))
    }
}
```
Register with `.manage(LastCaptureState::default())` in the builder chain.

Modify `open_editor_with_png` to also record it:
```rust
pub(crate) fn open_editor_with_png(app: &tauri::AppHandle, png_bytes: Vec<u8>) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let state = app.state::<LastCaptureState>();
    *state.0.lock().unwrap() = Some(LastCapture::Image { png_base64: b64.clone() });
    set_reopen_enabled(app, true);
    // ...rest of the existing function body unchanged (show window, emit editor-load-image)...
}
```
Modify `open_editor_with_video` similarly:
```rust
pub(crate) fn open_editor_with_video(app: &tauri::AppHandle, video_path: &std::path::Path) {
    let state = app.state::<LastCaptureState>();
    *state.0.lock().unwrap() = Some(LastCapture::Video { path: video_path.to_path_buf() });
    set_reopen_enabled(app, true);
    // ...rest of the existing function body unchanged...
}
```

Note on scope: per the design spec, only the *most recent* capture's raw content (image bytes or video path) needs to survive for reopening — the in-progress annotation/trim state living in the editor's own React state is what "reopen exactly as it was left" refers to, but since the editor window is hidden (not destroyed) after Save & Upload per the screenshot pipeline plan's window-close-hide fix, its React component state is naturally still present in memory when reopened, UNLESS the user already navigated it to a new capture in between. Keep this task's Rust-side state to just "what to re-show" (the raw image/video); do not attempt to serialize/restore annotation shapes or trim points from Rust — that's already preserved for free by the editor window staying alive, as long as `reopen_last_capture` re-shows the window WITHOUT re-emitting a fresh load event when the editor's own in-memory state is already correct. Only re-emit the load event if the editor window was actually closed/reset since the last capture (e.g., after `main.rs` restarts) — for this app's actual lifecycle (window hidden, never destroyed, per the close-to-hide fix), the simplest correct implementation is: `reopen_last_capture` just shows+focuses the editor window without emitting anything, since its content and state are already sitting there from last time. Implement it this way; do not add unnecessary complexity re-deriving state that already persists.

- [ ] **Step 2: Add the tray item and reopen command**

In `src-tauri/src/tray.rs`, add:
```rust
let reopen_last_capture = MenuItem::with_id(app, "reopen_last_capture", "Reopen Last Capture", false, None::<&str>)?;
```
(starts disabled, `false`) and add it to `Menu::with_items`. In `on_menu_event`:
```rust
"reopen_last_capture" => {
    if let Err(e) = crate::commands::reopen_last_capture(app.clone()) {
        eprintln!("reopen_last_capture failed: {e}");
    }
}
```

Extend Task 6's `TrayMenuItems` struct (read its current definition first) with a fourth field, and include it when the struct is constructed/managed:
```rust
pub struct TrayMenuItems {
    pub record_area: MenuItem<tauri::Wry>,
    pub record_full: MenuItem<tauri::Wry>,
    pub stop_recording: MenuItem<tauri::Wry>,
    pub reopen_last_capture: MenuItem<tauri::Wry>,
}

app.manage(TrayMenuItems {
    record_area: record_area.clone(),
    record_full: record_full.clone(),
    stop_recording: stop_recording.clone(),
    reopen_last_capture: reopen_last_capture.clone(),
});
```

In `src-tauri/src/lib.rs`, add the enabling helper following the exact same pattern as Task 6's `set_recording_tray_state`:
```rust
pub(crate) fn set_reopen_enabled(app: &tauri::AppHandle, enabled: bool) {
    let items = app.state::<crate::tray::TrayMenuItems>();
    let _ = items.reopen_last_capture.set_enabled(enabled);
}
```

In `src-tauri/src/commands.rs`:
```rust
#[tauri::command]
pub fn reopen_last_capture(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("editor").ok_or("editor window missing")?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Frontend — nothing new required**

Per Step 1's design note, the editor window's own React state already persists correctly across hide/show (it's the same mounted component instance). No `EditorApp.tsx` changes are needed for this task beyond what Tasks 8-9 already built. Confirm this assumption manually: capture something, annotate/trim it, let Save & Upload hide the window, then trigger "Reopen Last Capture" and verify the annotations/trim points are still there. State clearly in your report whether you were able to verify this (needs a real display).

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo build && cargo test` and `npm run build && npm run test`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Reopen Last Capture for both screenshots and recordings"
```

---

### Task 11: Quit-time and new-capture cleanup for in-progress recordings

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/tray.rs`

**Interfaces:**
- Consumes: `recording::{RecordingState, stop_recording}` (Tasks 3, 6).
- Produces: no new public API — ensures the app's `"quit"` tray handler and each capture/record trigger stop any in-progress recording first, per the global constraint ("no orphaned ffmpeg processes").

- [ ] **Step 1: Stop any active recording before quitting**

In `src-tauri/src/tray.rs`'s `"quit"` arm:
```rust
"quit" => {
    let state = app.state::<crate::recording::RecordingState>();
    if let Some((child, _path)) = state.0.lock().unwrap().take() {
        let _ = crate::recording::stop_recording(child);
    }
    app.exit(0);
}
```
(`RecordingState`'s inner type is `Option<(FfmpegChild, PathBuf)>` since Task 3 — this destructuring matches it directly.)

- [ ] **Step 2: Discard (don't finalize/upload) a recording interrupted by starting a new capture**

In each of `capture_full_screen`/`capture_area`/`show_overlay_for_recording`'s Tauri commands (or a shared guard called at the top of each), add a check: if `RecordingState` currently holds an active child, stop it (same graceful-quit path) and discard the resulting temp file (`std::fs::remove_file`) rather than opening the editor with it, since the user explicitly moved on to a different action. Implement this as a small shared helper:
```rust
pub(crate) fn discard_any_active_recording(app: &tauri::AppHandle) {
    let state = app.state::<recording::RecordingState>();
    if let Some((child, path)) = state.0.lock().unwrap().take() {
        let _ = recording::stop_recording(child);
        let _ = std::fs::remove_file(&path);
    }
}
```
Call `discard_any_active_recording(&app)` (or `app.handle()` as appropriate per call site) at the start of `capture_full_screen`, `capture_area`, and `show_overlay_for_recording`.

- [ ] **Step 3: Manually verify**

Start a recording, then trigger a screenshot capture mid-recording; confirm the recording stops and its temp file is gone (check the temp directory), and the screenshot capture proceeds normally. Requires a real display — state clearly if this couldn't be verified in this environment.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: stop and discard in-progress recordings on quit or new capture"
```

---

## Self-Review Notes

- **Spec coverage:** ffmpeg-based capture ✅ (Tasks 1-3), area/full-screen region selection reusing the overlay ✅ (Task 5), mic toggle in a confirmation panel for both recording modes ✅ (Task 5), recording indicator + Stop ✅ (Task 6), configurable hotkeys ✅ (Task 4), frame-accurate trim ✅ (Task 9), reuse of the existing upload pipeline ✅ (Task 9), Reopen Last Capture covering both capture types ✅ (Task 10), quit/new-capture cleanup of in-progress recordings ✅ (Task 11), error handling (ffmpeg missing, recording crash, trim failure) ✅ (Tasks 1, 3, 9 error paths + existing retry-banner pattern reused).
- **Deferred/out of scope, not re-implemented here:** system audio, webcam overlay, video annotation, recording history beyond last-capture, pause/resume — all explicitly out of scope per the design spec.
- **Known empirical risk flagged prominently:** macOS `avfoundation` device indices and Windows `dshow` device names are NOT hardcodable in a way guaranteed to work on every machine — Task 2's implementation ships a documented, testable placeholder and Task 2/3's steps explicitly require the implementer to verify against real `ffmpeg -list_devices` output and adapt, the same pattern successfully used for `xcap`/`aws-sdk-s3` version drift in the screenshot pipeline plan.
- **Type/interface consistency check:** `CaptureRegion` (Task 2, derives `Serialize`/`Deserialize` since it crosses the Tauri IPC boundary both as a direct command parameter (Task 3) and nested inside `RecordConfirmed` (Task 6)) is consumed unchanged throughout, matching field names (`x`/`y`/`width`/`height`) end to end from the frontend's rect object through to `build_capture_args`. `TrimState` (Task 7) flows unchanged into `VideoTrimmer` (Task 8) and is read directly (`trim.inPoint`/`trim.outPoint`) by `handleTrimAndUpload` (Task 9). `RecordingState`'s inner type is `Mutex<Option<(FfmpegChild, PathBuf)>>` from its first definition in Task 3 onward — Tasks 6, 8, and 11 all destructure it the same way, no mid-plan type drift. `TrayMenuItems` is defined in Task 6 with three fields and extended by Task 10 with a fourth (`reopen_last_capture`), both following the identical `MenuItem::set_enabled` pattern via managed state.

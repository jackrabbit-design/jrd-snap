# pxl — cross-platform screenshot & screen-recording menubar app

Date: 2026-07-20

## Summary

A menubar/tray app (macOS + Windows) for taking area/full-screen screenshots and screen recordings, annotating/trimming them, and uploading to an S3 or DigitalOcean Spaces bucket with the resulting URL auto-copied to the clipboard.

## Platform & stack

- **Tauri v2**, single Rust crate backend + single React + TypeScript frontend.
- Rust owns OS integration: tray menu, global shortcuts, screen/area capture, video encoding/trim, cloud upload, credential storage.
- React owns UI: annotation canvas editor, video trim UI, settings forms.
- Chosen over Electron for smaller footprint/lower memory (menubar apps run persistently in the background) and over native per-OS apps (Swift/WinUI) to avoid maintaining two codebases for two Windows users.

## Windows/surfaces

1. **Tray/menubar** — no dedicated window; a native tray menu is the primary entry point. Menu items: Capture Area, Capture Full Screen, Record Area, Record Screen, [Stop Recording when active], Reopen Last Capture, Settings, Quit. Mic toggle appears as a submenu/checkbox on the record actions.
2. **Overlay window** — fullscreen, transparent, borderless. Used for drag-to-select a rectangle, shared between area-screenshot and area-recording flows. Click-and-drag only; Esc cancels.
3. **Editor window** — React app with two modes:
   - **Image mode**: annotation canvas (`react-konva`) with tools: arrow, rectangle, ellipse, freehand pen, highlighter, text label, blur/pixelate region, crop/resize. Single "Save & Upload" action.
   - **Video mode**: trim UI — native `<video>` preview + a scrubber with draggable in/out handles to cut time off the start/end. Single "Save & Upload" action.
4. **Settings window** — React app: global hotkey bindings (per action), upload destination config, filename prefix.

## Capture flows

- **Screenshot, area**: hotkey or menu → overlay appears → drag-select → release triggers immediate capture of that region to a temp PNG → editor opens in image mode.
- **Screenshot, full screen**: menu → immediate full-display capture → editor opens in image mode.
- **Video, area or full screen**: menu → optional mic toggle → (overlay for area selection if applicable) → recording starts; tray shows a recording indicator plus a Stop item/hotkey → on stop, backend produces a temp MP4 → editor opens in video mode (trim).
- **Save & Upload** (both modes): flatten annotations (image) or apply trim in/out points via ffmpeg (video) → generate filename → upload → copy URL to clipboard → system notification with the link → delete temp source file(s) on success.
- **Reopen Last Capture**: menu item, enabled only if a capture exists from the current app session. Reopens the editor with the pre-flattened source and full annotation/trim state restored (kept in memory for the running session only — not persisted to disk, and cleared on app restart, consistent with the "temp files only" local-storage decision below). Saving again is a completely new upload: new filename, new URL, copied to clipboard again. The original upload/URL is untouched.

## Local storage

No persistent local copy is written on upload. Captures live in OS temp storage during editing and are deleted immediately after a successful upload. If an upload fails, the temp file is kept so the user can retry from the error state in the editor (see Error handling).

## Upload configuration

Settings window, one active destination at a time:
- **Provider**: S3 or DigitalOcean Spaces (radio toggle) — both use the S3 API; Spaces just uses a DO-style endpoint (e.g. `nyc3.digitaloceanspaces.com`) instead of an AWS region endpoint.
- **Fields**: Bucket name, Region (S3) or Region + custom endpoint (Spaces), Access Key ID, Secret Access Key, optional Custom Domain/CDN (overrides the generated URL's host if set, e.g. a CloudFront/Spaces CDN domain), optional Key Prefix (a folder-style path prepended to every object key, e.g. `team-chris/`).
- **Credential storage**: Access Key ID / Secret Access Key are stored in the OS keychain (`keyring` crate — Keychain on macOS, Credential Manager on Windows), never in a plaintext config file. Non-secret settings (provider, bucket, region, endpoint, custom domain, key prefix, filename prefix, hotkeys) are stored in Tauri's local app config.
- **Access model**: uploaded objects are set to public-read (ACL or bucket policy, whichever the provider requires) so the copied URL works standalone (e.g. pasted into Slack) with no auth. No presigned-URL/expiry support in v1.

## Filename generation

`{optional-user-prefix-}{6-char nanoid}.{png|mp4}`

- Nanoid uses the URL-safe alphabet (`A-Za-z0-9_-`): 64^6 ≈ 6.8×10^10 possible values — effectively zero collision risk at any realistic personal/small-team volume.
- The filename prefix (Settings) is a plain string glued to the front of the filename, e.g. prefix `chris` → `chris-Xk9fQ2.png`. This is independent of the S3 Key Prefix, which is a folder path in the object key (e.g. `team-chris/chris-Xk9fQ2.png`).
- Extension is chosen by capture type: `.png` for screenshots, `.mp4` for recordings.

## Annotation tools (v1, full set)

Arrow, rectangle, ellipse, freehand pen, highlighter, text label (click to place, editable, adjustable font size/color), blur/pixelate region, crop/resize canvas. All shape tools support adjustable stroke color/width where applicable.

## Video recording (v1 scope)

Area or full-screen capture, optional microphone audio (toggle before starting), trim start/end in the editor after stopping. No system-audio/loopback capture and no webcam overlay in v1.

## Error handling

- **Capture permission denied** (macOS Screen Recording permission not granted): tray notification linking to System Settings > Privacy & Security > Screen Recording.
- **Upload failure** (bad credentials, network error, bucket/ACL misconfiguration): editor stays open, shows an error banner with the failure reason and a "Retry" button. The temp source file is not deleted until upload succeeds.
- **Video encode/trim failure** (bundled ffmpeg missing or errors): trim UI shows an error; falls back to offering upload of the untrimmed original.

## Testing approach

- **Rust**: unit tests for filename generation (prefix + nanoid + extension), S3 object key construction (key prefix + filename), and ffmpeg command construction for trimming (mocking the sidecar invocation rather than actually shelling out in tests).
- **React**: component tests (Vitest + React Testing Library) for the annotation tool state machine (tool selection, shape creation/edit) and trim-handle drag math (clamping, in < out invariant).
- **Manual verification**: a checklist run on both macOS and Windows for the full capture → edit → upload → clipboard flow, plus the reopen-last-capture flow, since screen capture/recording APIs are OS-level and not practical to fully automate in CI.

## Out of scope for v1

- Capture history beyond "last capture" (no persisted list of past uploads).
- System/loopback audio capture in recordings.
- Multiple named upload destinations (only one active destination at a time).
- Presigned/expiring URLs (uploads are public-read only).
- Local backup copies of uploaded files.

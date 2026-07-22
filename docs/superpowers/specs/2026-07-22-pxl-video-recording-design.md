# pxl — screen video recording, trim, and reopen-last-capture

Date: 2026-07-22

## Summary

Adds screen video recording (area or full screen, optional microphone audio) to pxl, building on the screenshot pipeline's foundation: tray menu, hotkeys, editor window, and upload pipeline. Recordings are trimmed in a new editor mode and uploaded through the exact same S3/Spaces pipeline already built for screenshots. Also adds "Reopen Last Capture," deferred from the screenshot plan, now covering either capture type.

## Architecture

Rust gains a `recording` module using the `ffmpeg-sidecar` crate, which locates or auto-downloads a static ffmpeg binary into the app's data directory on first use — no manual per-platform binary bundling. ffmpeg performs both screen capture *and* encoding directly via its native screen-grab input devices (`avfoundation` on macOS, `gdigrab` on Windows), so no separate frame-capture crate or custom pixel-pushing code is needed. Output is MP4 (H.264 video, AAC audio track only if the mic was enabled) — universally playable, including directly in a browser from the uploaded link, consistent with how uploaded screenshots work today.

The existing overlay window (built for area screenshots) is reused for area *region* selection when recording, with the same drag-to-select interaction. The existing editor window gains a second mode (video/trim) alongside its current image/annotation mode. The existing upload pipeline (filename generation, object key construction, S3/Spaces client, clipboard + notification) is reused unchanged, parameterized by file extension/content-type instead of being screenshot-specific.

## Recording flow

1. Tray → **Record Area** or **Record Screen** (menu items and configurable hotkeys, following the same pattern as Capture Area/Capture Full Screen).
2. **Record Area**: shows the existing overlay window to drag-select a region. **Record Screen**: skips directly to step 3, targeting the full primary display.
3. A small floating confirmation panel appears — a microphone on/off toggle and a "Start Recording" button. Nothing records yet; this is a deliberate checkpoint to confirm the region and mic setting before going live. Pressing Escape or closing the panel cancels without recording.
4. On Start, the backend launches ffmpeg targeting the chosen region (or full display) with/without a mic audio input, writing to a temp MP4 file. The tray icon switches to a recording indicator, and a "Stop Recording" menu item (plus hotkey) replaces/augments the capture items while recording is active.
5. Stopping (via menu, hotkey, or app quit — quitting mid-recording stops and discards cleanly rather than leaving orphaned ffmpeg processes) ends the ffmpeg process. On a clean stop, the editor window opens in video mode with the resulting temp MP4.

## Editor video mode (trim)

The editor window's existing mode-dispatch (currently always image/annotation) branches on capture type. Video mode renders:
- A native `<video>` element previewing the recording.
- A scrubber beneath it with two draggable handles (in-point, out-point) and current-time display.
- A "Save & Upload" action (replacing the annotation toolbar's — video isn't annotated in v1, only trimmed) that calls a new Rust command to re-encode *exactly* the selected in/out range via ffmpeg (frame-accurate, not stream-copy — trimming re-encodes rather than snapping to the nearest keyframe, so the cut is always exactly where the handles were dropped), then feeds the resulting bytes through the existing upload pipeline with a `.mp4` extension and `video/mp4` content type.
- The same error banner + Retry pattern as the image upload flow on failure.

## Reopen Last Capture

A "Reopen Last Capture" tray menu item, enabled only when something has been captured this session (screenshot or recording — whichever was captured most recently). The last capture's full state is kept in memory for the running session only (never persisted to disk, consistent with the existing temp-files-only rule) — for a screenshot, that means the annotation shape list; for a recording, the temp video file path plus its last trim in/out points. Reopening restores the editor exactly as it was left. Saving again always produces a new filename and a new URL (never overwrites the original), matching the screenshot plan's established behavior for "reopen and re-save."

## Error handling

- ffmpeg missing and the auto-download fails (no network, blocked download): a tray notification with the error; the recording/trim action that needed it aborts cleanly without leaving the app in a broken state.
- The recording process crashes or exits unexpectedly mid-recording: a notification is shown; no editor window opens (there's no complete file to trim), and the tray reverts out of "recording" state.
- Trim re-encode failure: shown as an error state directly in the trim UI (not a silent failure), with a retry action — same pattern as the existing Save & Upload retry banner.
- Quitting the app (or another capture request arriving) while a recording is in progress stops and discards the in-progress recording rather than leaving an orphaned ffmpeg process running.

## Testing approach

Same split as the screenshot pipeline: pure/deterministic logic gets Rust unit tests — trim in/out range math and validation (e.g., out-point after in-point, both within the clip's duration), ffmpeg argument construction for capture (region crop, mic on/off) and for trim (re-encode range), filename/extension/content-type selection for video vs image. The actual recording and encoding path (launching ffmpeg against a real display and microphone, verifying the output file is a valid playable MP4) is manual-verification-only, called out explicitly in the implementation plan the same way screen capture was for the first plan — a real screen, and for the mic path a real audio input device, are both required and can't be exercised in a headless CI-style environment.

## Out of scope for this plan

- System/loopback audio capture (mic only, per the original design's v1 scope).
- Webcam overlay.
- Video annotation (drawing/text/blur on top of a recording) — trim only.
- A visible recording duration/elapsed-time display beyond what the OS/tray may show natively (not excluded, just not a requirement — implementer may add a simple elapsed-time label in the tray/menu if trivial, but it's not required for this plan to be complete).
- Multiple simultaneous recordings, pause/resume of a recording.
- Recording history beyond "last capture" (same constraint as the screenshot plan).

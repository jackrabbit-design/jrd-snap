use ffmpeg_sidecar::child::FfmpegChild;
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::auto_download;
use ffmpeg_sidecar::paths::ffmpeg_path;
use ffmpeg_sidecar::paths::sidecar_dir;
use std::path::PathBuf;
use std::sync::Mutex;

pub fn ensure_ffmpeg() -> Result<(), String> {
    if let Ok(dir) = sidecar_dir() {
        eprintln!("ffmpeg sidecar install directory: {}", dir.display());
    }
    auto_download().map_err(|e| e.to_string())
}

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
    macos_screen_device_index: &str,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    // Referenced unconditionally so the parameter isn't reported unused on
    // non-macOS builds, where the avfoundation branch below is not compiled.
    let _ = macos_screen_device_index;

    #[cfg(target_os = "macos")]
    {
        // The video device index for screen capture is NOT fixed — it
        // depends on how many cameras/displays the machine has. The caller
        // (Task 3's `start_recording`) is responsible for discovering the
        // real index via `find_macos_screen_device_index` and passing it
        // in here rather than this function guessing.
        let audio_device = if mic_enabled { "0" } else { "none" };
        args.push("-f".into());
        args.push("avfoundation".into());
        // avfoundation does NOT draw the OS mouse cursor into captured
        // frames by default — this must be requested explicitly, and (like
        // -framerate) has to come before -i since it's an avfoundation
        // input option.
        args.push("-capture_cursor".into());
        args.push("1".into());
        args.push("-framerate".into());
        args.push("30".into());
        args.push("-i".into());
        args.push(format!("{macos_screen_device_index}:{audio_device}"));
    }

    #[cfg(target_os = "windows")]
    {
        args.push("-f".into());
        args.push("gdigrab".into());
        // Explicit, though gdigrab already defaults to drawing the cursor —
        // stated outright so this doesn't silently regress if that default
        // ever changes.
        args.push("-draw_mouse".into());
        args.push("1".into());
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
            // KNOWN UNRESOLVED GAP: unlike the macOS branch, no runtime
            // discovery has been implemented for Windows dshow device names
            // (no Windows machine was available to test against). This
            // placeholder is very likely wrong on any real machine; see the
            // `eprintln!` warning in `start_recording` below.
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
    // Without an explicit preset, libx264 defaults to "medium" — decoding
    // and filtering a full 5K/Retina-resolution raw frame every tick just to
    // crop it down is already substantial throughput, and "medium" adds
    // enough encoder-side CPU cost on top that it can fall behind real time
    // on a high-resolution display, building up a backlog that then takes
    // far longer than expected to drain when asked to stop. "ultrafast"
    // trades bitrate efficiency for encoder speed, which matters far more
    // here than file size.
    args.push("-preset".into());
    args.push("ultrafast".into());

    if mic_enabled {
        args.push("-c:a".into());
        args.push("aac".into());
    }

    args.push(output_path.to_string_lossy().to_string());
    args
}

/// Parses avfoundation's `-list_devices true` stderr text for the index of
/// the "Capture screen {target}" entry, e.g. a line like:
/// `[AVFoundation indev @ 0x...] [4] Capture screen 0`
/// `target` is which monitor to record — avfoundation numbers its screen
/// devices "Capture screen 0", "Capture screen 1", etc. in the same order
/// macOS's own display list enumerates them, which lines up with the
/// monitor index used elsewhere (`commands::monitor_index_at`). Falls back
/// to the first "Capture screen" entry found if the exact target isn't
/// present (e.g. a monitor was unplugged between selecting the area and
/// starting the recording) rather than failing outright.
/// Extracted as a pure function so it can be unit tested against real,
/// captured output without spawning ffmpeg.
#[cfg(target_os = "macos")]
fn parse_screen_device_index(stderr_text: &str, target: usize) -> Result<String, String> {
    let wanted = format!("Capture screen {target}");
    let mut fallback: Option<String> = None;
    for line in stderr_text.lines() {
        if let Some(bracket_end) = line.find(']') {
            let after_first_bracket = &line[bracket_end + 1..];
            if let (Some(start), Some(end)) =
                (after_first_bracket.find('['), after_first_bracket.find(']'))
            {
                if start < end {
                    let index = &after_first_bracket[start + 1..end];
                    let name = after_first_bracket[end + 1..].trim();
                    if name == wanted {
                        return Ok(index.to_string());
                    }
                    if fallback.is_none() && name.starts_with("Capture screen") {
                        fallback = Some(index.to_string());
                    }
                }
            }
        }
    }
    fallback.ok_or_else(|| "no \"Capture screen\" device found in avfoundation device list".to_string())
}

/// Discovers the real avfoundation device index for the given monitor by
/// running `ffmpeg -f avfoundation -list_devices true -i ""` and parsing its
/// stderr. This command always exits non-zero (it errors out after printing
/// the device list because "" is not a valid input), so the exit status is
/// deliberately ignored here — only stderr's content matters.
///
/// This must invoke the ffmpeg_sidecar-managed binary (via `ffmpeg_path()`),
/// not whatever "ffmpeg" resolves to on PATH: `start_recording` records using
/// the sidecar binary via `FfmpegCommand::new()`, and on a clean install with
/// no system-wide ffmpeg there may be nothing on PATH at all, which would
/// silently fail discovery and fall back to the hardcoded (likely wrong)
/// index below.
#[cfg(target_os = "macos")]
pub fn find_macos_screen_device_index(target: usize) -> Result<String, String> {
    let output = std::process::Command::new(ffmpeg_path())
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "avfoundation device list (target monitor {target}):\n{}",
        stderr_text
            .lines()
            .filter(|l| l.contains("Capture screen"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let result = parse_screen_device_index(&stderr_text, target);
    eprintln!("resolved avfoundation device index: {result:?}");
    result
}

pub struct RecordingState(pub Mutex<Option<(FfmpegChild, PathBuf, std::time::Instant)>>);

impl Default for RecordingState {
    fn default() -> Self {
        RecordingState(Mutex::new(None))
    }
}

pub fn start_recording(
    region: Option<CaptureRegion>,
    mic_enabled: bool,
    output_path: &std::path::Path,
    monitor_index: usize,
) -> Result<FfmpegChild, String> {
    #[cfg(target_os = "macos")]
    let screen_device_index = match find_macos_screen_device_index(monitor_index) {
        Ok(index) => index,
        Err(e) => {
            eprintln!(
                "warning: failed to discover macOS screen capture device index ({e}); \
                 falling back to hardcoded index \"1\", which is likely WRONG on this machine"
            );
            "1".to_string()
        }
    };
    // Non-macOS capture backends don't select a screen by device index the
    // same way (see the `gdigrab`/Windows path below), so this parameter
    // only matters on macOS.
    #[cfg(not(target_os = "macos"))]
    let _ = monitor_index;
    #[cfg(not(target_os = "macos"))]
    let screen_device_index = "1".to_string();

    #[cfg(target_os = "windows")]
    if mic_enabled {
        eprintln!(
            "warning: Windows dshow microphone device name is a hardcoded placeholder \
             (\"audio=Microphone\"); real device discovery has not been implemented for \
             Windows yet, so this recording's audio input is likely wrong on this machine"
        );
    }

    let args = build_capture_args(region, mic_enabled, output_path, &screen_device_index);
    eprintln!("starting ffmpeg: {}", args.join(" "));
    let mut child = FfmpegCommand::new()
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;

    // ffmpeg_sidecar pipes stdout/stderr unconditionally (Stdio::piped()),
    // and ffmpeg writes continuous progress output to stderr — if nothing
    // ever reads it, the OS pipe buffer fills within a few seconds of any
    // real recording and ffmpeg blocks trying to write to it. At that point
    // it's fully deadlocked: it never gets back to checking stdin, so the
    // quit signal in `stop_recording` is never even seen, no matter how
    // long that waits. `.iter()`'s underlying channel is a zero-capacity
    // rendezvous (see ffmpeg_sidecar's `sync_channel(0)`), so the events
    // must be actively consumed for the life of the process, not just
    // requested once — merely calling `.iter()` and dropping the result
    // would still block the reader thread on its first send.
    if let Ok(events) = child.iter() {
        std::thread::spawn(move || {
            for _event in events {}
        });
    }

    Ok(child)
}

// avfoundation's screen-capture input takes a moment to actually start
// producing frames after ffmpeg opens it; sending the quit signal before
// that finishes appears to make ffmpeg ignore it and never exit gracefully
// (only the force-kill fallback below recovers) — every real hang observed
// so far was stopped within a couple of seconds of starting. Delaying the
// quit signal itself, rather than just relying on the kill fallback, keeps
// a quick start-then-stop from producing a forcibly-truncated file when a
// clean one was achievable just by waiting a moment longer.
const MIN_RECORDING_DURATION: std::time::Duration = std::time::Duration::from_secs(2);

pub fn stop_recording(mut child: FfmpegChild, started_at: std::time::Instant) -> Result<(), String> {
    let elapsed = started_at.elapsed();
    if elapsed < MIN_RECORDING_DURATION {
        std::thread::sleep(MIN_RECORDING_DURATION - elapsed);
    }

    // ffmpeg's documented graceful-quit signal: sending "q" over stdin
    // finalizes the output container (writes a valid MP4 moov atom) instead
    // of leaving a truncated/unplayable file, which a hard kill would risk.
    child.quit().map_err(|e| e.to_string())?;

    // This runs synchronously on the same thread that's handling the stop
    // request, so an unbounded `wait()` here means a stuck ffmpeg process
    // freezes the whole app — including Quit — until it's killed from
    // outside. Give it a few seconds to exit on its own (now that stderr is
    // actually drained — see `start_recording` — it should take well under
    // one), then force-kill rather than block forever; a truncated output
    // file is a far better failure mode than an unresponsive app.
    let wait_start = std::time::Instant::now();
    let deadline = wait_start + std::time::Duration::from_secs(5);
    loop {
        match child.as_inner_mut().try_wait().map_err(|e| e.to_string())? {
            Some(_) => {
                eprintln!("ffmpeg exited {:.1}s after the quit signal", wait_start.elapsed().as_secs_f32());
                return Ok(());
            }
            None if std::time::Instant::now() >= deadline => {
                eprintln!("ffmpeg still hadn't exited {:.1}s after the quit signal; killing it", wait_start.elapsed().as_secs_f32());
                child.kill().map_err(|e| e.to_string())?;
                child.wait().map_err(|e| e.to_string())?;
                return Ok(());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn full_screen_no_mic_has_no_crop_filter_or_audio_input() {
        let args = build_capture_args(None, false, Path::new("/tmp/out.mp4"), "1");
        let joined = args.join(" ");
        assert!(!joined.contains("crop="));
        assert!(!joined.contains("-c:a"));
        assert!(joined.contains("/tmp/out.mp4"));
    }

    #[test]
    fn area_region_adds_a_crop_filter_with_the_right_dimensions() {
        let region = CaptureRegion { x: 10, y: 20, width: 300, height: 200 };
        let args = build_capture_args(Some(region), false, Path::new("/tmp/out.mp4"), "1");
        let joined = args.join(" ");
        assert!(joined.contains("crop=300:200:10:20"));
    }

    #[test]
    fn mic_enabled_adds_an_audio_encoder() {
        let args = build_capture_args(None, true, Path::new("/tmp/out.mp4"), "1");
        let joined = args.join(" ");
        assert!(joined.contains("-c:a"));
        assert!(joined.contains("aac"));
    }

    #[test]
    fn output_path_is_always_the_last_argument() {
        let args = build_capture_args(None, false, Path::new("/tmp/out.mp4"), "1");
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
    }

    // Real stderr captured on a dev machine by running:
    //   ffmpeg -f avfoundation -list_devices true -i ""
    // on 2026-07-20 (ffmpeg 8.1, macOS). This machine has 4 cameras before
    // the screen entries, landing "Capture screen 0" at index 4 rather than
    // the commonly-assumed index 1 — the exact motivating case for this
    // discovery function.
    #[cfg(target_os = "macos")]
    const SAMPLE_AVFOUNDATION_STDERR: &str = "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers\n\
[AVFoundation indev @ 0x7f4c1c140] AVFoundation video devices:\n\
[AVFoundation indev @ 0x7f4c1c140] [0] MacBook Pro Camera\n\
[AVFoundation indev @ 0x7f4c1c140] [1] iChris Camera\n\
[AVFoundation indev @ 0x7f4c1c140] [2] MacBook Pro Desk View Camera\n\
[AVFoundation indev @ 0x7f4c1c140] [3] iChris Desk View Camera\n\
[AVFoundation indev @ 0x7f4c1c140] [4] Capture screen 0\n\
[AVFoundation indev @ 0x7f4c1c140] [5] Capture screen 1\n\
[AVFoundation indev @ 0x7f4c1c140] AVFoundation audio devices:\n\
[AVFoundation indev @ 0x7f4c1c140] [0] iChris Microphone\n\
[in#0 @ 0x7f4c1c000] Error opening input: Input/output error\n\
Error opening input file .\n\
Error opening input files: Input/output error\n";

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_screen_device_index_from_real_avfoundation_output() {
        let index = parse_screen_device_index(SAMPLE_AVFOUNDATION_STDERR, 0).unwrap();
        assert_eq!(index, "4");
    }

    // The exact case this whole target-matching scheme exists for: picking
    // the SECOND monitor's device must not just return the first "Capture
    // screen" line found.
    #[cfg(target_os = "macos")]
    #[test]
    fn parses_the_requested_screen_not_just_the_first_one() {
        let index = parse_screen_device_index(SAMPLE_AVFOUNDATION_STDERR, 1).unwrap();
        assert_eq!(index, "5");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn falls_back_to_first_capture_screen_when_target_is_missing() {
        let index = parse_screen_device_index(SAMPLE_AVFOUNDATION_STDERR, 7).unwrap();
        assert_eq!(index, "4");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn errs_when_no_capture_screen_line_is_present() {
        let text = "[AVFoundation indev @ 0x0] [0] MacBook Pro Camera\n";
        assert!(parse_screen_device_index(text, 0).is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod manual_discovery_check {
    use super::*;

    #[test]
    #[ignore]
    fn real_discovery_returns_the_actual_screen_index() {
        let index = find_macos_screen_device_index(0).unwrap();
        eprintln!("discovered index: {index}");
        assert_eq!(index, "4");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod manual_e2e_check {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    #[ignore]
    fn real_start_and_stop_produces_a_playable_mp4() {
        let output_path = std::env::temp_dir().join("snap-manual-e2e-test.mp4");
        let started_at = std::time::Instant::now();
        let child = start_recording(None, false, &output_path, 0).unwrap();
        sleep(Duration::from_secs(3));
        stop_recording(child, started_at).unwrap();

        let metadata = std::fs::metadata(&output_path).unwrap();
        eprintln!("output file: {} ({} bytes)", output_path.display(), metadata.len());
        assert!(metadata.len() > 0);
    }
}

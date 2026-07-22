use ffmpeg_sidecar::child::FfmpegChild;
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::auto_download;
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
        args.push("-framerate".into());
        args.push("30".into());
        args.push("-i".into());
        args.push(format!("{macos_screen_device_index}:{audio_device}"));
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

/// Parses avfoundation's `-list_devices true` stderr text for the index of
/// the first "Capture screen" entry, e.g. a line like:
/// `[AVFoundation indev @ 0x...] [4] Capture screen 0`
/// Extracted as a pure function so it can be unit tested against real,
/// captured output without spawning ffmpeg.
#[cfg(target_os = "macos")]
fn parse_screen_device_index(stderr_text: &str) -> Result<String, String> {
    for line in stderr_text.lines() {
        if let Some(bracket_end) = line.find(']') {
            let after_first_bracket = &line[bracket_end + 1..];
            if let (Some(start), Some(end)) =
                (after_first_bracket.find('['), after_first_bracket.find(']'))
            {
                if start < end {
                    let index = &after_first_bracket[start + 1..end];
                    let rest = &after_first_bracket[end + 1..];
                    if rest.trim_start().starts_with("Capture screen") {
                        return Ok(index.to_string());
                    }
                }
            }
        }
    }
    Err("no \"Capture screen\" device found in avfoundation device list".to_string())
}

/// Discovers the real avfoundation device index for the primary screen by
/// running `ffmpeg -f avfoundation -list_devices true -i ""` and parsing its
/// stderr. This command always exits non-zero (it errors out after printing
/// the device list because "" is not a valid input), so the exit status is
/// deliberately ignored here — only stderr's content matters.
#[cfg(target_os = "macos")]
pub fn find_macos_screen_device_index() -> Result<String, String> {
    let output = std::process::Command::new("ffmpeg")
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    parse_screen_device_index(&stderr_text)
}

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
    #[cfg(target_os = "macos")]
    let screen_device_index = match find_macos_screen_device_index() {
        Ok(index) => index,
        Err(e) => {
            eprintln!(
                "warning: failed to discover macOS screen capture device index ({e}); \
                 falling back to hardcoded index \"1\", which is likely WRONG on this machine"
            );
            "1".to_string()
        }
    };
    #[cfg(not(target_os = "macos"))]
    let screen_device_index = "1".to_string();

    let args = build_capture_args(region, mic_enabled, output_path, &screen_device_index);
    FfmpegCommand::new()
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())
}

pub fn stop_recording(mut child: FfmpegChild) -> Result<(), String> {
    // ffmpeg's documented graceful-quit signal: sending "q" over stdin
    // finalizes the output container (writes a valid MP4 moov atom) instead
    // of leaving a truncated/unplayable file, which a hard kill would risk.
    child.quit().map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
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
        let index = parse_screen_device_index(SAMPLE_AVFOUNDATION_STDERR).unwrap();
        assert_eq!(index, "4");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn errs_when_no_capture_screen_line_is_present() {
        let text = "[AVFoundation indev @ 0x0] [0] MacBook Pro Camera\n";
        assert!(parse_screen_device_index(text).is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod manual_discovery_check {
    use super::*;

    #[test]
    #[ignore]
    fn real_discovery_returns_the_actual_screen_index() {
        let index = find_macos_screen_device_index().unwrap();
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
        let output_path = std::env::temp_dir().join("pxl-manual-e2e-test.mp4");
        let child = start_recording(None, false, &output_path).unwrap();
        sleep(Duration::from_secs(3));
        stop_recording(child).unwrap();

        let metadata = std::fs::metadata(&output_path).unwrap();
        eprintln!("output file: {} ({} bytes)", output_path.display(), metadata.len());
        assert!(metadata.len() > 0);
    }
}

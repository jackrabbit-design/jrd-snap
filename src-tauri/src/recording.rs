use ffmpeg_sidecar::download::auto_download;
use ffmpeg_sidecar::paths::sidecar_dir;

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

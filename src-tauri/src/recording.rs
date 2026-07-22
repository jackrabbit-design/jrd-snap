use ffmpeg_sidecar::download::auto_download;
use ffmpeg_sidecar::paths::sidecar_dir;

pub fn ensure_ffmpeg() -> Result<(), String> {
    if let Ok(dir) = sidecar_dir() {
        eprintln!("ffmpeg sidecar install directory: {}", dir.display());
    }
    auto_download().map_err(|e| e.to_string())
}

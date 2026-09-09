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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn includes_input_and_output_paths() {
        let args = build_trim_args(
            Path::new("/tmp/in.mp4"),
            Path::new("/tmp/out.mp4"),
            1.0,
            5.0,
        );
        let joined = args.join(" ");
        assert!(joined.contains("/tmp/in.mp4"));
        assert!(joined.ends_with("/tmp/out.mp4"));
    }

    #[test]
    fn uses_ss_and_to_for_the_trim_range() {
        let args = build_trim_args(
            Path::new("/tmp/in.mp4"),
            Path::new("/tmp/out.mp4"),
            2.5,
            7.25,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-ss 2.5"));
        assert!(joined.contains("-to 7.25"));
    }

    #[test]
    fn never_uses_stream_copy() {
        // Frame-accurate trim per the global constraint: must re-encode,
        // never `-c copy` (which would snap to the nearest keyframe).
        let args = build_trim_args(
            Path::new("/tmp/in.mp4"),
            Path::new("/tmp/out.mp4"),
            0.0,
            3.0,
        );
        assert!(!args.iter().any(|a| a == "copy"));
    }
}

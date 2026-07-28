import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { resizeEditorWindow } from "../../lib/api";
import type { TrimState } from "./trimState";
import { setInPoint, setOutPoint } from "./trimState";

// Space the rest of the trimmer UI (the "Save & Upload" header row, the
// video's own padding, the dual-range slider, and the in/out/duration
// labels) takes up around the video itself — reserved so the window is
// sized to fit all of it, not just the video.
const CHROME_HEIGHT = 170;
const WINDOW_MARGIN = 80;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

// Scales the video's natural size down to fit comfortably on the current
// screen (leaving room for the reserved chrome above/below it), so the
// editor window opens showing the whole video with no scrolling — instead
// of always the fixed default window size, which could be far too small for
// a large recording or leave a lot of empty space around a small one.
function fitWindowSize(videoWidth: number, videoHeight: number): { width: number; height: number } {
  const maxWidth = window.screen.availWidth - WINDOW_MARGIN;
  const maxHeight = window.screen.availHeight - WINDOW_MARGIN - CHROME_HEIGHT;
  const scale = Math.min(1, maxWidth / videoWidth, maxHeight / videoHeight);
  return {
    width: Math.max(MIN_WIDTH, Math.round(videoWidth * scale)),
    height: Math.max(MIN_HEIGHT, Math.round(videoHeight * scale) + CHROME_HEIGHT),
  };
}

interface Props {
  videoSrc: string;
  trim: TrimState;
  onTrimChange: (t: TrimState) => void;
}

export interface VideoTrimmerHandle {
  // Seeks to `time`, waits for the frame to actually load, and returns a PNG
  // data URL of it — used to build a representative thumbnail right after a
  // successful upload (seeking to the trim's in-point, not whatever frame
  // happens to be showing, so the thumbnail reflects what was actually saved).
  captureThumbnail(time: number): Promise<string>;
}

const VideoTrimmer = forwardRef<VideoTrimmerHandle, Props>(function VideoTrimmer(
  { videoSrc, trim, onTrimChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Tracks the previous playback-boundary listener so releasing one slider
  // right after another can't leave two `timeupdate` listeners racing to
  // pause the video at two different out-points.
  const stopAtCleanupRef = useRef<(() => void) | null>(null);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    const duration = video?.duration ?? 0;
    if (duration > 0 && trim.duration === 0) {
      onTrimChange({ duration, inPoint: 0, outPoint: duration });
    }
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      const { width, height } = fitWindowSize(video.videoWidth, video.videoHeight);
      resizeEditorWindow(width, height).catch((e) => console.error("failed to resize editor window", e));
    }
  }

  function seekTo(time: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }

  // Plays from `start`, pausing exactly at `end` — used when a slider drag
  // is released, so you can preview the trimmed range immediately.
  function playRange(start: number, end: number) {
    const video = videoRef.current;
    if (!video) return;
    stopAtCleanupRef.current?.();
    video.currentTime = start;
    video.play().catch(() => {});
    const onTimeUpdate = () => {
      if (video.currentTime >= end) {
        video.pause();
        video.currentTime = end;
        cleanup();
      }
    };
    const cleanup = () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      stopAtCleanupRef.current = null;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    stopAtCleanupRef.current = cleanup;
  }

  useEffect(() => {
    return () => {
      stopAtCleanupRef.current?.();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    captureThumbnail(time: number) {
      return new Promise<string>((resolve, reject) => {
        const video = videoRef.current;
        if (!video) {
          reject(new Error("video not ready"));
          return;
        }
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("no 2d canvas context"));
            return;
          }
          ctx.drawImage(video, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = time;
      });
    },
  }));

  return (
    <div className="video-trimmer">
      <video ref={videoRef} src={videoSrc} controls onLoadedMetadata={handleLoadedMetadata} className="video-preview" disablePictureInPicture />
      <div className="dual-range">
        <div className="dual-range-track" />
        <div
          className="dual-range-fill"
          style={{
            left: `${trim.duration > 0 ? (trim.inPoint / trim.duration) * 100 : 0}%`,
            width: `${trim.duration > 0 ? ((trim.outPoint - trim.inPoint) / trim.duration) * 100 : 0}%`,
          }}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.inPoint}
          onChange={(e) => {
            const value = Number(e.target.value);
            onTrimChange(setInPoint(trim, value));
            seekTo(value);
          }}
          onMouseUp={(e) => playRange(Number(e.currentTarget.value), trim.outPoint)}
          onTouchEnd={(e) => playRange(Number(e.currentTarget.value), trim.outPoint)}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.outPoint}
          onChange={(e) => {
            const value = Number(e.target.value);
            onTrimChange(setOutPoint(trim, value));
            seekTo(value);
          }}
          onMouseUp={(e) => playRange(trim.inPoint, Number(e.currentTarget.value))}
          onTouchEnd={(e) => playRange(trim.inPoint, Number(e.currentTarget.value))}
        />
      </div>
      <div className="trim-labels">
        <span>In: {trim.inPoint.toFixed(2)}s</span>
        <span>Out: {trim.outPoint.toFixed(2)}s</span>
        <span>Duration: {(trim.outPoint - trim.inPoint).toFixed(2)}s</span>
      </div>
    </div>
  );
});

export default VideoTrimmer;

import { useEffect, useRef } from "react";
import type { TrimState } from "./trimState";
import { setInPoint, setOutPoint } from "./trimState";

interface Props {
  videoSrc: string;
  trim: TrimState;
  onTrimChange: (t: TrimState) => void;
}

export default function VideoTrimmer({ videoSrc, trim, onTrimChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Tracks the previous playback-boundary listener so releasing one slider
  // right after another can't leave two `timeupdate` listeners racing to
  // pause the video at two different out-points.
  const stopAtCleanupRef = useRef<(() => void) | null>(null);

  function handleLoadedMetadata() {
    const duration = videoRef.current?.duration ?? 0;
    if (duration > 0 && trim.duration === 0) {
      onTrimChange({ duration, inPoint: 0, outPoint: duration });
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

  return (
    <div className="video-trimmer">
      <video ref={videoRef} src={videoSrc} controls onLoadedMetadata={handleLoadedMetadata} className="video-preview" />
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
}

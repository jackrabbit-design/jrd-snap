import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { TrimState } from "./trimState";
import { setInPoint, setOutPoint } from "./trimState";

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
});

export default VideoTrimmer;

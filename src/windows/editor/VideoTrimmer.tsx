import { useRef } from "react";
import type { TrimState } from "./trimState";
import { setInPoint, setOutPoint } from "./trimState";

interface Props {
  videoSrc: string;
  trim: TrimState;
  onTrimChange: (t: TrimState) => void;
}

export default function VideoTrimmer({ videoSrc, trim, onTrimChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  function handleLoadedMetadata() {
    const duration = videoRef.current?.duration ?? 0;
    if (duration > 0 && trim.duration === 0) {
      onTrimChange({ duration, inPoint: 0, outPoint: duration });
    }
  }

  return (
    <div className="video-trimmer">
      <video ref={videoRef} src={videoSrc} controls onLoadedMetadata={handleLoadedMetadata} className="video-preview" />
      <div className="trim-scrubber">
        <input
          type="range"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.inPoint}
          onChange={(e) => onTrimChange(setInPoint(trim, Number(e.target.value)))}
        />
        <input
          type="range"
          min={0}
          max={trim.duration}
          step={0.01}
          value={trim.outPoint}
          onChange={(e) => onTrimChange(setOutPoint(trim, Number(e.target.value)))}
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

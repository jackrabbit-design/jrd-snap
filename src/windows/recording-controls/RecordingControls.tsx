import { emit } from "@tauri-apps/api/event";

export default function RecordingControls() {
  return (
    <div className="recording-controls-root">
      <button
        type="button"
        className="button button-danger"
        onClick={() => emit("trigger-stop-recording")}
      >
        Stop Recording
      </button>
    </div>
  );
}

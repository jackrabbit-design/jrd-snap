import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-600.css";
import "./styles.css";
import App from "./App";
import SettingsApp from "./windows/settings/SettingsApp";
import OverlayApp from "./windows/overlay/OverlayApp";
import EditorApp from "./windows/editor/EditorApp";
import RecordingControls from "./windows/recording-controls/RecordingControls";
import HistoryApp from "./windows/history/HistoryApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings")
  ? SettingsApp
  : hash.startsWith("#/overlay")
  ? OverlayApp
  : hash.startsWith("#/editor")
  ? EditorApp
  : hash.startsWith("#/recording-controls")
  ? RecordingControls
  : hash.startsWith("#/history")
  ? HistoryApp
  : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

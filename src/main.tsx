import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import SettingsApp from "./windows/settings/SettingsApp";
import OverlayApp from "./windows/overlay/OverlayApp";
import EditorApp from "./windows/editor/EditorApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings")
  ? SettingsApp
  : hash.startsWith("#/overlay")
  ? OverlayApp
  : hash.startsWith("#/editor")
  ? EditorApp
  : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

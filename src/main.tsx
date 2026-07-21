import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SettingsApp from "./windows/settings/SettingsApp";
import OverlayApp from "./windows/overlay/OverlayApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings")
  ? SettingsApp
  : hash.startsWith("#/overlay")
  ? OverlayApp
  : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

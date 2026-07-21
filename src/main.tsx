import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SettingsApp from "./windows/settings/SettingsApp";

const hash = window.location.hash;
const Root = hash.startsWith("#/settings") ? SettingsApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

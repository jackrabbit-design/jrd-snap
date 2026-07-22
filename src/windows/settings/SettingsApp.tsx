import HotkeyConfigForm from "./HotkeyConfigForm";
import UploadConfigForm from "./UploadConfigForm";

export default function SettingsApp() {
  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2>pxl Settings</h2>
      </div>
      <UploadConfigForm />
      <HotkeyConfigForm />
    </div>
  );
}

import HotkeyConfigForm from "./HotkeyConfigForm";
import UploadConfigForm from "./UploadConfigForm";

export default function SettingsApp() {
  return (
    <div>
      <h2 style={{ paddingLeft: 16 }}>pxl Settings</h2>
      <UploadConfigForm />
      <HotkeyConfigForm />
    </div>
  );
}

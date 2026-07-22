import { useEffect, useState } from "react";
import {
  getUploadSettings,
  saveUploadSettings,
  saveCredentials,
  hasCredentials,
  type UploadSettings,
} from "../../lib/api";

const EMPTY: UploadSettings = {
  provider: "S3",
  bucket: "",
  region: "",
  endpoint: null,
  customDomain: null,
  keyPrefix: null,
  filenamePrefix: null,
};

export default function UploadConfigForm() {
  const [settings, setSettings] = useState<UploadSettings>(EMPTY);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getUploadSettings()
      .then(setSettings)
      .catch((err) => setStatus(`Failed to load settings: ${err}`));
    hasCredentials().then(setCredsSaved);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await saveUploadSettings(settings);
      if (accessKeyId && secretAccessKey) {
        await saveCredentials(accessKeyId, secretAccessKey);
        setAccessKeyId("");
        setSecretAccessKey("");
        setCredsSaved(true);
      }
      setStatus("Saved");
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus(`Save failed: ${err}`);
    }
  }

  function field(key: keyof UploadSettings, value: string) {
    setSettings((s) => ({ ...s, [key]: value === "" ? null : value }));
  }

  return (
    <form onSubmit={handleSubmit} className="settings-section">
      <h3>Upload Destination</h3>
      <label className="field">
        Provider
        <select
          className="select"
          value={settings.provider}
          onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value as "S3" | "Spaces" }))}
        >
          <option value="S3">Amazon S3</option>
          <option value="Spaces">DigitalOcean Spaces</option>
        </select>
      </label>
      <label className="field">
        Bucket
        <input
          className="input"
          value={settings.bucket}
          onChange={(e) => setSettings((s) => ({ ...s, bucket: e.target.value }))}
        />
      </label>
      <label className="field">
        Region
        <input
          className="input"
          value={settings.region}
          onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Endpoint</span>
          <span className="field-hint">(Spaces only, e.g. nyc3.digitaloceanspaces.com)</span>
        </div>
        <input className="input" value={settings.endpoint ?? ""} onChange={(e) => field("endpoint", e.target.value)} />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Custom domain / CDN</span>
          <span className="field-hint">(optional)</span>
        </div>
        <input
          className="input"
          value={settings.customDomain ?? ""}
          onChange={(e) => field("customDomain", e.target.value)}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Key prefix / folder</span>
          <span className="field-hint">(optional)</span>
        </div>
        <input className="input" value={settings.keyPrefix ?? ""} onChange={(e) => field("keyPrefix", e.target.value)} />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Filename prefix</span>
          <span className="field-hint">(optional)</span>
        </div>
        <input
          className="input"
          value={settings.filenamePrefix ?? ""}
          onChange={(e) => field("filenamePrefix", e.target.value)}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Access Key ID</span>
          <span className="field-hint">{credsSaved && !accessKeyId ? "(saved)" : ""}</span>
        </div>
        <input className="input" value={credsSaved && !accessKeyId ? "********" : ""} onChange={(e) => setAccessKeyId(e.target.value)} />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Secret Access Key{" "}</span>
          <span className="field-hint">{credsSaved && !secretAccessKey ? "(saved)" : ""}</span>
        </div>
        <input
          className="input"
          type="text"
          value={credsSaved && !secretAccessKey ? "********" : ""}
          onChange={(e) => setSecretAccessKey(e.target.value)}
        />
      </label>
      <div className="settings-form-footer">
        <button type="submit" className="button button-primary">
          Save
        </button>
        {status && <span className="status-text">{status}</span>}
      </div>
    </form>
  );
}

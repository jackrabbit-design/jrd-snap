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
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      <label>
        Provider
        <select
          value={settings.provider}
          onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value as "S3" | "Spaces" }))}
        >
          <option value="S3">Amazon S3</option>
          <option value="Spaces">DigitalOcean Spaces</option>
        </select>
      </label>
      <label>
        Bucket
        <input value={settings.bucket} onChange={(e) => setSettings((s) => ({ ...s, bucket: e.target.value }))} />
      </label>
      <label>
        Region
        <input value={settings.region} onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))} />
      </label>
      <label>
        Endpoint (Spaces only, e.g. nyc3.digitaloceanspaces.com)
        <input value={settings.endpoint ?? ""} onChange={(e) => field("endpoint", e.target.value)} />
      </label>
      <label>
        Custom domain / CDN (optional)
        <input value={settings.customDomain ?? ""} onChange={(e) => field("customDomain", e.target.value)} />
      </label>
      <label>
        Key prefix / folder (optional)
        <input value={settings.keyPrefix ?? ""} onChange={(e) => field("keyPrefix", e.target.value)} />
      </label>
      <label>
        Filename prefix (optional)
        <input value={settings.filenamePrefix ?? ""} onChange={(e) => field("filenamePrefix", e.target.value)} />
      </label>
      <label>
        Access Key ID {credsSaved && !accessKeyId ? "(saved — leave blank to keep)" : ""}
        <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
      </label>
      <label>
        Secret Access Key {credsSaved && !secretAccessKey ? "(saved — leave blank to keep)" : ""}
        <input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
      </label>
      <button type="submit">Save</button>
      {status && <span>{status}</span>}
    </form>
  );
}

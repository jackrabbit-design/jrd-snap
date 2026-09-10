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

// The UI shows one "Folder/Prefix" field, but the backend still tracks the
// upload folder (keyPrefix) and the filename prefix (filenamePrefix)
// separately — build_object_key() joins them as "{keyPrefix}/{filename}"
// and generate_filename() glues filenamePrefix onto the filename itself.
// The last "/" in the typed value is the split point: "team/chris" means
// folder "team" + filename prefix "chris" (-> "team/chris-abc123.png");
// with no "/" at all, the whole value is just the folder.
function parseFolderPrefix(value: string): Pick<UploadSettings, "keyPrefix" | "filenamePrefix"> {
  const slash = value.lastIndexOf("/");
  if (slash === -1) {
    return { keyPrefix: value || null, filenamePrefix: null };
  }
  return {
    keyPrefix: value.slice(0, slash) || null,
    filenamePrefix: value.slice(slash + 1) || null,
  };
}

function combineFolderPrefix(keyPrefix: string | null, filenamePrefix: string | null): string {
  if (keyPrefix && filenamePrefix) return `${keyPrefix}/${filenamePrefix}`;
  return keyPrefix || filenamePrefix || "";
}

export default function UploadConfigForm() {
  const [settings, setSettings] = useState<UploadSettings>(EMPTY);
  // Kept as its own raw string rather than derived from settings on every
  // render — re-deriving via combineFolderPrefix(settings.keyPrefix, ...)
  // each render would eat a trailing "/" the moment you type it (an empty
  // filenamePrefix collapses back out of the combined string), making it
  // impossible to ever type past the slash.
  const [folderPrefix, setFolderPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getUploadSettings()
      .then((loaded) => {
        setSettings(loaded);
        setFolderPrefix(combineFolderPrefix(loaded.keyPrefix, loaded.filenamePrefix));
      })
      .catch((err) => setStatus(`Failed to load settings: ${err}`));
    hasCredentials().then(setCredsSaved);
  }, []);

  function handleFolderPrefixChange(value: string) {
    setFolderPrefix(value);
    setSettings((s) => ({ ...s, ...parseFolderPrefix(value) }));
  }

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
      <div className="settings-header">
        <h2>Upload Destination</h2>
      </div>
      <label className="field">
          <div className="label-flex">
            <span>Provider</span>
          </div>
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
        <div className="label-flex">
          <span>Bucket</span>
        </div>
        <input
          className="input"
          value={settings.bucket}
          onChange={(e) => setSettings((s) => ({ ...s, bucket: e.target.value }))}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Region</span>
        </div>
        <input
          className="input"
          value={settings.region}
          onChange={(e) => setSettings((s) => ({ ...s, region: e.target.value }))}
        />
      </label>
      {settings.provider === "Spaces" && (
        <label className="field">
          <div className="label-flex">
            <span>Endpoint</span>
            <span className="field-hint">e.g. nyc3.digitaloceanspaces.com</span>
          </div>
          <input className="input" value={settings.endpoint ?? ""} onChange={(e) => field("endpoint", e.target.value)} />
        </label>
      )}
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
          <span>Folder/Prefix</span>
          <span className="field-hint">(optional) e.g. <code style={{ border: "1px solid gray", borderRadius: "2px", padding: '3px 2px 1px' }}>CK/</code></span>
        </div>
        <input
          className="input"
          value={folderPrefix}
          onChange={(e) => handleFolderPrefixChange(e.target.value)}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Access Key ID</span>
          <span className="field-hint">{credsSaved && !accessKeyId ? "(saved)" : ""}</span>
        </div>
        <input
          className="input"
          type="password"
          placeholder={credsSaved ? "•••••••• (saved)" : ""}
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
        />
      </label>
      <label className="field">
        <div className="label-flex">
          <span>Secret Access Key{" "}</span>
          <span className="field-hint">{credsSaved && !secretAccessKey ? "(saved)" : ""}</span>
        </div>
        <input
          className="input"
          type="password"
          placeholder={credsSaved ? "•••••••• (saved)" : ""}
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
        />
      </label>
      <div className=" field">
        <div className="label-flex">&nbsp;</div>
        <div className="settings-form-footer">
          <button type="submit" className="button button-primary">
            Save Connection
          </button>
        </div>
        {status && <span className="status-text">{status}</span>}
      </div>
    </form>
  );
}

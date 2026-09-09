#!/usr/bin/env node
// Bumps the version in lockstep across the three files that must agree:
// package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml.
// Usage: node scripts/bump-version.mjs <version> [--draft-release]
//
// --draft-release additionally commits the bump, tags it, and pushes both —
// the tag push is what triggers .github/workflows/release.yml. Tags in this
// repo are bare semver (e.g. "0.4.1", not "v0.4.1").
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const version = args[0];
const draftRelease = args.includes("--draft-release");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/bump-version.mjs <x.y.z> [--draft-release]");
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function bumpJson(file) {
  const p = path.join(root, file);
  const contents = fs.readFileSync(p, "utf8");
  const json = JSON.parse(contents);
  json.version = version;
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
}

function bumpCargoToml(file) {
  const p = path.join(root, file);
  const contents = fs.readFileSync(p, "utf8");
  const updated = contents.replace(
    /^version = "[^"]+"/m,
    `version = "${version}"`
  );
  fs.writeFileSync(p, updated);
}

bumpJson("package.json");
bumpJson("src-tauri/tauri.conf.json");
bumpCargoToml("src-tauri/Cargo.toml");

console.log(`Bumped to ${version} in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml`);

if (draftRelease) {
  const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"];
  const git = (gitArgs) => execFileSync("git", gitArgs, { cwd: root, stdio: "inherit" });

  git(["add", ...files]);
  git(["commit", "-m", version]);
  git(["tag", version]);
  git(["push", "origin", "HEAD", version]);

  console.log(`Committed, tagged, and pushed ${version} — release workflow should be running now.`);
}

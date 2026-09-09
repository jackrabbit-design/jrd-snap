#!/usr/bin/env bash
# Assembles the latest.json manifest the Tauri updater polls (see
# tauri.conf.json's plugins.updater.endpoints) from the .sig files produced
# by `tauri build` for both macOS targets. Doesn't touch GitHub itself —
# just prints the file to upload alongside the release assets it points at.
#
# Usage: src-tauri/scripts/generate-latest-json.sh <version> <repo> [notes]
#   version  e.g. 0.3.1 (no "v" prefix, matching this repo's existing tags)
#   repo     e.g. jackrabbit-design/jrd-snap
#   notes    optional release notes text
#
# Expects both targets already built+signed, e.g.:
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/snap.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
#   npm run tauri build -- --target aarch64-apple-darwin
#   npm run tauri build -- --target x86_64-apple-darwin
set -euo pipefail

VERSION="${1:?usage: $0 <version> <repo> [notes]}"
REPO="${2:?usage: $0 <version> <repo> [notes]}"
NOTES="${3:-Snap $VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$SCRIPT_DIR/../target"

AARCH64_SIG="$TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/Snap.app.tar.gz.sig"
X86_64_SIG="$TARGET_DIR/x86_64-apple-darwin/release/bundle/macos/Snap.app.tar.gz.sig"

for f in "$AARCH64_SIG" "$X86_64_SIG"; do
  [ -f "$f" ] || { echo "error: missing $f — build that target first" >&2; exit 1; }
done

PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

cat <<EOF
{
  "version": "$VERSION",
  "notes": "$NOTES",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$(cat "$AARCH64_SIG")",
      "url": "$BASE_URL/Snap_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "$(cat "$X86_64_SIG")",
      "url": "$BASE_URL/Snap_x86_64.app.tar.gz"
    }
  }
}
EOF

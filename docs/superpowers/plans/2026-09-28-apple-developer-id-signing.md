# Apple Developer ID Signing + Notarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Snap's self-signed macOS code-signing identity with a real Apple Developer ID Application certificate, and validate a full local sign → notarize → staple chain, with notarization gated behind three env vars so routine local builds stay fast.

**Architecture:** Almost all of this is configuration and process, not application code — one line changes in `tauri.conf.json`, real `tauri build` invocations, and Apple's own `security`/`xcrun notarytool`/`spctl`/`stapler` CLIs as the verification tooling. Several steps require the user's own interactive actions (Keychain Access GUI, developer.apple.com, appleid.apple.com) that cannot be scripted — those are called out explicitly in each task.

**Tech Stack:** Tauri v2 (`tauri build`), macOS `security`/`codesign`/`xcrun notarytool`/`stapler`/`spctl` command-line tools, Apple Developer Program (Developer ID Application certificate, App Store Connect app-specific password).

**Spec:** `docs/superpowers/specs/2026-09-28-apple-developer-id-signing-design.md`

## Global Constraints

- The new Developer ID Application identity fully replaces the self-signed "Snap Local Code Signing" identity in `tauri.conf.json` — no fallback, no dual-identity config.
- Notarization must only trigger via the `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` env vars being present at build time — never hardcoded into any committed file.
- `.github/workflows/release.yml` is explicitly out of scope for this plan.
- `src-tauri/Entitlements.plist` is created only if/when a specific feature demonstrably breaks under the hardened runtime — no speculative entries.
- Both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets must be validated, matching what the existing release pipeline builds.

## Review Focus

- Certificate installed into the wrong keychain (e.g. System instead of login) — `security find-identity -v -p codesigning` silently not finding it, read as "no cert exists" instead of "wrong keychain."
- App-specific password rejected or Apple ID needs 2FA re-confirmation — notarization submission fails with an auth error that must be read from `xcrun notarytool log`, not assumed from exit status alone.
- Notarization succeeds but stapling fails (transient network issue, or run before the ticket propagated) — must be confirmed via `xcrun stapler validate`, not inferred from notarization success.
- A hardened-runtime restriction breaks a feature silently (mic capture producing a track with no audio, AppleScript automation quietly no-op'ing) rather than crashing — must be caught by actually exercising each feature, not just launching the app.
- A typo'd identity string in `tauri.conf.json` matching an unintended keychain entry (partial string match) — must be confirmed by reading the identity actually embedded in the built `.app` via `codesign -dv`, not assumed from the config value.

---

## Task 1: Generate and install the Developer ID Application certificate

**Files:** None (Keychain Access + developer.apple.com, both outside the repo).

**Interfaces:**
- Produces: an installed certificate + private key pair in the user's login keychain, and its exact `security find-identity` identity string (format `"Developer ID Application: <Name> (<TEAMID>)"`) and Team ID, both needed verbatim by Task 2.

- [ ] **Step 1: User generates a certificate signing request (CSR)**

Hand this to the user — it's a GUI flow Claude cannot perform:

1. Open **Keychain Access**.
2. Menu bar → **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority...**
3. Fill in their email and name, select **"Saved to disk"**, leave CA email blank, save the `.certSigningRequest` file somewhere findable (e.g. Desktop).

This generates a private key in the login keychain and a CSR file — the private key never leaves their machine.

- [ ] **Step 2: User creates the certificate on developer.apple.com**

1. Go to developer.apple.com → Account → Certificates, Identifiers & Profiles → Certificates → **+**.
2. Select **"Developer ID Application"** (under Software category; requires the paid Program membership).
3. Upload the `.certSigningRequest` from Step 1.
4. Download the resulting `.cer` file.

- [ ] **Step 3: User installs the certificate**

Double-click the downloaded `.cer` file — this installs it into the login keychain, pairing it with the private key from Step 1.

- [ ] **Step 4: Verify the identity is usable**

Claude runs this once the user confirms Steps 1-3 are done:

```bash
security find-identity -v -p codesigning
```

Expected: a line reading `1) <SHA1HASH> "Developer ID Application: <Name> (<TEAMID>)"` (plus possibly the old self-signed identity — that's expected until Task 2 removes it from config). If it's missing entirely, the cert likely landed in the wrong keychain — ask the user to confirm it via Keychain Access that it shows under the **login** keychain, **My Certificates** category, with a private key disclosure triangle (proof the key is paired).

- [ ] **Step 5: Record the exact identity string and Team ID**

Copy the full identity string between the quotes (e.g. `"Developer ID Application: Chris Kirk (AB12CD34EF)"`) and the 10-character Team ID inside the parentheses — Task 2 needs the former verbatim, Task 4 needs the latter verbatim.

---

## Task 2: Point Tauri at the new identity

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the identity string recorded in Task 1, Step 5.
- Produces: `bundle.macOS.signingIdentity` set to the real identity — every subsequent `tauri build` in this plan signs with it.

- [ ] **Step 1: Replace the signing identity**

In `src-tauri/tauri.conf.json`, find:

```json
"macOS": {
  "signingIdentity": "Snap Local Code Signing"
},
```

Replace with the real identity string from Task 1 (exact value depends on the user's name/Team ID captured in Task 1, Step 5):

```json
"macOS": {
  "signingIdentity": "Developer ID Application: <Name> (<TEAMID>)"
},
```

- [ ] **Step 2: Confirm the file is still valid JSON**

```bash
cd src-tauri && node -e "JSON.parse(require('fs').readFileSync('tauri.conf.json', 'utf8')); console.log('valid JSON')"
```

Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "Switch to real Apple Developer ID signing identity"
```

---

## Task 3: Local signed (unnotarized) build for both targets

**Files:** None (build output only, not committed).

**Interfaces:**
- Consumes: `signingIdentity` from Task 2.
- Produces: signed `.app` bundles at `src-tauri/target/<triple>/release/bundle/macos/Snap.app`, confirmed correctly signed — Task 4 notarizes these same builds.

- [ ] **Step 1: Build aarch64**

```bash
cd src-tauri && npm run tauri build -- --target aarch64-apple-darwin
```

Expected: build succeeds, ending with a `Finished` bundling message and no codesign errors in the output.

- [ ] **Step 2: Build x86_64**

```bash
cd src-tauri && npm run tauri build -- --target x86_64-apple-darwin
```

Expected: same as Step 1, for the `x86_64-apple-darwin` target directory.

- [ ] **Step 3: Verify the actual embedded signing identity on both builds**

This is the Review Focus item about a typo'd identity matching the wrong keychain entry — confirm what's actually embedded, not just that the build didn't error:

```bash
codesign -dv --verbose=4 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app 2>&1 | grep "Authority="
codesign -dv --verbose=4 src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Snap.app 2>&1 | grep "Authority="
```

Expected: both print `Authority=Developer ID Application: <Name> (<TEAMID>)` matching Task 1's recorded identity exactly — not the old self-signed name, not a different keychain entry.

- [ ] **Step 4: Verify hardened runtime is enabled**

Notarization requires this; Tauri enables it automatically for a Developer ID identity, but confirm rather than assume:

```bash
codesign -dv --verbose=4 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app 2>&1 | grep "flags="
```

Expected: the flags line includes `runtime` (e.g. `flags=0x10000(runtime)`).

---

## Task 4: One real notarization test build

**Files:** None (env vars only, never committed).

**Interfaces:**
- Consumes: signed builds from Task 3, Team ID from Task 1.
- Produces: a notarized, stapled `.app` for `aarch64-apple-darwin`, confirmed via `spctl` — proof the full chain works.

- [ ] **Step 1: User generates an app-specific password**

Hand this to the user:

1. Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate a new one, label it something like "Snap notarization".
2. Copy the generated password (format `xxxx-xxxx-xxxx-xxxx`) — Apple shows it only once.

- [ ] **Step 2: Export the three notarization env vars**

The user runs this in their own terminal (Claude should not handle the raw password directly — ask the user to export it themselves and confirm it's set, rather than pasting it into chat):

```bash
export APPLE_ID="<their Apple ID email>"
export APPLE_PASSWORD="<the app-specific password from Step 1>"
export APPLE_TEAM_ID="<Team ID from Task 1>"
```

- [ ] **Step 3: Rebuild aarch64 with notarization env vars present**

Claude runs this in the same shell session where the user exported the env vars (or asks the user to run it, if Claude's Bash tool is in a different shell context — confirm the three vars are visible first with `echo $APPLE_ID` before proceeding):

```bash
cd src-tauri && npm run tauri build -- --target aarch64-apple-darwin
```

Expected: build output includes notarization submission log lines (Tauri shells out to `xcrun notarytool submit ... --wait`), ending in a success status. This step makes a real network call to Apple and can take several minutes — do not treat a long-running build as a hang.

- [ ] **Step 4: If notarization fails, read the actual rejection reason**

Don't stop at a failed exit code — pull the real log, since notarization failures are almost always specific (invalid signature, missing entitlement, disallowed API) and printed only in the detailed log, not the summary:

```bash
xcrun notarytool log <submission-id-from-step-3-output> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

Fix whatever the log reports and retry Step 3.

- [ ] **Step 5: Verify stapling actually attached**

Notarization succeeding doesn't guarantee the staple step (which Tauri also runs automatically) actually completed — confirm explicitly:

```bash
xcrun stapler validate src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app
```

Expected: `The validate action worked!`

- [ ] **Step 6: Verify Gatekeeper accepts it with no warnings**

```bash
spctl --assess --type execute --verbose src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app
```

Expected: `accepted` with `source=Notarized Developer ID` — not `source=Unnotarized Developer ID` and not a rejection.

---

## Task 5: Re-verify every hardened-runtime-sensitive feature

**Files:**
- Create (only if needed): `src-tauri/Entitlements.plist`
- Modify (only if the file above is created): `src-tauri/tauri.conf.json` (add `"entitlements"` path under `bundle.macOS`)

**Interfaces:**
- Consumes: the notarized `.app` from Task 4.
- Produces: a confirmed-working notarized build, with `Entitlements.plist` containing only entries proven necessary by an actual observed failure.

- [ ] **Step 1: Launch the notarized build**

```bash
open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app
```

- [ ] **Step 2: User exercises area/full-screen capture**

Hand this to the user: trigger both a full-screen capture and an area-drag capture from the tray menu, confirm the editor opens with the image and no permission prompt loop or silent failure. Report back pass/fail.

- [ ] **Step 3: User exercises video recording with microphone**

Hand this to the user: start a region recording with the microphone checkbox enabled, record a few seconds narrating something audible, stop, and play back the saved video with sound on — confirm audio is actually present (a hardened-runtime mic restriction would produce a silent track, not a crash). Report back pass/fail.

- [ ] **Step 4: User exercises AppleScript/osakit-driven behavior**

Hand this to the user: identify what `osakit` is used for in this app (check `grep -rn "osakit" src-tauri/src` if unclear) and exercise that specific behavior. Report back pass/fail.

- [ ] **Step 5: User exercises tray/menubar-only mode**

Hand this to the user: confirm no Dock icon appears, the tray icon and its menu work, and the drop-upload window (if applicable) still shows/hides correctly. Report back pass/fail.

- [ ] **Step 6: For any failure, diagnose and add the specific entitlement**

If everything in Steps 2-5 passed, skip to Task 6 — no entitlements file needed.

If something failed, check Console.app (filtered to "Snap") for a `sandboxd` or TCC denial matching the failure, identify the specific entitlement key it names (e.g. `com.apple.security.device.audio-input` for mic, `com.apple.security.automation.apple-events` for AppleScript, `com.apple.security.cs.disable-library-validation` if a bundled dylib/sidecar binary is the issue), and create/update `src-tauri/Entitlements.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <false/>
</dict>
</plist>
```

(Replace the placeholder key above with whichever specific entitlement the observed failure actually points to — do not add entries speculatively.)

Then wire it into `tauri.conf.json`:

```json
"macOS": {
  "signingIdentity": "Developer ID Application: <Name> (<TEAMID>)",
  "entitlements": "Entitlements.plist"
},
```

- [ ] **Step 7: Rebuild and re-notarize after any entitlements change**

Repeat Task 3 (Steps 1-4) and Task 4 (Steps 3-6) after any `Entitlements.plist` change — a new entitlement changes the signature, so notarization must run again, not just a local re-sign.

- [ ] **Step 8: Repeat Steps 2-7 until every feature passes**

- [ ] **Step 9: Commit any entitlements changes**

```bash
git add src-tauri/Entitlements.plist src-tauri/tauri.conf.json
git commit -m "Add hardened-runtime entitlements required for <feature>"
```

(Only run this if Task 5 actually created/modified files — skip if Step 6 was never triggered.)

---

## Task 6: Repeat validation for x86_64

**Files:** None.

**Interfaces:**
- Consumes: final `tauri.conf.json` state (including any entitlements) from Task 5.
- Produces: confirmation that the second architecture is equally notarized and functional — the plan's stated Global Constraint that both targets must be validated.

- [ ] **Step 1: Rebuild x86_64 with notarization env vars still exported**

```bash
cd src-tauri && npm run tauri build -- --target x86_64-apple-darwin
```

- [ ] **Step 2: Verify stapling and Gatekeeper acceptance**

```bash
xcrun stapler validate src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Snap.app
spctl --assess --type execute --verbose src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Snap.app
```

Expected: same as Task 4 Steps 5-6 — `The validate action worked!` and `accepted` / `source=Notarized Developer ID`.

- [ ] **Step 3: Confirm this build embeds the same entitlements as aarch64**

```bash
codesign -d --entitlements - src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Snap.app
codesign -d --entitlements - src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Snap.app
```

Expected: identical entitlement sets between the two (both empty, if Task 5 never needed any; otherwise matching).

- [ ] **Step 4: Final status report**

Summarize for the user: both architectures signed with the real Developer ID identity, notarized, stapled, Gatekeeper-accepted, every hardened-runtime-sensitive feature confirmed working. Remind them the GitHub Actions release workflow still needs updating (out of scope here) before the next real release, and that existing installed users will likely need to re-approve Screen Recording once after upgrading to a build with the new identity.

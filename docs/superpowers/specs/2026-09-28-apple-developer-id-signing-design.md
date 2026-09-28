# Apple Developer ID signing + notarization (local setup)

## Context

Snap currently ships signed with a self-signed "Snap Local Code Signing"
identity (`src-tauri/tauri.conf.json`'s `bundle.macOS.signingIdentity`).
That identity was created purely to give TCC (the Screen Recording
permission prompt) a stable code identity across rebuilds — without it,
macOS treats every rebuild as a "new" app and re-prompts for permission.
It was never intended as real distribution signing: self-signed builds
still trigger Gatekeeper's "unidentified developer" warning for anyone who
downloads a release DMG.

The user now has a paid Apple Developer Program account and wants Snap
properly signed with a real Developer ID Application certificate and
notarized, so Gatekeeper stops warning users on install.

## Goal

Get local `tauri build` producing a properly signed, notarizable app,
validated end-to-end on the user's machine — cert creation through actual
notarization — before touching the GitHub Actions release pipeline
(`.github/workflows/release.yml`), which is deliberately **out of scope**
for this spec and will be its own follow-up once local signing is
confirmed working.

## Approach

### 1. Certificate creation

Walk through creating a "Developer ID Application" certificate:

1. Keychain Access → Certificate Assistant → Request a Certificate from a
   Certificate Authority (generates a CSR + private key, private key
   stays local).
2. Upload the CSR at developer.apple.com → Certificates → new
   certificate → "Developer ID Application".
3. Download the issued `.cer`, double-click to install into the login
   keychain (pairs with the private key from step 1).
4. Confirm it's usable via `security find-identity -v -p codesigning`,
   and note the exact identity string (e.g. `"Developer ID Application:
   Chris Kirk (TEAMID)"`) and the Team ID for later use.

### 2. One signing identity, notarization gated by env vars

Tauri v2's bundler signs (`codesign`) whenever `bundle.macOS.signingIdentity`
is set, independent of notarization. Notarization is a *separate* step
that only triggers when `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
password), and `APPLE_TEAM_ID` are all present in the environment at
build time.

This means we can:

- Replace `tauri.conf.json`'s `signingIdentity` with the new Developer ID
  Application identity, retiring "Snap Local Code Signing" entirely — one
  identity for every build, dev or release.
- Leave the three notarization env vars unset for routine local builds —
  they stay signed (fast, no network round-trip) but unnotarized.
- Export `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` only when
  deliberately testing or cutting a real release, triggering the full
  sign → notarize → staple chain on demand.

The app-specific password is generated once at appleid.apple.com (Sign-In
and Security → App-Specific Passwords) and used only locally for this
testing phase — it does not need to be committed or stored anywhere in
the repo.

### 3. Hardened runtime risk

Notarization requires the hardened runtime, which can restrict
capabilities this app actually uses: screen recording, microphone
capture, AppleScript automation via `osakit`, and `macOSPrivateApi: true`.
Rather than pre-guess every entitlement, the plan is empirical:

1. Produce one notarized local build.
2. Exercise each affected feature by hand (area/full screenshot capture,
   video recording with mic enabled, AppleScript-driven window behavior,
   the tray/menubar-only window mode).
3. Add specific entries to a new `src-tauri/Entitlements.plist` only for
   whatever actually breaks, re-test, repeat.

No entitlements file exists yet — one gets created only if/when something
demonstrably needs it, keeping the entitlement set minimal rather than
speculative.

### 4. Validation

"Done" for this spec means: a local `tauri build` (both targets:
`aarch64-apple-darwin` and `x86_64-apple-darwin`, matching what the
existing release pipeline builds) produces app bundles that are (a)
signed with the real Developer ID identity, (b) successfully submitted to
and accepted by Apple's notary service, (c) stapled, and (d) pass a
`spctl --assess` Gatekeeper check with no warnings — with every capture/
recording/tray feature confirmed still working under the hardened
runtime.

## Explicitly out of scope

- Updating `.github/workflows/release.yml` (new secrets, new build/
  notarize/staple steps for CI) — separate follow-up spec once local
  signing is validated.
- Communicating the one-time Screen Recording re-approval to existing
  users (release notes, in-app messaging) — a real consequence of
  changing code identity, but not a code change this spec covers.
- An App Store Connect API key as an alternative notarization credential
  — explicitly deferred in favor of the app-specific password per the
  user's choice; can be revisited later if the password path proves
  troublesome for CI specifically.

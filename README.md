# Empanadas.io Desktop App
This is a Electron wrapped native application for Desktop that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

Windows (x64) ships today. macOS (Apple Silicon and Intel) builds with
`npm run build:mac`, but is not released yet — see **macOS status** below.

## macOS status

The app runs on macOS: it has an application menu (so Cmd+Q/W/C/V work), the
window keeps its traffic lights via `titleBarStyle: 'hiddenInset'`, clicking the
dock icon reopens a closed window, and `empanadas-io://` links are delivered
through `open-url`.

Two things are still missing before a macOS release:

- **Signing and notarization.** `build.mac` is configured for the hardened
  runtime with `build/entitlements.mac.plist`, but producing a distributable
  build needs a Developer ID Application certificate, an Apple Developer
  Program membership, and a macOS runner. `npm run build:mac` on any other
  platform silently skips signing, and an unsigned build is Gatekeeper-blocked
  on other people's Macs.
- **Updates.** `updater.js` is Windows-only — it looks for a `.exe` asset and
  verifies it with Authenticode. On macOS it fails closed (refuses to install)
  rather than installing something unverified. A macOS path needs a `zip`
  asset, `codesign`/`spctl` verification with a pinned Team ID, and an
  app-bundle swap instead of an installer launch.

`icon.png` is 570×570, so the generated `.icns` is upscaled at 512 and 1024.
Replacing it with a 1024×1024 source would sharpen the dock icon.

## CI

`.github/workflows/node.js.yml` validates every push and PR (`npm test` —
syntax checks on the main-process files plus packaging-config assertions), then
builds unsigned Windows and macOS artifacts and attaches them to the run.
Download them from the run's **Artifacts** section; they are kept for 14 days.

CI deliberately does not publish. It passes `--publish never`, because
electron-builder otherwise detects CI and implicitly tries to upload to the
GitHub release — which both fails the build when no token is set and, when a
token *is* set, will attempt to add assets to an existing release. Releases
stay a manual, signed step; see **Cutting a release** below.

CI artifacts are unsigned, so the updater will refuse to install them. They are
for checking that a change packages and launches, not for distribution.

## Auto updates

`updater.js` checks the GitHub Releases API on startup (and every 6 hours),
compares the newest published tag against the running version, downloads the
installer asset, verifies it, and only then offers to install it.

Verification is fail-closed — anything that doesn't check out is deleted and
the update is abandoned:

| Check | Source | Config |
| --- | --- | --- |
| SHA-256 | the release asset's `digest` field from the GitHub API | `requireHash` |
| SHA-512 | `latest.yml`, if that asset was uploaded | `requireHash` |
| Authenticode | `Get-AuthenticodeSignature` on the downloaded installer | `requireSignature`, `expectedPublisher`, `expectedThumbprint` |

The hashes catch corrupted or truncated downloads. The Authenticode signature
is the actual trust anchor: it's the only check that still holds if the GitHub
account or a release asset is tampered with, since it's rooted in the
code-signing certificate rather than in anything GitHub serves.

Settings all live in the `CONFIG` block at the top of `updater.js`. Updates can
be disabled at runtime with `--no-update` or `EMPANADAS_NO_UPDATE=1`.

### Cutting a release

The updater reads the GitHub API directly, so it only needs the installer
attached to a **published** (not draft) release whose tag matches the version
in `package.json`:

1. Bump `version` in `package.json`.
2. `npm run build` — produces `dist/empanadas.io-Setup-<version>.exe`.
3. Sign the installer (the updater refuses anything without a valid
   Authenticode signature naming `Empanadas.io`).
4. Publish a release tagged `v<version>` with the `.exe` attached.

Upload the `.exe` with **no spaces in the filename**. GitHub rewrites spaces in
asset names to dots, which is what breaks tools that expect an exact filename.
The `artifactName` setting in `package.json` now produces dash-separated names
so this can't happen.

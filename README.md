# Empanadas.io Windows (x64) App
This is a Electron wrapped native application for Desktop Windows that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

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

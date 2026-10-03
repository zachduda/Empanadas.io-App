# Releasing

Why the checks exist and what they protect is in [SECURITY.md](../SECURITY.md).
This is the procedure.

## Cutting a release

The updater reads the GitHub API directly, so it only needs the assets attached
to a **published** (not draft) release whose tag matches the version in
`package.json`.

1. Bump `version` in `package.json`.
2. `npm run build` — produces `dist/empanadas.io-Setup-<version>.exe`.
3. Sign the installer. The updater refuses anything without a valid Authenticode
   signature naming `Empanadas.io`, or matching a pinned thumbprint if one is
   set.
4. `gpg --detach-sign dist/empanadas.io-Setup-<version>.exe`
5. Publish a release tagged `v<version>` with **both** the `.exe` and the
   `.exe.sig` attached. Once `release-keys.json` exists, a release without the
   `.sig` will not install.

Upload with **no spaces in the filename**. GitHub rewrites spaces in asset names
to dots, which breaks anything expecting an exact filename. The `artifactName`
setting in `package.json` produces dash-separated names so this cannot happen;
`npm test` checks it.

## Release signing

`updater.js` verifies a detached OpenPGP signature over the downloaded asset
against keys pinned in `release-keys.json`. That file ships inside the app, so
nobody can turn the check off remotely — removing it would break the app's own
code signature.

**The check is skipped until `release-keys.json` exists.** Without it the
updater logs a warning and carries on, and `npm test` prints a reminder. To
enable it:

```sh
gpg --export --armor <your release key id> > key.asc
node scripts/import-release-key.js key.asc     # writes release-keys.json
rm key.asc
```

Check the printed fingerprint against `gpg --fingerprint` and commit
`release-keys.json`. Only the public half is ever read or written.

Supported: RSA keys with SHA-256/384/512, binary `.sig` or armored `.asc`.
SHA-1 signatures are rejected.

> The 1.10.8 release was already signed this way — `dist/*.exe.sig` is a real
> detached signature from key
> `3BFF B247 6A7A 02BE 2600 948B 1388 2805 6A80 F9DE`. The updater had no way to
> check it until now. If that is still the release key, importing it is the only
> step left.

## Pinning the signing certificate

By default the Windows check accepts any Authenticode certificate whose subject
contains `Empanadas.io`, which is weaker than it looks: a certificate issued to
someone else with that string in its subject would pass. Pinning fixes that.

```sh
node scripts/thumbprint.js dist/empanadas.io-Setup-<version>.exe   # Windows
node scripts/thumbprint.js "dist/mac-arm64/Empanadas.io.app"       # macOS
```

It prints the values to paste into `CONFIG` (`pinnedThumbprints` on Windows,
`macTeamId` on macOS). Run it against an artifact **you** just signed — reading
the value off a download would pin whatever signed the download, which is the
thing the pin exists to catch.

During a certificate rollover keep both the old and the new thumbprint in the
list, so clients still on the previous release accept either.

## macOS

The app runs on macOS: it has an application menu (so Cmd+Q/W/C/V work), the
window keeps its traffic lights via `titleBarStyle: 'hiddenInset'`, clicking the
dock icon reopens a closed window, and `empanadas-io://` links arrive through
`open-url`.

Updates have a macOS path: the updater picks the
`empanadas.io-<version>-mac-<arch>.zip` asset matching `process.arch`, unpacks
it with `ditto`, verifies it with `codesign --verify --deep --strict` plus a
pinned Team ID and a Gatekeeper assessment, then hands off to a script that
waits for the app to exit, swaps the bundle and reopens it. The swap moves the
old bundle aside rather than deleting it, so a failure part-way through leaves a
working app rather than an empty `/Applications` entry.

Still missing before a macOS release:

- **Signing and notarization.** `build.mac` is configured for the hardened
  runtime with `build/entitlements.mac.plist`, but a distributable build needs a
  Developer ID Application certificate, an Apple Developer Program membership,
  and a macOS runner. `npm run build:mac` on any other platform silently skips
  signing, and an unsigned build is Gatekeeper-blocked on other people's Macs.
- **A pinned Team ID.** Until `CONFIG.macTeamId` is set, the macOS updater
  declines up front and points at the download page, because it cannot tell
  whose signature it would be looking at.
- **One run on a real Mac.** See *Untested paths* in [SECURITY.md](../SECURITY.md).

`icon.png` is 570×570, so the generated `.icns` is upscaled at 512 and 1024.
Replacing it with a 1024×1024 source would sharpen the dock icon.

## Tests

`npm test` runs syntax checks on the main-process files, assertions that the
hardening settings in `main.js` and `updater.js` are still in place, packaging
config checks, and the `lib/pgp.js` and `updater.js` suites. It also prints a
note for each trust step not yet completed (no release key, no thumbprint, no
Team ID).

The browser tests in `test/splash.test.js` need a Chromium and skip themselves
without one. To run them locally:

```sh
npm install --no-save playwright-core
npx playwright install chromium
npm test
```

CI installs that browser, so those assertions run on every push and PR.

## CI

`.github/workflows/node.js.yml` validates every push and PR, then builds
unsigned Windows and macOS artifacts and attaches them to the run. Download them
from the run's **Artifacts** section; they are kept for 14 days.

CI deliberately does not publish. It passes `--publish never`, because
electron-builder otherwise detects CI and implicitly tries to upload to the
GitHub release — which fails the build when no token is set and, when a token
*is* set, will attempt to add assets to an existing release. Releases stay a
manual, signed step.

CI artifacts are unsigned, so the updater will refuse to install them. They are
for checking that a change packages and launches, not for distribution.

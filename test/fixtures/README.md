# Signature test vectors

Generated once with GnuPG 2.4 so `npm test` can check `lib/pgp.js` against real
OpenPGP output on a machine with no `gpg` installed. Regenerating them is not
part of any workflow — they are fixed inputs with known answers.

| File | What it is |
| --- | --- |
| `payload.bin` | 64 bytes of text standing in for an installer |
| `payload.sig` | detached RSA/SHA-256 signature over it, binary, old-format packet header (what `gpg --detach-sign` emits, and what the real release `.sig` files are) |
| `payload-sha512.asc` | the same signature ASCII-armored and over SHA-512, to cover both the armor reader and a second hash |
| `payload-wrong-key.sig` | a *valid* signature over the same payload from a different key, so "verifies cryptographically but is not our signer" is tested separately from "does not verify" |
| `signer.pub.asc` | the signer's public key, armored |
| `signer.pub.gpg` | the same key, binary — the two exports use different packet header formats, and both have to parse |

These keys are throwaway test keys generated in a scratch keyring. They are
**not** the release signing key, have never signed a release, and the private
halves were discarded. Nothing here is a secret and nothing here is trusted at
runtime: the app pins its real key in `release-keys.json`.

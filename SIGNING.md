# Signing & notarizing Roxy

This document covers how release builds of Roxy are code-signed and notarized.

## macOS

macOS distribution requires two things so users don't see Gatekeeper's
"unidentified developer" / "damaged app" warnings:

1. **Code signing** with a _Developer ID Application_ certificate.
2. **Notarization** — uploading the signed app to Apple, which scans it and
   issues a ticket that is then _stapled_ into the app.

electron-builder does all of this automatically. You only need the certificate
(in your keychain) and notarization credentials (in the environment).

### One-time setup

1. **Apple Developer Program** membership ($99/yr) — https://developer.apple.com/programs/
2. **Developer ID Application certificate** in your login keychain. Verify with:

   ```sh
   security find-identity -v -p codesigning
   ```

   You should see a line like
   `"Developer ID Application: Your Name (TEAMID)"`. If it's there, the private
   key is present and you can sign. (For this account the Team ID is
   `MA46PKHWXH`.)

3. **Notarization credentials.** Copy `.env.example` to `.env` and fill in one
   of these sets:

   - **Apple ID (simplest):** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
     (create at https://appleid.apple.com → App-Specific Passwords),
     `APPLE_TEAM_ID`.
   - **App Store Connect API key (best for CI):** `APPLE_API_KEY` (path to the
     `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

   `.env` is git-ignored — never commit real credentials.

### Building

```sh
# Signed + notarized DMG and zip (loads .env, verifies creds, then builds):
npm run dist:mac

# Same, and upload to the GitHub release configured in electron-builder.yml:
npm run dist:mac:publish
```

Artifacts land in `dist/`. The first notarization can take a few minutes while
Apple scans the upload; electron-builder waits and then staples automatically.

Verify a finished build:

```sh
spctl -a -vvv -t install "dist/mac/roxy.app"      # → "accepted", source=Notarized Developer ID
xcrun stapler validate "dist/roxy-<version>.dmg"  # → "The validate action worked!"
```

### Quick unsigned local build

For a fast local build that skips signing/notarization, use:

```sh
npm run build:unpack   # electron-builder --dir, no DMG/notarization
```

`npm run build:mac` will still sign and attempt notarization; without the env
vars set it fails at the notarize step. Use `dist:mac` (loads `.env`) for real
release builds.

### How it's wired

- `build/entitlements.mac.plist` — hardened-runtime entitlements applied to both
  the app and its nested binaries (`entitlements` + `entitlementsInherit` in
  `electron-builder.yml`). Includes the JIT/unsigned-memory/dyld exceptions
  Electron needs plus `disable-library-validation` so native modules
  (`better-sqlite3`) load.
- `electron-builder.yml` → `mac.notarize: true` + `hardenedRuntime: true`.
- `script/build-mac.sh` — loads `.env`, checks the identity + credentials, then
  runs the build.

### CI (GitHub Actions)

Releases are built by `.github/workflows/release.yml`: pushing a **package.json
version bump** to `main` builds Windows/macOS/Linux, uploads to a _draft_ GitHub
Release, and publishes it once all three succeed.

CI runners have no login keychain, so the Developer ID identity is supplied as a
base64-encoded `.p12`, and notarization uses the `APPLE_*` env vars. These live
in GitHub **repository secrets** (the workflow injects them only on the macOS
runner — `CSC_LINK` is also Windows' signing variable, so it must not leak to the
Windows job).

**Secrets used by the workflow:**

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK` | base64 of your `.p12` (Developer ID cert + private key) |
| `MAC_CSC_KEY_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | `MA46PKHWXH` |

**Set them up (one time):**

1. Run the helper from a **normal terminal** (it uses `gh` and prompts for the
   private values, so nothing lands in your shell history):

   ```sh
   bash script/setup-mac-ci-secrets.sh
   ```

   With no argument it **exports your Developer ID identity straight from the
   login keychain** — a macOS *“security wants to export a key”* dialog pops up,
   click **Allow** (enter your Mac login password if asked) — generates a random
   `.p12` password, and sets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, and the
   auto-detected `APPLE_TEAM_ID` for you. You are prompted only for your
   `APPLE_ID` (email) and `APPLE_APP_SPECIFIC_PASSWORD`.

   > Must be run in your own terminal — the keychain-export dialog and the
   > password prompts need an interactive session.

   If you'd rather export the `.p12` yourself (Keychain Access → _login_ → _My
   Certificates_ → right-click **Developer ID Application: Freddy Diaz
   (MA46PKHWXH)** → **Export…**), pass its path and the script uses that instead:

   ```sh
   bash script/setup-mac-ci-secrets.sh ~/Desktop/roxy-cert.p12
   ```

   Or set them individually. **Use this empty‑proof pattern** — a bare
   `gh secret set NAME` will happily store a *blank* value if the paste doesn't
   register, and because secrets are write‑only you won't notice until the mac
   build fails (see Troubleshooting):

   ```sh
   base64 -i roxy-cert.p12 | tr -d '\n' | gh secret set MAC_CSC_LINK
   set_secret() { read -rsp "$1: " v; echo; [ -n "$v" ] && printf '%s' "$v" | gh secret set "$1" && echo "✓ $1" || echo "✗ $1 empty — skipped"; unset v; }
   set_secret MAC_CSC_KEY_PASSWORD          # the .p12 password
   set_secret APPLE_ID                      # your Apple ID email
   set_secret APPLE_APP_SPECIFIC_PASSWORD   # app-specific password (abcd-efgh-ijkl-mnop)
   printf '%s' MA46PKHWXH | gh secret set APPLE_TEAM_ID
   ```

2. Trigger a signed + notarized release by bumping the version:

   ```sh
   npm version patch    # e.g. 0.0.13 → 0.0.14
   git push             # runs the workflow; the macOS job signs + notarizes
   ```

   Confirm from the run logs that the macOS job prints `notarization successful`,
   then download the DMG from the release and verify:

   ```sh
   spctl -a -vvv -t install /Applications/roxy.app   # accepted, Notarized Developer ID
   ```

### Troubleshooting

**`⨯ APPLE_APP_SPECIFIC_PASSWORD env var needs to be set`** (mac job signs the
app, then fails) — one of the notarization secrets is **empty**. The workflow's
_“Verify macOS signing secrets”_ preflight now catches this in ~1s and names the
blank secret. Re‑set it with the empty‑proof pattern above, e.g.:

```sh
read -rsp 'app-specific password: ' v; echo; printf '%s' "$v" | gh secret set APPLE_APP_SPECIFIC_PASSWORD; unset v
```

A secret showing up in `gh secret list` only means it *exists* — not that it's
non‑empty. When in doubt, re‑set it.

**Finish a release whose mac job failed** — when Windows/Linux succeeded but mac
failed, the `vX.Y.Z` GitHub Release is left as a **Draft** (nothing ships until
all three platforms pass). After fixing the secret, re‑run just the failed job —
no version bump needed, and it picks up the corrected secret at runtime:

```sh
gh run rerun <run-id> --failed   # re-runs the mac job + the downstream publish
gh run watch  <run-id>
```

Get `<run-id>` from `gh run list`. Once mac passes, the `publish` job flips the
draft to Latest automatically.

## Windows

Not configured yet. The plan is to use **Azure Artifact Signing** (formerly
Trusted Signing / Azure Code Signing) rather than a physical EV token — cheaper,
no hardware, and available to individual US/Canada developers. See the project
notes for status.

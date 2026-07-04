#!/usr/bin/env bash
#
# Build, sign, and notarize the macOS app.
#
# electron-builder does not read .env files, so this wrapper loads .env (if
# present), sanity-checks the signing identity + notarization credentials, and
# then runs the build. Any extra args are passed through to electron-builder
# (e.g. `--publish always`).
#
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Load .env (Apple notarization credentials) ───────────────────────────────
if [ -f .env ]; then
  echo "→ Loading credentials from .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# ── Verify a Developer ID signing identity is in the keychain ────────────────
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No \"Developer ID Application\" identity found in your keychain." >&2
  echo "  Install your Developer ID certificate (double-click the .cer) first." >&2
  exit 1
fi
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)".*/\1/')
echo "→ Signing identity: ${IDENTITY}"

# ── Verify notarization credentials are present ──────────────────────────────
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  echo "→ Notarizing with App Store Connect API key"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "→ Notarizing as ${APPLE_ID} (team ${APPLE_TEAM_ID})"
else
  echo "✗ Missing notarization credentials." >&2
  echo "  Set either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID," >&2
  echo "  or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (see .env.example)." >&2
  exit 1
fi

# ── Build → sign → notarize → staple (all handled by electron-builder) ───────
echo "→ Building…"
npm run build
npx electron-builder --mac "$@"

echo "✓ Done. Signed + notarized artifacts are in dist/"

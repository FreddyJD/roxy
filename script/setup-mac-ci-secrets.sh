#!/usr/bin/env bash
#
# One-shot setup of the GitHub Actions secrets needed to SIGN + NOTARIZE the
# macOS build in CI (see .github/workflows/release.yml and SIGNING.md).
#
# What it sets (5 secrets):
#   MAC_CSC_LINK                 base64 of your Developer ID .p12 (cert + key)
#   MAC_CSC_KEY_PASSWORD         password protecting that .p12
#   APPLE_ID                     your Apple Developer account email
#   APPLE_APP_SPECIFIC_PASSWORD  an app-specific password from appleid.apple.com
#   APPLE_TEAM_ID                your 10-char team id (auto-detected)
#
# Usage:
#   bash script/setup-mac-ci-secrets.sh
#       → auto-exports the Developer ID identity straight from your login
#         keychain (a macOS "allow export" dialog will pop up — click Allow),
#         generates a random .p12 password, and sets every secret. You'll be
#         prompted only for your Apple ID email + app-specific password.
#
#   bash script/setup-mac-ci-secrets.sh /path/to/cert.p12
#       → uses a .p12 you already exported (it will ask for that .p12's
#         password instead of auto-generating one).
#
set -euo pipefail
cd "$(dirname "$0")/.."

command -v gh >/dev/null 2>&1 || { echo "✗ GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ Run 'gh auth login' first." >&2; exit 1; }

WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

P12="${1:-}"
if [ -n "$P12" ]; then
  # -------- use a pre-exported .p12 --------
  [ -f "$P12" ] || { echo "✗ no such file: $P12" >&2; exit 1; }
  read -rsp "  • password for $(basename "$P12"): " P12PW; echo
else
  # -------- auto-export the identity from the keychain --------
  command -v security >/dev/null 2>&1 || { echo "✗ 'security' not found (need macOS)." >&2; exit 1; }
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
             | awk -F'"' '/Developer ID Application/{print $2; exit}')
  [ -n "$IDENTITY" ] || {
    echo "✗ No 'Developer ID Application' identity found in your keychain." >&2
    echo "  Install your Developer ID cert first, or pass a .p12 path." >&2
    exit 1
  }
  echo "→ Exporting identity: $IDENTITY"
  echo "  ⚠️  A macOS dialog will appear (\"security wants to export a key\")."
  echo "     Click Allow and enter your Mac login password if asked."
  WORKDIR=$(mktemp -d -t roxy-ci-cert)
  P12="$WORKDIR/cert.p12"
  P12PW=$(openssl rand -base64 24)
  security export -t identities -f pkcs12 -P "$P12PW" -o "$P12"
  echo "  ✓ Exported ($(wc -c < "$P12" | tr -d ' ') bytes)"
fi

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "→ Setting macOS signing secrets on ${REPO}"

# 1) signing certificate (single-line base64 of the .p12)
echo "  • MAC_CSC_LINK"
base64 -i "$P12" | tr -d '\n' | gh secret set MAC_CSC_LINK

# 2) .p12 password
echo "  • MAC_CSC_KEY_PASSWORD"
printf '%s' "$P12PW" | gh secret set MAC_CSC_KEY_PASSWORD

# 3) team id — auto-detect from the identity name, fall back to the known value
TEAMID=$(security find-identity -v -p codesigning 2>/dev/null \
         | grep -oE '\([A-Z0-9]{10}\)' | head -1 | tr -d '()')
TEAMID="${TEAMID:-MA46PKHWXH}"
echo "  • APPLE_TEAM_ID ($TEAMID)"
printf '%s' "$TEAMID" | gh secret set APPLE_TEAM_ID

# 4) notarization credentials (your private Apple account values)
read -rp  "  • APPLE_ID (your Apple Developer email): " APPLEID
printf '%s' "$APPLEID" | gh secret set APPLE_ID

read -rsp "  • APPLE_APP_SPECIFIC_PASSWORD (from appleid.apple.com): " ASP; echo
printf '%s' "$ASP" | gh secret set APPLE_APP_SPECIFIC_PASSWORD

echo
echo "✓ Secrets set. Current repo secrets:"
gh secret list
echo
echo "Next: bump the version and push to trigger a signed + notarized release:"
echo "    npm version patch && git push"

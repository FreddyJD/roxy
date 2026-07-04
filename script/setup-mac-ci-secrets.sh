#!/usr/bin/env bash
#
# One-time setup of the GitHub Actions secrets needed to SIGN + NOTARIZE the
# macOS build in CI (see .github/workflows/release.yml and SIGNING.md).
#
# CI runners have no keychain, so the Developer ID identity must be provided as a
# base64-encoded .p12. Export it first from Keychain Access:
#   login keychain → My Certificates → right-click
#   "Developer ID Application: … (MA46PKHWXH)" → Export → save a .p12 → set a
#   password (that password is CSC_KEY_PASSWORD).
#
# Then run:   bash script/setup-mac-ci-secrets.sh /path/to/roxy-cert.p12
#
set -euo pipefail
cd "$(dirname "$0")/.."

P12="${1:-}"
if [ -z "$P12" ] || [ ! -f "$P12" ]; then
  echo "usage: bash script/setup-mac-ci-secrets.sh /path/to/cert.p12" >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "✗ GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ Run 'gh auth login' first." >&2; exit 1; }

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "→ Setting macOS signing secrets on ${REPO}"

# 1) The signing certificate (base64 of the .p12). tr strips newlines so the
#    value is a single clean base64 blob.
echo "  • MAC_CSC_LINK (from $(basename "$P12"))"
base64 -i "$P12" | tr -d '\n' | gh secret set MAC_CSC_LINK

# 2) The password you set when exporting the .p12.
read -rsp "  • MAC_CSC_KEY_PASSWORD (the .p12 export password): " P12PW; echo
printf '%s' "$P12PW" | gh secret set MAC_CSC_KEY_PASSWORD

# 3) Notarization: Apple ID + app-specific password + team id.
read -rp  "  • APPLE_ID (your Apple Developer email): " APPLEID
printf '%s' "$APPLEID" | gh secret set APPLE_ID

read -rsp "  • APPLE_APP_SPECIFIC_PASSWORD (from appleid.apple.com): " ASP; echo
printf '%s' "$ASP" | gh secret set APPLE_APP_SPECIFIC_PASSWORD

echo "  • APPLE_TEAM_ID (MA46PKHWXH)"
printf '%s' "MA46PKHWXH" | gh secret set APPLE_TEAM_ID

echo
echo "✓ Secrets set. Current repo secrets:"
gh secret list
echo
echo "Next: bump the version and push to trigger a signed + notarized release:"
echo "    npm version patch && git push"

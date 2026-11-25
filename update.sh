#!/usr/bin/env bash
# Fork updater: pull upstream T3 Code changes (optional), rebuild, and swap the app into /Applications.
#   ./update.sh          rebuild from current fork code
#   ./update.sh --pull   merge upstream/main first, then rebuild
set -euo pipefail

NODE_BIN="$HOME/.t3fork/node-v26.13.1-darwin-arm64/bin"
export PATH="$NODE_BIN:$PATH"
cd "$(dirname "$0")"

APP_NAME="T3 Code (Beta).app"
DEST="/Applications/$APP_NAME"

if [[ "${1:-}" == "--pull" ]]; then
  git fetch upstream
  git merge --no-edit upstream/main
  # Telemetry must stay off after a merge.
  grep -q "const telemetryEnabled = Effect.succeed(false)" apps/server/src/telemetry/AnalyticsService.ts \
    || { echo "!! upstream merge undid the telemetry kill switch in AnalyticsService.ts. Fix before building."; exit 1; }
  grep -q "isRelayTracingEnabled = (_env" packages/shared/src/otelEnvironment.ts \
    || { echo "!! upstream merge undid the relay tracing kill switch in otelEnvironment.ts. Fix before building."; exit 1; }
fi

pnpm install
pnpm exec node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64

BUILT="release/mac-arm64/$APP_NAME"
if grep -rqE "phc_XOWci4oZ|ingest\.t3\.codes|api\.axiom\.co" "$BUILT/Contents/Resources"; then
  echo "!! tracking endpoint found in the build. Not installing."; exit 1
fi

osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
sleep 2
rm -rf "$DEST"
ditto "$BUILT" "$DEST"
xattr -cr "$DEST"
echo "Installed $DEST. Reopen it."

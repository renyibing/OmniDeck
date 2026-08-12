#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  start-wda-device.sh --udid <device-udid> --local-port <port> [options]

Options:
  --bundle-id <id>          WDA runner bundle id override.
  --device-port <port>      Device-side WDA port. Default: 8100.
  --mjpeg-local-port <port> Host port for WDA MJPEG (device 9100). Default: local-port + 1000.
  --derived-data <path>     xcodebuild derived data path override.
  --team-id <id>            Apple development team id override.
  --project <path>          WebDriverAgent.xcodeproj path override.
  --output-dir <path>       Log and pid output directory. Default: output/wda
  --help                    Show this help text.

Environment:
  OMNIDECK_WDA_TEAM_ID      Optional team id override.
  OMNIDECK_WDA_PROJECT      Optional WDA project path override.
  OMNIDECK_WDA_OUTPUT_DIR   Optional output directory override.
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

sanitize_suffix() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

detect_team_id() {
  local profile_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  local tmp_plist
  tmp_plist="$(mktemp)"
  trap 'rm -f "$tmp_plist"' RETURN

  if [[ ! -d "$profile_dir" ]]; then
    return 1
  fi

  local profile
  for profile in "$profile_dir"/*.mobileprovision; do
    [[ -e "$profile" ]] || continue
    if ! security cms -D -i "$profile" >"$tmp_plist" 2>/dev/null; then
      continue
    fi
    if [[ "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' "$tmp_plist" 2>/dev/null || true)" != "true" ]]; then
      continue
    fi
    local detected
    detected="$(
      /usr/libexec/PlistBuddy -c 'Print :ApplicationIdentifierPrefix:0' "$tmp_plist" 2>/dev/null ||
      /usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$tmp_plist" 2>/dev/null ||
      true
    )"
    if [[ -n "$detected" ]]; then
      printf '%s\n' "$detected"
      return 0
    fi
  done

  return 1
}

wait_for_wda() {
  local local_port="$1"
  local attempts="${2:-90}"
  local index

  for ((index = 1; index <= attempts; index += 1)); do
    if curl -fsS "http://127.0.0.1:${local_port}/status" >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:${local_port}/status"
      return 0
    fi
    sleep 2
  done

  return 1
}

UDID=""
LOCAL_PORT=""
DEVICE_PORT="8100"
MJPEG_LOCAL_PORT=""
BUNDLE_ID=""
DERIVED_DATA=""
TEAM_ID="${OMNIDECK_WDA_TEAM_ID:-}"
WDA_PROJECT="${OMNIDECK_WDA_PROJECT:-$HOME/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj}"
OUTPUT_DIR="${OMNIDECK_WDA_OUTPUT_DIR:-output/wda}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --udid)
      UDID="${2:-}"
      shift 2
      ;;
    --local-port)
      LOCAL_PORT="${2:-}"
      shift 2
      ;;
    --device-port)
      DEVICE_PORT="${2:-}"
      shift 2
      ;;
    --mjpeg-local-port)
      MJPEG_LOCAL_PORT="${2:-}"
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      shift 2
      ;;
    --derived-data)
      DERIVED_DATA="${2:-}"
      shift 2
      ;;
    --team-id)
      TEAM_ID="${2:-}"
      shift 2
      ;;
    --project)
      WDA_PROJECT="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$UDID" || -z "$LOCAL_PORT" ]]; then
  usage >&2
  exit 1
fi

if [[ -z "$MJPEG_LOCAL_PORT" ]]; then
  MJPEG_LOCAL_PORT="$((LOCAL_PORT + 1000))"
fi

require_command xcodebuild
require_command iproxy
require_command curl
require_command security

if [[ -z "$TEAM_ID" ]]; then
  TEAM_ID="$(detect_team_id || true)"
fi

if [[ -z "$TEAM_ID" ]]; then
  echo "Unable to detect Apple development team id. Set --team-id or OMNIDECK_WDA_TEAM_ID." >&2
  exit 1
fi

if [[ ! -e "$WDA_PROJECT" ]]; then
  echo "WebDriverAgent project not found at: $WDA_PROJECT" >&2
  exit 1
fi

if [[ -z "$BUNDLE_ID" ]]; then
  BUNDLE_ID="com.omnideck.WebDriverAgentRunner.$(sanitize_suffix "$UDID")"
fi

if [[ -z "$DERIVED_DATA" ]]; then
  DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData/WebDriverAgent-$(sanitize_suffix "$UDID")"
fi

if curl -fsS "http://127.0.0.1:${LOCAL_PORT}/status" >/dev/null 2>&1; then
  echo "WDA is already reachable at http://127.0.0.1:${LOCAL_PORT}"
  curl -fsS "http://127.0.0.1:${LOCAL_PORT}/status"
  exit 0
fi

mkdir -p "$OUTPUT_DIR"

suffix="$(sanitize_suffix "${UDID}-${LOCAL_PORT}")"
xcode_log="${OUTPUT_DIR}/${suffix}-xcodebuild.log"
proxy_log="${OUTPUT_DIR}/${suffix}-iproxy.log"
mjpeg_proxy_log="${OUTPUT_DIR}/${suffix}-iproxy-mjpeg.log"
xcode_pid_file="${OUTPUT_DIR}/${suffix}-xcodebuild.pid"
proxy_pid_file="${OUTPUT_DIR}/${suffix}-iproxy.pid"
mjpeg_proxy_pid_file="${OUTPUT_DIR}/${suffix}-iproxy-mjpeg.pid"

if lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Local port ${LOCAL_PORT} is already in use." >&2
  exit 1
fi

if lsof -nP -iTCP:"${MJPEG_LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "MJPEG local port ${MJPEG_LOCAL_PORT} is already in use." >&2
  exit 1
fi

echo "Starting WebDriverAgent for ${UDID}"
echo "  project: ${WDA_PROJECT}"
echo "  team:    ${TEAM_ID}"
echo "  bundle:  ${BUNDLE_ID}"
echo "  local:   http://127.0.0.1:${LOCAL_PORT}"
echo "  mjpeg:   http://127.0.0.1:${MJPEG_LOCAL_PORT}"

# Parent shells sometimes export CC="ccache clang" (two tokens). Xcode then tries to
# spawn a binary literally named "ccache clang". Clear wrappers; do not override with
# /usr/bin/clang or the toolchain/libclang match breaks.
unset CC CXX LD

nohup xcodebuild \
  -project "$WDA_PROJECT" \
  -scheme WebDriverAgentRunner \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "id=${UDID}" \
  -allowProvisioningUpdates \
  "DEVELOPMENT_TEAM=${TEAM_ID}" \
  "CODE_SIGN_IDENTITY=Apple Development" \
  "PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID}" \
  test >"$xcode_log" 2>&1 &
echo $! >"$xcode_pid_file"

nohup iproxy -u "$UDID" "${LOCAL_PORT}:${DEVICE_PORT}" >"$proxy_log" 2>&1 &
echo $! >"$proxy_pid_file"

nohup iproxy -u "$UDID" "${MJPEG_LOCAL_PORT}:9100" >"$mjpeg_proxy_log" 2>&1 &
echo $! >"$mjpeg_proxy_pid_file"

if wait_for_wda "$LOCAL_PORT"; then
  echo
  echo "WDA ready at http://127.0.0.1:${LOCAL_PORT}"
  echo "MJPEG stream at http://127.0.0.1:${MJPEG_LOCAL_PORT}"
  echo "xcodebuild log: ${xcode_log}"
  echo "iproxy log:     ${proxy_log}"
  echo "mjpeg log:      ${mjpeg_proxy_log}"
  exit 0
fi

echo "WDA did not become ready on http://127.0.0.1:${LOCAL_PORT}" >&2
echo "Last xcodebuild log lines:" >&2
tail -n 40 "$xcode_log" >&2 || true
echo "Last iproxy log lines:" >&2
tail -n 40 "$proxy_log" >&2 || true
exit 1

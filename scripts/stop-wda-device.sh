#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  stop-wda-device.sh --udid <device-udid> --local-port <port> [--output-dir <path>]
EOF
}

sanitize_suffix() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

kill_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

UDID=""
LOCAL_PORT=""
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

suffix="$(sanitize_suffix "${UDID}-${LOCAL_PORT}")"
kill_pid_file "${OUTPUT_DIR}/${suffix}-iproxy.pid"
kill_pid_file "${OUTPUT_DIR}/${suffix}-xcodebuild.pid"

if lsof -tiTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:"${LOCAL_PORT}" -sTCP:LISTEN | xargs kill >/dev/null 2>&1 || true
fi

echo "Stopped WDA processes for ${UDID} on local port ${LOCAL_PORT}"

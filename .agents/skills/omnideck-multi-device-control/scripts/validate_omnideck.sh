#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(pwd)}"
package_file="$repo_root/package.json"

if [[ ! -f "$package_file" || ! -d "$repo_root/src/domain" ]]; then
  echo "error: expected OmniDeck repository root, got: $repo_root" >&2
  exit 2
fi

required_files=(
  "src/domain/deviceManager.ts"
  "src/domain/sessionManager.ts"
  "src/domain/streamManager.ts"
  "src/domain/taskScheduler.ts"
  "src/domain/workerPool.ts"
  "src/domain/controlPlane.ts"
  "src/domain/deviceDriver.ts"
  "src/domain/healthMonitor.ts"
  "src/domain/controlCenter.test.ts"
)

for path in "${required_files[@]}"; do
  if [[ ! -f "$repo_root/$path" ]]; then
    echo "error: missing required module: $path" >&2
    exit 3
  fi
done

if rg -n --glob '*.{ts,tsx}' '(broadcastTap\s*\(|broadcastClick\s*\(|analy[sz]eVideo\s*:\s*true|videoToVLM\s*\()' "$repo_root/src"; then
  echo "error: prohibited synchronized broadcast or continuous video analysis pattern detected" >&2
  exit 4
fi

(
  cd "$repo_root"
  npm run lint
  npm test
  npm run build
)

echo "OmniDeck architecture and build validation passed."

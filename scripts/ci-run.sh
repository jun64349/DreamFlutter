#!/usr/bin/env bash
set -euo pipefail

TITLE="$1"
shift
LOG="$(mktemp)"
cleanup() { rm -f "$LOG"; }
trap cleanup EXIT

set +e
"$@" 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e

if [[ "$RC" -ne 0 ]]; then
  node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean).slice(-40);
    const msg = lines.join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 3500);
    console.log(`::error title=${process.argv[2]}::${msg}`);
  ' "$LOG" "$TITLE"
  exit "$RC"
fi

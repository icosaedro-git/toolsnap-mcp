#!/usr/bin/env bash
# Entry point used by Glama/Smithery container tests (npm start).
# Starts wrangler dev in the background, waits for the HTTP server to be
# ready, then replaces this process with the stdio↔HTTP bridge so that
# mcp-proxy can communicate via stdin/stdout.

set -euo pipefail

# Mock secrets — no real funds or keys.
export X402_PAY_TO_ADDRESS="${X402_PAY_TO_ADDRESS:-0x0000000000000000000000000000000000000000}"
export RELAYER_PRIVATE_KEY="${RELAYER_PRIVATE_KEY:-0x0000000000000000000000000000000000000000000000000000000000000001}"

# Start wrangler dev in background; suppress all output so mcp-proxy never
# sees non-JSON lines on stdout.
npx wrangler dev --local --port 8787 --ip 0.0.0.0 >/dev/null 2>&1 &

# Wait up to 30 s for the HTTP server to be ready.
for i in $(seq 1 60); do
  curl -sf http://localhost:8787/ >/dev/null 2>&1 && break
  sleep 0.5
done

# Hand off to the stdio bridge — replaces this shell process.
exec node "$(dirname "$0")/stdio-proxy.mjs"

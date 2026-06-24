# Dockerfile for local MCP server inspection (Glama safety checks, Smithery sandbox, etc.)
#
# The production server runs as a Cloudflare Worker (V8 isolate). This file
# uses `wrangler dev --local` which runs via Miniflare — no Cloudflare account
# or credentials required. D1 and KV bindings are simulated in-memory.
#
# Free tools work fully. Paid tools (fetch_extract) return HTTP 402 without a
# valid x402 payment — that is the expected, correct behaviour.

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 8787

# Mock secrets so the server starts without real credentials.
# These values are intentionally fake — no real funds or keys.
ENV X402_PAY_TO_ADDRESS=0x0000000000000000000000000000000000000000
ENV RELAYER_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001

CMD ["npx", "wrangler", "dev", "--local", "--port", "8787", "--ip", "0.0.0.0"]

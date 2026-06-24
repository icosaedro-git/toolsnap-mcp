#!/usr/bin/env node
/**
 * Bridges stdio JSON-RPC (newline-delimited) → local HTTP MCP server.
 *
 * Glama/Smithery container tests spawn `npm start` via mcp-proxy, which
 * communicates over stdin/stdout. Our server is streamable-HTTP, so this
 * script acts as the translation layer:
 *   stdin  → POST http://localhost:8787/mcp → stdout
 */
import { createInterface } from 'readline';

const BASE_URL = process.env.MCP_URL ?? 'http://localhost:8787/mcp';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try { JSON.parse(trimmed); } catch { return; }

  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: trimmed,
    });
    if (res.status === 202) return; // notification — no response body
    const text = await res.text();
    if (text.trim()) process.stdout.write(text.trim() + '\n');
  } catch (err) {
    process.stderr.write(`[stdio-proxy] ${err.message}\n`);
  }
});

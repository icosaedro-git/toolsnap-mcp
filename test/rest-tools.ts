/**
 * Tests for POST /v1/tools/<name> (src/rest-tools.ts, ADR-003).
 * No live server: handler called directly with a mocked Env.
 *
 * Run:  npx tsx test/rest-tools.ts
 */
import { handleRestTool, REST_ALLOWED } from "../src/rest-tools.js";
import { requiresPayment } from "../src/x402/middleware.js";
import { tools } from "../src/tools/index.js";
import type { Env } from "../src/index.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

// Known paid tools, hardcoded on purpose: guards the guard. If requiresPayment
// ever stopped reporting these, the disjointness test below would pass vacuously.
const KNOWN_PAID = [
  "screenshot_url", "fetch_rendered", "keyword_research", "remove_background",
  "csv_query_xl", "json_query_xl", "image_generate", "image_upscale",
  "audio_transcribe", "text_to_speech", "video_generate",
];

console.log("Sets");
// THIS TEST IS THE WALL. If someone adds a paid tool to REST_ALLOWED, this
// route becomes a payment bypass (it never charges). It must fail the build.
{
  const leaked = [...REST_ALLOWED].filter((n) => requiresPayment(n));
  assert(leaked.length === 0, `REST_ALLOWED is disjoint from paid tools (leaked: ${leaked.join(",") || "none"})`);
  assert(KNOWN_PAID.every((n) => requiresPayment(n)), "sanity: requiresPayment still flags every known paid tool");
  assert(KNOWN_PAID.every((n) => !REST_ALLOWED.has(n)), "no known paid tool is in REST_ALLOWED");
  const registry = new Set(tools.map((t) => t.name));
  const missing = [...REST_ALLOWED].filter((n) => !registry.has(n));
  assert(missing.length === 0, `every REST_ALLOWED entry exists in the tool registry (missing: ${missing.join(",") || "none"})`);
}

// ---------------------------------------------------------------------------
const TOKEN = "test-rest-token-abc123";
let limitCalls = 0;
let allowLimit = true;
const env = {
  REST_API_TOKEN: TOKEN,
  FREE_FETCH_RL: { limit: async () => { limitCalls++; return { success: allowLimit }; } },
  PREPAID_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
} as unknown as Env;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(name: string, opts: { method?: string; auth?: string | null; body?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request(`https://mcp.toolsnap.app/v1/tools/${name}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" ? undefined : opts.body ?? "{}",
  });
}

console.log("Handler");
{
  let r = await handleRestTool(req("fetch_extract", { method: "GET" }), env, ctx);
  assert(r.status === 405, "GET -> 405");

  r = await handleRestTool(req("fetch_extract", { auth: null }), env, ctx);
  assert(r.status === 401 && (await r.text()) === '{"error":"unauthorized"}', "no Authorization -> 401 exact body");
  r = await handleRestTool(req("fetch_extract", { auth: `Basic ${TOKEN}` }), env, ctx);
  assert(r.status === 401, "non-Bearer -> 401");
  r = await handleRestTool(req("fetch_extract", { auth: `Bearer ${TOKEN.slice(0, -1)}x` }), env, ctx);
  assert(r.status === 401, "one char changed -> 401");

  // 401 must not depend on the tool.
  const a = await (await handleRestTool(req("screenshot_url", { auth: "Bearer nope" }), env, ctx)).text();
  const b = await (await handleRestTool(req("fetch_extract", { auth: "Bearer nope" }), env, ctx)).text();
  const c = await (await handleRestTool(req("does_not_exist", { auth: "Bearer nope" }), env, ctx)).text();
  assert(a === b && b === c, "401 body identical for paid / free / invented tool");

  const noSecret = { ...env, REST_API_TOKEN: undefined } as unknown as Env;
  r = await handleRestTool(req("fetch_extract"), noSecret, ctx);
  assert(r.status === 401, "secret unset -> 401 (fails closed)");

  for (const n of ["screenshot_url", "keyword_research", "image_generate", "csv_query_xl", "does_not_exist", "account_balance"]) {
    r = await handleRestTool(req(n), env, ctx);
    assert(r.status === 404 && (await r.text()) === '{"error":"not_found"}', `${n} -> 404 not_found`);
  }

  limitCalls = 0;
  r = await handleRestTool(req("fetch_extract", { body: "not json" }), env, ctx);
  assert(r.status === 400 && limitCalls === 0, "invalid JSON -> 400, nothing executed");

  allowLimit = false;
  r = await handleRestTool(req("fetch_extract", { body: "{}" }), env, ctx);
  assert(r.status === 429, "limiter denies -> 429");
  allowLimit = true;

  limitCalls = 0;
  r = await handleRestTool(req("fetch_extract", { body: "{}" }), env, ctx);
  const body = (await r.json()) as { ok: boolean; error?: string };
  assert(r.status === 400 && body.ok === false && typeof body.error === "string", "tool throws on bad args -> 400 {ok:false,error}");
  assert(limitCalls === 1, "limiter consulted before executing");
}

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");

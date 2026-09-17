/**
 * Unit tests for Fase 25.4 — Telegram error-alert noise floor.
 *
 * The 2026-07-25 analytics review found 77 alerts in 14 days, 77% of them
 * directory scanners health-checking the server with argument-less calls, plus
 * a throttle that never deduped (`__verifymcp_auth_probe_<random>__` produced a
 * fresh KV key every run). The panel had excluded probe traffic from demand
 * since Fase 25.1/25.3; the pager had never learned the same rule.
 *
 * Covers:
 *  - isProbeClient: the TS mirror of IS_PROBE_SQL matches the exact-name list,
 *    the LIKE patterns, and the raw User-Agent — and does NOT match the
 *    generic SDK labels Fase 25.1 deliberately kept out of PROBE_CLIENTS.
 *  - maybeAlertError: probe tool_errors are silent, real-caller errors still
 *    page, upstream/admin suppression still holds, and "Tool not found"
 *    collapses onto ONE throttle key regardless of the name tried.
 *  - Business signals are unaffected by the probe rule (they never ran through
 *    it: a probe cannot pay).
 *
 * Pure logic — a fake KV + a captured fetch stand in for D1/Telegram.
 *
 * Run: npx tsx test/alert-noise.ts
 */
import { isProbeClient } from "../src/analytics/surface.js";
import { isUpstreamError, classifyToolError } from "../src/alerts/error-classification.js";
import { maybeAlertError } from "../src/alerts/error-alerts.js";
import { findBrokenTools, type WindowRow } from "../src/alerts/health.js";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name} — ${detail}`);
    failed++;
  }
}

console.log("=== Fase 25.4 / 25.9 alert-noise tests ===\n");

// ---------------------------------------------------------------------------
// isProbeClient — must agree with IS_PROBE_SQL (queries.ts)
// ---------------------------------------------------------------------------
console.log("isProbeClient");
{
  // Exact-name list.
  assert("matches an exact PROBE_CLIENTS entry", isProbeClient("verifymcp-probe"), "expected true");
  assert("matches an exact entry with no pattern hit", isProbeClient("glama"), "expected true");

  // LIKE patterns.
  for (const name of [
    "agentstatus-probe",
    "canopii-scanner",
    "agentfinder-crawler",
    "sasame-audit",
    "somebot-spider",
    "LinerMCPVerifier",
  ]) {
    assert(`matches pattern for "${name}"`, isProbeClient(name), "expected true");
  }

  // Raw User-Agent fallback: the 2026-07-25 review saw firefly-miner-probe/0.1
  // arrive with client_name "Smithery Connect".
  assert(
    "matches on the raw User-Agent when client_name is generic",
    isProbeClient("Smithery Connect", "firefly-miner-probe/0.1"),
    "expected true"
  );

  // Deliberate non-probes (Fase 25.1: generic SDK labels used by real agents).
  for (const name of ["python-script", "mcp", "test", "agent-lab", "curl", "Anthropic/ClaudeAI"]) {
    assert(`does NOT match generic label "${name}"`, !isProbeClient(name), "expected false");
  }
  assert("does NOT match on empty input", !isProbeClient(null, null), "expected false");
  assert(
    "does NOT match a real agent whose UA merely mentions scanning",
    !isProbeClient("claude-code", "python-httpx/0.28.1"),
    "expected false"
  );
}

// ---------------------------------------------------------------------------
// isUpstreamError — the timeout rule must never swallow money/COGS failures
// ---------------------------------------------------------------------------
console.log("\nisUpstreamError (regla de timeout, Fase 25.6)");
{
  for (const detail of [
    "Failed to fetch URL: The operation was aborted",
    "Failed to fetch: The operation was aborted",
    "Failed to fetch feed: The operation was aborted",
    "Failed to fetch sitemap: The user aborted a request",
  ]) {
    assert(`silencia el timeout de fetch propio: "${detail.slice(0, 34)}…"`, isUpstreamError(detail), "esperaba true");
  }

  // La primera versión de esta regla casaba "timeout" en cualquier posición y
  // se tragaba estos, incluido un fallo de la ruta de dinero. Nunca ampliar.
  for (const detail of [
    "fal.ai: request timed out after 60s",
    "fal.ai video job timeout",
    "ScreenshotOne: capture timed out",
    "DataForSEO: gateway timeout",
    "Settle timed out on-chain",
    "Deposit confirmation timed out",
  ]) {
    assert(`NO silencia un fallo de proveedor/dinero: "${detail.slice(0, 34)}…"`, !isUpstreamError(detail), "esperaba false");
  }
}

// ---------------------------------------------------------------------------
// maybeAlertError — what actually reaches Telegram
// ---------------------------------------------------------------------------
console.log("\nmaybeAlertError");

interface FakeKv {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

function makeKv(): FakeKv {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

/** Collects the ctx.waitUntil promises so the test can await them. */
function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settled: async () => void (await Promise.all(pending)) };
}

async function sentMessages(
  events: Array<Parameters<typeof maybeAlertError>[2]>,
  kv = makeKv()
): Promise<string[]> {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "test-chat",
      X402_NONCES: kv as unknown as KVNamespace,
    };
    for (const event of events) {
      const { ctx, settled } = makeCtx();
      maybeAlertError(env, ctx, event);
      await settled();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

{
  // The exact scanner pattern from the review: 4 argument-less calls.
  const probeRun = ["csv_query", "json_query", "html_to_markdown", "pdf_text_extract"].map((toolName) => ({
    toolName,
    paymentType: "tool_error",
    payer: "anon:e85d9141e1e1",
    client: "python-requests/2.32.5",
    clientName: "agentstatus-probe",
    detail: "Provide either `url` or `csv`.",
  }));
  const sent = await sentMessages(probeRun);
  assert("a full directory-probe run sends nothing", sent.length === 0, `sent ${sent.length}`);
}

{
  // Fase 25.9 — INVERSION. El mismo error de validacion, de un llamante REAL
  // (python-script no es probe a proposito): ya no pagina. El mensaje es la
  // respuesta util para el agente, no un fallo de ToolSnap. 9 de las 14
  // alertas de los 5 dias previos al 2026-09-17 eran exactamente esto.
  const sent = await sentMessages([
    {
      toolName: "json_query",
      paymentType: "tool_error",
      payer: "anon:06663e5bb470",
      client: "python-httpx/0.28.1",
      clientName: "python-script",
      detail: "`query` is required.",
    },
    {
      toolName: "csv_query",
      paymentType: "tool_error",
      payer: "anon:06663e5bb470",
      client: "python-httpx/0.28.1",
      clientName: "python-script",
      detail: "Provide either `url` or `csv`.",
    },
    {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "anon:06663e5bb470",
      client: "python-httpx/0.28.1",
      clientName: "python-script",
      detail: "`url` must be a string starting with http:// or https://. Received nothing.",
    },
    {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "anon:06663e5bb470",
      client: "python-httpx/0.28.1",
      clientName: "python-script",
      detail: '`headers` key "User-Agent" is not allowed. Allowed keys: authorization, cookie, x-api-key.',
    },
  ]);
  assert("los errores de argumentos de un llamante real ya NO paginan", sent.length === 0, `sent ${sent.length}`);
}

{
  // Fase 25.9 — el destino portandose mal tampoco pagina. El bucle de
  // redirects y el muro de bots eran las otras 5 alertas de esos 5 dias.
  const sent = await sentMessages([
    {
      toolName: "fetch_html",
      paymentType: "tool_error",
      payer: "anon:1c04c4c8b1d7",
      clientName: "mcp",
      detail: "Failed to fetch URL: Too many redirects (max 5).",
    },
    {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "anon:1c04c4c8b1d7",
      clientName: "mcp",
      detail:
        "This URL returned very little extractable text despite a sizeable response (likely a bot wall).",
    },
    {
      toolName: "rss_parse",
      paymentType: "tool_error",
      payer: "anon:1c04c4c8b1d7",
      clientName: "mcp",
      detail: "No response body.",
    },
  ]);
  assert("los fallos del sitio destino ya NO paginan", sent.length === 0, `sent ${sent.length}`);
}

{
  // Fase 25.9 — lo que SI tiene que seguir sonando: COGS, config y cableado.
  // Cada uno con su propia tool para no chocar con el throttle por tool.
  const cases: Array<[string, string]> = [
    ["screenshot_url", "ScreenshotOne: capture timed out after 30s"],
    ["image_generate", "fal.ai: request timed out after 60s"],
    ["keyword_research", "DataForSEO: gateway timeout"],
    ["text_to_speech", "fal.ai API key is not configured (FAL_API_KEY)."],
    ["pdf_text_extract", "pdf_text_extract is env-aware and must be called via runWithEnv"],
    ["remove_background", "fal.ai rembg returned an unexpected response (no image URL)"],
    ["upload_file", "R2 bucket is not configured (SCREENSHOTS_BUCKET)."],
    ["count_tokens", "Cannot read properties of undefined (reading 'length')"],
  ];
  const sent = await sentMessages(
    cases.map(([toolName, detail]) => ({
      toolName,
      paymentType: "tool_error",
      payer: "anon:06663e5bb470",
      clientName: "claude-code",
      detail,
    }))
  );
  assert(
    "COGS, config, cableado y excepciones desconocidas siguen paginando",
    sent.length === cases.length,
    `sent ${sent.length} de ${cases.length}`
  );
}

{
  // Fase 25.9 — sondeos de tools inexistentes: el nombre nunca es uno que
  // anunciemos (tools/list y callTool salen del mismo registro), asi que es
  // siempre el llamante inventandoselo. Silencio total, no "uno por hora".
  const names = [
    "__verifymcp_auth_probe_b15947786f222090__",
    "__verifymcp_auth_probe_14255d48f6276645__",
    "__verifymcp_auth_probe_b2af2fec0983dc73__",
  ];
  const sent = await sentMessages(
    names.map((toolName) => ({
      toolName,
      paymentType: "tool_error",
      payer: "anon:1c04c4c8b1d7",
      client: "some-client/1.0",
      clientName: "unknown-caller",
      detail: `Tool not found: ${toolName}`,
    }))
  );
  assert("los sondeos de tools inexistentes no mandan nada", sent.length === 0, `sent ${sent.length}`);
}

{
  // Regressions: the Fase 24.6 / 14 suppressions must survive.
  const sent = await sentMessages([
    {
      toolName: "rss_parse",
      paymentType: "tool_error",
      payer: "anon:4ffa54610f6e",
      clientName: "python-script",
      detail: "Fetch failed: HTTP 404 Not Found",
    },
    {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "admin",
      clientName: "curl",
      detail: "boom",
    },
    {
      toolName: "screenshot_url",
      paymentType: "402_rejected",
      payer: "anon:fc8c4578c711",
      clientName: "mcp",
      detail: "no_payment_payload",
    },
    {
      toolName: "csv_query",
      paymentType: "prepaid_insufficient",
      payer: "acct:1234",
      clientName: "claude-code",
      detail: "balance too low",
    },
  ]);
  assert("upstream/admin/handshake/insufficient stay suppressed", sent.length === 0, `sent ${sent.length}`);
}

{
  // A blocked SSRF attempt is a security signal, not scanner noise — it must
  // survive the probe rule (curl is not a probe).
  const sent = await sentMessages([
    {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "anon",
      clientName: "curl",
      client: "curl/8.7.1",
      detail: 'Failed to fetch URL: URL host "169.254.169.254" is not allowed (private/reserved IP address).',
    },
  ]);
  assert("a blocked SSRF attempt still pages", sent.length === 1, `sent ${sent.length}`);
}

{
  // Money errors keep their 🔴 path and their own 5-minute key.
  const sent = await sentMessages([
    {
      toolName: "screenshot_url",
      paymentType: "settle_failed",
      payer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      clientName: "agentstatus-probe",
      detail: "settle reverted",
    },
  ]);
  assert(
    "a money failure pages even from a probe client name",
    sent.length === 1 && sent[0].startsWith("🔴"),
    `sent ${sent.length}: ${sent[0] ?? "(none)"}`
  );
}

// ---------------------------------------------------------------------------
// Fase 25.9 — convencion de crawler en el UA crudo
// ---------------------------------------------------------------------------
console.log("\nisProbeClient — convencion de crawler en el UA (Fase 25.9)");
{
  assert(
    "BrickBlueBot se declara bot en su propio UA",
    isProbeClient("brick.blue", "BrickBlueBot/0.1 (+https://brick.blue/bot; agentic web index)"),
    "expected true"
  );
  assert(
    "cualquier crawler futuro con la misma convencion",
    isProbeClient("algo-nuevo", "AlgoNuevo/2.0 (+https://algonuevo.example/bot)"),
    "expected true"
  );
  assert(
    "un agente real con parentesis en el UA NO casa",
    !isProbeClient("claude-code", "claude-cli/2.1.0 (external, cli)"),
    "expected false"
  );
  assert(
    "un UA que menciona http sin la convencion NO casa",
    !isProbeClient("mcp", "python-httpx/0.28.1"),
    "expected false"
  );
}

// ---------------------------------------------------------------------------
// Fase 25.9 — clasificador de tres clases
// ---------------------------------------------------------------------------
console.log("\nclassifyToolError");
{
  const cases: Array<[string, string]> = [
    ["Provide either `url` or `csv`.", "caller"],
    ["`url` is required.", "caller"],
    ["count must be an integer between 1 and 100.", "caller"],
    ['`headers` key "User-Agent" is not allowed. Allowed keys: authorization.', "caller"],
    ["text too long — max 2000 characters per call", "caller"],
    ["Tool not found: __probe_1234__", "caller"],
    ["Fetch failed: HTTP 404 Not Found for https://example.com", "upstream"],
    ["Failed to fetch URL: Too many redirects (max 5).", "upstream"],
    ["Failed to fetch sitemap: The operation was aborted", "upstream"],
    ["This URL returned very little extractable text despite a sizeable response.", "upstream"],
    ["No response body.", "upstream"],
    ["rate_limited", "upstream"],
    ["fal.ai: request timed out after 60s", "internal"],
    ["ScreenshotOne: capture timed out", "internal"],
    ["Settle timed out on-chain", "internal"],
    ["R2 bucket is not configured (SCREENSHOTS_BUCKET).", "internal"],
    ["csv_query is env-aware and must be called via runWithEnv", "internal"],
    ["Tool foo requires env but none was provided.", "internal"],
    ["fal.ai kokoro returned an unexpected response (no audio URL)", "internal"],
    ['Failed to fetch URL: URL host "10.0.0.1" is not allowed (private/reserved IP address).', "internal"],
    ["Cannot read properties of undefined (reading 'map')", "internal"],
  ];
  for (const [detail, expected] of cases) {
    const got = classifyToolError(detail);
    assert(`${expected.padEnd(8)} ← ${detail.slice(0, 52)}`, got === expected, `got "${got}"`);
  }
  assert("sin detail no se puede afirmar que sea ruido", classifyToolError(null) === "internal", "expected internal");
}

// ---------------------------------------------------------------------------
// Fase 25.9 — deteccion agregada de tools rotas (health.ts)
// ---------------------------------------------------------------------------
console.log("\nfindBrokenTools");
{
  const row = (over: Partial<WindowRow>): WindowRow => ({
    tool_name: "fetch_extract",
    payment_type: "free_tool",
    detail: null,
    client_name: "claude-code",
    client: "claude-cli/2.1.0",
    ...over,
  });

  assert(
    "por debajo del minimo de llamadas no hay tasa que valga",
    findBrokenTools([
      row({ payment_type: "tool_error", detail: "boom" }),
      row({ payment_type: "tool_error", detail: "boom" }),
    ]).length === 0,
    "expected 0"
  );

  const broken = findBrokenTools(
    Array.from({ length: 6 }, () => row({ payment_type: "tool_error", detail: "boom" }))
  );
  assert("6/6 fallos en una tool la marcan como rota", broken.length === 1 && broken[0].pct === 100, JSON.stringify(broken));
  assert("la alerta lleva el detail mas repetido", broken[0]?.topDetail === "boom", JSON.stringify(broken[0]));

  assert(
    "una tool con mayoria de exitos no salta",
    findBrokenTools([
      ...Array.from({ length: 5 }, () => row({})),
      row({ payment_type: "tool_error", detail: "boom" }),
    ]).length === 0,
    "expected 0"
  );

  assert(
    "los escaneres no cuentan para la tasa",
    findBrokenTools(
      Array.from({ length: 8 }, () =>
        row({
          payment_type: "tool_error",
          detail: "Provide either `url` or `csv`.",
          client_name: "brick.blue",
          client: "BrickBlueBot/0.1 (+https://brick.blue/bot)",
        })
      )
    ).length === 0,
    "expected 0"
  );

  const schemaProblem = findBrokenTools(
    Array.from({ length: 6 }, () =>
      row({ payment_type: "tool_error", detail: "Provide either `url` or `csv`." })
    )
  );
  assert(
    "100% de errores de argumentos de llamantes reales = el esquema confunde",
    schemaProblem.length === 1 && schemaProblem[0].kinds === "caller",
    JSON.stringify(schemaProblem)
  );
}

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) process.exit(1);

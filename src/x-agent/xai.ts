/**
 * Minimal client for the xAI Responses API (POST /v1/responses) used by
 * reply-guy discovery (Fase 22.4). Single call per sweep: the model runs its
 * own x_search tool loop server-side (search → read → reason → draft) and
 * returns one JSON array of candidates — see the prompt loaded from
 * `x_prompts` (name='reply_discovery', vault nota 14) for what it's asked to
 * produce. This module only knows how to call the API and parse the
 * response shape; it carries no strategy of its own.
 *
 * VERIFY AT IMPLEMENTATION TIME: xAI's public docs (docs.x.ai, checked
 * 2026-07-11) show the request shape clearly but not a full response
 * example — `parseResponseText`/`extractToolCallCount` below are written
 * defensively against the OpenAI-Responses-API-shaped conventions xAI's docs
 * describe (an `output` array of items, a `message` item with `output_text`
 * content parts) plus a couple of fallbacks. The FIRST real sweep against
 * the live API is the actual verification — if parsing throws
 * "unrecognized xai response shape", log the raw body and fix the two
 * functions below; nothing else in discovery.ts needs to change.
 */

export interface XaiEnv {
  XAI_API_KEY?: string;
  X_DRY_RUN?: string;
}

export interface XaiSweepResult {
  /** Raw JSON text the model returned (already asked to be a strict JSON array in the prompt). */
  rawText: string;
  /** Best-effort estimated cost of this one call, in USD. */
  costUsdEstimate: number;
}

// grok-4.3 per-million-token pricing (verified 2026-07-11, x.ai/api) — used
// only when the response doesn't hand back a ready-made cost figure.
const INPUT_USD_PER_MTOK = 1.25;
const OUTPUT_USD_PER_MTOK = 2.5;
// x_search (and other agent tools) are billed per tool invocation, not per
// token — $5 per 1,000 calls (x.ai/api, verified 2026-07-11).
const TOOL_CALL_USD = 5 / 1000;

interface XaiResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface XaiResponseBody {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: XaiResponseUsage;
}

/** Extract the model's final text output from a Responses API body, trying every shape we know xAI might use. */
function parseResponseText(body: XaiResponseBody): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }
  if (Array.isArray(body.output)) {
    const texts: string[] = [];
    for (const item of body.output) {
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (typeof part.text === "string") texts.push(part.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  throw new Error(
    `xai: unrecognized response shape (no output_text, no output[].content[].text) — raw keys: ${Object.keys(body).join(",")}`
  );
}

/** Count tool invocations in the output array (any item type mentioning "search") — defaults to 1 (the sweep asked for at least one). */
function extractToolCallCount(body: XaiResponseBody): number {
  if (!Array.isArray(body.output)) return 1;
  const calls = body.output.filter((item) => (item.type ?? "").includes("search")).length;
  return calls > 0 ? calls : 1;
}

function estimateCostUsd(body: XaiResponseBody): number {
  const usage = body.usage;
  const inputTok = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const outputTok = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const tokenCost = (inputTok / 1_000_000) * INPUT_USD_PER_MTOK + (outputTok / 1_000_000) * OUTPUT_USD_PER_MTOK;
  const toolCost = extractToolCallCount(body) * TOOL_CALL_USD;
  return tokenCost + toolCost;
}

/**
 * Run one discovery sweep: send the (vault-sourced) prompt with the x_search
 * tool enabled and get back the model's raw JSON text + a cost estimate.
 * Under X_DRY_RUN, returns a synthetic empty-candidates response so the rest
 * of the pipeline (filtering, queueing, alerting) can be exercised in tests
 * without spending real xAI budget.
 */
export async function runDiscoverySweep(env: XaiEnv, promptText: string): Promise<XaiSweepResult> {
  if (env.X_DRY_RUN === "1") {
    console.log("[x-agent DRY_RUN] would POST /v1/responses to xAI (x_search sweep)");
    return { rawText: "[]", costUsdEstimate: 0 };
  }
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not configured");

  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4.3",
      input: [{ role: "user", content: promptText }],
      tools: [{ type: "x_search" }],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`xai: /v1/responses error (${res.status}): ${text.slice(0, 500)}`);
  }

  let body: XaiResponseBody;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`xai: non-JSON success body: ${text.slice(0, 200)}`);
  }

  return { rawText: parseResponseText(body), costUsdEstimate: estimateCostUsd(body) };
}

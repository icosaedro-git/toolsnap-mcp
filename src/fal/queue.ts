/**
 * fal.ai asynchronous queue client (Fase 13.1b) — used only by video_generate
 * (1-6 minute renders don't fit inside a synchronous MCP tool call/client
 * timeout) and polled by media_job.
 *
 * Reference: https://fal.ai/docs/model-apis/model-endpoints/queue
 *   POST https://queue.fal.run/<model>              -> { request_id, status_url, response_url, cancel_url }
 *   GET  <status_url>?logs=1                        -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED, ... }
 *   GET  <response_url>                              -> the same shape fal.run would have returned synchronously
 */

import type { FalCallEnv } from "./client.js";

/**
 * Thrown by the queue helpers below when fal.ai returns a non-2xx HTTP
 * response, carrying the status code so media-job.ts (Fase 13.1c) can tell
 * a definitive client-side failure (4xx — the request/job is genuinely
 * invalid or gone) from a transient upstream blip (5xx) that shouldn't kill
 * a job that's still rendering. The message is identical to what a plain
 * Error would have carried (still starts with "fal.ai ...") so
 * error-alerts.ts's provider-prefix classification keeps working unchanged.
 */
export class FalQueueHttpError extends Error {
  constructor(
    message: string,
    public httpStatus: number
  ) {
    super(message);
    this.name = "FalQueueHttpError";
  }
}

export interface FalQueueSubmitResult {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
  queue_position?: number;
}

export type FalQueueStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export interface FalQueueStatusResult {
  status: FalQueueStatus;
  request_id: string;
  queue_position?: number;
  logs?: Array<{ message: string; timestamp: string }>;
}

function authHeaders(env: FalCallEnv): Record<string, string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  return { Authorization: `Key ${env.FAL_API_KEY}` };
}

/** Submit a request to fal's queue. Returns immediately with tracking URLs. */
export async function submitFalQueue(
  model: string,
  body: Record<string, unknown>,
  env: FalCallEnv,
  timeoutMs = 30_000
): Promise<FalQueueSubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://queue.fal.run/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(env) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      throw new FalQueueHttpError(
        `fal.ai queue submit (${model}) failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status
      );
    }
    return (await res.json()) as FalQueueSubmitResult;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fal.ai queue submit (${model}) timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Poll a queued request's status. */
export async function getFalQueueStatus(
  statusUrl: string,
  env: FalCallEnv,
  timeoutMs = 15_000
): Promise<FalQueueStatusResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${statusUrl}${statusUrl.includes("?") ? "&" : "?"}logs=0`, {
      headers: authHeaders(env),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      throw new FalQueueHttpError(
        `fal.ai queue status check failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status
      );
    }
    return (await res.json()) as FalQueueStatusResult;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fal.ai queue status check timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the final result of a COMPLETED queued request. */
export async function getFalQueueResult<T = unknown>(
  responseUrl: string,
  env: FalCallEnv,
  timeoutMs = 15_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(responseUrl, { headers: authHeaders(env), signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      throw new FalQueueHttpError(
        `fal.ai queue result fetch failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fal.ai queue result fetch timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

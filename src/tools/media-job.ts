import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { getFalQueueStatus, getFalQueueResult } from "../fal/queue.js";
import { downloadAndRehost } from "../fal/client.js";
import {
  getMediaJob,
  markMediaJobDone,
  markMediaJobRunning,
  markMediaJobFailed,
  markMediaJobRefunded,
} from "../fal/media-jobs.js";
import { refundDebit, microToUsdc } from "../x402/prepaid.js";

/**
 * media_job (Fase 13.1b) — free polling tool for video_generate's async
 * jobs. Idempotent: once a job is "done" it just returns the cached R2 URL
 * without touching fal again.
 *
 * Access control: job_id is a randomly-generated v4 UUID (122 bits of
 * entropy) — this server treats knowledge of the job_id itself as
 * sufficient authorization to poll it (the same model Stripe Checkout
 * sessions and most async job APIs use), rather than binding it to the
 * original caller's identity. Documented deliberate choice (see the plan)
 * — anyone who received the job_id from a video_generate response, or to
 * whom it was forwarded, can poll and read the result.
 *
 * REFUND ON FAILURE: if fal reports the render failed (or the job's status
 * URL/response is unusable), and the job's payment_type is refundable
 * (prepaid/api_key/oauth — both use the same debitBalance/refundDebit D1
 * ledger under the hood), this credits the exact original price_micro back
 * to refund_address and marks the job "refunded". Pay-per-call (x402) jobs
 * have no refund_address (settled on-chain at submit) — see video-generate.ts.
 */

const REFUNDABLE_PAYMENT_TYPES = new Set(["prepaid", "api_key", "oauth"]);

interface FalVideoResult {
  video?: { url: string; content_type?: string };
}

async function refundIfApplicable(
  env: Env,
  jobId: string,
  job: { payment_type: string; refund_address: string | null; refund_nonce: string | null; price_micro: number; tool: string }
): Promise<{ refunded: boolean; balanceUsdc?: string }> {
  if (
    !REFUNDABLE_PAYMENT_TYPES.has(job.payment_type) ||
    !job.refund_address ||
    !job.refund_nonce ||
    job.price_micro <= 0
  ) {
    return { refunded: false };
  }
  try {
    const balanceAfter = await refundDebit(
      env.PREPAID_DB,
      job.refund_address,
      BigInt(job.price_micro),
      job.tool,
      job.refund_nonce
    );
    await markMediaJobRefunded(env.PREPAID_DB, jobId);
    return { refunded: true, balanceUsdc: microToUsdc(balanceAfter) };
  } catch {
    // Refund failure must never crash the status response — the job stays
    // "failed" (not "refunded"), visible for manual reconciliation.
    return { refunded: false };
  }
}

async function runMediaJob(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.PREPAID_DB) throw new Error("D1 database is not configured (PREPAID_DB).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) throw new Error("`job_id` is required and must be a non-empty string");

  const job = await getMediaJob(env.PREPAID_DB, jobId);
  if (!job) throw new Error(`No job found for job_id "${jobId}"`);

  if (job.status === "done") {
    return JSON.stringify({ job_id: jobId, status: "done", result_url: job.result_url });
  }
  if (job.status === "failed" || job.status === "refunded") {
    return JSON.stringify({ job_id: jobId, status: job.status, error: job.error });
  }

  // status is "queued" or "running" — check fal.
  let falStatus: Awaited<ReturnType<typeof getFalQueueStatus>>;
  try {
    falStatus = await getFalQueueStatus(job.fal_status_url, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markMediaJobFailed(env.PREPAID_DB, jobId, message);
    const refund = await refundIfApplicable(env, jobId, job);
    return JSON.stringify({ job_id: jobId, status: refund.refunded ? "refunded" : "failed", error: message, ...refund });
  }

  if (falStatus.status === "IN_QUEUE" || falStatus.status === "IN_PROGRESS") {
    if (falStatus.status === "IN_PROGRESS" && job.status === "queued") {
      await markMediaJobRunning(env.PREPAID_DB, jobId);
    }
    return JSON.stringify({
      job_id: jobId,
      status: falStatus.status === "IN_QUEUE" ? "queued" : "running",
      queue_position: falStatus.queue_position,
    });
  }

  // COMPLETED — fetch the result and re-host it.
  try {
    const result = await getFalQueueResult<FalVideoResult>(job.fal_response_url, env);
    if (!result?.video?.url) {
      throw new Error("fal.ai queue result had no video URL");
    }
    const { url } = await downloadAndRehost(result.video.url, env, "media/video_generate", "mp4", "video/mp4");
    await markMediaJobDone(env.PREPAID_DB, jobId, url);
    return JSON.stringify({ job_id: jobId, status: "done", result_url: url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markMediaJobFailed(env.PREPAID_DB, jobId, message);
    const refund = await refundIfApplicable(env, jobId, job);
    return JSON.stringify({ job_id: jobId, status: refund.refunded ? "refunded" : "failed", error: message, ...refund });
  }
}

export const mediaJobTool: McpTool = {
  name: "media_job",
  description:
    'Poll the status/result of an async media job (currently video_generate). Free. Returns {status: "queued"|"running"|"done"|"failed"|"refunded", result_url?, error?}. Idempotent — once "done", repeated calls return the cached URL without contacting fal.ai again. If the render fails after a prepaid/API-key/OAuth charge, this automatically refunds the exact amount charged (pay-per-call/crypto has no refund path — see video_generate).',
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job_id returned by video_generate." },
    },
    required: ["job_id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run() {
    throw new Error("media_job is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.");
  },
  async runWithEnv(args, env) {
    return runMediaJob(args, env as Env);
  },
};

/**
 * D1 CRUD for the media_jobs table (Fase 13.1b — video_generate + media_job).
 * See migrations/0015_media_jobs.sql for the schema.
 */

export type MediaJobStatus = "queued" | "running" | "done" | "failed" | "refunded";

export interface MediaJobRow {
  job_id: string;
  payer: string;
  payment_type: string;
  refund_address: string | null;
  refund_nonce: string | null;
  tool: string;
  model: string;
  price_micro: number;
  fal_request_id: string;
  fal_status_url: string;
  fal_response_url: string;
  status: MediaJobStatus;
  result_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateMediaJobInput {
  jobId: string;
  payer: string;
  paymentType: string;
  refundAddress: string | null;
  refundNonce: string | null;
  tool: string;
  model: string;
  priceMicro: bigint;
  falRequestId: string;
  falStatusUrl: string;
  falResponseUrl: string;
}

export async function createMediaJob(db: D1Database, input: CreateMediaJobInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO media_jobs
        (job_id, payer, payment_type, refund_address, refund_nonce, tool, model, price_micro,
         fal_request_id, fal_status_url, fal_response_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
    .bind(
      input.jobId,
      input.payer,
      input.paymentType,
      input.refundAddress,
      input.refundNonce,
      input.tool,
      input.model,
      Number(input.priceMicro),
      input.falRequestId,
      input.falStatusUrl,
      input.falResponseUrl,
      now,
      now
    )
    .run();
}

export async function getMediaJob(db: D1Database, jobId: string): Promise<MediaJobRow | null> {
  const row = await db.prepare("SELECT * FROM media_jobs WHERE job_id = ?").bind(jobId).first<MediaJobRow>();
  return row ?? null;
}

export async function markMediaJobDone(db: D1Database, jobId: string, resultUrl: string): Promise<void> {
  await db
    .prepare("UPDATE media_jobs SET status = 'done', result_url = ?, updated_at = ? WHERE job_id = ?")
    .bind(resultUrl, Math.floor(Date.now() / 1000), jobId)
    .run();
}

export async function markMediaJobRunning(db: D1Database, jobId: string): Promise<void> {
  await db
    .prepare("UPDATE media_jobs SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'")
    .bind(Math.floor(Date.now() / 1000), jobId)
    .run();
}

export async function markMediaJobFailed(db: D1Database, jobId: string, error: string): Promise<void> {
  await db
    .prepare("UPDATE media_jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?")
    .bind(error.slice(0, 500), Math.floor(Date.now() / 1000), jobId)
    .run();
}

export async function markMediaJobRefunded(db: D1Database, jobId: string): Promise<void> {
  await db
    .prepare("UPDATE media_jobs SET status = 'refunded', updated_at = ? WHERE job_id = ?")
    .bind(Math.floor(Date.now() / 1000), jobId)
    .run();
}

-- Fase 13.1b — async media jobs (video_generate submit + media_job polling).
--
-- refund_address/refund_nonce carry enough to call refundDebit (src/x402/
-- prepaid.ts) if a job fails AFTER the initial charge already settled —
-- only meaningful for payment_type IN ('prepaid','api_key','oauth'), where
-- debitBalance() ran at submit time with that exact (address, nonce) pair.
-- payment_type 'x402' (pay-per-call) settles on-chain at submit and has no
-- refund path once settled — documented in video-generate.ts.
CREATE TABLE IF NOT EXISTS media_jobs (
  job_id TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  payment_type TEXT NOT NULL, -- 'prepaid' | 'api_key' | 'oauth' | 'x402' | 'admin' | 'whitelisted'
  refund_address TEXT,
  refund_nonce TEXT,
  tool TEXT NOT NULL DEFAULT 'video_generate',
  model TEXT NOT NULL,
  price_micro INTEGER NOT NULL,
  fal_request_id TEXT NOT NULL,
  fal_status_url TEXT NOT NULL,
  fal_response_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | refunded
  result_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
CREATE INDEX IF NOT EXISTS idx_media_jobs_payer ON media_jobs(payer);

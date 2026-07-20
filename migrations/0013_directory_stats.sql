-- Fase 25.3: daily snapshots of external directory/registry stats.
CREATE TABLE IF NOT EXISTS directory_stats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,          -- Unix epoch ms (snapshot time)
  source    TEXT    NOT NULL,          -- 'smithery' | 'glama' | future
  use_count INTEGER,                   -- NULL when the source exposes no usage metric (glama)
  listing   TEXT                       -- compact JSON: fields worth diffing (description, verified, isDeployed, attributes…)
);
CREATE INDEX IF NOT EXISTS idx_ds_src_ts ON directory_stats (source, ts DESC);

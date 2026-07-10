-- Fase 22.3: distinguish rows published via the X API (publisher cron) from
-- rows Unai published himself and marked done from the panel ("Publicado
-- manualmente" — copy the text, post it from X, register the result here so
-- metrics/dependents still work). Additive, no backfill needed: existing
-- published rows all went through the API and are backfilled to 'api'.

ALTER TABLE x_queue ADD COLUMN published_via TEXT; -- 'api' | 'manual' | NULL (not yet published)

UPDATE x_queue SET published_via = 'api' WHERE status = 'published' AND published_via IS NULL;

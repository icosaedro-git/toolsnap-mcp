-- Fase 25.8 — recortar rows-read en D1 (aviso de Cloudflare del 2026-08-28:
-- el free tier pasa a aplicar 5M filas leidas/dia el 2026-09-01).
--
-- Diagnostico: 3.45M filas leidas/dia, ~100% del panel /analytics. La tabla
-- tiene 39.6k filas de las que 33k (83%) son eventos `connect`, y CASI TODAS
-- las consultas del panel los descartan (`payment_type != 'connect'`) despues
-- de escanear la tabla entera: en la ventana de 30d hay 17.8k connects frente
-- a 3.2k eventos reales.
--
-- Indice parcial sobre ts que solo cubre los eventos NO-connect: las ~15
-- consultas del panel que filtran `payment_type != 'connect'` pasan de
-- escanear 39k filas a recorrer ~3.2k. Deliberadamente NO incluye
-- `internal = 0` en el WHERE del indice para que siga sirviendo con
-- ?include_internal=1 (el toggle del panel).
CREATE INDEX IF NOT EXISTS idx_ae_noconnect_ts
  ON analytics_events (ts)
  WHERE payment_type <> 'connect';

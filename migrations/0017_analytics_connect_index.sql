-- Fase 25.8 (segunda ronda) — cerrar las consultas del panel que el indice
-- parcial de 0016 no podia cubrir: las que SI necesitan los eventos
-- `connect` (connects_by_client) y las que filtran por tipos de error.
--
-- Indice compuesto y CUBRIENTE. Las cuatro columnas son exactamente las que
-- tocan esas consultas: dos igualdades (payment_type, internal), un rango
-- (ts) y el GROUP BY (client_name). Verificado con EXPLAIN QUERY PLAN sobre
-- la base remota: "SEARCH ... USING COVERING INDEX idx_ae_pay_int_ts_client
-- (payment_type=? AND internal=? AND ts>?)" — resuelve sin bajar a la tabla.
--
-- Por que este orden y no un indice parcial: el planificador de SQLite
-- prefiere igualdades a rangos, y con un indice parcial sobre (ts,
-- client_name) seguia eligiendo idx_ae_pay y leyendo 42k filas. Poniendo
-- payment_type primero elige este solo, sin necesidad de un INDEXED BY
-- (que ademas romperia la consulta si algun dia se borra el indice).
CREATE INDEX IF NOT EXISTS idx_ae_pay_int_ts_client
  ON analytics_events (payment_type, internal, ts, client_name);

-- idx_ae_pay (payment_type a secas, de 0002) queda subsumido: misma columna
-- lider, asi que toda consulta que lo usaba puede usar el nuevo. Ademas era
-- una TRAMPA para el planificador: sin histogramas (D1 no trae STAT4),
-- sqlite_stat1 solo guarda la media de filas por valor — unos 4.4k con 9
-- payment_types — cuando 'connect' vale por 33k, el 83% de la tabla. Con esa
-- estimacion falsa el planificador lo elegia para `payment_type = 'connect'`
-- y escaneaba casi todo. Borrarlo tambien ahorra una escritura de indice en
-- cada insert.
DROP INDEX IF EXISTS idx_ae_pay;

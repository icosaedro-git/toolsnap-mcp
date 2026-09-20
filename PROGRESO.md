# Progreso - Endpoint REST de ToolSnap

> Notas canonicas (plan, fases, hallazgos) en el vault:
> `unai-brain/Coding Ensemble/Endpoint REST de ToolSnap`. Aqui solo el resumen.

## Fase 3: revision, deploy y cierre (2026-09-20) - CERRADA

- Revisado el diff contra la tabla de vetos del plan: pasa entera.
- Desplegado en produccion: PR #91 (squash), sha `e76052f`.
- Lista de verificacion del plan contra produccion: 13 de 13.
  200 real, 404 en toda tool de pago y en las que no estan en la lista blanca,
  401 identico para tool de pago / gratuita / inventada, 405 en GET, 400 en
  cuerpo no-JSON y en argumentos malos, primer 429 en la llamada 122, y fila
  `free_tool` con `revenue_usdc 0` y latencia real en `analytics_events`.
- El test de conjuntos disjuntos se comprobo rompiendolo: con `screenshot_url`
  en `REST_ALLOWED` falla y sale con codigo 1, y `ci.yml` recorre `test/*.ts`
  en cada push y PR a `main`, antes de que `deploy.yml` corra.
- ADR-003 pasado a "aceptado" con fecha y sha.
- Hallazgo: el limitador `FREE_FETCH_RL` solo cuenta trafico secuencial (200
  llamadas en 20 s con 20 conexiones en paralelo no dan ningun 429). Es del
  binding de Workers, no de esta ruta: el camino gratuito de MCP se comporta
  igual. Anotado en ADR-003 §D5.

## Fase 1: ruta y doble cerrojo (2026-09-20)

- Rama `feat/rest-tools-endpoint`, commit `ccc795b`.
- `src/rest-tools.ts`, `test/rest-tools.ts`, despacho en `src/index.ts`,
  `/v1/tools/*` en `run_worker_first`.
- `npx tsx test/rest-tools.ts` y `npm run typecheck` en verde. Verificacion
  local con `wrangler dev`: la lista del plan entera (ver HALLAZGOS.md).

## Fase 2: cliente `tsnap` y la pinza con `jev`

- Sin hacer. La ruta no la necesita para estar viva; queda encolada.

# Hallazgos - fase 1 (endpoint REST)

1. `RATE_LIMITED_FETCH_TOOLS` (src/mcp/server.ts) no esta exportado y ese fichero
   quedaba fuera de alcance. En vez de duplicar el Set (riesgo de deriva), la ruta
   limita TODAS las tools de `REST_ALLOWED` con `FREE_FETCH_RL`, que es un
   superconjunto (las 11 iniciales estan en el Set original). Si en el futuro se
   anade a `REST_ALLOWED` una tool que no haga fetch, seguira limitada: es el lado
   seguro. Opcional: exportar el Set y usarlo directamente.
2. `PAID_TOOLS` (src/x402/*) tampoco se exporta, solo `requiresPayment()`. El test
   de conjuntos disjuntos usa `requiresPayment` sobre cada entrada (equivalente) y
   una lista fija de tools de pago conocidas para que el test no pase en vacio.
3. No existe script `npm test`. Los tests son `npx tsx test/<fichero>.ts`. Typecheck:
   `npm run typecheck`.
4. Las llamadas con error de tool se registran como `free_tool` (como pide el
   encargo), no `tool_error`, para no disparar el pager de Telegram por argumentos
   malos de un cliente; el detalle queda como `rest_error: ...` (saneado por writeEvent).
5. Antes de desplegar: `wrangler secret put REST_API_TOKEN`. Sin el secreto la ruta
   responde 401 a todo (falla cerrada).
6. No se ejecuto la verificacion con `wrangler dev` (129 llamadas seguidas, fila en
   analytics_events, 200 real en fetch_extract): solo tests con mocks. Pendiente.

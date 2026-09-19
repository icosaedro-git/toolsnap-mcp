/**
 * Corpus etiquetado de `tool_error` reales — la ÚNICA copia.
 *
 * Sale de los incidentes que documenta src/alerts/error-classification.ts: las
 * 14 alertas de la revisión del 2026-09-17 (9 de validación del llamante, 5 del
 * sitio destino), las dos falsas alarmas del 2026-09-18, y los fallos nuestros
 * que SÍ tienen que paginar. Cada cadena es la redacción literal de un
 * `throw new Error(...)` de src/tools/*.ts o de un wrapper de fetch.
 *
 * Lo consumen dos sitios y por eso vive aquí en vez de dentro de uno de ellos:
 *
 *  - test/alert-noise.ts — comprueba que las regex siguen clasificando igual.
 *  - scripts/typesafe-experiment.mts — mide si un modelo de TypeSafe llega a la
 *    misma respuesta SIN que le demos los patrones.
 *
 * Al añadir un caso nuevo, añadirlo aquí: si las dos copias divergen, el
 * experimento deja de decir nada sobre el pager de verdad.
 */

export type ToolErrorCase = readonly [detail: string, expected: "caller" | "upstream" | "internal"];

export const TOOL_ERROR_CASES: readonly ToolErrorCase[] = [
  ["Provide either `url` or `csv`.", "caller"],
  ["`url` is required.", "caller"],
  ["count must be an integer between 1 and 100.", "caller"],
  ['`headers` key "User-Agent" is not allowed. Allowed keys: authorization.', "caller"],
  ["text too long — max 2000 characters per call", "caller"],
  ["Tool not found: __probe_1234__", "caller"],
  ["Fetch failed: HTTP 404 Not Found for https://example.com", "upstream"],
  ["Failed to fetch URL: Too many redirects (max 5).", "upstream"],
  ["Failed to fetch sitemap: The operation was aborted", "upstream"],
  ["This URL returned very little extractable text despite a sizeable response.", "upstream"],
  ["No response body.", "upstream"],
  ["rate_limited", "upstream"],
  ["fal.ai: request timed out after 60s", "internal"],
  ["ScreenshotOne: capture timed out", "internal"],
  ["Settle timed out on-chain", "internal"],
  ["R2 bucket is not configured (SCREENSHOTS_BUCKET).", "internal"],
  ["csv_query is env-aware and must be called via runWithEnv", "internal"],
  ["Tool foo requires env but none was provided.", "internal"],
  ["fal.ai kokoro returned an unexpected response (no audio URL)", "internal"],
  ['Failed to fetch URL: URL host "10.0.0.1" is not allowed (private/reserved IP address).', "internal"],
  ["Cannot read properties of undefined (reading 'map')", "internal"],
  // Fase 25.10 — valores invalidos que escribio el llamante.
  ["Invalid JSON: Unexpected token 'x', \"xyz\" is not valid JSON", "caller"],
  ["Invalid query: Expected ] at position 7. This is JSONPath-lite: ...", "caller"],
  ['Invalid filter "@.price": no comparison found.', "caller"],
  ["Invalid regex pattern: Unterminated group", "caller"],
  ["Invalid base64 input: could not decode.", "caller"],
  ["`schema` is not valid JSON.", "caller"],
  ['Unknown model "sdxl". Allowed: ltx-fast, kling-pro', "caller"],
  ["Maximum 100 keywords per call; got 140", "caller"],
  ["Column(s) not found: precio. Available: price, qty", "caller"],
  ['No job found for job_id "nope"', "caller"],
  ['Cannot parse "ayer" as a date.', "caller"],
  // Fase 25.10 — el destino sirvio otro formato del que se le pidio. Esta
  // primera es EXACTAMENTE la falsa alarma del 2026-09-18.
  [
    "Invalid JSON from the URL: the server returned an HTML page, not JSON (often a landing page, a cookie/login wall, or an error page served with status 200). Use `fetch_extract` to read it as text, `html_table_extract` if the data is in a <table>, or check that the URL points at the JSON endpoint itself.",
    "upstream",
  ],
  ["Not a valid PDF file: the URL returned an HTML page, not a PDF", "upstream"],
  ['Response does not look like CSV (first line: "<!doctype html>").', "upstream"],
  ["No <table> elements found.", "upstream"],
  ["Rendered page produced no extractable text (it may require login, or block automation).", "upstream"],
  ["Response had no readable body.", "upstream"],
  ["Failed to fetch source: HTTP 404", "upstream"],
  // ... pero bajar el resultado del proveedor SI es cosa nuestra.
  ["Failed to download result from fal.ai CDN: HTTP 500", "internal"],
  ["Failed to download Microlink capture: HTTP 502", "internal"],
];

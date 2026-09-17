/**
 * Clasificacion compartida de los `tool_error` — quien tiene el problema.
 *
 * Fase 24.6 empezo con una sola pregunta ("¿fue culpa del sitio destino?") y
 * una LISTA NEGRA de prefijos que silenciaba el pager. Esa forma obliga a
 * perseguir cada mensaje de error nuevo: la revision del 2026-09-17 encontro
 * 14 alertas en 5 dias y NINGUNA accionable — 9 eran errores de validacion
 * que el propio llamante pidio de vuelta ("Provide either `url` or `csv`"),
 * 5 eran el sitio destino portandose mal (bucle de redirects, muro de bots).
 *
 * Fase 25.9 invierte la pregunta. Un `tool_error` cae siempre en una de tres
 * clases y solo UNA merece despertar a nadie:
 *
 *  - "caller"   → el agente llamo mal a la tool (falta un argumento, la URL
 *                 no es una URL, el header no esta permitido). El mensaje ES
 *                 la respuesta util para el llamante. Nunca es un fallo de
 *                 ToolSnap y nunca pagina.
 *  - "upstream" → la tool funciono, el destino no (4xx/5xx, SPA, bucle de
 *                 redirects, muro de bots, timeout, sin cuerpo de respuesta).
 *                 Tampoco es un fallo de ToolSnap y tampoco pagina.
 *  - "internal" → todo lo demas. Un proveedor de COGS que falla (fal.ai,
 *                 ScreenshotOne, DataForSEO, Microlink), un binding o secreto
 *                 sin configurar, una tool env-aware mal cableada, una
 *                 excepcion inesperada. ESTO si pagina.
 *
 * El default se invierte a proposito: antes se paginaba salvo coincidencia con
 * la lista negra, ahora la unica clase que pagina es la que no reconocemos
 * como ruido. Un error interno nuevo sigue llegando a Telegram (cae en
 * "internal" por descarte), pero un mensaje de validacion nuevo ya no.
 *
 * Consumidores: el pager (error-alerts.ts) y el panel (queries.ts,
 * error_rate_by_tool). Comparten este modulo justamente para que no vuelvan a
 * divergir — lo que el panel pinta en rojo es EXACTAMENTE lo que pagina.
 */

export type ToolErrorClass = "caller" | "upstream" | "internal";

/**
 * Se comprueban PRIMERO, antes que nada: son fallos nuestros cuya redaccion
 * colisiona con las frases genericas de validacion de abajo ("must be",
 * "is required"). Sin esta lista, un binding sin configurar o una tool
 * env-aware mal cableada se clasificarian como error del llamante y
 * desaparecerian del pager — justo el fallo de despliegue que mas urge ver.
 */
const INTERNAL_PATTERNS: readonly RegExp[] = [
  // "fal.ai API key is not configured (FAL_API_KEY)", "R2 bucket is not
  // configured (SCREENSHOTS_BUCKET)", "D1 database is not configured (...)".
  /\bis not configured \(/,
  // "<tool> is env-aware and must be called via runWithEnv", "... handled by
  // the server dispatcher (runWithEnv)" — cableado roto en el dispatcher.
  /\benv-aware\b/,
  /\brunWithEnv\b/,
  // "Tool <name> requires env but none was provided."
  /\brequires env but none was provided\b/,
  // "fal.ai <x> returned an unexpected response (no image URL)" y hermanos:
  // el proveedor contesto algo que no sabemos leer.
  /\breturned an unexpected response\b/,
];

/**
 * Errores de argumentos que devolvemos al llamante a proposito. Anclados a la
 * redaccion real de los `throw new Error(...)` de src/tools/*.ts.
 */
const CALLER_PATTERNS: readonly RegExp[] = [
  // "Provide either `url` or `csv`." / "... not both."
  /^Provide either /,
  // "`url` is required.", "`prompt` is required and must be a non-empty string"
  /\bis required\b/,
  // "`url` must start with http://...", "text must be a string.",
  // "count must be an integer between 1 and 100.", "duration must be \"5\"..."
  /\bmust (?:be|start with|contain|match|have)\b/,
  // "urls[0] must be an http:// or https:// string" (ya cubierto arriba) y
  // "`headers` key \"User-Agent\" is not allowed. Allowed keys: ..."
  /\bis not allowed\b/,
  // "text too long — max 2000 characters per call", "duration too large — max 10s"
  /\btoo (?:long|large|many characters)\b/,
  // El llamante pidio una tool que no existe. `tools/list` y `callTool`
  // resuelven ambos del MISMO registro (src/tools/index.ts), asi que un nombre
  // que llega aqui NUNCA es uno que anunciemos: es el agente inventandoselo o
  // un escaner probando (`__verifymcp_auth_probe_<hash>__`). No hay deriva de
  // catalogo posible por esta via.
  /^Tool not found: /,
];

/**
 * DELIBERADAMENTE fuera de CALLER_PATTERNS, aunque tecnicamente lo sea: el
 * guardia SSRF rechazando una IP privada/reservada ("URL host "10.0.0.1" is
 * not allowed (private/reserved IP address)") es una senal de seguridad, no un
 * argumento mal escrito. Cae en "internal" por descarte y por tanto pagina —
 * una vez por hora y por tool, y en los 5 dias de la revision del 2026-09-17
 * no hubo ni un intento, asi que el coste en ruido es cero y la senal vale la
 * pena. Si algun dia empieza a sonar a diario, es que alguien esta sondeando
 * la red interna a proposito: sigue siendo exactamente lo que hay que saber.
 *
 * Nota para el futuro: `is not allowed` en CALLER_PATTERNS cubre el caso de
 * los headers prohibidos, pero la comprobacion de arriba se hace ANTES por
 * orden de las listas; este comentario existe para que nadie "simplifique"
 * moviendo el patron SSRF al grupo del llamante.
 */
// SIN anclar al inicio a proposito: el mensaje llega envuelto por el wrapper
// de fetch ("Failed to fetch URL: URL host \"169.254.169.254\" is not allowed
// (private/reserved IP address)."), y ese prefijo lo clasificaria como
// upstream si solo mirasemos el principio de la cadena.
const SECURITY_PATTERNS: readonly RegExp[] = [/URL host .* is not allowed \(/];

/**
 * El destino fallo o se porto mal. La tool hizo su trabajo.
 */
const UPSTREAM_PATTERNS: readonly RegExp[] = [
  // "Fetch failed: HTTP 404 Not Found for https://..."
  /^Fetch failed: HTTP \d/,
  // Pagina renderizada en cliente que no podemos parsear sin navegador.
  /client-side rendered \(SPA\)/,
  // Nuestro propio rate limit del free tier — esperado, no cobrado.
  /^rate_limited$/,
  // Fase 25.9 — TODO lo que sale de nuestros wrappers de fetch
  // (src/tools/*.ts: "Failed to fetch URL:", "Failed to fetch:", "Failed to
  // fetch feed:", "Failed to fetch sitemap:", "Failed to read response
  // body:"). Por construccion son fallos al ALCANZAR el destino: DNS, reset de
  // conexion, abort, timeout, bucle de redirects ("Too many redirects (max
  // 5)", 4 de las 14 alertas del 2026-09-17). Antes solo se reconocian los
  // aborts/timeouts y el resto paginaba.
  //
  // ANCLADO al prefijo del wrapper a proposito, igual que en Fase 25.6: los
  // errores de proveedor empiezan por su propio nombre ("fal.ai: request timed
  // out", "ScreenshotOne: capture timed out") y "Settle timed out on-chain"
  // empieza por "Settle" — ninguno casa con este prefijo y los tres siguen
  // paginando, como exige F14. Nunca convertir esto en una busqueda suelta.
  /^Failed to (?:fetch(?: URL| feed| sitemap)?|read response body): /,
  // "Too many redirects (max 5)." lanzado sin envolver.
  /^Too many redirects \(max \d+\)/,
  // Muro de bots: 200 OK con cuerpo grande y casi nada de texto extraible.
  /returned very little extractable text/,
  // El destino contesto sin cuerpo.
  /^No response body\.?$/,
];

/** A que clase pertenece este `detail`. Sin detail no podemos afirmar ruido: "internal". */
export function classifyToolError(detail?: string | null): ToolErrorClass {
  if (!detail) return "internal";
  if (INTERNAL_PATTERNS.some((re) => re.test(detail))) return "internal";
  if (SECURITY_PATTERNS.some((re) => re.test(detail))) return "internal";
  if (UPSTREAM_PATTERNS.some((re) => re.test(detail))) return "upstream";
  if (CALLER_PATTERNS.some((re) => re.test(detail))) return "caller";
  return "internal";
}

/** El destino fallo, no nosotros. */
export function isUpstreamError(detail?: string | null): boolean {
  return classifyToolError(detail) === "upstream";
}

/** El agente llamo mal a la tool: el mensaje es para el, no para nosotros. */
export function isCallerError(detail?: string | null): boolean {
  return classifyToolError(detail) === "caller";
}

/**
 * La unica clase que justifica una notificacion inmediata: ni ruido del
 * llamante ni del destino.
 */
export function isOurError(detail?: string | null): boolean {
  return classifyToolError(detail) === "internal";
}

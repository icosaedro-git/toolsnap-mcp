import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";
import { classifyToolError } from "./error-classification.js";
import { isProbeClient } from "../analytics/surface.js";

/**
 * Fase 25.9 — vigilancia AGREGADA del servidor. El pager por evento
 * (error-alerts.ts) solo sabe mirar una llamada aislada, y por eso se le
 * escapan justo los dos fallos que de verdad requieren atencion:
 *
 *  1. Una tool que ha dejado de funcionar para TODO el mundo. Vista llamada a
 *     llamada cada error parece ruido del llamante o del destino; vista como
 *     tasa, "el 90% de las llamadas reales a fetch_extract fallan" es
 *     inequivoco. Es tambien la senal que pide "ajusta el MCP": si el 100% de
 *     los agentes llama mal a una tool, el problema es nuestro esquema o
 *     nuestra descripcion, no ellos.
 *
 *  2. Silencio. Nada falla porque no llega nada. Un Worker caido, una ruta
 *     rota o el rail de OAuth fuera de servicio no generan ni un evento de
 *     error — generan un vacio, y un vacio no dispara ningun pager por evento.
 *     Es exactamente la forma del incidente del CMS que estuvo 9 dias roto sin
 *     que nadie se enterara.
 *
 * Corre sobre el Cron Trigger de 5 minutos que ya existe (el publisher de X),
 * sin anadir un tercer trigger. Coste en D1: dos consultas que resuelven por
 * indice (idx_ae_noconnect_ts / idx_ae_ts), del orden de decenas de filas
 * leidas por pasada — irrelevante frente al presupuesto de 5M/dia que vigila
 * Fase 25.8.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Ventana y umbrales de "esta tool esta rota". */
const BREAKAGE_WINDOW_MS = 6 * HOUR_MS;
/** Por debajo de esto no hay muestra suficiente para hablar de una tasa. */
const BREAKAGE_MIN_CALLS = 5;
const BREAKAGE_PCT = 80;
const BREAKAGE_DEDUPE_SEC = 12 * 60 * 60;

/**
 * Silencio total. En los 14 dias previos al 2026-09-17 NO hubo ni una sola
 * hora sin eventos (minimo 15/h, mediana 27/h), asi que tres horas seguidas a
 * cero no es una racha tranquila: o el servidor no responde o la ruta de
 * escritura de analitica esta rota. Las dos cosas hay que mirarlas.
 */
const SILENCE_WINDOW_MS = 3 * HOUR_MS;
const SILENCE_DEDUPE_SEC = 6 * 60 * 60;
const SILENCE_FLAG_TTL_SEC = 7 * 24 * 60 * 60;
const SILENCE_FLAG_KEY = "health:silence:active";

export interface WindowRow {
  tool_name: string;
  payment_type: string;
  detail: string | null;
  client_name: string | null;
  client: string | null;
}

/** Deja alertar una sola vez por ventana TTL. Sin KV alerta igualmente (best effort). */
async function shouldAlert(kv: KVNamespace | undefined, key: string, ttlSec: number): Promise<boolean> {
  if (!kv) return true;
  if (await kv.get(key)) return false;
  await kv.put(key, "1", { expirationTtl: ttlSec });
  return true;
}

/**
 * Tools cuya tasa de error entre llamantes REALES (sin escaneres, sin trafico
 * interno) ha cruzado el umbral en la ventana. Devuelve tambien el detail mas
 * repetido, que es lo que convierte la alerta en accionable.
 */
export function findBrokenTools(rows: WindowRow[]): Array<{
  tool: string;
  total: number;
  errors: number;
  pct: number;
  topDetail: string | null;
  kinds: string;
}> {
  const byTool = new Map<
    string,
    { total: number; errors: number; details: Map<string, number>; kinds: Set<string> }
  >();

  for (const row of rows) {
    // Los escaneres de directorios llaman a proposito sin argumentos: incluirlos
    // haria que toda tool "de catalogo" pareciese rota permanentemente.
    if (isProbeClient(row.client_name, row.client)) continue;
    const agg = byTool.get(row.tool_name) ?? {
      total: 0,
      errors: 0,
      details: new Map<string, number>(),
      kinds: new Set<string>(),
    };
    agg.total += 1;
    if (row.payment_type === "tool_error") {
      agg.errors += 1;
      agg.kinds.add(classifyToolError(row.detail));
      const d = row.detail ?? "(sin detalle)";
      agg.details.set(d, (agg.details.get(d) ?? 0) + 1);
    }
    byTool.set(row.tool_name, agg);
  }

  const broken = [];
  for (const [tool, agg] of byTool) {
    if (agg.total < BREAKAGE_MIN_CALLS) continue;
    const pct = Math.round((agg.errors / agg.total) * 100);
    if (pct < BREAKAGE_PCT) continue;
    const topDetail =
      Array.from(agg.details.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    broken.push({
      tool,
      total: agg.total,
      errors: agg.errors,
      pct,
      topDetail,
      kinds: Array.from(agg.kinds).sort().join("+") || "—",
    });
  }
  return broken.sort((a, b) => b.errors - a.errors);
}

export async function checkServerHealth(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();

  const [windowRows, silence] = await Promise.all([
    env.PREPAID_DB.prepare(
      `SELECT tool_name, payment_type, detail, client_name, client
         FROM analytics_events
        WHERE ts >= ? AND payment_type <> 'connect' AND internal = 0
        LIMIT 5000`
    )
      .bind(nowMs - BREAKAGE_WINDOW_MS)
      .all<WindowRow>(),
    env.PREPAID_DB.prepare(`SELECT count(*) AS n FROM analytics_events WHERE ts >= ?`)
      .bind(nowMs - SILENCE_WINDOW_MS)
      .first<{ n: number }>(),
  ]);

  // --- 1. Silencio ---------------------------------------------------------
  const eventsInWindow = silence?.n ?? 0;
  if (eventsInWindow === 0) {
    await env.X402_NONCES.put(SILENCE_FLAG_KEY, String(nowMs), {
      expirationTtl: SILENCE_FLAG_TTL_SEC,
    });
    if (await shouldAlert(env.X402_NONCES, "health:silence:alert", SILENCE_DEDUPE_SEC)) {
      await sendTelegram(
        env,
        [
          `🔴 *ToolSnap sin trafico*`,
          `Ni un solo evento en las ultimas ${SILENCE_WINDOW_MS / HOUR_MS}h.`,
          `Lo normal son 15-30/h sin bajar nunca a cero, asi que esto apunta a servidor caido, ruta rota o la escritura de analitica fallando.`,
          `Comprueba https://mcp.toolsnap.app/mcp y los logs del Worker (wrangler tail).`,
        ].join("\n")
      );
    }
  } else if (await env.X402_NONCES.get(SILENCE_FLAG_KEY)) {
    // Solo puede sonar despues de un corte real: avisa de que ya paso.
    await env.X402_NONCES.delete(SILENCE_FLAG_KEY);
    await sendTelegram(env, `✅ *ToolSnap* — trafico restablecido (${eventsInWindow} eventos en las ultimas ${SILENCE_WINDOW_MS / HOUR_MS}h).`);
  }

  // --- 2. Tools rotas ------------------------------------------------------
  for (const b of findBrokenTools(windowRows.results ?? [])) {
    if (!(await shouldAlert(env.X402_NONCES, `health:broken:${b.tool}`, BREAKAGE_DEDUPE_SEC))) continue;
    await sendTelegram(
      env,
      [
        `🔴 *tool fallando para todo el mundo* · \`${b.tool}\``,
        `${b.errors}/${b.total} llamadas reales fallidas en ${BREAKAGE_WINDOW_MS / HOUR_MS}h (*${b.pct}%*)`,
        `clase: ${b.kinds}`,
        b.topDetail ? `detail mas comun: ${b.topDetail}` : null,
        b.kinds === "caller"
          ? `Todos son errores de argumentos: el esquema o la descripcion de la tool esta induciendo a los agentes a llamarla mal. Toca ajustar el MCP.`
          : null,
      ]
        .filter((l): l is string => l !== null)
        .join("\n")
    );
  }
}

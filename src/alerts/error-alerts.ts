import { sendTelegram, type TelegramEnv } from "./telegram.js";
import { isUpstreamError } from "./error-classification.js";

/**
 * Real-time Telegram alerts for failed/rejected analytics events, called from
 * writeEvent() right after the event is persisted. Fire-and-forget: wrapped
 * in try/catch + ctx.waitUntil so an alert failure never affects the tool
 * call that originated it. Safe before configuration — sendTelegram no-ops
 * without bot token + chat id.
 *
 * Throttled per (type, tool) via KV so a burst of the same failure sends one
 * message, not one per call.
 */

interface AlertEnv extends TelegramEnv {
  X402_NONCES?: KVNamespace;
}

interface ErrorEventParams {
  toolName: string;
  paymentType: string;
  payer: string;
  client?: string | null;
  detail?: string | null;
}

const HOUR_SEC = 60 * 60;
const MONEY_TYPES = new Set(["settle_failed", "deposit_failed", "fiat_deposit_failed"]);

/** Provider tools prefix their thrown errors with the provider name (see src/tools/*). */
const PROVIDER_PREFIXES = ["fal.ai", "ScreenshotOne", "Microlink", "DataForSEO"];

function classifyProvider(detail?: string | null): string | null {
  if (!detail) return null;
  return PROVIDER_PREFIXES.find((p) => detail.startsWith(p)) ?? null;
}

function truncatePayer(payer: string): string {
  if (payer.startsWith("0x") && payer.length > 12) {
    return `${payer.slice(0, 6)}…${payer.slice(-4)}`;
  }
  return payer;
}

/** Returns true (and marks the key) only the first time it's called within the TTL window. */
async function shouldAlert(kv: KVNamespace | undefined, key: string, ttlSec: number): Promise<boolean> {
  if (!kv) return true; // no dedupe store available — alert anyway (best effort)
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, "1", { expirationTtl: ttlSec });
  return true;
}

export function maybeAlertError(env: AlertEnv, ctx: ExecutionContext, params: ErrorEventParams): void {
  ctx.waitUntil(
    (async () => {
      try {
        const { toolName, paymentType, payer, client, detail } = params;

        // User-side rejections already surfaced to the caller and visible in the panel.
        if (
          paymentType === "prepaid_rejected" ||
          paymentType === "prepaid_insufficient" ||
          paymentType === "api_key_rejected" ||
          paymentType === "api_key_insufficient"
        ) {
          return;
        }

        // Normal x402 discovery handshake (agent probing without a wallet yet), not an error.
        if (paymentType === "402_rejected" && detail === "no_payment_payload") return;

        // Our own admin-key testing/diagnostics, not a customer-facing failure.
        if (paymentType === "tool_error" && payer === "admin") return;

        // Upstream target-site failures: the tool worked, the destination URL
        // refused (429/403/404/5xx), is a JS-rendered SPA, or the caller hit
        // our own free-tier rate limit (expected, uncharged error paths).
        // Still logged and visible in the panel, but not a ToolSnap
        // malfunction — paging Telegram for these buries real errors once
        // traffic grows. Provider (COGS) errors keep alerting: they carry a
        // provider prefix, not "Fetch failed: HTTP". Shared with the panel's
        // error-rate-by-tool split (queries.ts) so the two never diverge
        // again — see error-classification.ts.
        if (paymentType === "tool_error" && isUpstreamError(detail)) {
          return;
        }

        let icon = "🟠";
        let key: string;
        let ttlSec: number;
        if (MONEY_TYPES.has(paymentType)) {
          icon = "🔴";
          key = `alert:err:${paymentType}`;
          ttlSec = 5 * 60;
        } else if (paymentType === "tool_error") {
          key = `alert:err:tool_error:${toolName}`;
          ttlSec = HOUR_SEC;
        } else {
          // 402_rejected with a real payment-verification failure (not a bare handshake).
          key = `alert:err:402v:${toolName}`;
          ttlSec = HOUR_SEC;
        }

        if (!(await shouldAlert(env.X402_NONCES, key, ttlSec))) return;

        const provider = classifyProvider(detail);
        const lines = [
          `${icon} *${paymentType}* · \`${toolName}\``,
          provider ? `proveedor: ${provider}` : null,
          detail ? `detail: ${detail}` : null,
          `payer: ${truncatePayer(payer)}${client ? ` · client: ${client}` : ""}`,
        ].filter((l): l is string => l !== null);

        await sendTelegram(env, lines.join("\n"));
      } catch {
        // Alerts must never break the caller.
      }
    })()
  );
}

interface PaywallHitParams {
  toolName: string;
  clientIp: string;
  client?: string | null;
}

const PAYWALL_ALERT_TTL_SEC = 6 * HOUR_SEC;

/**
 * Fase 24.5 — signal, not error: an agent hit the x402 paywall with no
 * payment payload at all (no wallet yet). This is a lost-conversion
 * opportunity, not a ToolSnap malfunction — maybeAlertError already
 * suppresses it entirely (see the `no_payment_payload` check above). Sends
 * a single 🟡 Telegram message per IP per 6h window: it fires on the FIRST
 * hit and shouldAlert dedupes the rest, so a burst reads as one business
 * signal instead of either silence or per-call noise. Repeat volume is
 * visible in the panel's 402_no_wallet breakdown, not here.
 */
export function maybeAlertPaywallHit(env: AlertEnv, ctx: ExecutionContext, params: PaywallHitParams): void {
  ctx.waitUntil(
    (async () => {
      try {
        const { toolName, clientIp, client } = params;

        if (!(await shouldAlert(env.X402_NONCES, `alert:paywall:${clientIp}`, PAYWALL_ALERT_TTL_SEC))) return;

        const lines = [
          `🟡 agente golpeando el muro de pago sin wallet`,
          `tool: \`${toolName}\``,
          `ip: ${clientIp}${client ? ` · client: ${client}` : ""}`,
          `conversión en riesgo — aún no ha llamado a wallet_setup ni ido al checkout`,
        ];

        await sendTelegram(env, lines.join("\n"));
      } catch {
        // Alerts must never break the caller.
      }
    })()
  );
}

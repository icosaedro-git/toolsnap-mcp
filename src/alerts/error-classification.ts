/**
 * Fase 24.6 — shared classification for "not our fault" tool_error details:
 * the destination site refused the request (4xx/5xx), is a JS-rendered SPA
 * we can't parse, or the caller got rate-limited. Extracted from
 * error-alerts.ts (which already used this to suppress Telegram paging for
 * these cases) so the analytics panel's error-rate-by-tool can apply the
 * exact same rule instead of drifting from it — that drift is what let
 * json_query/csv_query/pdf_text_extract page on every upstream 404 for a
 * while (see the "Fetch failed: HTTP" prefix fix).
 */
export function isUpstreamError(detail?: string | null): boolean {
  if (!detail) return false;
  return (
    /^Fetch failed: HTTP \d/.test(detail) ||
    detail.includes("client-side rendered (SPA)") ||
    detail === "rate_limited"
  );
}

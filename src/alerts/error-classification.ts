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
    detail === "rate_limited" ||
    // Fase 25.6 — our own fetch timeout firing on a slow/unresponsive target,
    // always at exactly the configured deadline. Same class as an upstream
    // 5xx: the tool worked, the destination didn't answer in time. Paged 4
    // times on 2026-07-26 from one real caller sweeping hundreds of sites,
    // where a handful of slow hosts is expected, not a ToolSnap fault. Still
    // logged and visible in the panel's error-rate-by-tool.
    //
    // ANCHORED to our own fetch wrappers on purpose (see src/tools/*.ts:
    // "Failed to fetch URL:", "Failed to fetch:", "Failed to fetch feed:",
    // "Failed to fetch sitemap:"). The first cut of this rule matched the bare
    // word "timeout" anywhere and silently swallowed `fal.ai: request timed
    // out`, `ScreenshotOne: capture timed out` and — worst — `Settle timed out
    // on-chain`: COGS and money failures that F14 requires to keep paging.
    // Never widen this to an unanchored timeout match.
    /^Failed to fetch(?: URL| feed| sitemap)?: (?:The operation was aborted|The user aborted a request|.*\btimed out\b)/i.test(
      detail
    )
  );
}

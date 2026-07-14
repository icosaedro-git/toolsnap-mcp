/**
 * SSRF hardening shared by every tool that fetches a caller-supplied URL.
 *
 * Workers can't do DNS lookups before fetch(), so this can't stop DNS
 * rebinding — Cloudflare's edge itself doesn't route to private ranges,
 * which is the real backstop. This is defense in depth: it rejects the
 * obvious cases (literal loopback/private IPs, internal hostnames) cheaply,
 * and re-checks every redirect hop so a public URL can't 302 its way into
 * one of those ranges.
 */

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".internal", ".local"];
const MAX_REDIRECTS = 5;

function isIPv4(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/** Value of the address's first 16-bit group (hextet), or null if unparseable. */
function firstHextet(host: string): number | null {
  const first = host.split(":")[0];
  if (first === "") return 0; // address starts with "::" — leading group is all-zero
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified

  const first = firstHextet(h);
  if (first !== null) {
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique local
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96). The URL parser normalizes these to
  // "::ffff:XXXX:YYYY" (two hex groups encoding the 4 IPv4 bytes) rather than
  // keeping a dotted-decimal suffix, so decode that form and check the
  // embedded address.
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const g1 = parseInt(mapped[1], 16);
    const g2 = parseInt(mapped[2], 16);
    const ipv4 = `${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}

/**
 * Parses and validates a caller-supplied URL: must be http(s), and must not
 * resolve to a loopback/private/link-local address or an internal hostname.
 * Throws a caller-facing Error with a clear reason on rejection.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("`url` must be a valid absolute URL (http:// or https://).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("`url` must start with http:// or https://");
  }

  // URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]") — strip them.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || BLOCKED_HOSTNAME_SUFFIXES.some((suf) => hostname.endsWith(suf))) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (local/internal hostname).`);
  }
  if (isIPv4(hostname) && isPrivateIPv4(hostname)) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (private/reserved IP address).`);
  }
  if (hostname.includes(":") && isPrivateIPv6(hostname)) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (private/reserved IP address).`);
  }

  return parsed;
}

/**
 * Drop-in replacement for fetch() on caller-supplied URLs: validates the URL
 * (and every redirect hop) against assertPublicHttpUrl before following it.
 * Redirects are followed manually — `redirect: "follow"` would let fetch
 * chase a Location header we never got to inspect.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let current = assertPublicHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current.toString(), { ...init, redirect: "manual" });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) return response;

    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
    }
    response.body?.cancel().catch(() => {});
    current = assertPublicHttpUrl(new URL(location, current).toString());
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
}

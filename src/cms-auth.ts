/**
 * GitHub OAuth for the blog CMS (Decap at /admin) — same-origin edition.
 *
 * Replaces the orphan `cms-auth-toolsnap` worker (deployed ad hoc 2026-07-05,
 * never version-controlled, secrets never set → CMS login silently broken for
 * 9 days; see memory `project-cms-auth-worker`). Living here fixes all three
 * root causes at once:
 *   - same-origin: the OAuth popup and the CMS tab now share
 *     https://mcp.toolsnap.app, so the postMessage handshake can't be broken
 *     by cross-origin browser/extension policies (the failure mode that
 *     survived every bisection attempt on 2026-07-14);
 *   - versioned + CI-deployed: no more "secrets missing since creation with
 *     nobody noticing" — and handleCmsAuthStart fails LOUDLY when they are;
 *   - state validation: the old worker skipped it entirely (OAuth CSRF).
 *
 * Both routes live under /admin/*, which Cloudflare Access already gates at
 * the edge — that's deliberate: only an Access-authenticated browser session
 * can even start the flow. GitHub's redirect back to /admin/callback is a
 * top-level navigation, so it carries both the Access cookie and our
 * SameSite=Lax state cookie.
 *
 * Secrets (wrangler secret put ...): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET —
 * from the GitHub OAuth App whose callback URL is
 * https://mcp.toolsnap.app/admin/callback.
 */

interface CmsAuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const STATE_COOKIE = "cms_oauth_state";
const STATE_TTL_SECONDS = 600;

/**
 * The exact popup↔tab handshake Decap CMS 3.x expects (contract captured
 * byte-for-byte from the old worker, which Decap demonstrably understood):
 * the popup announces "authorizing:github" to its opener, waits for the CMS
 * tab to answer, and only then posts the final result to the answerer's
 * origin.
 */
function handshakePage(result: "success" | "error", payload: Record<string, string>, humanText: string): string {
  const message = `authorization:github:${result}:${JSON.stringify(payload)}`;
  return `<!doctype html>
<html><body>
<script>
(function() {
  function receiveMessage(e) {
    window.removeEventListener("message", receiveMessage, false);
    window.opener.postMessage(${JSON.stringify(message)}, e.origin);
  }
  window.addEventListener("message", receiveMessage, false);
  window.opener.postMessage("authorizing:github", "*");
})();
</script>
${humanText}
</body></html>`;
}

function htmlResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function errorPage(message: string, extraHeaders: Record<string, string> = {}): Response {
  return htmlResponse(
    handshakePage("error", { message }, `Authorization failed: ${message}`),
    extraHeaders
  );
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Expire the state cookie — sent on every callback response, win or lose. */
const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** GET /admin/auth — start the OAuth dance: set state cookie, bounce to GitHub. */
export function handleCmsAuthStart(request: Request, env: CmsAuthEnv): Response {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response(
      "CMS OAuth is not configured: missing GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET secrets.",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const state = crypto.randomUUID();
  const redirectUri = `${new URL(request.url).origin}/admin/callback`;

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "repo");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/admin; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

/** GET /admin/callback — validate state, swap the code for a token, hand it to the CMS tab. */
export async function handleCmsAuthCallback(request: Request, env: CmsAuthEnv): Promise<Response> {
  const clear = { "Set-Cookie": CLEAR_STATE_COOKIE };

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return errorPage("CMS OAuth is not configured on the server.", clear);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, STATE_COOKIE);

  if (!code) return errorPage("Missing code from GitHub.", clear);
  if (!state || !expectedState || state !== expectedState) {
    return errorPage("Invalid OAuth state.", clear);
  }

  let tokenData: { access_token?: string; error_description?: string; error?: string };
  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    tokenData = await tokenResponse.json();
  } catch (err) {
    return errorPage(
      `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      clear
    );
  }

  if (!tokenData.access_token) {
    return errorPage(tokenData.error_description ?? tokenData.error ?? "GitHub returned no token.", clear);
  }

  return htmlResponse(
    handshakePage(
      "success",
      { token: tokenData.access_token, provider: "github" },
      "Authorized. Finishing sign-in…"
    ),
    clear
  );
}

/**
 * GitHub OAuth provider for Decap CMS (github backend), Cloudflare Worker.
 *
 * Standard Decap/Netlify CMS "external OAuth client" protocol:
 *   1. Decap opens a popup at  GET /auth?provider=github&site_id=...
 *      -> we redirect (302) to GitHub's authorize screen.
 *   2. GitHub redirects the popup back to GET /callback?code=...&state=...
 *      -> we exchange the code for an access_token (server-side, so the
 *         GitHub client secret never reaches the browser) and return a tiny
 *         HTML page that postMessages the token back to the opener window.
 *
 * Decap listens for a window message of the exact form
 *   "authorization:github:success:{"token":"...","provider":"github"}"
 * This is not ToolSnap-specific — it's the same handshake Decap/Netlify CMS
 * has used for years, documented under "External OAuth Clients".
 */

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

function randomState(): string {
  return crypto.randomUUID();
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const state = randomState();
      const redirectUri = `${url.origin}/callback`;
      const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
      authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", "repo,user");
      authorizeUrl.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: { Location: authorizeUrl.toString() },
      });
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return html(renderResult("error", "Missing code from GitHub."));
      }

      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const data = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!data.access_token) {
        return html(renderResult("error", data.error_description ?? data.error ?? "No access_token returned by GitHub."));
      }

      return html(renderResult("success", JSON.stringify({ token: data.access_token, provider: "github" })));
    }

    return new Response("cms-auth-toolsnap: GitHub OAuth provider for Decap CMS. Routes: /auth, /callback.", {
      status: 200,
    });
  },
};

/**
 * Standard Decap/Netlify CMS popup handshake:
 *  - the popup announces itself with "authorizing:github" (targetOrigin "*",
 *    safe here because it carries no secret);
 *  - it then waits for the opener's reply message purely to learn a
 *    trustworthy target origin;
 *  - only then does it postMessage the real payload (token or error) to
 *    that specific origin, never to "*".
 */
function renderResult(status: "success" | "error", payload: string): string {
  const message = status === "success" ? `authorization:github:success:${payload}` : `authorization:github:error:${JSON.stringify({ message: payload })}`;
  return `<!doctype html>
<html><body>
<script>
(function() {
  function receiveMessage(e) {
    window.removeEventListener("message", receiveMessage, false);
    window.opener.postMessage(
      ${JSON.stringify(message)},
      e.origin
    );
  }
  window.addEventListener("message", receiveMessage, false);
  window.opener.postMessage("authorizing:github", "*");
})();
</script>
${status === "success" ? "Authorized. You can close this window." : `Authorization failed: ${escapeHtml(payload)}`}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

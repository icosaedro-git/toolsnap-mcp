# cms-auth-toolsnap

Standalone GitHub OAuth provider for the Decap CMS at `mcp.toolsnap.app/admin`. Deployed as its own Cloudflare Worker (separate from `toolsnap-mcp`) so it never shares a deploy with the MCP server or the site's static assets.

Live at: `https://cms-auth-toolsnap.icosaedro-academy.workers.dev`

## Setup (one-time)

1. Create a dedicated GitHub OAuth App at <https://github.com/settings/developers> → **New OAuth App**:
   - Application name: `ToolSnap MCP CMS` (or similar)
   - Homepage URL: `https://mcp.toolsnap.app`
   - Authorization callback URL: `https://cms-auth-toolsnap.icosaedro-academy.workers.dev/callback`
   - Upload the ToolSnap logo as the app icon.
2. Copy the generated **Client ID** and (after generating one) **Client secret**.
3. Set them as Worker secrets:
   ```bash
   cd cms-auth
   npx wrangler secret put GITHUB_CLIENT_ID --config ./wrangler.toml
   npx wrangler secret put GITHUB_CLIENT_SECRET --config ./wrangler.toml
   ```

## Deploy

Always pass `--config` explicitly — running plain `wrangler deploy` from this
folder can pick up the parent repo's `wrangler.jsonc` instead (seen in
practice: it silently redeployed the main `toolsnap-mcp` Worker rather than
this one). Confirmed fix:

```bash
cd cms-auth
npx wrangler deploy --config ./wrangler.toml
```

## Protocol

Standard Decap/Netlify CMS "external OAuth client" handshake — `GET /auth` redirects to GitHub's authorize screen, `GET /callback` exchanges the code for a token server-side and posts it back to the Decap popup via `window.opener.postMessage`. Nothing ToolSnap-specific; see `src/index.ts` for the ~80 lines of implementation.

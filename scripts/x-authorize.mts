/**
 * One-time PIN-based OAuth1.0a authorization for an X account (Fase 22.1).
 *
 * OAuth1.0a access tokens don't expire (see nota 10 §3 / vault plan D3),
 * so this only needs to run once per account (product @ToolSnapMCP,
 * personal @icosaedro_one) to mint the token/secret pair that goes into
 * X_ACCESS_TOKEN_(PRODUCT|PERSONAL) / X_ACCESS_TOKEN_SECRET_(PRODUCT|PERSONAL).
 *
 * Run:  X_API_KEY=... X_API_SECRET=... npx tsx scripts/x-authorize.mts
 *
 * Prints an authorize URL — open it LOGGED IN AS THE ACCOUNT YOU'RE
 * AUTHORIZING (product or personal), approve the app, and paste the PIN
 * X shows back here. Prints the resulting secrets to store with
 * `wrangler secret put`.
 */
import { createInterface } from "node:readline/promises";
import { getAccessToken, getRequestToken } from "../src/x-agent/oauth1.js";

async function main() {
  const consumerKey = process.env.X_API_KEY;
  const consumerSecret = process.env.X_API_SECRET;
  if (!consumerKey || !consumerSecret) {
    console.error("Set X_API_KEY and X_API_SECRET (the X app's consumer key/secret) before running.");
    process.exit(1);
  }

  console.log("Requesting a request token...");
  const { oauthToken, oauthTokenSecret } = await getRequestToken(consumerKey, consumerSecret);

  const authorizeUrl = `https://api.twitter.com/oauth/authorize?oauth_token=${oauthToken}`;
  console.log(`\nOpen this URL LOGGED IN AS THE ACCOUNT YOU WANT TO AUTHORIZE:\n\n  ${authorizeUrl}\n`);
  console.log("Approve the app, then copy the PIN X shows you.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question("PIN: ")).trim();
  rl.close();

  console.log("\nExchanging PIN for a permanent access token...");
  const { accessToken, accessTokenSecret, screenName, userId } = await getAccessToken(
    consumerKey,
    consumerSecret,
    oauthToken,
    oauthTokenSecret,
    pin
  );

  console.log(`\nAuthorized as @${screenName} (user id ${userId}).\n`);
  console.log("Store these (pick PRODUCT or PERSONAL to match the account you just authorized):\n");
  console.log(`  wrangler secret put X_ACCESS_TOKEN_<PRODUCT|PERSONAL>`);
  console.log(`    -> ${accessToken}`);
  console.log(`  wrangler secret put X_ACCESS_TOKEN_SECRET_<PRODUCT|PERSONAL>`);
  console.log(`    -> ${accessTokenSecret}`);
  console.log(`  wrangler secret put X_USER_ID_<PRODUCT|PERSONAL>`);
  console.log(`    -> ${userId}`);
  console.log("\nRepeat this script for the other account before deploying.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

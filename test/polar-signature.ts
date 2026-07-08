/**
 * Regression test for the Fase 26 webhook-401 incident: Polar signs with the
 * raw UTF-8 bytes of the FULL dashboard secret (literal `whsec_` prefix
 * included), not with the base64-decoded key the Standard Webhooks spec
 * describes. This byte-exactly replays Polar's signing path
 * (server/polar/webhook/tasks.py: StandardWebhook(base64(utf8(secret)))) and
 * asserts verifyPolarSignature accepts it — plus rejection of wrong secrets
 * and stale timestamps, and acceptance of a spec-compliant secret (fallback).
 *
 * Run: npx tsx test/polar-signature.ts
 */
import { createHmac } from "node:crypto";
import { verifyPolarSignature } from "../src/fiat/polar.js";

function polarSign(secret: string, id: string, ts: number, payload: string): string {
  const key = Buffer.from(secret, "utf-8"); // Polar: key = utf8 bytes of the full secret
  const mac = createHmac("sha256", key)
    .update(Buffer.from(`${id}.${ts}.${payload}`, "utf-8"))
    .digest("base64");
  return `v1,${mac}`;
}

const secret = "whsec_c8G2kR1XlN0pQ7sT9uV3wY5zA2bC4dE6"; // whsec_ + random token, NOT base64 of a key
const id = "1c8284fd-07a2-428a-be41-5d9c3cc4b896";
const ts = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({
  type: "order.paid",
  data: { customer: { name: "Unai Rodríguez" }, amount: 100 }, // multibyte char like the real payload
});

const ok = await verifyPolarSignature(
  payload,
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": polarSign(secret, id, ts, payload),
  }),
  secret
);
console.log("Polar-style signature verifies:", ok);

const bad = await verifyPolarSignature(
  payload,
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": polarSign(secret, id, ts, payload),
  }),
  "whsec_wrongsecret"
);
console.log("Wrong secret rejected:", !bad);

const stale = await verifyPolarSignature(
  payload,
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(ts - 4000),
    "webhook-signature": polarSign(secret, id, ts - 4000, payload),
  }),
  secret
);
console.log("Stale timestamp rejected:", !stale);

// Spec-compliant fallback: secret whose post-prefix part IS base64 of the key.
const keyBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const specSecret = "whsec_" + keyBytes.toString("base64");
const specOk = await verifyPolarSignature(
  payload,
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${createHmac("sha256", keyBytes).update(`${id}.${ts}.${payload}`).digest("base64")}`,
  }),
  specSecret
);
console.log("Spec-compliant fallback verifies:", specOk);

if (!ok || bad || stale || !specOk) {
  console.error("FAIL");
  process.exit(1);
}
console.log("ALL PASS");

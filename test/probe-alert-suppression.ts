/**
 * Regression test for the Telegram-alerts-vs-panel mismatch: the analytics
 * panel excludes probe/scanner traffic (IS_PROBE_SQL in
 * src/analytics/queries.ts, built from PROBE_CLIENTS + PROBE_NAME_PATTERNS in
 * src/analytics/surface.ts) but maybeAlertError previously alerted on every
 * tool_error regardless of client, so a probe hitting a tool with an empty
 * payload paged Telegram while staying invisible in the panel. isProbeClient
 * is the JS twin of IS_PROBE_SQL that maybeAlertError now checks before
 * alerting — this asserts it classifies exact names, LIKE-style patterns
 * (case-insensitively), real clients, and null/empty client_name correctly.
 *
 * Run: npx tsx test/probe-alert-suppression.ts
 */
import assert from "node:assert";
import { isProbeClient } from "../src/analytics/surface.js";

// Exact incident case: agentstatus-probe matches the "%probe%" pattern.
assert.strictEqual(isProbeClient("agentstatus-probe"), true, "agentstatus-probe should be a probe");

// Exact match in PROBE_CLIENTS.
assert.strictEqual(isProbeClient("glama"), true, "glama should be a probe (PROBE_CLIENTS)");

// Another "%probe%" pattern match.
assert.strictEqual(isProbeClient("smithery-probe"), true, "smithery-probe should be a probe");

// "%-audit" pattern, case-insensitive.
assert.strictEqual(isProbeClient("Some-Audit"), true, "Some-Audit should be a probe (%-audit, case-insensitive)");

// "%scanner%" pattern, case-insensitive.
assert.strictEqual(isProbeClient("BigScanner"), true, "BigScanner should be a probe (%scanner%, case-insensitive)");

// Real clients must never be misclassified as probes.
assert.strictEqual(isProbeClient("claude-code"), false, "claude-code should NOT be a probe");
assert.strictEqual(
  isProbeClient("python-script"),
  false,
  "python-script (python-requests UA) should NOT be a probe"
);

// Null/empty client_name is not a probe (mirrors the panel treating NULL as real demand).
assert.strictEqual(isProbeClient(null), false, "null client_name should NOT be a probe");
assert.strictEqual(isProbeClient(""), false, "empty client_name should NOT be a probe");

console.log("OK");

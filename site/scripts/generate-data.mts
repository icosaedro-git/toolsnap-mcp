// Pulls the live tool/pricing/recipe registry straight from the Worker source
// (../../src/**) so the website can never drift out of sync with what the
// MCP server actually serves. Run automatically before dev/build.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tools } from "../../src/tools/index.js";
import { requiresPayment, getToolPrice } from "../../src/x402/middleware.js";
import { FAMILIES, CORE_TOOLS, NOTES } from "../../src/tools/catalog.js";
import { RECIPES } from "../../src/recipes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "data");
mkdirSync(OUT_DIR, { recursive: true });

// getToolPrice reads env vars for the flat-rate fallback; the three paid
// tools all have explicit overrides so this only matters as a default.
const fakeEnv = { X402_PRICE_USDC: "0.02", X402_PREPAID_PRICE_USDC: "0.01" } as any;

const toolData = tools.map((t) => {
  const paid = requiresPayment(t.name);
  const price = paid ? getToolPrice(t.name, fakeEnv) : null;
  return {
    name: t.name,
    description: t.description,
    tier: paid ? ("paid" as const) : ("free" as const),
    price_usdc: price ? Number(price.payPerCallStr) : null,
    prepaid_price_usdc: price ? Number(price.prepaidStr) : null,
    notes: NOTES[t.name] ?? null,
  };
});

const toolsByName = new Map(toolData.map((t) => [t.name, t]));

const families = Object.entries(FAMILIES).map(([id, fam]) => {
  const famTools = fam.tools.map((name) => toolsByName.get(name)).filter(Boolean);
  const freeCount = famTools.filter((t) => t!.tier === "free").length;
  return {
    id,
    label: fam.label,
    oneLiner: fam.oneLiner,
    tools: famTools,
    toolCount: famTools.length,
    freeCount,
  };
});

const totalTools = toolData.length;
const freeTools = toolData.filter((t) => t.tier === "free").length;
const paidTools = toolData.filter((t) => t.tier === "paid").length;

writeFileSync(
  join(OUT_DIR, "tools.json"),
  JSON.stringify({ total: totalTools, free: freeTools, paid: paidTools, coreCount: CORE_TOOLS.length, tools: toolData }, null, 2)
);

writeFileSync(join(OUT_DIR, "families.json"), JSON.stringify(families, null, 2));

writeFileSync(
  join(OUT_DIR, "recipes.json"),
  JSON.stringify(
    RECIPES.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      audience: r.audience,
      tools: r.tools,
      est_cost: r.est_cost,
      prompt: r.prompt,
    })),
    null,
    2
  )
);

console.log(
  `[generate-data] ${totalTools} tools (${freeTools} free / ${paidTools} paid), ${families.length} families, ${RECIPES.length} recipes -> site/src/data/*.json`
);

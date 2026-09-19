/**
 * Mide si TypeSafe clasificaría los `tool_error` igual que nuestras regex,
 * ANTES de dejarle tocar el pager.
 *
 * No cambia nada en producción y no se ejecuta en CI. Es el paso que la propia
 * documentación de TypeSafe pide dar primero: correr consultas baratas contra
 * datos propios y proponer cambios a partir de lo que salga, en vez de creerse
 * los umbrales de un cookbook.
 *
 * Lo que compara:
 *
 *   corpus etiquetado (test/fixtures/tool-errors.ts, 41 casos reales)
 *     ├── classifyToolErrorDetailed()  ← las regex de hoy
 *     └── TypeSafe jev-latest          ← las preguntas de src/typesafe/questions.ts
 *
 * Las regex aciertan el 100% de este corpus POR CONSTRUCCIÓN: los patrones se
 * escribieron mirando estos mismos mensajes. Así que un empate no dice nada
 * bueno de las regex. Lo que se está midiendo es otra cosa: si un modelo que
 * NUNCA ha visto los patrones llega a la misma respuesta solo leyendo el
 * mensaje. Si lo hace, entonces también acertará en el mensaje nuevo de la
 * semana que viene, que es justo donde las regex fallan y suena el pager.
 *
 * La fila que de verdad importa es la del "default por descarte": los casos que
 * hoy se clasifican como `internal` sin casar con ningún patrón. Ahí es donde
 * nacieron las dos falsas alarmas del 2026-09-18.
 *
 * Uso:
 *   export TYPESAFE_API_KEY=...           # https://console.typesafe.ai/keys
 *   npx tsx scripts/typesafe-experiment.mts            # corpus entero
 *   npx tsx scripts/typesafe-experiment.mts --limit 8  # barato, para probar
 *   npx tsx scripts/typesafe-experiment.mts --unmatched-only
 */
import { systemOne } from "../src/typesafe/client.js";
import { classifyToolErrorDetailed } from "../src/alerts/error-classification.js";
import {
  ERROR_TRIAGE_QUESTIONS,
  ERROR_SILENCE_MIN_CONFIDENCE,
  ERROR_SILENCE_MAX_ACTIONABLE,
  errorTriageState,
} from "../src/typesafe/questions.js";
import { TOOL_ERROR_CASES } from "../test/fixtures/tool-errors.js";

// jev-1.13: $0.042 por millón de tokens de entrada; la salida no se cobra
// (https://docs.typesafe.ai/models). Verificar antes de citar este número.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.log(
    [
      "TYPESAFE_API_KEY no está definida — no hay nada que medir.",
      "",
      "  export TYPESAFE_API_KEY=...   # https://console.typesafe.ai/keys",
      "  npx tsx scripts/typesafe-experiment.mts --limit 8",
      "",
      "El corpus entero son 41 llamadas de ~250 tokens: del orden de $0.0005 en total.",
    ].join("\n")
  );
  process.exit(0);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const unmatchedOnly = args.includes("--unmatched-only");

interface Row {
  detail: string;
  expected: string;
  regex: string;
  regexMatched: boolean;
  model: string;
  confidence: number;
  actionable: number;
  inputTokens: number;
}

const rows: Row[] = [];
let failures = 0;

const selected = TOOL_ERROR_CASES.filter(([detail]) =>
  unmatchedOnly ? !classifyToolErrorDetailed(detail).matched : true
).slice(0, limit);

console.log(`=== Triaje de tool_error: regex vs TypeSafe (${selected.length} casos) ===\n`);

for (const [detail, expected] of selected) {
  const { cls: regex, matched } = classifyToolErrorDetailed(detail);
  try {
    const res = await systemOne(
      { TYPESAFE_API_KEY: apiKey },
      errorTriageState({ detail }),
      ERROR_TRIAGE_QUESTIONS
    );
    rows.push({
      detail,
      expected,
      regex,
      regexMatched: matched,
      model: res.answers.error_class.choice,
      confidence: res.answers.error_class.confidence,
      actionable: res.answers.actionable.noul,
      inputTokens: res.usage?.input_tokens ?? 0,
    });
  } catch (e) {
    failures++;
    console.log(`  !  ${(e as Error).message}`);
    console.log(`     ← ${detail.slice(0, 70)}`);
  }
}

if (rows.length === 0) {
  console.log("\nNinguna llamada llegó a completarse.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Desacuerdos, uno a uno — es lo que hay que leer, no el porcentaje
// ---------------------------------------------------------------------------
const disagreements = rows.filter((r) => r.model !== r.expected);

console.log(`Desacuerdos con la etiqueta humana: ${disagreements.length}/${rows.length}\n`);
for (const r of disagreements) {
  const flag = r.regexMatched ? "regex-anclada" : "DEFAULT-POR-DESCARTE";
  console.log(`  esperado=${r.expected.padEnd(8)} modelo=${r.model.padEnd(8)} conf=${r.confidence.toFixed(2)} actionable=${r.actionable.toFixed(2)}  [${flag}]`);
  console.log(`    ${r.detail.slice(0, 100)}`);
}

// ---------------------------------------------------------------------------
// El subconjunto que importa
// ---------------------------------------------------------------------------
function accuracy(subset: Row[]): string {
  if (subset.length === 0) return "n/a";
  const ok = subset.filter((r) => r.model === r.expected).length;
  return `${ok}/${subset.length} (${((ok / subset.length) * 100).toFixed(0)}%)`;
}

const unmatched = rows.filter((r) => !r.regexMatched);
const matchedRows = rows.filter((r) => r.regexMatched);

console.log("\n--- Acuerdo con la etiqueta ---");
console.log(`  todo el corpus         ${accuracy(rows)}`);
console.log(`  casos con regex anclada ${accuracy(matchedRows)}`);
console.log(`  DEFAULT POR DESCARTE    ${accuracy(unmatched)}   ← el que decide si esto vale para algo`);

// ---------------------------------------------------------------------------
// Qué pasaría con el pager si se cableara con los umbrales actuales
// ---------------------------------------------------------------------------
console.log(
  `\n--- Simulación del pager (silenciar si conf>=${ERROR_SILENCE_MIN_CONFIDENCE} y actionable<=${ERROR_SILENCE_MAX_ACTIONABLE}) ---`
);
let silencedCorrectly = 0;
let silencedWrongly = 0;
let stillNoisy = 0;
for (const r of unmatched) {
  const wouldSilence =
    r.model !== "internal" &&
    r.confidence >= ERROR_SILENCE_MIN_CONFIDENCE &&
    r.actionable <= ERROR_SILENCE_MAX_ACTIONABLE;
  if (!wouldSilence) {
    if (r.expected !== "internal") stillNoisy++;
    continue;
  }
  if (r.expected === "internal") {
    silencedWrongly++;
    console.log(`  ✗✗ SILENCIARÍA UN FALLO REAL: ${r.detail.slice(0, 80)}`);
  } else {
    silencedCorrectly++;
  }
}
console.log(`  falsas alarmas evitadas        ${silencedCorrectly}`);
console.log(`  falsas alarmas que seguirían   ${stillNoisy}`);
console.log(`  fallos reales silenciados      ${silencedWrongly}   ← tiene que ser 0`);

// ---------------------------------------------------------------------------
// Coste
// ---------------------------------------------------------------------------
const totalInput = rows.reduce((s, r) => s + r.inputTokens, 0);
console.log("\n--- Coste ---");
console.log(`  llamadas            ${rows.length}${failures ? ` (+${failures} fallidas)` : ""}`);
console.log(`  tokens de entrada   ${totalInput} (${Math.round(totalInput / rows.length)} de media)`);
console.log(`  estimado            $${(totalInput * USD_PER_INPUT_TOKEN).toFixed(6)}`);
console.log(
  `  por 1.000 errores   $${(((totalInput / rows.length) * 1000) * USD_PER_INPUT_TOKEN).toFixed(4)}`
);

process.exit(silencedWrongly > 0 ? 1 : 0);

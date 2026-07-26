/**
 * Fase 25.7 — chunk-boundary fuzz for StreamingCSVParser.
 *
 * `csv_query_xl` feeds this parser one network chunk at a time (up to 100 MB
 * streamed, never buffered whole), so any field/quote that straddles a
 * push() boundary is a real, reachable code path — but every test so far
 * (Fase 25.6/25.6b/25.7) only ever called push() once with the whole CSV.
 * The stateful flags (`inQuotes`, `pendingQuoteDecision`, `afterClosingQuote`,
 * `skipLFAfterCR`, `sawContentThisRow`) were reasoned through by hand for
 * cross-chunk survival but never verified mechanically, per Fable's 2026-07-26
 * adversarial review of PRs #78/#79.
 *
 * Method: for each tricky CSV, parse it whole (one push + end) and treat that
 * as ground truth. Then re-parse it split at every possible single boundary,
 * and again split into 1-character chunks (the worst case: every byte a
 * separate push()). Any divergence is a real chunk-boundary bug.
 *
 * Run: npx tsx test/csv-chunk-boundaries.ts
 */
import { StreamingCSVParser } from "../src/tools/csv-query.js";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name} — ${detail}`);
    failed++;
  }
}

function parseChunks(chunks: string[]): string[][] {
  const parser = new StreamingCSVParser();
  const rows: string[][] = [];
  for (const chunk of chunks) rows.push(...parser.push(chunk));
  rows.push(...parser.end());
  return rows;
}

const TRICKY_CSVS: Array<{ label: string; csv: string }> = [
  { label: "comillas escapadas", csv: 'name\n"say ""hi"""\n' },
  { label: "coma entrecomillada", csv: 'name,city\n"Smith, John",Madrid\n' },
  { label: "espacio antes de comilla de apertura", csv: 'name, "city, region"\nAlice, "Madrid, ES"\n' },
  { label: "espacio tras comilla de cierre", csv: 'name,city\n"Alice" , "Madrid"\n' },
  { label: "CRLF con espacios", csv: "a, b\r\n1, 2\r\n3, 4\r\n" },
  { label: "última fila sin salto de línea", csv: "a, b\n1, 2\n3, 4" },
  { label: 'campo "" final sin salto de línea', csv: 'name\nAlice\n""' },
  { label: "texto malformado tras comilla de cierre", csv: 'name,val\n"a" b c,x\n' },
  { label: "múltiples filas mixtas", csv: 'a,b,c\n1,"two, three",4\n"five","six""seven",8\n\n9,10,11\n' },
  { label: "campo vacío entre comas", csv: "a,b,c\n1,,3\n" },
];

console.log("=== Fase 25.7 CSV chunk-boundary fuzz ===\n");

for (const { label, csv } of TRICKY_CSVS) {
  const whole = JSON.stringify(parseChunks([csv]));

  // Cada punto de corte posible: dos push() por split.
  let allSplitsMatch = true;
  let firstMismatchAt = -1;
  for (let cut = 1; cut < csv.length; cut++) {
    const split = JSON.stringify(parseChunks([csv.slice(0, cut), csv.slice(cut)]));
    if (split !== whole) {
      allSplitsMatch = false;
      firstMismatchAt = cut;
      break;
    }
  }
  assert(
    `${label}: estable en cada punto de corte (2 trozos)`,
    allSplitsMatch,
    firstMismatchAt >= 0 ? `diverge al cortar en el índice ${firstMismatchAt} (carácter "${csv[firstMismatchAt]}")` : ""
  );

  // Peor caso: un push() por carácter.
  const charByChar = JSON.stringify(parseChunks(csv.split("")));
  assert(`${label}: estable con push() carácter a carácter`, charByChar === whole, `whole=${whole}\nchar-by-char=${charByChar}`);
}

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
  process.exit(1);
}

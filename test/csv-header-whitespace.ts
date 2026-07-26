/**
 * Unit tests for Fase 25.6 — CSV fields with whitespace after the comma.
 *
 * `name, city, n` (a space after each comma, how a large share of real CSVs are
 * written) parsed the header as `name`, ` city`, ` n`. Consecuencias reales,
 * todas reproducidas antes de tocar el parser el 2026-07-26:
 *   - `select: "city"`  → "Column(s) not found: city. Available: name,  city, n"
 *     (nombra como disponible justo la columna que dice que falta).
 *   - `select: " city"` → falla también: los nombres pedidos ya venían
 *     trimmeados, así que la columna era literalmente inalcanzable.
 *   - `filter: "city = Madrid"` → **0 filas, sin error**. Respuesta falsa.
 *   - `sort_by: "city"`         → ignorado en silencio.
 *
 * El arreglo trimea solo campos NO entrecomillados (`skipinitialspace`), así
 * que un espacio deliberado dentro de comillas se conserva.
 *
 * Run: npx tsx test/csv-header-whitespace.ts
 */
import { csvQueryTool } from "../src/tools/csv-query.js";

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

type Res = { ok: true; out: string } | { ok: false; err: string };

async function q(csv: string, args: Record<string, unknown>): Promise<Res> {
  try {
    const out = await (csvQueryTool as unknown as {
      runWithEnv(a: Record<string, unknown>, e: unknown): Promise<string>;
    }).runWithEnv({ csv, ...args }, {});
    return { ok: true, out: String(out) };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

const SPACED = "name, city, n\nAlice, Madrid, 5\nBob, Bilbao, 20\n";
const CLEAN = "name,city,n\nAlice,Madrid,5\nBob,Bilbao,20\n";

console.log("=== Fase 25.6 CSV whitespace ===\n");

console.log("Cabecera con espacio tras la coma");
{
  const cols = await q(SPACED, { limit: 1 });
  assert(
    "las columnas salen sin espacios",
    cols.ok && JSON.parse(cols.out).meta.columns.join(",") === "name,city,n",
    cols.ok ? JSON.stringify(JSON.parse(cols.out).meta.columns) : cols.err
  );

  const sel = await q(SPACED, { select: "city" });
  assert("select por el nombre natural funciona", sel.ok, sel.ok ? "" : sel.err.slice(0, 80));

  const filt = await q(SPACED, { filter: "city = Madrid" });
  assert(
    "filter devuelve la fila en vez de 0 en silencio",
    filt.ok && JSON.parse(filt.out).meta.returned_rows === 1,
    filt.ok ? `returned_rows=${JSON.parse(filt.out).meta.returned_rows}` : filt.err
  );

  const num = await q(SPACED, { filter: "n > 10" });
  assert(
    "filter numérico funciona",
    num.ok && JSON.parse(num.out).rows[0].name === "Bob",
    num.ok ? JSON.stringify(JSON.parse(num.out).rows) : num.err
  );

  const sorted = await q(SPACED, { sort_by: "n", sort_dir: "desc" });
  assert(
    "sort_by ordena de verdad",
    sorted.ok && JSON.parse(sorted.out).rows[0].name === "Bob",
    sorted.ok ? JSON.stringify(JSON.parse(sorted.out).rows[0]) : sorted.err
  );

  // El caso exacto del caller real: cabecera de años con espacio.
  const air = await q("Month, 1958, 1959\nJAN, 340, 360\n", { select: "1958" });
  assert(
    "el caso real (AirPassengers) deja seleccionar el año",
    air.ok && JSON.parse(air.out).rows[0]["1958"] === "340",
    air.ok ? JSON.stringify(JSON.parse(air.out).rows) : air.err.slice(0, 80)
  );
}

console.log("\nSin regresión");
{
  const clean = await q(CLEAN, { filter: "city = Bilbao" });
  assert(
    "un CSV sin espacios se comporta igual que antes",
    clean.ok && JSON.parse(clean.out).rows[0].name === "Bob",
    clean.ok ? JSON.stringify(JSON.parse(clean.out).rows) : clean.err
  );

  // Espacios DENTRO de comillas son deliberados y se conservan.
  const quoted = await q('name,note\n"  padded  ","x"\n', { limit: 1 });
  assert(
    "los espacios dentro de comillas se conservan",
    quoted.ok && JSON.parse(quoted.out).rows[0].name === "  padded  ",
    quoted.ok ? JSON.stringify(JSON.parse(quoted.out).rows[0]) : quoted.err
  );

  // Una coma dentro de comillas sigue siendo parte del valor.
  const comma = await q('name,city\n"Smith, John",Madrid\n', { limit: 1 });
  assert(
    "una coma entrecomillada no parte el campo",
    comma.ok && JSON.parse(comma.out).rows[0].name === "Smith, John",
    comma.ok ? JSON.stringify(JSON.parse(comma.out).rows[0]) : comma.err
  );

  // Comillas escapadas ("") intactas.
  const esc = await q('name\n"say ""hi"""\n', { limit: 1 });
  assert(
    'las comillas escapadas ("") se preservan',
    esc.ok && JSON.parse(esc.out).rows[0].name === 'say "hi"',
    esc.ok ? JSON.stringify(JSON.parse(esc.out).rows[0]) : esc.err
  );

  // Espacio ANTES de la comilla de apertura: es relleno del delimitador, no
  // contenido. Es el caso más común de campo entrecomillado (contiene una coma)
  // y el primer intento de F25.6 lo dejaba sin trimear.
  const beforeQuote = await q('name, "city, region"\nAlice, "Madrid, ES"\n', { limit: 1 });
  assert(
    "el espacio antes de la comilla de apertura no entra en el campo",
    beforeQuote.ok && JSON.parse(beforeQuote.out).meta.columns[1] === "city, region",
    beforeQuote.ok ? JSON.stringify(JSON.parse(beforeQuote.out).meta.columns) : beforeQuote.err
  );
  assert(
    "y el valor entrecomillado tampoco lo arrastra",
    beforeQuote.ok && JSON.parse(beforeQuote.out).rows[0]["city, region"] === "Madrid, ES",
    beforeQuote.ok ? JSON.stringify(JSON.parse(beforeQuote.out).rows[0]) : beforeQuote.err
  );

  // Espacio DESPUÉS de la comilla de cierre: mismo caso.
  const afterQuote = await q('name,city\n"Alice" , "Madrid"\n', { limit: 1 });
  assert(
    "el espacio tras la comilla de cierre no entra en el campo",
    afterQuote.ok && JSON.parse(afterQuote.out).rows[0].name === "Alice",
    afterQuote.ok ? JSON.stringify(JSON.parse(afterQuote.out).rows[0]) : afterQuote.err
  );

  // Campo vacío entre comas.
  const empty = await q("a,b,c\n1,,3\n", { limit: 1 });
  assert(
    "un campo vacío sigue siendo vacío",
    empty.ok && JSON.parse(empty.out).rows[0].b === "",
    empty.ok ? JSON.stringify(JSON.parse(empty.out).rows[0]) : empty.err
  );

  // Última fila sin salto de línea final (camino end()).
  const noNewline = await q("a, b\n1, 2", { limit: 5 });
  assert(
    "la última fila sin \\n final también se trimea",
    noNewline.ok && JSON.parse(noNewline.out).rows[0].b === "2",
    noNewline.ok ? JSON.stringify(JSON.parse(noNewline.out).rows[0]) : noNewline.err
  );

  // Línea en blanco al final: se sigue descartando.
  const blank = await q("a,b\n1,2\n\n", { limit: 5 });
  assert(
    "las líneas en blanco se siguen descartando",
    blank.ok && JSON.parse(blank.out).rows.length === 1,
    blank.ok ? `${JSON.parse(blank.out).rows.length} filas` : blank.err
  );

  // CRLF.
  const crlf = await q("a, b\r\n1, 2\r\n", { limit: 5 });
  assert(
    "CRLF sigue funcionando y trimea",
    crlf.ok && JSON.parse(crlf.out).rows[0].b === "2",
    crlf.ok ? JSON.stringify(JSON.parse(crlf.out).rows[0]) : crlf.err
  );
}

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
  process.exit(1);
}

/**
 * Unit tests for Fase 25.5 — json_query filter validation.
 *
 * Antes de este cambio, un filtro que el motor no sabe evaluar caía en el
 * `return false` por item de evalFilter y salía como resultado vacío — o, con
 * `&&`, como un resultado NO vacío e INCORRECTO (la lazy `(.+?)` casaba la
 * primera condición y descartaba el resto en silencio).
 *
 * El riesgo al arreglarlo era romper a quien dependiera del vacío. La tesis
 * que este fichero verifica es que ese riesgo no existe, porque la validación
 * nueva es **puramente sintáctica y ajena a los datos**: una expresión tiene
 * la forma `@.key op value` o no la tiene, con cualquier JSON. Por eso:
 *
 *  - GRUPO 1 (el que protege contra regresiones): todo vacío legítimo — filtro
 *    bien formado que no casa, clave ausente, ruta inexistente — sigue
 *    devolviendo [] sin lanzar. Si un solo caso de aquí pasa a error, el
 *    cambio SÍ rompía a alguien.
 *  - GRUPO 2: sintaxis inevaluable, antes silenciosa, ahora error explicativo.
 *  - GRUPO 3: lo que ya funcionaba sigue funcionando, byte a byte.
 *
 * Run: npx tsx test/json-query-filters.ts
 */
import { jsonQueryTool } from "../src/tools/json-query.js";

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

const DATA = JSON.stringify({
  users: [
    { name: "Alice", price: 5, stock: 0, tags: ["a"] },
    { name: "Bob", price: 20, stock: 3 },
    { name: "Ben && Jerry", price: 7 },
  ],
  empty: [],
});

type Result = { ok: true; out: string } | { ok: false; err: string };

async function run(query: string, json = DATA): Promise<Result> {
  try {
    const out = await (jsonQueryTool as unknown as {
      runWithEnv(args: Record<string, unknown>, env: unknown): Promise<string>;
    }).runWithEnv({ json, query }, {});
    return { ok: true, out: String(out) };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

/** Normaliza para comparar sin depender del pretty-printing. */
const norm = (s: string): string => s.replace(/\s+/g, "");

console.log("=== Fase 25.5 json_query filter validation ===\n");

// ---------------------------------------------------------------------------
// GRUPO 1 — vacíos legítimos: NINGUNO puede empezar a fallar
// ---------------------------------------------------------------------------
console.log("Vacíos legítimos (no deben lanzar nunca)");
{
  const cases: Array<[string, string]> = [
    ["filtro bien formado que no casa ningún item", "$.users[?(@.price > 999)].name"],
    ["filtro sobre una clave que ningún item tiene", "$.users[?(@.color = red)].name"],
    ["filtro sobre clave presente solo en algunos items", "$.users[?(@.stock > 100)].name"],
    ["filtro con = sobre valor inexistente", "$.users[?(@.name = Nadie)]"],
    ["filtro !=  que excluye todo", "$.users[?(@.price != 5)][?(@.price != 20)][?(@.price != 7)]"],
    ["regex válida que no casa nada", "$.users[?(@.name =~ /^zzz/)].name"],
    ["ruta que no existe en el documento", "$.orders[*].id"],
    ["wildcard sobre un array vacío", "$.empty[*]"],
    ["filtro sobre un array vacío", "$.empty[?(@.price > 1)]"],
    ["clave anidada inexistente", "$.users[*].address.city"],
  ];
  for (const [name, query] of cases) {
    const r = await run(query);
    assert(
      name,
      r.ok && norm(r.out) === "[]",
      r.ok ? `esperaba [] y devolvió ${norm(r.out).slice(0, 60)}` : `LANZÓ: ${r.err.slice(0, 90)}`
    );
  }
}

// ---------------------------------------------------------------------------
// GRUPO 2 — sintaxis inevaluable: antes silenciosa, ahora error
// ---------------------------------------------------------------------------
console.log("\nSintaxis inevaluable (antes silenciosa)");
{
  // El caso grave: no devolvía vacío, devolvía una respuesta INCORRECTA.
  const compound = await run("$.users[?(@.price > 1 && @.stock > 100)].name");
  assert(
    "condición compuesta && lanza en vez de ignorar media condición",
    !compound.ok && /compound condition/.test(compound.err),
    compound.ok ? `devolvió ${norm(compound.out)} (respuesta incorrecta)` : compound.err.slice(0, 90)
  );

  const or = await run("$.users[?(@.price < 1 || @.price > 10)].name");
  assert("condición compuesta || lanza", !or.ok, or.ok ? `devolvió ${norm(or.out)}` : "ok");

  const existence = await run("$.users[?(@.name)].name");
  assert(
    "filtro de existencia lanza y sugiere la alternativa",
    !existence.ok && /Existence checks are not supported/.test(existence.err),
    existence.ok ? `devolvió ${norm(existence.out)}` : existence.err.slice(0, 90)
  );

  // La alternativa que sugiere el mensaje tiene que funcionar de verdad:
  // un consejo roto sería peor que no dar ninguno.
  const suggested = await run("$.users[?(@.stock != '')].name");
  assert(
    "la alternativa sugerida [?(@.key != '')] funciona como existencia",
    suggested.ok && norm(suggested.out) === '["Alice","Bob"]',
    suggested.ok ? `devolvió ${norm(suggested.out)}` : suggested.err.slice(0, 90)
  );

  const jq = await run("$.users[?(.price > 1)].name");
  assert(
    "filtro estilo jq lanza y explica que se escribe @.key",
    !jq.ok && /@\.key/.test(jq.err),
    jq.ok ? `devolvió ${norm(jq.out)}` : jq.err.slice(0, 90)
  );

  const badRegex = await run("$.users[?(@.name =~ Alice)].name");
  assert(
    "=~ sin literal /regex/ lanza",
    !badRegex.ok && /regex/.test(badRegex.err),
    badRegex.ok ? `devolvió ${norm(badRegex.out)}` : badRegex.err.slice(0, 90)
  );

  const brokenRegex = await run("$.users[?(@.name =~ /[unclosed/)].name");
  assert(
    "regex que no compila lanza en vez de callar",
    !brokenRegex.ok,
    brokenRegex.ok ? `devolvió ${norm(brokenRegex.out)}` : "ok"
  );

  // El error de filtro no arrastra la coletilla genérica contradictoria.
  assert(
    "el error de filtro no dice que los filtros no estén soportados",
    !existence.ok && !/[Ff]ilter expressions.*not supported/.test(existence.err),
    existence.ok ? "no lanzó" : existence.err.slice(0, 90)
  );
}

// ---------------------------------------------------------------------------
// GRUPO 3 — lo que funcionaba sigue funcionando
// ---------------------------------------------------------------------------
console.log("\nSin regresión");
{
  const lt = await run("$.users[?(@.price < 10)].name");
  assert(
    "filtro < devuelve los items que casan",
    lt.ok && norm(lt.out) === '["Alice","Ben&&Jerry"]',
    lt.ok ? norm(lt.out) : lt.err
  );

  const eq = await run("$.users[?(@.name = Alice)].price");
  assert("filtro = por string", eq.ok && norm(eq.out) === "5", eq.ok ? norm(eq.out) : eq.err);

  const re = await run("$.users[?(@.name =~ /^Al/)].name");
  assert("filtro =~ con regex válida", re.ok && norm(re.out) === '"Alice"', re.ok ? norm(re.out) : re.err);

  // `&&` DENTRO de comillas es un valor legítimo, no un operador.
  const quoted = await run(`$.users[?(@.name = "Ben && Jerry")].price`);
  assert(
    "&& dentro de comillas se trata como valor, no como operador",
    quoted.ok && norm(quoted.out) === "7",
    quoted.ok ? norm(quoted.out) : quoted.err.slice(0, 90)
  );

  const plain = await run("$.users[*].name");
  assert(
    "consulta sin filtro intacta",
    plain.ok && norm(plain.out) === '["Alice","Bob","Ben&&Jerry"]',
    plain.ok ? norm(plain.out) : plain.err
  );

  const bracket = await run("$[users][0].name");
  assert("clave entre corchetes sin comillas sigue soportada", bracket.ok && norm(bracket.out) === '"Alice"', bracket.ok ? norm(bracket.out) : bracket.err);

  const recursive = await run("$..price");
  assert("descenso recursivo intacto", recursive.ok && norm(recursive.out) === "[5,20,7]", recursive.ok ? norm(recursive.out) : recursive.err);

  // Las rutas sin filtro siguen dando el error genérico con la guía de dialecto.
  const slice = await run("$.users[0:2].name");
  assert(
    "el slice sigue siendo error y conserva la guía de dialecto",
    !slice.ok && /JSONPath-lite/.test(slice.err),
    slice.ok ? norm(slice.out) : slice.err.slice(0, 90)
  );
}

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
  process.exit(1);
}

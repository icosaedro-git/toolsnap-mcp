# TypeSafe AI en ToolSnap — dónde encaja y dónde no

Análisis de dónde puede entrar [TypeSafe](https://docs.typesafe.ai) en este
repo, qué se gana en cada sitio y qué hay que medir antes de cablearlo.

TypeSafe sirve *juicios tipados*, no texto: se le manda un `state` y un mapa de
preguntas, y devuelve por cada una una respuesta con su distribución de
probabilidad. Tres tipos:

| Tipo | Devuelve | Para |
|---|---|---|
| `choice` | una opción del conjunto + probabilidad de cada una + `confidence` | elegir entre alternativas definidas |
| `noul` | probabilidad de que la respuesta sea "sí" (sin `confidence` aparte) | comprobar si se cumple una condición |
| `score` | posición ponderada sobre niveles ordenados + `confidence` | medir grado en una dimensión |

Todas las preguntas de una misma petición se evalúan **en paralelo** sobre el
mismo `state`, que se ingiere una sola vez. Eso es el grueso del ahorro:
agrupar preguntas independientes en una llamada en vez de encadenarlas
([parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions)).

**Precio (jev-1.13, verificado 2026-09-19):** $0.042 por millón de tokens de
entrada, salida gratis. Unas **71 veces más barato que la entrada de Sonnet**
($3/Mtok), que es la referencia que usa el README para calcular el ahorro de
`fetch_extract`. Un juicio sobre un mensaje de error cuesta del orden de
$0.00001.

---

## La línea que no se cruza

El README vende tres ideas, y la primera es:

> **Deterministic — no LLM in the loop.** ToolSnap's extraction is pure
> parsing: exact quotes, stable output, zero added inference cost, reproducible
> runs. What you extract is what the page said.

Meter un modelo dentro de `fetch_extract`, `csv_query` o `pdf_text_extract`
rompería esa frase, y esa frase es el producto. **TypeSafe no entra en las
tools de extracción.** Ni siquiera "solo para los casos raros": un resultado
que a veces es determinista y a veces no, no es determinista.

Donde sí entra es en **la operación del servidor** — el pager, el catálogo, el
x-agent —, que son sistemas internos donde nadie ha prometido reproducibilidad
y donde hoy hay heurísticas frágiles o un modelo generativo mal aprovechado.

Si algún día se quiere vender juicio semántico, va como una **tool nueva y
etiquetada** (`classify`, `rank`, `verify`…), con su precio y su descripción
diciendo que lleva un modelo dentro — nunca escondido dentro de una que hoy es
determinista.

---

## Por dónde entrar, en orden

### 1. El default por descarte del pager — el que más duele hoy

`src/alerts/error-classification.ts` reparte cada `tool_error` en `caller`,
`upstream` o `internal` con cuatro listas de expresiones regulares. Solo
`internal` despierta a nadie.

El problema no son las regex: es su **última línea**.

```ts
return "internal";   // por descarte
```

Un mensaje de error que no casa con ningún patrón se declara fallo nuestro y
suena el pager. El historial del propio fichero cuenta cómo sale eso:

- **2026-09-17** — 14 alertas en 5 días, **ninguna accionable**: 9 eran
  validaciones que el llamante pidió de vuelta, 5 el sitio destino portándose
  mal.
- **2026-09-18** — dos falsas alarmas más. Una era un `json_query` apuntado a
  una página HTML: `Invalid JSON: Unexpected token '<'` no casaba con nada y
  cayó en `internal`.
- Cada arreglo son 25.6 → 25.7 → 25.9 → 25.10: **cuatro fases persiguiendo la
  redacción de mensajes nuevos**. Cada tool nueva y cada `throw` nuevo vuelven a
  abrir el agujero.

Una `choice` de tres opciones sobre el texto del error no persigue redacciones:
lee lo que dice el mensaje. La forma propuesta (`ERROR_TRIAGE_QUESTIONS` en
`src/typesafe/questions.ts`) es:

- **no sustituye a las regex.** Un mensaje que casa con un patrón anclado ya
  está decidido; preguntar por él es gastar latencia para confirmar lo que se
  sabe. La pregunta solo se hace en el descarte (`needsTypeSafeTriage`).
- **asimétrica.** Solo se deja silenciar el pager con `confidence >= 0.85` y
  `actionable <= 0.15`. Si el modelo duda, gana el comportamiento de hoy y
  suena. Un falso negativo (fallo real que nadie ve) cuesta muchísimo más que
  una alerta de más, que además ya está limitada a una por hora y tool.
- **dos preguntas, no una.** "Es un fallo nuestro" y "hay que mirarlo hoy" no
  son lo mismo: el guardia SSRF rechazando una IP privada es `internal` y tiene
  que paginar, pero no porque haya nada roto. Separarlas deja esa política en
  código. Van en la misma llamada, así que cuestan una petición.

**Coste:** ~250 tokens por error sin clasificar ⇒ del orden de **$0.01 por cada
1.000 errores**. Va en un `waitUntil`, fuera del camino de respuesta de la
tool.

**Antes de cablearlo:** `npx tsx scripts/typesafe-experiment.mts`. Mide acuerdo
contra el corpus real y simula qué habría hecho el pager. La cifra que decide
es "fallos reales silenciados", que tiene que ser 0.

### 2. Encaminar una petición al tool correcto (47 tools, `tools/list` enseña 17)

`tool_catalog` + `use_tool` resuelven el coste de contexto: el catálogo entero
no se carga, se descubre a demanda. Lo que no resuelven es el salto del medio —
el agente tiene que leerse una familia entera para descubrir que existe
`html_table_extract`, y solo la lee si ya sospecha que hay algo.

El cookbook [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)
hace exactamente esto con 182 skills: una petición puntúa todas, una segunda lee
las mejores de verdad. Aquí serían 47 opciones, que caben de sobra en el
contexto de 64k.

Forma: `tool_catalog(goal: "necesito los precios de esta tabla")` → una `choice`
sobre los nombres reales del registro (`src/tools/index.ts`, nunca una lista a
mano) + un `noul` que dice si hacía falta una tool siquiera, porque una
`choice` siempre devuelve algo. Por debajo de `TOOL_ROUTING_MIN_CONFIDENCE` no
se sugiere nada: sugerir mal es peor que callarse, porque el agente paga la
llamada y aprende a no fiarse del catálogo.

Esto es lo único de la lista que es **producto y no operación**: hace el
servidor más fácil de usar y es medible en las analíticas que ya existen
(`src/analytics/`) — ¿sube la proporción de primeras llamadas que aciertan?

**Pero hoy no cabe.** El `inputSchema` de `tool_catalog` está en `tools/list`,
y por tanto dentro de lo que audita `scripts/first-connection-audit.ts` en CI.
Ahora mismo el margen es de **17 tokens** (2633 de 2650), que no da ni para la
descripción de un parámetro `goal`. Antes de esta idea hay que subir el
presupuesto a sabiendas o recortar en otro sitio — no es un detalle de
implementación, es la primera decisión.

### 3. El `score` que se autoasigna grok en el x-agent

`src/x-agent/discovery.ts` filtra candidatos con `minScore: 70` sobre un número
que **el propio modelo generativo se pone a sí mismo** dentro del JSON que
devuelve. Ese número no está calibrado, no es comparable entre barridos, y se
mueve si alguien toca una frase del prompt en `x_prompts` — que es justo lo que
esa tabla existe para permitir.

Cuatro preguntas separadas (`REPLY_QUESTIONS`) lo sustituyen con algo revisable:

- `relevance` y `opening` son `score`, se **compensan** entre sí y sus pesos
  (`REPLY_WEIGHTS`) se cambian en código sin volver a llamar a nadie. Mientras
  la evidencia y el significado de las preguntas no cambien, reponderar es
  aritmética sobre respuestas ya guardadas
  ([composite scoring](https://docs.typesafe.ai/patterns/composite-scoring)).
- `risky` y `draft_supported` son `noul` y **no se ponderan**: son condiciones.
  Una política de "cualquier infracción grave descarta" no admite compensación
  entre dimensiones.

`draft_supported` es la que más vale: comprueba que el borrador responde a lo
que el post dice de verdad, y no a algo que se inventó. Ese es el fallo caro de
un reply-guy automático, y hoy lo ataja un humano en Telegram
(`telegram-approval.ts`) leyéndolos uno a uno.

**Aviso:** el inglés es la lengua primaria de Jev y donde mejor va. Los posts
en castellano hay que medirlos aparte antes de fiarse de un umbral.

### 4. Candidatos menores, sin desarrollar

- **`health.ts` / `surface-digest.ts`** — el digest ya agrupa; un `score` de
  "cuánto se parece esto a una tool rota de verdad" ordenaría el resumen. Poco
  volumen, poco que ganar.
- **`extract-structured.ts`** — el patrón "seleccionar en vez de generar"
  ([value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook))
  encaja de libro: el código ya saca candidatos de JSON-LD y `<meta>`, y una
  `choice` elegiría cuál es el pedido, copiando el valor literal. **Pero es una
  tool de extracción**, así que cae del lado prohibido de la línea de arriba.
  Solo como tool nueva y etiquetada.

---

## Qué hay ya en el repo

| Fichero | Qué es |
|---|---|
| `.claude/skills/typesafe-ai/` | La skill oficial (MIT), vendorizada. Ver `UPSTREAM.md` para el commit fijado y cómo actualizarla. |
| `src/typesafe/client.ts` | Cliente de `POST /v1/systemone`. I/O puro: no sabe qué preguntas existen. |
| `src/typesafe/questions.ts` | **Todas** las preguntas y **todos** los umbrales. Un solo fichero, a propósito. |
| `scripts/typesafe-experiment.mts` | Mide regex vs TypeSafe sobre el corpus real. No toca producción, no corre en CI. |
| `test/fixtures/tool-errors.ts` | Los 41 casos etiquetados, extraídos de `test/alert-noise.ts` para que el experimento y el test midan lo mismo. |

`classifyToolErrorDetailed()` es lo único que se ha tocado de código existente:
dice si la clase salió de un patrón anclado o del descarte. No cambia ninguna
clasificación.

**Nada de esto está cableado a producción.** No hay `TYPESAFE_API_KEY` en
ningún sitio y ninguna ruta llama a `systemOne()`.

### Por qué las preguntas están todas juntas

Porque es lo único que un humano tiene que revisar de verdad. Un agente escribe
el cableado bien; las preguntas no. La documentación de TypeSafe lo dice en dos
sitios distintos: *"Put the constants (questions and thresholds) in a single
place"* y *"Agents aren't great at writing questions, so expect to edit
collaboratively with them"*. Los `instructions` de `questions.ts` son un primer
borrador y se espera que se editen a mano.

### Por qué un cliente a mano y no `@typesafe-ai/sdk`

El runtime es Cloudflare Workers y la superficie usada es una petición HTTP. El
SDK declara Node 20+ y trae su propia política de reintentos; una dependencia
más en el bundle cuesta arranque en frío y no compra nada. Se reconsidera si
aparece streaming o modelos con otra forma.

---

## Siguientes pasos

1. Crear una clave en <https://console.typesafe.ai/keys> y exportarla.
2. `npx tsx scripts/typesafe-experiment.mts --limit 8` para ver la forma, luego
   el corpus entero (~$0.0005).
3. Leer los **desacuerdos uno a uno**, no el porcentaje. Un empate del 100% con
   las regex no demuestra nada: los patrones se escribieron mirando este mismo
   corpus. Lo que se mide es si el modelo acierta **sin** conocerlos, que es lo
   que predice su comportamiento con el mensaje nuevo de la semana que viene.
4. Fijar `ERROR_SILENCE_MIN_CONFIDENCE` con esa curva, no con el 0.85 que hay
   puesto ahora, que es un punto de partida sin validar.
5. Si "fallos reales silenciados" sale 0 con margen, cablear el triaje en
   `error-alerts.ts` detrás de `hasTypeSafe(env)`, degradando al
   comportamiento actual cuando no haya clave o la llamada falle.

Los umbrales de los cookbooks son ejemplos a evaluar, no reglas. Y la salida
tipada garantiza la interfaz, no la verdad.

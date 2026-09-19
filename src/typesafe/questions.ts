/**
 * TODAS las preguntas de TypeSafe y TODOS sus umbrales, en un solo fichero.
 *
 * Esto es deliberado y es la única regla de estilo que impone la propia
 * documentación de TypeSafe: "Put the constants (questions and thresholds) in a
 * single place so they're easy to review" y "The most important thing for
 * humans to review is the questions and any threshold constants"
 * (<https://docs.typesafe.ai/agent-skill>). Un agente escribe el cableado; las
 * preguntas y los números se revisan a mano, y para eso tienen que estar
 * juntos. No dispersar `instructions` por los módulos que las consumen.
 *
 * Estado: NINGUNA de estas preguntas está cableada a producción todavía. Se
 * ejecutan desde `scripts/typesafe-experiment.mts` contra el corpus real que ya
 * vive en `test/alert-noise.ts`, para medir acuerdo ANTES de dejar que decidan
 * nada. El razonamiento de por dónde entra cada una, y qué se gana, está en
 * `docs/typesafe-ai.md`.
 *
 * Los umbrales de abajo son PUNTOS DE PARTIDA sin validar. La documentación
 * insiste en que los umbrales de los cookbooks son ejemplos a evaluar, no
 * reglas universales: hay que fijarlos con datos propios y con el coste real de
 * equivocarse en cada dirección.
 */

import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./client.js";
import type { ToolErrorClass } from "../alerts/error-classification.js";

// ---------------------------------------------------------------------------
// 1. Triaje de `tool_error` — ¿quién tiene el problema?
// ---------------------------------------------------------------------------

/**
 * Las mismas tres clases que decide hoy `classifyToolError()` a base de
 * expresiones regulares (src/alerts/error-classification.ts). Las descripciones
 * son la traducción al inglés del contrato que ya está escrito allí; no
 * inventan política nueva.
 *
 * El objetivo NO es sustituir las regex: es cubrir el default por descarte.
 * Hoy un mensaje que no casa con ninguna lista cae en "internal" y suena el
 * pager — así se colaron las falsas alarmas del 2026-09-18. Un mensaje que ya
 * casa con un patrón anclado no necesita modelo.
 */
export const ERROR_TRIAGE_CLASS: ChoiceQuestion = {
  type: "choice",
  instructions:
    "An MCP tool call failed and the tool returned this error message to the agent that called it. " +
    "Decide whose problem the message describes.",
  criteria: {
    caller:
      "The agent called the tool incorrectly: a missing or misspelled argument, a value the tool " +
      "cannot interpret (not a URL, not JSON, an unknown model or column name), a limit it exceeded, " +
      "or a tool name that does not exist. The message is the useful answer for the caller and " +
      "nothing is broken on the server.",
    upstream:
      "The tool worked; the destination it was pointed at did not. HTTP errors from the target site, " +
      "redirect loops, timeouts reaching it, bot walls, an empty response body, a single-page app " +
      "that needs a browser, or the target serving a different format than the one requested " +
      "(an HTML page where JSON, CSV or a PDF was asked for). Not a server defect either.",
    internal:
      "A defect in the MCP server itself or in a paid provider it depends on: an unconfigured secret " +
      "or binding, broken internal wiring, an unexpected exception, a third-party inference or " +
      "capture provider failing or answering with something unreadable, or a payment settlement " +
      "problem. This is the only class worth waking a human for.",
  },
};

/**
 * Pregunta independiente y a propósito: "es un fallo nuestro" y "hay algo que
 * hacer ahora" no son lo mismo. Un guardia SSRF rechazando una IP privada se
 * clasifica hoy como "internal" y pagina — correctamente, porque es una señal
 * de seguridad, no porque haya nada roto. Separarlas deja esa decisión en
 * código y no dentro de la definición de "internal".
 *
 * Se envía en la MISMA llamada que ERROR_TRIAGE_CLASS: son independientes
 * sobre el mismo estado, así que van en paralelo y cuestan una petición.
 */
export const ERROR_TRIAGE_ACTIONABLE: NoulQuestion = {
  type: "noul",
  instructions:
    "Would an on-call engineer responsible for this MCP server need to look at this error message " +
    "today, either to fix something or because it is a security signal worth knowing about?",
  criteria: {
    true:
      "Something is broken, misconfigured or under attack on the server side: an unconfigured secret, " +
      "a provider outage, an unhandled exception, a payment that did not settle, or a request probing " +
      "internal network addresses.",
    false:
      "Expected noise: the caller was told what it did wrong, or a third-party website misbehaved. " +
      "Nothing on the server needs to change.",
  },
};

export const ERROR_TRIAGE_QUESTIONS = {
  error_class: ERROR_TRIAGE_CLASS,
  actionable: ERROR_TRIAGE_ACTIONABLE,
} as const;

/**
 * Umbral de confianza para dejar que el modelo SILENCIE el pager.
 *
 * Asimétrico a propósito, y en la dirección segura: solo se acepta degradar un
 * "internal por descarte" a ruido cuando el modelo está muy concentrado. Si
 * duda, gana el comportamiento actual y suena. El coste de un falso negativo
 * (un fallo real que nadie ve) es mucho mayor que el de una alerta de más, que
 * ya está además limitada a una por hora y tool.
 *
 * SIN VALIDAR: fijarlo con la curva de acuerdo que imprime
 * scripts/typesafe-experiment.mts sobre el corpus real, no con este número.
 */
export const ERROR_SILENCE_MIN_CONFIDENCE = 0.85;

/** Probabilidad máxima de "hay que mirarlo" compatible con silenciar. */
export const ERROR_SILENCE_MAX_ACTIONABLE = 0.15;

/**
 * Estado para el triaje. Campos JSON con nombre en vez de una cadena suelta:
 * el mensaje de error se lee distinto según qué tool lo lanzó.
 */
export function errorTriageState(input: { tool?: string; detail: string }): Record<string, unknown> {
  // `tool_name` va cuando se conoce: el mismo mensaje se lee distinto según
  // quién lo lanzó. El corpus de test/fixtures/tool-errors.ts no lo guarda, así
  // que el experimento mide el caso PEOR — sin esa pista.
  return { ...(input.tool ? { tool_name: input.tool } : {}), error_message: input.detail };
}

/**
 * Cuándo merece la pena preguntar. Un mensaje que ya casa con un patrón anclado
 * está decidido: llamar a nadie por él es gastar latencia y dinero para
 * confirmar lo que ya sabemos. La pregunta solo se gana su sitio en el default
 * por descarte, que es donde nacen las falsas alarmas.
 */
export function needsTypeSafeTriage(regexClass: ToolErrorClass, matchedAPattern: boolean): boolean {
  return regexClass === "internal" && !matchedAPattern;
}

// ---------------------------------------------------------------------------
// 2. Encaminar una petición en lenguaje natural al tool correcto
// ---------------------------------------------------------------------------

/**
 * ToolSnap publica 47 tools pero solo enseña un núcleo curado en `tools/list`;
 * el resto se descubre con `tool_catalog()` y se ejecuta con `use_tool`. El
 * salto caro es el del medio: el agente tiene que leerse una familia entera
 * para enterarse de que existe `html_table_extract`.
 *
 * Esta Choice se construye EN CÓDIGO a partir del registro real de tools
 * (src/tools/index.ts), nunca a mano: una lista de opciones escrita a mano se
 * desincroniza del catálogo en cuanto se añade una tool, y el modelo no puede
 * elegir una opción que no le dimos.
 *
 * El cookbook de referencia es "Skill suggestion", que hace exactamente esto
 * con 182 skills: una petición puntúa todas, una segunda lee las mejores
 * <https://docs.typesafe.ai/cookbooks/skill_suggestion>.
 */
export function toolRoutingQuestion(toolDescriptions: Record<string, string>): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "An AI agent described what it is trying to do. Pick the single tool from this MCP server that " +
      "does that job. Pick `none` if no tool fits, or if the agent could do it without any tool.",
    criteria: { ...toolDescriptions, none: "No tool on this server does this job." },
  };
}

/**
 * Se manda junto a la Choice, en la misma llamada. Una Choice SIEMPRE devuelve
 * una opción; la que dice si había algo que elegir es esta.
 */
export const TOOL_ROUTING_NEEDS_TOOL: NoulQuestion = {
  type: "noul",
  instructions:
    "Does this request need a server-side web or data tool at all (fetching a URL, parsing a " +
    "document, querying a dataset, generating media), as opposed to something the agent can answer " +
    "on its own?",
  criteria: {
    true: "It needs external data, a document parsed, or media produced.",
    false: "It is reasoning, writing or arithmetic the agent can do by itself.",
  },
};

/**
 * Por debajo de esto no se sugiere nada. Sugerir una tool equivocada es peor
 * que no sugerir: el agente paga la llamada, se lleva un resultado inútil y
 * aprende a no fiarse del catálogo.
 */
export const TOOL_ROUTING_MIN_CONFIDENCE = 0.6;
export const TOOL_ROUTING_MIN_NEEDS_TOOL = 0.5;

// ---------------------------------------------------------------------------
// 3. Filtrar candidatos del x-agent antes de gastar atención humana
// ---------------------------------------------------------------------------

/**
 * Hoy el orden y el corte de los candidatos de respuesta salen de un `score`
 * numérico que el propio grok se autoasigna dentro del JSON que devuelve
 * (src/x-agent/discovery.ts: `minScore: 70`, `passesHardFilters`). Un número
 * que un modelo generativo se pone a sí mismo no está calibrado, no es
 * comparable entre barridos y cambia si alguien toca una frase del prompt en
 * `x_prompts`.
 *
 * Estas preguntas separan ese único número en dimensiones que sí se pueden
 * revisar por separado y cuyos pesos se cambian en código sin volver a llamar a
 * nadie — el patrón "composite scoring"
 * <https://docs.typesafe.ai/patterns/composite-scoring>.
 */
export const REPLY_RELEVANCE: ScoreQuestion = {
  type: "score",
  instructions:
    "How relevant is this post to ToolSnap's subject matter: MCP servers, AI coding agents, agent " +
    "context and token cost, web and document data extraction, or agent payments?",
  criteria: [
    "Unrelated to any of those subjects.",
    "Adjacent: general AI or developer content where the topic could come up but has not.",
    "On topic: the post is about one of those subjects.",
    "Directly on topic and stating a problem ToolSnap addresses.",
  ],
};

export const REPLY_OPENING: ScoreQuestion = {
  type: "score",
  instructions:
    "How much room does this post leave for a useful reply from a small developer tool account, " +
    "judged only by whether a reply would add something the thread does not already have?",
  criteria: [
    "None: the post is closed, already answered, or an announcement nobody is discussing.",
    "Little: a reply would only agree or restate.",
    "Some: an open question or an unstated tradeoff a reply could fill in.",
    "Clear: someone is stuck on something concrete and a specific answer would help them.",
  ],
};

/**
 * Guardarraíl, no puntuación. Esto no se pondera con nada: si sale que sí, el
 * candidato se descarta, por bueno que sea en todo lo demás. La política de
 * "cualquier infracción grave" no admite compensación entre dimensiones, así
 * que va como condición separada y no como peso.
 */
export const REPLY_RISKY: NoulQuestion = {
  type: "noul",
  instructions:
    "Would replying to this post as a developer-tools brand account be a bad idea?",
  criteria: {
    true:
      "It is a pile-on, a personal attack, grief, politics, an ongoing controversy, someone in " +
      "distress, a scam or engagement bait, or anything where a product reply would read as " +
      "opportunistic.",
    false: "An ordinary technical or product conversation.",
  },
};

/**
 * Comprueba la premisa del borrador CONTRA el post, no su tono. El fallo caro
 * de un reply-guy automático no es sonar raro: es contestar con seguridad a
 * algo que el post no decía.
 */
export const REPLY_DRAFT_SUPPORTED: NoulQuestion = {
  type: "noul",
  instructions:
    "Does the draft reply respond to what the post actually says, without attributing to it a claim, " +
    "a problem or a tool that is not there?",
  criteria: {
    true: "Every premise the reply leans on is present in the post.",
    false: "The reply answers a different post, or invents context.",
  },
};

export const REPLY_QUESTIONS = {
  relevance: REPLY_RELEVANCE,
  opening: REPLY_OPENING,
  risky: REPLY_RISKY,
  draft_supported: REPLY_DRAFT_SUPPORTED,
} as const;

/**
 * Pesos y cortes del filtro de candidatos. Se cambian sin volver a llamar a
 * TypeSafe: mientras la evidencia y el significado de las preguntas no cambien,
 * reponderar es aritmética sobre respuestas ya guardadas.
 *
 * `relevance` y `opening` se compensan entre sí (un post muy on-topic con poco
 * hueco puede seguir mereciendo la pena). `risky` y `draft_supported` NO: son
 * condiciones.
 */
export const REPLY_WEIGHTS = { relevance: 0.6, opening: 0.4 } as const;

/** Media ponderada mínima, en la escala 0..3 de los niveles. */
export const REPLY_MIN_WEIGHTED_SCORE = 2.0;
/** Por encima de esto se descarta, sin discusión. */
export const REPLY_MAX_RISKY = 0.25;
/** Por debajo de esto el borrador no se le enseña a nadie. */
export const REPLY_MIN_DRAFT_SUPPORTED = 0.75;

export function replyCandidateState(input: {
  authorHandle: string;
  postText: string;
  draftReply: string;
  topic?: string;
}): Record<string, unknown> {
  return {
    post: { author: input.authorHandle, text: input.postText },
    draft_reply: input.draftReply,
    ...(input.topic ? { topic: input.topic } : {}),
  };
}

/**
 * Combina las cuatro respuestas en la decisión. Aritmética pura: es la política
 * y se revisa aquí, no dentro de un prompt.
 */
export function replyCandidateVerdict(answers: {
  relevance: number;
  opening: number;
  risky: number;
  draft_supported: number;
}): { keep: boolean; weighted: number; reason: string } {
  const weighted =
    answers.relevance * REPLY_WEIGHTS.relevance + answers.opening * REPLY_WEIGHTS.opening;

  if (answers.risky > REPLY_MAX_RISKY) {
    return { keep: false, weighted, reason: `risky=${answers.risky.toFixed(2)}` };
  }
  if (answers.draft_supported < REPLY_MIN_DRAFT_SUPPORTED) {
    return { keep: false, weighted, reason: `draft_supported=${answers.draft_supported.toFixed(2)}` };
  }
  if (weighted < REPLY_MIN_WEIGHTED_SCORE) {
    return { keep: false, weighted, reason: `weighted=${weighted.toFixed(2)}` };
  }
  return { keep: true, weighted, reason: `weighted=${weighted.toFixed(2)}` };
}

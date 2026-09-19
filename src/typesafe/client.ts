/**
 * Cliente mínimo de la API System One de TypeSafe (POST /v1/systemone).
 *
 * Por qué a mano y no `@typesafe-ai/sdk`: el runtime es Cloudflare Workers y
 * la superficie que usamos es UNA petición HTTP con `state` + `questions`
 * (<https://docs.typesafe.ai/api>). El SDK declara Node 20+ y trae su propia
 * política de reintentos; aquí una dependencia más en el bundle del Worker
 * cuesta arranque en frío y no compra nada. Si algún día usamos streaming,
 * paginación o modelos nuevos con forma distinta, se reconsidera.
 *
 * Este módulo es I/O PURO, igual que src/fal/client.ts: no sabe qué preguntas
 * existen ni qué umbrales se aplican. Eso vive TODO en ./questions.ts, en un
 * solo sitio, porque es lo único que un humano tiene que revisar de verdad
 * (principio 3 de <https://docs.typesafe.ai/agent-skill>).
 *
 * Convención de errores: todo fallo sale con el prefijo "TypeSafe: ". Si algún
 * día una tool de pago se apoya en esto, ese prefijo es el que hay que añadir a
 * PROVIDER_PREFIXES en src/alerts/error-alerts.ts para que un proveedor caído
 * se clasifique como fallo de proveedor y no como excepción nuestra.
 */

const API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Reintentables según la tabla de errores de la API. */
const RETRYABLE_STATUS = new Set([429, 529]);
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

export interface TypeSafeEnv {
  /** wrangler secret put TYPESAFE_API_KEY. Sin ella, todo llamador debe degradar. */
  TYPESAFE_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// Preguntas
// ---------------------------------------------------------------------------

/** `state` admite texto plano o datos estructurados. */
export type State = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** Qué significa un sí (valor cercano a 1) y un no (cercano a 0). */
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** opción → descripción (o null si no necesita matiz). */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Niveles ORDENADOS, mínimo dos, cada uno describiendo una situación concreta. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export interface NoulAnswer {
  type: "noul";
  /** Probabilidad de que la respuesta sea "sí", de 0 a 1. No hay `confidence`. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** La opción con más probabilidad. */
  choice: string;
  /** Cada opción con su probabilidad; suman 1. */
  probabilities: Record<string, number>;
  /** Concentración de la distribución, de 0 a 1. NO es "probabilidad de acertar". */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Posición ponderada por probabilidad; puede caer entre dos niveles. */
  score: number;
  /** Índice de nivel (como clave string) → su descripción. */
  legend: Record<string, string>;
  /** Índice de nivel (como clave string) → su probabilidad; suman 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Mapea cada pregunta a la forma de respuesta que le corresponde. */
export type AnswersFor<Q extends Record<string, Question>> = {
  [K in keyof Q]: Q[K] extends NoulQuestion
    ? NoulAnswer
    : Q[K] extends ChoiceQuestion
      ? ChoiceAnswer
      : Q[K] extends ScoreQuestion
        ? ScoreAnswer
        : Answer;
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface SystemOneResult<Q extends Record<string, Question>> {
  model: string;
  answers: AnswersFor<Q>;
  usage?: Usage;
}

export interface SystemOneOptions {
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evalúa `state` contra un mapa de preguntas tipadas y devuelve una respuesta
 * por pregunta, bajo las mismas claves.
 *
 * Las preguntas de un mismo `questions` se evalúan EN PARALELO y no se ven
 * entre sí. Esa es toda la eficiencia del asunto: agrupar todas las preguntas
 * independientes sobre el mismo estado en una sola llamada en vez de encadenar
 * llamadas (<https://docs.typesafe.ai/cookbooks/parallel_questions>). Una
 * segunda petición solo se justifica si una respuesta anterior determina qué
 * estado construir o qué opciones ofrecer.
 */
export async function systemOne<Q extends Record<string, Question>>(
  env: TypeSafeEnv,
  state: State,
  questions: Q,
  opts: SystemOneOptions = {}
): Promise<SystemOneResult<Q>> {
  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) {
    // Misma redacción que el resto de proveedores, para que
    // INTERNAL_PATTERNS (/\bis not configured \(/) lo reconozca como fallo
    // nuestro de despliegue y no como ruido del llamante.
    throw new Error("TypeSafe API key is not configured (TYPESAFE_API_KEY).");
  }
  if (Object.keys(questions).length === 0) {
    throw new Error("TypeSafe: at least one question is required.");
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const body = JSON.stringify({ state, model, questions });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 400);
        const err = new Error(`TypeSafe: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
        // 401/422 son culpa nuestra (clave mala, pregunta mal formada):
        // reintentar solo gasta latencia.
        if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) throw err;
        lastError = err;
      } else {
        const parsed = (await res.json()) as Partial<SystemOneResult<Q>>;
        if (!parsed || typeof parsed !== "object" || !parsed.answers) {
          throw new Error("TypeSafe returned an unexpected response (no `answers`).");
        }
        return {
          model: parsed.model ?? model,
          answers: parsed.answers,
          usage: parsed.usage,
        };
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Un abort es el timeout nuestro: no lo reintentamos hasta agotar
      // presupuesto de latencia en un cron.
      if (err.name === "AbortError") {
        throw new Error(`TypeSafe: request timed out after ${timeoutMs}ms`);
      }
      if (attempt === maxAttempts) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  throw lastError ?? new Error("TypeSafe: request failed.");
}

/** ¿Está configurada la clave? Todo llamador debe degradar a la vía determinista si no. */
export function hasTypeSafe(env: TypeSafeEnv): boolean {
  return Boolean(env.TYPESAFE_API_KEY);
}

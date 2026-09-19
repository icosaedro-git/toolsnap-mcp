/**
 * Saneado del `detail` ANTES de que salga de memoria — lo unico que se
 * persiste de una llamada fallida.
 *
 * Origen (2026-09-18): la web promete, en `/privacy` y en la tabla "What we
 * log" de `/security`, que NO se registran «the URLs you fetch», «the content
 * of files you process» ni «the arguments of your tool calls», y a la vez que
 * en un fallo se registra «the error message text». Las dos frases se
 * contradecian: `fetch_html` y `fetch_extract` metian la URL entera en el
 * mensaje, y otros mensajes echan de vuelta un fragmento de lo que llego (la
 * primera linea de un CSV que resulto ser HTML, las columnas de la cabecera).
 * Quitar esas interpolaciones una a una arregla el caso de hoy y no el de
 * manana: cualquier `throw new Error(\`... ${algoDelLlamante}\`)` nuevo vuelve
 * a romper la promesa sin que nadie lo note.
 *
 * Asi que el arreglo va en el BORDE, no en cada tool — misma leccion que
 * Fase 25.9 con el pager: decidir que pasa, en vez de ir tachando lo que no.
 * El llamante sigue recibiendo el mensaje completo y util; lo que se guarda
 * (D1, logs del Worker y Telegram) es su FORMA, que es lo unico que se usa
 * para clasificar y diagnosticar.
 *
 * INVARIANTE, cubierta por test: sanear nunca cambia la clase que devuelve
 * `classifyToolError`. Si un patron de clasificacion depende de un fragmento
 * que aqui se borra, el que se ajusta es el patron (ver el de "Cannot
 * parse/interpret", que exigia una comilla).
 */

/** Marca visible: en el panel se distingue de un mensaje que venia asi. */
const URL_MARK = "[url]";
const MARK = "[redacted]";

/**
 * 1. URLs completas. Cubre tanto las que interpolabamos a proposito como las
 *    que llegan dentro del mensaje de error del propio `fetch` de Workers.
 */
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

/**
 * 2. Cualquier cosa entre comillas dobles. Es la convencion con la que estas
 *    tools citan un valor del llamante o del destino: `URL host "10.0.0.1"`,
 *    `Unknown model "sdxl"`, `No job found for job_id "abc"`, y el fragmento
 *    del cuerpo que citan `Response does not look like CSV (first line: "...")`
 *    y el `Invalid JSON: Unexpected token '<', "<!DOCTYPE "...` de V8.
 *
 *    Las comillas SIMPLES se dejan a proposito: no citan datos (el `'<'` de
 *    V8 es un caracter suelto) y borrarlas destrozaria cualquier mensaje con
 *    un apostrofo. Las comillas invertidas tambien: ahi van nombres de
 *    argumentos nuestros (`url`, `query`), que son justo lo que hay que ver.
 */
const DQUOTED_RE = /"[^"]*"/g;

/**
 * 3. Enumeraciones que devolvemos copiadas del fichero del llamante. Solo hay
 *    una: `Column(s) not found: precio. Available: price, qty` (csv_query)
 *    echa de vuelta las columnas pedidas Y la cabecera real del CSV, sin
 *    comillas que la regla 2 pudiera atrapar. El prefijo basta para saber que
 *    paso; los nombres son del fichero de quien llama.
 */
const COLUMN_LIST_RE = /^(Column\(s\) not found:).*$/s;

/**
 * 4. V8 devuelve el patron ENTERO, entre barras y sin comillas, cuando una
 *    expresion regular no compila: "Invalid regular expression:
 *    /(?<mi_secreto>[/: Unterminated character class". Ese patron es un
 *    argumento del llamante y lo reenvia `regex_extract`
 *    ("Invalid regex pattern: ..."). La razon del fallo, que es lo util, se
 *    conserva.
 */
const REGEX_LITERAL_RE = /(Invalid regular expression: )\/[\s\S]*\/[a-z]*(?=:)/;

export function redactDetail(detail: string): string {
  return detail
    .replace(URL_RE, URL_MARK)
    .replace(DQUOTED_RE, MARK)
    .replace(COLUMN_LIST_RE, `$1 ${MARK}`)
    .replace(REGEX_LITERAL_RE, `$1${MARK}`);
}

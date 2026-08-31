// Ciclo de generación del cuadrante con un modelo de lenguaje (decisión V-45). PURO: recibe el
// `llm` y el `validar` inyectados, así que aquí no hay red, ni Sheets, ni dominio — es el núcleo
// hexagonal del generador, y el adaptador impuro (UrlFetchApp contra la Gemini API) vive donde
// viven todos los adaptadores, en `Code.gs`.
//
// LA REGLA QUE JUSTIFICA EL MÓDULO ENTERO: «la IA propone, el validador dispone» (spec.md §5).
// Este ciclo no sabe nada de guardias. Solo sabe pedir, parsear, preguntarle al juez y, si el juez
// dice que no, volver a pedir explicando POR QUÉ no — hasta 3 veces, y ni una más. Lo único que
// nunca puede pasar es que devuelva `ok:true` con una propuesta que tenga violaciones `error`: eso
// escribiría un cuadrante ilegal en una tabla append-only que no se borra nunca.
//
// Por qué el reintento lleva las violaciones CONCRETAS y no un «vuelve a intentarlo»: sin el
// motivo, el segundo intento es una tirada de dados idéntica a la primera y los tres se gastan en
// nada. Con el motivo, el modelo corrige el día que falla. Es la diferencia entre reintentar y
// simplemente repetir.

import { parseGenerationResponse, buildRetryPrompt } from "./ai-prompt.js";

/** Los 3 intentos del encargo. Configurable en la llamada, pero este es el número acordado. */
export const MAX_INTENTOS = 3;

/**
 * Llama al adaptador sin fiarse de él. `Code.gs` es la única pieza del backend sin tests (es la
 * frontera de I/O), así que no se da por hecho que cumpla el contrato `{ok, texto|error}`: si
 * lanza, se trata como un fallo de transporte más y se gasta el intento, en vez de reventar la
 * petición entera y dejar al responsable con un error de Apps Script en pantalla.
 */
function pedir(llm, prompt) {
  try {
    const r = llm(prompt);
    if (!r || typeof r !== "object") return { ok: false, error: "el adaptador del modelo no devolvió nada" };
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Pide un cuadrante al modelo y no lo da por bueno hasta que el validador calla.
 *
 * @param {object} p
 *   - prompt: el encargo completo (`ai-prompt.js:buildGenerationPrompt`)
 *   - llm: `(prompt) => {ok:true, texto} | {ok:false, error}`. El puerto de generación.
 *   - validar: `(asignaciones) => violaciones[]`. El juez real (validateMonth + validateThirdPost
 *     en el router). Solo `severidad === "error"` bloquea, igual que en `canValidate` (V-14).
 *   - maxIntentos: por defecto MAX_INTENTOS
 * @returns {{ok:true, asignaciones, violaciones, intentos:number, historial:object[]}
 *          |{ok:false, resultado:"REVISION_MANUAL"|"ERROR_MODELO", error:string,
 *             violaciones:object[], intentos:number, historial:object[]}}
 */
export function generateSchedule({ prompt, llm, validar, maxIntentos = MAX_INTENTOS }) {
  const historial = [];
  let siguiente = prompt;
  let ultimasViolaciones = [];
  let ultimoErrorModelo = null;
  let huboPropuesta = false;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    const respuesta = pedir(llm, siguiente);

    if (!respuesta.ok) {
      // Fallo de transporte (cuota, 503, red). Se reintenta con el MISMO prompt: el problema no
      // estaba en lo que se pidió. El error de Google se conserva tal cual — si al final se agotan
      // los intentos, es lo único que le dice a la persona qué ha pasado de verdad.
      ultimoErrorModelo = respuesta.error || "el modelo no respondió";
      historial.push({ intento, motivo: ultimoErrorModelo });
      continue;
    }

    const parsed = parseGenerationResponse(respuesta.texto);
    if (!parsed.ok) {
      ultimoErrorModelo = parsed.error;
      historial.push({ intento, motivo: parsed.error });
      siguiente = buildRetryPrompt({ prompt, problema: parsed.error });
      continue;
    }

    huboPropuesta = true;
    const violaciones = validar(parsed.asignaciones) || [];
    const bloqueantes = violaciones.filter((v) => v.severidad === "error");
    historial.push({ intento, bloqueantes: bloqueantes.length, avisos: violaciones.length - bloqueantes.length });
    ultimasViolaciones = violaciones;

    if (bloqueantes.length === 0) {
      // Se devuelven TAMBIÉN los avisos: no bloquean (V-14), pero quien pulsó el botón tiene
      // derecho a ver que el mes que se acaba de guardar cojea en equidad.
      return { ok: true, asignaciones: parsed.asignaciones, violaciones, intentos: intento, historial };
    }

    siguiente = buildRetryPrompt({ prompt, propuesta: parsed.asignaciones, violaciones });
  }

  // Agotados los intentos. Se distingue «el modelo no supo cuadrar el mes» de «el modelo nunca
  // devolvió algo legible» porque piden cosas distintas de quien lo lee: la primera es un mes
  // difícil que hay que montar a mano; la segunda, un problema de configuración o de servicio.
  if (!huboPropuesta) {
    return {
      ok: false,
      resultado: "ERROR_MODELO",
      error: `el modelo no devolvió ninguna propuesta utilizable en ${maxIntentos} intentos: ${ultimoErrorModelo}`,
      violaciones: [],
      intentos: maxIntentos,
      historial,
    };
  }
  return {
    ok: false,
    resultado: "REVISION_MANUAL",
    error: `tras ${maxIntentos} intentos el cuadrante propuesto sigue incumpliendo reglas obligatorias: no se ha guardado nada y el mes queda para revisión manual`,
    violaciones: ultimasViolaciones,
    intentos: maxIntentos,
    historial,
  };
}

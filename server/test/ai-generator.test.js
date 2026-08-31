// Tests de server/src/ai-generator.js — el ciclo propuesta → validación → reintento (V-45).
//
// Es el corazón del encargo y por eso se prueba con un `llm` y un `validar` falsos: lo que se
// comprueba aquí no es que un modelo acierte (eso no se puede probar), sino que el ciclo se
// comporte igual pase lo que pase al otro lado — que reintente exactamente 3 veces, que le
// devuelva las violaciones concretas, y sobre todo que NUNCA declare bueno un cuadrante con
// errores. Un fallo aquí escribe un mes ilegal en el Sheet.

import test from "node:test";
import assert from "node:assert/strict";
import { generateSchedule, MAX_INTENTOS } from "../src/ai-generator.js";

const PROPUESTA = [{ fecha: "2026-08-01", residenteId: "r3a", codigo: "G" }];
const RESPUESTA = JSON.stringify({ asignaciones: PROPUESTA });

const ERROR_INV1 = { invariante: "INV-1", severidad: "error", detalle: "2026-08-04 sin ninguna asignación" };
const AVISO_INV3 = { invariante: "INV-3", severidad: "aviso", detalle: "r3a=6 vs r3b=3 en total" };

/** `llm` falso que devuelve la respuesta n-ésima y apunta cada prompt que recibe. */
function fakeLlm(respuestas) {
  const prompts = [];
  const fn = (prompt) => {
    prompts.push(prompt);
    const r = respuestas[prompts.length - 1];
    return typeof r === "function" ? r() : r;
  };
  fn.prompts = prompts;
  return fn;
}

const ok = (texto) => ({ ok: true, texto });

test("acierta al primer intento: no reintenta y devuelve la propuesta", () => {
  const llm = fakeLlm([ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, PROPUESTA);
  assert.equal(r.intentos, 1);
  assert.equal(llm.prompts.length, 1, "no debe pedir nada más si el primero ya vale");
});

test("los AVISOS no bloquean: se acepta la propuesta y los avisos viajan de vuelta", () => {
  const llm = fakeLlm([ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [AVISO_INV3] });

  // V-14: la equidad nunca bloquea. Un generador más estricto que el validador pediría un mes
  // que ninguna persona podría montar a mano tampoco.
  assert.equal(r.ok, true);
  assert.equal(r.intentos, 1);
  assert.deepEqual(r.violaciones, [AVISO_INV3]);
});

test("acierta al tercer intento tras dos rondas con errores", () => {
  const llm = fakeLlm([ok(RESPUESTA), ok(RESPUESTA), ok(RESPUESTA)]);
  let vez = 0;
  const r = generateSchedule({ prompt: "P", llm, validar: () => (++vez < 3 ? [ERROR_INV1] : []) });

  assert.equal(r.ok, true);
  assert.equal(r.intentos, 3);
  assert.equal(llm.prompts.length, 3);
});

test("el reintento le devuelve la lista CONCRETA de violaciones y su propuesta anterior", () => {
  const llm = fakeLlm([ok(RESPUESTA), ok(RESPUESTA)]);
  let vez = 0;
  generateSchedule({ prompt: "P", llm, validar: () => (++vez === 1 ? [ERROR_INV1, AVISO_INV3] : []) });

  const segundo = llm.prompts[1];
  assert.ok(segundo.includes(ERROR_INV1.detalle), "el reintento debe llevar el detalle del error");
  assert.ok(segundo.includes(AVISO_INV3.detalle), "también los avisos, para que mejore");
  assert.ok(segundo.includes("2026-08-01"), "y su propia propuesta anterior");
  assert.ok(segundo.includes("P"), "sobre el encargo original, no suelto");
});

test("tras 3 intentos con errores: NO se acepta nada y se marca para revisión manual", () => {
  const llm = fakeLlm([ok(RESPUESTA), ok(RESPUESTA), ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [ERROR_INV1] });

  assert.equal(r.ok, false);
  assert.equal(r.resultado, "REVISION_MANUAL");
  assert.equal(r.intentos, MAX_INTENTOS);
  assert.equal(llm.prompts.length, 3, "exactamente 3, ni uno más");
  assert.equal(r.asignaciones, undefined, "no puede devolver una propuesta que no vale");
  // Las violaciones que quedaban viajan: son lo que la persona tiene que resolver a mano.
  assert.deepEqual(r.violaciones, [ERROR_INV1]);
  assert.match(r.error, /3 intentos|revisión manual/i);
});

test("una respuesta ilegible gasta intento y el reintento explica el problema de formato", () => {
  const llm = fakeLlm([ok("no puedo ayudarte"), ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, true);
  assert.equal(r.intentos, 2);
  assert.match(llm.prompts[1], /PROBLEMA DE FORMATO/);
});

test("tres respuestas ilegibles seguidas: ERROR_MODELO, no revisión manual", () => {
  // La distinción importa: «el modelo no supo cuadrar el mes» y «el modelo no devolvió nunca un
  // JSON» piden cosas distintas de la persona que lo ve.
  const llm = fakeLlm([ok("hola"), ok("hola"), ok("hola")]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, false);
  assert.equal(r.resultado, "ERROR_MODELO");
  assert.equal(r.intentos, 3);
});

test("un fallo de transporte del modelo gasta intento pero no tumba el ciclo", () => {
  const llm = fakeLlm([{ ok: false, error: "HTTP 503" }, ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, true);
  assert.equal(r.intentos, 2);
});

test("si el modelo falla las 3 veces se devuelve SU error, no uno inventado", () => {
  const llm = fakeLlm([
    { ok: false, error: "HTTP 429: quota exceeded" },
    { ok: false, error: "HTTP 429: quota exceeded" },
    { ok: false, error: "HTTP 429: quota exceeded" },
  ]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, false);
  assert.equal(r.resultado, "ERROR_MODELO");
  assert.match(r.error, /429/, "el motivo real de Google tiene que llegar a la persona");
});

test("si el adaptador LANZA en vez de devolver {ok:false}, el ciclo lo trata igual", () => {
  // `Code.gs` es la única pieza sin tests: no se puede dar por hecho que cumpla el contrato.
  const llm = fakeLlm([() => { throw new Error("UrlFetchApp se cayó"); }, ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [] });

  assert.equal(r.ok, true);
  assert.equal(r.intentos, 2);
});

test("el historial guarda qué pasó en cada intento (es lo que va a la bitácora)", () => {
  const llm = fakeLlm([ok("basura"), ok(RESPUESTA), ok(RESPUESTA)]);
  let vez = 0;
  const r = generateSchedule({ prompt: "P", llm, validar: () => (++vez === 1 ? [ERROR_INV1] : []) });

  assert.equal(r.ok, true);
  assert.equal(r.historial.length, 3);
  assert.match(r.historial[0].motivo, /JSON|formato|leer/i);
  assert.equal(r.historial[1].bloqueantes, 1);
  assert.equal(r.historial[2].bloqueantes, 0);
});

test("maxIntentos es configurable, pero el defecto del encargo son 3", () => {
  assert.equal(MAX_INTENTOS, 3);
  const llm = fakeLlm([ok(RESPUESTA), ok(RESPUESTA), ok(RESPUESTA)]);
  const r = generateSchedule({ prompt: "P", llm, validar: () => [ERROR_INV1], maxIntentos: 1 });
  assert.equal(r.intentos, 1);
  assert.equal(llm.prompts.length, 1);
});

test("valida SIEMPRE lo parseado, nunca lo que el modelo dice de sí mismo", () => {
  // Un modelo que responde «este cuadrante cumple todas las normas» no cambia nada: el veredicto
  // sale de `validar`, y de ningún otro sitio.
  const llm = fakeLlm([ok('Cumple todas las normas.\n' + RESPUESTA)]);
  let visto = null;
  const r = generateSchedule({ prompt: "P", llm, validar: (a) => { visto = a; return [ERROR_INV1]; } });

  assert.deepEqual(visto, PROPUESTA);
  assert.equal(r.ok, false);
});

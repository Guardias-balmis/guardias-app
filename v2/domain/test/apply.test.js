// Tests de v2/domain/apply.js — el lote que deja el mes EXACTAMENTE como la propuesta
// del generador. Lo que se verifica sobre todo es la regresión que motivó el módulo: aplicar
// AÑADÍA sobre lo que ya había, así que un día podía acabar con tres personas después de que la
// pantalla dijera «sin violaciones».
import test from "node:test";
import assert from "node:assert/strict";
import { monthReplacementPlan } from "../apply.js";

// Todos los ids que usan los tests, salvo donde se prueba justo lo contrario.
const RESIDENTES = ["r1", "r2", "r3", "r4", "r4x", "mayorViejo", "mayorNuevo", "pequeno", "viejo", "nuevo"].map((id) => ({ id }));
const MES = { mes: 8, anio: 2026, residentes: RESIDENTES };
const a = (fecha, residenteId, codigo, extra = {}) => ({ fecha, residenteId, codigo, ...extra });
const borrados = (plan) => plan.cambios.filter((c) => c.codigo === "");

test("mes vacío: los cambios son exactamente la propuesta, sin un solo borrado", () => {
  const propuesta = [a("2026-08-01", "r1", "G"), a("2026-08-01", "r3", "G")];
  const plan = monthReplacementPlan({ ...MES, existentes: [], propuesta });

  assert.deepEqual(plan.cambios, propuesta);
  assert.equal(plan.borradas.length, 0);
  assert.equal(plan.fueraDelMes.length, 0);
});

test("la guardia previa de OTRO residente el mismo día se borra (la regresión de los 3 por día)", () => {
  // El escenario real: se genera dos veces y en la segunda vuelta el modelo cambia de Mayor.
  const existentes = [a("2026-08-01", "mayorViejo", "G"), a("2026-08-01", "pequeno", "G")];
  const propuesta = [a("2026-08-01", "mayorNuevo", "G"), a("2026-08-01", "pequeno", "G")];
  const plan = monthReplacementPlan({ ...MES, existentes, propuesta });

  assert.deepEqual(plan.borradas, [a("2026-08-01", "mayorViejo", "G")]);
  assert.deepEqual(borrados(plan), [{ fecha: "2026-08-01", residenteId: "mayorViejo", codigo: "" }]);
  // `pequeno` no se borra: la propuesta lo pisa por clave, y borrarlo además dejaría el día
  // dependiendo del orden de las filas dentro del mismo lote.
  assert.equal(plan.borradas.some((x) => x.residenteId === "pequeno"), false);
});

test("mismo residente y día con código distinto: se pisa por clave, no se borra", () => {
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-15", "r2", "G")],
    propuesta: [a("2026-08-15", "r2", "GF")],
  });

  assert.equal(plan.borradas.length, 0);
  assert.deepEqual(plan.cambios, [{ fecha: "2026-08-15", residenteId: "r2", codigo: "GF" }]);
});

test("los marcadores V/R/B se conservan: el generador no los propone y no le pertenecen", () => {
  const existentes = [a("2026-08-10", "r1", "V"), a("2026-08-11", "r1", "R"), a("2026-08-12", "r1", "B")];
  const plan = monthReplacementPlan({ ...MES, existentes, propuesta: [a("2026-08-20", "r1", "G")] });

  assert.equal(plan.borradas.length, 0);
  assert.equal(plan.marcadores.length, 3);
  assert.equal(borrados(plan).length, 0);
});

test("una guardia propuesta sobre un marcador del mismo residente/día lo pisa sin borrarlo aparte", () => {
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-10", "r1", "V")],
    propuesta: [a("2026-08-10", "r1", "G")],
  });

  assert.deepEqual(plan.cambios, [{ fecha: "2026-08-10", residenteId: "r1", codigo: "G" }]);
  assert.deepEqual(plan.marcadores, [a("2026-08-10", "r1", "V")]);
});

// Decisión V-38: el 3P le pertenece al generador SOLO cuando lo propone. Antes estaba fijo entre
// los borrables, y como `schedule.js` no repartía 3P, regenerar un mes se llevaba por delante los
// 3P puestos a mano — los únicos que había — contándolos además como «guardias» en el aviso.
test("una propuesta SIN 3P no toca los 3P que ya haya: no son suyos", () => {
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-03", "r4", "3P")],
    propuesta: [a("2026-08-03", "r4x", "G")],
  });

  assert.deepEqual(borrados(plan), []);
  assert.deepEqual(plan.marcadores.map((x) => x.codigo), ["3P"]);
});

test("una propuesta CON 3P sí manda sobre ellos: el 3P que no reemplaza, lo borra", () => {
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-03", "r4", "3P")],
    propuesta: [a("2026-08-03", "r4x", "G"), a("2026-08-10", "r2", "3P")],
  });

  assert.deepEqual(borrados(plan), [{ fecha: "2026-08-03", residenteId: "r4", codigo: "" }]);
});

test("reemplazar una cedida/comprada le quita el `origen`: vuelve al cómputo que juzgó el validador", () => {
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-07", "r3", "G", { origen: "CEDIDA" })],
    propuesta: [a("2026-08-07", "r3", "G")],
  });

  assert.equal(plan.cambios.length, 1);
  assert.equal("origen" in plan.cambios[0], false);
});

test("una fecha de otro mes se reporta en fueraDelMes en vez de colarse en silencio", () => {
  // Ningún invariante de validateMonth la mira, pero guardarAsignaciones sí la escribiría.
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [],
    propuesta: [a("2026-08-31", "r1", "G"), a("2026-09-03", "r1", "G")],
  });

  assert.deepEqual(plan.fueraDelMes, [a("2026-09-03", "r1", "G")]);
});

test("una fecha imposible (30 de febrero) también cae en fueraDelMes", () => {
  const plan = monthReplacementPlan({
    mes: 2, anio: 2026, residentes: RESIDENTES, existentes: [],
    propuesta: [a("2026-02-30", "r1", "G")],
  });

  assert.deepEqual(plan.fueraDelMes, [a("2026-02-30", "r1", "G")]);
});

test("un residenteId que no es de nadie se reporta en desconocidos", () => {
  // Pasó de verdad al verificar el reemplazo: un id mal escrito (res-carl por res-carlos) solo
  // producía `aviso` en INV-1, así que se aplicaba — y con el reemplazo puesto, borraba el
  // cuadrante bueno a cambio de 31 filas que no se ven en ninguna pantalla.
  const plan = monthReplacementPlan({
    ...MES, existentes: [],
    propuesta: [a("2026-08-01", "r3", "G"), a("2026-08-01", "res-carl", "G")],
  });

  assert.deepEqual(plan.desconocidos, [a("2026-08-01", "res-carl", "G")]);
});

test("sin ids desconocidos, `desconocidos` queda vacío", () => {
  const plan = monthReplacementPlan({ ...MES, existentes: [], propuesta: [a("2026-08-01", "r3", "G")] });
  assert.deepEqual(plan.desconocidos, []);
});

test("un residente que ya no está en el equipo puede seguir teniendo guardias que borrar", () => {
  // `existentes` NO se filtra por `residentes`: una guardia vieja de quien ya terminó la
  // residencia hay que poder quitarla del mes, y el filtro de ids solo mira la propuesta.
  const plan = monthReplacementPlan({
    ...MES,
    existentes: [a("2026-08-02", "yaNoEsta", "G")],
    propuesta: [a("2026-08-02", "r3", "G")],
  });

  assert.deepEqual(plan.desconocidos, []);
  assert.deepEqual(borrados(plan), [{ fecha: "2026-08-02", residenteId: "yaNoEsta", codigo: "" }]);
});

test("un mes lleno que se regenera entero: todo lo previo que no reaparece se borra", () => {
  const existentes = Array.from({ length: 5 }, (_, i) => a(`2026-08-0${i + 1}`, "viejo", "G"));
  const propuesta = Array.from({ length: 5 }, (_, i) => a(`2026-08-0${i + 1}`, "nuevo", "G"));
  const plan = monthReplacementPlan({ ...MES, existentes, propuesta });

  assert.equal(plan.borradas.length, 5);
  assert.equal(plan.cambios.length, 10);
});

// ── monthCompletionPlan (decisión V-47): lo que ya hay se respeta, la propuesta solo rellena ──
import { monthCompletionPlan } from "../apply.js";

test("completar un mes vacío: los cambios son la propuesta entera, sin fijadas ni borrados", () => {
  const propuesta = [a("2026-08-01", "r1", "G"), a("2026-08-01", "r3", "G")];
  const plan = monthCompletionPlan({ ...MES, existentes: [], propuesta });
  assert.deepEqual(plan.cambios, propuesta);
  assert.deepEqual(plan.fijadas, []);
  assert.deepEqual(plan.conflictos, []);
  assert.deepEqual(plan.borradas, []);
});

test("completar NUNCA borra: la guardia previa que la propuesta no repite sigue en el mes (es una fijada)", () => {
  // El caso que motiva el modo: un residente puso su guardia del 15 antes de generar.
  const existentes = [a("2026-08-15", "r2", "G")];
  const propuesta = [a("2026-08-01", "r1", "G"), a("2026-08-02", "r3", "G")];
  const plan = monthCompletionPlan({ ...MES, existentes, propuesta });
  assert.deepEqual(plan.fijadas, existentes);
  assert.deepEqual(plan.borradas, []);
  assert.equal(borrados(plan).length, 0);
  assert.equal(plan.cambios.length, 2);
});

test("una fijada repetida por la propuesta (misma clave y código) no se reescribe: conserva su origen", () => {
  const existentes = [a("2026-08-15", "r2", "G", { origen: "CEDIDA" })];
  const propuesta = [a("2026-08-15", "r2", "G"), a("2026-08-16", "r3", "G")];
  const plan = monthCompletionPlan({ ...MES, existentes, propuesta });
  assert.deepEqual(plan.cambios, [{ fecha: "2026-08-16", residenteId: "r3", codigo: "G" }]);
  assert.deepEqual(plan.conflictos, []);
});

test("una fijada pisada con OTRO código es un conflicto: no entra en los cambios y se reporta", () => {
  const existentes = [a("2026-08-15", "r2", "G")];
  const propuesta = [a("2026-08-15", "r2", "GF")];
  const plan = monthCompletionPlan({ ...MES, existentes, propuesta });
  assert.deepEqual(plan.cambios, []);
  assert.equal(plan.conflictos.length, 1);
  assert.deepEqual(plan.conflictos[0].fijada, existentes[0]);
  assert.deepEqual(plan.conflictos[0].propuesta, propuesta[0]);
});

test("los 3P que ya había son fijadas aunque la propuesta no traiga ningún 3P", () => {
  const plan = monthCompletionPlan({ ...MES, existentes: [a("2026-08-03", "r4", "3P")], propuesta: [a("2026-08-04", "r1", "G")] });
  assert.deepEqual(plan.fijadas.map((x) => x.codigo), ["3P"]);
  assert.equal(borrados(plan).length, 0);
});

test("los marcadores V/R/B no son fijadas (nadie los respeta ni los borra); una guardia propuesta encima se REPORTA en `pisados`, porque por clave la sustituiría", () => {
  const existentes = [a("2026-08-10", "r1", "V"), a("2026-08-11", "r1", "B")];
  const plan = monthCompletionPlan({ ...MES, existentes, propuesta: [a("2026-08-10", "r1", "G")] });
  assert.deepEqual(plan.fijadas, []);
  assert.deepEqual(plan.marcadores, existentes);
  assert.deepEqual(plan.cambios, [{ fecha: "2026-08-10", residenteId: "r1", codigo: "G" }]);
  assert.deepEqual(plan.pisados, [{ propuesta: a("2026-08-10", "r1", "G"), marcador: existentes[0] }]);
  // Y en reemplazar exactamente igual: la promesa de la tarjeta («se conservan») es de los dos modos.
  const plan2 = monthReplacementPlan({ ...MES, existentes, propuesta: [a("2026-08-10", "r1", "G")] });
  assert.equal(plan2.pisados.length, 1);
  // Un 3P previo que la propuesta pisa no es un marcador V/R/B: no se reporta aquí.
  assert.deepEqual(monthReplacementPlan({ ...MES, existentes: [a("2026-08-10", "r1", "3P")], propuesta: [a("2026-08-10", "r1", "G")] }).pisados, []);
});

test("una clave fecha|residente repetida en la propuesta se reporta en `duplicadas` (los dos planes): el validador juzgaría una lista y el Sheet guardaría otra", () => {
  const propuesta = [a("2026-08-03", "r4", "G"), a("2026-08-03", "r1", "G"), a("2026-08-03", "r4", "3P")];
  for (const plan of [monthReplacementPlan({ ...MES, existentes: [], propuesta }), monthCompletionPlan({ ...MES, existentes: [], propuesta })]) {
    assert.deepEqual(plan.duplicadas, [{ fecha: "2026-08-03", residenteId: "r4", codigos: ["G", "3P"] }]);
  }
  assert.deepEqual(monthReplacementPlan({ ...MES, existentes: [], propuesta: propuesta.slice(0, 2) }).duplicadas, []);
});

test("completar mantiene el guardarraíl de V-31: fechas de otro mes e ids desconocidos se reportan", () => {
  const plan = monthCompletionPlan({
    ...MES, existentes: [],
    propuesta: [a("2026-09-01", "r1", "G"), a("2026-08-01", "nadie", "G")],
  });
  assert.deepEqual(plan.fueraDelMes, [a("2026-09-01", "r1", "G")]);
  assert.deepEqual(plan.desconocidos, [a("2026-08-01", "nadie", "G")]);
});

test("un mes ya completo devuelto tal cual por el modelo no produce ni un cambio", () => {
  const existentes = [a("2026-08-01", "r1", "G"), a("2026-08-01", "r3", "G")];
  const plan = monthCompletionPlan({ ...MES, existentes, propuesta: existentes.map((x) => ({ ...x })) });
  assert.deepEqual(plan.cambios, []);
  assert.equal(plan.fijadas.length, 2);
});

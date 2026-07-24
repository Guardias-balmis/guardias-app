// Tests de v2/domain/accumulate.js — contaje acumulado por residente para el generador
// «prompt portátil» (Fase 6.1, spec.md §4: "la ventana es del residente"). Ayuda a la IA
// a repartir con equidad entre meses sin re-implementar la lógica de periodos/tally.
import test from "node:test";
import assert from "node:assert/strict";
import { accumulatedTally } from "../accumulate.js";

const ANA = { id: "ana", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" }; // R3 en 2026-07
const NUEVO = { id: "nuevo", fechaInicio: "2026-07-10", fechaFin: "2030-07-09" }; // empieza a mitad de julio

test("accumulatedTally cuenta las guardias del residente dentro de SU año de residencia en curso", () => {
  const asignaciones = [
    { residenteId: "ana", fecha: "2026-06-05", codigo: "G" },   // dentro del periodo R3 (empieza 2026-05-07)
    { residenteId: "ana", fecha: "2026-06-07", codigo: "GF" },
    { residenteId: "ana", fecha: "2025-05-01", codigo: "G" },   // año anterior (R2): no debe contar
  ];
  const out = accumulatedTally([ANA], asignaciones, "2026-06-30"); // hasta fin de junio, generando julio
  assert.equal(out.get("ana").total, 2);
  assert.equal(out.get("ana").festivos, 1);
});

test("accumulatedTally: residente cuyo año de residencia en curso aún no ha empezado da todo a cero (sin lanzar)", () => {
  const asignaciones = [{ residenteId: "nuevo", fecha: "2026-07-12", codigo: "G" }]; // tras hasta, no cuenta igualmente
  const out = accumulatedTally([NUEVO], asignaciones, "2026-06-30"); // el periodo de NUEVO empieza el 10-jul
  assert.deepEqual(out.get("nuevo"), { total: 0, finde: 0, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("accumulatedTally no mezcla guardias de otro residente", () => {
  const asignaciones = [
    { residenteId: "ana", fecha: "2026-06-05", codigo: "G" },
    { residenteId: "otro", fecha: "2026-06-06", codigo: "G" },
  ];
  const out = accumulatedTally([ANA], asignaciones, "2026-06-30");
  assert.equal(out.get("ana").total, 1);
});

test("accumulatedTally respeta el lookahead de doblete (C-1) si el llamador incluye los ~2 días tras `hasta`", () => {
  // Viernes 26-jun (dentro de la ventana) + domingo 28-jun (fuera de la ventana, pero presente
  // en la lista): el doblete se atribuye al mes de junio pese a que `hasta` corta el 26.
  const asignaciones = [
    { residenteId: "ana", fecha: "2026-06-26", codigo: "G" }, // viernes
    { residenteId: "ana", fecha: "2026-06-28", codigo: "G" }, // domingo, fuera de [start,hasta]
  ];
  const out = accumulatedTally([ANA], asignaciones, "2026-06-26");
  assert.equal(out.get("ana").dobletes, 1);
  assert.equal(out.get("ana").total, 1); // el domingo, fuera de ventana, no suma a total
});

test("accumulatedTally: si `hasta` es el último día de un periodo, el contaje resetea a cero (no arrastra el año saliente)", () => {
  // hasta = 2026-05-06 es el último día de R2 de ANA; hasta+1 (2026-05-07) es ya el
  // aniversario de R3. La ventana pasada a tally queda invertida (correcto, ver comentario
  // en accumulate.js) y debe dar cero pese a que hay guardias reales dentro de R2.
  const asignaciones = [
    { residenteId: "ana", fecha: "2026-04-01", codigo: "G" }, // dentro de R2 (año saliente)
    { residenteId: "ana", fecha: "2025-06-01", codigo: "G" }, // también dentro de R2
  ];
  const out = accumulatedTally([ANA], asignaciones, "2026-05-06");
  assert.equal(out.get("ana").total, 0);
});

test("accumulatedTally usa fechaFin EXPLÍCITO (residencia alargada por baja) para seguir contando en R4 más allá del fin por defecto", () => {
  // Residencia alargada 3 meses (nota [a] de la normativa): sin fechaFin explícito, R4
  // terminaría el 2028-05-06; con la baja, sigue siendo R4 hasta el 2028-08-15.
  const alargada = { id: "alargada", fechaInicio: "2024-05-07", fechaFin: "2028-08-15" };
  const asignaciones = [
    { residenteId: "alargada", fecha: "2027-06-01", codigo: "G" }, // dentro de R4, antes del fin "por defecto"
    { residenteId: "alargada", fecha: "2028-06-01", codigo: "G" }, // dentro de R4 SOLO gracias al fechaFin extendido
  ];
  const out = accumulatedTally([alargada], asignaciones, "2028-08-10"); // tras el fin "por defecto" (2028-05-06)
  assert.equal(out.get("alargada").total, 2);
});

test("accumulatedTally devuelve un Map con una entrada por cada residente recibido", () => {
  const out = accumulatedTally([ANA, NUEVO], [], "2026-06-30");
  assert.equal(out.size, 2);
  assert.ok(out.has("ana"));
  assert.ok(out.has("nuevo"));
});

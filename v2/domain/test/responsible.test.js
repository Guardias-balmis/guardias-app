// Tests de v2/domain/responsible.js — INV-14 (spec.md): Responsable del contaje, R3 de
// enero a enero, sorteo auditable. Normativa: "recae sobre un R3 de enero a enero de R4 ...
// designado por sorteo en ausencia de voluntarios" (docs/normativa.pdf). Decisión Fase 5:
// si se ofrecen ≥2 voluntarios, se sortea SOLO entre ellos (la normativa no cubre ese caso);
// la semilla la genera la app (no una fuente externa) pero el sorteo es recomputable a
// partir de (semilla, candidatos) guardados.
import test from "node:test";
import assert from "node:assert/strict";
import { eligibleCandidates, resolveMethod, drawResponsible, validateResponsible } from "../responsible.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });

// Los tres nacen R3 el 2026-05-27 y siguen R3 hasta el 2027-05-26 (R4 después) — igual que
// las fixtures de equity.test.js.
const A = R("r3a", "2024-05-27", "2028-05-26");
const B = R("r3b", "2024-05-27", "2028-05-26");
const C = R("r3c", "2024-05-27", "2028-05-26");
const R2 = R("r2x", "2025-05-26", "2029-05-25"); // R2 en 2027-01-01, no elegible
const R4PREV = R("r4x", "2023-05-27", "2027-05-26"); // R4 en 2027-01-01, no elegible

const PERIODO_INICIO = "2027-01-01";
const PERIODO_FIN = "2028-01-01";
const RESIDENTES = [A, B, C, R2, R4PREV];

test("eligibleCandidates: solo los R3 en periodoInicio, ordenados por id", () => {
  const elegibles = eligibleCandidates(RESIDENTES, PERIODO_INICIO);
  assert.deepEqual(elegibles, ["r3a", "r3b", "r3c"]);
});

test("eligibleCandidates: ninguno es R3 esa fecha → lista vacía", () => {
  assert.deepEqual(eligibleCandidates(RESIDENTES, "2020-01-01"), []);
});

test("resolveMethod: sin voluntarios → SORTEO entre todos los elegibles", () => {
  const r = resolveMethod(["r3a", "r3b", "r3c"], []);
  assert.equal(r.metodo, "SORTEO");
  assert.deepEqual(r.candidatos, ["r3a", "r3b", "r3c"]);
});

test("resolveMethod: un solo voluntario → VOLUNTARIO directo, sin sorteo", () => {
  const r = resolveMethod(["r3a", "r3b", "r3c"], ["r3b"]);
  assert.equal(r.metodo, "VOLUNTARIO");
  assert.equal(r.residenteId, "r3b");
});

test("resolveMethod: dos o más voluntarios → SORTEO solo entre ellos (decisión Fase 5)", () => {
  const r = resolveMethod(["r3a", "r3b", "r3c"], ["r3c", "r3a"]);
  assert.equal(r.metodo, "SORTEO");
  assert.deepEqual(r.candidatos, ["r3a", "r3c"]); // NO incluye a r3b, que no se ofreció
});

test("resolveMethod: ignora voluntarios que no son elegibles (defensivo)", () => {
  const r = resolveMethod(["r3a", "r3b"], ["r3a", "intruso"]);
  assert.equal(r.metodo, "VOLUNTARIO");
  assert.equal(r.residenteId, "r3a");
});

test("drawResponsible: determinista — mismo (candidatos, semilla) siempre da el mismo resultado", () => {
  const candidatos = ["r3a", "r3b", "r3c"];
  const r1 = drawResponsible(candidatos, "semilla-2027");
  const r2 = drawResponsible(candidatos, "semilla-2027");
  assert.equal(r1, r2);
  assert.ok(candidatos.includes(r1));
});

test("drawResponsible: el resultado no depende del orden de llegada de candidatos", () => {
  const a = drawResponsible(["r3c", "r3a", "r3b"], "semilla-x");
  const b = drawResponsible(["r3a", "r3b", "r3c"], "semilla-x");
  assert.equal(a, b);
});

test("drawResponsible: la semilla sí influye en el resultado (no es un valor fijo ignorando la semilla)", () => {
  const candidatos = ["r3a", "r3b", "r3c", "r3d", "r3e"];
  const resultados = new Set(Array.from({ length: 20 }, (_, i) => drawResponsible(candidatos, `semilla-${i}`)));
  assert.ok(resultados.size > 1, "20 semillas distintas deberían producir más de un ganador distinto");
});

test("drawResponsible: rechaza candidatos vacíos o semilla ausente", () => {
  assert.throws(() => drawResponsible([], "semilla"));
  assert.throws(() => drawResponsible(["r3a"], undefined));
});

test("INV-14: mandato VOLUNTARIO correcto (único voluntario elegible) no viola", () => {
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: "r3b", metodo: "VOLUNTARIO", voluntarios: ["r3b"],
  };
  assert.deepEqual(validateResponsible(responsable, { residentes: RESIDENTES }), []);
});

test("INV-14: se declara VOLUNTARIO pero había 0 voluntarios registrados → violación", () => {
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: "r3b", metodo: "VOLUNTARIO", voluntarios: [],
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.equal(v.length, 1);
  assert.equal(v[0].invariante, "INV-14");
});

test("INV-14: SORTEO sin voluntarios, semilla+candidatos reproducen al residente → no viola", () => {
  const candidatos = eligibleCandidates(RESIDENTES, PERIODO_INICIO);
  const semilla = "semilla-real-2027";
  const ganador = drawResponsible(candidatos, semilla);
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: ganador, metodo: "SORTEO", voluntarios: [], candidatos, semilla, fechaSorteo: "2026-12-15",
  };
  assert.deepEqual(validateResponsible(responsable, { residentes: RESIDENTES }), []);
});

test("INV-14: SORTEO con ≥2 voluntarios pero candidatos = todos los R3 (no solo voluntarios) → violación", () => {
  const todosLosElegibles = eligibleCandidates(RESIDENTES, PERIODO_INICIO); // r3a, r3b, r3c
  const voluntarios = ["r3a", "r3c"];
  const semilla = "semilla-voluntarios";
  const ganador = drawResponsible(todosLosElegibles, semilla); // sorteado sobre el pool INCORRECTO
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: ganador, metodo: "SORTEO", voluntarios, candidatos: todosLosElegibles, semilla, fechaSorteo: "2026-12-15",
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.ok(v.some((x) => x.invariante === "INV-14"));
});

test("INV-14: falta la semilla en un mandato SORTEO → violación (no es recomputable)", () => {
  const candidatos = eligibleCandidates(RESIDENTES, PERIODO_INICIO);
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: "r3a", metodo: "SORTEO", voluntarios: [], candidatos,
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.ok(v.some((x) => x.invariante === "INV-14"));
});

test("INV-14: el sorteo guardado no es reproducible (residente no coincide con recomputar) → violación", () => {
  const candidatos = eligibleCandidates(RESIDENTES, PERIODO_INICIO);
  const semilla = "semilla-manipulada";
  const ganadorReal = drawResponsible(candidatos, semilla);
  const otro = candidatos.find((id) => id !== ganadorReal);
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: otro, metodo: "SORTEO", voluntarios: [], candidatos, semilla, fechaSorteo: "2026-12-15",
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.ok(v.some((x) => x.invariante === "INV-14" && /reproducible/i.test(x.detalle)));
});

test("INV-14: el residente asignado no tiene nivel R3 en periodoInicio → violación", () => {
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: "r2x", metodo: "VOLUNTARIO", voluntarios: ["r2x"],
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.ok(v.some((x) => x.invariante === "INV-14"));
});

test("INV-14: el mandato debe ir de enero a enero — periodoFin incorrecto → violación", () => {
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: "2027-06-01",
    residenteId: "r3a", metodo: "VOLUNTARIO", voluntarios: ["r3a"],
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.ok(v.some((x) => x.invariante === "INV-14"));
});

test("INV-14: residenteId desconocido → violación (no explota)", () => {
  const responsable = {
    periodoInicio: PERIODO_INICIO, periodoFin: PERIODO_FIN,
    residenteId: "fantasma", metodo: "VOLUNTARIO", voluntarios: ["fantasma"],
  };
  const v = validateResponsible(responsable, { residentes: RESIDENTES });
  assert.equal(v.length, 1);
  assert.equal(v[0].invariante, "INV-14");
});

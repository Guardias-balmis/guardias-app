// Tests de v2/domain/thirdpost.js — INV-8 (tercer puesto). spec.md §5.
// Reglas: (a) solo voluntarios; (b) rotación de días por residente sobre su historial de
// 3P (7 días distintos antes de repetir, acumula entre meses, reinicia al completarse);
// (c) equidad ≤1 entre voluntarios al cierre del año de residencia; (d) prioridad mochila.
import test from "node:test";
import assert from "node:assert/strict";
import { validateThirdPost } from "../thirdpost.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const p3 = (residenteId, fecha) => ({ residenteId, fecha, codigo: "3P" });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });

const ANA = R("r3-ana", "2024-05-25", "2028-05-24");
const BRUNO = R("r2-bruno", "2025-05-25", "2029-05-24");
const CARLA = R("r2-carla", "2025-05-25", "2029-05-24");
const DAVID = R("r4-david", "2023-05-25", "2027-05-24");
const EVA = R("r1-eva", "2026-05-25", "2030-05-24");

const only8 = (v) => v.filter((x) => x.invariante === "INV-8" && x.severidad === "error");

test("INV-8b: ciclo completo permite repetir día", () => {
  const historial3P = { "r3-ana": ["2026-06-01", "2026-06-09", "2026-06-17", "2026-06-25", "2026-07-03", "2026-07-11", "2026-07-19"] };
  const v = validateThirdPost({ mes: 8, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2026-08-03")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: repetición de día entre meses con ciclo incompleto", () => {
  const historial3P = { "r2-bruno": ["2026-09-04", "2026-09-15"] }; // V, M
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [BRUNO], voluntarios3P: ["r2-bruno"], historial3P, asignaciones: [p3("r2-bruno", "2026-10-02")] }); // viernes: repite V
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-10-02");
  assert.equal(e[0].residenteId, "r2-bruno");
});

test("INV-8b: mismo día de semana en dos residentes distintos es válido", () => {
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [CARLA, BRUNO], voluntarios3P: ["r2-carla", "r2-bruno"], historial3P: {}, asignaciones: [p3("r2-carla", "2026-10-03"), p3("r2-bruno", "2026-10-10")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: repetición dentro del segundo ciclo", () => {
  const historial3P = { "r3-ana": ["2026-06-01", "2026-06-09", "2026-06-17", "2026-06-25", "2026-07-03", "2026-07-11", "2026-07-19", "2026-08-03"] };
  const v = validateThirdPost({ mes: 8, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2026-08-17")] }); // L repetido en ciclo 2
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-08-17");
});

test("INV-8b: repetición dentro del mismo mes (segunda asignación viola)", () => {
  const v = validateThirdPost({ mes: 11, anio: 2026, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P: {}, asignaciones: [p3("r2-carla", "2026-11-06"), p3("r2-carla", "2026-11-20")] }); // dos viernes
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-11-20");
});

test("INV-8b: orden libre dentro del ciclo (D→L→J no repite)", () => {
  const historial3P = { "r2-bruno": ["2026-09-06", "2026-09-14"] }; // D, L
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [BRUNO], voluntarios3P: ["r2-bruno"], historial3P, asignaciones: [p3("r2-bruno", "2026-10-01")] }); // J
  assert.equal(only8(v).length, 0);
});

test("INV-8b: el ciclo no se reinicia por el cambio de año natural", () => {
  const historial3P = { "r3-ana": ["2026-12-28", "2026-12-30"] }; // L, X
  const v = validateThirdPost({ mes: 1, anio: 2027, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2027-01-04")] }); // L repetido
  assert.equal(only8(v).length, 1);
});

test("INV-8a: 3P asignado a un no voluntario", () => {
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA, BRUNO, CARLA, DAVID], voluntarios3P: ["r3-ana", "r2-bruno", "r2-carla"], historial3P: {}, asignaciones: [p3("r4-david", "2026-10-17")] });
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].residenteId, "r4-david");
});

test("INV-8c: diferencia 2 a mitad de año no es error", () => {
  const historial3P = {
    "r3-ana": ["2026-06-03", "2026-07-07", "2026-08-13", "2026-09-05"],
    "r2-bruno": ["2026-06-15", "2026-07-26", "2026-08-29"],
  };
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones: [p3("r3-ana", "2026-10-23")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8c: diferencia 2 al cierre del año de residencia es error", () => {
  const historial3P = {
    "r2-bruno": ["2026-06-08", "2026-07-14", "2026-09-16", "2026-11-19", "2027-02-13"],
    "r2-carla": ["2026-06-22", "2026-08-19", "2026-12-11", "2027-03-06"],
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [BRUNO, CARLA], voluntarios3P: ["r2-bruno", "r2-carla"], historial3P, asignaciones: [p3("r2-bruno", "2027-05-14")] });
  const e = only8(v);
  assert.equal(e.length, 1); // Bruno 6, Carla 4 → diferencia 2 al cierre 2027-05-24
});

test("INV-8c: 3P posterior al aniversario cuenta el año siguiente", () => {
  const historial3P = {
    "r2-bruno": ["2026-06-08", "2026-07-14", "2026-09-16", "2026-11-19", "2027-02-13"], // 5 en el año que cierra
    "r2-carla": ["2026-06-22", "2026-08-19", "2026-12-11", "2027-03-06"], // 4
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [BRUNO, CARLA], voluntarios3P: ["r2-bruno", "r2-carla"], historial3P, asignaciones: [p3("r2-bruno", "2027-05-28")] }); // tras el cierre
  assert.equal(only8(v).length, 0); // al cierre: 5 vs 4, diferencia 1
});

test("INV-8c: no voluntario excluido del cómputo de equidad", () => {
  const historial3P = {
    "r3-ana": ["2026-07-06", "2026-10-13", "2027-01-20"],
    "r2-bruno": ["2026-08-27", "2027-02-19"],
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [ANA, BRUNO, DAVID], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones: [] });
  assert.equal(only8(v).length, 0); // Ana 3, Bruno 2 → diferencia 1; David (no voluntario) fuera
});

test("INV-8d: mochila descubierta con 3P mal priorizado", () => {
  // r1-eva de mochila el 2026-09-11 (V); único 3P el 2026-09-12 (S, sin R1)
  const asignaciones = [g("r1-eva", "2026-09-11", "G"), p3("r2-bruno", "2026-09-12")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, BRUNO], voluntarios3P: ["r2-bruno"], historial3P: {}, asignaciones });
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-09-11");
});

test("INV-8d: 3P extra válido con mochilas cubiertas", () => {
  const asignaciones = [
    g("r1-eva", "2026-09-11", "G"), g("r1-eva", "2026-09-25", "G"),
    p3("r3-ana", "2026-09-11"), p3("r2-carla", "2026-09-25"),
    p3("r2-bruno", "2026-09-19"), // extra en día sin R1
  ];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, CARLA, BRUNO], voluntarios3P: ["r3-ana", "r2-carla", "r2-bruno"], historial3P: {}, asignaciones });
  assert.equal(only8(v).length, 0);
});

test("INV-8d: mochila descubierta sin ningún 3P no es error (3P es voluntario)", () => {
  const asignaciones = [g("r1-eva", "2026-09-11", "G"), g("r1-eva", "2026-09-18", "G")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P: {}, asignaciones });
  assert.equal(only8(v).length, 0);
});

test("INV-8d: prioridad mochila no exime la rotación", () => {
  // mochila 2026-09-20 (D) cubierta por r3-ana, pero ana repite domingo (ciclo incompleto con D)
  const historial3P = { "r3-ana": ["2026-09-06"] }; // D
  const asignaciones = [g("r1-eva", "2026-09-20", "G"), p3("r3-ana", "2026-09-20")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones });
  const e = only8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-09-20");
  assert.equal(e[0].residenteId, "r3-ana");
});

test("INV-8: voluntario nuevo con historial ausente no lanza", () => {
  const v = validateThirdPost({ mes: 1, anio: 2027, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P: {}, asignaciones: [p3("r2-carla", "2027-01-13")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: la rotación solo mira códigos 3P, no las G", () => {
  const historial3P = { "r3-ana": ["2026-10-06"] }; // M
  const asignaciones = [g("r3-ana", "2026-10-05", "G"), g("r3-ana", "2026-10-19", "G"), p3("r3-ana", "2026-10-26")]; // 3P lunes
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones });
  assert.equal(only8(v).length, 0); // lunes no está en su ciclo 3P (solo martes)
});

test("INV-8b: ciclo repartido en tres meses cruzando febrero se completa", () => {
  const historial3P = { "r2-carla": ["2026-12-25", "2027-01-16", "2027-01-24"] }; // V, S, D
  const asignaciones = ["2027-02-01", "2027-02-09", "2027-02-17", "2027-02-25"].map((f) => p3("r2-carla", f)); // L, M, X, J
  const v = validateThirdPost({ mes: 2, anio: 2027, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P, asignaciones });
  assert.equal(only8(v).length, 0); // 7 días distintos, sin repetición
});

// Tests de v2/domain/equity.js — INV-3 (equidad al cierre del año de residencia) + INV-4.
// La ventana es el año de residencia INDIVIDUAL (aniversario), no el académico. Solo se
// evalúa en el mes que contiene el cierre. Entrada tipo "Resumen del Excel": acumulados
// hasta el mes anterior + asignaciones del mes (tally excluye 3P y cedidas/compradas → INV-4).
import test from "node:test";
import assert from "node:assert/strict";
import { validateResidencyYearClose } from "../equity.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const acc = (total, findes = 0, festivos = 0, puentesLibres = 0, dobletes = 0) => ({ total, findes, festivos, puentesLibres, dobletes });
const g = (residenteId, fecha, codigo = "G", extra = {}) => ({ residenteId, fecha, codigo, ...extra });

const A = R("r3a", "2024-05-27", "2028-05-26"); // cierre R3 el 2027-05-26
const B = R("r3b", "2024-05-27", "2028-05-26");
const R2A = R("r2a", "2025-05-26", "2029-05-25"); // cierre R2 el 2027-05-25
const R2B = R("r2b", "2025-05-26", "2029-05-25");
const only3 = (v) => v.filter((x) => x.invariante === "INV-3" && x.severidad === "error");

test("INV-3: mes intermedio desigual no viola (no es mes de cierre)", () => {
  const v = validateResidencyYearClose({
    mes: 10, anio: 2026, residentes: [A, B],
    acumulados: { r3a: acc(18), r3b: acc(18) },
    asignaciones: ["2026-10-02", "2026-10-06", "2026-10-10", "2026-10-15", "2026-10-20", "2026-10-24"].map((f) => g("r3a", f))
      .concat(["2026-10-04", "2026-10-08", "2026-10-17", "2026-10-28"].map((f) => g("r3b", f))),
  });
  assert.equal(only3(v).length, 0);
});

test("INV-3: al cierre, diferencia 2 en totales es violación", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(54), r3b: acc(54) },
    asignaciones: ["2027-05-04", "2027-05-12", "2027-05-20"].map((f) => g("r3a", f)).concat([g("r3b", "2027-05-06")]),
  });
  const e = only3(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2027-05-26");
  assert.match(e[0].detalle, /57|55|total/i);
});

test("INV-3: guardias posteriores al aniversario no cuentan", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(55), r3b: acc(55) },
    asignaciones: [g("r3a", "2027-05-05"), g("r3a", "2027-05-28"), g("r3a", "2027-05-30"), g("r3b", "2027-05-11")],
  });
  assert.equal(only3(v).length, 0); // 56 vs 56 dentro de la ventana [.., 2027-05-26]
});

test("INV-3: guardia en el día exacto de cierre sí cuenta", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(55), r3b: acc(54) },
    asignaciones: [g("r3a", "2027-05-19"), g("r3a", "2027-05-26"), g("r3b", "2027-05-24")],
  });
  assert.equal(only3(v).length, 1); // 57 vs 55
});

test("INV-3: no se compara entre años formativos distintos", () => {
  const MARTA = R("r4a", "2023-05-31", "2027-05-30"); // única R4, cierra 2027-05-30
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [MARTA, A, B],
    acumulados: { r4a: acc(48), r3a: acc(57), r3b: acc(57) },
    asignaciones: [],
  });
  assert.equal(only3(v).length, 0); // Marta sin pares; R3 empatados
});

test("INV-3: totales iguales pero fines de semana con diferencia 2", () => {
  // r2a suma findes en mayo (sáb 08, dom 16); r2b no
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(51, 12, 4, 3, 2), r2b: acc(51, 12, 4, 3, 2) },
    asignaciones: [g("r2a", "2027-05-03"), g("r2a", "2027-05-08"), g("r2a", "2027-05-16"),
      g("r2b", "2027-05-04"), g("r2b", "2027-05-13"), g("r2b", "2027-05-17")],
  });
  const e = only3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /semana|finde/i);
});

test("INV-3: doblete real vs falso doblete de semanas distintas", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(52, 12, 4, 0, 3), r2b: acc(52, 12, 4, 0, 2) },
    asignaciones: [g("r2a", "2027-05-07"), g("r2a", "2027-05-09"), // vie+dom mismo finde → doblete
      g("r2b", "2027-05-14"), g("r2b", "2027-05-23")],             // vie+dom semanas distintas → no
  });
  const e = only3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /doblete/i);
});

test("INV-4: 3P no infla el cómputo (queda enmascarado un desequilibrio real)", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(50), r2b: acc(53) },
    asignaciones: [g("r2a", "2027-05-05"), g("r2a", "2027-05-12"), g("r2a", "2027-05-06", "3P"), g("r2a", "2027-05-13", "3P"),
      g("r2b", "2027-05-07")],
  });
  const e = only3(v); // r2a 52 (los 2 3P no cuentan), r2b 54 → diff 2
  assert.equal(e.length, 1);
});

test("INV-4: guardias compradas no cuentan para quien las realiza", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54), r2b: acc(53) },
    asignaciones: [g("r2b", "2027-05-08"), g("r2b", "2027-05-06", "G", { origen: "COMPRADA", cedentePrevio: "r2a" })],
  });
  assert.equal(only3(v).length, 0); // r2a 54, r2b 54 (la comprada no suma) → diff 0
});

test("INV-3: tres residentes, max−min > 1 aunque los pares adyacentes cumplan", () => {
  const C = R("r1c", "2026-06-01", "2030-05-31");
  const E = R("r1a", "2026-06-01", "2030-05-31");
  const F = R("r1b", "2026-06-01", "2030-05-31");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [E, F, C],
    acumulados: { r1a: acc(49), r1b: acc(48), r1c: acc(47) },
    asignaciones: [],
  });
  const e = only3(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2027-05-31");
});

test("INV-3: frontera exacta diff 1 en todas las dimensiones no viola", () => {
  const E = R("r1a", "2026-06-01", "2030-05-31");
  const F = R("r1b", "2026-06-01", "2030-05-31");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [E, F],
    acumulados: { r1a: acc(48, 11, 4, 2, 2), r1b: acc(47, 10, 3, 1, 1) },
    asignaciones: [],
  });
  assert.equal(only3(v).length, 0);
});

test("INV-3: aniversario en junio → mayo no es cierre", () => {
  const A2 = R("r3a", "2024-06-10", "2028-06-09");
  const B2 = R("r3b", "2024-06-10", "2028-06-09");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A2, B2],
    acumulados: { r3a: acc(54), r3b: acc(52) },
    asignaciones: [],
  });
  assert.equal(only3(v).length, 0);
});

test("INV-3: puentes libres con diferencia 2 es violación", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54, 12, 4, 4, 2), r2b: acc(55, 12, 5, 2, 2) },
    asignaciones: [],
  });
  const e = only3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /puente/i);
});

test("INV-3: baja médica se descuenta proporcionalmente (nota [a])", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54, 12, 4, 3, 2), r2b: acc(50, 12, 4, 3, 2) },
    asignaciones: [],
    bloqueos: [{ residenteId: "r2b", desde: "2027-02-01", hasta: "2027-02-28", motivo: "BAJA" }],
  });
  // ventana 2026-05-26..2027-05-25 (365 d); baja 28 d → f≈0.923; 50/0.923≈54.2 vs 54 → diff <1
  assert.equal(only3(v).length, 0);
});

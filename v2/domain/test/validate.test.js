// Tests de v2/domain/validate.js — validateMonth (spec.md §5).
// Invariantes por mes: INV-1, INV-2, INV-5, INV-6, INV-7, INV-9, INV-10, INV-11.
// Derivados de ~78 casos adversariales. Reconciliación (decisión V-1): un día con dos
// Pequeños AMBOS R2 lo gobierna INV-9; cualquier otro día defectuoso, INV-1. El
// comportamiento (aceptar/rechazar) es idéntico a la normativa; solo se unifica la etiqueta.
import test from "node:test";
import assert from "node:assert/strict";
import { validateMonth } from "../validate.js";

// ── helpers de construcción ──
const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const asg = (residenteId, fecha, codigo, extra = {}) => ({ residenteId, fecha, codigo, ...extra });
const blk = (residenteId, desde, hasta, motivo, extra = {}) => ({ residenteId, desde, hasta, motivo, ...extra });

// Base de residentes reutilizable (cohortes por año de inicio).
const ANA = R("ANA", "2023-05-22", "2027-05-21");   // R4 en 2026-27
const BEA = R("BEA", "2023-05-29", "2027-05-28");   // R4
const CARLOS = R("CARLOS", "2024-05-27", "2028-05-26"); // R3 en 2026-27
const DIANA = R("DIANA", "2024-05-27", "2028-05-26");   // R3
const ELENA = R("ELENA", "2025-05-26", "2029-05-25");   // R2
const FRAN = R("FRAN", "2025-05-26", "2029-05-25");      // R2
const HUGO = R("HUGO", "2025-05-26", "2029-05-25");      // R2
const IVAN = R("IVAN", "2026-05-25", "2030-05-24");      // R1 en 2026-27

const only = (viols, inv) => viols.filter((v) => v.invariante === inv);

// ── cobertura mínima para no disparar INV-1 en días no relevantes ──
// Genera un mes entero cubierto con ANA(R4)+ELENA(R2) salvo los días que se sobrescriban.
function coverMonth(mes, anio, dias, overrides = []) {
  const pad = (n) => String(n).padStart(2, "0");
  const a = [];
  const overriddenDays = new Set(overrides.map((o) => o.fecha));
  for (let d = 1; d <= dias; d++) {
    const fecha = `${anio}-${pad(mes)}-${pad(d)}`;
    if (overriddenDays.has(fecha)) continue;
    a.push(asg("ANA", fecha, "G"), asg("ELENA", fecha, "G"));
  }
  return a.concat(overrides);
}

// ─────────────── INV-1 ───────────────
test("INV-1: festivo cubierto con GF no rompe la paridad", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("ANA", "2026-12-25", "GF"), asg("ELENA", "2026-12-25", "GF")]);
  const v = validateMonth({ mes: 12, anio: 2026, residentes: [ANA, ELENA], asignaciones: asgs });
  assert.equal(only(v, "INV-1").length, 0);
});

test("INV-1: 3P no cuenta como puesto (Mayor+Pequeño+3P es válido)", () => {
  const asgs = coverMonth(10, 2026, 31, [
    asg("ANA", "2026-10-17", "G"), asg("HUGO", "2026-10-17", "G"), asg("ELENA", "2026-10-17", "3P"),
  ]);
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [ANA, ELENA, HUGO], asignaciones: asgs });
  assert.equal(only(v, "INV-1").length, 0);
});

test("INV-1: día con solo Mayor → falta el Pequeño", () => {
  // julio: día 31 solo ANA
  const asgs = coverMonth(7, 2026, 31, [asg("ANA", "2026-07-31", "G")]); // ELENA no asignada ese día
  const v = validateMonth({ mes: 7, anio: 2026, residentes: [ANA, ELENA], asignaciones: asgs });
  const i1 = only(v, "INV-1");
  assert.equal(i1.length, 1);
  assert.equal(i1[0].fecha, "2026-07-31");
  assert.match(i1[0].detalle, /peque/i);
});

test("INV-1: febrero de 28 días no inventa violaciones en días fantasma", () => {
  const asgs = coverMonth(2, 2027, 28);
  const v = validateMonth({ mes: 2, anio: 2027, residentes: [ANA, ELENA], asignaciones: asgs });
  assert.equal(only(v, "INV-1").length, 0);
  assert.ok(!v.some((x) => x.fecha && x.fecha > "2027-02-28"));
});

test("INV-1: nivel día a día — promoción a mitad de mes crea 2 mayores el día 15", () => {
  const FATIMA = R("FATIMA", "2024-12-10", "2028-12-09"); // R2 hasta 2026-12-09, R3 desde 2026-12-10
  const asgs = coverMonth(12, 2026, 31, [
    asg("ANA", "2026-12-05", "G"), asg("FATIMA", "2026-12-05", "G"), // ANA R4 + FATIMA R2 → ok
    asg("ANA", "2026-12-15", "G"), asg("FATIMA", "2026-12-15", "G"), // ANA R4 + FATIMA R3 → 2 mayores
  ]);
  const v = validateMonth({ mes: 12, anio: 2026, residentes: [ANA, FATIMA, ELENA], asignaciones: asgs });
  const i1 = only(v, "INV-1");
  assert.equal(i1.length, 1);
  assert.equal(i1[0].fecha, "2026-12-15");
  assert.match(i1[0].detalle, /mayor/i);
});

test("INV-1: dos Pequeños con un R1 (no ambos R2) es violación de INV-1", () => {
  // enero: IVAN(R1) + ELENA(R2), con excepción 2xR2 activa → sigue siendo INV-1
  const asgs = coverMonth(1, 2027, 31, [asg("IVAN", "2027-01-23", "G"), asg("ELENA", "2027-01-23", "G")]);
  const v = validateMonth({
    mes: 1, anio: 2027, residentes: [ANA, ELENA, IVAN],
    asignaciones: asgs,
    excepciones: [{ tipo: "2xR2", desde: "2027-01-01", hasta: "2027-01-31", justificacion: "mayores en rotación" }],
  });
  const i1 = only(v, "INV-1");
  assert.equal(i1.length, 1);
  assert.equal(i1[0].fecha, "2027-01-23");
});

// ─────────────── INV-9 (2xR2) ───────────────
test("INV-9: 2xR2 en noviembre (antes de diciembre) es violación aunque esté justificado", () => {
  const asgs = coverMonth(11, 2026, 30, [asg("ELENA", "2026-11-20", "G"), asg("FRAN", "2026-11-20", "G")]);
  const v = validateMonth({
    mes: 11, anio: 2026, residentes: [ANA, ELENA, FRAN],
    asignaciones: asgs,
    excepciones: [{ tipo: "2xR2", desde: "2026-11-01", hasta: "2026-11-30", justificacion: "mayores en rotación" }],
  });
  assert.equal(only(v, "INV-9").length, 1);
  assert.equal(only(v, "INV-9")[0].fecha, "2026-11-20");
  assert.equal(only(v, "INV-1").length, 0); // no se duplica como INV-1
});

test("INV-9: 2xR2 en diciembre con justificación es válido", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("ELENA", "2026-12-18", "G"), asg("FRAN", "2026-12-18", "G")]);
  const v = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, ELENA, FRAN],
    asignaciones: asgs,
    excepciones: [{ tipo: "2xR2", desde: "2026-12-01", hasta: "2026-12-31", justificacion: "mayores en rotación" }],
  });
  assert.equal(only(v, "INV-9").length, 0);
  assert.equal(only(v, "INV-1").length, 0);
});

test("INV-9: 2xR2 en enero (mismo año académico, tras cambio de año natural) válido", () => {
  const asgs = coverMonth(1, 2027, 31, [asg("ELENA", "2027-01-22", "G"), asg("FRAN", "2027-01-22", "G")]);
  const v = validateMonth({
    mes: 1, anio: 2027, residentes: [ANA, ELENA, FRAN],
    asignaciones: asgs,
    excepciones: [{ tipo: "2xR2", desde: "2027-01-04", hasta: "2027-01-31", justificacion: "mayores" }],
  });
  assert.equal(only(v, "INV-9").length, 0);
});

test("INV-9: 2xR2 en diciembre SIN justificación es violación", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("ELENA", "2026-12-19", "G"), asg("FRAN", "2026-12-19", "G")]);
  const v = validateMonth({ mes: 12, anio: 2026, residentes: [ANA, ELENA, FRAN], asignaciones: asgs });
  assert.equal(only(v, "INV-9").length, 1);
  assert.equal(only(v, "INV-9")[0].fecha, "2026-12-19");
});

test("INV-9: frontera 30-nov (violación) vs 1-dic (válido) con misma justificación", () => {
  const exc = [{ tipo: "2xR2", desde: "2026-11-15", hasta: "2026-12-15", justificacion: "mayores" }];
  const nov = validateMonth({
    mes: 11, anio: 2026, residentes: [ANA, ELENA, FRAN],
    asignaciones: coverMonth(11, 2026, 30, [asg("ELENA", "2026-11-30", "G"), asg("FRAN", "2026-11-30", "G")]),
    excepciones: exc,
  });
  const dic = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, ELENA, FRAN],
    asignaciones: coverMonth(12, 2026, 31, [asg("ELENA", "2026-12-01", "G"), asg("FRAN", "2026-12-01", "G")]),
    excepciones: exc,
  });
  assert.equal(only(nov, "INV-9").length, 1);
  assert.equal(only(dic, "INV-9").length, 0);
});

test("INV-9: reset de ventana en nuevo año académico (junio 2027 con 2xR2 justificado es violación)", () => {
  const J1 = R("J1", "2026-05-25", "2030-05-24"); // R1 en 2026-27, R2 desde 2027-05-25
  const J2 = R("J2", "2026-05-25", "2030-05-24");
  const asgs = coverMonth(6, 2027, 30, [asg("J1", "2027-06-04", "G"), asg("J2", "2027-06-04", "G")]);
  const v = validateMonth({
    mes: 6, anio: 2027, residentes: [ANA, J1, J2], asignaciones: asgs,
    excepciones: [{ tipo: "2xR2", desde: "2027-06-01", hasta: "2027-06-30", justificacion: "mayores" }],
  });
  // en jun 2027 J1/J2 son R2 (subieron 2027-05-25); es antes de diciembre del año académico 2027-28
  assert.equal(only(v, "INV-9").length, 1);
  assert.equal(only(v, "INV-9")[0].fecha, "2027-06-04");
});

// ─────────────── INV-2 (4..6 mensual) ───────────────
test("INV-2: R1 con 0 guardias en julio es válido (verano sin R1)", () => {
  const asgs = coverMonth(7, 2026, 31); // ELENA(R2) cubre; IVAN(R1) 0 guardias
  const v = validateMonth({ mes: 7, anio: 2026, residentes: [ANA, ELENA, IVAN], asignaciones: asgs });
  assert.equal(v.filter((x) => x.invariante === "INV-2" && x.residenteId === "IVAN").length, 0);
});

test("INV-2: 3P no cuenta para el mínimo (3 G + 1 3P = infra-mínimo)", () => {
  const asgs = [
    asg("DAVID", "2026-10-06", "G"), asg("DAVID", "2026-10-14", "G"), asg("DAVID", "2026-10-22", "G"),
    asg("DAVID", "2026-10-25", "3P"),
  ];
  const DAVID = R("DAVID", "2025-05-26", "2029-05-25");
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [DAVID], asignaciones: asgs });
  const i2 = v.filter((x) => x.invariante === "INV-2" && x.residenteId === "DAVID");
  assert.equal(i2.length, 1);
  assert.match(i2[0].detalle, /4|mínimo|minimo/i);
});

test("INV-2: 3P no cuenta para el máximo (6 G + 1 3P = ok)", () => {
  const BRUNO = R("BRUNO", "2024-05-27", "2028-05-26");
  const asgs = ["2026-10-03", "2026-10-07", "2026-10-10", "2026-10-15", "2026-10-21", "2026-10-28"]
    .map((f) => asg("BRUNO", f, "G")).concat([asg("BRUNO", "2026-10-17", "3P")]);
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [BRUNO], asignaciones: asgs });
  assert.equal(v.filter((x) => x.invariante === "INV-2").length, 0);
});

test("INV-2: febrero exime del mínimo", () => {
  const CARLA = R("CARLA", "2025-05-26", "2029-05-25");
  const asgs = ["2027-02-05", "2027-02-13", "2027-02-24"].map((f) => asg("CARLA", f, "G"));
  const v = validateMonth({ mes: 2, anio: 2027, residentes: [CARLA], asignaciones: asgs });
  assert.equal(v.filter((x) => x.invariante === "INV-2").length, 0);
});

test("INV-2: vacaciones documentadas eximen del mínimo", () => {
  const BRUNO = R("BRUNO", "2024-05-27", "2028-05-26");
  const asgs = [asg("BRUNO", "2026-09-19", "G"), asg("BRUNO", "2026-09-26", "G")];
  const v = validateMonth({
    mes: 9, anio: 2026, residentes: [BRUNO], asignaciones: asgs,
    bloqueos: [blk("BRUNO", "2026-09-01", "2026-09-15", "VACACIONES")],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-2").length, 0);
});

test("INV-2: baja documentada también exime del mínimo (misma rama que vacaciones)", () => {
  const BRUNO = R("BRUNO", "2024-05-27", "2028-05-26");
  const asgs = [asg("BRUNO", "2026-09-19", "G"), asg("BRUNO", "2026-09-26", "G")];
  const v = validateMonth({
    mes: 9, anio: 2026, residentes: [BRUNO], asignaciones: asgs,
    bloqueos: [blk("BRUNO", "2026-09-01", "2026-09-15", "BAJA")],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-2").length, 0);
});

test("INV-2: 7 guardias reales superan el máximo (31 días no amplía el tope)", () => {
  const asgs = ["2026-10-01", "2026-10-05", "2026-10-09", "2026-10-13", "2026-10-17", "2026-10-21", "2026-10-29"]
    .map((f) => asg("ANA", f, "G"));
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [ANA], asignaciones: asgs });
  const i2 = v.filter((x) => x.invariante === "INV-2" && x.residenteId === "ANA");
  assert.equal(i2.length, 1);
  assert.match(i2[0].detalle, /6|máximo|maximo/i);
});

// ─────────────── INV-5 (bloqueo motivo BAJA — decisión V-8) ───────────────
// Fase 5.x / decisión V-8: solo BAJA sigue bloqueando la asignación (no se puede exigir una
// guardia a alguien de baja médica/embarazo). VACACIONES y ROTACION dejaron de bloquear: son
// informativas para el generador, pero sus fechas siguen alimentando INV-2/6/7 y la equidad.
test("INV-5: guardia y 3P sobre bloqueo BAJA violan; el mismo patrón sobre VACACIONES no", () => {
  const BRUNO = R("BRUNO", "2024-05-27", "2028-05-26");
  const CARLA = R("CARLA", "2025-05-26", "2029-05-25");
  const asgs = [asg("BRUNO", "2026-10-07", "G"), asg("CARLA", "2026-10-21", "3P")];
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [BRUNO, CARLA], asignaciones: asgs,
    bloqueos: [blk("BRUNO", "2026-10-05", "2026-10-11", "VACACIONES"), blk("CARLA", "2026-10-19", "2026-10-23", "BAJA")],
  });
  const i5 = v.filter((x) => x.invariante === "INV-5");
  assert.equal(i5.length, 1);
  assert.ok(i5.some((x) => x.fecha === "2026-10-21" && x.residenteId === "CARLA"));
  assert.ok(!i5.some((x) => x.residenteId === "BRUNO")); // VACACIONES ya no bloquea (V-8)
});

test("INV-5: VACACIONES y ROTACION ya no bloquean asignación (decisión V-8)", () => {
  const asgs = [asg("ANA", "2026-10-07", "G")];
  const DAVID = R("DAVID", "2025-05-26", "2029-05-25");
  const asgsRot = [asg("DAVID", "2026-10-15", "G")];
  const vVac = validateMonth({
    mes: 10, anio: 2026, residentes: [ANA], asignaciones: asgs,
    bloqueos: [blk("ANA", "2026-10-05", "2026-10-11", "VACACIONES")],
  });
  const vRot = validateMonth({
    mes: 10, anio: 2026, residentes: [DAVID], asignaciones: asgsRot,
    bloqueos: [blk("DAVID", "2026-10-01", "2026-10-15", "ROTACION", { provincia: "Madrid" })],
  });
  assert.equal(vVac.filter((x) => x.invariante === "INV-5").length, 0);
  assert.equal(vRot.filter((x) => x.invariante === "INV-5").length, 0);
});

test("INV-5: bloqueo BAJA que cruza de diciembre a enero (extremos inclusivos)", () => {
  const asgs = [asg("ANA", "2027-01-02", "G"), asg("ANA", "2027-01-04", "G")];
  const v = validateMonth({
    mes: 1, anio: 2027, residentes: [ANA], asignaciones: asgs,
    bloqueos: [blk("ANA", "2026-12-28", "2027-01-03", "BAJA")],
  });
  const i5 = v.filter((x) => x.invariante === "INV-5");
  assert.equal(i5.length, 1);
  assert.equal(i5[0].fecha, "2027-01-02");
});

test("INV-5: fin de bloqueo BAJA inclusivo (día 15 viola, día 16 no)", () => {
  const DAVID = R("DAVID", "2025-05-26", "2029-05-25");
  const asgs = [asg("DAVID", "2026-10-15", "G"), asg("DAVID", "2026-10-16", "G")];
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [DAVID], asignaciones: asgs,
    bloqueos: [blk("DAVID", "2026-10-01", "2026-10-15", "BAJA")],
  });
  const i5 = v.filter((x) => x.invariante === "INV-5");
  assert.equal(i5.length, 1);
  assert.equal(i5[0].fecha, "2026-10-15");
});

test("INV-5: inicio de bloqueo BAJA inclusivo (día 9 no viola, día 10 sí — simétrico al fin)", () => {
  const DAVID = R("DAVID", "2025-05-26", "2029-05-25");
  const asgs = [asg("DAVID", "2026-10-09", "G"), asg("DAVID", "2026-10-10", "G")];
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [DAVID], asignaciones: asgs,
    bloqueos: [blk("DAVID", "2026-10-10", "2026-10-20", "BAJA")],
  });
  const i5 = v.filter((x) => x.invariante === "INV-5");
  assert.equal(i5.length, 1);
  assert.equal(i5[0].fecha, "2026-10-10");
});

test("INV-5/INV-7 ya no se contradicen: cubrir viernes+sábado en rotación cercana satisface INV-7 sin disparar INV-5", () => {
  // Antes de la decisión V-8, este mismo escenario (ya probado en el bloque INV-7 de más
  // abajo) violaba INV-5 en las 3 asignaciones mientras satisfacía INV-7 — una contradicción
  // real nunca detectada porque los tests de INV-7 no comprobaban INV-5 en el mismo caso.
  const M1 = R("M1", "2024-05-27", "2028-05-26");
  const asgs = [asg("M1", "2026-10-16", "G"), asg("M1", "2026-10-24", "G"), asg("M1", "2026-10-20", "G")];
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [M1], asignaciones: asgs,
    bloqueos: [blk("M1", "2026-10-05", "2026-10-31", "ROTACION", { provincia: "Alicante" })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 0);
  assert.equal(v.filter((x) => x.invariante === "INV-5").length, 0);
});

// ─────────────── INV-6 (rotaciones simultáneas) ───────────────
const cohort = (id, y) => R(id, `${y}-05-25`, `${y + 4}-05-24`);

test("INV-6: 2 simultáneos del mismo año es el límite exacto (válido)", () => {
  const M1 = cohort("M1", 2024), M2 = cohort("M2", 2024);
  const v = validateMonth({
    mes: 9, anio: 2026, residentes: [M1, M2], asignaciones: [],
    bloqueos: [blk("M1", "2026-09-01", "2026-09-30", "ROTACION"), blk("M2", "2026-09-15", "2026-10-14", "ROTACION")],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-6").length, 0);
});

test("INV-6: triple solape de un solo día → violación al que se incorpora último", () => {
  const M1 = cohort("M1", 2024), M2 = cohort("M2", 2024), M3 = cohort("M3", 2024);
  const v = validateMonth({
    mes: 7, anio: 2026, residentes: [M1, M2, M3], asignaciones: [],
    bloqueos: [
      blk("M1", "2026-07-01", "2026-07-20", "ROTACION"),
      blk("M2", "2026-07-10", "2026-07-31", "ROTACION"),
      blk("M3", "2026-07-20", "2026-08-16", "ROTACION"),
    ],
  });
  const i6 = v.filter((x) => x.invariante === "INV-6");
  assert.equal(i6.length, 1);
  assert.equal(i6[0].fecha, "2026-07-20");
  assert.equal(i6[0].residenteId, "M3");
});

test("INV-6: el límite es por año formativo (2 R3 + 2 R4 simultáneos es válido)", () => {
  const M1 = cohort("M1", 2024), M2 = cohort("M2", 2024), S1 = cohort("S1", 2023), S2 = cohort("S2", 2023);
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [M1, M2, S1, S2], asignaciones: [],
    bloqueos: [M1, M2, S1, S2].map((r) => blk(r.id, "2026-10-01", "2026-10-31", "ROTACION")),
  });
  assert.equal(v.filter((x) => x.invariante === "INV-6").length, 0);
});

test("INV-6: 2 R + 1 V simultáneos → viola el de vacaciones (rotación prioritaria)", () => {
  const P1 = cohort("P1", 2025), P2 = cohort("P2", 2025), P3 = cohort("P3", 2025);
  const v = validateMonth({
    mes: 11, anio: 2026, residentes: [P1, P2, P3], asignaciones: [],
    bloqueos: [
      blk("P1", "2026-11-02", "2026-11-29", "ROTACION"),
      blk("P2", "2026-11-09", "2026-12-06", "ROTACION"),
      blk("P3", "2026-11-16", "2026-11-22", "VACACIONES"),
    ],
  });
  const i6 = v.filter((x) => x.invariante === "INV-6");
  assert.equal(i6.length, 1);
  assert.equal(i6[0].residenteId, "P3");
  assert.equal(i6[0].fecha, "2026-11-16");
});

test("INV-6: la baja no computa como ausencia planificable", () => {
  const P1 = cohort("P1", 2025), P2 = cohort("P2", 2025), P3 = cohort("P3", 2025);
  const v = validateMonth({
    mes: 8, anio: 2026, residentes: [P1, P2, P3], asignaciones: [],
    bloqueos: [
      blk("P1", "2026-08-03", "2026-08-30", "ROTACION"),
      blk("P2", "2026-08-03", "2026-08-30", "ROTACION"),
      blk("P3", "2026-08-10", "2026-08-23", "BAJA"),
    ],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-6").length, 0);
});

test("INV-6: cohorte por año de inicio, no por nivel computado (solape en aniversario)", () => {
  const A = R("A", "2024-05-24", "2028-05-23"), B = R("B", "2024-05-24", "2028-05-23"), C = R("C", "2024-06-02", "2028-06-01");
  const v = validateMonth({
    mes: 5, anio: 2027, residentes: [A, B, C], asignaciones: [],
    bloqueos: [
      blk("A", "2027-05-03", "2027-05-31", "ROTACION"),
      blk("B", "2027-05-10", "2027-05-31", "ROTACION"),
      blk("C", "2027-05-25", "2027-05-31", "ROTACION"),
    ],
  });
  const i6 = v.filter((x) => x.invariante === "INV-6");
  assert.equal(i6.length, 1);
  assert.equal(i6[0].fecha, "2027-05-25");
  assert.equal(i6[0].residenteId, "C");
});

// ─────────────── INV-7 (presencia mínima en rotación cercana) ───────────────
test("INV-7: rotación en Alicante con 1 viernes + 1 sábado en el periodo es válida", () => {
  const M1 = R("M1", "2024-05-27", "2028-05-26");
  const asgs = [asg("M1", "2026-10-16", "G"), asg("M1", "2026-10-24", "G"), asg("M1", "2026-10-20", "G")];
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [M1], asignaciones: asgs,
    bloqueos: [blk("M1", "2026-10-05", "2026-10-31", "ROTACION", { provincia: "Alicante" })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 0);
});

test("INV-7: dos viernes sin sábado → falta el sábado", () => {
  const M2 = R("M2", "2024-05-27", "2028-05-26");
  const asgs = [asg("M2", "2026-11-06", "G"), asg("M2", "2026-11-20", "G")];
  const v = validateMonth({
    mes: 11, anio: 2026, residentes: [M2], asignaciones: asgs,
    bloqueos: [blk("M2", "2026-11-02", "2026-11-29", "ROTACION", { provincia: "Murcia" })],
  });
  const i7 = v.filter((x) => x.invariante === "INV-7");
  assert.equal(i7.length, 1);
  assert.match(i7[0].detalle, /s[áa]bado/i);
  assert.doesNotMatch(i7[0].detalle, /falta.*viernes/i);
});

test("INV-7: guardias en el mes pero fuera del periodo → faltan viernes y sábado", () => {
  const M3 = R("M3", "2024-05-27", "2028-05-26");
  const asgs = [asg("M3", "2026-09-04", "G"), asg("M3", "2026-09-26", "G")]; // fuera de 07-20
  const v = validateMonth({
    mes: 9, anio: 2026, residentes: [M3], asignaciones: asgs,
    bloqueos: [blk("M3", "2026-09-07", "2026-09-20", "ROTACION", { provincia: "Valencia" })],
  });
  const i7 = v.filter((x) => x.invariante === "INV-7");
  assert.equal(i7.length, 1);
  assert.match(i7[0].detalle, /viernes/i);
  assert.match(i7[0].detalle, /s[áa]bado/i);
});

test("INV-7: Madrid (no colindante) está exenta", () => {
  const S1 = R("S1", "2023-05-27", "2027-05-26");
  const v = validateMonth({
    mes: 10, anio: 2026, residentes: [S1], asignaciones: [],
    bloqueos: [blk("S1", "2026-10-01", "2026-10-31", "ROTACION", { provincia: "Madrid" })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 0);
});

test("INV-7: periodo sin viernes ni sábado → requisitos vacuos", () => {
  const P1 = R("P1", "2025-05-26", "2029-05-25");
  const v = validateMonth({
    mes: 6, anio: 2026, residentes: [P1], asignaciones: [],
    bloqueos: [blk("P1", "2026-06-01", "2026-06-04", "ROTACION", { provincia: "Valencia" })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 0);
});

test("INV-7: periodo con viernes cubierto y sin sábado → válido (requisito sábado vacuo)", () => {
  const P2 = R("P2", "2025-05-26", "2029-05-25");
  const v = validateMonth({
    mes: 6, anio: 2026, residentes: [P2], asignaciones: [asg("P2", "2026-06-12", "G")],
    bloqueos: [blk("P2", "2026-06-08", "2026-06-12", "ROTACION", { provincia: "Albacete" })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 0);
});

test("INV-7: se evalúa solo en el mes de fin (dic sin violación, ene con GF viernes + G sábado válido)", () => {
  const S2 = R("S2", "2023-05-27", "2027-05-26");
  const asgs = [asg("S2", "2026-12-25", "GF"), asg("S2", "2027-01-02", "G")];
  const blo = [blk("S2", "2026-12-14", "2027-01-10", "ROTACION", { provincia: "Valencia" })];
  const dic = validateMonth({ mes: 12, anio: 2026, residentes: [S2], asignaciones: asgs, bloqueos: blo });
  const ene = validateMonth({ mes: 1, anio: 2027, residentes: [S2], asignaciones: asgs, bloqueos: blo });
  assert.equal(dic.filter((x) => x.invariante === "INV-7").length, 0);
  assert.equal(ene.filter((x) => x.invariante === "INV-7").length, 0);
});

test("INV-7: guardias en el centro externo no eximen", () => {
  const S3 = R("S3", "2023-05-27", "2027-05-26");
  const v = validateMonth({
    mes: 3, anio: 2027, residentes: [S3], asignaciones: [],
    bloqueos: [blk("S3", "2027-03-01", "2027-03-28", "ROTACION", { provincia: "Valencia", guardiasEnCentroExterno: true })],
  });
  assert.equal(v.filter((x) => x.invariante === "INV-7").length, 1);
});

// ─────────────── INV-10 (eventos del servicio) ───────────────
test("INV-10: Navidad con 2 R2 y sorteo documentado no dispara falso INV-9", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("ELENA", "2026-12-18", "G"), asg("FRAN", "2026-12-18", "G")]);
  const v = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, ELENA, FRAN], asignaciones: asgs,
    eventos: { navidad: { fecha: "2026-12-18", voluntarios: [], sorteoDocumentado: true, designados: ["ELENA", "FRAN"] } },
  });
  assert.equal(only(v, "INV-10").length, 0);
  assert.equal(only(v, "INV-9").length, 0);
});

test("INV-10: Navidad cubierta por un R3 es violación (severidad AVISO)", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("CARLOS", "2026-12-18", "G"), asg("ELENA", "2026-12-18", "G")]);
  const v = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, CARLOS, ELENA], asignaciones: asgs,
    eventos: { navidad: { fecha: "2026-12-18", voluntarios: [], sorteoDocumentado: true, designados: ["ELENA"] } },
  });
  assert.equal(only(v, "INV-10").length, 1);
  assert.equal(only(v, "INV-10")[0].fecha, "2026-12-18");
  assert.equal(only(v, "INV-10")[0].severidad, "aviso"); // los eventos son avisos, no bloquean
});

test("INV-9: un día de evento exime el 2×R2 aunque caiga antes de diciembre (fix P0-3)", () => {
  // Evento ficticio en noviembre cubierto por 2×R2: el evento exime con independencia de la ventana de diciembre.
  const asgs = coverMonth(11, 2026, 30, [asg("ELENA", "2026-11-20", "G"), asg("FRAN", "2026-11-20", "G")]);
  const v = validateMonth({
    mes: 11, anio: 2026, residentes: [ANA, ELENA, FRAN], asignaciones: asgs,
    eventos: { navidad: { fecha: "2026-11-20", voluntarios: [], sorteoDocumentado: true, designados: ["ELENA", "FRAN"] } },
  });
  assert.equal(only(v, "INV-9").length, 0);
});

test("INV-10: Navidad sin sorteo documentado (y sin voluntario único) es violación", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("ELENA", "2026-12-18", "G"), asg("FRAN", "2026-12-18", "G")]);
  const v = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, ELENA, FRAN], asignaciones: asgs,
    eventos: { navidad: { fecha: "2026-12-18", voluntarios: [], sorteoDocumentado: false, designados: ["ELENA", "FRAN"] } },
  });
  assert.equal(only(v, "INV-10").length, 1);
});

test("INV-10: voluntario único cubre sin sorteo (segundo puesto por sorteo) es válido", () => {
  const asgs = coverMonth(12, 2026, 31, [asg("HUGO", "2026-12-18", "G"), asg("ELENA", "2026-12-18", "G")]);
  const v = validateMonth({
    mes: 12, anio: 2026, residentes: [ANA, HUGO, ELENA], asignaciones: asgs,
    eventos: { navidad: { fecha: "2026-12-18", voluntarios: ["HUGO"], sorteoDocumentado: true, designados: ["HUGO", "ELENA"] } },
  });
  assert.equal(only(v, "INV-10").length, 0);
});

test("INV-10: designada de Navidad no puede repetir en la despedida", () => {
  const asgs = coverMonth(5, 2027, 31, [asg("ELENA", "2027-05-14", "G"), asg("HUGO", "2027-05-14", "G")]);
  const v = validateMonth({
    mes: 5, anio: 2027, residentes: [ANA, ELENA, HUGO], asignaciones: asgs,
    designadosNavidad: ["ELENA", "FRAN"],
    eventos: { despedida: { fecha: "2027-05-14", voluntarios: [], sorteoDocumentado: true, designados: ["ELENA", "HUGO"] } },
  });
  const i10 = only(v, "INV-10");
  assert.equal(i10.length, 1);
  assert.equal(i10[0].residenteId, "ELENA");
});

// ─────────────── INV-11 (verano sin R1 + recuento entre R2) ───────────────
test("INV-11: R1 asignado en julio es violación", () => {
  const asgs = coverMonth(7, 2026, 31, [asg("ANA", "2026-07-15", "G"), asg("IVAN", "2026-07-15", "G")]);
  const v = validateMonth({ mes: 7, anio: 2026, residentes: [ANA, ELENA, IVAN], asignaciones: asgs });
  const i11 = only(v, "INV-11");
  assert.ok(i11.some((x) => x.fecha === "2026-07-15" && x.residenteId === "IVAN"));
});

test("INV-11: fronteras 1-jun y 31-ago violan; 1-sep no", () => {
  const JULIA = R("JULIA", "2026-05-25", "2030-05-24"); // R1 en 2026-27
  const jun = validateMonth({ mes: 6, anio: 2026, residentes: [ANA, JULIA], asignaciones: coverMonth(6, 2026, 30, [asg("ANA", "2026-06-01", "G"), asg("JULIA", "2026-06-01", "G")]) });
  const ago = validateMonth({ mes: 8, anio: 2026, residentes: [ANA, JULIA], asignaciones: coverMonth(8, 2026, 31, [asg("ANA", "2026-08-31", "G"), asg("JULIA", "2026-08-31", "G")]) });
  const sep = validateMonth({ mes: 9, anio: 2026, residentes: [CARLOS, JULIA], asignaciones: coverMonth(9, 2026, 30, [asg("CARLOS", "2026-09-01", "G"), asg("JULIA", "2026-09-01", "G")]) });
  assert.ok(only(jun, "INV-11").some((x) => x.fecha === "2026-06-01" && x.residenteId === "JULIA"));
  assert.ok(only(ago, "INV-11").some((x) => x.fecha === "2026-08-31" && x.residenteId === "JULIA"));
  assert.equal(only(sep, "INV-11").length, 0);
});

test("INV-11: aniversario personal a mitad de junio (R1 el día 5 viola, R2 el día 19 no)", () => {
  const KAREN = R("KAREN", "2025-06-10", "2029-06-09"); // R1 hasta 2026-06-09, R2 desde 2026-06-10
  const asgs = coverMonth(6, 2026, 30, [
    asg("ANA", "2026-06-05", "G"), asg("KAREN", "2026-06-05", "G"),
    asg("ANA", "2026-06-19", "G"), asg("KAREN", "2026-06-19", "G"),
  ]);
  const v = validateMonth({ mes: 6, anio: 2026, residentes: [ANA, KAREN], asignaciones: asgs });
  const i11 = only(v, "INV-11").filter((x) => x.residenteId === "KAREN");
  assert.equal(i11.length, 1);
  assert.equal(i11[0].fecha, "2026-06-05");
});

test("INV-11: recuento agosto con diferencia 2 entre R2 del mismo año es aviso (compensable)", () => {
  // ELENA 5 (4G+1GF), FRAN 3, HUGO 4 — mismo año (cohorte 2025)
  const a = [];
  ["2026-08-03", "2026-08-06", "2026-08-11", "2026-08-18"].forEach((f) => a.push(asg("ELENA", f, "G")));
  a.push(asg("ELENA", "2026-08-22", "GF"));
  ["2026-08-04", "2026-08-12", "2026-08-19"].forEach((f) => a.push(asg("FRAN", f, "G")));
  ["2026-08-05", "2026-08-13", "2026-08-20", "2026-08-27"].forEach((f) => a.push(asg("HUGO", f, "G")));
  const v = validateMonth({ mes: 8, anio: 2026, residentes: [ANA, ELENA, FRAN, HUGO], asignaciones: a });
  const i11 = only(v, "INV-11").filter((x) => x.fecha == null);
  assert.equal(i11.length, 1);
  assert.equal(i11[0].severidad, "aviso"); // el desequilibrio de verano es compensable antes del cierre
  assert.match(i11[0].detalle, /5|3|diferencia/i);
});

test("INV-2: un Pequeño con exactamente 3 guardias es AVISO, no error (infra-oferta, normativa pág. 2)", () => {
  const DAVID = R("DAVID", "2025-05-26", "2029-05-25"); // R2 = PEQUENO
  const asgs = ["2026-10-06", "2026-10-14", "2026-10-22"].map((f) => asg("DAVID", f, "G")); // 3 guardias
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [DAVID], asignaciones: asgs });
  const i2 = v.filter((x) => x.invariante === "INV-2" && x.residenteId === "DAVID");
  assert.equal(i2.length, 1);
  assert.equal(i2[0].severidad, "aviso"); // "R pequeños... alguno podría tocar a solo 3"
});

test("INV-2: un Mayor con solo 3 guardias sí es error DURA", () => {
  const CARLOS = R("CARLOS", "2024-05-27", "2028-05-26"); // R3 = MAYOR
  const asgs = ["2026-10-06", "2026-10-14", "2026-10-22"].map((f) => asg("CARLOS", f, "G"));
  const v = validateMonth({ mes: 10, anio: 2026, residentes: [CARLOS], asignaciones: asgs });
  const i2 = v.filter((x) => x.invariante === "INV-2" && x.residenteId === "CARLOS");
  assert.equal(i2.length, 1);
  assert.equal(i2[0].severidad, "error");
});

test("INV-11: recuento excluye 3P — diferencia computable 1 es válida", () => {
  const a = [];
  ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"].forEach((f) => a.push(asg("ELENA", f, "G")));
  a.push(asg("ELENA", "2026-07-02", "3P"), asg("ELENA", "2026-07-09", "3P")); // no computan
  ["2026-07-07", "2026-07-14", "2026-07-21", "2026-07-28"].forEach((f) => a.push(asg("FRAN", f, "G")));
  a.push(asg("FRAN", "2026-07-31", "GP")); // FRAN 5 computables
  ["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"].forEach((f) => a.push(asg("HUGO", f, "G")));
  const v = validateMonth({ mes: 7, anio: 2026, residentes: [ANA, ELENA, FRAN, HUGO], asignaciones: a });
  assert.equal(only(v, "INV-11").filter((x) => x.fecha == null).length, 0);
});

// Tests de v2/domain/blockPreview.js — simulación preventiva de cobertura al registrar un
// `Bloqueo` (P-13, spec.md §8/§8.1, decisión 2026-08-07).
import test from "node:test";
import assert from "node:assert/strict";
import { previewBloqueoRisk, previewWindowEnd } from "../blockPreview.js";

// Grupo MAYOR con 4 residentes (dos R3, dos R4) — periodos ya calculados a mano, deliberadamente
// largos en el año 3 (R3) y el año 4 (R4) para que el nivel se mantenga estable en TODAS las
// fechas de 2026 que usan los tests: no depender de defaultTrainingPeriods aquí.
const R3_PERIODOS = [
  { year: 1, start: "2019-05-01", end: "2020-04-30" },
  { year: 2, start: "2020-05-01", end: "2021-04-30" },
  { year: 3, start: "2021-05-01", end: "2028-04-30" }, // largo a propósito: R3 en todo 2026
  { year: 4, start: "2028-05-01", end: "2029-04-30" },
];
const R4_PERIODOS = [
  { year: 1, start: "2018-05-01", end: "2019-04-30" },
  { year: 2, start: "2019-05-01", end: "2020-04-30" },
  { year: 3, start: "2020-05-01", end: "2021-04-30" },
  { year: 4, start: "2021-05-01", end: "2029-04-30" }, // largo a propósito: R4 en todo 2026
];
const R3A = { id: "r3a", periodos: R3_PERIODOS };
const R3B = { id: "r3b", periodos: R3_PERIODOS };
const R4A = { id: "r4a", periodos: R4_PERIODOS };
const R4B = { id: "r4b", periodos: R4_PERIODOS };
const RESIDENTES = [R3A, R3B, R4A, R4B];

const b = (residenteId, desde, hasta, motivo) => ({ residenteId, desde, hasta, motivo, activo: true });

test("sin ausencias previas, un Bloqueo normal no genera ningún riesgo", () => {
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-03-10", hasta: "2026-03-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [], today: "2026-01-01" },
  );
  assert.deepEqual(r.riesgos, []);
  assert.equal(r.bloquea, false);
});

test("imposibilidad: si ya están ausentes los otros 3 del grupo, el 4º queda bloqueado dentro de 3 meses", () => {
  const bloqueosActivos = [
    b("r3b", "2026-03-10", "2026-03-12", "VACACIONES"),
    b("r4a", "2026-03-10", "2026-03-12", "ROTACION"),
    b("r4b", "2026-03-10", "2026-03-12", "VACACIONES"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-03-10", hasta: "2026-03-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-01-01" }, // 2026-03-10 cae dentro de 3 meses desde 2026-01-01
  );
  assert.equal(r.bloquea, true);
  const imp = r.riesgos.find((x) => x.tipo === "IMPOSIBILIDAD");
  assert.ok(imp, "debe emitir IMPOSIBILIDAD");
  assert.equal(imp.severidad, "error");
  assert.equal(imp.fecha, "2026-03-10");
});

test("imposibilidad fuera de la ventana de 3 meses: avisa, no bloquea", () => {
  const bloqueosActivos = [
    b("r3b", "2026-09-10", "2026-09-12", "VACACIONES"),
    b("r4a", "2026-09-10", "2026-09-12", "ROTACION"),
    b("r4b", "2026-09-10", "2026-09-12", "VACACIONES"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-09-10", hasta: "2026-09-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-01-01" }, // muy por delante de la ventana de 3 meses
  );
  assert.equal(r.bloquea, false);
  const imp = r.riesgos.find((x) => x.tipo === "IMPOSIBILIDAD");
  assert.ok(imp);
  assert.equal(imp.severidad, "aviso");
});

test("previewWindowEnd: exactamente al filo de los 3 meses todavía bloquea (inclusive)", () => {
  const today = "2026-01-01";
  const limite = previewWindowEnd(today);
  assert.equal(limite, "2026-04-01");
  const bloqueosActivos = [
    b("r3b", limite, limite, "VACACIONES"),
    b("r4a", limite, limite, "ROTACION"),
    b("r4b", limite, limite, "VACACIONES"),
  ];
  const dentro = previewBloqueoRisk(
    { residenteId: "r3a", desde: limite, hasta: limite, motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today },
  );
  assert.equal(dentro.bloquea, true, "el propio día límite todavía bloquea");

  const unDiaDespues = "2026-04-02";
  const fuera = previewBloqueoRisk(
    { residenteId: "r3a", desde: unDiaDespues, hasta: unDiaDespues, motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [
      b("r3b", unDiaDespues, unDiaDespues, "VACACIONES"),
      b("r4a", unDiaDespues, unDiaDespues, "ROTACION"),
      b("r4b", unDiaDespues, unDiaDespues, "VACACIONES"),
    ], today },
  );
  assert.equal(fuera.bloquea, false, "un día después del límite ya no bloquea");
});

test("con 3 de 4 disponibles no hay ningún riesgo (el caso que confirmó el autor)", () => {
  // Solo r3b ausente: quedan r3a (el solicitante, simulado), r4a, r4b — 3 de 4, sin problema.
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-03-10", hasta: "2026-03-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [b("r3b", "2026-03-10", "2026-03-12", "VACACIONES")], today: "2026-01-01" },
  );
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "IMPOSIBILIDAD"), []);
});

test("concentración por nivel: más de 2 R4 ausentes a la vez avisa aunque el grupo Mayor siga cubierto", () => {
  // Grupo con 3 R4 + 2 R3 (6 en total): 3 R4 ausentes a la vez, pero los 2 R3 siguen cubriendo.
  const R4C = { id: "r4c", periodos: R4A.periodos };
  const residentes = [R3A, R3B, R4A, R4B, R4C];
  const bloqueosActivos = [
    b("r4a", "2026-03-10", "2026-03-10", "VACACIONES"),
    b("r4b", "2026-03-10", "2026-03-10", "VACACIONES"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r4c", desde: "2026-03-10", hasta: "2026-03-10", motivo: "VACACIONES" },
    { residentes, bloqueosActivos, today: "2026-01-01" },
  );
  assert.equal(r.bloquea, false, "quedan r3a/r3b: sigue siendo factible, no bloquea");
  const conc = r.riesgos.find((x) => x.tipo === "CONCENTRACION_NIVEL");
  assert.ok(conc, "debe avisar de la concentración de 3 R4");
  assert.equal(conc.severidad, "aviso");
  assert.equal(conc.nivel, "R4");
  assert.deepEqual(conc.residentes.sort(), ["r4a", "r4b", "r4c"]);
});

test("concentración por nivel NO se confunde con el grupo: 2 R3 + 2 R4 ausentes no dispara nada (ninguno supera 2 por NIVEL)", () => {
  const bloqueosActivos = [
    b("r3b", "2026-03-10", "2026-03-10", "VACACIONES"),
    b("r4a", "2026-03-10", "2026-03-10", "ROTACION"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r4b", desde: "2026-03-10", hasta: "2026-03-10", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-01-01" },
  );
  // r3a queda disponible: no hay imposibilidad. Por nivel: 1 R3 (r3b) y 2 R4 (r4a,r4b) ausentes — ninguno > 2.
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "CONCENTRACION_NIVEL"), []);
});

test("BAJA no cuenta para nada: ni resta disponibilidad ni entra en la concentración por nivel", () => {
  const bloqueosActivos = [
    b("r3b", "2026-03-10", "2026-03-12", "BAJA"),
    b("r4a", "2026-03-10", "2026-03-12", "BAJA"),
    b("r4b", "2026-03-10", "2026-03-12", "BAJA"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-03-10", hasta: "2026-03-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-01-01" },
  );
  // Sin BAJA en el cómputo, solo r3a (el solicitante) está "ausente": 3 de 4 disponibles, sin riesgo.
  assert.deepEqual(r.riesgos, []);
});

test("sobrecarga: un periodo largo con muy pocos disponibles supera el techo de 6/mes", () => {
  // 20 días del periodo repartidos entre 2 disponibles (r3a simulado + r3b) = 10/mes, > 6.
  const bloqueosActivos = [
    b("r4a", "2026-03-01", "2026-03-20", "VACACIONES"),
    b("r4b", "2026-03-01", "2026-03-20", "VACACIONES"),
  ];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-03-01", hasta: "2026-03-20", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-01-01" },
  );
  const sobre = r.riesgos.find((x) => x.tipo === "SOBRECARGA");
  assert.ok(sobre, "debe avisar de sobrecarga");
  assert.equal(sobre.severidad, "aviso");
  assert.equal(r.bloquea, false, "sobrecarga nunca bloquea");
});

// ── P-12: división Navidad/Año Nuevo (spec.md §8/§8.1, decisión 2026-08-08) ──

test("P-12: ausente en Navidad y luego pide Año Nuevo también → avisa", () => {
  const bloqueosActivos = [b("r3a", "2026-12-23", "2026-12-26", "VACACIONES")]; // ya tiene Navidad
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-12-29", hasta: "2027-01-02", motivo: "VACACIONES" }, // pide Año Nuevo
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-11-01" },
  );
  const div = r.riesgos.find((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO");
  assert.ok(div, "debe avisar: ausente en las dos ventanas");
  assert.equal(div.severidad, "aviso");
  assert.equal(div.anio, 2026);
  assert.equal(r.bloquea, false);
});

test("P-12: la ventana de Año Nuevo se estira hasta Reyes (6 de enero)", () => {
  const bloqueosActivos = [b("r3a", "2026-12-23", "2026-12-24", "VACACIONES")];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2027-01-05", hasta: "2027-01-06", motivo: "ROTACION" }, // solo toca Reyes
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-11-01" },
  );
  assert.ok(r.riesgos.some((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"), "Reyes cuenta como Año Nuevo");
});

test("P-12: un día después de Reyes ya no cuenta como Año Nuevo", () => {
  const bloqueosActivos = [b("r3a", "2026-12-23", "2026-12-24", "VACACIONES")];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2027-01-07", hasta: "2027-01-09", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-11-01" },
  );
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"), []);
});

test("P-12: solo Navidad, sin nada en Año Nuevo, no avisa", () => {
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-12-23", hasta: "2026-12-26", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [], today: "2026-11-01" },
  );
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"), []);
});

test("P-12: BAJA en la otra ventana no cuenta (es impredecible, fuera del cómputo)", () => {
  const bloqueosActivos = [b("r3a", "2026-12-23", "2026-12-26", "BAJA")];
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-12-29", hasta: "2027-01-02", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-11-01" },
  );
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"), []);
});

test("P-12: es por residente individual — la ausencia de OTRO en la otra ventana no cuenta", () => {
  const bloqueosActivos = [b("r3b", "2026-12-23", "2026-12-26", "VACACIONES")]; // otro residente, no r3a
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-12-29", hasta: "2027-01-02", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos, today: "2026-11-01" },
  );
  assert.deepEqual(r.riesgos.filter((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"), []);
});

test("P-12: un Bloqueo que ya cubre las dos ventanas de punta a punta avisa por sí solo", () => {
  const r = previewBloqueoRisk(
    { residenteId: "r3a", desde: "2026-12-20", hasta: "2027-01-10", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [], today: "2026-11-01" },
  );
  assert.ok(r.riesgos.some((x) => x.tipo === "DIVISION_NAVIDAD_ANIO_NUEVO"));
});

test("residenteId desconocido lanza, no falla en silencio", () => {
  assert.throws(() => previewBloqueoRisk(
    { residenteId: "fantasma", desde: "2026-03-10", hasta: "2026-03-12", motivo: "VACACIONES" },
    { residentes: RESIDENTES, bloqueosActivos: [], today: "2026-01-01" },
  ), /residenteId desconocido/);
});

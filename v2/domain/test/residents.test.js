// Tests de v2/domain/residents.js — periodos formativos, nivel, grupo, activo
// (spec.md §3.1–3.3, decisiones S-2 y S-3). El nivel NUNCA se almacena: se deriva.
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultTrainingPeriods, levelOn, groupOf, isActiveOn, validateTrainingPeriods, periodOn,
  periodsOfResident, groupOnDate,
} from "../residents.js";

// Residente de ejemplo del brief: inicio 2024-05-07 (los desfases respecto a junio son NORMALES).
const START = "2024-05-07";
const END = "2028-05-06";
const periods = defaultTrainingPeriods(START, END);

test("defaultTrainingPeriods genera 4 periodos por aniversario", () => {
  assert.deepEqual(periods, [
    { year: 1, start: "2024-05-07", end: "2025-05-06" },
    { year: 2, start: "2025-05-07", end: "2026-05-06" },
    { year: 3, start: "2026-05-07", end: "2027-05-06" },
    { year: 4, start: "2027-05-07", end: "2028-05-06" },
  ]);
});

test("defaultTrainingPeriods: R4 termina en fechaFin aunque no sea aniversario exacto (baja alarga)", () => {
  const p = defaultTrainingPeriods("2024-05-07", "2028-07-15"); // residencia alargada 2 meses
  assert.equal(p[3].start, "2027-05-07");
  assert.equal(p[3].end, "2028-07-15");
});

test("defaultTrainingPeriods maneja inicio en 29-feb", () => {
  const p = defaultTrainingPeriods("2024-02-29", "2028-02-28");
  assert.equal(p[0].end, "2025-02-27");   // día antes del aniversario ajustado
  assert.equal(p[1].start, "2025-02-28"); // aniversario ajustado a 28-feb
});

test("levelOn: PENDIENTE antes de empezar, R1..R4 por periodo, FINALIZADO después", () => {
  assert.equal(levelOn(periods, "2024-05-06"), "PENDIENTE");
  assert.equal(levelOn(periods, "2024-05-07"), "R1"); // primer día
  assert.equal(levelOn(periods, "2026-05-06"), "R2"); // último día de R2
  assert.equal(levelOn(periods, "2026-05-07"), "R3"); // sube en SU aniversario, no en junio (S-2)
  assert.equal(levelOn(periods, "2026-07-16"), "R3"); // hoy
  assert.equal(levelOn(periods, "2028-05-06"), "R4"); // último día
  assert.equal(levelOn(periods, "2028-05-07"), "FINALIZADO"); // desaparece por cálculo, no por borrado
});

test("levelOn: en un hueco entre periodos se conserva el nivel anterior (S-3: baja retrasa la promoción)", () => {
  const edited = [
    { year: 1, start: "2024-05-07", end: "2025-05-06" },
    { year: 2, start: "2025-05-07", end: "2026-05-06" },
    { year: 3, start: "2026-07-01", end: "2027-06-30" }, // baja de ~2 meses: R3 empieza tarde
    { year: 4, start: "2027-07-01", end: "2028-06-30" },
  ];
  assert.equal(levelOn(edited, "2026-06-01"), "R2"); // en el hueco sigue siendo R2
  assert.equal(levelOn(edited, "2026-07-01"), "R3");
});

test("groupOf: R3/R4 MAYOR, R1/R2 PEQUENO, resto null", () => {
  assert.equal(groupOf("R1"), "PEQUENO");
  assert.equal(groupOf("R2"), "PEQUENO");
  assert.equal(groupOf("R3"), "MAYOR");
  assert.equal(groupOf("R4"), "MAYOR");
  assert.equal(groupOf("FINALIZADO"), null);
  assert.equal(groupOf("PENDIENTE"), null);
});

test("periodOn devuelve el periodo formativo que contiene la fecha", () => {
  assert.deepEqual(periodOn(periods, "2024-05-07"), { year: 1, start: "2024-05-07", end: "2025-05-06" });
  assert.deepEqual(periodOn(periods, "2026-07-16"), { year: 3, start: "2026-05-07", end: "2027-05-06" });
  assert.deepEqual(periodOn(periods, "2026-05-06"), { year: 2, start: "2025-05-07", end: "2026-05-06" }); // último día de R2
  assert.deepEqual(periodOn(periods, "2028-05-06"), { year: 4, start: "2027-05-07", end: "2028-05-06" }); // último día
});

test("periodOn: null antes de empezar (PENDIENTE) o tras el último periodo (FINALIZADO)", () => {
  assert.equal(periodOn(periods, "2024-05-06"), null);
  assert.equal(periodOn(periods, "2028-05-07"), null);
});

test("periodOn: en un hueco entre periodos devuelve el periodo ANTERIOR (S-3, igual que levelOn)", () => {
  const edited = [
    { year: 1, start: "2024-05-07", end: "2025-05-06" },
    { year: 2, start: "2025-05-07", end: "2026-05-06" },
    { year: 3, start: "2026-07-01", end: "2027-06-30" },
    { year: 4, start: "2027-07-01", end: "2028-06-30" },
  ];
  assert.deepEqual(periodOn(edited, "2026-06-01"), { year: 2, start: "2025-05-07", end: "2026-05-06" });
  assert.deepEqual(periodOn(edited, "2026-07-01"), { year: 3, start: "2026-07-01", end: "2027-06-30" });
});

test("isActiveOn deriva actividad de los periodos", () => {
  assert.equal(isActiveOn(periods, "2026-07-16"), true);
  assert.equal(isActiveOn(periods, "2024-05-06"), false);
  assert.equal(isActiveOn(periods, "2028-05-07"), false);
});

test("validateTrainingPeriods: válidos → sin errores; hueco permitido", () => {
  assert.deepEqual(validateTrainingPeriods(periods), []);
  const withGap = [
    { year: 1, start: "2024-05-07", end: "2025-05-06" },
    { year: 2, start: "2025-05-07", end: "2026-05-06" },
    { year: 3, start: "2026-07-01", end: "2027-06-30" },
    { year: 4, start: "2027-07-01", end: "2028-06-30" },
  ];
  assert.deepEqual(validateTrainingPeriods(withGap), []);
});

test("validateTrainingPeriods detecta solapes, desorden y periodos invertidos", () => {
  const overlap = [
    { year: 1, start: "2024-05-07", end: "2025-05-06" },
    { year: 2, start: "2025-04-01", end: "2026-05-06" }, // solapa con R1
    { year: 3, start: "2026-05-07", end: "2027-05-06" },
    { year: 4, start: "2027-05-07", end: "2028-05-06" },
  ];
  assert.ok(validateTrainingPeriods(overlap).some(e => /solap/i.test(e)));

  const inverted = [
    { year: 1, start: "2025-05-06", end: "2024-05-07" }, // start > end
    { year: 2, start: "2025-05-07", end: "2026-05-06" },
    { year: 3, start: "2026-05-07", end: "2027-05-06" },
    { year: 4, start: "2027-05-07", end: "2028-05-06" },
  ];
  assert.ok(validateTrainingPeriods(inverted).length > 0);

  const wrongCount = periods.slice(0, 3);
  assert.ok(validateTrainingPeriods(wrongCount).some(e => /4 periodos/i.test(e)));
});


// --- periodsOfResident / groupOnDate --------------------------------------------------------
// Centralizan el `fechaFin || +4 años` que estaba copiado en siete ficheros, y el atajo
// "¿este residente es Mayor o Pequeño tal día?" que necesita el permiso del ciclo (V-16).

test("periodsOfResident: respeta los periodos editados si el residente los trae", () => {
  const propios = [{ year: 1, start: "2024-01-01", end: "2024-12-31" }];
  assert.deepEqual(periodsOfResident({ fechaInicio: "2024-05-07", periodos: propios }), propios);
});

test("periodsOfResident: sin fechaFin, deriva 4 años desde la incorporación", () => {
  const p = periodsOfResident({ fechaInicio: "2024-05-07" });
  assert.equal(p.length, 4);
  assert.equal(p[0].start, "2024-05-07");
  assert.equal(p[3].end, "2028-05-06"); // víspera del 4.º aniversario
});

test("periodsOfResident: con fechaFin, el R4 termina exactamente ahí", () => {
  const p = periodsOfResident({ fechaInicio: "2024-05-07", fechaFin: "2028-05-07" });
  assert.equal(p[3].end, "2028-05-07");
});

test("groupOnDate: MAYOR en R3/R4, PEQUENO en R1/R2, null fuera de la residencia", () => {
  const r = { fechaInicio: "2024-05-07", fechaFin: "2028-05-07" };
  assert.equal(groupOnDate(r, "2024-06-01"), "PEQUENO"); // R1
  assert.equal(groupOnDate(r, "2025-06-01"), "PEQUENO"); // R2
  assert.equal(groupOnDate(r, "2026-07-27"), "MAYOR");   // R3
  assert.equal(groupOnDate(r, "2027-06-01"), "MAYOR");   // R4
  assert.equal(groupOnDate(r, "2024-05-06"), null);      // PENDIENTE
  assert.equal(groupOnDate(r, "2028-05-08"), null);      // FINALIZADO
});

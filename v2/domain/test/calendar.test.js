// Tests de v2/domain/calendar.js — calendario puro (spec.md §3.4, decisión S-1).
// Anclas verificadas contra el calendario real y contra el Excel
// (Cuadrante Anual!I5 confirma: 2026-06-01 = 'L').
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseISO, toISO, weekday, isWeekend, addDays, addYears, daysInMonth,
  datesOfMonth, academicYearOf, trimesterOf, trimesterWindow, compareISO,
} from "../calendar.js";

test("parseISO acepta fechas válidas y devuelve componentes", () => {
  assert.deepEqual(parseISO("2026-06-01"), { year: 2026, month: 6, day: 1 });
  assert.deepEqual(parseISO("2024-02-29"), { year: 2024, month: 2, day: 29 }); // bisiesto
});

test("parseISO rechaza formatos y fechas inexistentes", () => {
  for (const bad of ["2026-2-1", "2026-02-30", "2026-13-01", "2027-02-29", "01-06-2026", "garbage", "", "2026-06-01T00:00", 20260601, null, undefined]) {
    assert.throws(() => parseISO(bad), /fecha/i, `debería rechazar ${JSON.stringify(bad)}`);
  }
});

test("toISO rellena con ceros", () => {
  assert.equal(toISO(2026, 6, 1), "2026-06-01");
  assert.equal(toISO(2026, 12, 25), "2026-12-25");
});

test("weekday devuelve L,M,X,J,V,S,D correctos (anclas reales)", () => {
  // El bug del cliente v1 (desfase +1 mes) haría fallar la primera ancla: pintaría 2026-06-01 como X.
  assert.equal(weekday("2026-06-01"), "L");
  assert.equal(weekday("2026-07-01"), "X");
  assert.equal(weekday("2026-12-25"), "V");
  assert.equal(weekday("2027-01-01"), "V");
  assert.equal(weekday("2026-08-15"), "S");
  assert.equal(weekday("2026-08-02"), "D");
  assert.equal(weekday("2024-02-29"), "J");
  assert.equal(weekday("2027-05-31"), "L");
});

test("isWeekend: sábado y domingo sí, laborables no", () => {
  assert.equal(isWeekend("2026-08-15"), true);  // S
  assert.equal(isWeekend("2026-08-02"), true);  // D
  assert.equal(isWeekend("2026-06-01"), false); // L
  assert.equal(isWeekend("2026-10-09"), false); // V — viernes NO es fin de semana
});

test("addDays cruza mes, año y febrero bisiesto", () => {
  assert.equal(addDays("2026-06-01", 1), "2026-06-02");
  assert.equal(addDays("2026-07-31", 2), "2026-08-02");   // doblete V-D de borde de mes (S-5)
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(addDays("2026-06-01", -1), "2026-05-31");
});

test("addYears con ajuste de 29-feb (spec §3.1)", () => {
  assert.equal(addYears("2024-05-07", 1), "2025-05-07");
  assert.equal(addYears("2024-02-29", 1), "2025-02-28");  // no bisiesto: se ajusta
  assert.equal(addYears("2024-02-29", 4), "2028-02-29");  // bisiesto: se conserva
});

test("daysInMonth (meses 1-12)", () => {
  assert.equal(daysInMonth(2026, 6), 30);
  assert.equal(daysInMonth(2026, 7), 31);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.throws(() => daysInMonth(2026, 0), /mes/i);
  assert.throws(() => daysInMonth(2026, 13), /mes/i);
});

test("datesOfMonth genera todas las fechas del mes", () => {
  const june = datesOfMonth(2026, 6);
  assert.equal(june.length, 30);
  assert.equal(june[0], "2026-06-01");
  assert.equal(june[29], "2026-06-30");
});

test("academicYearOf: el año académico empieza en junio (spec §3.4)", () => {
  assert.equal(academicYearOf("2026-06-01"), 2026);
  assert.equal(academicYearOf("2026-05-31"), 2025);
  assert.equal(academicYearOf("2026-12-31"), 2026);
  assert.equal(academicYearOf("2027-01-15"), 2026); // enero pertenece al académico anterior
  assert.equal(academicYearOf("2027-05-31"), 2026);
});

test("trimesterOf: T1 jun-ago, T2 sep-nov, T3 dic-feb (cruza año), T4 mar-may", () => {
  assert.equal(trimesterOf("2026-06-01"), "T1");
  assert.equal(trimesterOf("2026-08-31"), "T1");
  assert.equal(trimesterOf("2026-09-01"), "T2");
  assert.equal(trimesterOf("2026-11-30"), "T2");
  assert.equal(trimesterOf("2026-12-01"), "T3");
  assert.equal(trimesterOf("2027-01-15"), "T3");
  assert.equal(trimesterOf("2027-02-28"), "T3");
  assert.equal(trimesterOf("2027-03-01"), "T4");
  assert.equal(trimesterOf("2027-05-31"), "T4");
});

test("trimesterWindow: ventana completa del trimestre de la fecha", () => {
  assert.deepEqual(trimesterWindow("2026-07-15"), { trimestre: "T1", start: "2026-06-01", end: "2026-08-31" });
  assert.deepEqual(trimesterWindow("2026-09-01"), { trimestre: "T2", start: "2026-09-01", end: "2026-11-30" });
  assert.deepEqual(trimesterWindow("2027-04-30"), { trimestre: "T4", start: "2027-03-01", end: "2027-05-31" });
});

test("trimesterWindow: T3 cruza el año natural en los dos sentidos", () => {
  // Desde diciembre: el trimestre TERMINA en el febrero del año siguiente.
  assert.deepEqual(trimesterWindow("2026-12-25"), { trimestre: "T3", start: "2026-12-01", end: "2027-02-28" });
  // Desde enero/febrero: el diciembre que lo ABRE es del año anterior (el bug fácil).
  assert.deepEqual(trimesterWindow("2027-01-15"), { trimestre: "T3", start: "2026-12-01", end: "2027-02-28" });
  assert.deepEqual(trimesterWindow("2027-02-28"), { trimestre: "T3", start: "2026-12-01", end: "2027-02-28" });
});

test("trimesterWindow: febrero de año bisiesto cierra el 29", () => {
  assert.equal(trimesterWindow("2028-01-10").end, "2028-02-29");
});

test("compareISO ordena cronológicamente y valida entradas", () => {
  assert.ok(compareISO("2026-06-01", "2026-06-02") < 0);
  assert.ok(compareISO("2027-01-01", "2026-12-31") > 0);
  assert.equal(compareISO("2026-06-01", "2026-06-01"), 0);
  assert.throws(() => compareISO("2026-6-1", "2026-06-01"), /fecha/i);
});

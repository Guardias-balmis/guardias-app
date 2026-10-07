// Tests de v2/domain/holidays.js — festivos de la Comunitat Valenciana por año (V-61).
// Las listas esperadas de 2025 y 2026 salen de los decretos de calendario laboral de la
// Comunitat (2026: Decreto 100/2025, DOGV 10145, 12 días): si cambian, es que el algoritmo o la
// regla de los domingos se ha movido, no los decretos.
import test from "node:test";
import assert from "node:assert/strict";
import { easterSunday, valencianHolidays } from "../holidays.js";

test("Domingo de Pascua de varios años conocidos", () => {
  const conocidos = { 2024: "2024-03-31", 2025: "2025-04-20", 2026: "2026-04-05", 2027: "2027-03-28", 2028: "2028-04-16", 2038: "2038-04-25" };
  for (const [anio, pascua] of Object.entries(conocidos)) assert.equal(easterSunday(Number(anio)), pascua, anio);
});

test("2026: exactamente los 12 días del decreto (1 de nov y 6 de dic son domingo y no se incluyen)", () => {
  const fechas = valencianHolidays(2026).map((h) => h.fecha);
  assert.deepEqual(fechas, [
    "2026-01-01", "2026-01-06", "2026-03-19", "2026-04-03", "2026-04-06", "2026-05-01",
    "2026-06-24", "2026-08-15", "2026-10-09", "2026-10-12", "2026-12-08", "2026-12-25",
  ]);
});

test("2025: los 13 de la lista autonómica (el 12 de octubre es domingo y no se incluye)", () => {
  const fechas = valencianHolidays(2025).map((h) => h.fecha);
  assert.deepEqual(fechas, [
    "2025-01-01", "2025-01-06", "2025-03-19", "2025-04-18", "2025-04-21", "2025-05-01", "2025-06-24",
    "2025-08-15", "2025-10-09", "2025-11-01", "2025-12-06", "2025-12-08", "2025-12-25",
  ]);
});

test("Viernes Santo y Lunes de Pascua siguen a la Pascua, y ninguno cae en domingo", () => {
  for (const anio of [2027, 2028, 2030, 2031]) {
    const pascua = easterSunday(anio);
    const lista = valencianHolidays(anio);
    const por = (n) => lista.find((h) => h.nombre === n);
    assert.ok(por("Viernes Santo") && por("Lunes de Pascua"), String(anio));
    assert.ok(por("Viernes Santo").fecha < pascua && por("Lunes de Pascua").fecha > pascua);
    assert.ok(lista.every((h) => new Date(h.fecha + "T00:00:00Z").getUTCDay() !== 0), "ningún festivo automático en domingo");
  }
});

test("la lista sale ordenada, sin fechas repetidas y con ámbito válido", () => {
  for (let anio = 2026; anio <= 2040; anio++) {
    const lista = valencianHolidays(anio);
    const fechas = lista.map((h) => h.fecha);
    assert.deepEqual(fechas, [...fechas].sort(), String(anio));
    assert.equal(new Set(fechas).size, fechas.length, String(anio));
    assert.ok(lista.every((h) => ["NACIONAL", "AUTONOMICO"].includes(h.ambito) && h.nombre));
    assert.ok(lista.every((h) => h.fecha.startsWith(`${anio}-`)), "todas del año pedido");
  }
});

test("Jueves Santo no es festivo en la Comunitat", () => {
  const jueves = "2026-04-02";
  assert.ok(!valencianHolidays(2026).some((h) => h.fecha === jueves));
});

test("un año absurdo se rechaza en vez de inventar fechas", () => {
  assert.throws(() => valencianHolidays(1800), /fuera de rango/);
  assert.throws(() => valencianHolidays(2026.5), /fuera de rango/);
  assert.throws(() => valencianHolidays("2026"), /fuera de rango/);
});

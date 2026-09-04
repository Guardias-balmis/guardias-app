import test from "node:test";
import assert from "node:assert/strict";
import { partirResidentesLegibles } from "../residentes.js";

const OK = { id: "a", nombre: "Ana", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

test("un residente con fechas ISO es legible", () => {
  const { legibles, ilegibles } = partirResidentesLegibles([OK], "2026-09-04");
  assert.deepEqual(legibles, [OK]);
  assert.deepEqual(ilegibles, []);
});

test("una fecha tecleada a mano en la hoja aparta SOLO a ese residente, con el motivo, y no tumba a los demás", () => {
  const malo = { id: "b", nombre: "Bea", fechaInicio: "31/05/2026", fechaFin: "2030-05-24" };
  const sinFecha = { id: "c", nombre: "Caro" };
  const { legibles, ilegibles } = partirResidentesLegibles([OK, malo, sinFecha], "2026-09-04");
  assert.deepEqual(legibles, [OK]);
  assert.deepEqual(ilegibles.map((x) => x.residente.id), ["b", "c"]);
  assert.match(ilegibles[0].motivo, /31\/05\/2026/);
});

test("unos periodos editados corruptos también cuentan como ilegibles", () => {
  const conPeriodos = { ...OK, id: "d", periodos: [{ year: 1, start: "ayer", end: "2025-05-26" }] };
  const { legibles, ilegibles } = partirResidentesLegibles([conPeriodos], "2026-09-04");
  assert.deepEqual(legibles, []);
  assert.equal(ilegibles.length, 1);
});

test("lista vacía o ausente: nada que apartar", () => {
  assert.deepEqual(partirResidentesLegibles([], "2026-09-04"), { legibles: [], ilegibles: [] });
  assert.deepEqual(partirResidentesLegibles(undefined, "2026-09-04"), { legibles: [], ilegibles: [] });
});

test("una fechaFin ilegible con los periodos ya en la tabla también es ilegible: la pantalla de Residentes, la única que la corrige, no debe lanzar", () => {
  const r = {
    id: "dani", nombre: "Dani", fechaInicio: "2025-05-26", fechaFin: "25/05/2029",
    periodos: [
      { year: 1, start: "2025-05-26", end: "2026-05-25" }, { year: 2, start: "2026-05-26", end: "2027-05-25" },
      { year: 3, start: "2027-05-26", end: "2028-05-25" }, { year: 4, start: "2028-05-26", end: "2029-05-25" },
    ],
  };
  const { legibles, ilegibles } = partirResidentesLegibles([r], "2026-09-04");
  assert.equal(legibles.length, 0);
  assert.equal(ilegibles.length, 1);
  assert.match(ilegibles[0].motivo, /25\/05\/2029/);
});

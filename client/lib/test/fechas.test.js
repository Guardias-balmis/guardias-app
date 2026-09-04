import test from "node:test";
import assert from "node:assert/strict";
import { fechaValida, rangoValido } from "../fechas.js";

test("fechaValida acepta una fecha ISO real y rechaza sin lanzar lo que teclea el navegador a medias", () => {
  assert.equal(fechaValida("2026-09-04"), true);
  for (const mala of ["", "0002-09-04", "0020-09-04", "2026-02-30", "4/9/2026", undefined, null, 42]) {
    assert.equal(fechaValida(mala), false, JSON.stringify(mala));
  }
});

test("rangoValido exige dos fechas válidas en orden, y no lanza con valores intermedios", () => {
  assert.equal(rangoValido("2026-09-01", "2026-09-04"), true);
  assert.equal(rangoValido("2026-09-04", "2026-09-04"), true);
  assert.equal(rangoValido("2026-09-05", "2026-09-04"), false);
  assert.equal(rangoValido("0002-09-04", "2026-09-04"), false);
  assert.equal(rangoValido("", "2026-09-04"), false);
});

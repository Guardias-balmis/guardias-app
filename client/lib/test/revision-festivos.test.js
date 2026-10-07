import test from "node:test";
import assert from "node:assert/strict";
import { anioARevisar, recordarRevision } from "../revision-festivos.js";

test("V-63: se revisa el año en curso, y desde diciembre el siguiente (para montar enero)", () => {
  assert.equal(anioARevisar("2026-01-01"), 2026);
  assert.equal(anioARevisar("2026-10-08"), 2026);
  assert.equal(anioARevisar("2026-11-30"), 2026);
  assert.equal(anioARevisar("2026-12-01"), 2027);
  assert.equal(anioARevisar("2026-12-31"), 2027);
  assert.equal(anioARevisar("2027-01-01"), 2027);
});

test("V-63: solo se recuerda si el servidor dice que NO está revisado; ante un fallo no se molesta", () => {
  assert.equal(recordarRevision({ ok: true, revisado: false }), true);
  assert.equal(recordarRevision({ ok: true, revisado: true }), false);
  assert.equal(recordarRevision({ ok: false, error: "x" }), false);
  assert.equal(recordarRevision(null), false);
  assert.equal(recordarRevision(undefined), false);
});

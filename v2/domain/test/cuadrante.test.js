// Tests de v2/domain/cuadrante.js — ciclo de estados BORRADOR->VALIDADO->PUBLICADO (Fase 6.2).
import test from "node:test";
import assert from "node:assert/strict";
import { STATES, canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit } from "../cuadrante.js";

const error = (invariante) => ({ invariante, severidad: "error", detalle: "x" });
const aviso = (invariante) => ({ invariante, severidad: "aviso", detalle: "x" });

test("STATES expone los tres estados del ciclo, en orden", () => {
  assert.deepEqual(STATES, ["BORRADOR", "VALIDADO", "PUBLICADO"]);
});

test("canValidate: sin violaciones es válido", () => {
  assert.equal(canValidate([]), true);
});

test("canValidate: solo avisos sigue siendo válido (severidad error es la única bloqueante, spec.md §5)", () => {
  assert.equal(canValidate([aviso("INV-2"), aviso("INV-11")]), true);
});

test("canValidate: cualquier error bloquea, aunque también haya avisos", () => {
  assert.equal(canValidate([error("INV-1"), aviso("INV-2")]), false);
});

test("canPublish: solo desde VALIDADO", () => {
  assert.equal(canPublish("VALIDADO"), true);
  assert.equal(canPublish("BORRADOR"), false);
  assert.equal(canPublish("PUBLICADO"), false);
});

test("canUnpublish: solo desde PUBLICADO", () => {
  assert.equal(canUnpublish("PUBLICADO"), true);
  assert.equal(canUnpublish("VALIDADO"), false);
  assert.equal(canUnpublish("BORRADOR"), false);
});

test("canEdit: bloqueado únicamente en PUBLICADO (decisión V-9b)", () => {
  assert.equal(canEdit("BORRADOR"), true);
  assert.equal(canEdit("VALIDADO"), true);
  assert.equal(canEdit("PUBLICADO"), false);
});

test("stateAfterEdit: un mes VALIDADO vuelve a BORRADOR al editarlo", () => {
  assert.equal(stateAfterEdit("VALIDADO"), "BORRADOR");
});

test("stateAfterEdit: BORRADOR se queda igual (no genera una transición sin efecto)", () => {
  assert.equal(stateAfterEdit("BORRADOR"), "BORRADOR");
});

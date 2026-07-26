// Tests de v2/domain/cuadrante.js — ciclo de estados BORRADOR->VALIDADO->PUBLICADO (Fase 6.2).
import test from "node:test";
import assert from "node:assert/strict";
import { STATES, canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit, EQUITY_INVARIANTS, equityWarnings } from "../cuadrante.js";

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

// --- Avisos de equidad (decisión V-14) -----------------------------------------------------
// La equidad no bloquea nunca: la UI usa esto para pedir confirmación explícita antes de
// validar un cuadrante que la incumple, sin reconocer mensajes por su texto.

test("EQUITY_INVARIANTS son los tres que miden equidad del reparto", () => {
  assert.deepEqual(EQUITY_INVARIANTS, ["INV-3", "INV-8", "INV-11"]);
});

test("equityWarnings devuelve solo los AVISOS de los invariantes de equidad", () => {
  const violaciones = [
    error("INV-1"), aviso("INV-1"),   // día sin cubrir / cubierto por 1: no es equidad
    error("INV-5"),                    // baja: no es equidad
    aviso("INV-3"), aviso("INV-8"), aviso("INV-11"),
  ];
  assert.deepEqual(equityWarnings(violaciones).map((v) => v.invariante), ["INV-3", "INV-8", "INV-11"]);
});

test("equityWarnings ignora un error de un invariante de equidad (no debería existir, pero no se cuela como aviso)", () => {
  assert.deepEqual(equityWarnings([error("INV-3"), error("INV-11")]), []);
});

test("equityWarnings sobre una lista sin equidad devuelve vacío", () => {
  assert.deepEqual(equityWarnings([error("INV-1"), aviso("INV-10")]), []);
  assert.deepEqual(equityWarnings([]), []);
});

test("canValidate no bloquea por avisos de equidad (V-14): un cuadrante desequilibrado se puede validar", () => {
  assert.equal(canValidate([aviso("INV-3"), aviso("INV-8"), aviso("INV-11")]), true);
});

// Tests de client/lib/rest.js — el aviso de descanso (INV-15) al escribir una celda.
// Lo que más importa aquí: que use el MISMO conjunto de códigos que el validador (V/R/B no
// encadenan) y que vea el par que cruza el borde del mes, que es el caso que se olvida siempre.
import test from "node:test";
import assert from "node:assert/strict";
import { chainedNeighbour } from "../rest.js";

test("un 3P el día siguiente a una guardia encadena", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "G", "2026-08-11": "3P" }, fecha: "2026-08-11", codigo: "3P" }),
    "2026-08-10"
  );
});

test("un 3P el día ANTERIOR a una guardia también encadena", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "3P", "2026-08-11": "G" }, fecha: "2026-08-10", codigo: "3P" }),
    "2026-08-11"
  );
});

test("dos días de separación no encadenan", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "G", "2026-08-12": "3P" }, fecha: "2026-08-12", codigo: "3P" }),
    null
  );
});

test("una guardia junto a otra guardia encadena igual: la regla no es solo del 3P", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "GF", "2026-08-11": "G" }, fecha: "2026-08-11", codigo: "G" }),
    "2026-08-10"
  );
});

test("V/R/B no ocupan puesto: ni encadenan ni se encadenan con ellos", () => {
  // Marcar vacaciones el día después de una guardia no es encadenar.
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "G", "2026-08-11": "V" }, fecha: "2026-08-11", codigo: "V" }),
    null
  );
  // Y una guardia el día después de unas vacaciones tampoco.
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "V", "2026-08-11": "G" }, fecha: "2026-08-11", codigo: "G" }),
    null
  );
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "B", "2026-08-11": "3P" }, fecha: "2026-08-11", codigo: "3P" }),
    null
  );
});

test("borrar una celda (código vacío) nunca avisa", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-08-10": "G", "2026-08-11": "" }, fecha: "2026-08-11", codigo: "" }),
    null
  );
});

test("el par que cruza el BORDE del mes se ve, gracias a `bordes`", () => {
  // Día 1 del mes, con guardia el último día del mes anterior. Sin `bordes` esto es invisible.
  assert.equal(
    chainedNeighbour({
      codigos: { "2026-09-01": "3P" },
      bordes: [{ fecha: "2026-08-31", codigo: "G" }],
      fecha: "2026-09-01", codigo: "3P",
    }),
    "2026-08-31"
  );
});

test("el borde del final del mes también", () => {
  assert.equal(
    chainedNeighbour({
      codigos: { "2026-08-31": "3P" },
      bordes: [{ fecha: "2026-09-01", codigo: "G" }],
      fecha: "2026-08-31", codigo: "3P",
    }),
    "2026-09-01"
  );
});

test("sin `bordes`, el día 1 no inventa un conflicto que no puede ver", () => {
  assert.equal(
    chainedNeighbour({ codigos: { "2026-09-01": "3P" }, fecha: "2026-09-01", codigo: "3P" }),
    null
  );
});

test("si encadena por los dos lados, se nombra el día anterior", () => {
  assert.equal(
    chainedNeighbour({
      codigos: { "2026-08-10": "G", "2026-08-11": "3P", "2026-08-12": "G" },
      fecha: "2026-08-11", codigo: "3P",
    }),
    "2026-08-10"
  );
});

test("una celda aislada en un mes vacío no avisa", () => {
  assert.equal(chainedNeighbour({ codigos: { "2026-08-15": "3P" }, fecha: "2026-08-15", codigo: "3P" }), null);
  assert.equal(chainedNeighbour({ fecha: "2026-08-15", codigo: "3P" }), null);
});

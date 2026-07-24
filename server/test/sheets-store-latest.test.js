// Tests de readLatest en sheets-store.js — resolución "última versión gana" sobre un
// almacén append-only (ADR-002 D-3). Nunca se sobreescribe una fila cruda: para dar una
// vista de "estado actual" (p.ej. la celda de un día de guardia, o las preferencias de un
// mes), se toma la ÚLTIMA fila insertada para una misma clave. Una fila con valor "" es un
// borrado explícito (arregla el bug del v1: "borrar una celda nunca se persiste").
import test from "node:test";
import assert from "node:assert/strict";
import { makeStore } from "../src/sheets-store.js";

function fakeSS(rows = {}) {
  const sheets = new Map(Object.entries(rows).map(([k, v]) => [k, v.map((r) => r.slice())]));
  return {
    listSheets: () => [...sheets.keys()], exists: (n) => sheets.has(n),
    read: (n) => (sheets.get(n) || []).map((r) => r.slice()),
    overwrite: (n, r) => sheets.set(n, r.map((x) => x.slice())),
    append: (n, r) => { if (!sheets.has(n)) sheets.set(n, []); sheets.get(n).push(...r.map((x) => x.slice())); },
    createSheet: (n) => sheets.set(n, []), deleteSheet: (n) => sheets.delete(n),
    renameSheet: (a, b) => { sheets.set(b, sheets.get(a)); sheets.delete(a); },
  };
}
let n = 0;
const store = (ss) => makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++n}` });

test("readLatest: sin duplicados, devuelve todos los registros", () => {
  const ss = fakeSS();
  ss.createSheet("asignaciones");
  const st = store(ss);
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "G" });
  st.appendRecord("asignaciones", { fecha: "2026-06-02", residenteId: "ana", codigo: "GF" });
  const latest = st.readLatest("asignaciones", (r) => `${r.fecha}|${r.residenteId}`);
  assert.equal(latest.length, 2);
});

test("readLatest: la última fila de la misma clave gana (edición)", () => {
  const ss = fakeSS();
  ss.createSheet("asignaciones");
  const st = store(ss);
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "G" });
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "GF" }); // corrección
  const latest = st.readLatest("asignaciones", (r) => `${r.fecha}|${r.residenteId}`);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].codigo, "GF");
});

test("readLatest: código vacío es un borrado explícito y se excluye del estado actual", () => {
  const ss = fakeSS();
  ss.createSheet("asignaciones");
  const st = store(ss);
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "G" });
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "" }); // borrado
  const latest = st.readLatest("asignaciones", (r) => `${r.fecha}|${r.residenteId}`, { emptyField: "codigo" });
  assert.equal(latest.length, 0); // arregla el bug del v1: borrar SÍ se persiste
});

test("readLatest: preserva el orden relativo de primera aparición de cada clave", () => {
  const ss = fakeSS();
  ss.createSheet("asignaciones");
  const st = store(ss);
  st.appendRecord("asignaciones", { fecha: "2026-06-02", residenteId: "ana", codigo: "G" });
  st.appendRecord("asignaciones", { fecha: "2026-06-01", residenteId: "ana", codigo: "G" });
  st.appendRecord("asignaciones", { fecha: "2026-06-02", residenteId: "ana", codigo: "GF" }); // reedición, no mueve posición
  const latest = st.readLatest("asignaciones", (r) => `${r.fecha}|${r.residenteId}`);
  assert.deepEqual(latest.map((r) => r.fecha), ["2026-06-02", "2026-06-01"]);
});

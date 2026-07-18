// Tests de la acción listAsignacionesRango (Fase 6.1): a diferencia de listAsignaciones
// (filtra por mes/año), esta filtra por rango de fechas ISO [desde,hasta] cruzando meses o
// años. La usan Calendar.jsx (fix del contrato C-2: INV-7 necesita las asignaciones de TODO
// el periodo de rotación, que puede empezar en meses anteriores) y Generator.jsx (contaje
// acumulado del año de residencia en curso, spec §4).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { parseISO } from "../../v2/domain/calendar.js";

const CLIENT_ID = "cid.apps.googleusercontent.com";
const crypto = {
  hmac: (m, s) => nodeCrypto.createHmac("sha256", s).update(m, "utf8").digest("base64url"),
  b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
  b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
};

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
const ANA = { id: "uuid-ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
let idCounter = 0;
function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), recordToRow(TABLES.residentes, ANA)],
    responsables: [headerOf(TABLES.responsables)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    preferencias: [headerOf(TABLES.preferencias)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: { canEdit, stateAfterEdit, parseISO },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "ana@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] }),
    ...overrides,
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("listAsignacionesRango requiere sesión", () => {
  const r = call({ action: "listAsignacionesRango", desde: "2026-05-01", hasta: "2026-07-31" }, makeDeps());
  assert.equal(r.ok, false);
});

test("listAsignacionesRango filtra por fecha (inclusive) cruzando meses y años", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2025-12-31", residenteId: "uuid-ana", codigo: "G" },  // justo fuera
    { fecha: "2026-01-01", residenteId: "uuid-ana", codigo: "G" },  // borde inferior, dentro
    { fecha: "2026-05-15", residenteId: "uuid-ana", codigo: "GF" }, // dentro
    { fecha: "2026-07-02", residenteId: "uuid-ana", codigo: "G" },  // borde superior, dentro
    { fecha: "2026-07-03", residenteId: "uuid-ana", codigo: "G" },  // justo fuera
  ] }, deps);
  const r = call({ action: "listAsignacionesRango", session, desde: "2026-01-01", hasta: "2026-07-02" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.asignaciones.length, 3);
  assert.deepEqual(r.asignaciones.map((a) => a.fecha).sort(), ["2026-01-01", "2026-05-15", "2026-07-02"]);
});

test("listAsignacionesRango devuelve asignaciones de TODOS los residentes, no solo de quien consulta", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2026-06-01", residenteId: "uuid-ana", codigo: "G" },
    { fecha: "2026-06-02", residenteId: "otro-residente", codigo: "GP" },
  ] }, deps);
  const r = call({ action: "listAsignacionesRango", session, desde: "2026-06-01", hasta: "2026-06-30" }, deps);
  assert.equal(r.asignaciones.length, 2);
});

test("listAsignacionesRango respeta última-gana (reedición del mismo día)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "G" }] }, deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "GP" }] }, deps);
  const r = call({ action: "listAsignacionesRango", session, desde: "2026-01-01", hasta: "2026-12-31" }, deps);
  assert.equal(r.asignaciones.length, 1);
  assert.equal(r.asignaciones[0].codigo, "GP");
});

test("listAsignacionesRango respeta última-gana con un borrado explícito (codigo vacío desaparece, no una fila vacía)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "G" }] }, deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "" }] }, deps);
  const r = call({ action: "listAsignacionesRango", session, desde: "2026-01-01", hasta: "2026-12-31" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.asignaciones.length, 0);
});

test("listAsignacionesRango rechaza un rango invertido (desde > hasta)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "listAsignacionesRango", session, desde: "2026-07-01", hasta: "2026-06-01" }, deps);
  assert.equal(r.ok, false);
});

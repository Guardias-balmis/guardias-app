// Tests del ciclo de estados del Cuadrante (Fase 6.2, spec.md §2/§5, decisión V-9/V-10):
// estadoCuadrante, marcarValidado (solo Responsable, revalida en servidor), publicarCuadrante
// y despublicarCuadrante (solo Responsable), y guardarAsignaciones consciente del estado
// (bloquea PUBLICADO, revierte VALIDADO→BORRADOR al editar).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "../../v2/domain/validate.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";

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

// RESP es Responsable en mandato (periodoInicio 2027-01-01..2028-01-01, cubre `today`); OTRO no.
const RESP = { id: "resp-1", nombre: "Rita", email: "resp@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const OTRO = { id: "otro-1", nombre: "Oscar", email: "otro@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "resp-1", metodo: "VOLUNTARIO" })],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16", // dentro del mandato de RESP
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${nodeCrypto.randomUUID()}` }),
    domain: { validateMonth, buildMonthContext, rotationHistoryStart, parseISO, canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => {
      const email = /:([^:]+)@/.test(idToken) ? idToken.split(":")[1] : "resp@gmail.com";
      return { aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] };
    },
    ...overrides,
  };
}
// Deps con validateMonth reemplazado por un stub "cuadrante limpio" — construir un mes real
// que pase TODOS los invariantes (INV-1 exige cubrir cada día) es un problema combinatorio
// aparte del ciclo de estados que aquí se prueba; el propio validador ya está probado a fondo
// en v2/domain/test/validate.test.js.
function stubClean(deps) {
  return { ...deps, domain: { ...deps.domain, validateMonth: () => [] } };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("estadoCuadrante: sin filas previas, el estado por defecto es BORRADOR", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "BORRADOR");
});

test("marcarValidado: rechaza a quien no es Responsable", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("marcarValidado: el Responsable con un cuadrante sin errores lo pasa a VALIDADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("marcarValidado: revalida en el SERVIDOR (ignora lo que diga el cliente) — un mes vacío tiene errores reales de INV-1 y no se persiste", () => {
  const deps = makeDeps(); // domain.validateMonth REAL, sin stub
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "INV-1" && v.severidad === "error"));
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("marcarValidado: rechaza si el cuadrante ya está PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("publicarCuadrante: rechaza si el cuadrante todavía está en BORRADOR", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /VALIDADO/);
});

test("publicarCuadrante: rechaza a quien no es Responsable, aunque el cuadrante esté VALIDADO", () => {
  const deps = stubClean(makeDeps());
  const sResp = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session: sResp, mes: 7, anio: 2027 }, deps);
  const sOtro = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "publicarCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("publicarCuadrante: el Responsable pasa un cuadrante VALIDADO a PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "PUBLICADO");
});

test("despublicarCuadrante: rechaza si no está PUBLICADO", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
});

test("despublicarCuadrante: rechaza a quien no es Responsable", () => {
  const deps = stubClean(makeDeps());
  const sResp = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session: sResp, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session: sResp, mes: 7, anio: 2027 }, deps);
  const sOtro = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "despublicarCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("despublicarCuadrante: el Responsable revierte PUBLICADO a VALIDADO (para corregir y republicar)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
});

test("guardarAsignaciones: rechaza cualquier edición de un mes PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /PUBLICADO/);
  const asigs = call({ action: "listAsignaciones", session, anio: 2027, mes: 7 }, deps);
  assert.deepEqual(asigs.asignaciones, []); // no se escribió nada
});

test("guardarAsignaciones: editar un mes VALIDADO lo revierte a BORRADOR automáticamente", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");

  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, true);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("guardarAsignaciones: editar un mes BORRADOR no cambia nada del ciclo de estados", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, true);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("guardarAsignaciones: rechaza el lote entero (sin escribir nada) si una fecha no es una ISO válida", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" },
    { fecha: "no-es-una-fecha", residenteId: "resp-1", codigo: "G" },
  ] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fecha inválida/);
  const asigs = call({ action: "listAsignaciones", session, anio: 2027, mes: 7 }, deps);
  assert.deepEqual(asigs.asignaciones, []); // nada del lote se escribió, ni siquiera el cambio válido
});

test("acciones del ciclo de estados requieren sesión", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "estadoCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "marcarValidado", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "publicarCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "despublicarCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
});

test("mes/anio inválidos se rechazan en las acciones del cuadrante", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 13, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "marcarValidado", session, mes: 0, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "publicarCuadrante", session, mes: 7, anio: 99 }, deps).ok, false);
});

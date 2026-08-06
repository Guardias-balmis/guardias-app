// Tests de server/src/router.js — ensamblaje doGet/doPost (ADR-002 D-2/D-4, paso 2.4).
// handleRequest es puro: recibe el cuerpo crudo y unas dependencias inyectadas (fetchTokeninfo,
// nonces, store, dominio, crypto, reloj). El wrapper doPost de Apps Script solo lee
// e.postData.contents y serializa el retorno. Se prueba el flujo completo login→sesión→acción
// autenticada + validación, y que TODA entrada hostil devuelve JSON (nunca lanza).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth } from "../../v2/domain/validate.js";

const CLIENT_ID = "cid.apps.googleusercontent.com";
const crypto = {
  hmac: (m, s) => nodeCrypto.createHmac("sha256", s).update(m, "utf8").digest("base64url"),
  b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
  b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
};

// Store en memoria con una residente vinculada.
function fakeSS(rows) {
  const sheets = new Map(Object.entries(rows));
  return {
    listSheets: () => [...sheets.keys()], exists: (n) => sheets.has(n),
    read: (n) => (sheets.get(n) || []).map((r) => r.slice()),
    overwrite: (n, r) => sheets.set(n, r), append: (n, r) => (sheets.get(n) || sheets.set(n, []).get(n)).push(...r),
    createSheet: (n) => sheets.set(n, []), deleteSheet: (n) => sheets.delete(n),
    renameSheet: (a, b) => { sheets.set(b, sheets.get(a)); sheets.delete(a); },
  };
}
const ANA = { id: "uuid-ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), recordToRow(TABLES.residentes, ANA)],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "resp1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "uuid-ana", metodo: "VOLUNTARIO" })],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => "nuevo-id" }),
    domain: { absences, validateMonth },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "ana@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] }),
    ...overrides,
  };
}
const call = (body, deps) => handleRequest(typeof body === "string" ? body : JSON.stringify(body), deps);

test("getNonce devuelve un nonce", () => {
  const r = call({ action: "getNonce" }, makeDeps());
  assert.equal(r.ok, true);
  assert.match(r.nonce, /^nonce-/);
});

test("login válido resuelve la residente, marca rol responsable y emite sesión", () => {
  const deps = makeDeps();
  const nonce = call({ action: "getNonce" }, deps).nonce;
  const r = call({ action: "login", idToken: "jwt", nonce }, deps);
  assert.equal(r.ok, true);
  assert.ok(r.session);
  assert.equal(r.residente.id, "uuid-ana");
  assert.equal(r.residente.rol, "responsable"); // hoy (2027-07-16) está dentro de su mandato
});

test("login con aud de otra app se rechaza (fallo estrella propagado)", () => {
  const deps = makeDeps({ fetchTokeninfo: () => ({ aud: "otra.apps.googleusercontent.com", iss: "https://accounts.google.com", email: "ana@gmail.com", email_verified: "true", exp: String(2_000_000) }) });
  const r = call({ action: "login", idToken: "jwt" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /aud/i);
});

test("login de un email no vinculado a ningún residente se rechaza y da un pendingToken (evita repetir el login de Google para el alta)", () => {
  // consumeNonce undefined: aislamos la rama de resolución de residente (nonce no exigido aquí)
  const deps = makeDeps({
    consumeNonce: undefined,
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "desconocido@gmail.com", email_verified: "true", exp: String(2_000_000) }),
  });
  const r = call({ action: "login", idToken: "jwt" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /vinculad/i);
  assert.ok(r.pendingToken, "debe incluir un pendingToken reutilizable para altaResidente");
});

test("una acción autenticada sin sesión válida se rechaza", () => {
  const r = call({ action: "whoami", session: "falsa.firma" }, makeDeps());
  assert.equal(r.ok, false);
  assert.match(r.error, /sesi/i);
});

test("flujo completo: login → whoami con la sesión emitida", () => {
  const deps = makeDeps();
  const nonce = call({ action: "getNonce" }, deps).nonce;
  const session = call({ action: "login", idToken: "jwt", nonce }, deps).session;
  const r = call({ action: "whoami", session }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.sub, "uuid-ana");
  assert.equal(r.rol, "responsable");
});

test("acción 'validar' pasa el cuadrante por el validador de dominio", () => {
  const deps = makeDeps();
  const nonce = call({ action: "getNonce" }, deps).nonce;
  const session = call({ action: "login", idToken: "jwt", nonce }, deps).session;
  const cuadrante = {
    mes: 7, anio: 2026,
    residentes: [{ id: "ANA", fechaInicio: "2023-05-22", fechaFin: "2027-05-21" }, { id: "IVAN", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }],
    asignaciones: [{ residenteId: "ANA", fecha: "2026-07-15", codigo: "G" }, { residenteId: "IVAN", fecha: "2026-07-15", codigo: "G" }],
  };
  const r = call({ action: "validar", session, cuadrante }, deps);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.violaciones));
  assert.ok(r.violaciones.some((v) => v.invariante === "INV-11")); // R1 en verano
  assert.equal(typeof r.bloqueantes, "number");
});

test("cuerpo que no es JSON válido devuelve error, no lanza", () => {
  const r = call("esto no es json", makeDeps());
  assert.equal(r.ok, false);
  assert.match(r.error, /json/i);
});

test("acción desconocida devuelve error controlado", () => {
  const r = call({ action: "borrarTodo" }, makeDeps());
  assert.equal(r.ok, false);
});

test("una excepción interna se captura y devuelve JSON (nunca HTML de Apps Script)", () => {
  const deps = makeDeps({ store: { readRecords: () => { throw new Error("Sheet caído"); } } });
  const r = call({ action: "login", idToken: "jwt" }, deps);
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
});

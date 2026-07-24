// Tests de listBloqueos — a diferencia de misBloqueos (alcance al propio residente, para la
// pantalla de Preferencias), esta acción devuelve los bloqueos ACTIVOS de TODOS los
// residentes en un mes: lo necesita el validador de CalendarScreen (INV-5/6/7 dependen de
// los bloqueos del equipo entero, no solo de quien pulsa "Validar").
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";

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
function makeDeps() {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), recordToRow(TABLES.residentes, ANA)],
    responsables: [headerOf(TABLES.responsables)],
    bloqueos: [headerOf(TABLES.bloqueos)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: {},
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "ana@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("listBloqueos devuelve los bloqueos activos de TODOS los residentes, no solo el propio", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  deps.store.appendRecord("bloqueos", { residenteId: "uuid-ana", desde: "2026-08-01", hasta: "2026-08-05", motivo: "VACACIONES", activo: true });
  deps.store.appendRecord("bloqueos", { residenteId: "otro-residente", desde: "2026-08-10", hasta: "2026-08-12", motivo: "ROTACION", activo: true });
  const r = call({ action: "listBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.bloqueos.length, 2);
});

test("listBloqueos excluye los cancelados", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = deps.store.appendRecord("bloqueos", { residenteId: "uuid-ana", desde: "2026-08-01", hasta: "2026-08-05", motivo: "VACACIONES", activo: true });
  deps.store.appendRecord("bloqueos", { id, residenteId: "uuid-ana", desde: "2026-08-01", hasta: "2026-08-05", motivo: "VACACIONES", activo: false });
  const r = call({ action: "listBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r.bloqueos.length, 0);
});

test("listBloqueos requiere sesión", () => {
  const r = call({ action: "listBloqueos", anio: 2026, mes: 8 }, makeDeps());
  assert.equal(r.ok, false);
});

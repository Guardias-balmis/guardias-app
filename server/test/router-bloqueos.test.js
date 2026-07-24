// Tests de las acciones de bloqueos (Fase 4.0): crearBloqueo, misBloqueos, cancelarBloqueo.
// Vacaciones/rotación/baja — spec.md §5 decisión V-6: rango desde/hasta, nunca un día suelto;
// cancelación por reinserción con el MISMO id (append-only, readLatest resuelve). Estas
// acciones son agnósticas de severidad: desde V-8 (Fase 5.x) solo BAJA bloquea la asignación
// (INV-5) — la distinción vive en el validador de dominio, no aquí.
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
function makeDeps(overrides = {}) {
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
    ...overrides,
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("crearBloqueo y misBloqueos hacen round-trip; el bloqueo nace activo", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r1 = call({ action: "crearBloqueo", session, desde: "2026-08-01", hasta: "2026-08-15", motivo: "VACACIONES" }, deps);
  assert.equal(r1.ok, true);
  assert.ok(r1.id);
  const r2 = call({ action: "misBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.bloqueos.length, 1);
  assert.equal(r2.bloqueos[0].motivo, "VACACIONES");
  assert.equal(r2.bloqueos[0].activo, true);
});

test("misBloqueos solo devuelve los del propio residente (session.sub), nunca ajenos", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  // bloqueo de otro residente insertado directamente en el almacén
  deps.store.appendRecord("bloqueos", { residenteId: "otro-residente", desde: "2026-08-01", hasta: "2026-08-05", motivo: "VACACIONES", activo: true });
  call({ action: "crearBloqueo", session, desde: "2026-08-10", hasta: "2026-08-12", motivo: "ROTACION", provincia: "Valencia" }, deps);
  const r = call({ action: "misBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r.bloqueos.length, 1);
  assert.equal(r.bloqueos[0].residenteId, "uuid-ana");
});

test("misBloqueos filtra por solape con el mes pedido (no por fecha exacta de inicio)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  // bloqueo que empieza en julio y termina en agosto: debe aparecer en AMBOS meses
  call({ action: "crearBloqueo", session, desde: "2026-07-28", hasta: "2026-08-03", motivo: "VACACIONES" }, deps);
  const julio = call({ action: "misBloqueos", session, anio: 2026, mes: 7 }, deps);
  const agosto = call({ action: "misBloqueos", session, anio: 2026, mes: 8 }, deps);
  const septiembre = call({ action: "misBloqueos", session, anio: 2026, mes: 9 }, deps);
  assert.equal(julio.bloqueos.length, 1);
  assert.equal(agosto.bloqueos.length, 1);
  assert.equal(septiembre.bloqueos.length, 0);
});

test("cancelarBloqueo lo excluye de misBloqueos sin borrar la fila original (append-only)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const { id } = call({ action: "crearBloqueo", session, desde: "2026-08-01", hasta: "2026-08-10", motivo: "VACACIONES" }, deps);
  let r = call({ action: "misBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r.bloqueos.length, 1);

  const c = call({ action: "cancelarBloqueo", session, id }, deps);
  assert.equal(c.ok, true);

  r = call({ action: "misBloqueos", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r.bloqueos.length, 0); // ya no aparece como activo

  // pero la fila original sigue en el almacén crudo (historial sagrado)
  const crudo = deps.store.readRecords("bloqueos");
  assert.ok(crudo.some((b) => b.id === id && b.activo === true));
  assert.ok(crudo.some((b) => b.id === id && b.activo === false));
});

test("cancelarBloqueo de un id ajeno se rechaza (no se puede cancelar el bloqueo de otro)", () => {
  const deps = makeDeps();
  const ajenoId = deps.store.appendRecord("bloqueos", { residenteId: "otro-residente", desde: "2026-08-01", hasta: "2026-08-05", motivo: "VACACIONES", activo: true });
  const session = loggedIn(deps);
  const r = call({ action: "cancelarBloqueo", session, id: ajenoId }, deps);
  assert.equal(r.ok, false);
});

test("crearBloqueo valida motivo y rango de fechas", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(call({ action: "crearBloqueo", session, desde: "2026-08-10", hasta: "2026-08-01", motivo: "VACACIONES" }, deps).ok, false); // hasta < desde
  assert.equal(call({ action: "crearBloqueo", session, desde: "2026-08-01", hasta: "2026-08-10", motivo: "INVENTADO" }, deps).ok, false); // motivo inválido
});

test("crearBloqueo, misBloqueos y cancelarBloqueo requieren sesión", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "crearBloqueo", desde: "2026-08-01", hasta: "2026-08-10", motivo: "VACACIONES" }, deps).ok, false);
  assert.equal(call({ action: "misBloqueos", anio: 2026, mes: 8 }, deps).ok, false);
  assert.equal(call({ action: "cancelarBloqueo", id: "x" }, deps).ok, false);
});

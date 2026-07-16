// Tests de las acciones CRUD del router (Fase 3.0): altaResidente, listResidentes,
// listAsignaciones, guardarAsignaciones, misPreferencias, guardarPreferencias.
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
    asignaciones: [headerOf(TABLES.asignaciones)],
    preferencias: [headerOf(TABLES.preferencias)],
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

// ── altaResidente ──
test("altaResidente crea el registro y devuelve sesión (auto-registro, sin sesión previa)", () => {
  const deps = makeDeps();
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "nuevo@gmail.com", email_verified: "true", exp: String(2_000_000), nonce });
  const r = call({ action: "altaResidente", idToken: "jwt", nombre: "Nuevo R1", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, true);
  assert.ok(r.session);
  assert.equal(r.residente.nombre, "Nuevo R1");
  const guardado = deps.store.readRecords("residentes").find((x) => x.email === "nuevo@gmail.com");
  assert.equal(guardado.fechaInicio, "2026-05-25");
});

test("altaResidente rechaza un email ya vinculado (evita duplicados)", () => {
  const deps = makeDeps(); // fetchTokeninfo por defecto usa ana@gmail.com, ya existe
  call({ action: "getNonce" }, deps); // registra el nonce que el fetchTokeninfo por defecto reutiliza
  const r = call({ action: "altaResidente", idToken: "jwt", nombre: "Ana Otra Vez", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /ya existe|vinculad/i);
});

test("altaResidente valida campos obligatorios", () => {
  const deps = makeDeps({ fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "x@gmail.com", email_verified: "true", exp: String(2_000_000) }) });
  const r = call({ action: "altaResidente", idToken: "jwt", nombre: "", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, false);
});

test("altaResidente acepta un pendingToken de un login fallido, sin volver a verificar con Google (evita un segundo popup)", () => {
  const deps = makeDeps({ fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "nuevo2@gmail.com", email_verified: "true", exp: String(2_000_000) }) });
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "nuevo2@gmail.com", email_verified: "true", exp: String(2_000_000), nonce });
  const fallo = call({ action: "login", idToken: "jwt", nonce }, deps);
  assert.equal(fallo.ok, false);
  assert.ok(fallo.pendingToken);

  // segunda llamada SIN idToken, solo con el pendingToken de la primera
  const r = call({ action: "altaResidente", pendingToken: fallo.pendingToken, nombre: "Nuevo Dos", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, true);
  assert.equal(deps.store.readRecords("residentes").find((x) => x.email === "nuevo2@gmail.com").nombre, "Nuevo Dos");
});

test("altaResidente rechaza un pendingToken caducado o manipulado", () => {
  const deps = makeDeps();
  const r = call({ action: "altaResidente", pendingToken: "firma.falsa", nombre: "X", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, false);
});

test("altaResidente con aud incorrecta se rechaza (misma protección que login)", () => {
  const deps = makeDeps({ fetchTokeninfo: () => ({ aud: "otra.apps.googleusercontent.com", iss: "https://accounts.google.com", email: "x@gmail.com", email_verified: "true", exp: String(2_000_000) }) });
  const r = call({ action: "altaResidente", idToken: "jwt", nombre: "X", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /aud/i);
});

// ── listResidentes ──
test("listResidentes requiere sesión", () => {
  const r = call({ action: "listResidentes" }, makeDeps());
  assert.equal(r.ok, false);
});

test("listResidentes devuelve la lista con sesión válida", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "listResidentes", session }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.residentes.length, 1);
  assert.equal(r.residentes[0].nombre, "Ana");
});

// ── asignaciones ──
test("guardarAsignaciones (batch) y listAsignaciones reflejan el estado actual", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r1 = call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "G" },
    { fecha: "2026-06-07", residenteId: "uuid-ana", codigo: "GF" },
  ] }, deps);
  assert.equal(r1.ok, true);
  const r2 = call({ action: "listAsignaciones", session, anio: 2026, mes: 6 }, deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.asignaciones.length, 2);
});

test("guardarAsignaciones: una reedición del mismo día es la que prevalece (última gana)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "G" }] }, deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "GP" }] }, deps);
  const r = call({ action: "listAsignaciones", session, anio: 2026, mes: 6 }, deps);
  assert.equal(r.asignaciones.length, 1);
  assert.equal(r.asignaciones[0].codigo, "GP");
});

test("guardarAsignaciones con código vacío borra la celda (arregla el bug del v1)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "G" }] }, deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "uuid-ana", codigo: "" }] }, deps);
  const r = call({ action: "listAsignaciones", session, anio: 2026, mes: 6 }, deps);
  assert.equal(r.asignaciones.length, 0);
});

test("listAsignaciones filtra por mes/año (fecha fuera del mes no aparece)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2026-06-30", residenteId: "uuid-ana", codigo: "G" },
    { fecha: "2026-07-01", residenteId: "uuid-ana", codigo: "G" },
  ] }, deps);
  const junio = call({ action: "listAsignaciones", session, anio: 2026, mes: 6 }, deps);
  assert.equal(junio.asignaciones.length, 1);
  assert.equal(junio.asignaciones[0].fecha, "2026-06-30");
});

test("guardarAsignaciones requiere sesión", () => {
  const r = call({ action: "guardarAsignaciones", cambios: [{ fecha: "2026-06-05", residenteId: "x", codigo: "G" }] }, makeDeps());
  assert.equal(r.ok, false);
});

// ── preferencias ──
test("misPreferencias devuelve null si no hay registro previo", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "misPreferencias", session, anio: 2026, mes: 7 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.prefs, null);
});

test("guardarPreferencias y misPreferencias hacen round-trip; solo afecta al propio residente", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const prefs = { maxGuardias: 5, preferDobles: true, fechasPreferidas: ["2026-07-17"], fechasEvitar: ["2026-07-06"], notas: "ninguna" };
  const r1 = call({ action: "guardarPreferencias", session, anio: 2026, mes: 7, prefs }, deps);
  assert.equal(r1.ok, true);
  const r2 = call({ action: "misPreferencias", session, anio: 2026, mes: 7 }, deps);
  assert.equal(r2.prefs.maxGuardias, 5);
  assert.deepEqual(r2.prefs.fechasPreferidas, ["2026-07-17"]);
  // otro mes no ve estas preferencias
  const r3 = call({ action: "misPreferencias", session, anio: 2026, mes: 8 }, deps);
  assert.equal(r3.prefs, null);
});

test("guardarPreferencias dos veces: la segunda sobreescribe (última gana)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarPreferencias", session, anio: 2026, mes: 7, prefs: { maxGuardias: 4 } }, deps);
  call({ action: "guardarPreferencias", session, anio: 2026, mes: 7, prefs: { maxGuardias: 6 } }, deps);
  const r = call({ action: "misPreferencias", session, anio: 2026, mes: 7 }, deps);
  assert.equal(r.prefs.maxGuardias, 6);
});

test("misPreferencias/guardarPreferencias requieren sesión", () => {
  assert.equal(call({ action: "misPreferencias", anio: 2026, mes: 7 }, makeDeps()).ok, false);
  assert.equal(call({ action: "guardarPreferencias", anio: 2026, mes: 7, prefs: {} }, makeDeps()).ok, false);
});

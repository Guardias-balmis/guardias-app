// Tests de autorización del router: qué NO puede hacer un token que no es una sesión de
// residente, y qué campos de una escritura NO puede elegir el cliente.
//
// Por qué existen: el endpoint es ANYONE_ANONYMOUS y el GOOGLE_CLIENT_ID es público (vive en
// client/config.js, en GitHub Pages), así que conseguir un ID token de Google válido es abrir la
// web y pulsar Login con cualquier cuenta. Si el email no está vinculado a ningún residente, el
// servidor devuelve un `pendingToken` para poder completar el alta sin repetir el popup de
// Google — y ese token va firmado con EL MISMO secreto que una sesión. Sin la comprobación de
// `sub` en `authed`, valía como sesión completa: leer el equipo entero, escribir bloqueos y
// preferencias, y revertir un mes VALIDADO a BORRADOR.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { eligibleCandidates, resolveMethod, drawResponsible, validateResponsible } from "../../v2/domain/responsible.js";

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

// ANA está vinculada; INTRUSA tiene cuenta de Google verificada pero NO es residente.
const ANA = { id: "uuid-ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const PEQUE = { id: "uuid-r1", nombre: "Iván", email: "r1@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }; // R2 el 2027-07-16 → PEQUENO
let idCounter = 0;
function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, PEQUE].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    voluntariosResponsable: [headerOf(TABLES.voluntariosResponsable)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    preferencias: [headerOf(TABLES.preferencias)],
    bloqueos: [headerOf(TABLES.bloqueos)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    sorteos: [headerOf(TABLES.sorteos)],
  });
  const emails = new Set(["ana@gmail.com", "r1@gmail.com"]);
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto, ss, emails,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: { parseISO, canEdit, stateAfterEdit, groupOnDate, eligibleCandidates, resolveMethod, drawResponsible, validateResponsible },
    newSeed: () => "semilla-fija", // el sorteo es puro dado (candidatos, semilla): fijarla lo hace reproducible
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: String(idToken).split("|")[1] || "ana@gmail.com",
      email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
    ...overrides,
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loginComo(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: `jwt|${email}`, nonce }, deps);
}

test("un email de Google NO vinculado recibe pendingToken, no sesión (situación de partida)", () => {
  const deps = makeDeps();
  const r = loginComo(deps, "intrusa@gmail.com");
  assert.equal(r.ok, false);
  assert.ok(r.pendingToken, "el flujo de alta necesita el pendingToken");
  assert.equal(r.session, undefined);
});

test("el pendingToken NO sirve como sesión: ni lecturas, ni escrituras, ni whoami", () => {
  const deps = makeDeps();
  const pendingToken = loginComo(deps, "intrusa@gmail.com").pendingToken;

  const lecturas = [
    { action: "listResidentes" },
    { action: "listBloqueos", anio: 2027, mes: 7 },
    { action: "listAsignaciones", anio: 2027, mes: 7 },
    { action: "whoami" },
  ];
  for (const l of lecturas) {
    const r = call({ ...l, session: pendingToken }, deps);
    assert.equal(r.ok, false, `${l.action} no puede responder a un pendingToken`);
    assert.match(r.error, /no identifica a ningún residente/);
    assert.equal(r.residentes, undefined);
    assert.equal(r.bloqueos, undefined);
  }

  const escrituras = [
    { action: "crearBloqueo", desde: "2027-08-01", hasta: "2027-08-15", motivo: "VACACIONES" },
    { action: "guardarPreferencias", anio: 2027, mes: 8, prefs: { notas: "x" } },
    { action: "guardarAsignaciones", cambios: [{ fecha: "2027-08-03", residenteId: "uuid-ana", codigo: "G" }] },
  ];
  for (const e of escrituras) {
    assert.equal(call({ ...e, session: pendingToken }, deps).ok, false, `${e.action} no puede escribir con un pendingToken`);
  }
  // Y no ha quedado NADA escrito: el modelo es append-only, una fila colada no se borra.
  assert.equal(deps.store.readRecords("bloqueos").length, 0);
  assert.equal(deps.store.readRecords("preferencias").length, 0);
  assert.equal(deps.store.readRecords("asignaciones").length, 0);
});

test("el pendingToken SÍ sigue sirviendo para el alta autoservicio (DoD-1, no se rompe el flujo)", () => {
  const deps = makeDeps();
  const pendingToken = loginComo(deps, "nueva@gmail.com").pendingToken;
  const r = call({ action: "altaResidente", pendingToken, nombre: "Nueva", fechaInicio: "2027-05-26", fechaFin: "2031-05-25" }, deps);
  assert.equal(r.ok, true);
  assert.ok(r.session, "el alta devuelve una sesión de verdad");
  assert.equal(call({ action: "whoami", session: r.session }, deps).ok, true);
});

test("guardarPreferencias ignora residenteId, anio/mes e id que mande el cliente", () => {
  const deps = makeDeps();
  const session = loginComo(deps, "r1@gmail.com").session; // Iván
  const r = call({
    action: "guardarPreferencias", session, anio: 2027, mes: 8,
    prefs: { residenteId: "uuid-ana", anio: 1999, mes: 1, id: "id-falsificado", notas: "mías", maxGuardias: 5 },
  }, deps);
  assert.equal(r.ok, true);
  const filas = deps.store.readRecords("preferencias");
  assert.equal(filas.length, 1);
  assert.equal(filas[0].residenteId, "uuid-r1", "la fila es de quien la escribe, no de quien diga el cliente");
  assert.equal(filas[0].anio, 2027);
  assert.equal(filas[0].mes, 8);
  assert.notEqual(filas[0].id, "id-falsificado", "el id lo genera el store, no el cliente");
  assert.equal(filas[0].notas, "mías");
  assert.equal(filas[0].maxGuardias, 5);
});

test("guardarPreferencias rechaza mes/anio inválidos (la tabla es append-only: lo que entra se queda)", () => {
  const deps = makeDeps();
  const session = loginComo(deps, "ana@gmail.com").session;
  assert.equal(call({ action: "guardarPreferencias", session, anio: 2027, mes: 13, prefs: { notas: "x" } }, deps).ok, false);
  assert.equal(call({ action: "guardarPreferencias", session, anio: 1999, mes: 1, prefs: { notas: "x" } }, deps).ok, false);
  assert.equal(deps.store.readRecords("preferencias").length, 0);
});

test("ejecutarSorteoResponsable exige el permiso del ciclo: un Pequeño no quema el mandato de un año", () => {
  const deps = makeDeps(); // sin mandato vigente
  const session = loginComo(deps, "r1@gmail.com").session; // Iván: R2 en 2027-07-16 → PEQUENO
  const r = call({ action: "ejecutarSorteoResponsable", session, anio: 2028 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo un R3 o R4/);
  assert.equal(deps.store.readRecords("responsables").length, 0, "no se ha escrito ningún mandato");
});

test("ejecutarSorteoResponsable sí lo puede lanzar un Mayor cuando no hay Responsable (V-16)", () => {
  const deps = makeDeps();
  const session = loginComo(deps, "ana@gmail.com").session; // Ana: R4 en 2027-07-16 → MAYOR
  // El mandato 2027 exige ser R3 el 2027-01-01: Ana lo era (R3 2026-05-27..2027-05-26).
  const r = call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(deps.store.readRecords("responsables").length, 1);
});

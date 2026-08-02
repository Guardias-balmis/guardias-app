// Tests de listBloqueos — a diferencia de misBloqueos (alcance al propio residente, para la
// pantalla de Preferencias), esta acción devuelve los bloqueos ACTIVOS de TODOS los
// residentes en un mes: lo necesita el validador de CalendarScreen (INV-5/6/7 dependen de
// los bloqueos del equipo entero, no solo de quien pulsa "Validar").
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { groupOnDate } from "../../v2/domain/residents.js";

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
    festivos: [headerOf(TABLES.festivos)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    // parseISO/groupOnDate: las acciones de festivos validan fechas y piden permiso de Mayor.
    domain: { absences, parseISO, groupOnDate },
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

// listBloqueosRango: mismo alcance (todo el equipo) pero por rango de fechas, porque los
// cierres de equidad de INV-3 descuentan las BAJAS de todo el trimestre o del año de
// residencia, no solo las que solapan el mes validado (P-8, decisión V-13).

test("listBloqueosRango devuelve los que solapan el rango, cruzando meses", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  deps.store.appendRecord("bloqueos", { residenteId: "uuid-ana", desde: "2026-09-20", hasta: "2026-10-15", motivo: "BAJA", activo: true });
  deps.store.appendRecord("bloqueos", { residenteId: "otro-residente", desde: "2026-12-01", hasta: "2026-12-10", motivo: "VACACIONES", activo: true });
  const r = call({ action: "listBloqueosRango", session, desde: "2026-09-01", hasta: "2026-11-30" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.bloqueos.length, 1); // el de diciembre queda fuera del trimestre
  assert.equal(r.bloqueos[0].motivo, "BAJA");
});

test("listBloqueosRango excluye los cancelados y valida el rango", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = deps.store.appendRecord("bloqueos", { residenteId: "uuid-ana", desde: "2026-09-20", hasta: "2026-10-15", motivo: "BAJA", activo: true });
  deps.store.appendRecord("bloqueos", { id, residenteId: "uuid-ana", desde: "2026-09-20", hasta: "2026-10-15", motivo: "BAJA", activo: false });
  assert.equal(call({ action: "listBloqueosRango", session, desde: "2026-09-01", hasta: "2026-11-30" }, deps).bloqueos.length, 0);
  assert.equal(call({ action: "listBloqueosRango", session, desde: "2026-11-30", hasta: "2026-09-01" }, deps).ok, false);
  assert.equal(call({ action: "listBloqueosRango", session, desde: "2026-09-01" }, deps).ok, false);
});

test("listBloqueosRango requiere sesión", () => {
  const r = call({ action: "listBloqueosRango", desde: "2026-09-01", hasta: "2026-11-30" }, makeDeps());
  assert.equal(r.ok, false);
});


// --- Festivos: dato de entrada (S-4), carga en lote y anulación por reinserción ---------------
// ANA es R4 el 2027-07-16 (alta 2024-05-27) → MAYOR, y no hay mandato vigente, así que puede
// cargarlos por V-16. Un Pequeño no podría.

test("crearFestivos carga un lote y listFestivosRango los devuelve por rango", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "crearFestivos", session, festivos: [
    { fecha: "2026-12-25", nombre: "Navidad", ambito: "NACIONAL" },
    { fecha: "2026-12-08", nombre: "Inmaculada", ambito: "NACIONAL" },
    { fecha: "2027-01-06", nombre: "Reyes", ambito: "NACIONAL" },
  ] }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.cargados, 3);

  const dic = call({ action: "listFestivosRango", session, desde: "2026-12-01", hasta: "2026-12-31" }, deps);
  assert.deepEqual(dic.festivos.map((f) => f.fecha).sort(), ["2026-12-08", "2026-12-25"]);
  assert.equal(dic.festivos[0].nombre.length > 0, true, "el nombre viaja para poder mostrarlo");

  const cruzando = call({ action: "listFestivosRango", session, desde: "2026-12-24", hasta: "2027-01-07" }, deps);
  assert.deepEqual(cruzando.festivos.map((f) => f.fecha).sort(), ["2026-12-25", "2027-01-06"]);
});

test("crearFestivos rechaza el lote entero si una fecha no es ISO (la tabla no se reescribe)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-12-25" }, { fecha: "25/12/2026" }] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fecha inválida/);
  assert.equal(deps.store.readRecords("festivos").length, 0, "no se cuela ninguna fila del lote");
});

test("anularFestivo reinserta con activo=false y deja de aparecer (jamás borra la fila)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-12-24", nombre: "mal cargado" }] }, deps).ids[0];
  assert.equal(call({ action: "listFestivosRango", session, desde: "2026-12-01", hasta: "2026-12-31" }, deps).festivos.length, 1);

  assert.equal(call({ action: "anularFestivo", session, id }, deps).ok, true);
  assert.equal(call({ action: "listFestivosRango", session, desde: "2026-12-01", hasta: "2026-12-31" }, deps).festivos.length, 0);
  assert.equal(deps.store.readRecords("festivos").length, 2, "las dos filas siguen ahí: append-only");
});

test("listFestivosRango valida el rango de verdad (ISO, no orden lexicográfico)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(call({ action: "listFestivosRango", session, desde: "2026-12-31", hasta: "2026-12-01" }, deps).ok, false);
  assert.equal(call({ action: "listFestivosRango", session, desde: "2026-12-01", hasta: "31/12/2026" }, deps).ok, false);
  assert.equal(call({ action: "listFestivosRango", session, desde: "2026-12-01" }, deps).ok, false);
});

test("cargar o anular festivos exige ser Mayor: es dato compartido de todo el servicio", () => {
  const deps = makeDeps();
  deps.store.appendRecord("residentes", { id: "uuid-peque", nombre: "Pepa", email: "peque@gmail.com", fechaInicio: "2026-05-27", fechaFin: "2030-05-26" });
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "peque@gmail.com", email_verified: "true", sub: "g-2", exp: String(2_000_000), nonce: call({ action: "getNonce" }, deps).nonce });
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "peque@gmail.com", email_verified: "true", sub: "g-2", exp: String(2_000_000), nonce });
  const session = call({ action: "login", idToken: "jwt", nonce }, deps).session;
  const r = call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-12-25" }] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo un R3 o R4/);
  assert.equal(deps.store.readRecords("festivos").length, 0);
});

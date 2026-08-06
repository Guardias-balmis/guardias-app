// Tests del voluntariado del TERCER PUESTO (INV-8, decisión V-18): estadoVoluntariado3P,
// ofrecerse3P y retirarVoluntariado3P. Autoservicio puro —«será siempre voluntario»
// (normativa p.2)—, con la única condición del compromiso de permanencia de 4 meses, que se
// acepta explícitamente al apuntarse y se comprueba al intentar salir.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { thirdPostCommitmentEnd, canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES } from "../../v2/domain/thirdpost.js";

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
const BEA = { id: "uuid-bea", nombre: "Bea", email: "bea@gmail.com", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };
let idCounter = 0;

function makeDeps({ today = "2027-07-16", filas = [] } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, BEA].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P), ...filas.map((f) => recordToRow(TABLES.voluntarios3P, f))],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today,
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: { absences, parseISO, groupOnDate, thirdPostCommitmentEnd, canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: /bea/.test(idToken) ? "bea@gmail.com" : "ana@gmail.com",
      email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps, quien = "ana") {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: `jwt-${quien}`, nonce }, deps).session;
}

test("estadoVoluntariado3P: de partida no hay nadie apuntado y `mio` es null", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "estadoVoluntariado3P", session }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.voluntarios, []);
  assert.equal(r.mio, null);
  assert.equal(r.permanenciaMeses, 4);
});

test("ofrecerse3P apunta al de la sesión con la fecha de HOY, y devuelve hasta cuándo se compromete", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const session = loggedIn(deps);
  const r = call({ action: "ofrecerse3P", session, compromisoAceptado: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.desde, "2027-07-16");
  assert.equal(r.compromisoHasta, "2027-11-15"); // 4 meses menos un día

  const estado = call({ action: "estadoVoluntariado3P", session }, deps);
  assert.deepEqual(estado.voluntarios, [{ residenteId: "uuid-ana", desde: "2027-07-16" }]);
  assert.deepEqual(estado.mio, { desde: "2027-07-16", compromisoHasta: "2027-11-15", puedoRetirarme: false });
});

test("ofrecerse3P SIN aceptar el compromiso se rechaza y no escribe nada", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(call({ action: "ofrecerse3P", session }, deps).ok, false);
  assert.equal(call({ action: "ofrecerse3P", session, compromisoAceptado: "sí" }, deps).ok, false, "solo vale el booleano");
  assert.deepEqual(call({ action: "estadoVoluntariado3P", session }, deps).voluntarios, []);
});

test("ofrecerse3P dos veces no reinicia el compromiso (sería la vía para esquivarlo al revés)", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const session = loggedIn(deps);
  call({ action: "ofrecerse3P", session, compromisoAceptado: true }, deps);
  deps.today = "2027-09-01";
  const r = call({ action: "ofrecerse3P", session, compromisoAceptado: true }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /ya estás apuntado/);
  assert.equal(call({ action: "estadoVoluntariado3P", session }, deps).mio.desde, "2027-07-16");
});

test("retirarVoluntariado3P se rechaza dentro de la permanencia, y el error dice hasta cuándo", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const session = loggedIn(deps);
  call({ action: "ofrecerse3P", session, compromisoAceptado: true }, deps);

  deps.today = "2027-11-15"; // último día del compromiso
  const r = call({ action: "retirarVoluntariado3P", session }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /2027-11-15/);
  assert.equal(call({ action: "estadoVoluntariado3P", session }, deps).voluntarios.length, 1);
});

test("retirarVoluntariado3P funciona al día siguiente de cumplirse, sin borrar la fila del alta", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const session = loggedIn(deps);
  call({ action: "ofrecerse3P", session, compromisoAceptado: true }, deps);

  deps.today = "2027-11-16";
  assert.equal(call({ action: "estadoVoluntariado3P", session }, deps).mio.puedoRetirarme, true);
  assert.equal(call({ action: "retirarVoluntariado3P", session }, deps).ok, true);

  const estado = call({ action: "estadoVoluntariado3P", session }, deps);
  assert.deepEqual(estado.voluntarios, []);
  assert.equal(estado.mio, null);
  // Append-only: la tabla conserva las DOS filas (alta y baja), nunca se reescribe. Y la de
  // baja deja escrito CUÁNDO se retiró, que si no se perdería.
  const filas = deps.ss.read("voluntarios3P");
  assert.equal(filas.length, 3); // cabecera + alta + baja
  const iHasta = filas[0].indexOf("hasta");
  assert.equal(String(filas[1][iHasta]).replace(/^'/, ""), "", "el alta no lleva hasta");
  assert.equal(String(filas[2][iHasta]).replace(/^'/, ""), "2027-11-16");
});

test("retirarVoluntariado3P de quien no está apuntado se rechaza", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "retirarVoluntariado3P", session }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /no estás apuntado/);
});

test("cada uno se apunta y se retira SOLO a sí mismo: la acción ignora cualquier residenteId del cliente", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const sAna = loggedIn(deps, "ana");
  call({ action: "ofrecerse3P", session: sAna, compromisoAceptado: true, residenteId: "uuid-bea" }, deps);
  assert.deepEqual(call({ action: "estadoVoluntariado3P", session: sAna }, deps).voluntarios, [{ residenteId: "uuid-ana", desde: "2027-07-16" }]);

  const sBea = loggedIn(deps, "bea");
  deps.today = "2028-01-01";
  assert.equal(call({ action: "retirarVoluntariado3P", session: sBea, residenteId: "uuid-ana" }, deps).ok, false, "Bea no puede sacar a Ana");
  assert.equal(call({ action: "estadoVoluntariado3P", session: sAna }, deps).voluntarios.length, 1);
});

test("cada residente ve la lista completa, pero `mio` es solo lo suyo", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const sAna = loggedIn(deps, "ana");
  call({ action: "ofrecerse3P", session: sAna, compromisoAceptado: true }, deps);
  const sBea = loggedIn(deps, "bea");
  const r = call({ action: "estadoVoluntariado3P", session: sBea }, deps);
  assert.equal(r.voluntarios.length, 1);
  assert.equal(r.mio, null);
});

test("las tres acciones exigen sesión: sin ella no se lee ni se escribe la lista", () => {
  const deps = makeDeps();
  for (const action of ["estadoVoluntariado3P", "ofrecerse3P", "retirarVoluntariado3P"]) {
    const r = call({ action, compromisoAceptado: true }, deps);
    assert.equal(r.ok, false, `${action} sin sesión`);
  }
  assert.equal(deps.ss.read("voluntarios3P").length, 1); // solo la cabecera
});

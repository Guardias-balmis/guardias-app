// Tests del tercer puesto MENSUAL (INV-8, P-16/V-55): `estadoVoluntariado3P` lee lo que INV-8 necesita
// de la respuesta mensual a «¿Deseas hacer tercer puesto este mes?» (`preferencias.tercerPuesto`).
// Ya no hay alta ni compromiso de permanencia: «será siempre voluntario» (normativa p.2) y se decide
// cada mes, así que aquí se comprueba quién ve qué y que nadie pueda responder por otro.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { thirdPostVolunteersFromPrefs } from "../../v2/domain/thirdpost.js";

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

function makeDeps({ today = "2027-07-16" } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, BEA].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    preferencias: [headerOf(TABLES.preferencias)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today,
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: { absences, parseISO, groupOnDate, thirdPostVolunteersFromPrefs },
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

const quiere = (deps, session, mes, anio, si = true) =>
  call({ action: "guardarPreferencias", session, anio, mes, prefs: { tercerPuesto: si } }, deps);

test("estadoVoluntariado3P: de partida nadie ha dicho que sí y `yo` es falso", () => {
  const deps = makeDeps();
  const r = call({ action: "estadoVoluntariado3P", session: loggedIn(deps) }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual([r.voluntarios, r.periodos, r.delMes, r.yo], [[], [], [], false]);
});

test("sin mes ni año pide el mes ACTUAL (deps.today)", () => {
  const deps = makeDeps({ today: "2027-07-16" });
  const sAna = loggedIn(deps);
  quiere(deps, sAna, 7, 2027);
  const r = call({ action: "estadoVoluntariado3P", session: sAna }, deps);
  assert.deepEqual([r.mes, r.anio, r.yo], [7, 2027, true]);
});

test("cada uno responde SOLO por sí mismo: guardarPreferencias ignora cualquier residenteId del cliente", () => {
  const deps = makeDeps();
  const sAna = loggedIn(deps, "ana");
  call({ action: "guardarPreferencias", session: sAna, anio: 2027, mes: 7, prefs: { tercerPuesto: true, residenteId: "uuid-bea" } }, deps);
  const sBea = loggedIn(deps, "bea");
  const r = call({ action: "estadoVoluntariado3P", session: sBea, mes: 7, anio: 2027 }, deps);
  assert.deepEqual(r.delMes, ["uuid-ana"]);
  assert.equal(r.yo, false, "Bea no ha dicho nada");
});

test("cada residente ve la lista completa del mes, pero `yo` es solo lo suyo", () => {
  const deps = makeDeps();
  quiere(deps, loggedIn(deps, "ana"), 7, 2027);
  const r = call({ action: "estadoVoluntariado3P", session: loggedIn(deps, "bea"), mes: 7, anio: 2027 }, deps);
  assert.equal(r.voluntarios.length, 1);
  assert.equal(r.yo, false);
});

test("cambiar de idea: la última respuesta del mes gana (append-only), y deja el historial", () => {
  const deps = makeDeps();
  const sAna = loggedIn(deps);
  quiere(deps, sAna, 7, 2027, true);
  quiere(deps, sAna, 7, 2027, false);
  assert.equal(call({ action: "estadoVoluntariado3P", session: sAna, mes: 7, anio: 2027 }, deps).yo, false);
  assert.equal(deps.store.readRecords("preferencias").length, 2, "las dos respuestas quedan escritas");
});

test("estadoVoluntariado3P exige sesión", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "estadoVoluntariado3P" }, deps).ok, false);
  assert.equal(deps.ss.read("preferencias").length, 1); // solo la cabecera
});

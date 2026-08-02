// Tests de las acciones del Responsable (Fase 5): estadoResponsable, ofrecerseResponsable,
// retirarVoluntariadoResponsable, ejecutarSorteoResponsable, listResponsables — y el rol
// 'responsable' derivado (spec.md INV-14, decisión Fase 5 sobre ≥2 voluntarios).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { eligibleCandidates, resolveMethod, drawResponsible, validateResponsible } from "../../v2/domain/responsible.js";
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

// Mismas fechas que v2/domain/test/responsible.test.js: A/B/C son R3 en 2027-01-01.
const A = { id: "r3a", nombre: "Ana", email: "a@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const B = { id: "r3b", nombre: "Bruno", email: "b@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const C = { id: "r3c", nombre: "Cris", email: "c@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const R2 = { id: "r2x", nombre: "Rita", email: "r2@gmail.com", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };

let idCounter = 0;
let seedCounter = 0;
function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[A, B, C, R2].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    voluntariosResponsable: [headerOf(TABLES.voluntariosResponsable)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2026-12-01",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    // groupOnDate: el sorteo pasa por requireCicloPermiso desde que escribe un mandato irreversible.
    domain: { absences, eligibleCandidates, resolveMethod, drawResponsible, validateResponsible, groupOnDate },
    newSeed: () => `semilla-${++seedCounter}`,
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => {
      const email = /:([^:]+)@/.test(idToken) ? idToken.split(":")[1] : "a@gmail.com";
      return { aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] };
    },
    ...overrides,
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("estadoResponsable: elegibles son solo los R3 en el periodo, sin voluntarios ni mandato aún", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  const r = call({ action: "estadoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.elegibles, ["r3a", "r3b", "r3c"]);
  assert.deepEqual(r.voluntarios, []);
  assert.equal(r.mandato, null);
});

test("ofrecerseResponsable: un R3 elegible se ofrece y aparece en estadoResponsable", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  const r = call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  const estado = call({ action: "estadoResponsable", session, anio: 2027 }, deps);
  assert.deepEqual(estado.voluntarios, ["r3a"]);
  assert.equal(estado.meHeOfrecido, true);
});

test("ofrecerseResponsable: rechaza a quien no es R3 en ese periodo", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "r2@gmail.com");
  const r = call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, false);
});

test("retirarVoluntariadoResponsable: deja de aparecer en estadoResponsable (append-only)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps);
  const r = call({ action: "retirarVoluntariadoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  const estado = call({ action: "estadoResponsable", session, anio: 2027 }, deps);
  assert.deepEqual(estado.voluntarios, []);
});

test("ejecutarSorteoResponsable: un único voluntario se asigna directo, sin sorteo", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "b@gmail.com");
  call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps);
  const r = call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mandato.metodo, "VOLUNTARIO");
  assert.equal(r.mandato.residenteId, "r3b");
  assert.equal(r.mandato.periodoInicio, "2027-01-01");
  assert.equal(r.mandato.periodoFin, "2028-01-01");
});

test("ejecutarSorteoResponsable: sin voluntarios, sortea entre todo el grupo de R3 y el resultado es reproducible", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  const r = call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mandato.metodo, "SORTEO");
  assert.deepEqual(r.mandato.candidatos, ["r3a", "r3b", "r3c"]);
  assert.ok(r.mandato.semilla);
  assert.equal(drawResponsible(r.mandato.candidatos, r.mandato.semilla), r.mandato.residenteId);
});

test("ejecutarSorteoResponsable: con ≥2 voluntarios, sortea SOLO entre ellos (decisión Fase 5)", () => {
  const deps = makeDeps();
  const sA = loggedInAs(deps, "a@gmail.com");
  call({ action: "ofrecerseResponsable", session: sA, anio: 2027 }, deps);
  const sC = loggedInAs(deps, "c@gmail.com");
  call({ action: "ofrecerseResponsable", session: sC, anio: 2027 }, deps);
  const r = call({ action: "ejecutarSorteoResponsable", session: sA, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mandato.metodo, "SORTEO");
  assert.deepEqual(r.mandato.candidatos, ["r3a", "r3c"]); // NO r3b, que no se ofreció
  assert.ok(["r3a", "r3c"].includes(r.mandato.residenteId));
});

test("ejecutarSorteoResponsable: no se puede volver a ejecutar si el periodo ya está decidido", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  const r2 = call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  assert.equal(r2.ok, false);
});

test("ofrecerseResponsable y retirarVoluntariadoResponsable se rechazan si el mandato ya está decidido", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  assert.equal(call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "retirarVoluntariadoResponsable", session, anio: 2027 }, deps).ok, false);
});

test("listResponsables devuelve el historial (última reinserción gana por periodo)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "a@gmail.com");
  call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  const r = call({ action: "listResponsables", session }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mandatos.length, 1);
  assert.equal(r.mandatos[0].periodoInicio, "2027-01-01");
});

test("el rol 'responsable' se deriva de la tabla responsables (whoami)", () => {
  const deps = makeDeps({ today: "2027-03-01" }); // dentro del mandato 2027-01-01..2028-01-01
  const session = loggedInAs(deps, "a@gmail.com");
  call({ action: "ejecutarSorteoResponsable", session, anio: 2027 }, deps);
  const ganadorEmail = { r3a: "a@gmail.com", r3b: "b@gmail.com", r3c: "c@gmail.com" };
  const mandato = call({ action: "listResponsables", session }, deps).mandatos[0];
  const sesionGanador = loggedInAs(deps, ganadorEmail[mandato.residenteId]);
  const who = call({ action: "whoami", session: sesionGanador }, deps);
  assert.equal(who.rol, "responsable");
});

test("acciones de Responsable requieren sesión", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "estadoResponsable", anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "ofrecerseResponsable", anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "ejecutarSorteoResponsable", anio: 2027 }, deps).ok, false);
});

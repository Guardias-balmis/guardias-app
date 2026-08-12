// Tests de Excepcion (INV-9, decisión V-29): degrada un 2×R2 documentado dentro de un rango de
// fechas. Hasta esta decisión, `validateMonth` ya sabía leer `ctx.excepciones` (con tests propios
// en v2/domain/test/validate.test.js) pero nada la escribía ni la pasaba: no había tabla, ni
// acción de router, ni wiring en `buildCuadranteCtx`. Aquí se comprueba la vía completa: fila en
// `excepciones` → `buildCuadranteCtx` → `marcarValidado` deja de avisar.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { absences } from "../../v2/domain/absences.js";
import { groupOnDate, levelOn, periodsOfResident } from "../../v2/domain/residents.js";
import { drawResponsible } from "../../v2/domain/responsible.js";
import { parseISO, addDays } from "../../v2/domain/calendar.js";
import { validateMonth, buildMonthContext, rotationHistoryStart } from "../../v2/domain/validate.js";
import { canValidate, canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import {
  validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart,
  yearCloseFestivosRange, validateQuarterClose, quarterCloseWindow,
} from "../../v2/domain/equity.js";
import { validateThirdPost, thirdPostHistoryStart } from "../../v2/domain/thirdpost.js";

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
// A 2026-12-01: ANA R3 (MAYOR), DAVID R4 (MAYOR), BRUNO y CARLA R2 (PEQUENO), EVA R1.
const ANA = { id: "ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-25", fechaFin: "2028-05-24" };
const DAVID = { id: "david", nombre: "David", email: "david@gmail.com", fechaInicio: "2023-05-25", fechaFin: "2027-05-24" };
const BRUNO = { id: "bruno", nombre: "Bruno", email: "bruno@gmail.com", fechaInicio: "2025-05-25", fechaFin: "2029-05-24" };
const CARLA = { id: "carla", nombre: "Carla", email: "carla@gmail.com", fechaInicio: "2025-05-25", fechaFin: "2029-05-24" };
const EVA = { id: "eva", nombre: "Eva", email: "eva@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" };
let idCounter = 0;

function makeDeps({ today = "2026-12-01" } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, DAVID, BRUNO, CARLA, EVA].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    eventos: [headerOf(TABLES.eventos)],
    excepciones: [headerOf(TABLES.excepciones)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    sorteos: [headerOf(TABLES.sorteos)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today,
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: {
      absences, groupOnDate, levelOn, periodsOfResident, drawResponsible,
      parseISO, addDays, validateMonth, buildMonthContext, rotationHistoryStart,
      canValidate, canEdit, stateAfterEdit,
      validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart,
      yearCloseFestivosRange, validateQuarterClose, quarterCloseWindow,
      validateThirdPost, thirdPostHistoryStart,
    },
    newSeed: () => "semilla-fija-para-el-test",
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: /eva/.test(idToken) ? "eva@gmail.com" : "ana@gmail.com",
      email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps, quien = "ana") {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: `jwt-${quien}`, nonce }, deps).session;
}
const crearExc = (deps, session, extra = {}) =>
  call({ action: "crearExcepcion", session, tipo: "2xR2", desde: "2026-12-01", hasta: "2026-12-31", justificacion: "mayores en rotación", ...extra }, deps);
const dosR2 = { cambios: [
  { fecha: "2026-12-19", residenteId: "bruno", codigo: "G" },
  { fecha: "2026-12-19", residenteId: "carla", codigo: "G" },
] };

test("crearExcepcion / listExcepciones hacen round-trip; nace activa", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(crearExc(deps, session).ok, true);
  const r = call({ action: "listExcepciones", session }, deps);
  assert.equal(r.excepciones.length, 1);
  assert.equal(r.excepciones[0].tipo, "2xR2");
  assert.equal(r.excepciones[0].justificacion, "mayores en rotación");
  assert.equal(r.excepciones[0].registradaPor, "ana");
});

test("crearExcepcion exige el permiso del ciclo y valida tipo, fechas y justificación", () => {
  const deps = makeDeps();
  const pequena = loggedIn(deps, "eva"); // R1: no es Mayor
  assert.match(crearExc(deps, pequena).error, /solo un R3 o R4/);

  const session = loggedIn(deps, "ana");
  assert.match(crearExc(deps, session, { tipo: "3xR2" }).error, /tipo de excepción inválido/);
  assert.match(crearExc(deps, session, { desde: "01/12/2026" }).error, /fecha inválida/);
  assert.match(crearExc(deps, session, { desde: "2026-12-31", hasta: "2026-12-01" }).error, /desde.*no puede ser posterior/);
  assert.match(crearExc(deps, session, { justificacion: "" }).error, /justificación/);
  assert.deepEqual(call({ action: "listExcepciones", session }, deps).excepciones, []);
});

test("anularExcepcion la saca de la lista sin borrar la fila (append-only)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearExc(deps, session).id;
  assert.equal(call({ action: "anularExcepcion", session, id }, deps).ok, true);
  assert.deepEqual(call({ action: "listExcepciones", session }, deps).excepciones, []);
  assert.equal(deps.ss.read("excepciones").length, 3); // cabecera + alta + anulación
});

test("sin excepción, un 2×R2 en diciembre avisa (INV-9)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, ...dosR2 }, deps);
  const r = call({ action: "marcarValidado", session, mes: 12, anio: 2026 }, deps);
  const i9 = r.violaciones.filter((v) => v.invariante === "INV-9");
  assert.equal(i9.length, 1);
  assert.equal(i9[0].severidad, "aviso");
});

test("Excepcion deja de estar MUDA: la fila de la tabla llega hasta marcarValidado y apaga INV-9", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  crearExc(deps, session);
  call({ action: "guardarAsignaciones", session, ...dosR2 }, deps);
  const r = call({ action: "marcarValidado", session, mes: 12, anio: 2026 }, deps);
  assert.deepEqual(r.violaciones.filter((v) => v.invariante === "INV-9"), []);
});

test("anular la excepción hace que INV-9 vuelva a avisar", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearExc(deps, session).id;
  call({ action: "anularExcepcion", session, id }, deps);
  call({ action: "guardarAsignaciones", session, ...dosR2 }, deps);
  const r = call({ action: "marcarValidado", session, mes: 12, anio: 2026 }, deps);
  assert.equal(r.violaciones.filter((v) => v.invariante === "INV-9").length, 1);
});

test("leer las excepciones está abierto a cualquier sesión: el validador y el generador las necesitan", () => {
  const deps = makeDeps();
  const pequena = loggedIn(deps, "eva");
  assert.equal(call({ action: "listExcepciones", session: pequena }, deps).ok, true);
});

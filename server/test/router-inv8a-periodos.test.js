// Test end-to-end de INV-8a "por fecha, no por estado actual" (decisión V-28): fila retirada de
// `voluntarios3P` → `allThirdPostPeriods` → `buildThirdPostCtx` → `marcarValidado`.
//
// Antes de V-28, `buildThirdPostCtx` solo pasaba a `validateThirdPost` los voluntarios ACTIVOS
// de HOY (`activeThirdPostVolunteers`, vía `readLatest`), así que un 3P legítimo de alguien ya
// retirado se marcaba en falso, y un 3P de antes de apuntarse dejaba de avisar. `readRecords`
// (crudo, sin colapsar) es lo que permite reconstruir el periodo cerrado que `readLatest` pierde.
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
// A 2026-12-01: ANA R3 (MAYOR), BRUNO R2 (PEQUENO).
const ANA = { id: "ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-25", fechaFin: "2028-05-24" };
const BRUNO = { id: "bruno", nombre: "Bruno", email: "bruno@gmail.com", fechaInicio: "2025-05-25", fechaFin: "2029-05-24" };
let idCounter = 0;

function makeDeps({ today = "2026-12-01", voluntarios3P = [] } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, BRUNO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    eventos: [headerOf(TABLES.eventos)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    sorteos: [headerOf(TABLES.sorteos)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P), ...voluntarios3P.map((f) => recordToRow(TABLES.voluntarios3P, f))],
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
    fetchTokeninfo: () => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: "ana@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt-ana", nonce }, deps).session;
}
const inv8a = (r) => r.violaciones.filter((v) => v.invariante === "INV-8" && /no consta en la lista/.test(v.detalle));

test("un 3P de julio de quien se retiró en diciembre NO avisa (era voluntario ESE día)", () => {
  const deps = makeDeps({
    voluntarios3P: [
      { residenteId: "bruno", desde: "2026-05-01", compromisoAceptado: true, activo: true },
      { residenteId: "bruno", desde: "2026-05-01", hasta: "2026-12-01", compromisoAceptado: true, activo: false },
    ],
  });
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-07-03", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2026 }, deps);
  assert.deepEqual(inv8a(r), []);
});

test("un 3P de junio de quien recién se apuntó en septiembre SÍ avisa (no era voluntario todavía)", () => {
  const deps = makeDeps({
    voluntarios3P: [{ residenteId: "bruno", desde: "2026-09-01", compromisoAceptado: true, activo: true }],
  });
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 6, anio: 2026 }, deps);
  const v = inv8a(r);
  assert.equal(v.length, 1);
  assert.equal(v[0].residenteId, "bruno");
});

test("dos periodos separados (se apuntó, se retiró, volvió a apuntarse): cada 3P se juzga contra SU tramo", () => {
  const deps = makeDeps({
    voluntarios3P: [
      { residenteId: "bruno", desde: "2026-01-01", compromisoAceptado: true, activo: true },
      { residenteId: "bruno", desde: "2026-01-01", hasta: "2026-03-31", compromisoAceptado: true, activo: false },
      { residenteId: "bruno", desde: "2026-08-01", compromisoAceptado: true, activo: true },
    ],
  });
  const session = loggedIn(deps);
  // Febrero: dentro del primer periodo → válido.
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-02-06", residenteId: "bruno", codigo: "3P" }] }, deps);
  assert.deepEqual(inv8a(call({ action: "marcarValidado", session, mes: 2, anio: 2026 }, deps)), []);
  // Mayo: en el hueco entre los dos periodos → avisa, aunque hoy (deps.today=2026-12-01) vuelva a ser voluntario.
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-05-04", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 5, anio: 2026 }, deps);
  assert.equal(inv8a(r).length, 1);
});

// Test end-to-end de INV-8a "por fecha, no por estado actual" (decisión V-28, reescrito para el
// modelo mensual de P-16/V-55): respuesta «sí» en `preferencias.tercerPuesto` → periodo de ESE mes →
// `buildThirdPostCtx` → `marcarValidado`.
//
// Antes de V-28, `buildThirdPostCtx` solo pasaba a `validateThirdPost` los voluntarios de HOY, así
// que un 3P legítimo de alguien que ya no lo era se marcaba en falso, y un 3P de antes de apuntarse
// dejaba de avisar. Con la pregunta mensual cada «sí» es un periodo de un mes, y el mes que se
// valida se juzga contra SU respuesta, no contra la de hoy.
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
import { validateThirdPost, thirdPostHistoryStart, thirdPostVolunteersFromPrefs } from "../../v2/domain/thirdpost.js";

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
const ANA = { id: "ana", nombre: "Ana", email: "quiquemm14@gmail.com", fechaInicio: "2024-05-25", fechaFin: "2028-05-24" };
const BRUNO = { id: "bruno", nombre: "Bruno", email: "bruno@gmail.com", fechaInicio: "2025-05-25", fechaFin: "2029-05-24" };
let idCounter = 0;

function makeDeps({ today = "2026-12-01", preferencias = [] } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, BRUNO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    eventos: [headerOf(TABLES.eventos)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    sorteos: [headerOf(TABLES.sorteos)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    preferencias: [headerOf(TABLES.preferencias), ...preferencias.map((f) => recordToRow(TABLES.preferencias, f))],
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
      validateThirdPost, thirdPostHistoryStart, thirdPostVolunteersFromPrefs,
    },
    newSeed: () => "semilla-fija-para-el-test",
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: "quiquemm14@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt-ana", nonce }, deps).session;
}
const inv8a = (r) => r.violaciones.filter((v) => v.invariante === "INV-8" && /no consta en la lista/.test(v.detalle));

const sí = (residenteId, anio, mes) => ({ residenteId, anio, mes, tercerPuesto: true });
const no = (residenteId, anio, mes) => ({ residenteId, anio, mes, tercerPuesto: false });

test("un 3P de julio de quien dijo «sí» en julio NO avisa aunque en diciembre ya dijera «no» (era voluntario ESE mes)", () => {
  const deps = makeDeps({ preferencias: [sí("bruno", 2026, 7), no("bruno", 2026, 12)] });
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-07-03", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2026 }, deps);
  assert.deepEqual(inv8a(r), []);
});

test("un 3P de junio de quien solo dijo «sí» en septiembre SÍ avisa (no era voluntario ese mes)", () => {
  const deps = makeDeps({ preferencias: [sí("bruno", 2026, 9)] });
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-06-05", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 6, anio: 2026 }, deps);
  const v = inv8a(r);
  assert.equal(v.length, 1);
  assert.equal(v[0].residenteId, "bruno");
});

test("meses alternos: cada 3P se juzga contra la respuesta de SU mes", () => {
  const deps = makeDeps({ preferencias: [sí("bruno", 2026, 2), no("bruno", 2026, 5), sí("bruno", 2026, 8)] });
  const session = loggedIn(deps);
  // Febrero: dijo «sí» → válido.
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-02-06", residenteId: "bruno", codigo: "3P" }] }, deps);
  assert.deepEqual(inv8a(call({ action: "marcarValidado", session, mes: 2, anio: 2026 }, deps)), []);
  // Mayo: dijo «no» → avisa, aunque en agosto vuelva a decir «sí».
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-05-04", residenteId: "bruno", codigo: "3P" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 5, anio: 2026 }, deps);
  assert.equal(inv8a(r).length, 1);
});

// Tests del ciclo de estados del Cuadrante (Fase 6.2, spec.md §2/§5, decisión V-9/V-10):
// estadoCuadrante, marcarValidado (solo Responsable, revalida en servidor), publicarCuadrante
// y despublicarCuadrante (solo Responsable), y guardarAsignaciones consciente del estado
// (bloquea PUBLICADO, revierte VALIDADO→BORRADOR al editar).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "../../v2/domain/validate.js";
import { validateThirdPost, thirdPostHistoryStart, thirdPostCommitmentEnd, canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES } from "../../v2/domain/thirdpost.js";
import { validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange, validateQuarterClose, quarterCloseWindow } from "../../v2/domain/equity.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { eligibleCandidates } from "../../v2/domain/responsible.js";
import { parseISO, academicYearOf, toISO } from "../../v2/domain/calendar.js";
import { canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { buildMonthSheetRows, buildResumenRows, buildContajeTrimestralRows } from "../../v2/domain/projection.js";

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

// RESP es Responsable en mandato (periodoInicio 2027-01-01..2028-01-01, cubre `today`); OTRO no.
const RESP = { id: "resp-1", nombre: "Rita", email: "resp@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const OTRO = { id: "otro-1", nombre: "Oscar", email: "otro@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

function makeDeps(overrides = {}, extraSheets = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "resp-1", metodo: "VOLUNTARIO" })],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P)],
    ...extraSheets,
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16", // dentro del mandato de RESP
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss, // expuesto para que los tests inspeccionen pestañas proyectadas (no lo usa el router)
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${nodeCrypto.randomUUID()}` }),
    // Subconjunto a mano de lo que Code.gs pasa entero (`deps.domain = Domain`): marcarValidado
    // comprueba el mes Y los dos cierres de equidad de INV-3 (trimestral y anual), así que cada
    // función del dominio que el router llame tiene que estar aquí o la acción falla por
    // TypeError — que es justo el fallo que este harness sirve para detectar antes que producción.
    domain: {
      absences,
      validateMonth, buildMonthContext, rotationHistoryStart, parseISO,
      validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange,
      validateQuarterClose, quarterCloseWindow,
      groupOnDate, eligibleCandidates,
      validateThirdPost, thirdPostHistoryStart, thirdPostCommitmentEnd, canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES,
      canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit,
      // La proyección son TRES hojas desde la Fase 7.2, y las dos agregadas necesitan el curso.
      buildMonthSheetRows, buildResumenRows, buildContajeTrimestralRows, academicYearOf, toISO,
    },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => {
      const email = /:([^:]+)@/.test(idToken) ? idToken.split(":")[1] : "resp@gmail.com";
      return { aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] };
    },
    ...overrides,
  };
}
// Deps con validateMonth reemplazado por un stub "cuadrante limpio" — construir un mes real
// que pase TODOS los invariantes (INV-1 exige cubrir cada día) es un problema combinatorio
// aparte del ciclo de estados que aquí se prueba; el propio validador ya está probado a fondo
// en v2/domain/test/validate.test.js.
function stubClean(deps) {
  return { ...deps, domain: { ...deps.domain, validateMonth: () => [] } };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("estadoCuadrante: sin filas previas, el estado por defecto es BORRADOR", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "BORRADOR");
});

test("marcarValidado: rechaza a quien no es Responsable", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("marcarValidado: el Responsable con un cuadrante sin errores lo pasa a VALIDADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("marcarValidado: revalida en el SERVIDOR (ignora lo que diga el cliente) — un mes vacío tiene errores reales de INV-1 y no se persiste", () => {
  const deps = makeDeps(); // domain.validateMonth REAL, sin stub
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "INV-1" && v.severidad === "error"));
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("marcarValidado: rechaza si el cuadrante ya está PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("publicarCuadrante: rechaza si el cuadrante todavía está en BORRADOR", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /VALIDADO/);
});

test("publicarCuadrante: rechaza a quien no es Responsable, aunque el cuadrante esté VALIDADO", () => {
  const deps = stubClean(makeDeps());
  const sResp = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session: sResp, mes: 7, anio: 2027 }, deps);
  const sOtro = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "publicarCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("publicarCuadrante: el Responsable pasa un cuadrante VALIDADO a PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "PUBLICADO");
});

test("publicarCuadrante: proyecta de verdad las TRES hojas al Sheet (Fase 7.1/7.2, V-11a y V-25)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  // Las dos agregadas llevan el CURSO en el nombre (V-25): julio-2027 es del curso 2027-28.
  assert.deepEqual(r.proyeccion, { mensual: "2027-07", resumen: "Resumen 2027-28", contaje: "Contaje Trimestral 2027-28" });

  const mensual = deps.ss.read("2027-07");
  assert.equal(mensual[0][0], "Residente");
  const filaRita = mensual.find((row) => row[0] === "Rita");
  assert.ok(filaRita, "la pestaña mensual debe incluir a Rita (RESP, activa en julio-2027)");
  assert.equal(filaRita.slice(9)[4], "G"); // día 5 (índice 4 tras las 9 columnas fijas): el código real cae en la columna correcta

  const resumen = deps.ss.read("Resumen 2027-28");
  assert.equal(resumen[0][0], "Residente");
  assert.ok(resumen.some((row) => row[0] === "Rita"));

  const contaje = deps.ss.read("Contaje Trimestral 2027-28");
  assert.equal(contaje[0][0], "Residente");
  assert.equal(contaje[0][2], "T1 jun-ago", "julio cae en T1 y la cabecera nombra los cuatro trimestres");
  assert.ok(contaje.some((row) => row[0] === "Rita"));
});

test("publicarCuadrante: una asignación de OTRO mes no se cuela en la pestaña publicada", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-08-05", residenteId: "resp-1", codigo: "GF" },
  ] }, deps);
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);

  const filaRita = deps.ss.read("2027-07").find((row) => row[0] === "Rita");
  assert.equal(filaRita.slice(9)[4], "G"); // 5-jul, dentro del mes publicado
  assert.ok(!filaRita.slice(9).includes("GF")); // el GF del 5-ago no aparece en la pestaña de julio
});

test("publicarCuadrante: publicar un segundo mes actualiza Resumen para incluir AMBOS meses", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  call({ action: "marcarValidado", session, mes: 8, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 8, anio: 2027 }, deps);

  assert.ok(deps.ss.exists("2027-07"));
  assert.ok(deps.ss.exists("2027-08"));
  const resumen = deps.ss.read("Resumen 2027-28");
  const filaResp = resumen.find((row) => row[0] === "Rita");
  assert.match(filaResp[2], /'2027-07'!/); // el Total de Resumen referencia AMBAS pestañas publicadas
  assert.match(filaResp[2], /'2027-08'!/);
  // Y las dos caen en T1 (jun-ago), así que la columna T1 del Contaje también las referencia.
  const filaContaje = deps.ss.read("Contaje Trimestral 2027-28").find((row) => row[0] === "Rita");
  assert.match(filaContaje[2], /'2027-07'!/);
  assert.match(filaContaje[2], /'2027-08'!/);
  assert.equal(filaContaje[3], 0, "T2 (sep-nov) no tiene ningún mes publicado todavía");
});

test("publicarCuadrante: si la proyección al Sheet falla, el cuadrante queda intacto en VALIDADO (nunca un PUBLICADO fantasma)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  deps.store.rebuildSheet = () => { throw new Error("fallo simulado de la API de Sheets"); };
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fallo simulado/);
  // estadoCuadrante no llama a rebuildSheet: comprobar el estado tras el fallo no necesita restaurarlo
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("publicarCuadrante: si falla la escritura de Resumen TRAS haber escrito ya la pestaña mensual, el cuadrante queda en VALIDADO (nunca fantasma) aunque la pestaña mensual quede con un adelanto", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const rebuildSheetReal = deps.store.rebuildSheet;
  deps.store.rebuildSheet = (name, rows) => {
    if (name.startsWith("Resumen")) throw new Error("fallo simulado al escribir Resumen");
    return rebuildSheetReal(name, rows);
  };
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fallo simulado al escribir Resumen/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
  assert.ok(deps.ss.exists("2027-07")); // ventana de desincronización aceptada: ver comentario de projectCuadranteToSheets
  assert.ok(!deps.ss.exists("Resumen 2027-28"));
  assert.ok(!deps.ss.exists("Contaje Trimestral 2027-28"), "el Contaje va DESPUÉS de Resumen: si Resumen falla, no se llega a escribir");
});

test("publicarCuadrante: tras un fallo parcial, reintentar Publicar sana del todo (ambas pestañas completas, sin residuo _tmp_)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const rebuildSheetReal = deps.store.rebuildSheet;
  let falla = true;
  deps.store.rebuildSheet = (name, rows) => {
    if (falla && name.startsWith("Resumen")) throw new Error("fallo simulado");
    return rebuildSheetReal(name, rows);
  };
  const primero = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(primero.ok, false);
  falla = false;
  const segundo = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps); // sigue VALIDADO: se puede reintentar
  assert.equal(segundo.ok, true);
  assert.equal(segundo.estado, "PUBLICADO");
  assert.ok(deps.ss.exists("2027-07"));
  assert.ok(deps.ss.exists("Resumen 2027-28"));
  assert.ok(deps.ss.exists("Contaje Trimestral 2027-28"), "el reintento tiene que sanar las TRES hojas, no solo las dos primeras");
  assert.ok(!deps.ss.listSheets().some((n) => n.startsWith("_tmp_")));
});

test("despublicarCuadrante: rechaza si no está PUBLICADO", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
});

test("despublicarCuadrante: rechaza a quien no es Responsable", () => {
  const deps = stubClean(makeDeps());
  const sResp = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session: sResp, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session: sResp, mes: 7, anio: 2027 }, deps);
  const sOtro = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "despublicarCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(call({ action: "estadoCuadrante", session: sOtro, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("despublicarCuadrante: el Responsable revierte PUBLICADO a VALIDADO (para corregir y republicar)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
});

test("despublicarCuadrante: NO toca ninguna pestaña proyectada del Sheet (decisión V-11b)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const mensualAntes = deps.ss.read("2027-07");
  const resumenAntes = deps.ss.read("Resumen");
  const r = call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(deps.ss.read("2027-07"), mensualAntes);
  assert.deepEqual(deps.ss.read("Resumen"), resumenAntes);
});

test("guardarAsignaciones: rechaza cualquier edición de un mes PUBLICADO", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /PUBLICADO/);
  const asigs = call({ action: "listAsignaciones", session, anio: 2027, mes: 7 }, deps);
  assert.deepEqual(asigs.asignaciones, []); // no se escribió nada
});

test("guardarAsignaciones: editar un mes VALIDADO lo revierte a BORRADOR automáticamente", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");

  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, true);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("guardarAsignaciones: editar un mes BORRADOR no cambia nada del ciclo de estados", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(r.ok, true);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("guardarAsignaciones: rechaza el lote entero (sin escribir nada) si una fecha no es una ISO válida", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" },
    { fecha: "no-es-una-fecha", residenteId: "resp-1", codigo: "G" },
  ] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fecha inválida/);
  const asigs = call({ action: "listAsignaciones", session, anio: 2027, mes: 7 }, deps);
  assert.deepEqual(asigs.asignaciones, []); // nada del lote se escribió, ni siquiera el cambio válido
});

test("acciones del ciclo de estados requieren sesión", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "estadoCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "marcarValidado", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "publicarCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "despublicarCuadrante", mes: 7, anio: 2027 }, deps).ok, false);
});

test("mes/anio inválidos se rechazan en las acciones del cuadrante", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 13, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "marcarValidado", session, mes: 0, anio: 2027 }, deps).ok, false);
  assert.equal(call({ action: "publicarCuadrante", session, mes: 7, anio: 99 }, deps).ok, false);
});

// --- Cierres de equidad de INV-3 al validar (P-8, decisión V-13) ----------------------------
// marcarValidado comprueba el mes Y los cierres que caen en él. Antes de P-8 el cierre anual
// estaba implementado en el dominio pero no lo invocaba nadie: la equidad de cierre no se
// comprobaba nunca en producción.
const guardar = (deps, session, cambios) => call({ action: "guardarAsignaciones", session, cambios }, deps);

test("marcarValidado: el cierre TRIMESTRAL incumplido avisa pero no impide validar", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  // T2-2027 (sep-nov): Rita 3 guardias computables, Óscar 1 → diferencia 2 en totales.
  guardar(deps, session, [
    { fecha: "2027-09-06", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-09-13", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-10-04", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-10-11", residenteId: "otro-1", codigo: "G" },
  ]);
  const r = call({ action: "marcarValidado", session, mes: 11, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
  const aviso = r.violaciones.find((v) => v.invariante === "INV-3" && v.severidad === "aviso");
  assert.ok(aviso, "el cierre de T2 debe aparecer como aviso");
  assert.match(aviso.detalle, /trimestre T2/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 11, anio: 2027 }, deps).estado, "VALIDADO");
});

test("marcarValidado: el cierre ANUAL incumplido AVISA y NO impide validar (decisión V-14)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  // Año de residencia 2027-05-27→2028-05-26 (el 4.º de ambos): Rita 3 guardias, Óscar ninguna.
  guardar(deps, session, [
    { fecha: "2027-06-07", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-06-14", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-06-21", residenteId: "resp-1", codigo: "G" },
  ]);
  const r = call({ action: "marcarValidado", session, mes: 5, anio: 2028 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "VALIDADO");
  assert.equal(r.violaciones.filter((v) => v.severidad === "error").length, 0, "la equidad no bloquea nunca");
  const aviso = r.violaciones.find((v) => v.invariante === "INV-3" && /año de residencia/.test(v.detalle));
  assert.ok(aviso, "el cierre anual debe aparecer como aviso");
  assert.equal(aviso.severidad, "aviso");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 5, anio: 2028 }, deps).estado, "VALIDADO");
});

// Fase 3 de V-17: el eje `puentesLibres` sale de la tabla `festivos` y su ventana es el año de
// residencia entero, que cruza dos años naturales. Antes de esto comparaba ceros siempre.
test("marcarValidado: el eje de puentes libres se deriva de la tabla `festivos` de DOS años", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  // Año de residencia 2027-05-27→2028-05-26. Con los festivos reales de esos dos años naturales
  // la ventana tiene tres puentes: el martes 7-dic-2027 (entre dos festivos), el lunes
  // 11-oct-2027 y el viernes 7-ene-2028. Ninguno cae en el mes que se valida (mayo-2028): si el
  // eje solo mirase el mes, como hacía antes de esta fase, los tres serían invisibles.
  call({ action: "crearFestivos", session, festivos: [
    { fecha: "2027-10-12", nombre: "Hispanidad" },
    { fecha: "2027-12-06", nombre: "Constitución" },
    { fecha: "2027-12-08", nombre: "Inmaculada" },
    { fecha: "2028-01-06", nombre: "Reyes" },
  ] }, deps);
  guardar(deps, session, [
    { fecha: "2027-10-11", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-12-07", residenteId: "resp-1", codigo: "G" },
  ]);

  const r = call({ action: "marcarValidado", session, mes: 5, anio: 2028 }, deps);
  assert.equal(r.ok, true, "la equidad nunca bloquea (V-14)");
  // Ya no aparece el aviso de "no hay festivos": el calendario está cargado y el eje se comprueba.
  assert.equal(r.violaciones.filter((v) => /no hay ningún festivo cargado/.test(v.detalle)).length, 0);
  // Rita se come dos de los tres puentes, Óscar ninguno → 1 vs 3, diferencia 2.
  const puentes = r.violaciones.filter((v) => /puentes libres/i.test(v.detalle));
  assert.equal(puentes.length, 1);
  assert.equal(puentes[0].severidad, "aviso");
  assert.match(puentes[0].detalle, /otro-1=3.*resp-1=1/);
});

test("marcarValidado: un mes que no cierra trimestre ni año no comprueba ningún cierre", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  guardar(deps, session, [
    { fecha: "2027-09-06", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-09-13", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-10-04", residenteId: "resp-1", codigo: "G" },
  ]);
  const r = call({ action: "marcarValidado", session, mes: 10, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.violaciones.filter((v) => v.invariante === "INV-3").length, 0);
});


// --- Permiso del ciclo sin Responsable designado (decisión V-16) -----------------------------
// La regla base sigue siendo "lo mueve el Responsable en mandato". Lo nuevo: si NADIE tiene el
// mandato vigente, el ciclo no se queda bloqueado — lo puede mover cualquier Mayor (R3/R4 hoy).
// `today` de estos tests es 2027-07-16, cuando RESP y OTRO (alta 2024-05-27) son R4.

/** Igual que makeDeps pero con la tabla de responsables VACÍA: nadie tiene el mandato. */
function makeDepsSinMandato() {
  const deps = makeDeps();
  const ss = deps.ss;
  ss.overwrite("responsables", [headerOf(TABLES.responsables)]);
  return deps;
}

test("V-16 sin mandato vigente: un Mayor puede validar aunque no sea Responsable", () => {
  const deps = stubClean(makeDepsSinMandato());
  const session = loggedInAs(deps, "otro@gmail.com"); // Óscar, R4 en 2027-07-16, sin mandato
  assert.equal(call({ action: "whoami", session }, deps).rol, "residente", "no se le llama Responsable");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("V-16 sin mandato vigente: un Pequeño NO puede validar", () => {
  const deps = stubClean(makeDepsSinMandato());
  deps.store.appendRecord("residentes", { id: "peque-1", nombre: "Pepa", email: "peque@gmail.com", fechaInicio: "2026-05-27", fechaFin: "2030-05-26" }); // R2 en 2027-07-16
  const session = loggedInAs(deps, "peque@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo un R3 o R4/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
});

test("V-16 sin mandato vigente: un Mayor también puede publicar y despublicar", () => {
  const deps = stubClean(makeDepsSinMandato());
  const session = loggedInAs(deps, "otro@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "otro-1", codigo: "G" }] }, deps);
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
  assert.equal(call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
});

test("V-16: CON mandato de otra persona, un Mayor sigue sin poder (la excepción es solo la ausencia)", () => {
  const deps = stubClean(makeDeps()); // el mandato 2027 es de resp-1
  const session = loggedInAs(deps, "otro@gmail.com"); // Óscar es R4, pero no es el titular
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo el Responsable/);
});

test("estadoCuadrante informa de si hay Responsable designado (lo usa el cliente para avisar)", () => {
  const conMandato = stubClean(makeDeps());
  const s1 = loggedInAs(conMandato, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session: s1, mes: 7, anio: 2027 }, conMandato).sinResponsable, false);

  const sinMandato = stubClean(makeDepsSinMandato());
  const s2 = loggedInAs(sinMandato, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session: s2, mes: 7, anio: 2027 }, sinMandato).sinResponsable, true);
});

test("estadoResponsable devuelve también el periodo SIGUIENTE (voluntariado abierto por adelantado)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "estadoResponsable", session, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.periodoInicio, "2027-01-01");
  assert.equal(r.siguiente.anio, 2028);
  assert.equal(r.siguiente.periodoInicio, "2028-01-01");
  assert.equal(r.siguiente.mandato, null); // sin decidir
  assert.deepEqual(r.siguiente.voluntarios, []);
  assert.equal(r.siguiente.meHeOfrecido, false);
});

// INV-8 (tercer puesto) en marcarValidado. Hasta la decisión V-18 estaba implementado y
// probado en el dominio desde la Fase 3 pero NO lo invocaba nadie, y le faltaba la tabla de
// voluntarios: con la lista vacía marcaba TODO 3P como no-voluntario, que es lo que impedía
// cablearlo. Las cuatro reglas son ahora aviso, así que ninguna impide validar.
test("marcarValidado: un 3P de quien no consta voluntario AVISA y no impide validar (INV-8a, V-18)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  guardar(deps, session, [{ fecha: "2027-07-14", residenteId: "otro-1", codigo: "3P" }]);

  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true, "INV-8 no bloquea nunca (V-18)");
  assert.equal(r.estado, "VALIDADO");
  const av = r.violaciones.filter((v) => v.invariante === "INV-8");
  assert.equal(av.length, 1);
  assert.equal(av[0].severidad, "aviso");
  assert.match(av[0].detalle, /no consta en la lista de voluntarios/);
});

test("marcarValidado: con el residente apuntado, ese mismo 3P deja de avisar", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  const suya = loggedInAs(deps, "otro@gmail.com");
  call({ action: "ofrecerse3P", session: suya, compromisoAceptado: true }, deps); // desde = deps.today, "2027-07-16"
  // La fecha del 3P tiene que ser DESDE el alta (decisión V-29, INV-8a juzga "¿era voluntario
  // ESE día?"): antes se aceptaba cualquier fecha del mes con tal de que hoy siguiera apuntado.
  guardar(deps, loggedInAs(deps, "resp@gmail.com"), [{ fecha: "2027-07-17", residenteId: "otro-1", codigo: "3P" }]);

  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violaciones.filter((v) => v.invariante === "INV-8"), []);
});

test("marcarValidado: el ciclo de INV-8b arranca en el alta del voluntario y cruza meses", () => {
  const deps = stubClean(makeDeps({ today: "2027-06-01" }));
  const suya = loggedInAs(deps, "otro@gmail.com");
  call({ action: "ofrecerse3P", session: suya, compromisoAceptado: true }, deps);
  // Dos miércoles: el de junio queda en el histórico y el de julio repite día sin cerrar ciclo.
  guardar(deps, suya, [
    { fecha: "2027-06-09", residenteId: "otro-1", codigo: "3P" },
    { fecha: "2027-07-14", residenteId: "otro-1", codigo: "3P" },
  ]);

  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  const av = r.violaciones.filter((v) => v.invariante === "INV-8");
  assert.equal(av.length, 1, "el 3P de junio tiene que llegar como histórico");
  assert.match(av[0].detalle, /repite X .* 2027-07-14/);
});

test("marcarValidado: el 3P del propio mes no se cuenta dos veces (histórico + mes)", () => {
  const deps = stubClean(makeDeps({ today: "2027-06-01" }));
  const suya = loggedInAs(deps, "otro@gmail.com");
  call({ action: "ofrecerse3P", session: suya, compromisoAceptado: true }, deps);
  // Un ÚNICO 3P, dentro del mes validado: si el histórico lo incluyera también, el ciclo vería
  // dos miércoles seguidos y avisaría de una repetición que no existe.
  guardar(deps, suya, [{ fecha: "2027-07-14", residenteId: "otro-1", codigo: "3P" }]);

  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.deepEqual(r.violaciones.filter((v) => v.invariante === "INV-8"), []);
});

test("marcarValidado: el ciclo de INV-8b arranca en el alta de CADA uno, no en el mínimo global", () => {
  // Reproduce el fallo que encontró la revisión adversarial. El histórico se lee desde el alta
  // MÁS ANTIGUA (hace falta entera para INV-8c), así que el recorte por residente tiene que
  // hacerlo el validador: sin él, el 3P que Óscar hizo en enero —antes de apuntarse— entraba en
  // su ciclo nuevo y avisaba de una repetición de lunes que no existe.
  const deps = stubClean(makeDeps({ today: "2027-01-02" }));
  const resp = loggedInAs(deps, "resp@gmail.com");
  call({ action: "ofrecerse3P", session: resp, compromisoAceptado: true }, deps); // alta antigua: 2027-01-02

  const suya = loggedInAs(deps, "otro@gmail.com");
  guardar(deps, suya, [{ fecha: "2027-01-04", residenteId: "otro-1", codigo: "3P" }]); // lunes, sin estar apuntado
  deps.today = "2027-06-01";
  call({ action: "ofrecerse3P", session: suya, compromisoAceptado: true }, deps);
  guardar(deps, suya, [{ fecha: "2027-07-05", residenteId: "otro-1", codigo: "3P" }]); // otro lunes, ya en su etapa

  deps.today = "2027-07-20";
  const r = call({ action: "marcarValidado", session: loggedInAs(deps, "resp@gmail.com"), mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.violaciones.filter((v) => v.invariante === "INV-8" && /repite/.test(v.detalle)), [],
    "el 3P de enero es anterior a su alta: no entra en su ciclo"
  );
});

// ── Ausencia con fecha ilegible ya escrita en el Sheet (decisión V-22) ──
// `crearBloqueo` ya no la deja entrar, pero el Sheet se edita a mano y las tablas son append-only:
// la fila puede estar ya ahí y no se va a borrar. Medido el 2026-08-02, antes de V-22, hacía una de
// dos cosas según por dónde ordenase la fecha mala, y las dos son peores que un error con nombre:
// desaparecer del rango de `absences` —que compara cadenas a propósito (V-19)— dejando INV-5 sin
// proteger EN SILENCIO, o tumbar `marcarValidado` con «Fecha ISO inválida» sin decir de qué fila.
const bloqueoRaw = (b) => [headerOf(TABLES.bloqueos), recordToRow(TABLES.bloqueos, b)];

test("una ausencia con fecha ilegible da un error INV-5 que la nombra, en vez de tumbar la validación", () => {
  const mala = { id: "b-mala", residenteId: "otro-1", desde: "2027-07-01", hasta: "30/02/2028", motivo: "BAJA", activo: true };
  const deps = stubClean(makeDeps({}, { bloqueos: bloqueoRaw(mala) }));
  const r = call({ action: "marcarValidado", session: loggedInAs(deps, "resp@gmail.com"), mes: 7, anio: 2027 }, deps);

  assert.equal(r.ok, false, "no se puede validar mientras la baja no se pueda comprobar");
  assert.equal(r.error, "el cuadrante tiene errores, no se puede validar");
  const v = r.violaciones.find((x) => /fecha ilegible/.test(x.detalle));
  assert.ok(v, `debía nombrar la fila; violaciones: ${JSON.stringify(r.violaciones)}`);
  assert.equal(v.invariante, "INV-5");
  assert.equal(v.severidad, "error");
  assert.equal(v.residenteId, "otro-1", "sin residenteId, violations.js no puede traducirlo a un nombre");
  assert.match(v.detalle, /BAJA/);          // de qué ausencia habla
  assert.match(v.detalle, /30\/02\/2028/);  // qué fecha está mal
  assert.match(v.detalle, /b-mala/);        // y el id, que es lo que hace falta para cancelarla
});

test("la fecha ilegible que ordena POR ENCIMA ya no desaparece: antes INV-5 no emitía nada", () => {
  // `desde="30/02/2027"` empieza por "3", así que `absences` la descartaba por `b.desde > hasta` y
  // la baja se volvía invisible: con guardias asignadas encima, INV-5 emitía CERO violaciones.
  const invisible = { id: "b-inv", residenteId: "otro-1", desde: "30/02/2027", hasta: "2027-07-31", motivo: "BAJA", activo: true };
  const deps = stubClean(makeDeps({}, { bloqueos: bloqueoRaw(invisible) }));
  const session = loggedInAs(deps, "resp@gmail.com");
  guardar(deps, session, [{ fecha: "2027-07-10", residenteId: "otro-1", codigo: "G" }]); // guardia sobre la baja

  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.violaciones.filter((v) => v.invariante === "INV-5").length, 1);

  // Y sigue siendo visible en la lista, que es la única forma de cancelarla desde la app. Aparece
  // en CUALQUIER mes a propósito: con la fecha ilegible no se sabe en cuál cae.
  for (const mes of [7, 11]) {
    const lista = call({ action: "listBloqueos", session, anio: 2027, mes }, deps).bloqueos;
    assert.ok(lista.some((b) => b.id === "b-inv"), `debía verse en el mes ${mes} para poder cancelarla`);
  }
});

test("cancelar la ausencia ilegible desbloquea la validación (la salida existe dentro de la app)", () => {
  const mala = { id: "b-mala", residenteId: "otro-1", desde: "2027-07-01", hasta: "30/02/2028", motivo: "BAJA", activo: true };
  const deps = stubClean(makeDeps({}, { bloqueos: bloqueoRaw(mala) }));
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps).ok, false);

  // Desde V-19 el permiso del ciclo alcanza a cancelar la ausencia de otro, así que esto lo puede
  // hacer quien valida — sin eso, el error sería un bloqueo sin salida y no podría ser `error`.
  assert.equal(call({ action: "cancelarBloqueo", session, id: "b-mala" }, deps).ok, true);
  assert.equal(call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps).ok, true);
});

test("la acción `validar` cambia el veredicto-a-suerte de INV-5 por el error que nombra la fila", () => {
  // `validateMonth` NO lanza por una fecha de bloqueo ilegible: todas sus comparaciones son de
  // cadenas. Lo que hacía era peor de explicar: con `hasta="no-es-fecha"` INV-5 emitía su
  // «Asignación G … sobre bloqueo BAJA» de puro accidente ("2" ordena antes que "n"), y con
  // `desde="30/02/…"` no emitía nada. Aquí se comprueba que ya no juzga la fila ilegible y que en
  // su lugar dice qué arreglar — que es lo que ve quien valida desde Calendar.jsx.
  const deps = makeDeps(); // validateMonth REAL, sin stub
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "validar", session, cuadrante: {
    mes: 7, anio: 2027, residentes: [OTRO],
    asignaciones: [{ residenteId: "otro-1", fecha: "2027-07-10", codigo: "G" }],
    bloqueos: [{ id: "b-x", residenteId: "otro-1", desde: "2027-07-01", hasta: "no-es-fecha", motivo: "BAJA", activo: true }],
  } }, deps);

  assert.equal(r.ok, true);
  const i5 = r.violaciones.filter((v) => v.invariante === "INV-5");
  assert.equal(i5.length, 1, `una sola violación de INV-5, la de la fila ilegible: ${JSON.stringify(i5)}`);
  assert.match(i5[0].detalle, /fecha ilegible/);
  assert.doesNotMatch(i5[0].detalle, /sobre bloqueo/, "no debe juzgar la asignación con una fecha que no se puede leer");
  assert.ok(r.bloqueantes >= 1);
});

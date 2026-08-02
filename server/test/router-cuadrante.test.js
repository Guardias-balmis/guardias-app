// Tests del ciclo de estados del Cuadrante (Fase 6.2, spec.md §2/§5, decisión V-9/V-10):
// estadoCuadrante, marcarValidado (solo Responsable, revalida en servidor), publicarCuadrante
// y despublicarCuadrante (solo Responsable), y guardarAsignaciones consciente del estado
// (bloquea PUBLICADO, revierte VALIDADO→BORRADOR al editar).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "../../v2/domain/validate.js";
import { validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange, validateQuarterClose, quarterCloseWindow } from "../../v2/domain/equity.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { eligibleCandidates } from "../../v2/domain/responsible.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { buildMonthSheetRows, buildResumenRows } from "../../v2/domain/projection.js";

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

function makeDeps(overrides = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "resp-1", metodo: "VOLUNTARIO" })],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)],
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
      validateMonth, buildMonthContext, rotationHistoryStart, parseISO,
      validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange,
      validateQuarterClose, quarterCloseWindow,
      groupOnDate, eligibleCandidates,
      canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit, buildMonthSheetRows, buildResumenRows,
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

test("publicarCuadrante: proyecta de verdad la pestaña mensual y la hoja Resumen al Sheet (Fase 7.1, V-11a)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-05", residenteId: "resp-1", codigo: "G" }] }, deps);
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.proyeccion, { mensual: "2027-07", resumen: "Resumen" });

  const mensual = deps.ss.read("2027-07");
  assert.equal(mensual[0][0], "Residente");
  const filaRita = mensual.find((row) => row[0] === "Rita");
  assert.ok(filaRita, "la pestaña mensual debe incluir a Rita (RESP, activa en julio-2027)");
  assert.equal(filaRita.slice(9)[4], "G"); // día 5 (índice 4 tras las 9 columnas fijas): el código real cae en la columna correcta

  const resumen = deps.ss.read("Resumen");
  assert.equal(resumen[0][0], "Residente");
  assert.ok(resumen.some((row) => row[0] === "Rita"));
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
  const resumen = deps.ss.read("Resumen");
  const filaResp = resumen.find((row) => row[0] === "Rita");
  assert.match(filaResp[2], /'2027-07'!/); // el Total de Resumen referencia AMBAS pestañas publicadas
  assert.match(filaResp[2], /'2027-08'!/);
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
    if (name === "Resumen") throw new Error("fallo simulado al escribir Resumen");
    return rebuildSheetReal(name, rows);
  };
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /fallo simulado al escribir Resumen/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
  assert.ok(deps.ss.exists("2027-07")); // ventana de desincronización aceptada: ver comentario de projectCuadranteToSheets
  assert.ok(!deps.ss.exists("Resumen"));
});

test("publicarCuadrante: tras un fallo parcial, reintentar Publicar sana del todo (ambas pestañas completas, sin residuo _tmp_)", () => {
  const deps = stubClean(makeDeps());
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const rebuildSheetReal = deps.store.rebuildSheet;
  let falla = true;
  deps.store.rebuildSheet = (name, rows) => {
    if (falla && name === "Resumen") throw new Error("fallo simulado");
    return rebuildSheetReal(name, rows);
  };
  const primero = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(primero.ok, false);
  falla = false;
  const segundo = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps); // sigue VALIDADO: se puede reintentar
  assert.equal(segundo.ok, true);
  assert.equal(segundo.estado, "PUBLICADO");
  assert.ok(deps.ss.exists("2027-07"));
  assert.ok(deps.ss.exists("Resumen"));
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

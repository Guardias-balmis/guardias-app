// Comprobar-y-escribir bajo el lock, idempotencia de las anulaciones y guardas de entrada
// (2026-09-04, hallazgos de la revisión adversarial).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "../../v2/domain/validate.js";
import { validateThirdPost, thirdPostHistoryStart } from "../../v2/domain/thirdpost.js";
import { groupOnDate, levelOn, periodsOfResident } from "../../v2/domain/residents.js";
import { parseISO, addDays, bridgesOfMonth, academicYearOf } from "../../v2/domain/calendar.js";
import { accumulatedTally } from "../../v2/domain/accumulate.js";
import { monthReplacementPlan, monthCompletionPlan } from "../../v2/domain/apply.js";
import { canEdit, canValidate, canPublish, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { quarterCloseWindow, validateQuarterClose, yearCloseHistoryStart, yearCloseFestivosRange, buildYearCloseContext, validateResidencyYearClose } from "../../v2/domain/equity.js";
import { eligibleCandidates, resolveMethod, drawResponsible, validateResponsible } from "../../v2/domain/responsible.js";
import { previewBloqueoRisk } from "../../v2/domain/blockPreview.js";

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
const RESP = { id: "resp-1", nombre: "Rita Mayor", email: "resp@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const OTRO = { id: "otro-1", nombre: "Olga Pequeña", email: "otro@gmail.com", fechaInicio: "2026-05-27", fechaFin: "2030-05-26" };

function makeDeps({ llm, violaciones = () => [] } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)],
    voluntariosResponsable: [headerOf(TABLES.voluntariosResponsable)],
    asignaciones: [headerOf(TABLES.asignaciones)], cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)], eventos: [headerOf(TABLES.eventos)], bloqueos: [headerOf(TABLES.bloqueos)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P)], generaciones: [headerOf(TABLES.generaciones)],
    preferencias: [headerOf(TABLES.preferencias)], imaginaria: [headerOf(TABLES.imaginaria)], sorteos: [headerOf(TABLES.sorteos)],
  });
  const nonces = new Set();
  const locks = { veces: 0, profundidad: 0, maxima: 0 };
  // `withLock` instrumentado y reentrante, como el de Code.gs: cuenta cuántas veces se coge y
  // hasta qué profundidad, para poder afirmar que la comprobación y la escritura van juntas.
  const withLock = (fn) => { locks.veces++; locks.profundidad++; locks.maxima = Math.max(locks.maxima, locks.profundidad); try { return fn(); } finally { locks.profundidad--; } };
  return {
    now: 1_000_000, today: "2027-06-16", clientId: CLIENT_ID, sessionSecret: "s", sessionTtl: 3600, crypto, ss, locks,
    store: makeStore({ ss, withLock, newId: () => `id-${nodeCrypto.randomUUID()}` }),
    llm,
    domain: {
      absences, validateMonth: (ctx) => violaciones(ctx), validateThirdPost: () => [],
      buildMonthContext, rotationHistoryStart, thirdPostHistoryStart, parseISO, addDays, bridgesOfMonth, academicYearOf,
      accumulatedTally, monthReplacementPlan, monthCompletionPlan, levelOn, periodsOfResident, groupOnDate,
      canEdit, canValidate, canPublish, stateAfterEdit,
      quarterCloseWindow, validateQuarterClose, yearCloseHistoryStart, yearCloseFestivosRange, buildYearCloseContext, validateResidencyYearClose,
      eligibleCandidates, resolveMethod, drawResponsible, validateResponsible, previewBloqueoRisk,
    },
    newSeed: () => "semilla",
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({}),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}

test("marcarValidado lee, valida y escribe DENTRO de una sola transacción: el lock real se coge UNA vez y la escritura de dentro no lo vuelve a pedir", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com"); // Mayor sin Responsable: puede validar (V-16)
  deps.locks.veces = 0; deps.locks.maxima = 0;
  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  // Si el store no absorbiera la reentrada, el `waitLock` de Apps Script se esperaría a sí mismo
  // 30 s y lanzaría en cada validación: por eso se exige UNA sola llamada al lock crudo.
  assert.equal(deps.locks.veces, 1, "una transacción, y la escritura del estado va dentro sin volver a pedir el lock");
  assert.equal(deps.locks.maxima, 1);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO", "y la escritura ocurrió");
});

test("una escritura suelta (fuera de transacción) sigue cogiendo el lock, y dos transacciones seguidas lo cogen dos veces", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  deps.locks.veces = 0;
  call({ action: "guardarPreferencias", session, anio: 2027, mes: 7, prefs: { maxGuardias: 5 } }, deps);
  assert.equal(deps.locks.veces, 1);
  deps.store.transaction(() => deps.store.appendRecord("preferencias", { residenteId: "otro-1", anio: 2027, mes: 8, maxGuardias: 4 }));
  deps.store.transaction(() => {});
  assert.equal(deps.locks.veces, 3, "la bandera se suelta al salir: la siguiente transacción vuelve a coger el lock");
});

test("generarCuadranteIA no escribe si el mes cambió mientras el modelo pensaba: CONFLICTO, sin filas nuevas, y queda en la bitácora", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const propuesta = JSON.stringify({ asignaciones: [{ fecha: "2027-07-01", residenteId: "resp-1", codigo: "G" }] });
  // El «modelo» tarda: mientras responde, otro residente guarda una celda del mismo mes.
  deps.llm = { modelo: "fake", generar: () => { deps.store.appendRecord("asignaciones", { fecha: "2027-07-20", residenteId: "otro-1", codigo: "G" }); return { ok: true, texto: propuesta }; } };
  const r = call({ action: "generarCuadranteIA", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.resultado, "CONFLICTO");
  assert.match(r.error, /cambió mientras se generaba/);
  const filas = deps.store.readLatest("asignaciones", (a) => `${a.fecha}|${a.residenteId}`, { emptyField: "codigo" });
  assert.deepEqual(filas.map((a) => a.fecha), ["2027-07-20"], "solo la celda que guardó el otro; la propuesta no se escribió");
  assert.equal(deps.store.readRecords("generaciones")[0].resultado, "CONFLICTO");
});

test("generarCuadranteIA sí escribe cuando nadie tocó el mes entre la lectura y la escritura", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  deps.llm = { modelo: "fake", generar: () => ({ ok: true, texto: JSON.stringify({ asignaciones: [{ fecha: "2027-07-01", residenteId: "resp-1", codigo: "G" }] }) }) };
  const r = call({ action: "generarCuadranteIA", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.guardados, 1);
});

test("el sorteo del Responsable se decide como pronto el año anterior: 2029 se rechaza en 2027, 2028 no", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "ejecutarSorteoResponsable", session, anio: 2029 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /como pronto en 2028/);
  assert.equal(deps.store.readRecords("responsables").length, 0);
  // 2028: RESP es R3 a 1 de enero de 2028 (empezó en mayo de 2024 → R4 desde mayo 2027)… no es
  // elegible; lo que se comprueba es que el tope de año no lo frena, sino la elegibilidad.
  const r2 = call({ action: "ejecutarSorteoResponsable", session, anio: 2028 }, deps);
  assert.doesNotMatch(r2.error || "", /como pronto/);
});

test("cancelar/anular dos veces no apila una segunda fila inactiva (append-only sin duplicados)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  // BAJA y no VACACIONES: la simulación preventiva (P-13) rechazaría las vacaciones de la única Pequeña.
  const { id } = call({ action: "crearBloqueo", session, desde: "2027-07-10", hasta: "2027-07-12", motivo: "BAJA" }, deps);
  assert.equal(call({ action: "cancelarBloqueo", session, id }, deps).ok, true);
  assert.equal(call({ action: "cancelarBloqueo", session, id }, deps).ok, true, "idempotente");
  assert.equal(deps.store.readRecords("bloqueos").length, 2, "alta + una sola cancelación");

  const fest = call({ action: "crearFestivos", session, festivos: [{ fecha: "2027-07-25", nombre: "Santiago" }] }, deps);
  call({ action: "anularFestivo", session, id: fest.ids[0] }, deps);
  call({ action: "anularFestivo", session, id: fest.ids[0] }, deps);
  assert.equal(deps.store.readRecords("festivos").length, 2);

  const ev = call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2027-12-20", voluntarios: ["otro-1", "otro-1", 7, ""] }, deps);
  assert.deepEqual(deps.store.readRecords("eventos")[0].voluntarios, ["otro-1"], "voluntarios sin duplicados ni basura");
  call({ action: "anularEvento", session, id: ev.id }, deps);
  call({ action: "anularEvento", session, id: ev.id }, deps);
  assert.equal(deps.store.readRecords("eventos").length, 2);
});

test("ofrecerse/retirarse dos veces como Responsable no duplica filas", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com"); // R3 el 2027-01-01: elegible
  assert.equal(call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps).ok, true);
  assert.equal(call({ action: "ofrecerseResponsable", session, anio: 2027 }, deps).ok, true);
  assert.equal(deps.store.readRecords("voluntariosResponsable").length, 1);
  assert.equal(call({ action: "retirarVoluntariadoResponsable", session, anio: 2027 }, deps).ok, true);
  assert.equal(call({ action: "retirarVoluntariadoResponsable", session, anio: 2027 }, deps).ok, true);
  assert.equal(deps.store.readRecords("voluntariosResponsable").length, 2);
});

test("las lecturas por mes rechazan mes/anio que no sean números, en vez de devolver vacío en silencio", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  for (const action of ["misPreferencias", "misBloqueos", "listBloqueos", "listAsignaciones"]) {
    const r = call({ action, session, anio: "2027", mes: "7" }, deps);
    assert.equal(r.ok, false, action);
    assert.match(r.error, /mes\/anio inválido/);
  }
});

test("listas con elementos que no son objetos se rechazan con un mensaje, no con un TypeError interno", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  const r1 = call({ action: "guardarAsignaciones", session, cambios: [null] }, deps);
  assert.equal(r1.ok, false); assert.match(r1.error, /cambio inválido/);
  const r2 = call({ action: "crearFestivos", session, festivos: ["2027-07-25"] }, deps);
  assert.equal(r2.ok, false); assert.match(r2.error, /festivo/);
  const r3 = call({ action: "validar", session, cuadrante: "nada" }, deps);
  assert.equal(r3.ok, true, "un cuadrante que no es objeto se trata como vacío");
});

// ── 2026-09-04: INV-15 en el borde del mes también en el servidor; eventos únicos; imaginaria con ausencias ──

test("marcarValidado ve el par que cruza el borde del mes (G el 31 y G el 1) aunque no haya rotación cercana", () => {
  const deps = makeDeps({ violaciones: (ctx) => validateMonth(ctx) }); // el validador REAL
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2027-07-31", residenteId: "resp-1", codigo: "G" },
    { fecha: "2027-08-01", residenteId: "resp-1", codigo: "G" },
  ] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 8, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "INV-15" && /2027-07-31 y 2027-08-01/.test(v.detalle)), "INV-15 en el borde");
  const r7 = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.ok(r7.violaciones.some((v) => v.invariante === "INV-15"), "y también validando el mes anterior");
});

test("crearEvento rechaza un segundo evento activo del mismo tipo en el mismo curso, y admite el mismo tipo en otro curso o tras anular", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  const e1 = call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2027-12-20" }, deps);
  assert.equal(e1.ok, true);
  const dup = call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2027-12-22" }, deps);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /ya hay un evento NAVIDAD activo en ese curso \(el 2027-12-20\)/);
  assert.equal(call({ action: "crearEvento", session, tipo: "DESPEDIDA", fecha: "2028-05-20" }, deps).ok, true, "otro tipo, mismo curso");
  assert.equal(call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2028-12-18" }, deps).ok, true, "mismo tipo, curso siguiente");
  call({ action: "anularEvento", session, id: e1.id }, deps);
  assert.equal(call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2027-12-22" }, deps).ok, true, "tras anular sí");
});

test("colaImaginaria aparta a quien está de baja ese día, y listBloqueosRango no devuelve filas ilegibles", async () => {
  const deps = makeDeps();
  deps.domain.imaginariaQueue = (await import("../../v2/domain/imaginaria.js")).imaginariaQueue;
  const session = loggedInAs(deps, "otro@gmail.com");
  call({ action: "crearBloqueo", session: loggedInAs(deps, "resp@gmail.com"), desde: "2027-07-01", hasta: "2027-07-31", motivo: "BAJA" }, deps);
  deps.store.appendRecord("bloqueos", { id: "corrupta", residenteId: "otro-1", desde: "30/02/2027", hasta: "2027-07-20", motivo: "VACACIONES", activo: true });
  const cola = call({ action: "colaImaginaria", session, grupo: "MAYOR", fecha: "2027-07-10" }, deps);
  assert.equal(cola.ok, true);
  assert.equal(cola.cola.find((x) => x.residenteId === "resp-1").apartadoPor, "está de baja");
  const rango = call({ action: "listBloqueosRango", session, desde: "2027-07-01", hasta: "2027-07-31" }, deps);
  assert.equal(rango.ok, true);
  assert.equal(rango.bloqueos.some((b) => b.id === "corrupta"), false, "la fila ilegible no alimenta la aritmética de los cierres");
  assert.equal(call({ action: "listBloqueos", session, anio: 2027, mes: 7 }, deps).bloqueos.some((b) => b.id === "corrupta"), true, "pero sigue visible para cancelarla");
});

test("estadoCuadrante anuncia los modos de generación que entiende el servidor (el cliente no ofrece «completar» a un servidor viejo)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.modosGeneracion, ["completar", "reemplazar"]);
});

// Tests de los festivos automáticos de la Comunitat Valenciana (V-61) en el router.
// (Montaje copiado de router-ausencia-ajena.test.js.) Antes: Tests de la ausencia registrada POR OTRO (punto 3 del plan de ausencias): `crearBloqueo` con
// `residenteId` y `cancelarBloqueo` sobre una fila ajena, las dos con el permiso del ciclo
// (V-16: el Responsable en mandato o, si no hay ninguno, cualquier Mayor).
//
// Por qué existe: la tabla `bloqueos` es la que leen los invariantes, y hasta ahora nadie podía
// escribir en ella por otro. Ante una baja que el residente no ha declarado —y que precisamente
// por estar de baja puede no poder declarar— el único gesto posible era pintar una «B» en la
// rejilla, que es un código de asignación y no lo lee NINGÚN invariante: INV-5 seguía dejando
// asignarle guardias.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { absences, BLOQUEA_ASIGNACION } from "../../v2/domain/absences.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { parseISO, addDays } from "../../v2/domain/calendar.js";
import { previewBloqueoRisk } from "../../v2/domain/blockPreview.js";
import { canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";
import { valencianHolidays } from "../../v2/domain/holidays.js";

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
// A día 2027-07-16: MAYOR es R4, PEQUE es R1 (se incorporó en mayo de 2027).
const MAYOR = { id: "uuid-mayor", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const OTRO_MAYOR = { id: "uuid-otro", nombre: "Bea", email: "bea@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const PEQUE = { id: "uuid-peque", nombre: "Iván", email: "peque@gmail.com", fechaInicio: "2027-05-25", fechaFin: "2031-05-24" };
// Segundo Pequeño del mismo nivel que Iván (P-13, spec.md §8): sin él, Iván sería el único
// residente de su grupo y CUALQUIER vacación suya dispararía el riesgo de imposibilidad — estos
// tests son de permisos de ausencia ajena, no de P-13.
const OTRO_PEQUE = { id: "uuid-otro-peque", nombre: "Marta", email: "marta@gmail.com", fechaInicio: "2027-05-25", fechaFin: "2031-05-24" };
let idCounter = 0;

function makeDeps({ mandatoDe = null } = {}) {
  const responsables = [headerOf(TABLES.responsables)];
  if (mandatoDe) {
    responsables.push(recordToRow(TABLES.responsables, {
      id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: mandatoDe, metodo: "VOLUNTARIO",
    }));
  }
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[MAYOR, OTRO_MAYOR, PEQUE, OTRO_PEQUE].map((r) => recordToRow(TABLES.residentes, r))],
    responsables,
    bloqueos: [headerOf(TABLES.bloqueos)],
    festivos: [headerOf(TABLES.festivos)],
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16",
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    // `addDays`/`canEdit`/`stateAfterEdit` los necesita `writeBloqueoMarcas` (V-50): la marca
    // V/R/B se escribe sola en la rejilla al crear el bloqueo, así que crearBloqueo ya no es
    // "solo escribir en bloqueos" y también toca estas tres funciones del ciclo del cuadrante.
    domain: { absences, groupOnDate, parseISO, addDays, previewBloqueoRisk, canEdit, stateAfterEdit, valencianHolidays },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: (idToken) => ({
      aud: CLIENT_ID, iss: "https://accounts.google.com",
      email: /peque/.test(idToken) ? "peque@gmail.com" : /bea/.test(idToken) ? "bea@gmail.com" : "ana@gmail.com",
      email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0],
    }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedIn(deps, quien = "ana") {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: `jwt-${quien}`, nonce }, deps).session;
}

const fechasDe = (r) => r.festivos.map((f) => f.fecha).sort();
const rango = (deps, session, desde, hasta) => call({ action: "listFestivosRango", session, desde, hasta }, deps);

test("V-61: sin cargar nada, un año ya trae los festivos de la Comunitat (9 y 12 de octubre incluidos)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = rango(deps, session, "2026-10-01", "2026-10-31");
  assert.equal(r.ok, true);
  assert.deepEqual(fechasDe(r), ["2026-10-09", "2026-10-12"]);
  assert.ok(r.festivos.every((f) => f.origen === "AUTO" && f.id === `auto:${f.fecha}` && f.activo === true));
});

test("V-61: los años sucesivos salen solos, sin cargar uno a uno", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  assert.equal(rango(deps, session, "2027-01-01", "2027-12-31").festivos.length, valencianHolidays(2027).length);
  const dosAnios = rango(deps, session, "2031-12-01", "2032-01-31");
  assert.deepEqual(fechasDe(dosAnios), ["2031-12-06", "2031-12-08", "2031-12-25", "2032-01-01", "2032-01-06"]);
});

test("V-61: una fila cargada a mano manda sobre la base de su fecha y no se duplica", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  assert.equal(call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-10-09", nombre: "Nueve de octubre (manual)", ambito: "AUTONOMICO" }] }, deps).ok, true);
  const r = rango(deps, session, "2026-10-01", "2026-10-31");
  assert.deepEqual(fechasDe(r), ["2026-10-09", "2026-10-12"]);
  const nueve = r.festivos.find((f) => f.fecha === "2026-10-09");
  assert.equal(nueve.nombre, "Nueve de octubre (manual)");
  assert.notEqual(nueve.origen, "AUTO");
});

test("V-61: se puede añadir a mano lo que la base no sabe (un local de Alicante) y anularlo", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const ids = call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-04-16", nombre: "Santa Faz", ambito: "LOCAL" }] }, deps).ids;
  assert.ok(rango(deps, session, "2026-04-01", "2026-04-30").festivos.some((f) => f.fecha === "2026-04-16"));
  assert.equal(call({ action: "anularFestivo", session, id: ids[0] }, deps).ok, true);
  assert.ok(!rango(deps, session, "2026-04-01", "2026-04-30").festivos.some((f) => f.fecha === "2026-04-16"));
});

test("V-61: anular un festivo automático lo quita ese año, sin tocar los demás ni otros años", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  assert.equal(call({ action: "anularFestivo", session, id: "auto:2026-10-12" }, deps).ok, true);
  assert.deepEqual(fechasDe(rango(deps, session, "2026-10-01", "2026-10-31")), ["2026-10-09"]);
  assert.ok(rango(deps, session, "2027-10-01", "2027-10-31").festivos.some((f) => f.fecha === "2027-10-12"), "el año siguiente conserva el suyo");
  // Idempotente: repetirlo no apila filas.
  const antes = deps.store.readRecords("festivos").length;
  assert.equal(call({ action: "anularFestivo", session, id: "auto:2026-10-12" }, deps).ok, true);
  assert.equal(deps.store.readRecords("festivos").length, antes);
  // Y una fecha que no es festivo automático no escribe nada.
  assert.equal(call({ action: "anularFestivo", session, id: "auto:2026-10-13" }, deps).ok, true);
  assert.equal(deps.store.readRecords("festivos").length, antes);
});

test("V-61: una fecha anulada que se vuelve a cargar a mano queda activa", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  call({ action: "anularFestivo", session, id: "auto:2026-10-12" }, deps);
  call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-10-12", nombre: "Fiesta Nacional", ambito: "NACIONAL" }] }, deps);
  assert.ok(rango(deps, session, "2026-10-01", "2026-10-31").festivos.some((f) => f.fecha === "2026-10-12"));
});

test("V-61: el rango no se sale de lo pedido, y un rango inválido sigue rechazándose", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  assert.deepEqual(fechasDe(rango(deps, session, "2026-10-10", "2026-10-11")), []);
  assert.equal(rango(deps, session, "2026-10-31", "2026-10-01").ok, false);
});

test("V-61: con un domain.gs anterior (sin valencianHolidays) se devuelve solo la tabla, sin romper", () => {
  const deps = makeDeps();
  delete deps.domain.valencianHolidays;
  const session = loggedIn(deps, "ana");
  assert.deepEqual(fechasDe(rango(deps, session, "2026-10-01", "2026-10-31")), []);
  call({ action: "crearFestivos", session, festivos: [{ fecha: "2026-10-09", nombre: "x", ambito: "" }] }, deps);
  assert.deepEqual(fechasDe(rango(deps, session, "2026-10-01", "2026-10-31")), ["2026-10-09"]);
});

test("V-61: un lote con listFestivosRango devuelve también los automáticos", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = call({ action: "lote", session, llamadas: [{ action: "listFestivosRango", desde: "2026-10-01", hasta: "2026-10-31" }, { action: "listEventos" }] }, deps);
  assert.equal(r.resultados[0].festivos.length, 2);
});

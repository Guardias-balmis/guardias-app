// Tests de la acción `lote` (S-9): varias lecturas en una petición.
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
    domain: { absences, groupOnDate, parseISO, addDays, previewBloqueoRisk, canEdit, stateAfterEdit },
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

test("S-9: un lote devuelve un resultado por llamada, en orden, con lo mismo que darían por separado", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const sueltas = [
    call({ action: "listResidentes", session }, deps),
    call({ action: "estadoCuadrante", session, anio: 2027, mes: 7 }, deps),
    call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps),
  ];
  const r = call({ action: "lote", session, llamadas: [
    { action: "listResidentes" }, { action: "estadoCuadrante", anio: 2027, mes: 7 }, { action: "listBloqueos", anio: 2027, mes: 8 },
  ] }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.resultados, sueltas);
});

test("S-9: un lote rechaza escrituras, anidar lotes y acciones inventadas, sin tumbar las demás llamadas", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = call({ action: "lote", session, llamadas: [
    { action: "listResidentes" },
    { action: "crearBloqueo", desde: "2027-08-01", hasta: "2027-08-05", motivo: "BAJA" },
    { action: "lote", llamadas: [] },
    { action: "inventada" },
    "no soy un objeto",
  ] }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.resultados[0].ok, true);
  for (const k of [1, 2, 3, 4]) { assert.equal(r.resultados[k].ok, false); assert.match(r.resultados[k].error, /no admitida en un lote/); }
  assert.equal(call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps).bloqueos.length, 0, "la escritura no se ejecutó");
});

test("S-9: sin sesión válida el lote entero se rechaza como cualquier acción, y el tamaño tiene tope", () => {
  const deps = makeDeps();
  assert.match(call({ action: "lote", session: "basura", llamadas: [{ action: "listResidentes" }] }, deps).error, /^sesión /);
  const session = loggedIn(deps, "ana");
  assert.equal(call({ action: "lote", session, llamadas: [] }, deps).ok, false);
  assert.equal(call({ action: "lote", session, llamadas: Array.from({ length: 13 }, () => ({ action: "listResidentes" })) }, deps).ok, false);
  assert.equal(call({ action: "lote", session }, deps).ok, false);
});

test("S-9: dentro de un lote el permiso de cada acción se sigue comprobando (un Pequeño no ve lo del ciclo)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "peque");
  const r = call({ action: "lote", session, llamadas: [{ action: "listResidentes" }, { action: "listSolicitudesInvitado" }] }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.resultados[0].ok, true);
  assert.equal(r.resultados[1].ok, false, "listSolicitudesInvitado exige permiso de administrador");
});

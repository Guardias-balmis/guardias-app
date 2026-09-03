// Tests de la ausencia registrada POR OTRO (punto 3 del plan de ausencias): `crearBloqueo` con
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
    // `addDays`/`canEdit`/`stateAfterEdit` los necesita `writeBloqueoMarcas` (V-48): la marca
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
const bajaDe = (residenteId) => ({
  action: "crearBloqueo", residenteId, desde: "2027-08-01", hasta: "2027-08-31", motivo: "BAJA",
});

test("un Mayor registra la baja de OTRO cuando no hay Responsable designado (V-16)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = call({ ...bajaDe("uuid-peque"), session }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.residenteId, "uuid-peque", "la fila es del ausente, no de quien la registra");

  // Y la lee el invariante: es lo que NO conseguía pintar una «B» en la rejilla.
  const todos = call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps).bloqueos;
  assert.deepEqual(
    absences(todos, { residenteId: "uuid-peque", motivos: BLOQUEA_ASIGNACION, fecha: "2027-08-15" }).length, 1
  );
});

test("un Pequeño NO puede registrar la ausencia de otro, ni con mandato ni sin él", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "peque");
  const r = call({ ...bajaDe("uuid-mayor"), session }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo un R3 o R4/);
  assert.deepEqual(call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps).bloqueos, []);
});

test("con Responsable en mandato, solo él registra la de otro — ni siquiera otro Mayor", () => {
  const deps = makeDeps({ mandatoDe: "uuid-mayor" });
  const otroMayor = loggedIn(deps, "bea");
  const r = call({ ...bajaDe("uuid-peque"), session: otroMayor }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo el Responsable/);

  const responsable = loggedIn(deps, "ana");
  assert.equal(call({ ...bajaDe("uuid-peque"), session: responsable }, deps).ok, true);
});

test("registrar la PROPIA ausencia no exige ningún permiso (sigue siendo autoservicio)", () => {
  const deps = makeDeps({ mandatoDe: "uuid-mayor" });
  const peque = loggedIn(deps, "peque");
  // Sin `residenteId`, como siempre.
  assert.equal(call({ action: "crearBloqueo", session: peque, desde: "2027-08-01", hasta: "2027-08-10", motivo: "VACACIONES" }, deps).ok, true);
  // Y mandando el suyo propio explícitamente: tampoco pasa por el permiso.
  assert.equal(call({ ...bajaDe("uuid-peque"), session: peque }, deps).ok, true);
});

test("no se puede registrar una ausencia a un residente que no existe", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = call({ ...bajaDe("uuid-fantasma"), session }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /no existe/);
});

test("las validaciones de motivo y rango se aplican igual a la ausencia ajena", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  assert.equal(call({ action: "crearBloqueo", session, residenteId: "uuid-peque", desde: "2027-08-01", hasta: "2027-08-31", motivo: "INVENTADO" }, deps).ok, false);
  assert.equal(call({ action: "crearBloqueo", session, residenteId: "uuid-peque", desde: "2027-08-31", hasta: "2027-08-01", motivo: "BAJA" }, deps).ok, false);
  assert.deepEqual(call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps).bloqueos, []);
});

test("quien puede registrarla puede CORREGIRLA: una baja puesta al residente equivocado se cancela", () => {
  // Sin esto la fila sería irreversible: la tabla es append-only y el afectado no la creó, así
  // que tampoco podía cancelarla él — le habría bloqueado las asignaciones para siempre.
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const id = call({ ...bajaDe("uuid-peque"), session }, deps).id;
  assert.equal(call({ action: "cancelarBloqueo", session, id }, deps).ok, true);
  assert.deepEqual(call({ action: "listBloqueos", session, anio: 2027, mes: 8 }, deps).bloqueos, []);
  // Append-only: la fila original sigue ahí, solo se ha reinsertado con activo=false.
  assert.equal(deps.ss.read("bloqueos").length, 3); // cabecera + alta + cancelación
});

test("un Pequeño no puede cancelar la ausencia de otro, pero sí la suya", () => {
  const deps = makeDeps();
  const mayor = loggedIn(deps, "ana");
  const ajena = call({ ...bajaDe("uuid-mayor"), session: mayor }, deps).id;

  const peque = loggedIn(deps, "peque");
  const r = call({ action: "cancelarBloqueo", session: peque, id: ajena }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo un R3 o R4/);

  const propia = call({ action: "crearBloqueo", session: peque, desde: "2027-09-01", hasta: "2027-09-05", motivo: "VACACIONES" }, deps).id;
  assert.equal(call({ action: "cancelarBloqueo", session: peque, id: propia }, deps).ok, true);
});

test("cancelar un id que no existe se rechaza sin escribir nada", () => {
  const deps = makeDeps();
  const session = loggedIn(deps, "ana");
  const r = call({ action: "cancelarBloqueo", session, id: "no-existe" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /no encontrado/);
  assert.equal(deps.ss.read("bloqueos").length, 1); // solo la cabecera
});

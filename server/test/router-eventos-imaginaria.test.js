// Tests de los eventos del servicio (INV-10) y de la Imaginaria (INV-13), decisión V-20.
//
// INV-10 llevaba desde la Fase 3 implementado y con test pero MUDO: `validateEvents` leía un
// `ctx.eventos` que nadie le pasaba y no había tabla. Aquí se comprueba la vía completa: fila
// en `eventos` → `buildCuadranteCtx` → `marcarValidado` emite el aviso.
//
// INV-13 es una HERRAMIENTA: `colaImaginaria` dice a quién llamar. No valida nada a posteriori.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { absences } from "../../v2/domain/absences.js";
import { imaginariaQueue } from "../../v2/domain/imaginaria.js";
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
    imaginaria: [headerOf(TABLES.imaginaria)],
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
      absences, imaginariaQueue, groupOnDate, levelOn, periodsOfResident, drawResponsible,
      parseISO, addDays, validateMonth, buildMonthContext, rotationHistoryStart,
      canValidate, canEdit, stateAfterEdit,
      // marcarValidado comprueba el mes, los dos cierres de INV-3 y el tercer puesto: si falta
      // una sola de estas, la acción cae por TypeError. Es lo que este arnés sirve para detectar.
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
const crearNavidad = (deps, session, extra = {}) =>
  call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2026-12-18", ...extra }, deps);

// ── Eventos del servicio (INV-10) ──────────────────────────────────────────────────────────

test("crearEvento / listEventos hacen round-trip; nace activo y sin designados", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(crearNavidad(deps, session).ok, true);
  const r = call({ action: "listEventos", session }, deps);
  assert.equal(r.eventos.length, 1);
  assert.equal(r.eventos[0].tipo, "NAVIDAD");
  assert.deepEqual(r.eventos[0].designados, []);
});

test("crearEvento exige el permiso del ciclo y valida tipo y fecha", () => {
  const deps = makeDeps();
  const pequena = loggedIn(deps, "eva"); // R1: no es Mayor
  assert.match(call({ action: "crearEvento", session: pequena, tipo: "NAVIDAD", fecha: "2026-12-18" }, deps).error, /solo un R3 o R4/);

  const session = loggedIn(deps, "ana");
  assert.match(call({ action: "crearEvento", session, tipo: "CENA", fecha: "2026-12-18" }, deps).error, /tipo de evento inválido/);
  assert.match(call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "18/12/2026" }, deps).error, /fecha inválida/);
  assert.deepEqual(call({ action: "listEventos", session }, deps).eventos, []);
});

test("sortearEvento saca 2 R2 distintos, deja fila en `sorteos` y es reproducible", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearNavidad(deps, session).id;
  const r = call({ action: "sortearEvento", session, id }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.designados.length, 2);
  assert.notEqual(r.designados[0], r.designados[1], "no puede salir dos veces la misma persona");
  for (const d of r.designados) assert.ok(["bruno", "carla"].includes(d), `${d} tendría que ser R2`);

  // La fila del sorteo queda con semilla y candidatos: se puede recomputar y detectar manipulación.
  const sorteos = deps.ss.read("sorteos");
  assert.equal(sorteos.length, 2); // cabecera + 1
  // Y el evento apunta a ella, que es de donde sale `sorteoDocumentado`.
  const evento = call({ action: "listEventos", session }, deps).eventos[0];
  assert.equal(evento.sorteoId, r.sorteoId);
  assert.deepEqual(evento.designados, r.designados);
});

test("sortearEvento sortea SOLO entre los voluntarios cuando hay 2 o más (criterio V-7b)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearNavidad(deps, session, { voluntarios: ["bruno", "carla"] }).id;
  const r = call({ action: "sortearEvento", session, id }, deps);
  assert.deepEqual(r.designados.sort(), ["bruno", "carla"]);
});

test("sortearEvento se niega si no hay 2 R2, y no sortea dos veces el mismo evento", () => {
  // En diciembre de 2024 todavía no había ningún R2 en esta plantilla (Bruno y Carla entraron
  // en mayo de 2025). El permiso se mira a `deps.today`, así que Ana sigue pudiendo sortear.
  const deps = makeDeps();
  const session = loggedIn(deps);
  const lejano = call({ action: "crearEvento", session, tipo: "NAVIDAD", fecha: "2024-12-18" }, deps).id;
  assert.match(call({ action: "sortearEvento", session, id: lejano }, deps).error, /al menos 2 R2/);

  const deps2 = makeDeps();
  const s2 = loggedIn(deps2);
  const id = crearNavidad(deps2, s2).id;
  assert.equal(call({ action: "sortearEvento", session: s2, id }, deps2).ok, true);
  assert.match(call({ action: "sortearEvento", session: s2, id }, deps2).error, /ya está sorteado/);
});

test("anularEvento lo saca de la lista sin borrar la fila (append-only)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearNavidad(deps, session).id;
  assert.equal(call({ action: "anularEvento", session, id }, deps).ok, true);
  assert.deepEqual(call({ action: "listEventos", session }, deps).eventos, []);
  assert.equal(deps.ss.read("eventos").length, 3); // cabecera + alta + anulación
});

test("INV-10 deja de estar MUDO: el evento de la tabla llega hasta marcarValidado", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = crearNavidad(deps, session).id;
  call({ action: "sortearEvento", session, id }, deps);
  // Ana es R3: cubrir el evento con ella incumple «se cubrirá por dos R2».
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-12-18", residenteId: "ana", codigo: "G" }] }, deps);

  const r = call({ action: "marcarValidado", session, mes: 12, anio: 2026 }, deps);
  const i10 = r.violaciones.filter((v) => v.invariante === "INV-10");
  assert.equal(i10.length, 1);
  assert.equal(i10[0].severidad, "aviso"); // V-4: los eventos nunca bloquean
  assert.match(i10[0].detalle, /debe cubrirse con 2 R2/);
});

test("sin fila de evento, INV-10 sigue callado (no se inventa ninguna fecha)", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-12-18", residenteId: "ana", codigo: "G" }] }, deps);
  const r = call({ action: "marcarValidado", session, mes: 12, anio: 2026 }, deps);
  assert.deepEqual(r.violaciones.filter((v) => v.invariante === "INV-10"), []);
});

// ── Imaginaria (INV-13) ────────────────────────────────────────────────────────────────────

test("colaImaginaria devuelve la cola derivada del grupo, con el R1 fuera de Pequeños", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const r = call({ action: "colaImaginaria", session, grupo: "PEQUENO", fecha: "2026-12-21" }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cola.map((x) => x.residenteId), ["bruno", "carla"]);
  assert.deepEqual(call({ action: "colaImaginaria", session, grupo: "MAYOR", fecha: "2026-12-21" }, deps).cola.map((x) => x.residenteId), ["ana", "david"]);
});

test("colaImaginaria aparta a quien tiene guardia la víspera o el día siguiente", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2026-12-20", residenteId: "bruno", codigo: "G" }] }, deps);
  const cola = call({ action: "colaImaginaria", session, grupo: "PEQUENO", fecha: "2026-12-21" }, deps).cola;
  assert.equal(cola[0].residenteId, "carla");
  assert.match(cola[1].apartadoPor, /día anterior/);
});

test("registrar una cobertura mueve la cola: quien cubre pasa al final", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const antes = call({ action: "colaImaginaria", session, grupo: "PEQUENO", fecha: "2026-12-21" }, deps).cola;
  assert.equal(antes[0].residenteId, "bruno");

  assert.equal(call({ action: "registrarImaginaria", session, grupo: "PEQUENO", fechaIncidencia: "2026-12-21", residenteId: "bruno" }, deps).ok, true);
  const despues = call({ action: "colaImaginaria", session, grupo: "PEQUENO", fecha: "2027-01-15" }, deps).cola;
  assert.equal(despues[0].residenteId, "carla", "ahora le toca a quien no ha cubierto");
  assert.equal(despues[1].ultimaCobertura, "2026-12-21");
});

test("registrarImaginaria exige permiso del ciclo, grupo, fecha y residente reales", () => {
  const deps = makeDeps();
  const pequena = loggedIn(deps, "eva");
  assert.match(call({ action: "registrarImaginaria", session: pequena, grupo: "PEQUENO", fechaIncidencia: "2026-12-21", residenteId: "bruno" }, deps).error, /solo un R3 o R4/);

  const session = loggedIn(deps, "ana");
  assert.match(call({ action: "registrarImaginaria", session, grupo: "TERCERO", fechaIncidencia: "2026-12-21", residenteId: "bruno" }, deps).error, /grupo inválido/);
  assert.match(call({ action: "registrarImaginaria", session, grupo: "PEQUENO", fechaIncidencia: "21/12/2026", residenteId: "bruno" }, deps).error, /fecha inválida/);
  assert.match(call({ action: "registrarImaginaria", session, grupo: "PEQUENO", fechaIncidencia: "2026-12-21", residenteId: "fantasma" }, deps).error, /no existe/);
});

test("se puede registrar a quien NO era el primero de la cola: la app no impone el orden", () => {
  // Una incidencia se resuelve por teléfono y hay mil motivos legítimos para saltárselo (nadie
  // cogía, se cambió con otro). Lo que importa es que la cobertura quede registrada.
  const deps = makeDeps();
  const session = loggedIn(deps);
  assert.equal(call({ action: "registrarImaginaria", session, grupo: "PEQUENO", fechaIncidencia: "2026-12-21", residenteId: "carla" }, deps).ok, true);
});

test("anularImaginaria devuelve la cola a su estado anterior, sin borrar la fila", () => {
  const deps = makeDeps();
  const session = loggedIn(deps);
  const id = call({ action: "registrarImaginaria", session, grupo: "PEQUENO", fechaIncidencia: "2026-12-21", residenteId: "bruno" }, deps).id;
  assert.equal(call({ action: "anularImaginaria", session, id }, deps).ok, true);
  const cola = call({ action: "colaImaginaria", session, grupo: "PEQUENO", fecha: "2027-01-15" }, deps).cola;
  assert.equal(cola[0].residenteId, "bruno", "la cobertura anulada ya no le mueve");
  assert.equal(deps.ss.read("imaginaria").length, 3); // cabecera + alta + anulación
});

test("leer la cola está abierto a cualquier sesión: cualquiera puede necesitar saber a quién llamar", () => {
  const deps = makeDeps();
  const pequena = loggedIn(deps, "eva");
  assert.equal(call({ action: "colaImaginaria", session: pequena, grupo: "MAYOR", fecha: "2026-12-21" }, deps).ok, true);
});

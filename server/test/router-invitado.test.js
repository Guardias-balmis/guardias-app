// Perfil de invitado (V-53): solo lectura, sin alta, sin escribir nada, sin emails ni ausencias.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { groupOnDate } from "../../v2/domain/residents.js";
import { parseISO } from "../../v2/domain/calendar.js";
import { canEdit } from "../../v2/domain/cuadrante.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";

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
const ANA = { id: "ana", nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const ADMIN = { id: "adm", nombre: "Quique", email: "quiquemm14@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

function makeDeps() {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[ANA, ADMIN].map((r) => recordToRow(TABLES.residentes, r))],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
  });
  let n = 0;
  const deps = {
    now: 1_000_000, today: "2026-10-06", clientId: CLIENT_ID, sessionSecret: "secreto", sessionTtl: 12 * 3600, crypto, ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => nodeCrypto.randomUUID() }),
    domain: { absences, groupOnDate, canEdit, parseISO },
    email: "tutor@gmail.com", // quien «inicia sesión en Google» en el siguiente login
    correos: [],
    sendMail: (para, asunto, cuerpo) => deps.correos.push({ para, asunto, cuerpo }),
    issueNonce: () => "n" + (++n),
    consumeNonce: () => true,
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: deps.email, email_verified: "true", sub: "g", exp: String(2_000_000), nonce: "n" + n }),
  };
  return deps;
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function login(deps, email) {
  deps.email = email;
  const nonce = call({ action: "getNonce" }, deps).nonce;
  return call({ action: "login", idToken: "jwt", nonce }, deps);
}
const loggedInAs = (deps, email) => login(deps, email).session;
function solicita(deps) {
  const r = login(deps, "tutor@gmail.com");
  assert.equal(r.ok, false);
  const sol = call({ action: "solicitarInvitado", pendingToken: r.pendingToken }, deps);
  assert.equal(sol.ok, true);
  return sol;
}
const filas = (deps) => Object.fromEntries(["residentes", "asignaciones", "cuadrantes"].map((t) => [t, deps.ss.read(t).length]));
const pasa = (deps, seg) => { deps.now += seg; };

test("solicitarInvitado: avisa por correo a los administradores, queda PENDIENTE y NO da sesión", () => {
  const deps = makeDeps();
  const antes = filas(deps);
  const sol = solicita(deps);
  assert.equal(deps.correos.length, 1);
  assert.deepEqual(deps.correos[0].para, ["agustinlagioiosa@gmail.com", "quiquemm14@gmail.com"]);
  assert.match(deps.correos[0].cuerpo, /tutor@gmail\.com/);
  const e = call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps);
  assert.equal(e.estado, "PENDIENTE");
  assert.equal(e.session, undefined);
  assert.deepEqual(filas(deps), antes, "no se crea ningún residente");
});

test("pedirlo varias veces seguidas no manda más correos (reutiliza la pendiente)", () => {
  const deps = makeDeps();
  solicita(deps); solicita(deps); solicita(deps);
  assert.equal(deps.correos.length, 1);
});

test("si el correo falla, la solicitud sigue viéndose en la app del administrador", () => {
  const deps = makeDeps();
  deps.sendMail = () => { throw new Error("cuota"); };
  solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  assert.equal(call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes.length, 1);
});

test("un administrador aprueba y el invitado canjea UNA sola vez una sesión de solo lectura, sin emails", () => {
  const deps = makeDeps();
  const sol = solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const [pend] = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes;
  assert.equal(pend.email, "tutor@gmail.com");
  assert.equal(call({ action: "resolverSolicitudInvitado", session: adm, id: pend.id, aprobar: true }, deps).ok, true);
  const e = call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps);
  assert.equal(e.estado, "APROBADA");
  assert.equal(e.residente.rol, "invitado");
  assert.equal("email" in e.residentes[0], false);
  assert.equal(call({ action: "estadoCuadrante", session: e.session, mes: 10, anio: 2026 }, deps).ok, true);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "CADUCADA", "un solo canje");
});

test("rechazada: el invitado no entra", () => {
  const deps = makeDeps();
  const sol = solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const id = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes[0].id;
  assert.equal(call({ action: "resolverSolicitudInvitado", session: adm, id, aprobar: false }, deps).estado, "RECHAZADA");
  const e = call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps);
  assert.equal(e.estado, "RECHAZADA");
  assert.equal(e.session, undefined);
});

test("solo un administrador gestiona solicitudes: un residente normal no puede listar ni aprobar", () => {
  const deps = makeDeps();
  const sol = solicita(deps);
  const ana = loggedInAs(deps, "ana@gmail.com");
  assert.equal(call({ action: "listSolicitudesInvitado", session: ana }, deps).ok, false);
  const id = deps.store.readLatest("solicitudesInvitado", (r) => r.id)[0].id;
  const r = call({ action: "resolverSolicitudInvitado", session: ana, id, aprobar: true }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /administradores/);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "PENDIENTE");
});

test("a los 5 minutos la solicitud caduca: no se puede aprobar ni canjear", () => {
  const deps = makeDeps();
  const sol = solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const id = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes[0].id;
  pasa(deps, 301);
  assert.equal(call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes.length, 0);
  const r = call({ action: "resolverSolicitudInvitado", session: adm, id, aprobar: true }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /caducado/);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "CADUCADA");
});

test("aprobada a tiempo pero canjeada tarde: caducada", () => {
  const deps = makeDeps();
  const sol = solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const id = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes[0].id;
  call({ action: "resolverSolicitudInvitado", session: adm, id, aprobar: true }, deps);
  pasa(deps, 301);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "CADUCADA");
});

test("solicitudes con token falso o sin token no hacen nada", () => {
  const deps = makeDeps();
  assert.equal(call({ action: "solicitarInvitado" }, deps).ok, false);
  assert.equal(call({ action: "solicitarInvitado", pendingToken: "x.y" }, deps).ok, false);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: "x.y" }, deps).estado, "CADUCADA");
  assert.equal(deps.correos.length, 0);
});

// Con la sesión de invitado ya concedida, el resto de garantías de V-53:
function sesionInvitado(deps) {
  const sol = solicita(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const id = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes[0].id;
  call({ action: "resolverSolicitudInvitado", session: adm, id, aprobar: true }, deps);
  return call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).session;
}

test("el invitado puede LEER el cuadrante y el equipo, sin emails", () => {
  const deps = makeDeps();
  const session = sesionInvitado(deps);
  assert.equal(call({ action: "listAsignacionesRango", session, desde: "2026-10-01", hasta: "2026-10-31" }, deps).ok, true);
  const l = call({ action: "listResidentes", session }, deps);
  assert.equal(l.ok, true);
  assert.ok(l.residentes.every((r) => !("email" in r)));
});

test("el invitado NO puede escribir ni leer lo sensible: escritura, ausencias, preferencias, imaginaria, solicitudes", () => {
  const deps = makeDeps();
  const session = sesionInvitado(deps);
  const antes = filas(deps);
  for (const action of [
    "guardarAsignaciones", "marcarValidado", "publicarCuadrante", "despublicarCuadrante", "generarCuadranteIA",
    "crearBloqueo", "cancelarBloqueo", "guardarPreferencias", "editarResidente", "guardarPeriodos",
    "ofrecerseResponsable", "ejecutarSorteoResponsable", "ofrecerse3P", "registrarImaginaria", "crearFestivos",
    "listBloqueos", "listBloqueosRango", "misBloqueos", "listPreferencias", "misPreferencias", "colaImaginaria",
    "listSolicitudesInvitado", "resolverSolicitudInvitado",
  ]) {
    const r = call({ action, session, mes: 10, anio: 2026, id: "x", aprobar: true, cambios: [{ fecha: "2026-10-03", residenteId: "ana", codigo: "G" }] }, deps);
    assert.equal(r.ok, false, action);
    assert.match(r.error, /solo lectura/, action);
  }
  assert.deepEqual(filas(deps), antes);
});

test("el rol de invitado va firmado: no se puede ascender cambiando el token", () => {
  const deps = makeDeps();
  const session = sesionInvitado(deps);
  const [payload, firma] = session.split(".");
  const falso = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), rol: "residente" })).toString("base64url");
  assert.equal(call({ action: "listBloqueos", session: `${falso}.${firma}` }, deps).ok, false);
});

test("la sesión de invitado dura 2 h", () => {
  const deps = makeDeps();
  const session = sesionInvitado(deps);
  const p = JSON.parse(Buffer.from(session.split(".")[0], "base64url").toString());
  assert.equal(p.exp - deps.now, 2 * 3600);
});

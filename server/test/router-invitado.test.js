// Perfil de invitado (V-53): solo lectura, sin alta, sin escribir nada, sin emails ni ausencias.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { groupOnDate, levelOn } from "../../v2/domain/residents.js";
import { parseISO, addDays } from "../../v2/domain/calendar.js";
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
// El otro administrador: sin fila de residente no podría ni entrar, así que tampoco recibiría el aviso (V-57).
const AGUS = { id: "agus", nombre: "Agustín", email: "agustinlagioiosa@gmail.com", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };

function makeDeps({ residentes = [ANA, AGUS, ADMIN] } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...residentes.map((r) => recordToRow(TABLES.residentes, r))],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
  });
  let n = 0;
  const deps = {
    now: 1_000_000, today: "2026-10-06", clientId: CLIENT_ID, sessionSecret: "secreto", sessionTtl: 12 * 3600, crypto, ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => nodeCrypto.randomUUID() }),
    domain: { absences, groupOnDate, canEdit, parseISO, addDays },
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
    "ofrecerseResponsable", "ejecutarSorteoResponsable", "registrarImaginaria", "crearFestivos",
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

// ── Alta de residente con aprobación (V-54) ──
function pideAlta(deps, email = "nueva@gmail.com", nombre = "  Nueva Residente ") {
  const r = login(deps, email);
  assert.equal(r.ok, false);
  const sol = call({ action: "solicitarAlta", pendingToken: r.pendingToken, nombre, fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(sol.ok, true);
  return sol;
}
const idPendiente = (deps, adm) => call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes[0];

test("alta: pedirla avisa a los administradores y NO crea el residente ni da sesión", () => {
  const deps = makeDeps();
  const antes = filas(deps);
  const sol = pideAlta(deps);
  assert.equal(deps.correos.length, 1);
  assert.match(deps.correos[0].asunto, /alta de residente/);
  assert.match(deps.correos[0].cuerpo, /Nueva Residente/);
  assert.deepEqual(filas(deps), antes);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "PENDIENTE");
});

test("alta: el administrador la ve con sus datos, la aprueba y SOLO entonces se crea el residente, que entra con su sesión", () => {
  const deps = makeDeps();
  const sol = pideAlta(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const p = idPendiente(deps, adm);
  assert.deepEqual([p.tipo, p.nombre, p.fechaInicio, p.email], ["ALTA", "Nueva Residente", "2026-05-25", "nueva@gmail.com"]);
  assert.equal(call({ action: "resolverSolicitudInvitado", session: adm, id: p.id, aprobar: true }, deps).ok, true);
  const e = call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps);
  assert.equal(e.estado, "APROBADA");
  assert.equal(e.residente.nombre, "Nueva Residente");
  assert.notEqual(e.residente.rol, "invitado");
  assert.equal(e.residentes.length, 4);
  // Es una sesión de residente de verdad: puede leer lo que un invitado no puede
  assert.equal(call({ action: "misBloqueos", session: e.session, mes: 10, anio: 2026 }, deps).ok, true);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "CADUCADA", "un solo canje");
});

test("alta rechazada: no se crea nada", () => {
  const deps = makeDeps();
  const sol = pideAlta(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  call({ action: "resolverSolicitudInvitado", session: adm, id: idPendiente(deps, adm).id, aprobar: false }, deps);
  assert.equal(call({ action: "estadoSolicitudInvitado", solicitudToken: sol.solicitudToken }, deps).estado, "RECHAZADA");
  assert.equal(deps.store.readRecords("residentes").length, 3);
});

test("alta: a los 5 minutos caduca y no se puede aprobar (no se crea el residente)", () => {
  const deps = makeDeps();
  pideAlta(deps);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const id = idPendiente(deps, adm).id;
  pasa(deps, 301);
  assert.match(call({ action: "resolverSolicitudInvitado", session: adm, id, aprobar: true }, deps).error, /caducado/);
  assert.equal(deps.store.readRecords("residentes").length, 3);
});

test("alta: un residente normal no puede aprobar su propia alta ni la de otro", () => {
  const deps = makeDeps();
  pideAlta(deps);
  const id = deps.store.readLatest("solicitudesInvitado", (r) => r.id)[0].id;
  const ana = loggedInAs(deps, "ana@gmail.com");
  assert.match(call({ action: "resolverSolicitudInvitado", session: ana, id, aprobar: true }, deps).error, /administradores/);
  assert.equal(deps.store.readRecords("residentes").length, 3);
});

test("alta: si el email ya se vinculó entre la petición y la aprobación, no se duplica", () => {
  const deps = makeDeps();
  pideAlta(deps);
  deps.store.appendRecord("residentes", { nombre: "Colada", email: "nueva@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" });
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const r = call({ action: "resolverSolicitudInvitado", session: adm, id: idPendiente(deps, adm).id, aprobar: true }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /ya está vinculado/);
  assert.equal(deps.store.readRecords("residentes").filter((x) => x.email === "nueva@gmail.com").length, 1);
});

test("alta: un residente ya vinculado no puede pedirla, y una solicitud de invitado no se confunde con una de alta", () => {
  const deps = makeDeps();
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.email = "ana@gmail.com";
  const r = call({ action: "solicitarAlta", idToken: "jwt", nonce, nombre: "Ana", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, deps);
  assert.equal(r.ok, false);
  const inv = solicita(deps); // tutor@gmail.com como INVITADO
  pideAlta(deps, "tutor@gmail.com", "Tutor"); // el mismo email pide ahora un ALTA: es otra solicitud
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const tipos = call({ action: "listSolicitudesInvitado", session: adm }, deps).solicitudes.map((s) => s.tipo).sort();
  assert.deepEqual(tipos, ["ALTA", "INVITADO"]);
  assert.ok(inv.solicitudToken);
});

// ── A quién se avisa, y qué se le dice al solicitante (V-57) ──
// Antes de V-57, pasada la ventana de administradores no se avisaba a nadie, y la pantalla del
// solicitante seguía diciendo que sí. El aviso tiene que llegar justo a quien puede aprobar.
const PEQ = { id: "peq", nombre: "Pepa", email: "peq@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" };
const MUDO = { id: "mudo", nombre: "Sin email", email: "", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
function trasLaVentana({ mandatoDe } = {}) {
  const deps = makeDeps();
  deps.today = "2027-04-15"; // ANA y ADMIN son R3 (Mayores); PEQ es R1
  deps.store.appendRecords("residentes", [PEQ, MUDO]);
  if (mandatoDe) deps.store.appendRecord("responsables", { periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: mandatoDe, metodo: "VOLUNTARIO" });
  return deps;
}

test("V-57: dentro de la ventana avisa a los administradores y la respuesta dice a cuántos", () => {
  const deps = makeDeps();
  assert.equal(solicita(deps).avisados, 2);
});

test("V-57: pasada la ventana, con mandato vigente, avisa SOLO al Responsable, que es el único que puede aprobar", () => {
  const deps = trasLaVentana({ mandatoDe: "ana" });
  assert.equal(solicita(deps).avisados, 1);
  assert.deepEqual(deps.correos[0].para, ["ana@gmail.com"]);
  const quique = loggedInAs(deps, "quiquemm14@gmail.com"); // Mayor, pero ya sin ventana de administrador
  assert.match(call({ action: "listSolicitudesInvitado", session: quique }, deps).error, /Responsable/);
  const ana = loggedInAs(deps, "ana@gmail.com");
  const [pend] = call({ action: "listSolicitudesInvitado", session: ana }, deps).solicitudes;
  assert.equal(call({ action: "resolverSolicitudInvitado", session: ana, id: pend.id, aprobar: true }, deps).ok, true);
});

test("V-57: pasada la ventana, sin mandato, avisa a todos los Mayores y a ningún Pequeño", () => {
  const deps = trasLaVentana();
  assert.equal(solicita(deps).avisados, 2);
  assert.deepEqual([...deps.correos[0].para].sort(), ["ana@gmail.com", "quiquemm14@gmail.com"]);
  const pepa = loggedInAs(deps, "peq@gmail.com");
  assert.equal(call({ action: "listSolicitudesInvitado", session: pepa }, deps).ok, false, "a quien no se avisa tampoco puede aprobar");
});

test("V-57: el alta de un R1 pasada la ventana también avisa al Responsable", () => {
  const deps = trasLaVentana({ mandatoDe: "ana" });
  assert.equal(pideAlta(deps).avisados, 1);
  assert.deepEqual(deps.correos[0].para, ["ana@gmail.com"]);
  assert.match(deps.correos[0].asunto, /alta de residente/);
});

test("V-57: si el correo falla, no está configurado o no hay a quién mandarlo, la respuesta dice avisados: 0", () => {
  const falla = makeDeps();
  falla.sendMail = () => { throw new Error("cuota"); };
  assert.equal(solicita(falla).avisados, 0);
  const sinCorreo = makeDeps();
  delete sinCorreo.sendMail;
  assert.equal(solicita(sinCorreo).avisados, 0);
  const sinDestinatario = trasLaVentana({ mandatoDe: "mudo" }); // el Responsable no tiene email
  assert.equal(solicita(sinDestinatario).avisados, 0);
  assert.equal(sinDestinatario.correos.length, 0);
});

test("V-57: una solicitud reutilizada no afirma nada del correo (se mandó, o no, en otra petición)", () => {
  const deps = makeDeps();
  assert.equal(solicita(deps).avisados, 2);
  assert.equal("avisados" in solicita(deps), false);
  assert.equal(deps.correos.length, 1);
});

// ── El invitado no ve las ausencias de la rejilla (V-53 d, roto por las marcas de V-50) ──
test("el invitado no recibe las marcas V/R/B de la rejilla (bajas médicas incluidas); un residente sí", () => {
  const deps = makeDeps();
  deps.store.appendRecords("asignaciones", [
    { fecha: "2026-10-05", residenteId: "ana", codigo: "G" },
    { fecha: "2026-10-06", residenteId: "ana", codigo: "B" }, // marca de una BAJA (V-50)
    { fecha: "2026-10-07", residenteId: "adm", codigo: "V" },
    { fecha: "2026-10-08", residenteId: "adm", codigo: "R" },
    { fecha: "2026-10-09", residenteId: "ana", codigo: "G" }, // guardia que luego tapó una baja:
    { fecha: "2026-10-09", residenteId: "ana", codigo: "B" }, // al quitar la B no debe reaparecer la G
  ]);
  const inv = sesionInvitado(deps);
  const mes = call({ action: "listAsignaciones", session: inv, mes: 10, anio: 2026 }, deps);
  assert.equal(mes.ok, true);
  assert.deepEqual(mes.asignaciones.map((a) => `${a.fecha}:${a.codigo}`), ["2026-10-05:G"]);
  const rango = call({ action: "listAsignacionesRango", session: inv, desde: "2026-10-01", hasta: "2026-10-31" }, deps);
  assert.deepEqual(rango.asignaciones.map((a) => `${a.fecha}:${a.codigo}`), ["2026-10-05:G"]);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const todas = call({ action: "listAsignaciones", session: adm, mes: 10, anio: 2026 }, deps).asignaciones;
  assert.equal(todas.length, 5, "a un residente no se le quita nada");
});

test("V-57: los destinatarios salen del permiso también DENTRO de la ventana: un administrador sin fila de residente no recibe un aviso que no podría atender", () => {
  const deps = makeDeps({ residentes: [ANA, ADMIN] });
  assert.equal(solicita(deps).avisados, 1);
  assert.deepEqual(deps.correos[0].para, ["quiquemm14@gmail.com"]);
});

test("V-57: un administrador con el email en mayúsculas o con espacios en el Sheet recibe el aviso (normalizado) y PUEDE aprobar", () => {
  const deps = makeDeps({ residentes: [ANA, { ...ADMIN, email: "  Quiquemm14@gmail.com " }, AGUS] });
  assert.equal(solicita(deps).avisados, 2);
  assert.deepEqual([...deps.correos[0].para].sort(), ["agustinlagioiosa@gmail.com", "quiquemm14@gmail.com"]);
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  assert.equal(call({ action: "listSolicitudesInvitado", session: adm }, deps).ok, true);
});

test("V-57: pasada la ventana, un residente con fechas ilegibles no tumba la solicitud ni deja sin aviso a los demás Mayores", () => {
  const deps = trasLaVentana();
  deps.store.appendRecord("residentes", { id: "roto", nombre: "Fecha rota", email: "roto@gmail.com", fechaInicio: "27/05/2025", fechaFin: "2029-05-26" });
  const r = login(deps, "tutor@gmail.com");
  const sol = call({ action: "solicitarInvitado", pendingToken: r.pendingToken }, deps);
  assert.equal(sol.ok, true, "la solicitud se registra y devuelve su token");
  assert.equal(sol.avisados, 2);
  assert.deepEqual([...deps.correos[0].para].sort(), ["ana@gmail.com", "quiquemm14@gmail.com"]);
});

test("V-57: una celda de email que no es un email se salta, para que no tumbe el correo de todos", () => {
  const deps = trasLaVentana();
  deps.store.appendRecord("residentes", { id: "basura", nombre: "Sin email real", email: "pendiente", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" });
  assert.equal(solicita(deps).avisados, 2);
  assert.deepEqual([...deps.correos[0].para].sort(), ["ana@gmail.com", "quiquemm14@gmail.com"]);
});

test("el invitado no puede fechar una baja larga por el hueco entre periodos formativos editados, y el nivel no cambia ningún día", () => {
  const deps = makeDeps();
  // Tutoría registra que la baja de Ana retrasa su R3: hueco entre el fin de R2 y el inicio de R3 (S-3).
  const editados = [
    { anio: 1, fechaInicio: "2024-05-27", fechaFin: "2025-05-26" },
    { anio: 2, fechaInicio: "2025-05-27", fechaFin: "2026-05-26" },
    { anio: 3, fechaInicio: "2026-11-27", fechaFin: "2027-11-26" },
    { anio: 4, fechaInicio: "2027-11-27", fechaFin: "2028-11-26" },
  ];
  deps.store.appendRecords("periodos", editados.map((p) => ({ residenteId: "ana", ...p })));
  const inv = sesionInvitado(deps);
  const ana = call({ action: "listResidentes", session: inv }, deps).residentes.find((r) => r.id === "ana");
  assert.equal(ana.periodos[1].end, "2026-11-26", "el fin de R2 ya no delata cuándo empezó la baja");
  assert.equal(ana.periodos[3].end, "2028-11-26", "el último fin se conserva: sin él, el nivel cambiaría");
  const adm = loggedInAs(deps, "quiquemm14@gmail.com");
  const real = call({ action: "listResidentes", session: adm }, deps).residentes.find((r) => r.id === "ana");
  assert.equal(real.periodos[1].end, "2026-05-26", "a un residente se le da el dato tal cual");
  for (let d = "2024-05-01"; d <= "2029-01-31"; d = addDays(d, 1)) {
    assert.equal(levelOn(ana.periodos, d), levelOn(real.periodos, d), `mismo nivel el ${d}`);
  }
});

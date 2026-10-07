// Tests de client/lib/api.js — cliente del backend Apps Script (ADR-002 D-1: petición
// "simple" sin preflight). Se inyecta un `fetch` falso: nunca se abre red real en los tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestInit, callBackend, makeApi } from "../api.js";

test("buildRequestInit cumple el contrato D-1: text/plain, credentials omit, sin Authorization", () => {
  const init = buildRequestInit({ action: "whoami", session: "abc" });
  assert.equal(init.method, "POST");
  assert.equal(init.mode, "cors");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "follow");
  assert.deepEqual(Object.keys(init.headers), ["Content-Type"]);
  assert.equal(init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.equal(JSON.parse(init.body).action, "whoami");
});

function fakeFetch(status, jsonBody) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => jsonBody };
  };
  fn.calls = calls;
  return fn;
}

// `fetch` que devuelve una secuencia de respuestas, una por intento. Sirve para fijar el reintento
// sin esperar de verdad: `esperar` se inyecta como no-op.
function fetchSecuencia(...respuestas) {
  const calls = [];
  const fn = async (url, init) => {
    const r = respuestas[calls.length];
    calls.push({ url, init });
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const sinEsperar = async () => {};

test("callBackend manda el payload correcto y devuelve el JSON parseado", async () => {
  const fetchImpl = fakeFetch(200, { ok: true, nonce: "n1" });
  const r = await callBackend("https://exec.example/x", { action: "getNonce" }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.nonce, "n1");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://exec.example/x");
});

test("callBackend nunca lanza: HTTP de error se convierte en {ok:false}", async () => {
  const r = await callBackend("https://exec.example/x", { action: "x" }, { fetchImpl: fakeFetch(500, {}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
});

test("callBackend nunca lanza: fallo de red se convierte en {ok:false}", async () => {
  const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
  const r = await callBackend("https://exec.example/x", { action: "x" }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /Failed to fetch/, "el texto original se conserva: es lo que sirve para diagnosticar");
});

// 2026-10-08, fallo en producción al generar el cuadrante: Google mató la ejecución (6 min) y
// contestó con una página suya sin CORS. En el navegador eso es un TypeError «Failed to fetch», y la
// tarjeta enseñaba «No se pudo generar — Failed to fetch». Para una ESCRITURA eso es engañoso: no
// se sabe si se guardó. Quien llama tiene que poder distinguir «el servidor dijo que no» de «no
// llegó respuesta».
test("un fallo de red se explica en español, sin perder el original", async () => {
  const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
  const r = await callBackend("https://exec.example/x", { action: "x" }, { fetchImpl });
  assert.match(r.error, /no llegó (la )?respuesta del servidor de Google/);
});

test("todo fallo de transporte lleva `transporte: true`; un rechazo del servidor, no", async () => {
  const casos = [
    async () => { throw new TypeError("Failed to fetch"); },
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }),
    async () => ({ ok: true, status: 200, json: async () => [1, 2] }),
  ];
  for (const fetchImpl of casos) {
    const r = await callBackend("https://exec.example/x", { action: "generarCuadranteIA" }, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.transporte, true, r.error);
  }
  const rechazo = await callBackend("https://exec.example/x", { action: "generarCuadranteIA" }, { fetchImpl: fakeFetch(200, { ok: false, error: "no" }) });
  assert.equal(rechazo.transporte, undefined, "un {ok:false} del router es una respuesta, no un fallo de transporte");
});

test("makeApi: cada método manda la action correcta y adjunta la sesión si se provee", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "sess-123" });
  await api.listResidentes();
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.action, "listResidentes");
  assert.equal(sent.session, "sess-123");
});

test("makeApi.login no adjunta sesión (aún no existe)", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => null });
  await api.login("idtok", "nonce1");
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.action, "login");
  assert.equal(sent.idToken, "idtok");
  assert.equal(sent.nonce, "nonce1");
  assert.equal(sent.session, undefined);
});

test("makeApi.solicitarAlta soporta idToken+nonce o pendingToken", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => null });

  await api.solicitarAlta({ idToken: "jwt", nonce: "n1" }, { nombre: "Ana", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" });
  let sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.idToken, "jwt");
  assert.equal(sent.nombre, "Ana");

  await api.solicitarAlta({ pendingToken: "ptok" }, { nombre: "Bea", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" });
  sent = JSON.parse(fetchImpl.calls[1].init.body);
  assert.equal(sent.pendingToken, "ptok");
  assert.equal(sent.idToken, undefined);
});

test("makeApi.listBloqueos y misBloqueos mandan la action correcta", async () => {
  const fetchImpl = fakeFetch(200, { ok: true, bloqueos: [] });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
  await api.listBloqueos(2026, 8);
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).action, "listBloqueos");
  await api.misBloqueos(2026, 8);
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).action, "misBloqueos");
});

test("makeApi.guardarAsignaciones manda el array de cambios", async () => {
  const fetchImpl = fakeFetch(200, { ok: true, guardados: 2 });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
  const cambios = [{ fecha: "2026-06-05", residenteId: "r1", codigo: "G" }];
  const r = await api.guardarAsignaciones(cambios);
  assert.equal(r.guardados, 2);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.cambios, cambios);
});

test("makeApi.listAsignacionesRango manda desde/hasta", async () => {
  const fetchImpl = fakeFetch(200, { ok: true, asignaciones: [] });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
  await api.listAsignacionesRango("2026-05-01", "2026-07-31");
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.action, "listAsignacionesRango");
  assert.equal(sent.desde, "2026-05-01");
  assert.equal(sent.hasta, "2026-07-31");
});

test("makeApi: acciones del Responsable mandan la action y el anio correctos", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
  await api.estadoResponsable(2027);
  await api.ofrecerseResponsable(2027);
  await api.retirarVoluntariadoResponsable(2027);
  await api.ejecutarSorteoResponsable(2027);
  await api.listResponsables();
  const acciones = fetchImpl.calls.map((c) => JSON.parse(c.init.body));
  assert.deepEqual(acciones.map((a) => a.action), [
    "estadoResponsable", "ofrecerseResponsable", "retirarVoluntariadoResponsable", "ejecutarSorteoResponsable", "listResponsables",
  ]);
  assert.equal(acciones[0].anio, 2027);
});

test("makeApi: acciones del ciclo de estados del cuadrante mandan anio/mes correctos", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
  await api.estadoCuadrante(2027, 7);
  await api.marcarValidado(2027, 7);
  await api.publicarCuadrante(2027, 7);
  await api.despublicarCuadrante(2027, 7);
  const acciones = fetchImpl.calls.map((c) => JSON.parse(c.init.body));
  assert.deepEqual(acciones.map((a) => a.action), [
    "estadoCuadrante", "marcarValidado", "publicarCuadrante", "despublicarCuadrante",
  ]);
  for (const a of acciones) { assert.equal(a.anio, 2027); assert.equal(a.mes, 7); }
});

// ── Reintento de fallos de TRANSPORTE (2026-08-05) ──
// El `/exec` de Apps Script responde 302 a un enlace de un solo uso; cuando el segundo salto falla
// llega HTML de Google con 404. Reproducido en producción: dos `login` idénticos y seguidos dieron
// 404 y 200, y el residente veía «HTTP 404» al entrar sin nada que hacer.
test("callBackend reintenta una acción idempotente si el transporte falla, y devuelve el éxito", async () => {
  const fetchImpl = fetchSecuencia({ status: 404 }, { status: 200, body: { ok: true, nonce: "n1" } });
  const r = await callBackend("https://exec.example/x", { action: "getNonce" }, { fetchImpl, esperar: sinEsperar });
  assert.deepEqual(r, { ok: true, nonce: "n1" });
  assert.equal(fetchImpl.calls.length, 2);
});

test("callBackend reintenta también ante excepción de red (el otro síntoma: el enlace no responde)", async () => {
  const fetchImpl = fetchSecuencia(new TypeError("Failed to fetch"), { status: 200, body: { ok: true } });
  const r = await callBackend("https://exec.example/x", { action: "login", idToken: "t", nonce: "n" }, { fetchImpl, esperar: sinEsperar });
  assert.equal(r.ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test("callBackend hace como máximo 3 intentos y devuelve un error que no es un número pelado", async () => {
  const fetchImpl = fetchSecuencia({ status: 404 }, { status: 404 }, { status: 404 }, { status: 200, body: { ok: true } });
  const r = await callBackend("https://exec.example/x", { action: "getNonce" }, { fetchImpl, esperar: sinEsperar });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 3, "3 intentos, no 4: el tope existe");
  assert.match(r.error, /Google/, "el residente no puede hacer nada con un «HTTP 404» pelado");
  assert.match(r.error, /404/, "pero el código sigue estando, para diagnosticar");
});

test("callBackend NO reintenta una ESCRITURA: duplicaría una fila en una tabla append-only", async () => {
  for (const action of ["guardarAsignaciones", "crearBloqueo", "guardarPeriodos", "editarResidente",
                        "restaurarPeriodos", "publicarCuadrante", "marcarValidado", "solicitarAlta", "solicitarInvitado", "resolverSolicitudInvitado",
                        "crearFestivos", "sortearEvento", "ejecutarSorteoResponsable", "registrarImaginaria"]) {
    const fetchImpl = fetchSecuencia({ status: 404 }, { status: 200, body: { ok: true } });
    const r = await callBackend("https://exec.example/x", { action }, { fetchImpl, esperar: sinEsperar });
    assert.equal(r.ok, false, `${action} no debe reintentarse`);
    assert.equal(fetchImpl.calls.length, 1, `${action} debe hacer UN solo intento`);
  }
});

test("callBackend NO reintenta un {ok:false} del servidor: es un rechazo de negocio, no transporte", async () => {
  // Repetirlo solo gasta el tiempo de quien espera: el veredicto es determinista.
  const fetchImpl = fetchSecuencia({ status: 200, body: { ok: false, error: "sesión caducada" } },
                                   { status: 200, body: { ok: true } });
  const r = await callBackend("https://exec.example/x", { action: "listResidentes" }, { fetchImpl, esperar: sinEsperar });
  assert.equal(r.ok, false);
  assert.equal(r.error, "sesión caducada");
  assert.equal(fetchImpl.calls.length, 1);
});

test("callBackend espera entre intentos, y con backoff creciente", async () => {
  const esperas = [];
  const fetchImpl = fetchSecuencia({ status: 404 }, { status: 404 }, { status: 200, body: { ok: true } });
  await callBackend("https://exec.example/x", { action: "getNonce" },
    { fetchImpl, esperar: async (ms) => { esperas.push(ms); } });
  assert.equal(esperas.length, 2);
  assert.ok(esperas[1] > esperas[0], `el backoff debe crecer: ${JSON.stringify(esperas)}`);
});

// ── sesión rechazada por el servidor (2026-09-04) ──
import { isSessionError } from "../api.js";

test("isSessionError reconoce SOLO los rechazos de sesión de router.js:authed", () => {
  for (const e of ["sesión expirada", "sesión firma", "sesión formato", "sesión payload"]) assert.equal(isSessionError(e), true, e);
  for (const e of ["solo el Responsable puede validar el cuadrante", "sesión caducada de otra cosa", "", undefined, "el token no identifica a ningún residente (¿es un token de alta?)"]) assert.equal(isSessionError(e), false, String(e));
});

test("makeApi avisa por onSessionInvalid cuando el servidor rechaza la sesión, y devuelve igualmente la respuesta", async () => {
  const fetchImpl = fakeFetch(200, { ok: false, error: "sesión expirada" });
  const avisos = [];
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok-viejo", onSessionInvalid: (e) => avisos.push(e) });
  const r = await api.listResidentes();
  assert.equal(r.ok, false);
  assert.deepEqual(avisos, ["sesión expirada"]);
});

test("makeApi NO avisa por un rechazo de negocio ni por un fallo de transporte", async () => {
  const avisos = [];
  const api1 = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(200, { ok: false, error: "solo el Responsable puede validar el cuadrante" }), getSession: () => "tok", onSessionInvalid: (e) => avisos.push(e) });
  await api1.marcarValidado(2027, 7);
  const api2 = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(500, {}), getSession: () => "tok", onSessionInvalid: (e) => avisos.push(e) });
  await api2.whoami();
  assert.deepEqual(avisos, []);
});

test("generarCuadranteIA manda el modo (completar por defecto) — decisión V-47", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok" });
  await api.generarCuadranteIA(2027, 7);
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).modo, "completar");
  await api.generarCuadranteIA(2027, 7, "reemplazar");
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).modo, "reemplazar");
});

test("solicitarInvitado manda el pendingToken; estadoSolicitudInvitado el solicitudToken (V-53)", async () => {
  const cuerpos = [];
  const api = makeApi("https://x/exec", { fetchImpl: async (_u, init) => { cuerpos.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) }; } });
  await api.solicitarInvitado("tok");
  await api.estadoSolicitudInvitado("sol");
  assert.deepEqual(cuerpos[0], { action: "solicitarInvitado", pendingToken: "tok" });
  assert.deepEqual(cuerpos[1], { action: "estadoSolicitudInvitado", solicitudToken: "sol" });
});

test("generarCuadranteIA solo manda `fase` cuando no es la de siempre (P-17/V-59)", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok" });
  await api.generarCuadranteIA(2027, 7);
  assert.equal("fase" in JSON.parse(fetchImpl.calls[0].init.body), false);
  await api.generarCuadranteIA(2027, 7, "completar", "extras");
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).fase, "extras");
});

// ── Contrato de las respuestas (2026-10-07, aviso del autor: «TypeError: Cannot read properties of
// undefined (reading 'length')» en SolicitudesAcceso, junto a un 404 de
// script.googleusercontent.com/macros/echo). La pantalla hacía `if (r.ok) setLista(r.solicitudes)`:
// basta un `ok:true` sin la lista para que el render reviente. El adaptador garantiza ahora que
// `ok:true` trae SIEMPRE el array, y que todo lo demás es `{ok:false, error}` con un texto legible.

// El salto del `/exec` a script.googleusercontent.com que termina en 404 (V-26): página HTML de Google.
const respuesta404 = { status: 404, body: "<!DOCTYPE html><html>404. That’s an error.</html>" };
// Lo que `res.json()` hace en un navegador con una página HTML en vez de JSON.
function fetchHtml(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); } };
  };
  fn.calls = calls;
  return fn;
}

test("404 de Google en el salto del /exec: tras los reintentos, {ok:false} con un error legible — nunca undefined", async () => {
  const fetchImpl = fetchSecuencia(respuesta404, respuesta404, respuesta404);
  const r = await callBackend("https://exec.example/x", { action: "listSolicitudesInvitado", session: "s" }, { fetchImpl, esperar: sinEsperar });
  assert.equal(fetchImpl.calls.length, 3, "es una lectura: se reintenta");
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
  assert.match(r.error, /404/);
});

test("HTML en vez de JSON (página de error de Apps Script con 200): {ok:false} que lo dice, no el SyntaxError del parser", async () => {
  const fetchImpl = fetchHtml(200);
  const r = await callBackend("https://exec.example/x", { action: "listSolicitudesInvitado", session: "s" }, { fetchImpl, esperar: sinEsperar });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 3, "una página en vez de datos es un fallo de transporte: se reintenta como el 404");
  assert.match(r.error, /servidor de Google/);
  assert.doesNotMatch(r.error, /Unexpected token|is not valid JSON/, "el residente no puede hacer nada con el texto del parser");
});

test("un JSON que no es un objeto ({ok,…}) no se entrega tal cual: {ok:false}", async () => {
  for (const body of [null, "hola", 42, [1, 2]]) {
    const r = await callBackend("https://exec.example/x", { action: "x" }, { fetchImpl: fakeFetch(200, body) });
    assert.equal(r.ok, false, `cuerpo ${JSON.stringify(body)}`);
    assert.equal(typeof r.error, "string");
  }
});

test("listSolicitudesInvitado: respuesta válida → ok:true con su array, tal cual", async () => {
  const solicitudes = [{ id: "s1", email: "x@y.com", tipo: "INVITADO" }];
  const api = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(200, { ok: true, solicitudes }), getSession: () => "s" });
  const r = await api.listSolicitudesInvitado();
  assert.equal(r.ok, true);
  assert.deepEqual(r.solicitudes, solicitudes);
});

test("listSolicitudesInvitado: ok:true SIN el array (o con otra cosa) es un error explícito, nunca una lista undefined", async () => {
  for (const body of [{ ok: true }, { ok: true, solicitudes: null }, { ok: true, solicitudes: "x" }]) {
    const api = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(200, body), getSession: () => "s" });
    const r = await api.listSolicitudesInvitado();
    assert.equal(r.ok, false, `cuerpo ${JSON.stringify(body)}`);
    assert.match(r.error, /solicitudes/);
  }
});

test("listSolicitudesInvitado con el backend caído (404) o devolviendo HTML: {ok:false, error}, sin campo solicitudes", async () => {
  for (const fetchImpl of [fetchSecuencia(respuesta404, respuesta404, respuesta404), fetchHtml(200)]) {
    const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "s" });
    const r = await api.listSolicitudesInvitado();
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
    assert.equal(r.solicitudes, undefined);
  }
});

test("el mismo contrato en todas las lecturas de listas: ok:true sin su array es {ok:false}", async () => {
  const casos = [
    ["listResidentes", [], "residentes"],
    ["listAsignaciones", [2026, 10], "asignaciones"],
    ["listAsignacionesRango", ["2026-10-01", "2026-10-31"], "asignaciones"],
    ["listPreferencias", [2026, 10], "preferencias"],
    ["misBloqueos", [2026, 10], "bloqueos"],
    ["listBloqueos", [2026, 10], "bloqueos"],
    ["listBloqueosRango", ["2026-10-01", "2026-10-31"], "bloqueos"],
    ["listFestivosRango", ["2026-01-01", "2026-12-31"], "festivos"],
    ["listEventos", [], "eventos"],
    ["listExcepciones", [], "excepciones"],
    ["colaImaginaria", ["PEQUENO", "2026-10-07"], "cola"],
    ["listResponsables", [], "mandatos"],
  ];
  for (const [metodo, args, campo] of casos) {
    const roto = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(200, { ok: true }), getSession: () => "s" });
    const r = await roto[metodo](...args);
    assert.equal(r.ok, false, `${metodo} sin «${campo}»`);
    assert.match(r.error, new RegExp(campo));
    const sano = makeApi("https://exec.example/x", { fetchImpl: fakeFetch(200, { ok: true, [campo]: [] }), getSession: () => "s" });
    assert.deepEqual(await sano[metodo](...args), { ok: true, [campo]: [] }, `${metodo} con su array vacío pasa tal cual`);
  }
});

// ── lecturas en lote (S-9) ────────────────────────────────────────────────────────────────────

/** `fetch` falso que contesta a un `lote` con un resultado por llamada y al resto con `{ok:true}`. */
function fetchConLote() {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const json = body.action === "lote"
      ? { ok: true, resultados: body.llamadas.map((l) => ({ ok: true, eco: l.action, residentes: [], bloqueos: [], festivos: [] })) }
      : { ok: true, eco: body.action, residentes: [] };
    return { ok: true, status: 200, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test("S-9: lecturas pedidas a la vez viajan en UNA petición `lote` y cada una recibe lo suyo", async () => {
  const fetchImpl = fetchConLote();
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok", ventanaLoteMs: 0 });
  const [a, b, c] = await Promise.all([api.estadoCuadrante(2027, 7), api.estadoResponsable(2027), api.listResidentes()]);
  assert.equal(fetchImpl.calls.length, 1, "una sola ida y vuelta");
  assert.equal(fetchImpl.calls[0].action, "lote");
  assert.equal(fetchImpl.calls[0].session, "tok");
  assert.deepEqual(fetchImpl.calls[0].llamadas, [
    { action: "estadoCuadrante", anio: 2027, mes: 7 }, { action: "estadoResponsable", anio: 2027 }, { action: "listResidentes" },
  ]);
  assert.deepEqual([a.eco, b.eco, c.eco], ["estadoCuadrante", "estadoResponsable", "listResidentes"]);
});

test("S-9: una lectura sola se manda como siempre y una escritura nunca entra en un lote", async () => {
  const fetchImpl = fetchConLote();
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok", ventanaLoteMs: 0 });
  await Promise.all([api.estadoCuadrante(2027, 7), api.guardarAsignaciones([{ fecha: "2027-07-01", residenteId: "r", codigo: "G" }])]);
  assert.deepEqual(fetchImpl.calls.map((c) => c.action).sort(), ["estadoCuadrante", "guardarAsignaciones"]);
});

test("S-9: un servidor que aún no conoce `lote` hace que se manden por separado, sin perder ninguna", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.action);
    const json = body.action === "lote" ? { ok: false, error: "acción desconocida: lote" } : { ok: true, eco: body.action, residentes: [] };
    return { ok: true, status: 200, json: async () => json };
  };
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok", ventanaLoteMs: 0 });
  const [a, b] = await Promise.all([api.estadoCuadrante(2027, 7), api.estadoResponsable(2027)]);
  assert.deepEqual([a.eco, b.eco], ["estadoCuadrante", "estadoResponsable"]);
  assert.deepEqual(calls, ["lote", "estadoCuadrante", "estadoResponsable"]);
  await Promise.all([api.estadoCuadrante(2027, 8), api.estadoResponsable(2028)]);
  assert.equal(calls.filter((x) => x === "lote").length, 1, "no vuelve a probar el lote");
});

test("S-9: el rechazo de sesión de un lote llega a cada lectura y avisa una vez por cada una", async () => {
  const avisos = [];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "sesión expirada" }) });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok", ventanaLoteMs: 0, onSessionInvalid: (e) => avisos.push(e) });
  const [a, b] = await Promise.all([api.estadoCuadrante(2027, 7), api.listEventos()]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.match(a.error, /sesión expirada/);
  assert.ok(avisos.length >= 1);
});

test("S-9: las listas siguen exigidas dentro de un lote", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, resultados: [{ ok: true }, { ok: true, eventos: [] }] }) });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => "tok", ventanaLoteMs: 0 });
  const [a, b] = await Promise.all([api.listResidentes(), api.listEventos()]);
  assert.equal(a.ok, false, "falta la lista de residentes");
  assert.equal(b.ok, true);
});

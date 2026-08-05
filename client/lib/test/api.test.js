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
  assert.match(r.error, /Failed to fetch/);
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

test("makeApi.altaResidente soporta idToken+nonce o pendingToken", async () => {
  const fetchImpl = fakeFetch(200, { ok: true });
  const api = makeApi("https://exec.example/x", { fetchImpl, getSession: () => null });

  await api.altaResidente({ idToken: "jwt", nonce: "n1" }, { nombre: "Ana", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" });
  let sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.idToken, "jwt");
  assert.equal(sent.nombre, "Ana");

  await api.altaResidente({ pendingToken: "ptok" }, { nombre: "Bea", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" });
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
                        "restaurarPeriodos", "publicarCuadrante", "marcarValidado", "altaResidente",
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

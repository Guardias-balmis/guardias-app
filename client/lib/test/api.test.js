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

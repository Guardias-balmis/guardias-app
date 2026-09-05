// Tests de client/lib/auth.js — orquestación de "Sign in with Google" (GIS). Se inyectan
// `api` y `gis` falsos: nada de esto toca la red ni el DOM real. El objeto `gis` real es
// `google.accounts.id`, cargado por index.html vía CDN — aquí lo simulamos.
import test from "node:test";
import assert from "node:assert/strict";
import { setupGoogleSignIn, submitAlta, getSession, storeSession, clearSession } from "../auth.js";

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

// ── sesión en sessionStorage (no localStorage: cero secretos persistentes — ADR-001 §3) ──
test("storeSession / getSession / clearSession hacen round-trip sobre el storage inyectado", () => {
  const storage = fakeStorage();
  assert.equal(getSession(storage), null);
  storeSession({ session: "tok", residente: { id: "r1", nombre: "Ana", rol: "residente" } }, storage);
  const s = getSession(storage);
  assert.equal(s.session, "tok");
  assert.equal(s.residente.nombre, "Ana");
  clearSession(storage);
  assert.equal(getSession(storage), null);
});

test("getSession tolera storage corrupto sin lanzar", () => {
  const storage = fakeStorage();
  storage.setItem("guardias_session", "esto no es json");
  assert.equal(getSession(storage), null);
});

// ── flujo de login: nonce -> gis.initialize -> callback -> api.login ──
function fakeGis() {
  const calls = { initialize: null, renderButton: null };
  return {
    initialize: (cfg) => { calls.initialize = cfg; },
    renderButton: (el, opts) => { calls.renderButton = { el, opts }; },
    _calls: calls,
    _fireCredential: (credential) => calls.initialize.callback({ credential }),
  };
}
function fakeApi(overrides = {}) {
  return {
    getNonce: async () => ({ ok: true, nonce: "server-nonce" }),
    login: async () => ({ ok: true, session: "sess-1", residente: { id: "r1", nombre: "Ana", rol: "residente" } }),
    ...overrides,
  };
}

test("setupGoogleSignIn pide un nonce ANTES de inicializar GIS, y se lo pasa", async () => {
  const gis = fakeGis();
  const api = fakeApi();
  const storage = fakeStorage();
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage, onSuccess() {}, onNeedsAlta() {}, onError() {} });
  assert.equal(gis._calls.initialize.client_id, "cid");
  assert.equal(gis._calls.initialize.nonce, "server-nonce");
  assert.ok(gis._calls.renderButton);
});

test("login correcto: guarda la sesión y llama onSuccess con el residente", async () => {
  const gis = fakeGis();
  const storage = fakeStorage();
  let success = null;
  const api = fakeApi();
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage, onSuccess: (r) => (success = r), onNeedsAlta() {}, onError() {} });
  await gis._fireCredential("id-token-real");
  assert.equal(success.residente.nombre, "Ana");
  assert.equal(getSession(storage).session, "sess-1");
});

test("login con email no vinculado: NO guarda sesión, llama onNeedsAlta con el pendingToken (sin relanzar Google)", async () => {
  const gis = fakeGis();
  const storage = fakeStorage();
  let needsAlta = null;
  const api = fakeApi({ login: async () => ({ ok: false, error: "email no vinculado a ningún residente", pendingToken: "ptok" }) });
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage, onSuccess() {}, onNeedsAlta: (info) => (needsAlta = info), onError() {} });
  await gis._fireCredential("id-token-real");
  assert.equal(needsAlta.pendingToken, "ptok");
  assert.equal(getSession(storage), null);
});

test("login con error genuino (aud incorrecta, etc.) llama onError, no onNeedsAlta", async () => {
  const gis = fakeGis();
  let error = null, needsAlta = null;
  const api = fakeApi({ login: async () => ({ ok: false, error: "aud incorrecta" }) });
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta: () => (needsAlta = true), onError: (e) => (error = e) });
  await gis._fireCredential("id-token-real");
  assert.equal(error, "aud incorrecta");
  assert.equal(needsAlta, null);
});

// ── alta ──
test("submitAlta guarda la sesión devuelta y llama onSuccess", async () => {
  const storage = fakeStorage();
  let success = null;
  const api = { altaResidente: async () => ({ ok: true, session: "sess-2", residente: { id: "r2", nombre: "Nuevo", rol: "residente" } }) };
  await submitAlta({ api, identidad: { pendingToken: "ptok" }, datos: { nombre: "Nuevo", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, storage, onSuccess: (r) => (success = r), onError() {} });
  assert.equal(success.residente.nombre, "Nuevo");
  assert.equal(getSession(storage).session, "sess-2");
});

test("submitAlta con error del servidor llama onError y no toca el storage", async () => {
  const storage = fakeStorage();
  let error = null;
  const api = { altaResidente: async () => ({ ok: false, error: "ese email ya está vinculado a un residente" }) };
  await submitAlta({ api, identidad: { pendingToken: "ptok" }, datos: { nombre: "X", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, storage, onSuccess() {}, onError: (e) => (error = e) });
  assert.match(error, /vinculad/i);
  assert.equal(getSession(storage), null);
});

// ── nonce adelantado, refresco y GIS tardío (2026-09-04) ──
import { prefetchNonce, waitForGis, _resetNoncePrefetch } from "../auth.js";

test("setupGoogleSignIn CONSUME el nonce adelantado por prefetchNonce en vez de pedir otro", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const api = fakeApi({ getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }) });
  prefetchNonce(api);
  const gis = fakeGis();
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError() {} });
  assert.equal(pedidos, 1, "un solo nonce: el adelantado");
  assert.equal(gis._calls.initialize.nonce, "n-1");
});

test("el nonce adelantado se consume UNA sola vez: el siguiente setup pide uno nuevo", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const api = fakeApi({ getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }) });
  prefetchNonce(api);
  const comun = { api, clientId: "cid", buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError() {} };
  await setupGoogleSignIn({ ...comun, gis: fakeGis() });
  const gis2 = fakeGis();
  await setupGoogleSignIn({ ...comun, gis: gis2 });
  assert.equal(pedidos, 2);
  assert.equal(gis2._calls.initialize.nonce, "n-2");
});

test("refrescar() pide otro nonce, reinicializa GIS y vuelve a pintar el botón", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const api = fakeApi({ getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }) });
  const gis = fakeGis();
  let pintados = 0;
  gis.renderButton = (el, opts) => { pintados++; gis._calls.renderButton = { el, opts }; };
  const asa = await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError() {} });
  assert.equal(await asa.refrescar(), true);
  assert.equal(pedidos, 2);
  assert.equal(gis._calls.initialize.nonce, "n-2", "GIS queda con el nonce nuevo");
  assert.equal(pintados, 2, "el botón lleva el nonce dentro: hay que repintarlo");
});

test("un login rechazado por nonce reinicializa con uno nuevo y lo explica en llano", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const gis = fakeGis();
  let error = null;
  const api = fakeApi({
    getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }),
    login: async () => ({ ok: false, error: "nonce reusado o desconocido" }),
  });
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError: (e) => (error = e) });
  await gis._fireCredential("id-token");
  assert.match(error, /caducó/);
  assert.equal(pedidos, 2, "hay un nonce nuevo listo para el siguiente clic");
  assert.equal(gis._calls.initialize.nonce, "n-2");
});

test("cualquier otro fallo de login también deja un nonce nuevo (el anterior ya se gastó)", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const gis = fakeGis();
  let error = null;
  const api = fakeApi({
    getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }),
    login: async () => ({ ok: false, error: "aud incorrecta" }),
  });
  await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError: (e) => (error = e) });
  await gis._fireCredential("id-token");
  assert.equal(error, "aud incorrecta", "el mensaje real se conserva");
  assert.equal(pedidos, 2);
});

test("sin nonce (backend caído) setupGoogleSignIn devuelve null y avisa, sin tocar GIS", async () => {
  _resetNoncePrefetch();
  const gis = fakeGis();
  let error = null;
  const api = fakeApi({ getNonce: async () => ({ ok: false, error: "el servidor de Google no respondió bien (HTTP 404)" }) });
  const asa = await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError: (e) => (error = e) });
  assert.equal(asa, null);
  assert.match(error, /404/);
  assert.equal(gis._calls.initialize, null);
});

test("storeSession guarda SOLO sesión y perfil: la lista de residentes que trae el login no se persiste", () => {
  const storage = fakeStorage();
  storeSession({ session: "tok", residente: { id: "r1", nombre: "Ana", rol: "residente" }, residentes: [{ id: "r1" }, { id: "r2" }] }, storage);
  assert.deepEqual(getSession(storage), { session: "tok", residente: { id: "r1", nombre: "Ana", rol: "residente" } });
});

test("waitForGis espera a que el script de Google esté y devuelve el objeto", async () => {
  let veces = 0;
  const gis = await waitForGis({ getGis: () => (++veces >= 3 ? { initialize() {}, renderButton() {} } : undefined), intervaloMs: 1, esperar: async () => {} });
  assert.ok(gis);
  assert.equal(veces, 3);
});

test("waitForGis se rinde pasado el tope y devuelve null (para decirlo en pantalla, no esperar en silencio)", async () => {
  let t = 0;
  const gis = await waitForGis({ getGis: () => undefined, intervaloMs: 100, maxMs: 250, esperar: async () => { t += 100; } });
  assert.equal(gis, null);
  assert.ok(t >= 200, "sondeó varias veces antes de rendirse");
});

test("cada nonce va ligado a su callback: un login que empezó con N1 sigue mandando N1 aunque el refresco haya pasado a N2", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const recibidos = [];
  const gis = fakeGis();
  const api = fakeApi({
    getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }),
    login: async (credential, nonce) => { recibidos.push(nonce); return { ok: true, session: "s", residente: { id: "r1", nombre: "Ana", rol: "residente" } }; },
  });
  const asa = await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl: {}, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError() {} });
  const primera = gis._calls.initialize; // la configuración que GIS tenía cuando la persona pulsó
  assert.equal(primera.nonce, "n-1");
  await asa.refrescar(); // el temporizador pasa a n-2 con el selector de cuentas aún abierto
  assert.equal(gis._calls.initialize.nonce, "n-2");
  await primera.callback({ credential: "token-acuñado-con-n-1" });
  assert.deepEqual(recibidos, ["n-1"], "el token lleva n-1 dentro: se manda n-1, no el nonce nuevo");
});

test("cada repintado del botón de Google vacía el contenedor antes (el renderButton real AÑADE, no sustituye)", async () => {
  _resetNoncePrefetch();
  let pedidos = 0;
  const api = fakeApi({ getNonce: async () => ({ ok: true, nonce: `n-${++pedidos}` }) });
  const gis = fakeGis();
  // Contenedor que imita al DOM: renderButton apila un hijo; replaceChildren lo vacía.
  const buttonEl = { children: [], replaceChildren() { this.children = []; } };
  gis.renderButton = (el) => { el.children.push("boton"); };
  const asa = await setupGoogleSignIn({ api, clientId: "cid", gis, buttonEl, storage: fakeStorage(), onSuccess() {}, onNeedsAlta() {}, onError() {} });
  await asa.refrescar();
  await asa.refrescar();
  assert.equal(buttonEl.children.length, 1, "un solo botón tras dos refrescos");
});

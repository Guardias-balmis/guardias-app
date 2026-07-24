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

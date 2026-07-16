// Tests de server/src/verify-token.js — verificación del ID token de Google (ADR-002 D-2, 2.2).
// Lógica PURA sobre la respuesta ya parseada de tokeninfo. La llamada de red (UrlFetchApp) es
// un adaptador aparte. tokeninfo valida firma/iss/exp, pero NO la audiencia: por eso el chequeo
// de `aud` es obligatorio y es el fallo estrella (sin él se acepta un token de cualquier app).
import test from "node:test";
import assert from "node:assert/strict";
import { verifyTokeninfo } from "../src/verify-token.js";

const CLIENT_ID = "526410201682-abc.apps.googleusercontent.com";
const NOW = 1_000_000;

// Respuesta válida de referencia (email_verified llega como string "true" desde tokeninfo).
const ok = () => ({
  aud: CLIENT_ID,
  iss: "https://accounts.google.com",
  email: "Quique@Gmail.com",
  email_verified: "true",
  sub: "104567890",
  exp: String(NOW + 3600),
  nonce: "nonce-abc",
});

// consumeNonce que acepta un nonce una sola vez.
function oneShotNonce(valid) {
  const used = new Set();
  return (n) => {
    if (!valid.has(n) || used.has(n)) return false;
    used.add(n);
    return true;
  };
}

test("token válido → ok, email en minúsculas, sub presente", () => {
  const r = verifyTokeninfo(ok(), { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) });
  assert.equal(r.ok, true);
  assert.equal(r.email, "quique@gmail.com"); // normalizado a minúsculas (el v1 tenía bug de case)
  assert.equal(r.sub, "104567890");
});

test("FALLO ESTRELLA: aud de otra app se rechaza", () => {
  const claims = ok();
  claims.aud = "999-otraapp.apps.googleusercontent.com";
  const r = verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /aud/i);
});

test("iss inválida se rechaza; se aceptan las dos formas oficiales", () => {
  for (const iss of ["accounts.google.com", "https://accounts.google.com"]) {
    const claims = ok(); claims.iss = iss;
    assert.equal(verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) }).ok, true);
  }
  const bad = ok(); bad.iss = "https://evil.example.com";
  assert.equal(verifyTokeninfo(bad, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) }).ok, false);
});

test("email no verificado se rechaza (string 'false' y booleano false)", () => {
  for (const v of ["false", false]) {
    const claims = ok(); claims.email_verified = v;
    const r = verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /verificad/i);
  }
});

test("email_verified booleano true también se acepta", () => {
  const claims = ok(); claims.email_verified = true;
  assert.equal(verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) }).ok, true);
});

test("token expirado se rechaza (exp inclusive)", () => {
  const claims = ok(); claims.exp = String(NOW);
  assert.equal(verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) }).ok, false);
  const future = ok(); future.exp = String(NOW + 1);
  assert.equal(verifyTokeninfo(future, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set(["nonce-abc"])) }).ok, true);
});

test("nonce reusado se rechaza (anti-replay)", () => {
  const consume = oneShotNonce(new Set(["nonce-abc"]));
  assert.equal(verifyTokeninfo(ok(), { clientId: CLIENT_ID, now: NOW, consumeNonce: consume }).ok, true);
  assert.equal(verifyTokeninfo(ok(), { clientId: CLIENT_ID, now: NOW, consumeNonce: consume }).ok, false); // segundo uso
});

test("nonce ausente se rechaza cuando se exige nonce", () => {
  const claims = ok(); delete claims.nonce;
  const r = verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW, consumeNonce: oneShotNonce(new Set()) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nonce/i);
});

test("respuesta vacía o no-objeto se rechaza sin lanzar", () => {
  for (const bad of [null, undefined, "string", 42]) {
    assert.equal(verifyTokeninfo(bad, { clientId: CLIENT_ID, now: NOW }).ok, false);
  }
});

test("sin consumeNonce (nonce no exigido) valida el resto igualmente", () => {
  const claims = ok(); delete claims.nonce;
  const r = verifyTokeninfo(claims, { clientId: CLIENT_ID, now: NOW });
  assert.equal(r.ok, true);
});

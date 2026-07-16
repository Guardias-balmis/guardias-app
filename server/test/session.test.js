// Tests de server/src/session.js — token de sesión HMAC (ADR-002 D-2, paso 2.1).
// Lógica pura: el HMAC y el base64url se inyectan (Node aquí; Utilities en Apps Script).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { issueSession, verifySession } from "../src/session.js";

// Primitivas criptográficas inyectadas (en Apps Script: Utilities.computeHmacSha256Signature + base64EncodeWebSafe).
const crypto = {
  hmac: (msg, secret) => nodeCrypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64url"),
  b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
  b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
};
const SECRET = "secreto-de-servicio-autogenerado-xxxxxxxx";
const CLAIMS = { sub: "uuid-residente-123", rol: "responsable" };

test("una sesión emitida se valida y recupera los claims", () => {
  const token = issueSession(CLAIMS, { now: 1000, ttlSeconds: 3600, secret: SECRET, crypto });
  const r = verifySession(token, { now: 1500, secret: SECRET, crypto });
  assert.equal(r.valid, true);
  assert.equal(r.payload.sub, "uuid-residente-123");
  assert.equal(r.payload.rol, "responsable");
  assert.equal(r.payload.exp, 1000 + 3600);
});

test("sesión expirada se rechaza (en el instante exacto de exp y después)", () => {
  const token = issueSession(CLAIMS, { now: 1000, ttlSeconds: 100, secret: SECRET, crypto });
  assert.equal(verifySession(token, { now: 1099, secret: SECRET, crypto }).valid, true);
  assert.equal(verifySession(token, { now: 1100, secret: SECRET, crypto }).valid, false); // exp inclusive
  assert.equal(verifySession(token, { now: 5000, secret: SECRET, crypto }).reason, "expirada");
});

test("firma manipulada se rechaza", () => {
  const token = issueSession(CLAIMS, { now: 1000, ttlSeconds: 3600, secret: SECRET, crypto });
  const [payload, sig] = token.split(".");
  const tampered = payload + "." + sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
  assert.equal(verifySession(tampered, { now: 1500, secret: SECRET, crypto }).valid, false);
});

test("payload manipulado (escalada de rol) se rechaza: la firma ya no casa", () => {
  const token = issueSession({ sub: "x", rol: "residente" }, { now: 1000, ttlSeconds: 3600, secret: SECRET, crypto });
  const [, sig] = token.split(".");
  const forgedPayload = crypto.b64urlEncode(JSON.stringify({ sub: "x", rol: "responsable", exp: 4600 }));
  const forged = forgedPayload + "." + sig;
  assert.equal(verifySession(forged, { now: 1500, secret: SECRET, crypto }).valid, false);
});

test("secreto distinto (p.ej. tras regenerarse) invalida las sesiones previas", () => {
  const token = issueSession(CLAIMS, { now: 1000, ttlSeconds: 3600, secret: SECRET, crypto });
  const r = verifySession(token, { now: 1500, secret: "otro-secreto-distinto", crypto });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "firma");
});

test("formato inválido se rechaza sin lanzar", () => {
  for (const bad of ["", "sinpunto", "a.b.c", ".", "payload.", ".sig"]) {
    const r = verifySession(bad, { now: 1500, secret: SECRET, crypto });
    assert.equal(r.valid, false);
  }
});

test("payload que no es JSON válido se rechaza sin lanzar", () => {
  const payload = crypto.b64urlEncode("esto no es json");
  const sig = crypto.hmac(payload, SECRET);
  const r = verifySession(payload + "." + sig, { now: 1500, secret: SECRET, crypto });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "payload");
});

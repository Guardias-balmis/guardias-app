// Token de sesión HMAC-SHA256 (ADR-002 D-2, paso 2.1). Puro y sin I/O: las primitivas
// (`hmac`, `b64urlEncode`, `b64urlDecode`) se inyectan — en Node con `crypto`, en Apps Script
// con `Utilities.computeHmacSha256Signature` + `Utilities.base64EncodeWebSafe`.
//
// El token es `base64url(payloadJSON).base64url(HMAC(payload, secreto))`. Tras verificar el
// ID token de Google UNA vez por login, el servidor emite esta sesión; las siguientes
// peticiones se validan en local con el HMAC, sin volver a tocar la red. El secreto se
// autogenera y vive solo en PropertiesService; rotarlo simplemente re-loguea a todos.
//
// Regla de seguridad: los claims van FIRMADOS pero NO cifrados — no meter nada sensible;
// solo el UUID del residente (`sub`), el rol y `exp`.

/**
 * @param {object} claims  p.ej. { sub: uuid, rol }
 * @param {{now:number, ttlSeconds:number, secret:string, crypto:object}} opts
 * @returns {string} token `payload.sig`
 */
export function issueSession(claims, { now, ttlSeconds, secret, crypto }) {
  const payload = { ...claims, exp: now + ttlSeconds };
  const payloadB64 = crypto.b64urlEncode(JSON.stringify(payload));
  const sig = crypto.hmac(payloadB64, secret);
  return payloadB64 + "." + sig;
}

/**
 * @param {string} token
 * @param {{now:number, secret:string, crypto:object}} opts
 * @returns {{valid:boolean, payload?:object, reason?:string}}
 */
export function verifySession(token, { now, secret, crypto }) {
  if (typeof token !== "string") return invalid("formato");
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return invalid("formato");
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Comparación en tiempo (casi) constante: Apps Script no trae crypto.timingSafeEqual.
  const expected = crypto.hmac(payloadB64, secret);
  if (!timingSafeEqual(sig, expected)) return invalid("firma");

  let payload;
  try {
    payload = JSON.parse(crypto.b64urlDecode(payloadB64));
  } catch {
    return invalid("payload");
  }
  if (!payload || typeof payload.exp !== "number") return invalid("payload");
  if (now >= payload.exp) return invalid("expirada");

  return { valid: true, payload };
}

function invalid(reason) {
  return { valid: false, reason };
}

/** Comparación de strings resistente a timing: recorre SIEMPRE la longitud del esperado. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

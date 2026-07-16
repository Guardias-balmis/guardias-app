// Verificación del ID token de Google (ADR-002 D-2, paso 2.2). PURA: opera sobre la respuesta
// ya parseada de `https://oauth2.googleapis.com/tokeninfo?id_token=…`. La llamada de red
// (`UrlFetchApp` con reintentos + backoff) es un adaptador aparte.
//
// CLAVE DE SEGURIDAD: tokeninfo valida firma, `iss` y `exp`, pero **NO la audiencia**. El
// chequeo `aud === CLIENT_ID` es OBLIGATORIO y es el fallo estrella: sin él se aceptaría un
// ID token emitido para cualquier otra app OAuth del ecosistema Google → suplantación total.

const ISS_VALIDOS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/**
 * @param {object} claims respuesta parseada de tokeninfo
 * @param {{clientId:string, now:number, consumeNonce?:(nonce:string)=>boolean}} opts
 *   consumeNonce (si se pasa) exige un nonce de un solo uso (anti-replay del login).
 * @returns {{ok:boolean, email?:string, sub?:string, reason?:string}}
 */
export function verifyTokeninfo(claims, { clientId, now, consumeNonce }) {
  if (!claims || typeof claims !== "object") return fail("respuesta vacía o inválida");

  // 1. Audiencia — el chequeo que tokeninfo NO hace por ti. Imprescindible.
  if (claims.aud !== clientId) return fail("aud incorrecta (token emitido para otra app)");

  // 2. Emisor.
  if (!ISS_VALIDOS.has(claims.iss)) return fail("iss inválida");

  // 3. Email verificado (tokeninfo lo devuelve como string "true").
  if (claims.email_verified !== true && claims.email_verified !== "true") return fail("email no verificado");

  // 4. Expiración re-chequeada en local (cinturón y tirantes; llega como string).
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || now >= exp) return fail("token expirado");

  // 5. Nonce de un solo uso (si se exige).
  if (consumeNonce) {
    if (!claims.nonce) return fail("falta nonce");
    if (!consumeNonce(claims.nonce)) return fail("nonce reusado o desconocido");
  }

  // Email normalizado a minúsculas: es la clave para resolver el residente y NO debe fallar
  // por diferencias de mayúsculas (el cliente v1 tenía justo ese bug, index.html:188).
  return { ok: true, email: String(claims.email || "").toLowerCase(), sub: claims.sub };
}

function fail(reason) {
  return { ok: false, reason };
}

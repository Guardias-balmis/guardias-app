// Orquestación de "Sign in with Google" (GIS) y ciclo de vida de la sesión (ADR-002 D-2).
//
// La sesión (token HMAC + perfil mínimo) vive en `sessionStorage`, NO `localStorage`: se
// borra al cerrar la pestaña. No es un secreto de terceros (es un token propio, de TTL
// corto, que solo autoriza llamadas a este backend) pero persistirlo indefinidamente no
// aporta nada y sessionStorage es un límite más prudente por defecto.
//
// Flujo de login (antirreplay, ADR-002 D-2 punto 5): se pide un nonce AL SERVIDOR antes de
// inicializar GIS, y se lo pasamos a `initialize({nonce})` — así el ID token que Google
// firme incluye ese nonce, y el servidor lo consume una sola vez al verificar.
//
// TRES COSAS QUE EL NONCE OBLIGA A CUIDAR (2026-09-04, a raíz del pedido de «más velocidad al
// meter el correo con Google»), todas aquí y no en la pantalla, para que se puedan probar:
//  - Pedirlo es una ida y vuelta entera a Apps Script (más su arranque en frío), y el botón de
//    Google no se puede pintar sin él. `prefetchNonce` deja que el cargador lo pida ANTES de que
//    exista la pantalla de login; `setupGoogleSignIn` consume esa promesa si la hay.
//  - Vive 5 minutos en el servidor (CacheService, Code.gs). Quien deja la pantalla de login
//    abierta y vuelve más tarde tenía un botón que fallaba con «nonce reusado o desconocido» y
//    ninguna salida salvo recargar. Ahora `refrescar()` pide otro y vuelve a inicializar GIS (y a
//    pintar el botón, que lleva la configuración dentro); la pantalla lo llama cada pocos minutos
//    y al volver a la pestaña.
//  - Se CONSUME en cada intento de login, también en los que fallan después de verificarlo
//    (email sin vincular → alta; residente que no resuelve). Tras cualquier fallo se vuelve a
//    inicializar con uno nuevo, o el segundo clic estaba condenado antes de darse.
//
// `gis` es el objeto real `google.accounts.id` (cargado por <script src=".../gsi/client">
// en index.html) o un doble de test con la misma forma: {initialize(cfg), renderButton(el,opts)}.

const SESSION_KEY = "guardias_session";

export function getSession(storage = sessionStorage) {
  try {
    return JSON.parse(storage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}
/**
 * Guarda SOLO lo que la sesión necesita (token + perfil mínimo). `login`/`altaResidente`
 * devuelven además la lista de residentes para ahorrarle al arranque una ida y vuelta; esa
 * lista es estado de la app, no de la sesión, y no se persiste aquí.
 */
export function storeSession(data, storage = sessionStorage) {
  storage.setItem(SESSION_KEY, JSON.stringify({ session: data.session, residente: data.residente }));
}
export function clearSession(storage = sessionStorage) {
  storage.removeItem(SESSION_KEY);
}

// ── nonce ──────────────────────────────────────────────────────────────────────────────────
let noncePendiente = null;

/**
 * Pide un nonce YA y guarda la promesa para que el siguiente `setupGoogleSignIn` la consuma en
 * vez de pedir otro. Idempotente: si ya hay uno en vuelo, devuelve ese. Nunca lanza (api.js no
 * lanza). Lo invoca client/loader.js en la primera línea del arranque.
 */
export function prefetchNonce(api) {
  if (!noncePendiente) noncePendiente = api.getNonce();
  return noncePendiente;
}

/** Toma el nonce adelantado si lo hay (una sola vez) o pide uno nuevo. */
function tomarNonce(api) {
  const p = noncePendiente || api.getNonce();
  noncePendiente = null;
  return p;
}

/** Solo para tests: olvida un nonce adelantado de un caso anterior. */
export function _resetNoncePrefetch() {
  noncePendiente = null;
}

// ── GIS ────────────────────────────────────────────────────────────────────────────────────

/**
 * Espera a que el script de Google Identity esté cargado. Va con `async defer` en index.html,
 * así que puede llegar DESPUÉS de que la pantalla de login monte —en una conexión lenta es lo
 * normal, y la pantalla no puede hacer nada hasta entonces. Sondea porque el <script> no
 * dispara ningún evento que se pueda escuchar desde aquí sin acoplarse al DOM de index.html.
 *
 * @param {object} p
 *   - getGis: () => objeto `google.accounts.id` o undefined si aún no está
 *   - intervaloMs / maxMs: cadencia y tope de espera (15 s por defecto: pasado eso, es un CDN
 *     bloqueado o sin red, y hay que decírselo a la persona en vez de esperar en silencio)
 *   - esperar: inyectable en tests
 * @returns {Promise<object|null>} el objeto GIS, o null si no llegó a tiempo
 */
export async function waitForGis({ getGis, intervaloMs = 100, maxMs = 15000, esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const inicio = Date.now();
  for (;;) {
    const gis = getGis();
    if (gis) return gis;
    if (Date.now() - inicio >= maxMs) return null;
    await esperar(intervaloMs);
  }
}

/** Cómo se reconoce un rechazo del servidor por nonce (verify-token.js). */
const ERROR_NONCE_RE = /nonce/i;

/**
 * Pide un nonce, inicializa GIS con él y pinta el botón. Cuando el usuario completa el
 * login, GIS invoca el callback con el ID token; aquí lo canjeamos por una sesión.
 * - Login correcto → guarda sesión, `onSuccess({session, residente, residentes?})`.
 * - Email no vinculado → NO guarda sesión, `onNeedsAlta({pendingToken})` (el cliente puede
 *   pedir el formulario de alta sin repetir el login de Google).
 * - Cualquier otro fallo → `onError(mensaje)`, y se vuelve a inicializar con un nonce nuevo
 *   para que el siguiente clic pueda funcionar.
 *
 * @returns {Promise<{refrescar: () => Promise<boolean>}|null>} null si no se pudo ni empezar
 *   (sin nonce); si no, un asa con `refrescar()`, que pide otro nonce y reinicializa GIS.
 */
export async function setupGoogleSignIn({ api, clientId, gis, buttonEl, storage = sessionStorage, onSuccess, onNeedsAlta, onError }) {
  let nonce = null;
  const opcionesBoton = { theme: "outline", size: "large", width: 320, text: "continue_with" };

  // Cada nonce va ligado a SU callback, no a una variable compartida: el refresco periódico (cada 4
  // min, o al volver a la pestaña) reasignaba el nonce mientras el selector de cuentas de Google
  // seguía abierto con el anterior, y el ID token volvía acuñado con N1 pero el cliente mandaba N2 —
  // «nonce reusado o desconocido», y un login que fallaba sin culpa de nadie. El servidor acepta
  // cualquier nonce no consumido dentro de sus 5 minutos, así que N1 sigue valiendo.
  const callbackPara = (nonceDeEsta) => async (response) => {
    const r = await api.login(response.credential, nonceDeEsta);
    if (r.ok) {
      storeSession(r, storage);
      onSuccess(r);
    } else if (r.pendingToken) {
      onNeedsAlta({ pendingToken: r.pendingToken });
    } else {
      // El nonce ya se gastó (o caducó) en este intento: sin uno nuevo, el siguiente clic
      // fallaría seguro. Se reinicializa ANTES de avisar, para que el aviso ya sea verdad.
      const caducado = ERROR_NONCE_RE.test(String(r.error || ""));
      await inicializar();
      onError(caducado ? "El acceso tardó demasiado y caducó. Vuelve a pulsar el botón de Google." : r.error);
    }
  };

  const inicializar = async () => {
    const nonceRes = await tomarNonce(api);
    if (!nonceRes.ok) {
      onError(nonceRes.error);
      return false;
    }
    nonce = nonceRes.nonce;
    gis.initialize({ client_id: clientId, nonce, callback: callbackPara(nonce) });
    // El botón se vuelve a pintar en cada inicialización: la configuración (nonce incluido) se
    // fija al renderizarlo, así que un botón viejo seguiría mandando el nonce viejo.
    gis.renderButton(buttonEl, opcionesBoton);
    return true;
  };

  if (!(await inicializar())) return null;
  return { refrescar: inicializar };
}

/**
 * Envía el formulario de alta autoservicio. `identidad` es {idToken,nonce} o {pendingToken}
 * (ver router.js handleAlta). Guarda la sesión resultante igual que un login.
 */
export async function submitAlta({ api, identidad, datos, storage = sessionStorage, onSuccess, onError }) {
  const r = await api.altaResidente(identidad, datos);
  if (!r.ok) {
    onError(r.error);
    return;
  }
  storeSession(r, storage);
  onSuccess(r);
}

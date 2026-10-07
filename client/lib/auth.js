// Orquestación de "Sign in with Google" (GIS) y ciclo de vida de la sesión (ADR-002 D-2).
//
// La sesión (token HMAC + perfil mínimo) vive en `localStorage` desde el 2026-10-07 (decisión S-8,
// de Quique): antes iba en `sessionStorage` y se borraba al cerrar la pestaña, pero en un móvil el
// botón «atrás» cierra la pestaña que abrió un enlace (WhatsApp, por ejemplo), y cada salida sin
// querer obligaba a repetir el login entero con Google y con Apps Script en frío. No es un secreto
// de terceros (es un token propio que solo autoriza llamadas a este backend) y caduca solo a las
// 12 h (SESSION_TTL de Code.gs): `getSession` tira la sesión caducada en vez de devolverla, para no
// pintar la app un instante y echar al usuario en la primera petición. Contrapartida asumida: en un
// móvil compartido, quien lo coja entra con esa cuenta hasta que caduque o alguien cierre sesión.
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

// `sessionStorage` solo para recoger la sesión de quien ya estaba dentro antes del cambio a
// `localStorage` (S-8): sin esto, el despliegue echaba a todos al recargar la pestaña.
const almacenLegado = () => { try { return sessionStorage; } catch { return null; } };

/** Segundos de caducidad (`exp`) del token propio (`payload.firma`, session.js), o null si no se lee. */
function caducidadDelToken(token) {
  try {
    const b64 = String(token).split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

export function getSession(storage = localStorage, { legado = almacenLegado(), ahoraMs = Date.now() } = {}) {
  try {
    let crudo = storage.getItem(SESSION_KEY);
    if (!crudo && legado) {
      crudo = legado.getItem(SESSION_KEY);
      if (crudo) { storage.setItem(SESSION_KEY, crudo); legado.removeItem(SESSION_KEY); }
    }
    const s = JSON.parse(crudo || "null");
    // La caducidad la impone el servidor; aquí solo se evita arrancar con una sesión que ya no sirve.
    const exp = s && caducidadDelToken(s.session);
    if (exp !== null && exp !== undefined && exp * 1000 <= ahoraMs) { storage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch {
    return null;
  }
}
/**
 * Guarda SOLO lo que la sesión necesita (token + perfil mínimo). `login`/`estadoSolicitudInvitado`
 * devuelven además la lista de residentes para ahorrarle al arranque una ida y vuelta; esa
 * lista es estado de la app, no de la sesión, y no se persiste aquí.
 */
export function storeSession(data, storage = localStorage) {
  storage.setItem(SESSION_KEY, JSON.stringify({ session: data.session, residente: data.residente }));
}
export function clearSession(storage = localStorage, { legado = almacenLegado() } = {}) {
  storage.removeItem(SESSION_KEY);
  if (legado) legado.removeItem(SESSION_KEY);
}

/** La clave bajo la que se guarda la sesión, para escuchar el evento `storage` de otras pestañas. */
export const CLAVE_SESION = SESSION_KEY;

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
 * Nombre, email y foto que trae el ID token de Google, SOLO para enseñarlos mientras el servidor
 * verifica el login («Entrando como …»). No se confía en nada de esto ni se guarda: quien decide
 * quién eres es el servidor, que valida el token entero (verify-token.js). Devuelve null si el
 * token no tiene forma de JWT (p. ej. el `dev:` del dev-server) o no se puede leer, para que la
 * pantalla caiga a un «Entrando…» sin nombre en vez de romperse.
 */
export function perfilDelToken(credential) {
  try {
    const partes = String(credential || "").split(".");
    if (partes.length !== 3) return null;
    const b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(partes[1].length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    const texto = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const foto = texto(p.picture);
    return {
      nombre: texto(p.given_name) || texto(p.name),
      email: texto(p.email),
      foto: foto && foto.startsWith("https://") ? foto : null,
    };
  } catch {
    return null;
  }
}

/**
 * Pide un nonce, inicializa GIS con él y pinta el botón. Cuando el usuario completa el
 * login, GIS invoca el callback con el ID token; aquí lo canjeamos por una sesión.
 * - Login correcto → guarda sesión, `onSuccess({session, residente, residentes?})`.
 * - Email no vinculado → NO guarda sesión, `onNeedsAlta({pendingToken})` (el cliente puede
 *   pedir el formulario de alta sin repetir el login de Google).
 * - Cualquier otro fallo → `onError(mensaje)`, y se vuelve a inicializar con un nonce nuevo
 *   para que el siguiente clic pueda funcionar.
 * `onStart(perfil)`, si se pasa, se llama en cuanto Google devuelve la cuenta elegida y ANTES de
 * llamar al servidor: el login a Apps Script tarda unos segundos y sin esto la pantalla no cambiaba
 * nada, así que parecía colgada (2026-10-07). `perfil` es `perfilDelToken(...)` (puede ser null).
 *
 * @returns {Promise<{refrescar: () => Promise<boolean>}|null>} null si no se pudo ni empezar
 *   (sin nonce); si no, un asa con `refrescar()`, que pide otro nonce y reinicializa GIS.
 */
export async function setupGoogleSignIn({ api, clientId, gis, buttonEl, storage = localStorage, onSuccess, onNeedsAlta, onError, onStart }) {
  let nonce = null;
  const opcionesBoton = { theme: "outline", size: "large", width: 320, text: "continue_with" };

  // Cada nonce va ligado a SU callback, no a una variable compartida, para que el `nonce` que viaja
  // en el cuerpo del login sea el mismo con el que Google acuñó ese ID token aunque el refresco
  // periódico (cada 4 min, o al volver a la pestaña) haya pasado a otro mientras el selector de
  // cuentas seguía abierto. Es coherencia, no un arreglo: el anti-replay real del servidor es
  // `consumeNonce(claims.nonce)` sobre el nonce DEL TOKEN (verify-token.js) y hoy no compara el del
  // cuerpo con nada — así que el desfase nunca hizo fallar un login (verificado 2026-09-05).
  const callbackPara = (nonceDeEsta) => async (response) => {
    if (onStart) onStart(perfilDelToken(response.credential));
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
    // El `renderButton` real de GIS AÑADE el widget al contenedor, no lo sustituye: sin vaciarlo,
    // cada refresco del nonce (4 min, o al volver a la pestaña) apilaba un botón más.
    if (buttonEl && typeof buttonEl.replaceChildren === "function") buttonEl.replaceChildren();
    else if (buttonEl && "innerHTML" in buttonEl) buttonEl.innerHTML = "";
    gis.renderButton(buttonEl, opcionesBoton);
    return true;
  };

  if (!(await inicializar())) return null;
  return { refrescar: inicializar };
}

/**
 * Pide acceso (V-53 invitado, V-54 alta de residente) y espera a que lo apruebe quien puede (un
 * administrador o, pasada la ventana de V-52, el permiso del ciclo; 5 min). `iniciar()` lanza la
 * solicitud (`api.solicitarInvitado(pendingToken)` o `api.solicitarAlta(pendingToken, datos)`) y
 * devuelve `{ok, solicitudToken, expiraEn, avisados?}`. Consulta cada `intervaloMs`; al aprobarse
 * guarda la sesión igual que un login (en un alta, la del residente recién creado). `cancelado()`
 * corta la espera (el usuario pulsó Cancelar, pidió otra cosa o desmontó la pantalla), y se mira
 * también DESPUÉS de cada respuesta: una consulta que vuelve tras cancelar no puede guardar la
 * sesión de una solicitud que el usuario ya abandonó. `onEstado` recibe cada consulta, para pintar
 * la espera con el `expiraEn` del servidor; la primera lleva además `avisados` (V-57).
 *
 * Devuelve el estado final: "APROBADA" | "RECHAZADA" | "CADUCADA" | "CANCELADA" | "ERROR".
 */
export async function pedirAcceso({
  api, iniciar, storage = localStorage, onSuccess, onError, onEstado = () => {},
  intervaloMs = 4000, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), cancelado = () => false,
}) {
  const sol = await iniciar();
  if (cancelado()) return "CANCELADA";
  if (!sol.ok) { onError(sol.error); return "ERROR"; }
  onEstado({ estado: "PENDIENTE", expiraEn: sol.expiraEn, avisados: sol.avisados });
  while (!cancelado()) {
    await esperar(intervaloMs);
    if (cancelado()) break;
    const r = await api.estadoSolicitudInvitado(sol.solicitudToken);
    if (cancelado()) break;
    // Un fallo de red puntual no tira la solicitud: se sigue preguntando hasta que caduque.
    if (!r.ok) continue;
    if (r.estado === "APROBADA") { storeSession(r, storage); onSuccess(r); return "APROBADA"; }
    if (r.estado === "RECHAZADA" || r.estado === "CADUCADA") { onEstado(r); return r.estado; }
    onEstado(r);
  }
  return "CANCELADA";
}

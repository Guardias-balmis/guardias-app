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
export function storeSession(data, storage = sessionStorage) {
  storage.setItem(SESSION_KEY, JSON.stringify(data));
}
export function clearSession(storage = sessionStorage) {
  storage.removeItem(SESSION_KEY);
}

/**
 * Pide un nonce, inicializa GIS con él y pinta el botón. Cuando el usuario completa el
 * login, GIS invoca el callback con el ID token; aquí lo canjeamos por una sesión.
 * - Login correcto → guarda sesión, `onSuccess({session, residente})`.
 * - Email no vinculado → NO guarda sesión, `onNeedsAlta({pendingToken})` (el cliente puede
 *   pedir el formulario de alta sin repetir el login de Google).
 * - Cualquier otro fallo → `onError(mensaje)`.
 */
export async function setupGoogleSignIn({ api, clientId, gis, buttonEl, storage = sessionStorage, onSuccess, onNeedsAlta, onError }) {
  const nonceRes = await api.getNonce();
  if (!nonceRes.ok) {
    onError(nonceRes.error);
    return;
  }
  const nonce = nonceRes.nonce;

  gis.initialize({
    client_id: clientId,
    nonce,
    callback: async (response) => {
      const r = await api.login(response.credential, nonce);
      if (r.ok) {
        storeSession(r, storage);
        onSuccess(r);
      } else if (r.pendingToken) {
        onNeedsAlta({ pendingToken: r.pendingToken });
      } else {
        onError(r.error);
      }
    },
  });
  gis.renderButton(buttonEl, { theme: "outline", size: "large", width: 320, text: "continue_with" });
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

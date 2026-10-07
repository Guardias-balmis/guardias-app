// El botón «atrás» del móvil navega DENTRO de la app (2026-10-07, a pedido de Quique: «el botón de
// atrás del móvil, en cualquier pantalla, te saca»).
//
// La app cambia de pantalla con un estado de React (`tab` en App.jsx), sin router, así que para el
// navegador solo había UNA página: «atrás» salía de la app —y si la había abierto un enlace, cerraba
// la pestaña—. Ahora cada cambio de pantalla que hace el usuario deja una entrada en el historial
// (`pushState`) y «atrás» (`popstate`) vuelve a la anterior.
//
// Inicio es la RAÍZ, como en cualquier app de Android: «atrás» desde Inicio sale de la app, siempre.
// La primera versión (PR #60) apilaba sin más, y eso tenía cuatro fallos que se vieron en el
// navegador: (1) cerrar sesión dejaba apiladas las pantallas de la sesión anterior —los primeros
// «atrás» en el login no hacían nada visible y quien entrara después caía en, p. ej., Preferencias
// de otro—; (2) cada paso por Inicio desde la barra inferior apilaba otra entrada, y para salir había
// que pulsar «atrás» tantas veces como pantallas se hubieran visitado; (3) «← Volver» de una
// subpantalla de Ajustes apilaba Ajustes otra vez, y el siguiente «atrás» devolvía a la subpantalla;
// (4) recargar volvía a Inicio aunque el historial dijera Cuadrante. De ahí las reglas:
//   - cada entrada guarda su pantalla, su PROFUNDIDAD (cuántas hay por debajo hasta la raíz) y la
//     pantalla ANTERIOR; con eso la app sabe cuánto desapilar sin llevar la cuenta aparte, y la
//     cuenta sobrevive a una recarga porque vive en el propio historial;
//   - ir a Inicio desde una pantalla apilada es `go(-profundidad)`, no una entrada nueva;
//   - ir a la pantalla que es justo la anterior es `back()`: «← Volver» deshace, no apila;
//   - cerrar sesión desapila hasta la raíz;
//   - al recargar, la app arranca en la pantalla que dice la entrada (si sigue habiendo sesión).
//
// Las entradas solo se CREAN al pulsar (con gesto del usuario): Chrome se salta al ir atrás las que
// una página crea sin gesto. Por eso, cuando el usuario cancela un «atrás» (celdas sin guardar), no se
// apila otra vez la pantalla: se vuelve con `go()` a la entrada de la que venía, que ya existe.
//
// `go`/`back` son asíncronos: el navegador avisa con un `popstate` cuando ha llegado. Los viajes que
// pide la propia app no se notifican a `alVolver` (la pantalla ya está puesta), y un cambio de
// pantalla pedido mientras hay uno en curso espera a que termine: dos viajes a la vez se pisan.
//
// Vive en client/lib y no en App.jsx porque un `.jsx` no se puede probar en Node; App.jsx solo lo usa.

/** Clave propia dentro de `history.state`, para no pisar lo que otro código guarde ahí. */
export const CLAVE_NAVEGACION = "gappNav";

/**
 * La entrada de navegación guardada en un `history.state`, o null si no es de la app o no es
 * coherente (otra página, un ancla, una versión anterior con otra forma, una pantalla que ya no
 * existe). La raíz, y solo ella, está a profundidad 0.
 * @returns {{pantalla: string, profundidad: number, anterior: string|null} | null}
 */
export function leerEntrada(state, { raiz = "home", pantallas } = {}) {
  const n = state && typeof state === "object" ? state[CLAVE_NAVEGACION] : null;
  if (!n || typeof n !== "object") return null;
  const { pantalla, profundidad, anterior } = n;
  if (typeof pantalla !== "string" || !Number.isInteger(profundidad) || profundidad < 0) return null;
  if (pantallas && !pantallas.includes(pantalla)) return null;
  if ((profundidad === 0) !== (pantalla === raiz)) return null;
  if (profundidad > 0 && typeof anterior !== "string") return null;
  return { pantalla, profundidad, anterior: profundidad > 0 ? anterior : null };
}

/** La pantalla que guarda la entrada actual (tras una recarga), o null. App.jsx arranca en ella. */
export function pantallaGuardada(historial, opciones) {
  const e = leerEntrada(historial.state, opciones);
  return e ? e.pantalla : null;
}

/**
 * @param {object} p
 *   - historial: `window.history` (o un doble de test con pushState/replaceState/go/back/state)
 *   - ventana: lo que recibe el listener de `popstate` (`window` o un doble)
 *   - raiz: la pantalla raíz ("home")
 *   - pantallas: las que la app sabe pintar (una entrada con otra no se restaura)
 *   - restaurar: true si hay sesión al arrancar; entonces una entrada guardada se respeta tal cual
 *     (la app arranca en ella). Sin sesión, una entrada apilada se desapila hasta la raíz.
 *   - alVolver(pantalla): el usuario ha ido atrás o adelante hasta `pantalla`. Si devuelve `false`,
 *     la app se queda donde estaba y el historial vuelve a la entrada de la que venía.
 * @returns {{ir: (p: string) => void, aLaRaiz: () => void, desmontar: () => void}}
 *   `ir` es un cambio de pantalla hecho por el usuario (apila, desapila hasta la raíz o vuelve a la
 *   anterior, según el caso). `aLaRaiz` desapila hasta Inicio (al cerrar sesión).
 */
export function crearNavegacion({ historial, ventana, raiz = "home", pantallas, restaurar = false, alVolver }) {
  const opciones = { raiz, pantallas };
  const RAIZ = { pantalla: raiz, profundidad: 0, anterior: null };
  // replaceState conserva las demás claves de la entrada; pushState crea una entrada nueva y solo
  // lleva la nuestra.
  const reemplaza = (nav) => {
    const otras = historial.state && typeof historial.state === "object" ? historial.state : {};
    historial.replaceState({ ...otras, [CLAVE_NAVEGACION]: nav }, "");
  };

  let actual;           // la entrada en la que está el historial, o en la que va a estar al acabar un viaje
  let viaje = null;     // la entrada a la que tiene que llegar un go/back pedido por la app
  let pendiente = null; // pantalla pedida durante un viaje: se aplica cuando el viaje llega

  const viajar = (destino, delta) => {
    viaje = destino;
    actual = destino;
    if (delta === -1) historial.back(); else historial.go(delta);
  };

  function ir(pantalla) {
    if (viaje !== null) { pendiente = pantalla; return; }
    if (pantalla === actual.pantalla) return;
    if (pantalla === raiz) { viajar(RAIZ, -actual.profundidad); return; }
    if (pantalla === actual.anterior) {
      // La anterior de la anterior no se sabe hasta llegar: la trae su `popstate`.
      viajar({ pantalla, profundidad: actual.profundidad - 1, anterior: null }, -1);
      return;
    }
    actual = { pantalla, profundidad: actual.profundidad + 1, anterior: actual.pantalla };
    historial.pushState({ [CLAVE_NAVEGACION]: actual }, "");
  }

  const guardada = leerEntrada(historial.state, opciones);
  if (guardada && restaurar) actual = guardada;
  // Sin sesión no se restaura nada, y dejar las entradas de debajo haría que, tras entrar, «atrás»
  // desde Inicio llevara a pantallas de la sesión anterior (el fallo 1, por la vía de recargar).
  else if (guardada && guardada.profundidad > 0) viajar(RAIZ, -guardada.profundidad);
  else { actual = RAIZ; reemplaza(RAIZ); }

  const onPopstate = (e) => {
    const llegada = leerEntrada(e && e.state, opciones);
    if (viaje !== null) {
      // Llega un viaje de la app: la pantalla ya está puesta, no hay nada que notificar. Si mientras
      // tanto se pidió otra, o si ha llegado a otra entrada (el usuario fue atrás a la vez), se lleva
      // el historial a la pantalla que la app enseña, que es lo último que pidió el usuario.
      const objetivo = pendiente !== null ? pendiente : viaje.pantalla;
      viaje = null;
      pendiente = null;
      if (llegada) actual = llegada; else { actual = RAIZ; reemplaza(RAIZ); }
      ir(objetivo);
      return;
    }
    if (!llegada) {
      // Una entrada que no es de la app no debería existir (la app no usa anclas): se adopta como
      // raíz y, si la app no puede salir de donde está, pasa a ser la pantalla actual.
      if (alVolver(raiz) === false) { reemplaza(actual); return; }
      actual = RAIZ;
      reemplaza(RAIZ);
      return;
    }
    const desde = actual;
    if (alVolver(llegada.pantalla) === false) {
      // Se queda: vuelve a la entrada de la que venía, que sigue ahí (atrás o adelante).
      const delta = desde.profundidad - llegada.profundidad;
      actual = llegada;
      if (delta !== 0) viajar(desde, delta);
      return;
    }
    actual = llegada;
  };
  ventana.addEventListener("popstate", onPopstate);

  return {
    ir,
    aLaRaiz() { ir(raiz); },
    desmontar() { ventana.removeEventListener("popstate", onPopstate); },
  };
}

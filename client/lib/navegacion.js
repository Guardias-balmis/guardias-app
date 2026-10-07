// El botón «atrás» del móvil navega DENTRO de la app (2026-10-07, a pedido de Quique: «el botón de
// atrás del móvil, en cualquier pantalla, te saca»).
//
// La app cambia de pantalla con un estado de React (`tab` en App.jsx), sin router y sin tocar el
// historial del navegador, así que para el móvil solo había UNA página: «atrás» salía de la app —y
// si la había abierto un enlace, cerraba la pestaña—. Ahora cada cambio de pantalla que hace el
// usuario deja una entrada en el historial (`pushState`) y «atrás» (`popstate`) vuelve a la anterior;
// solo desde la pantalla inicial sale de la app, como en cualquier app de Android.
//
// Vive en client/lib y no en App.jsx porque un `.jsx` no se puede probar en Node; App.jsx solo lo
// usa. Las entradas se crean al pulsar (con gesto del usuario): Chrome se salta al ir atrás las que
// una página crea sin gesto, así que no se intenta «atrapar» la salida con una entrada de más.

/** Clave dentro de `history.state`, para no pisar lo que otro código guarde ahí. */
export const CLAVE_PANTALLA = "gappPantalla";

/**
 * @param {object} p
 *   - historial: `window.history` (o un doble de test con pushState/replaceState/state)
 *   - ventana: lo que recibe el listener de `popstate` (`window` o un doble)
 *   - inicial: la pantalla con la que arranca la app
 *   - alVolver(pantalla): se llama cuando el usuario va atrás o adelante, con la pantalla de destino
 * @returns {{ir: (p: string) => void, reemplazar: (p: string) => void, desmontar: () => void}}
 *   `ir` deja una entrada nueva: un cambio de pantalla hecho por el usuario, o deshacer un «atrás»
 *   que el usuario canceló (el navegador ya ha retrocedido, y hay que volver a poner delante la
 *   pantalla en la que se queda). `reemplazar` cambia la actual sin crear otra (al cerrar sesión).
 */
export function crearNavegacion({ historial, ventana, inicial, alVolver }) {
  const estado = (pantalla) => ({ ...(historial.state || {}), [CLAVE_PANTALLA]: pantalla });
  // La entrada en la que se carga la app pasa a ser la pantalla inicial: así, al volver hasta ella,
  // `popstate` trae una pantalla con la que trabajar en vez de un estado vacío.
  historial.replaceState(estado(inicial), "");
  const onPopstate = (e) => {
    const destino = e && e.state && e.state[CLAVE_PANTALLA];
    alVolver(typeof destino === "string" ? destino : inicial);
  };
  ventana.addEventListener("popstate", onPopstate);
  return {
    ir(pantalla) { historial.pushState({ [CLAVE_PANTALLA]: pantalla }, ""); },
    reemplazar(pantalla) { historial.replaceState(estado(pantalla), ""); },
    desmontar() { ventana.removeEventListener("popstate", onPopstate); },
  };
}

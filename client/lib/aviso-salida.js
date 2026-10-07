// El aviso del navegador al recargar, cerrar la pestaña o salir de la app («¿Salir del sitio? Es
// posible que los cambios no se guarden»), para las pantallas con cambios sin guardar: las celdas
// del cuadrante (Calendar.jsx) y las preferencias del mes (Prefs.jsx).
//
// App.jsx ya pregunta antes de cambiar de pantalla, ir atrás o cerrar sesión, pero una recarga no
// pasa por la app: se llevaba lo no guardado sin decir nada. Esa pregunta solo la puede hacer el
// navegador, con `beforeunload`.
//
// El escuchador se pone SOLO mientras hay cambios, y por eso esto es una función con su test y no
// una línea en cada pantalla: un `beforeunload` puesto siempre saca la página de la bfcache (la
// copia en memoria que hace instantáneo volver a ella), y en el móvil volver a la app sin pantalla
// en blanco es justo lo que más ha costado conseguir.

/**
 * Pide el aviso de salida a `ventana` (el `window`) mientras `activo` sea verdad. Devuelve la
 * función que lo quita, pensada para ser la limpieza de un `useEffect`:
 * `useEffect(() => avisarAlSalir(window, hayCambios), [hayCambios])`.
 */
export function avisarAlSalir(ventana, activo) {
  if (!activo) return () => {};
  // Las dos cosas: `preventDefault` es lo estándar, y `returnValue` lo que aún exigen Safari y los
  // Chrome anteriores al 119. El texto lo pone el navegador; el que se dé aquí no se enseña.
  const alSalir = (e) => { e.preventDefault(); e.returnValue = ""; };
  ventana.addEventListener("beforeunload", alSalir);
  return () => ventana.removeEventListener("beforeunload", alSalir);
}

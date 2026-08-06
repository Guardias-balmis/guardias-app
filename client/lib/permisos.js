// El permiso del ciclo (decisión V-16) visto desde el cliente, en un solo sitio.
//
// La regla la manda el servidor (`requireCicloPermiso` en router.js) y esto NO la sustituye:
// aquí solo decide qué se enseña. Existe porque la misma expresión estaba escrita en
// `Calendar.jsx` y hacía falta otra vez en `Prefs.jsx` para el registro de ausencias ajenas —
// y una regla de permiso copiada en dos pantallas se desincroniza en cuanto una de las dos
// cambie. Vive en client/lib y no en un `.jsx` porque un `.jsx` no puede importar otro
// (loader.js transpila cada uno aislado), que es lo mismo que ya obligó a `closes.js`.
//
// `sinResponsable` NO se deriva aquí: lo dice el servidor en `estadoCuadrante`, releído del
// store en cada llamada. El `rol` del token se firmó en el login y puede ser anterior al
// sorteo, así que nunca se usa para esto.

/**
 * @param {object} p
 *   - isResponsable: si la sesión es la del titular del mandato vigente (contexto de la app)
 *   - grupo: "MAYOR" | "PEQUENO" | null, derivado de fechas como todo lo demás
 *   - sinResponsable: lo que devuelve `estadoCuadrante`; true si no hay mandato vigente
 */
export function puedeMoverCiclo({ isResponsable, grupo, sinResponsable }) {
  return Boolean(isResponsable) || (Boolean(sinResponsable) && grupo === "MAYOR");
}

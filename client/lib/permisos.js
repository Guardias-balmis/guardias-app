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

/**
 * Si se le ofrece a esta sesión el botón de «Generar cuadrante con IA» de Inicio (decisión V-43).
 *
 * Es el permiso del ciclo MÁS el estado del mes: generar reescribe el cuadrante entero, y un mes
 * PUBLICADO no admite ediciones (el servidor ya lo rechaza — esto solo evita ofrecer un botón que
 * va a fallar). `estado` puede llegar `null` mientras se está cargando o si la consulta falló: en
 * los dos casos NO se ofrece, porque no saber si el mes está publicado no es lo mismo que saber
 * que no lo está.
 *
 * Y como siempre: esto decide qué se ENSEÑA. El permiso de verdad lo vuelve a comprobar
 * `requireCicloPermiso` en el servidor, que es donde no se puede falsear.
 *
 * @param {object} p  los tres de `puedeMoverCiclo` más `estado` ("BORRADOR"|"VALIDADO"|"PUBLICADO")
 */
export function puedeGenerarCuadrante({ isResponsable, grupo, sinResponsable, estado }) {
  return puedeMoverCiclo({ isResponsable, grupo, sinResponsable })
    && (estado === "BORRADOR" || estado === "VALIDADO");
}

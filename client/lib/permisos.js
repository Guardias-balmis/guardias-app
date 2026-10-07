import { todayISO } from "./dates.js";

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
 *   - accesoDesarrollador: el resultado de `esAccesoDesarrollador` para esta sesión (V-49)
 */
export function puedeMoverCiclo({ isResponsable, grupo, sinResponsable, accesoDesarrollador }) {
  return Boolean(accesoDesarrollador) || Boolean(isResponsable) || (Boolean(sinResponsable) && grupo === "MAYOR");
}

/**
 * Si se le ofrece a esta sesión el botón de «Generar cuadrante con IA» de Inicio (decisión V-45).
 *
 * Es el permiso del ciclo MÁS el estado del mes: generar reescribe el cuadrante entero, y un mes
 * PUBLICADO no admite ediciones (el servidor ya lo rechaza — esto solo evita ofrecer un botón que
 * va a fallar). `estado` puede llegar `null` mientras se está cargando o si la consulta falló: en
 * los dos casos NO se ofrece, porque no saber si el mes está publicado no es lo mismo que saber
 * que no lo está.
 *
 * Solo BORRADOR, ya no VALIDADO (decisión V-46, 2026-09-02): una vez que el equipo se reúne y lo
 * valida entre todos, regenerarlo por encima descartaría en silencio un mes que ya se dio por
 * bueno — así que a partir de VALIDADO el botón deja de ofrecerse, igual que ya pasaba con
 * PUBLICADO.
 *
 * Y como siempre: esto decide qué se ENSEÑA. El permiso de verdad lo vuelve a comprobar
 * `requireCicloPermiso` en el servidor, que es donde no se puede falsear.
 *
 * @param {object} p  los cuatro de `puedeMoverCiclo` más `estado` ("BORRADOR"|"VALIDADO"|"PUBLICADO")
 */
export function puedeGenerarCuadrante({ isResponsable, grupo, sinResponsable, accesoDesarrollador, estado }) {
  return puedeMoverCiclo({ isResponsable, grupo, sinResponsable, accesoDesarrollador }) && estado === "BORRADOR";
}

// Acceso de desarrollador para TODO el permiso del ciclo (decisión V-49, 2026-09-03, a pedido
// explícito del autor de la app — amplía V-46, que cubría solo el botón de generar con IA): ahora
// se pasa como `accesoDesarrollador` a `puedeMoverCiclo`, así que también se enseñan validar,
// publicar, despublicar, excepciones, sorteo e imaginaria, mientras el autor corrige errores de
// esta primera puesta en producción. El autor es R1/R2 hoy y no puede pasar a ser Mayor sin
// falsear su nivel real —se deriva de fechas y alimenta INV-11 y compañía—, así que se identifica
// por EMAIL, no por rol ni nivel. `FECHA_LIMITE_ACCESO_DESARROLLADOR` lo caduca solo, sin que haga
// falta acordarse de retirar este bloque. Esto SOLO decide qué se ENSEÑA: el servidor vuelve a
// comprobar el mismo email y la misma fecha por su cuenta en `requireCicloPermiso`, que es donde
// de verdad no se puede falsear.
const EMAILS_ACCESO_DESARROLLADOR = ["agustinlagioiosa@gmail.com", "quiquemm14@gmail.com"];
const FECHA_LIMITE_ACCESO_DESARROLLADOR = "2027-03-31";
export function esAccesoDesarrollador(email, hoy = todayISO()) {
  // Normalizado como el servidor (y el login): el email llega de la celda del Sheet, tal cual.
  return EMAILS_ACCESO_DESARROLLADOR.includes(String(email || "").trim().toLowerCase()) && hoy <= FECHA_LIMITE_ACCESO_DESARROLLADOR;
}

/**
 * Si se enseña «Validar» (decisión V-52): mientras dure la ventana de administradores, solo ellos;
 * pasada la fecha límite vuelve el permiso del ciclo (V-16). Espejo de `requireValidarPermiso`
 * en el servidor, que es quien manda.
 */
export function puedeValidarCuadrante({ email, puedeMoverCiclo, hoy = todayISO() }) {
  if (hoy > FECHA_LIMITE_ACCESO_DESARROLLADOR) return Boolean(puedeMoverCiclo);
  return esAccesoDesarrollador(email, hoy);
}

/**
 * Quién decide las solicitudes de acceso (V-53/V-54), dicho para la pantalla de quien las pide,
 * que aún no tiene sesión y no puede saber si hay mandato: dentro de la ventana de V-52, los
 * administradores; pasada la fecha, el permiso del ciclo (V-16). Espejo de `destinatariosAviso` y
 * `requireValidarPermiso` en el servidor.
 */
export function quienApruebaSolicitudes(hoy = todayISO()) {
  return hoy > FECHA_LIMITE_ACCESO_DESARROLLADOR
    ? "el Responsable (o, si no hay Responsable, un R3 o R4)"
    : "un administrador";
}

/**
 * Lo que la pantalla de espera dice del correo de aviso (V-55). Solo afirma que se ha avisado si el
 * servidor dice que el correo salió (`avisados` > 0); si dice que no pudo avisar a nadie, se lo
 * pide al solicitante, porque quien aprueba no tiene otra forma de enterarse a tiempo; y si no lo
 * sabe (solicitud reutilizada, o un servidor anterior a V-55 que no lo devuelve), no afirma nada.
 */
export function textoAvisoSolicitud(avisados) {
  if (typeof avisados !== "number") return "";
  if (avisados > 0) return "Se ha enviado un aviso por correo.";
  return "No se ha podido avisar a nadie por correo: avisa tú directamente a quien tenga que aprobarla, antes de que caduque.";
}

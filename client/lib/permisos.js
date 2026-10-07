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

/**
 * ¿Se ofrece la fase 2 del generador (quintas/sextas y tercer puestos, P-17/V-59)? A diferencia de
 * la fase 1, también sobre un mes VALIDADO: solo AÑADE guardias (no descarta nada de lo revisado) y
 * no revierte el estado. Sigue sin ofrecerse sobre PUBLICADO. El servidor lo vuelve a comprobar.
 */
export function puedeAnadirExtras({ isResponsable, grupo, sinResponsable, accesoDesarrollador, estado }) {
  return puedeMoverCiclo({ isResponsable, grupo, sinResponsable, accesoDesarrollador }) && (estado === "BORRADOR" || estado === "VALIDADO");
}

/**
 * Qué enseña la tarjeta «Generar cuadrante» de Inicio para el mes seleccionado. `null` = la tarjeta
 * no es para esta sesión; si no, la tarjeta se pinta, y con ella su selector de mes ◀/▶.
 *
 * Existe porque esconder la tarjeta era también esconder las flechas: un ◀ que caía en un mes
 * PUBLICADO (o VALIDADO, antes de la fase 2) la hacía desaparecer entera y desde Inicio ya no había
 * forma de volver al mes de hoy —«Mes en curso» seguía diciendo octubre y abría septiembre—. Y
 * mientras respondía `estadoCuadrante` la tarjeta encogía a una línea sin flechas, así que el
 * segundo toque de una ráfaga caía en otra cosa. De ahí las tres reglas:
 *  - Se esconde SOLO cuando ya se sabe que no hay permiso del ciclo. Mientras no llega el estado
 *    tampoco se sabe `sinResponsable` (viaja en la misma respuesta), así que hasta entonces se
 *    enseña a quien PODRÍA tenerlo —el titular, el acceso de desarrollador o cualquier Mayor—;
 *    esconderla ahí dejaba sin tarjeta, en el caso real de producción, a un Mayor sin Responsable.
 *  - Con permiso, un mes en el que no se puede generar enseña POR QUÉ (`motivo`, `fases` vacía) en
 *    vez de desaparecer.
 *  - Mientras se comprueba, conserva la FORMA de la última vista resuelta (`anterior`): mismas
 *    fases, mismo alto, nada pulsable. Solo así una ráfaga de ◀/▶ no mueve nada bajo el dedo.
 * Las flechas se pintan siempre que se pinta la tarjeta, pero solo se pueden pulsar (`flechas`)
 * con el permiso ya confirmado: si no, un Mayor con Responsable vigente podía cambiar de mes en el
 * segundo que tarda la primera comprobación, ver desaparecer la tarjeta y quedarse en ese mes.
 *
 * Como el resto de este módulo, solo decide qué se ENSEÑA; el servidor vuelve a comprobarlo todo.
 *
 * @param {object} p  los cuatro de `puedeMoverCiclo` más:
 *   - estado: el del mes según `estadoCuadrante`; null mientras se comprueba o si falló
 *   - estadoError: el error de esa consulta, o null
 *   - extrasDisponible: si el servidor desplegado entiende la fase 2 (`fasesGeneracion`)
 *   - anterior: la última vista devuelta que no era «comprobando» ni error (o null)
 * @returns {null | {fases: string[], motivo: null|"VALIDADO"|"PUBLICADO"|"OTRO", estado: string|null,
 *   comprobando: boolean, error: string|null, activa: boolean, flechas: boolean}}
 *   `fases` en orden de pantalla ("obligatorias" antes que "extras"); `activa` = se puede generar;
 *   `flechas` = se puede cambiar de mes.
 */
export function vistaGenerador({ isResponsable, grupo, sinResponsable, accesoDesarrollador, estado, estadoError, extrasDisponible, anterior }) {
  const quien = { isResponsable, grupo, sinResponsable, accesoDesarrollador };
  const flechas = puedeMoverCiclo(quien);
  if (estado == null) {
    // `sinResponsable: true` es la hipótesis más generosa: quién tendría el permiso si resultara
    // que no hay mandato. Quien no lo tendría ni así no va a ver la tarjeta pase lo que pase.
    if (!puedeMoverCiclo({ ...quien, sinResponsable: true })) return null;
    if (estadoError) return { fases: [], motivo: null, estado: null, comprobando: false, error: estadoError, activa: false, flechas };
    return {
      fases: anterior ? anterior.fases : [], motivo: anterior ? anterior.motivo : null,
      estado: null, comprobando: true, error: null, activa: false, flechas,
    };
  }
  if (!flechas) return null;
  const fases = [];
  if (puedeGenerarCuadrante({ ...quien, estado })) fases.push("obligatorias");
  if (extrasDisponible && puedeAnadirExtras({ ...quien, estado })) fases.push("extras");
  const motivo = estado === "BORRADOR" ? null : estado === "VALIDADO" ? "VALIDADO" : estado === "PUBLICADO" ? "PUBLICADO" : "OTRO";
  return { fases, motivo, estado, comprobando: false, error: null, activa: fases.length > 0, flechas: true };
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
 * Lo que la pantalla de espera dice del correo de aviso (V-57). Solo afirma que se ha avisado si el
 * servidor dice que el correo salió (`avisados` > 0); si dice que no pudo avisar a nadie, se lo
 * pide al solicitante, porque quien aprueba no tiene otra forma de enterarse a tiempo; y si no lo
 * sabe (solicitud reutilizada, o un servidor anterior a V-57 que no lo devuelve), no afirma nada.
 */
export function textoAvisoSolicitud(avisados) {
  if (typeof avisados !== "number") return "";
  if (avisados > 0) return "Se ha enviado un aviso por correo.";
  return "No se ha podido avisar a nadie por correo: avisa tú directamente a quien tenga que aprobarla, antes de que caduque.";
}

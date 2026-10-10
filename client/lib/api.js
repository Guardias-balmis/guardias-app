// Cliente del backend Apps Script (ADR-002 D-1). Petición "simple" para no disparar el
// preflight OPTIONS (que Apps Script no atiende): Content-Type text/plain con el JSON en
// el cuerpo, credentials 'omit' (NUNCA 'include': la respuesta trae ACAO:* y el estándar
// Fetch prohíbe wildcard+credenciales). La identidad viaja como bearer en el cuerpo
// (idToken en login/solicitarAlta, session en el resto), nunca en una cookie ni en un
// header Authorization (eso dispararía preflight).
//
// `fetchImpl` se inyecta (test: fake; navegador: `fetch` global) — módulo puro y testeable.

/** Construye las opciones de fetch para el contrato D-1. Puro. */
export function buildRequestInit(payload) {
  return {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

/**
 * Acciones que se pueden REPETIR sin consecuencias, y por tanto reintentar ante un fallo de
 * transporte. Lista explícita a propósito: lo que no esté aquí NO se reintenta, así que olvidarse
 * de añadir una lectura solo cuesta un reintento perdido, mientras que colar una escritura
 * costaría una fila duplicada en una tabla append-only que nadie borra. Ante la duda, fuera.
 *
 * `login` entra aunque consuma el nonce: si el POST no llegó a ejecutarse —el caso mayoritario de
 * este fallo— el reintento resuelve el login, y si sí llegó, el usuario ve «nonce reusado» en vez
 * de «HTTP 404», que no es peor. `solicitarAlta` NO entra: escribe una solicitud.
 */
const REINTENTABLES = new Set([
  "getNonce", "login", "estadoSolicitudInvitado", "listSolicitudesInvitado", "whoami", "validar",
  "listResidentes", "listAsignaciones", "listAsignacionesRango",
  "misPreferencias", "listPreferencias", "misBloqueos", "listBloqueos", "listBloqueosRango",
  "listFestivosRango", "listEventos", "listExcepciones", "colaImaginaria",
  "estadoResponsable", "listResponsables", "estadoCuadrante", "estadoVoluntariado3P", "estadoRevisionFestivos", "lote",
]);

/**
 * Lecturas que se agrupan en UNA petición (S-9) cuando se piden a la vez. Cada petición al `/exec`
 * cuesta ~3 s de arranque y redirección de Google aunque la ejecución sea de milisegundos, y varias
 * en paralelo se estorban entre sí (se vieron 21 s): Inicio lanzaba 4-5. Mismas acciones que
 * `LOTE_ACCIONES` del servidor; solo lecturas.
 */
const LOTEABLES = new Set([
  "listResidentes", "listAsignaciones", "listAsignacionesRango",
  "misPreferencias", "listPreferencias", "misBloqueos", "listBloqueos", "listBloqueosRango",
  "listFestivosRango", "listEventos", "listExcepciones", "colaImaginaria",
  "estadoResponsable", "listResponsables", "estadoCuadrante", "estadoVoluntariado3P",
  "listSolicitudesInvitado", "estadoRevisionFestivos",
]);
const LOTE_VENTANA_MS = 10; // lo que se espera a que lleguen las demás lecturas de la misma pantalla
const LOTE_MAX = 12;

const REINTENTOS_MS = [400, 1200]; // dos reintentos: hay una persona esperando delante
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama al backend. Nunca lanza: cualquier fallo (red, HTTP, JSON) se devuelve como
 * `{ok:false, error, transporte:true}` para que la UI lo trate igual que un rechazo de negocio del
 * servidor. Lo que devuelve es SIEMPRE un objeto: nunca `undefined`, `null`, un array ni el
 * cuerpo crudo de una página de error. `transporte` distingue «no llegó respuesta» de «el servidor
 * dijo que no», que en una ESCRITURA no es lo mismo: sin respuesta no se sabe si se guardó.
 *
 * Reintenta los fallos de TRANSPORTE de las acciones idempotentes, y esto no es defensa
 * especulativa: el `/exec` de Apps Script no contesta directo, responde **302 a un enlace temporal
 * de un solo uso** que el navegador sigue, y cuando ese segundo salto falla —enlace consumido,
 * caducado, o Google estrangulando la tasa— llega HTML de Google con un 404. Reproducido en
 * producción el 2026-08-05: dos `login` idénticos y seguidos dieron 404 y 200. El residente veía
 * «HTTP 404» al entrar, sin nada que hacer salvo insistir a ciegas. El servidor ya tenía esta red
 * para el mismo tipo de inestabilidad (`fetchTokeninfo_` en Code.gs reintenta 3 veces); el cliente
 * no la tenía.
 *
 * NO se reintenta un `{ok:false}` del servidor: eso es un rechazo de negocio, es determinista y
 * repetirlo solo gasta tiempo. Solo el `!res.ok` y la excepción de red.
 */
export async function callBackend(execUrl, payload, { fetchImpl = fetch, esperar = espera } = {}) {
  const intentos = REINTENTABLES.has(payload && payload.action) ? REINTENTOS_MS.length + 1 : 1;
  let ultimo = { ok: false, error: "sin respuesta" };

  for (let i = 0; i < intentos; i++) {
    if (i > 0) await esperar(REINTENTOS_MS[i - 1]);
    try {
      const res = await fetchImpl(execUrl, buildRequestInit(payload));
      if (res.ok) {
        const datos = await res.json();
        // Solo un objeto es una respuesta del router (`{ok, …}`). Un `null` o un array llegaba tal
        // cual a la pantalla, que leía `r.ok` de él y reventaba fuera de toda red.
        if (datos && typeof datos === "object" && !Array.isArray(datos)) return datos;
        ultimo = { ok: false, transporte: true, error: "el servidor de Google devolvió una respuesta que no es de esta app" };
        continue;
      }
      // Se dice que es de Google y no un número pelado: el residente no puede hacer nada con un
      // «HTTP 404», y este no es culpa suya ni de sus datos.
      ultimo = { ok: false, transporte: true, error: `el servidor de Google no respondió bien (HTTP ${res.status})` };
    } catch (e) {
      // Una página HTML en vez de JSON: es lo que devuelve Apps Script cuando falla él (cuota,
      // ejecución abortada) aunque el estado sea 200. Es un fallo de transporte como el 404 —se
      // reintenta igual—, y el texto del parser («Unexpected token '<'…») no le dice nada a nadie.
      // Y una excepción de red («Failed to fetch») es también lo que se ve cuando Google mata la
      // ejecución (6 min) y contesta con una página sin cabeceras CORS: se dice en español y se
      // conserva el texto original, que es el que sirve para diagnosticar.
      ultimo = e instanceof SyntaxError
        ? { ok: false, transporte: true, error: "el servidor de Google devolvió una página de error en vez de datos" }
        : { ok: false, transporte: true, error: `no llegó respuesta del servidor de Google: sin conexión, o la petición se cortó por el camino (${String((e && e.message) || e)})` };
    }
  }
  return ultimo;
}


/**
 * Un rechazo del servidor por la SESIÓN (no por los datos): `router.js:authed` responde
 * «sesión expirada|firma|formato|payload» (session.js) cuando el token HMAC no sirve. Es la
 * única clase de error que no se arregla reintentando ni corrigiendo nada en pantalla: hay que
 * volver a entrar. Se distingue por la forma exacta del mensaje, no por buscar la palabra
 * «sesión» en cualquier error, que aparece también en rechazos de negocio.
 */
const SESION_INVALIDA_RE = /^sesión (expirada|firma|formato|payload)$/;
export function isSessionError(error) {
  return SESION_INVALIDA_RE.test(String(error || ""));
}

/**
 * La lista que trae cada lectura (2026-10-07). Las pantallas hacen `if (r.ok) setX(r.lista)` y luego
 * `.length`/`.map`: un `ok:true` sin la lista dejaba el estado en `undefined` y tumbaba la pantalla
 * en el render —pasó en producción con «Solicitudes de acceso» de Inicio—. Aquí se garantiza una
 * vez para todas: `ok:true` trae SIEMPRE un array en ese campo (vacío si no hay nada), y si no lo
 * trae es `{ok:false, error}`, que cada pantalla ya sabe enseñar.
 *
 * Solo campos que el servidor manda desde que existe la acción. Uno añadido después (como
 * `coberturas` en `colaImaginaria`) NO va aquí: contra un `/exec` anterior —el servidor se
 * despliega a mano— faltaría con toda normalidad, y lo correcto es leerlo con `|| []`.
 */
const CAMPO_LISTA = {
  listSolicitudesInvitado: "solicitudes",
  listResidentes: "residentes",
  listAsignaciones: "asignaciones",
  listAsignacionesRango: "asignaciones",
  listPreferencias: "preferencias",
  misBloqueos: "bloqueos",
  listBloqueos: "bloqueos",
  listBloqueosRango: "bloqueos",
  listFestivosRango: "festivos",
  listEventos: "eventos",
  listExcepciones: "excepciones",
  colaImaginaria: "cola",
  listResponsables: "mandatos",
};

function exigirLista(action, r) {
  const campo = CAMPO_LISTA[action];
  if (!campo || !r || r.ok !== true || Array.isArray(r[campo])) return r;
  return { ok: false, error: `respuesta incompleta del servidor: falta la lista de ${campo}` };
}

/**
 * Fábrica de la API tipada. `getSession()` se invoca en cada llamada (no se cachea el
 * valor) para que un logout a mitad de sesión no reenvíe un token viejo.
 *
 * `onSessionInvalid(error)` (opcional) se dispara cuando el servidor rechaza el token de sesión.
 * Existe porque la sesión dura 12 h (Code.gs) y antes, pasado ese plazo, la app seguía en pie
 * con la pestaña abierta: cada pantalla enseñaba «Error cargando…: sesión expirada» y ninguna
 * ofrecía volver a entrar — el residente tenía que adivinar que la salida era el botón de cerrar
 * sesión. App.jsx lo usa para cerrarla y volver al login con un aviso.
 */
export function makeApi(execUrl, { fetchImpl = fetch, getSession, onSessionInvalid, ventanaLoteMs = LOTE_VENTANA_MS } = {}) {
  const call = (payload) => callBackend(execUrl, payload, { fetchImpl });
  const procesa = (action, r) => {
    const out = exigirLista(action, r && typeof r === "object" && !Array.isArray(r) ? r : { ok: false, error: "respuesta vacía en el lote" });
    if (out && out.ok === false && onSessionInvalid && isSessionError(out.error)) onSessionInvalid(out.error);
    return out;
  };

  // Lecturas pendientes de la misma tanda. Una sola se manda como siempre (sin `lote`); dos o más,
  // juntas. Si el servidor desplegado aún no conoce `lote` —se despliega a mano y puede ir por
  // detrás del cliente— se apaga el agrupado y se manda cada una por separado, como antes.
  let cola = [];
  let temporizador = null;
  let loteDisponible = true;
  const sueltas = (tanda) => { for (const t of tanda) call({ action: t.action, session: getSession(), ...t.extra }).then((r) => t.resolver(procesa(t.action, r))); };
  const volcar = async () => {
    temporizador = null;
    const pendientes = cola;
    cola = [];
    for (let i = 0; i < pendientes.length; i += LOTE_MAX) {
      const tanda = pendientes.slice(i, i + LOTE_MAX);
      if (tanda.length === 1 || !loteDisponible) { sueltas(tanda); continue; }
      const r = await call({ action: "lote", session: getSession(), llamadas: tanda.map((t) => ({ action: t.action, ...t.extra })) });
      if (r && r.ok === true && Array.isArray(r.resultados) && r.resultados.length === tanda.length) {
        tanda.forEach((t, k) => t.resolver(procesa(t.action, r.resultados[k])));
      } else if (r && r.ok === false && /acción desconocida/.test(String(r.error))) {
        loteDisponible = false;
        sueltas(tanda);
      } else {
        const fallo = r && r.ok === false ? r : { ok: false, error: "respuesta incompleta del lote" };
        tanda.forEach((t) => t.resolver(procesa(t.action, fallo)));
      }
    }
  };

  const authed = async (action, extra = {}) => {
    if (LOTEABLES.has(action) && loteDisponible) {
      return new Promise((resolver) => {
        cola.push({ action, extra, resolver });
        if (temporizador === null) temporizador = setTimeout(volcar, ventanaLoteMs);
      });
    }
    return procesa(action, await call({ action, session: getSession(), ...extra }));
  };

  return {
    getNonce: () => call({ action: "getNonce" }),
    login: (idToken, nonce) => call({ action: "login", idToken, nonce }),
    /**
     * Solicitudes de acceso (V-53 invitado, V-54 alta), siempre con la aprobación de un administrador
     * en 5 min. Ambas usan el `pendingToken` de un login sin vincular (la de alta, también un
     * `idToken`+`nonce`); `estadoSolicitudInvitado` se consulta hasta que la aprueben (devuelve
     * entonces la sesión). NO se reintentan `solicitarInvitado`/`solicitarAlta`/
     * `resolverSolicitudInvitado`: escriben o deciden.
     */
    solicitarAlta: (identidad, { nombre, fechaInicio, fechaFin }) =>
      call({ action: "solicitarAlta", ...(typeof identidad === "string" ? { pendingToken: identidad } : identidad), nombre, fechaInicio, fechaFin }),
    solicitarInvitado: (pendingToken) => call({ action: "solicitarInvitado", pendingToken }),
    estadoSolicitudInvitado: (solicitudToken) => call({ action: "estadoSolicitudInvitado", solicitudToken }),
    listSolicitudesInvitado: () => authed("listSolicitudesInvitado"),
    resolverSolicitudInvitado: (id, aprobar) => authed("resolverSolicitudInvitado", { id, aprobar }),
    whoami: () => authed("whoami"),
    listResidentes: () => authed("listResidentes"),
    /**
     * Fechas y periodos formativos (nota [a] de la normativa, V-24). Las tres exigen el permiso del
     * ciclo en el servidor: el retraso de una promoción lo decide tutoría, no el propio residente.
     * `periodos` viaja en la forma de la TABLA (`{anio,fechaInicio,fechaFin}`); el router la traduce
     * a la del dominio (`{year,start,end}`), que es la que vuelve en `listResidentes`.
     */
    editarResidente: (residenteId, { fechaInicio, fechaFin } = {}) => authed("editarResidente", { residenteId, fechaInicio, fechaFin }),
    guardarPeriodos: (residenteId, periodos) => authed("guardarPeriodos", { residenteId, periodos }),
    restaurarPeriodos: (residenteId) => authed("restaurarPeriodos", { residenteId }),
    listAsignaciones: (anio, mes) => authed("listAsignaciones", { anio, mes }),
    listAsignacionesRango: (desde, hasta) => authed("listAsignacionesRango", { desde, hasta }),
    guardarAsignaciones: (cambios) => authed("guardarAsignaciones", { cambios }),
    misPreferencias: (anio, mes) => authed("misPreferencias", { anio, mes }),
    /** Alcance EQUIPO (misPreferencias es el propio): las necesita quien monta el cuadrante. */
    listPreferencias: (anio, mes) => authed("listPreferencias", { anio, mes }),
    guardarPreferencias: (anio, mes, prefs) => authed("guardarPreferencias", { anio, mes, prefs }),
    validar: (cuadrante) => authed("validar", { cuadrante }),
    misBloqueos: (anio, mes) => authed("misBloqueos", { anio, mes }),
    listBloqueos: (anio, mes) => authed("listBloqueos", { anio, mes }),
    /** Por rango (no por mes): los cierres de equidad descuentan bajas de todo el trimestre/año. */
    listBloqueosRango: (desde, hasta) => authed("listBloqueosRango", { desde, hasta }),
    crearBloqueo: (desde, hasta, motivo, extra = {}) => authed("crearBloqueo", { desde, hasta, motivo, ...extra }),
    /** Festivos: dato de entrada (S-4). Por rango, porque los puentes miran el día anterior y el siguiente. */
    listFestivosRango: (desde, hasta) => authed("listFestivosRango", { desde, hasta }),
    crearFestivos: (festivos) => authed("crearFestivos", { festivos }),
    anularFestivo: (id) => authed("anularFestivo", { id }),
    /** Revisión anual de los festivos (V-63): quién y cuándo comprobó el calendario del año. */
    estadoRevisionFestivos: (anio) => authed("estadoRevisionFestivos", { anio }),
    confirmarRevisionFestivos: (anio) => authed("confirmarRevisionFestivos", { anio }),
    cancelarBloqueo: (id) => authed("cancelarBloqueo", { id }),
    /**
     * Tercer puesto (INV-8, P-16/V-55): lo que hace falta del mes pedido (`voluntarios`, `periodos`,
     * `delMes`, `yo`). Solo lee: la respuesta a «¿Deseas hacer tercer puesto este mes?» va en las
     * preferencias del mes (`guardarPreferencias`, campo `tercerPuesto`).
     */
    estadoVoluntariado3P: (mes, anio) => authed("estadoVoluntariado3P", { mes, anio }),
    /** Eventos del servicio (INV-10, V-20): dato de entrada, como los festivos. */
    listEventos: () => authed("listEventos"),
    crearEvento: (tipo, fecha, voluntarios = []) => authed("crearEvento", { tipo, fecha, voluntarios }),
    anularEvento: (id) => authed("anularEvento", { id }),
    sortearEvento: (id) => authed("sortearEvento", { id }),
    /** Excepciones (INV-9, V-29): degradan un 2×R2 documentado dentro de [desde,hasta]. */
    listExcepciones: () => authed("listExcepciones"),
    crearExcepcion: (tipo, desde, hasta, justificacion) => authed("crearExcepcion", { tipo, desde, hasta, justificacion }),
    anularExcepcion: (id) => authed("anularExcepcion", { id }),
    /** Imaginaria (INV-13, V-20): la cola se DERIVA, nunca se almacena. */
    colaImaginaria: (grupo, fecha) => authed("colaImaginaria", { grupo, fecha }),
    registrarImaginaria: (grupo, fechaIncidencia, residenteId) => authed("registrarImaginaria", { grupo, fechaIncidencia, residenteId }),
    anularImaginaria: (id) => authed("anularImaginaria", { id }),
    estadoResponsable: (anio) => authed("estadoResponsable", { anio }),
    ofrecerseResponsable: (anio) => authed("ofrecerseResponsable", { anio }),
    retirarVoluntariadoResponsable: (anio) => authed("retirarVoluntariadoResponsable", { anio }),
    ejecutarSorteoResponsable: (anio) => authed("ejecutarSorteoResponsable", { anio }),
    listResponsables: () => authed("listResponsables"),
    estadoCuadrante: (anio, mes) => authed("estadoCuadrante", { anio, mes }),
    /**
     * Generación del mes con IA (decisión V-45). NO está en REINTENTABLES a propósito, aunque el
     * fallo de transporte del `/exec` que motivó V-26 le afecte igual: repetirla escribe el mes
     * OTRA VEZ —con otro cuadrante, porque un modelo no es determinista— y gasta otra tanda de
     * llamadas de cuota. Ante la duda, fuera: es la regla que ya fija el comentario de esa lista.
     * `modo` (decisión V-47): "completar" respeta las guardias que ya hay en la rejilla y rellena
     * el resto; "reemplazar" es el comportamiento anterior, que sustituye el mes entero.
     */
    generarCuadranteIA: (anio, mes, modo = "completar", fase = "obligatorias") =>
      // `fase` solo viaja si no es la de siempre: un servidor anterior a V-59 la ignoraría.
      authed("generarCuadranteIA", fase === "obligatorias" ? { anio, mes, modo } : { anio, mes, modo, fase }),
    marcarValidado: (anio, mes) => authed("marcarValidado", { anio, mes }),
    publicarCuadrante: (anio, mes) => authed("publicarCuadrante", { anio, mes }),
    despublicarCuadrante: (anio, mes) => authed("despublicarCuadrante", { anio, mes }),
    /**
     * Vuelca el contaje al Excel del servicio (decisión V-65) sin publicar: repara un volcado que
     * falló o recoge cambios que no pasan por publicar. Escritura: fuera de REINTENTABLES y de
     * LOTEABLES. Sin la propiedad en el servidor responde `{ok:false, omitido:true, error}`.
     */
    volcarContaje: (anio, mes) => authed("volcarContaje", { anio, mes }),
  };
}

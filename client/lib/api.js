// Cliente del backend Apps Script (ADR-002 D-1). Petición "simple" para no disparar el
// preflight OPTIONS (que Apps Script no atiende): Content-Type text/plain con el JSON en
// el cuerpo, credentials 'omit' (NUNCA 'include': la respuesta trae ACAO:* y el estándar
// Fetch prohíbe wildcard+credenciales). La identidad viaja como bearer en el cuerpo
// (idToken en login/altaResidente, session en el resto), nunca en una cookie ni en un
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
 * de «HTTP 404», que no es peor. `altaResidente` NO entra: escribe un residente.
 */
const REINTENTABLES = new Set([
  "getNonce", "login", "whoami", "validar",
  "listResidentes", "listAsignaciones", "listAsignacionesRango",
  "misPreferencias", "misBloqueos", "listBloqueos", "listBloqueosRango",
  "listFestivosRango", "listEventos", "colaImaginaria",
  "estadoResponsable", "listResponsables", "estadoCuadrante", "estadoVoluntariado3P",
]);

const REINTENTOS_MS = [400, 1200]; // dos reintentos: hay una persona esperando delante
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama al backend. Nunca lanza: cualquier fallo (red, HTTP, JSON) se devuelve como
 * `{ok:false, error}` para que la UI lo trate igual que un rechazo de negocio del servidor.
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
      if (res.ok) return await res.json();
      // Se dice que es de Google y no un número pelado: el residente no puede hacer nada con un
      // «HTTP 404», y este no es culpa suya ni de sus datos.
      ultimo = { ok: false, error: `el servidor de Google no respondió bien (HTTP ${res.status})` };
    } catch (e) {
      ultimo = { ok: false, error: String((e && e.message) || e) };
    }
  }
  return ultimo;
}


/**
 * Fábrica de la API tipada. `getSession()` se invoca en cada llamada (no se cachea el
 * valor) para que un logout a mitad de sesión no reenvíe un token viejo.
 */
export function makeApi(execUrl, { fetchImpl = fetch, getSession } = {}) {
  const call = (payload) => callBackend(execUrl, payload, { fetchImpl });
  const authed = (action, extra = {}) => call({ action, session: getSession(), ...extra });

  return {
    getNonce: () => call({ action: "getNonce" }),
    login: (idToken, nonce) => call({ action: "login", idToken, nonce }),
    /**
     * Alta autoservicio. `identidad` es { idToken, nonce } (primer intento) o
     * { pendingToken } (tras un login fallido por email no vinculado — sin repetir Google).
     */
    altaResidente: (identidad, { nombre, fechaInicio, fechaFin }) =>
      call({ action: "altaResidente", ...identidad, nombre, fechaInicio, fechaFin }),
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
    cancelarBloqueo: (id) => authed("cancelarBloqueo", { id }),
    /** Tercer puesto (INV-8): autoservicio puro, «será siempre voluntario» (V-18). */
    estadoVoluntariado3P: () => authed("estadoVoluntariado3P"),
    ofrecerse3P: (compromisoAceptado) => authed("ofrecerse3P", { compromisoAceptado }),
    retirarVoluntariado3P: () => authed("retirarVoluntariado3P"),
    /** Eventos del servicio (INV-10, V-20): dato de entrada, como los festivos. */
    listEventos: () => authed("listEventos"),
    crearEvento: (tipo, fecha, voluntarios = []) => authed("crearEvento", { tipo, fecha, voluntarios }),
    anularEvento: (id) => authed("anularEvento", { id }),
    sortearEvento: (id) => authed("sortearEvento", { id }),
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
    marcarValidado: (anio, mes) => authed("marcarValidado", { anio, mes }),
    publicarCuadrante: (anio, mes) => authed("publicarCuadrante", { anio, mes }),
    despublicarCuadrante: (anio, mes) => authed("despublicarCuadrante", { anio, mes }),
  };
}

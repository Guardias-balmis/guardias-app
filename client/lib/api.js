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
 * Llama al backend. Nunca lanza: cualquier fallo (red, HTTP, JSON) se devuelve como
 * `{ok:false, error}` para que la UI lo trate igual que un rechazo de negocio del servidor.
 */
export async function callBackend(execUrl, payload, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(execUrl, buildRequestInit(payload));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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

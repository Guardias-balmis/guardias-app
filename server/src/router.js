// Router del Web App (ADR-002 D-2/D-4, paso 2.4). PURO: recibe el cuerpo crudo (el JSON que
// el cliente manda como text/plain, D-1) y unas dependencias inyectadas; devuelve un objeto
// plano que el wrapper `doPost` de Apps Script serializa. Ningún camino lanza: toda entrada
// es hostil (endpoint ANYONE_ANONYMOUS) → siempre se devuelve JSON, nunca el HTML de error.
//
// Identidad: el ID token se verifica UNA vez en `login`; a partir de ahí, cada acción lleva
// el token de sesión HMAC (validado en local, sin red). El rol se DERIVA de la tabla de
// responsables (nunca es un flag que el cliente pueda falsear).

import { issueSession, verifySession } from "./session.js";
import { verifyTokeninfo } from "./verify-token.js";

const ASIG_KEY = (r) => `${r.fecha}|${r.residenteId}`;
const PREF_KEY = (r) => `${r.residenteId}|${r.anio}|${r.mes}`;
const BLOQ_MOTIVOS = new Set(["VACACIONES", "ROTACION", "BAJA"]); // enum de motivos válidos (severidad mixta desde V-8: solo BAJA bloquea la asignación)

/**
 * @param {string} rawBody  cuerpo crudo de la petición (JSON en text/plain)
 * @param {object} deps  { now, today, clientId, sessionSecret, sessionTtl, crypto,
 *                         store, domain, issueNonce, consumeNonce, fetchTokeninfo }
 */
export function handleRequest(rawBody, deps) {
  try {
    let req;
    try {
      req = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: "cuerpo no es JSON válido" };
    }
    if (!req || typeof req !== "object") return { ok: false, error: "petición inválida" };

    switch (req.action) {
      case "getNonce":
        return { ok: true, nonce: deps.issueNonce() };

      case "login":
        return handleLogin(req, deps);

      case "altaResidente":
        return handleAlta(req, deps);

      case "whoami":
        return authed(req, deps, (session) => ({ ok: true, sub: session.sub, rol: session.rol }));

      case "validar":
        return authed(req, deps, () => {
          const violaciones = deps.domain.validateMonth(req.cuadrante);
          return { ok: true, violaciones, bloqueantes: violaciones.filter((v) => v.severidad === "error").length };
        });

      case "listResidentes":
        return authed(req, deps, () => ({ ok: true, residentes: deps.store.readRecords("residentes") }));

      case "listAsignaciones":
        return authed(req, deps, () => {
          const prefix = monthPrefix(req.anio, req.mes);
          const all = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          return { ok: true, asignaciones: all.filter((a) => a.fecha.startsWith(prefix)) };
        });

      case "guardarAsignaciones":
        return authed(req, deps, () => {
          if (!Array.isArray(req.cambios) || req.cambios.length === 0) return { ok: false, error: "cambios vacío" };
          for (const c of req.cambios) {
            deps.store.appendRecord("asignaciones", { fecha: c.fecha, residenteId: c.residenteId, codigo: c.codigo || "", puesto: c.puesto, origen: c.origen });
          }
          return { ok: true, guardados: req.cambios.length };
        });

      case "misPreferencias":
        return authed(req, deps, (session) => {
          const all = deps.store.readLatest("preferencias", PREF_KEY);
          const mine = all.find((p) => p.residenteId === session.sub && p.anio === req.anio && p.mes === req.mes);
          return { ok: true, prefs: mine || null };
        });

      case "guardarPreferencias":
        return authed(req, deps, (session) => {
          if (!req.prefs || typeof req.prefs !== "object") return { ok: false, error: "prefs inválido" };
          deps.store.appendRecord("preferencias", { residenteId: session.sub, anio: req.anio, mes: req.mes, ...req.prefs });
          return { ok: true };
        });

      case "crearBloqueo":
        return authed(req, deps, (session) => {
          if (!BLOQ_MOTIVOS.has(req.motivo)) return { ok: false, error: "motivo inválido" };
          if (!req.desde || !req.hasta || req.desde > req.hasta) return { ok: false, error: "rango de fechas inválido" };
          const id = deps.store.appendRecord("bloqueos", {
            residenteId: session.sub, desde: req.desde, hasta: req.hasta, motivo: req.motivo,
            provincia: req.provincia, guardiasEnCentroExterno: req.guardiasEnCentroExterno, activo: true,
          });
          return { ok: true, id };
        });

      case "misBloqueos":
        return authed(req, deps, (session) =>
          ({ ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes).filter((b) => b.residenteId === session.sub) }));

      // A diferencia de misBloqueos (alcance propio, para Preferencias), esta acción
      // devuelve los bloqueos de TODO el equipo: el validador de CalendarScreen (INV-5/6/7)
      // necesita conocer los bloqueos de todos los residentes, no solo de quien valida.
      case "listBloqueos":
        return authed(req, deps, () => ({ ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes) }));

      case "cancelarBloqueo":
        return authed(req, deps, (session) => {
          const actuales = deps.store.readLatest("bloqueos", (r) => r.id);
          const propio = actuales.find((b) => b.id === req.id && b.residenteId === session.sub);
          if (!propio) return { ok: false, error: "bloqueo no encontrado o ajeno" };
          deps.store.appendRecord("bloqueos", { ...propio, activo: false });
          return { ok: true };
        });

      case "estadoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio, periodoFin } = mandatoPeriod(req.anio);
          const residentes = deps.store.readRecords("residentes");
          const elegibles = deps.domain.eligibleCandidates(residentes, periodoInicio);
          const voluntarios = activeVolunteers(deps, periodoInicio);
          const mandato = currentMandate(deps, periodoInicio);
          return { ok: true, periodoInicio, periodoFin, elegibles, voluntarios, meHeOfrecido: voluntarios.includes(session.sub), mandato };
        });

      case "ofrecerseResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = deps.store.readRecords("residentes");
          const elegibles = deps.domain.eligibleCandidates(residentes, periodoInicio);
          if (!elegibles.includes(session.sub)) return { ok: false, error: "no tienes nivel R3 en ese periodo" };
          deps.store.appendRecord("voluntariosResponsable", { residenteId: session.sub, periodoInicio, activo: true });
          return { ok: true };
        });

      case "retirarVoluntariadoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          deps.store.appendRecord("voluntariosResponsable", { residenteId: session.sub, periodoInicio, activo: false });
          return { ok: true };
        });

      case "ejecutarSorteoResponsable":
        return authed(req, deps, () => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio, periodoFin } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = deps.store.readRecords("residentes");
          const elegibles = deps.domain.eligibleCandidates(residentes, periodoInicio);
          if (elegibles.length === 0) return { ok: false, error: "no hay ningún R3 elegible para ese periodo" };
          const voluntarios = activeVolunteers(deps, periodoInicio);
          const decision = deps.domain.resolveMethod(elegibles, voluntarios);

          const record = decision.metodo === "VOLUNTARIO"
            ? { periodoInicio, periodoFin, residenteId: decision.residenteId, metodo: "VOLUNTARIO", voluntarios }
            : (() => {
              const semilla = deps.newSeed();
              const residenteId = deps.domain.drawResponsible(decision.candidatos, semilla);
              return { periodoInicio, periodoFin, residenteId, metodo: "SORTEO", voluntarios, candidatos: decision.candidatos, semilla, fechaSorteo: deps.today };
            })();

          const violaciones = deps.domain.validateResponsible(record, { residentes });
          if (violaciones.length > 0) return { ok: false, error: "fallo interno: " + violaciones.map((v) => v.detalle).join("; ") };

          const id = deps.store.appendRecord("responsables", record);
          return { ok: true, mandato: { id, ...record } };
        });

      case "listResponsables":
        return authed(req, deps, () => ({
          ok: true,
          mandatos: deps.store.readLatest("responsables", (r) => r.periodoInicio).sort((a, b) => (a.periodoInicio < b.periodoInicio ? -1 : 1)),
        }));

      default:
        return { ok: false, error: `acción desconocida: ${req.action}` };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Verifica el ID token de una petición (login/altaResidente) y devuelve el email, o el error. */
function verifyIdentity(req, deps) {
  const claims = deps.fetchTokeninfo(req.idToken);
  return verifyTokeninfo(claims, { clientId: deps.clientId, now: deps.now, consumeNonce: deps.consumeNonce });
}

function sessionFor(residente, deps) {
  const rol = resolveRol(deps.store, residente.id, deps.today);
  const session = issueSession({ sub: residente.id, rol }, { now: deps.now, ttlSeconds: deps.sessionTtl, secret: deps.sessionSecret, crypto: deps.crypto });
  return { ok: true, session, residente: { id: residente.id, nombre: residente.nombre, rol } };
}

const PENDING_TTL = 300; // 5 min: solo para completar el alta tras un login fallido por email desconocido.

function handleLogin(req, deps) {
  const v = verifyIdentity(req, deps);
  if (!v.ok) return { ok: false, error: v.reason };

  const residente = deps.store.readRecords("residentes").find((r) => (r.email || "").toLowerCase() === v.email);
  if (!residente) {
    // El email SÍ quedó verificado con Google (aud/iss/email_verified/exp ya comprobados);
    // se emite un token de corta vida para que el cliente pueda completar el alta sin
    // repetir el login de Google (y sin el problema de reusar un nonce ya consumido).
    const pendingToken = issueSession({ pending: true, email: v.email }, { now: deps.now, ttlSeconds: PENDING_TTL, secret: deps.sessionSecret, crypto: deps.crypto });
    return { ok: false, error: "email no vinculado a ningún residente", pendingToken };
  }

  return sessionFor(residente, deps);
}

/**
 * Alta autoservicio (DoD-1: "un R1 nuevo se da de alta solo"). Verifica identidad de dos
 * formas posibles: (a) un `idToken`+`nonce` frescos (como login), o (b) un `pendingToken`
 * emitido por un login previo que falló solo por "email no vinculado" — evita un segundo
 * popup de Google. El nivel R1-R4 no se pide: se deriva de `fechaInicio`/`fechaFin` (S-2).
 */
function handleAlta(req, deps) {
  let email;
  if (req.pendingToken) {
    const s = verifySession(req.pendingToken, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
    if (!s.valid || !s.payload.pending) return { ok: false, error: "pendingToken inválido o caducado" };
    email = s.payload.email;
  } else {
    const v = verifyIdentity(req, deps);
    if (!v.ok) return { ok: false, error: v.reason };
    email = v.email;
  }

  if (!req.nombre || !req.fechaInicio || !req.fechaFin) return { ok: false, error: "nombre, fechaInicio y fechaFin son obligatorios" };

  const yaExiste = deps.store.readRecords("residentes").some((r) => (r.email || "").toLowerCase() === email);
  if (yaExiste) return { ok: false, error: "ese email ya está vinculado a un residente" };

  const id = deps.store.appendRecord("residentes", { nombre: req.nombre, email, fechaInicio: req.fechaInicio, fechaFin: req.fechaFin });
  return sessionFor({ id, nombre: req.nombre }, deps);
}

/** Prefijo "YYYY-MM" de una fecha ISO, para filtrar asignaciones de un mes concreto. */
function monthPrefix(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/** Bloqueos activos (de cualquier residente) que solapan el mes dado. */
function activeBloqueosInMonth(deps, anio, mes) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const monthEnd = `${prefix}-31`; // comparación lexicográfica ISO: basta un tope holgado
  return deps.store.readLatest("bloqueos", (r) => r.id)
    .filter((b) => b.activo === true && b.desde <= monthEnd && b.hasta >= monthStart);
}

function isYear(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 2000 && v < 2100;
}

/** Mandato enero→enero (INV-14) para el año dado: [YYYY-01-01, (YYYY+1)-01-01). */
function mandatoPeriod(anio) {
  return { periodoInicio: `${anio}-01-01`, periodoFin: `${anio + 1}-01-01` };
}

/** Voluntarios activos (última reinserción gana, como cancelarBloqueo) para un periodo. */
function activeVolunteers(deps, periodoInicio) {
  return deps.store.readLatest("voluntariosResponsable", (r) => `${r.residenteId}|${r.periodoInicio}`)
    .filter((v) => v.periodoInicio === periodoInicio && v.activo === true)
    .map((v) => v.residenteId);
}

/** El mandato ya decidido para un periodo, si existe (última reinserción gana). */
function currentMandate(deps, periodoInicio) {
  return deps.store.readLatest("responsables", (r) => r.periodoInicio).find((r) => r.periodoInicio === periodoInicio) || null;
}

/** Valida la sesión y ejecuta `fn(payload)`, o devuelve el error de sesión. */
function authed(req, deps, fn) {
  const s = verifySession(req.session, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid) return { ok: false, error: `sesión ${s.reason}` };
  return fn(s.payload);
}

/**
 * Rol derivado: 'responsable' si hoy cae dentro de un mandato de la tabla responsables.
 * `readLatest` por periodoInicio (no `readRecords` crudo): si un mandato se reemplaza por
 * una corrección posterior (misma clave), la fila vieja no debe seguir concediendo el rol.
 */
function resolveRol(store, residenteId, today) {
  const mandatos = store.readLatest("responsables", (r) => r.periodoInicio);
  const activo = mandatos.some((m) => m.residenteId === residenteId && m.periodoInicio <= today && today < m.periodoFin);
  return activo ? "responsable" : "residente";
}

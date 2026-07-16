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

function handleLogin(req, deps) {
  const v = verifyIdentity(req, deps);
  if (!v.ok) return { ok: false, error: v.reason };

  const residente = deps.store.readRecords("residentes").find((r) => (r.email || "").toLowerCase() === v.email);
  if (!residente) return { ok: false, error: "email no vinculado a ningún residente" };

  return sessionFor(residente, deps);
}

/**
 * Alta autoservicio (DoD-1: "un R1 nuevo se da de alta solo"). Verifica el ID token de
 * Google como login, pero en vez de exigir un residente ya vinculado, CREA uno — siempre
 * que el email no esté ya vinculado (evita duplicados). El nivel R1-R4 no se pide: se
 * deriva de `fechaInicio`/`fechaFin` (spec.md S-2).
 */
function handleAlta(req, deps) {
  const v = verifyIdentity(req, deps);
  if (!v.ok) return { ok: false, error: v.reason };

  if (!req.nombre || !req.fechaInicio || !req.fechaFin) return { ok: false, error: "nombre, fechaInicio y fechaFin son obligatorios" };

  const yaExiste = deps.store.readRecords("residentes").some((r) => (r.email || "").toLowerCase() === v.email);
  if (yaExiste) return { ok: false, error: "ese email ya está vinculado a un residente" };

  const id = deps.store.appendRecord("residentes", { nombre: req.nombre, email: v.email, fechaInicio: req.fechaInicio, fechaFin: req.fechaFin });
  return sessionFor({ id, nombre: req.nombre }, deps);
}

/** Prefijo "YYYY-MM" de una fecha ISO, para filtrar asignaciones de un mes concreto. */
function monthPrefix(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/** Valida la sesión y ejecuta `fn(payload)`, o devuelve el error de sesión. */
function authed(req, deps, fn) {
  const s = verifySession(req.session, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid) return { ok: false, error: `sesión ${s.reason}` };
  return fn(s.payload);
}

/** Rol derivado: 'responsable' si hoy cae dentro de un mandato de la tabla responsables. */
function resolveRol(store, residenteId, today) {
  const mandatos = store.readRecords("responsables").filter((r) => r.residenteId === residenteId);
  const activo = mandatos.some((m) => m.periodoInicio <= today && today < m.periodoFin);
  return activo ? "responsable" : "residente";
}

/**
 * server-lib.gs · guardias-app para Google Apps Script.
 * ARTEFACTO GENERADO por build/build-gas.mjs desde server/src/*.js — NO EDITAR A MANO.
 * Regenerar: `npm run build`. La paridad con la fuente ESM la verifica parity.test.js.
 */


// ── sheets-schema.js ──
var SheetsSchema = (function () {
// Esquema de las pestañas de datos normalizadas (ADR-002 D-3). PURO: solo define las tablas
// y el mapeo fila↔registro por tipos. La fuente de verdad es append-only con clave UUID
// (spec §2 / ADR-001 §3): nunca se reescribe una fila cruda, solo se añaden.
//
// Los valores viajan a/desde el Sheet como celdas; cada columna declara su tipo para
// recuperar números/booleanos/JSON sin ambigüedad (un `anio` debe volver como number, no "3").

const col = (key, type = "string") => ({ key, type });

const TABLES = {
  residentes: { name: "residentes", columns: [col("id"), col("nombre"), col("email"), col("fechaInicio"), col("fechaFin")] },
  periodos: { name: "periodos", columns: [col("id"), col("residenteId"), col("anio", "number"), col("fechaInicio"), col("fechaFin")] },
  bloqueos: { name: "bloqueos", columns: [col("id"), col("residenteId"), col("desde"), col("hasta"), col("motivo"), col("provincia"), col("guardiasEnCentroExterno", "bool"), col("activo", "bool")] },
  asignaciones: { name: "asignaciones", columns: [col("id"), col("fecha"), col("residenteId"), col("codigo"), col("puesto"), col("origen")] },
  responsables: { name: "responsables", columns: [col("id"), col("periodoInicio"), col("periodoFin"), col("residenteId"), col("metodo"), col("voluntarios", "json"), col("semilla"), col("candidatos", "json"), col("fechaSorteo")] },
  voluntariosResponsable: { name: "voluntariosResponsable", columns: [col("id"), col("residenteId"), col("periodoInicio"), col("activo", "bool")] },
  sorteos: { name: "sorteos", columns: [col("id"), col("fecha"), col("motivo"), col("semilla"), col("candidatos", "json"), col("resultado", "json")] },
  // Fase 4: diasPreferidos/diasEvitar (día de semana genérico) y rotDe/rotHasta/vacDe/vacHasta
  // (número de día suelto) del v1 se sustituyen por fechas concretas (BLANDO) y por la tabla
  // `bloqueos` — spec.md §5 Fase 4: "distingue DURO vs BLANDO, son cosas distintas". Desde V-8
  // (Fase 5.x) la severidad dentro de `bloqueos` ya no es uniforme: solo motivo BAJA bloquea
  // la asignación (INV-5); VACACIONES/ROTACION son informativas.
  preferencias: { name: "preferencias", columns: [col("id"), col("residenteId"), col("anio", "number"), col("mes", "number"), col("maxGuardias", "number"), col("preferDobles", "bool"), col("fechasEvitar", "json"), col("notas")] },
};

/** Cabecera (nombres de columna) de una tabla. */
function headerOf(table) {
  return table.columns.map((c) => c.key);
}

/** Registro → fila de celdas, en el orden de las columnas. */
function recordToRow(table, record) {
  return table.columns.map((c) => serialize(record[c.key], c.type));
}

/** [cabecera, ...filas] → registros. Ignora la cabecera y mapea por posición de columna. */
function rowsToRecords(table, values) {
  if (!values || values.length <= 1) return [];
  return values.slice(1).map((row) => {
    const rec = {};
    table.columns.forEach((c, i) => {
      const v = deserialize(row[i], c.type);
      if (v !== undefined) rec[c.key] = v;
    });
    return rec;
  });
}

function serialize(value, type) {
  if (value === undefined || value === null) return "";
  switch (type) {
    case "number": return String(value);
    case "bool": return value ? "TRUE" : "FALSE";
    case "json": return JSON.stringify(value);
    default: return String(value);
  }
}

function deserialize(cell, type) {
  if (cell === undefined || cell === null || cell === "") return undefined;
  switch (type) {
    case "number": return Number(cell);
    case "bool": return cell === true || cell === "TRUE" || cell === "true";
    case "json": try { return JSON.parse(cell); } catch { return undefined; }
    default: return String(cell);
  }
}

  return { TABLES, headerOf, recordToRow, rowsToRecords };
})();

// ── sheets-store.js ──
var SheetsStore = (function () {
// Almacén sobre Google Sheets (ADR-002 D-3, paso 2.3). La lógica (append-only, shadow-swap)
// es pura y testeable; las operaciones de hoja se delegan en un `ss` inyectado (en Apps
// Script, un adaptador de SpreadsheetApp; en los tests, un fake en memoria). Toda escritura
// pasa por `withLock` (un único `LockService.getScriptLock()` para los 15 usuarios, porque el
// Web App corre "Execute as Me" bajo una sola identidad → un lock por usuario no serializaría).
//
// `ss` debe ofrecer: listSheets, exists, read, overwrite, append, createSheet, deleteSheet,
// renameSheet. `newId()` genera UUID (Utilities.getUuid en Apps Script).

  const { TABLES, headerOf, recordToRow, rowsToRecords } = SheetsSchema;

const TMP_PREFIX = "_tmp_";

function makeStore({ ss, withLock, newId }) {
  function table(nameOrTable) {
    const t = typeof nameOrTable === "string" ? TABLES[nameOrTable] : nameOrTable;
    if (!t) throw new Error(`tabla desconocida: ${nameOrTable}`);
    return t;
  }

  /** Añade un registro (append-only). Genera `id` si no lo trae. Devuelve el id. */
  function appendRecord(nameOrTable, record) {
    const t = table(nameOrTable);
    return withLock(() => {
      if (ss.read(t.name).length === 0) ss.append(t.name, [headerOf(t)]); // cabecera si falta
      const id = record.id || newId();
      ss.append(t.name, [recordToRow(t, { ...record, id })]);
      return id;
    });
  }

  /** Lee todos los registros de una tabla normalizada. */
  function readRecords(nameOrTable) {
    const t = table(nameOrTable);
    return rowsToRecords(t, ss.read(t.name));
  }

  /**
   * Vista de "estado actual" sobre un almacén append-only: para cada clave (`keyFn`), la
   * ÚLTIMA fila insertada gana. Si `opts.emptyField` se indica y el registro ganador tiene
   * ese campo vacío/ausente, es un borrado explícito y se excluye del resultado.
   * Conserva el orden de PRIMERA aparición de cada clave (una reedición no reordena).
   */
  function readLatest(nameOrTable, keyFn, opts = {}) {
    const records = readRecords(nameOrTable);
    const order = [];
    const byKey = new Map();
    for (const r of records) {
      const k = keyFn(r);
      if (!byKey.has(k)) order.push(k);
      byKey.set(k, r); // sobreescribe: la última fila de esta clave gana
    }
    return order
      .map((k) => byKey.get(k))
      .filter((r) => !opts.emptyField || (r[opts.emptyField] !== undefined && r[opts.emptyField] !== ""));
  }

  /**
   * Reescribe una pestaña (entregable proyectado) de forma idempotente y crash-safe por
   * "shadow-swap": se vuelca a una temporal, se borra la vieja y se renombra la temporal.
   * Si un intento previo cayó a mitad, se limpia el `_tmp_` residual antes de empezar.
   */
  function rebuildSheet(name, rows) {
    return withLock(() => {
      const tmp = TMP_PREFIX + name;
      if (ss.exists(tmp)) ss.deleteSheet(tmp); // limpia residuo de una caída anterior
      ss.createSheet(tmp);
      ss.overwrite(tmp, rows);
      if (ss.exists(name)) ss.deleteSheet(name); // ventana de inconsistencia: dos metadata ops rápidas
      ss.renameSheet(tmp, name);
    });
  }

  return { appendRecord, readRecords, readLatest, rebuildSheet };
}

  return { makeStore };
})();

// ── session.js ──
var Session = (function () {
// Token de sesión HMAC-SHA256 (ADR-002 D-2, paso 2.1). Puro y sin I/O: las primitivas
// (`hmac`, `b64urlEncode`, `b64urlDecode`) se inyectan — en Node con `crypto`, en Apps Script
// con `Utilities.computeHmacSha256Signature` + `Utilities.base64EncodeWebSafe`.
//
// El token es `base64url(payloadJSON).base64url(HMAC(payload, secreto))`. Tras verificar el
// ID token de Google UNA vez por login, el servidor emite esta sesión; las siguientes
// peticiones se validan en local con el HMAC, sin volver a tocar la red. El secreto se
// autogenera y vive solo en PropertiesService; rotarlo simplemente re-loguea a todos.
//
// Regla de seguridad: los claims van FIRMADOS pero NO cifrados — no meter nada sensible;
// solo el UUID del residente (`sub`), el rol y `exp`.

/**
 * @param {object} claims  p.ej. { sub: uuid, rol }
 * @param {{now:number, ttlSeconds:number, secret:string, crypto:object}} opts
 * @returns {string} token `payload.sig`
 */
function issueSession(claims, { now, ttlSeconds, secret, crypto }) {
  const payload = { ...claims, exp: now + ttlSeconds };
  const payloadB64 = crypto.b64urlEncode(JSON.stringify(payload));
  const sig = crypto.hmac(payloadB64, secret);
  return payloadB64 + "." + sig;
}

/**
 * @param {string} token
 * @param {{now:number, secret:string, crypto:object}} opts
 * @returns {{valid:boolean, payload?:object, reason?:string}}
 */
function verifySession(token, { now, secret, crypto }) {
  if (typeof token !== "string") return invalid("formato");
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return invalid("formato");
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Comparación en tiempo (casi) constante: Apps Script no trae crypto.timingSafeEqual.
  const expected = crypto.hmac(payloadB64, secret);
  if (!timingSafeEqual(sig, expected)) return invalid("firma");

  let payload;
  try {
    payload = JSON.parse(crypto.b64urlDecode(payloadB64));
  } catch {
    return invalid("payload");
  }
  if (!payload || typeof payload.exp !== "number") return invalid("payload");
  if (now >= payload.exp) return invalid("expirada");

  return { valid: true, payload };
}

function invalid(reason) {
  return { valid: false, reason };
}

/** Comparación de strings resistente a timing: recorre SIEMPRE la longitud del esperado. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

  return { issueSession, verifySession };
})();

// ── verify-token.js ──
var VerifyToken = (function () {
// Verificación del ID token de Google (ADR-002 D-2, paso 2.2). PURA: opera sobre la respuesta
// ya parseada de `https://oauth2.googleapis.com/tokeninfo?id_token=…`. La llamada de red
// (`UrlFetchApp` con reintentos + backoff) es un adaptador aparte.
//
// CLAVE DE SEGURIDAD: tokeninfo valida firma, `iss` y `exp`, pero **NO la audiencia**. El
// chequeo `aud === CLIENT_ID` es OBLIGATORIO y es el fallo estrella: sin él se aceptaría un
// ID token emitido para cualquier otra app OAuth del ecosistema Google → suplantación total.

const ISS_VALIDOS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/**
 * @param {object} claims respuesta parseada de tokeninfo
 * @param {{clientId:string, now:number, consumeNonce?:(nonce:string)=>boolean}} opts
 *   consumeNonce (si se pasa) exige un nonce de un solo uso (anti-replay del login).
 * @returns {{ok:boolean, email?:string, sub?:string, reason?:string}}
 */
function verifyTokeninfo(claims, { clientId, now, consumeNonce }) {
  if (!claims || typeof claims !== "object") return fail("respuesta vacía o inválida");

  // 1. Audiencia — el chequeo que tokeninfo NO hace por ti. Imprescindible.
  if (claims.aud !== clientId) return fail("aud incorrecta (token emitido para otra app)");

  // 2. Emisor.
  if (!ISS_VALIDOS.has(claims.iss)) return fail("iss inválida");

  // 3. Email verificado (tokeninfo lo devuelve como string "true").
  if (claims.email_verified !== true && claims.email_verified !== "true") return fail("email no verificado");

  // 4. Expiración re-chequeada en local (cinturón y tirantes; llega como string).
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || now >= exp) return fail("token expirado");

  // 5. Nonce de un solo uso (si se exige).
  if (consumeNonce) {
    if (!claims.nonce) return fail("falta nonce");
    if (!consumeNonce(claims.nonce)) return fail("nonce reusado o desconocido");
  }

  // Email normalizado a minúsculas: es la clave para resolver el residente y NO debe fallar
  // por diferencias de mayúsculas (el cliente v1 tenía justo ese bug, index.html:188).
  return { ok: true, email: String(claims.email || "").toLowerCase(), sub: claims.sub };
}

function fail(reason) {
  return { ok: false, reason };
}

  return { verifyTokeninfo };
})();

// ── router.js ──
var Router = (function () {
// Router del Web App (ADR-002 D-2/D-4, paso 2.4). PURO: recibe el cuerpo crudo (el JSON que
// el cliente manda como text/plain, D-1) y unas dependencias inyectadas; devuelve un objeto
// plano que el wrapper `doPost` de Apps Script serializa. Ningún camino lanza: toda entrada
// es hostil (endpoint ANYONE_ANONYMOUS) → siempre se devuelve JSON, nunca el HTML de error.
//
// Identidad: el ID token se verifica UNA vez en `login`; a partir de ahí, cada acción lleva
// el token de sesión HMAC (validado en local, sin red). El rol se DERIVA de la tabla de
// responsables (nunca es un flag que el cliente pueda falsear).

  const { issueSession, verifySession } = Session;
  const { verifyTokeninfo } = VerifyToken;

const ASIG_KEY = (r) => `${r.fecha}|${r.residenteId}`;
const PREF_KEY = (r) => `${r.residenteId}|${r.anio}|${r.mes}`;
const BLOQ_MOTIVOS = new Set(["VACACIONES", "ROTACION", "BAJA"]); // enum de motivos válidos (severidad mixta desde V-8: solo BAJA bloquea la asignación)

/**
 * @param {string} rawBody  cuerpo crudo de la petición (JSON en text/plain)
 * @param {object} deps  { now, today, clientId, sessionSecret, sessionTtl, crypto,
 *                         store, domain, issueNonce, consumeNonce, fetchTokeninfo }
 */
function handleRequest(rawBody, deps) {
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

      // A diferencia de listAsignaciones (filtra por mes/año), esta filtra por rango de
      // fechas ISO [desde,hasta] pudiendo cruzar meses o años — la usa el cliente para el
      // contrato C-2 (INV-7 necesita las asignaciones de TODO el periodo de rotación,
      // aunque empiece en un mes anterior) y para el contaje acumulado del generador (§4).
      case "listAsignacionesRango":
        return authed(req, deps, () => {
          if (!req.desde || !req.hasta || req.desde > req.hasta) return { ok: false, error: "rango de fechas inválido" };
          const all = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          return { ok: true, asignaciones: all.filter((a) => a.fecha >= req.desde && a.fecha <= req.hasta) };
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

  return { handleRequest };
})();

// ── API pública ──
var Server = Object.assign({}, SheetsSchema, SheetsStore, Session, VerifyToken, Router);

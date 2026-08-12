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
  residentes: { name: "residentes", columns: [col("id"), col("nombre"), col("email"), col("fechaInicio", "date"), col("fechaFin", "date")] },
  periodos: { name: "periodos", columns: [col("id"), col("residenteId"), col("anio", "number"), col("fechaInicio", "date"), col("fechaFin", "date")] },
  bloqueos: { name: "bloqueos", columns: [col("id"), col("residenteId"), col("desde", "date"), col("hasta", "date"), col("motivo"), col("provincia"), col("guardiasEnCentroExterno", "bool"), col("activo", "bool")] },
  asignaciones: { name: "asignaciones", columns: [col("id"), col("fecha", "date"), col("residenteId"), col("codigo"), col("puesto"), col("origen")] },
  // Festivos: DATO DE ENTRADA, nunca derivado ni delegado a la IA (S-4; el cliente v1 le pedía
  // al modelo "identifícalos tú"). `anio` NO se almacena, se deriva de `fecha` (§1). `activo`
  // permite corregir una fecha mal cargada reinsertando la fila con activo=false, igual que
  // `bloqueos` — la tabla no se reescribe nunca. `ambito` (NACIONAL/AUTONOMICO/LOCAL) es
  // informativo: los locales de Alicante son festivos reales y cambian de fecha cada año, así
  // que sin ellos INV-12 avisaría en falso sobre GF correctas.
  festivos: { name: "festivos", columns: [col("id"), col("fecha", "date"), col("nombre"), col("ambito"), col("activo", "bool")] },
  // Eventos del servicio (INV-10, decisión V-20): comida de Navidad y despedida de R4. Son
  // DATOS DE ENTRADA como los festivos —la fecha la pone el servicio cada año, no se deriva de
  // nada— y por eso la tabla se parece a `festivos`: append-only, `activo` para corregir por
  // reinserción. `designados` se ALMACENA (no se deriva de quién tuviera guardia ese día):
  // validar la despedida de mayo necesita saber quién cubrió la Navidad del diciembre anterior,
  // y guardarlo evita que junio tenga que leer las asignaciones de diciembre. La contrapartida,
  // aceptada: si alguien cambia la guardia del día de Navidad después, esta lista no se entera.
  // `sorteoId` apunta a la tabla `sorteos` (la misma de INV-14): es lo que hace comprobable el
  // «a sorteo» de la normativa en vez de un booleano que nadie puede verificar.
  eventos: { name: "eventos", columns: [col("id"), col("tipo"), col("fecha", "date"), col("voluntarios", "json"), col("designados", "json"), col("sorteoId"), col("activo", "bool")] },
  // Imaginaria (INV-13, decisión V-20). NO se almacena la cola: se registra cada cobertura real
  // y la cola se DERIVA de ese historial (§1, «derivar > almacenar»), igual que el nivel R1-R4.
  // Una guardia de incidencia cedida o comprada no genera fila, y por eso no mueve a nadie en la
  // cola — literal de la normativa p.4.
  imaginaria: { name: "imaginaria", columns: [col("id"), col("grupo"), col("fechaIncidencia", "date"), col("residenteId"), col("registradaEn", "date"), col("activo", "bool")] },
  responsables: { name: "responsables", columns: [col("id"), col("periodoInicio", "date"), col("periodoFin", "date"), col("residenteId"), col("metodo"), col("voluntarios", "json"), col("semilla"), col("candidatos", "json"), col("fechaSorteo", "date")] },
  voluntariosResponsable: { name: "voluntariosResponsable", columns: [col("id"), col("residenteId"), col("periodoInicio", "date"), col("activo", "bool")] },
  // Voluntarios del TERCER PUESTO (INV-8a, decisión V-18). Se parece a voluntariosResponsable
  // —append-only, `activo` para retirarse reinsertando— pero NO lleva `periodoInicio`: el 3P no
  // se elige por periodos comunes, cada residente se apunta el día que quiere y su ciclo L-D
  // (INV-8b) arranca ahí. Por eso `desde` es la fecha de alta real y no un borde de calendario:
  // es lo que `thirdPostHistoryStart` usa para saber desde cuándo leer el historial, y lo que
  // fija el compromiso de permanencia de 4 meses (`thirdPostCommitmentEnd`). Se guarda además
  // `compromisoAceptado` porque el compromiso se acepta explícitamente al apuntarse: sin dejar
  // constancia, negarle a alguien la retirada sería una regla que nadie aceptó.
  // `hasta` solo lo escribe la retirada, y hoy no lo lee ningún invariante: existe porque sin él
  // la fila de baja es indistinguible de la de alta y la fecha en que alguien dejó el 3P se
  // perdería para siempre en una tabla cuyo sentido es que el historial no se borra nunca. Lo
  // necesitará quien arregle la laguna anotada en §7: INV-8a juzga un mes pasado con la lista de
  // HOY, así que a quien se retiró en diciembre le avisa en falso por los 3P que hizo en julio.
  voluntarios3P: { name: "voluntarios3P", columns: [col("id"), col("residenteId"), col("desde", "date"), col("hasta", "date"), col("compromisoAceptado", "bool"), col("activo", "bool")] },
  sorteos: { name: "sorteos", columns: [col("id"), col("fecha", "date"), col("motivo"), col("semilla"), col("candidatos", "json"), col("resultado", "json")] },
  // Fase 4: diasPreferidos/diasEvitar (día de semana genérico) y rotDe/rotHasta/vacDe/vacHasta
  // (número de día suelto) del v1 se sustituyen por fechas concretas (BLANDO) y por la tabla
  // `bloqueos` — spec.md §5 Fase 4: "distingue DURO vs BLANDO, son cosas distintas". Desde V-8
  // (Fase 5.x) la severidad dentro de `bloqueos` ya no es uniforme: solo motivo BAJA bloquea
  // la asignación (INV-5); VACACIONES/ROTACION son informativas.
  // preferDobles pasó de bool a enum de texto ("" | VIERNES_DOMINGO | JUEVES_SABADO) el
  // 2026-08-08, a petición del autor — ver client/screens/Prefs.jsx:DOBLETE_LABEL. Las filas
  // viejas con TRUE/FALSE se leen tal cual (string plana) y no calzan con ningún valor del
  // nuevo enum: no rompen nada, simplemente no coinciden hasta que el residente vuelva a guardar.
  preferencias: { name: "preferencias", columns: [col("id"), col("residenteId"), col("anio", "number"), col("mes", "number"), col("maxGuardias", "number"), col("preferDobles"), col("fechasEvitar", "json"), col("notas")] },
  // Fase 6.2: ciclo BORRADOR|VALIDADO|PUBLICADO por mes+año (spec.md §2 Cuadrante). Cada fila
  // es UNA transición de estado (append-only, `readLatest` por mes|anio se queda con la
  // última); `actorId`/`fecha` identifican quién la disparó y cuándo, sin distinguir un campo
  // por tipo de transición (generadoPor/validadoPor/...) — el historial completo de quién hizo
  // qué ya queda en las filas append-only anteriores si algún día hace falta auditarlo.
  cuadrantes: { name: "cuadrantes", columns: [col("id"), col("mes", "number"), col("anio", "number"), col("estado"), col("actorId"), col("fecha", "date")] },
  // Excepcion (spec.md §2, decisión V-29): degrada una violación DURA→AVISO donde la normativa lo
  // permite. Hoy el único consumidor es `validate.js:twoR2Justified` (INV-9, tipo "2xR2"): un
  // 2×R2 dentro de [desde,hasta] deja de avisar si hay una excepción documentada que lo cubra.
  // Append-only como `festivos`/`eventos`: `activo` corrige por reinserción, nunca se borra una
  // fila. `tipo` es el identificador que lee el dominio (no `INV-n`: un mismo invariante podría
  // en el futuro tener más de un tipo de excepción), y añadir uno nuevo exige cablearlo en
  // `validateMonth`/`buildMonthContext` para que tenga efecto — la tabla por sí sola no hace nada.
  excepciones: { name: "excepciones", columns: [col("id"), col("tipo"), col("desde", "date"), col("hasta", "date"), col("justificacion"), col("registradaPor"), col("fecha", "date"), col("activo", "bool")] },
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
    // Bug real (Fase 2.6/7.1, primer uso en vivo): Sheets detecta un string "YYYY-MM-DD" y
    // convierte la celda a tipo Fecha interno; el apóstrofe fuerza texto plano (invisible
    // tras guardar, por UI o por API) para que la celda se quede como el string que mandamos.
    case "date": return `'${value}`;
    default: return String(value);
  }
}

function deserialize(cell, type) {
  if (cell === undefined || cell === null || cell === "") return undefined;
  switch (type) {
    case "number": return Number(cell);
    case "bool": return cell === true || cell === "TRUE" || cell === "true";
    case "json": try { return JSON.parse(cell); } catch { return undefined; }
    // Contraparte de "date" en serialize: si el apóstrofe no llegó a evitar la conversión
    // (celda ya corrompida de antes de este fix, o algún borde de Sheets que lo ignore),
    // `cell` llega como un Date real — se recupera "YYYY-MM-DD" con getters LOCALES (no
    // UTC: Apps Script corre con el huso horario del proyecto, el mismo que ancló la
    // medianoche de esa celda — distinto del "siempre UTC" del dominio, pensado para el
    // navegador). Si no, es el string con apóstrofe (el `ss` falso de los tests no simula
    // el despojo de Sheets, así que llega literal).
    case "date": return cell instanceof Date ? isoFromLocalDate(cell) : String(cell).replace(/^'/, "");
    default: return String(cell);
  }
}

function isoFromLocalDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
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
//
// Contrato del adaptador, fijado tras un fallo que ningún test podía ver (2026-07-27):
//  - `append(nombre, filas)` CREA la hoja si no existe (este módulo escribe luego la cabecera).
//  - `overwrite` y `append` deben AMPLIAR la rejilla si hace falta. En Apps Script una hoja nace
//    con 1000 filas × 26 columnas y `getRange` fuera de rango lanza: la pestaña mensual de la
//    proyección necesita hasta 40 columnas, y una tabla append-only pasa de 1000 filas sola.
//    El `ss` de los tests es un array de arrays sin límites, así que esto NO lo cubre ningún
//    test: vive en server/Code.gs y se verifica a mano contra el Sheet real.

  const { TABLES, headerOf, recordToRow, rowsToRecords } = SheetsSchema;

const TMP_PREFIX = "_tmp_";

function makeStore({ ss, withLock, newId }) {
  function table(nameOrTable) {
    const t = typeof nameOrTable === "string" ? TABLES[nameOrTable] : nameOrTable;
    if (!t) throw new Error(`tabla desconocida: ${nameOrTable}`);
    return t;
  }

  /**
   * Añade VARIOS registros (append-only) en una sola escritura: un lock, una comprobación de
   * cabecera y un solo `ss.append`. Devuelve los ids generados, en orden.
   *
   * Existe porque `appendRecord` por fila no escala en Apps Script: aplicar un mes del generador
   * son ~60-90 cambios, y cada uno tomaba el lock y RELEÍA la tabla entera solo para ver si
   * faltaba la cabecera — con `asignaciones` creciendo ~700 filas/año y sin borrados, eso es
   * coste (filas × cambios) contra el límite de ejecución. Y en lote la escritura es atómica
   * frente a otros escritores, así que ya no puede quedar un mes medio aplicado cuyo estado
   * VALIDADO nadie revierte.
   */
  function appendRecords(nameOrTable, records) {
    const t = table(nameOrTable);
    if (!records.length) return [];
    return withLock(() => {
      if (ss.read(t.name).length === 0) ss.append(t.name, [headerOf(t)]); // cabecera si falta
      const conId = records.map((r) => ({ ...r, id: r.id || newId() }));
      ss.append(t.name, conId.map((r) => recordToRow(t, r)));
      return conId.map((r) => r.id);
    });
  }

  /** Añade un registro (append-only). Genera `id` si no lo trae. Devuelve el id. */
  function appendRecord(nameOrTable, record) {
    return appendRecords(nameOrTable, [record])[0];
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

  return { appendRecord, appendRecords, readRecords, readLatest, rebuildSheet };
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
const CUAD_KEY = (r) => `${r.mes}|${r.anio}`;
// Los periodos se corrigen REINSERTANDO las 4 filas (append-only), así que el estado actual es la
// última fila por residente+año — nunca se reescribe ni se borra ninguna.
const PERIODO_KEY = (r) => `${r.residenteId}|${r.anio}`;
const EVENTO_TIPOS = new Set(["NAVIDAD", "DESPEDIDA"]); // los dos eventos del servicio (INV-10)
// Tipos de Excepcion que el dominio realmente consume (V-29). Lista blanca deliberada: crear una
// excepción de un tipo que `validateMonth` no lee sería una fila muerta que nadie avisa que no
// sirve para nada.
const EXCEPCION_TIPOS = new Set(["2xR2"]);
const BLOQ_MOTIVOS = new Set(["VACACIONES", "ROTACION", "BAJA"]); // enum de motivos válidos (severidad mixta desde V-8: solo BAJA bloquea la asignación)
// Códigos de asignación (spec.md §2 + `CODES_CYCLE` del cliente). El "" es el BORRADO explícito:
// `readLatest("asignaciones", …, { emptyField: "codigo" })` lo usa para quitar una asignación sin
// borrar la fila, así que la lista blanca tiene que admitirlo. Existe porque sin ella entraba
// cualquier cadena y las erratas son MUDAS: una "g" minúscula no la reconoce ni `GUARDIA` (INV-1
// da el día por descubierto) ni `tally` (no cuenta para nada), y nadie avisa.
const ASIG_CODIGOS = new Set(["G", "GF", "GP", "3P", "V", "R", "B", ""]);
// `origen` marca la guardia cedida o comprada, que INV-4 excluye de los seis ejes de INV-3.
// `tally.js:15` lo evalúa por TRUTHINESS, así que una errata cualquiera —no solo un valor de otro
// enum— saca la guardia del cómputo y de los totales de la pestaña publicada, en silencio.
const ASIG_ORIGENES = new Set(["CEDIDA", "COMPRADA"]);

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
          // Mismo tratamiento que en `marcarValidado` (V-22): aquí los bloqueos los manda el
          // cliente, que los saca de `listBloqueos` — y esa acción devuelve también las filas con
          // fecha ilegible, para que se puedan cancelar. Esta acción no llama a los cierres de
          // equidad, así que no hay riesgo de excepción; lo que se evita es que INV-5 dé un
          // veredicto a suerte sobre una fecha que no se puede leer, y lo que se gana es que
          // `Calendar.jsx` —que valida por aquí— diga qué fila hay que arreglar en vez de callarse.
          const cuadrante = req.cuadrante || {};
          const { usables, corruptas } = partitionBloqueos(deps, cuadrante.bloqueos || []);
          const violaciones = [
            ...bloqueoCorruptoViolations(corruptas),
            ...deps.domain.validateMonth({ ...cuadrante, bloqueos: usables }),
          ];
          return { ok: true, violaciones, bloqueantes: violaciones.filter((v) => v.severidad === "error").length };
        });

      case "listResidentes":
        return authed(req, deps, () => ({ ok: true, residentes: allResidentes(deps) }));

      // Corregir las fechas de un residente. Hasta ahora `fechaInicio`/`fechaFin` solo se escribían
      // en el alta (`handleAlta`) y no había forma de tocarlas después, lo que dejaba sin salida
      // dentro de la app el caso que V-21 tuvo que degradar a `aviso`: una `fechaFin` mal teclada
      // hacía que INV-1 avisara de una asignación «a quien no es residente asignable» sin que nadie
      // pudiera arreglar la causa. Append-only: se reinserta la fila con el MISMO id (readLatest
      // resuelve), nunca se reescribe.
      case "editarResidente":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "corregir las fechas de un residente");
          if (denegado) return denegado;
          const actual = allResidentes(deps).find((r) => r.id === req.residenteId);
          if (!actual) return { ok: false, error: "el residente no existe" };

          const fechaInicio = req.fechaInicio || actual.fechaInicio;
          const fechaFin = req.fechaFin || actual.fechaFin;
          const malRango = validRango({ desde: fechaInicio, hasta: fechaFin }, deps);
          if (malRango.ok === false) return malRango;

          // El email y el nombre NO se tocan aquí: el email es la llave del login y cambiarlo por
          // este camino dejaría a alguien fuera de la app sin que se note hasta que intente entrar.
          deps.store.appendRecord("residentes", { ...actual, fechaInicio, fechaFin });
          return { ok: true, residenteId: req.residenteId, fechaInicio, fechaFin };
        });

      // Periodos formativos editados (nota [a] de la normativa: «los periodos generados son
      // editables después»). Es el dato que permite expresar que una baja larga RETRASA la
      // promoción — y por eso lo escribe quien reparte y no el propio residente: el retraso lo
      // decide tutoría, no se deriva de la tabla `bloqueos` (una baja de dos semanas no retrasa
      // nada, y adivinarlo cambiaría el nivel de alguien sin que nadie lo haya decidido).
      case "guardarPeriodos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "editar los periodos formativos de un residente");
          if (denegado) return denegado;
          if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
            return { ok: false, error: "el residente no existe" };
          }
          if (!Array.isArray(req.periodos)) return { ok: false, error: "periodos debe ser una lista de 4" };

          // Forma de la tabla → forma del dominio, para poder validar con el dominio. La traducción
          // inversa la hace `allResidentes`; que las dos vivan en este fichero es a propósito.
          const enDominio = req.periodos.map((p) => ({ year: Number(p.anio), start: p.fechaInicio, end: p.fechaFin }));
          for (const p of enDominio) {
            const malRango = validRango({ desde: p.start, hasta: p.end }, deps);
            if (malRango.ok === false) return { ok: false, error: `periodo R${p.year}: ${malRango.error}` };
          }
          // `validateTrainingPeriods` existe justo para esto y no la llamaba NADIE (exactamente 4,
          // años 1..4 en orden, sin solapes; los huecos SÍ se permiten, que es S-3: una baja
          // retrasa la promoción, no des-promociona).
          const errores = deps.domain.validateTrainingPeriods(enDominio);
          if (errores.length) return { ok: false, error: errores.join("; ") };

          // Las 4 filas de golpe (`appendRecords`, un solo lock) y con el id derivado de
          // residente+año: reinsertar el mismo par SUSTITUYE por `readLatest`, sin borrar nada.
          deps.store.appendRecords("periodos", enDominio.map((p) => ({
            id: `${req.residenteId}|${p.year}`, residenteId: req.residenteId,
            anio: p.year, fechaInicio: p.start, fechaFin: p.end,
          })));
          return { ok: true, residenteId: req.residenteId, periodos: enDominio };
        });

      // Volver a los periodos derivados de las fechas: reinserta las 4 filas con el rango que
      // `defaultTrainingPeriods` calcularía. Sin esto, unos periodos mal editados serían
      // irreversibles (la tabla es append-only y `allResidentes` exige las 4), y eso es un bloqueo
      // sin salida dentro de la herramienta — lo mismo que V-16 tuvo que arreglar de urgencia.
      case "restaurarPeriodos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "restaurar los periodos formativos de un residente");
          if (denegado) return denegado;
          const actual = allResidentes(deps).find((r) => r.id === req.residenteId);
          if (!actual) return { ok: false, error: "el residente no existe" };
          const derivados = deps.domain.periodsOfResident({ fechaInicio: actual.fechaInicio, fechaFin: actual.fechaFin });
          deps.store.appendRecords("periodos", derivados.map((p) => ({
            id: `${req.residenteId}|${p.year}`, residenteId: req.residenteId,
            anio: p.year, fechaInicio: p.start, fechaFin: p.end,
          })));
          return { ok: true, residenteId: req.residenteId, periodos: derivados };
        });

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
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;
          const all = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          return { ok: true, asignaciones: all.filter((a) => a.fecha >= req.desde && a.fecha <= req.hasta) };
        });

      // Consciente del ciclo de estados (Fase 6.2): PUBLICADO bloquea cualquier edición del mes
      // (decisión V-9b); editar un mes VALIDADO lo invalida y lo revierte a BORRADOR (decisión
      // de Fase 6.2 — "vuelve a BORRADOR automáticamente", sin fricción para quien edita).
      case "guardarAsignaciones":
        return authed(req, deps, (session) => {
          if (!Array.isArray(req.cambios) || req.cambios.length === 0) return { ok: false, error: "cambios vacío" };
          let fechas;
          try {
            fechas = req.cambios.map((c) => deps.domain.parseISO(c.fecha));
          } catch (e) {
            return { ok: false, error: "cambio con fecha inválida: " + e.message };
          }
          // Listas blancas de `codigo` y `origen`: la tabla es append-only y el Sheet se edita a
          // mano, así que lo que entre mal se queda para siempre y encima no se nota (ver el
          // comentario de ASIG_CODIGOS/ASIG_ORIGENES).
          const malCodigo = req.cambios.find((c) => !ASIG_CODIGOS.has(c.codigo || ""));
          if (malCodigo) return { ok: false, error: `código de asignación inválido: ${JSON.stringify(malCodigo.codigo)} (válidos: ${[...ASIG_CODIGOS].filter(Boolean).join(", ")})` };
          const malOrigen = req.cambios.find((c) => c.origen !== undefined && c.origen !== "" && !ASIG_ORIGENES.has(c.origen));
          if (malOrigen) return { ok: false, error: `origen inválido: ${JSON.stringify(malOrigen.origen)} (válidos: ${[...ASIG_ORIGENES].join(", ")})` };
          const meses = [...new Map(fechas.map((f) => [`${f.year}-${f.month}`, f])).values()]
            .map((f) => ({ mes: f.month, anio: f.year, estado: currentCuadranteEstado(deps, f.month, f.year) }));
          const publicado = meses.find((m) => !deps.domain.canEdit(m.estado));
          if (publicado) return { ok: false, error: `el cuadrante de ${publicado.mes}/${publicado.anio} está PUBLICADO y no admite ediciones` };

          // Una sola escritura para todo el lote (appendRecords): un mes del generador son
          // ~60-90 cambios y fila a fila era un lock y una relectura íntegra de la tabla por cada
          // uno. Además así el lote es atómico y no puede quedar medio aplicado.
          deps.store.appendRecords("asignaciones", req.cambios.map((c) => (
            { fecha: c.fecha, residenteId: c.residenteId, codigo: c.codigo || "", puesto: c.puesto, origen: c.origen }
          )));
          for (const m of meses) {
            const siguiente = deps.domain.stateAfterEdit(m.estado);
            if (siguiente !== m.estado) writeCuadranteEstado(deps, session, m.mes, m.anio, siguiente);
          }
          return { ok: true, guardados: req.cambios.length };
        });

      case "misPreferencias":
        return authed(req, deps, (session) => {
          const all = deps.store.readLatest("preferencias", PREF_KEY);
          const mine = all.find((p) => p.residenteId === session.sub && p.anio === req.anio && p.mes === req.mes);
          return { ok: true, prefs: mine || null };
        });

      // Lista blanca de columnas, no spread del cliente: con `...req.prefs` al final, un residente
      // podía escribir preferencias EN NOMBRE de otro (su `residenteId` pisaba el de la sesión) y
      // colar un `id` propio, que el store honra. Invertir el orden del spread no bastaría: el `id`
      // seguiría pasando, y de hecho la pantalla ya reenvía el suyo y duplica ids en producción.
      case "guardarPreferencias":
        return authed(req, deps, (session) => {
          if (!req.prefs || typeof req.prefs !== "object") return { ok: false, error: "prefs inválido" };
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          const { maxGuardias, preferDobles, fechasEvitar, notas } = req.prefs;
          deps.store.appendRecord("preferencias", {
            residenteId: session.sub, anio: req.anio, mes: req.mes,
            maxGuardias, preferDobles, fechasEvitar, notas,
          });
          return { ok: true };
        });

      // `residenteId` es OPCIONAL y solo lo admite quien tiene el permiso del ciclo (V-16): sin
      // él, la ausencia es siempre la de quien la pide (session.sub, como hasta ahora).
      //
      // La ausencia ajena existe porque la tabla `bloqueos` es la que mandan los invariantes y
      // hasta ahora nadie podía escribir en ella por otro: ante una baja que el residente no ha
      // declarado —y que precisamente por estar de baja puede no poder declarar—, el único gesto
      // posible era pintar una «B» en la rejilla, que es un código de asignación y no lo lee
      // NINGÚN invariante. Es decir: INV-5 seguía dejando asignarle guardias.
      case "crearBloqueo":
        return authed(req, deps, (session) => {
          if (!BLOQ_MOTIVOS.has(req.motivo)) return { ok: false, error: "motivo inválido" };
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;

          let residenteId = session.sub;
          if (req.residenteId && req.residenteId !== session.sub) {
            const denegado = requireCicloPermiso(deps, session, "registrar la ausencia de otro residente");
            if (denegado) return denegado;
            if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
              return { ok: false, error: "el residente no existe" };
            }
            residenteId = req.residenteId;
          }

          // P-13 (spec.md §8/§8.1, decisión 2026-08-07): simulación preventiva de cobertura.
          // Solo VACACIONES/ROTACION pasan por aquí — BAJA es impredecible, no se "previene".
          let riesgos = [];
          if (req.motivo === "VACACIONES" || req.motivo === "ROTACION") {
            const preview = deps.domain.previewBloqueoRisk(
              { residenteId, desde: rango.desde, hasta: rango.hasta, motivo: req.motivo },
              { residentes: allResidentes(deps), bloqueosActivos: allBloqueos(deps), today: deps.today },
            );
            if (preview.bloquea) {
              return {
                ok: false,
                error: "el bloqueo dejaría algún día sin nadie disponible de ese grupo dentro de los próximos 3 meses",
                riesgos: preview.riesgos,
              };
            }
            riesgos = preview.riesgos;
          }

          const id = deps.store.appendRecord("bloqueos", {
            residenteId, desde: rango.desde, hasta: rango.hasta, motivo: req.motivo,
            provincia: req.provincia, guardiasEnCentroExterno: req.guardiasEnCentroExterno, activo: true,
          });
          return { ok: true, id, residenteId, riesgos };
        });

      case "misBloqueos":
        return authed(req, deps, (session) =>
          ({ ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes).filter((b) => b.residenteId === session.sub) }));

      // A diferencia de misBloqueos (alcance propio, para Preferencias), esta acción
      // devuelve los bloqueos de TODO el equipo: el validador de CalendarScreen (INV-5/6/7)
      // necesita conocer los bloqueos de todos los residentes, no solo de quien valida.
      case "listBloqueos":
        return authed(req, deps, () => ({ ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes) }));

      // Mismo papel que listAsignacionesRango, para bloqueos: los cierres de equidad de
      // INV-3 descuentan las BAJAS de TODO el trimestre (o del año de residencia), no solo
      // las que solapan el mes que se está validando.
      case "listBloqueosRango":
        return authed(req, deps, () => {
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;
          return { ok: true, bloqueos: bloqueosInRange(deps, allBloqueos(deps), rango.desde, rango.hasta) };
        });

      // FESTIVOS (S-4: datos de entrada, nunca derivados). Lectura por RANGO y abierta a cualquier
      // sesión: la necesitan el validador (INV-12), los puentes y el prompt del generador. El
      // rango se pide con margen porque los vecinos del día 1 y del último día del mes deciden si
      // son puente.
      case "listFestivosRango":
        return authed(req, deps, () => {
          const rango = validRango(req, deps);
          if (rango.error) return rango;
          return { ok: true, festivos: festivosInRange(deps, rango.desde, rango.hasta) };
        });

      // Carga en LOTE (una escritura, un lock): un año de festivos se pega de golpe. Mismo permiso
      // que el ciclo del cuadrante (V-16), porque es dato compartido de todo el servicio.
      case "crearFestivos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "cargar festivos");
          if (denegado) return denegado;
          if (!Array.isArray(req.festivos) || req.festivos.length === 0) return { ok: false, error: "festivos vacío" };
          let filas;
          try {
            filas = req.festivos.map((f) => {
              deps.domain.parseISO(f.fecha);
              return { fecha: f.fecha, nombre: f.nombre || "", ambito: f.ambito || "", activo: true };
            });
          } catch (e) {
            return { ok: false, error: "festivo con fecha inválida: " + e.message };
          }
          const ids = deps.store.appendRecords("festivos", filas);
          return { ok: true, ids, cargados: ids.length };
        });

      // Anular una fecha mal cargada: reinserción con activo=false, jamás borrado (append-only).
      case "anularFestivo":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular un festivo");
          if (denegado) return denegado;
          const actual = allFestivos(deps).find((f) => f.id === req.id);
          if (!actual) return { ok: false, error: "festivo no encontrado" };
          deps.store.appendRecord("festivos", { ...actual, activo: false });
          return { ok: true };
        });

      // Simétrica de `crearBloqueo`: quien puede registrar la ausencia de otro tiene que poder
      // corregirla. Sin esto, una baja registrada por error en el residente equivocado sería
      // irreversible —la tabla es append-only y el afectado no la creó, así que tampoco podía
      // cancelarla él—, y quedaría bloqueándole las asignaciones para siempre (INV-5).
      case "cancelarBloqueo":
        return authed(req, deps, (session) => {
          const actuales = deps.store.readLatest("bloqueos", (r) => r.id);
          const bloqueo = actuales.find((b) => b.id === req.id);
          if (!bloqueo) return { ok: false, error: "bloqueo no encontrado" };
          if (bloqueo.residenteId !== session.sub) {
            const denegado = requireCicloPermiso(deps, session, "cancelar la ausencia de otro residente");
            if (denegado) return denegado;
          }
          deps.store.appendRecord("bloqueos", { ...bloqueo, activo: false });
          return { ok: true };
        });

      // Devuelve el periodo pedido Y el SIGUIENTE en la misma respuesta: el mandato se decide
      // antes de que empiece, así que quien puede ofrecerse necesita ver el año que viene sin
      // tener que adivinar que existe un selector de año (decisión V-16).
      case "estadoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const residentes = allResidentes(deps);
          return {
            ok: true,
            ...periodoResponsable(deps, req.anio, session, residentes),
            siguiente: periodoResponsable(deps, req.anio + 1, session, residentes),
          };
        });

      case "ofrecerseResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = allResidentes(deps);
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

      // El sorteo escribe una fila de mandato append-only e IRREVERSIBLE para todo un año: no
      // puede quedar al alcance de cualquier sesión (un R1 podía quemar el mandato antes de que
      // nadie se ofreciera). Mismo permiso que las transiciones del cuadrante (V-16): el
      // Responsable en mandato o, si no hay ninguno —que es justo cuando hay que sortear—,
      // cualquier Mayor.
      case "ejecutarSorteoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const denegado = requireCicloPermiso(deps, session, "lanzar el sorteo del Responsable");
          if (denegado) return denegado;
          const { periodoInicio, periodoFin } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = allResidentes(deps);
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

      // TERCER PUESTO (INV-8, decisión V-18). Autoservicio puro, como el voluntariado del
      // Responsable: el 3P «será siempre voluntario» (normativa p.2), así que nadie apunta a
      // nadie — ni siquiera el Responsable. Abierta a cualquier sesión: el validador necesita la
      // lista para INV-8a y la pantalla para saber si ya estás dentro.
      case "estadoVoluntariado3P":
        return authed(req, deps, (session) => {
          const voluntarios = activeThirdPostVolunteers(deps);
          const mio = voluntarios.find((v) => v.residenteId === session.sub) || null;
          return {
            ok: true,
            voluntarios,
            permanenciaMeses: deps.domain.THIRD_POST_PERMANENCIA_MESES,
            mio: mio && {
              desde: mio.desde,
              compromisoHasta: deps.domain.thirdPostCommitmentEnd(mio.desde),
              puedoRetirarme: deps.domain.canWithdrawThirdPost(mio.desde, deps.today),
            },
          };
        });

      case "ofrecerse3P":
        return authed(req, deps, (session) => {
          // El compromiso de permanencia se acepta explícitamente y queda registrado: es la
          // condición que después impide retirarse, y una regla que restringe sin que conste
          // aceptada no se le puede oponer a nadie dentro de diez años.
          if (req.compromisoAceptado !== true) return { ok: false, error: "hay que aceptar el compromiso de permanencia para apuntarse al tercer puesto" };
          if (activeThirdPostVolunteers(deps).some((v) => v.residenteId === session.sub)) {
            return { ok: false, error: "ya estás apuntado al tercer puesto" };
          }
          deps.store.appendRecord("voluntarios3P", { residenteId: session.sub, desde: deps.today, compromisoAceptado: true, activo: true });
          return { ok: true, desde: deps.today, compromisoHasta: deps.domain.thirdPostCommitmentEnd(deps.today) };
        });

      case "retirarVoluntariado3P":
        return authed(req, deps, (session) => {
          const mio = activeThirdPostVolunteers(deps).find((v) => v.residenteId === session.sub);
          if (!mio) return { ok: false, error: "no estás apuntado al tercer puesto" };
          if (!deps.domain.canWithdrawThirdPost(mio.desde, deps.today)) {
            return { ok: false, error: `el compromiso de permanencia dura hasta el ${deps.domain.thirdPostCommitmentEnd(mio.desde)}: hasta entonces no puedes retirarte del tercer puesto` };
          }
          // Append-only: se reinserta con activo=false, la fila del alta se queda (y con ella el
          // `desde`, que es lo que documenta que el compromiso se cumplió). `hasta` deja escrito
          // CUÁNDO se retiró: sin él la fila de baja repite el `desde` y esa fecha se pierde.
          deps.store.appendRecord("voluntarios3P", { residenteId: session.sub, desde: mio.desde, hasta: deps.today, compromisoAceptado: true, activo: false });
          return { ok: true };
        });

      // EVENTOS DEL SERVICIO (INV-10, decisión V-20). Dato de entrada como los festivos: la
      // fecha la pone el servicio cada año. Leerlos está abierto (los necesita el validador);
      // crearlos y anularlos usa el permiso del ciclo (V-16), porque es dato de todo el equipo.
      case "listEventos":
        return authed(req, deps, () => ({ ok: true, eventos: activeEventos(deps) }));

      case "crearEvento":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "registrar un evento del servicio");
          if (denegado) return denegado;
          if (!EVENTO_TIPOS.has(req.tipo)) return { ok: false, error: "tipo de evento inválido (NAVIDAD o DESPEDIDA)" };
          try { deps.domain.parseISO(req.fecha); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          const voluntarios = Array.isArray(req.voluntarios) ? req.voluntarios : [];
          const id = deps.store.appendRecord("eventos", { tipo: req.tipo, fecha: req.fecha, voluntarios, designados: [], activo: true });
          return { ok: true, id };
        });

      case "anularEvento":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular un evento del servicio");
          if (denegado) return denegado;
          const actual = deps.store.readLatest("eventos", (r) => r.id).find((e) => e.id === req.id);
          if (!actual) return { ok: false, error: "evento no encontrado" };
          deps.store.appendRecord("eventos", { ...actual, activo: false });
          return { ok: true };
        });

      // EXCEPCIONES (INV-9, decisión V-29): degradan un 2×R2 dentro de un rango de fechas, con
      // justificación documentada. Mismo tratamiento que festivos/eventos: dato compartido del
      // servicio, lectura abierta (la necesita el validador), escritura con el permiso del ciclo.
      case "listExcepciones":
        return authed(req, deps, () => ({ ok: true, excepciones: activeExcepciones(deps) }));

      case "crearExcepcion":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "registrar una excepción");
          if (denegado) return denegado;
          if (!EXCEPCION_TIPOS.has(req.tipo)) return { ok: false, error: "tipo de excepción inválido (2xR2)" };
          if (!req.justificacion || !String(req.justificacion).trim()) return { ok: false, error: "la excepción necesita una justificación" };
          try { deps.domain.parseISO(req.desde); deps.domain.parseISO(req.hasta); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          if (req.desde > req.hasta) return { ok: false, error: "«desde» no puede ser posterior a «hasta»" };
          const id = deps.store.appendRecord("excepciones", {
            tipo: req.tipo, desde: req.desde, hasta: req.hasta, justificacion: String(req.justificacion).trim(),
            registradaPor: session.sub, fecha: deps.today, activo: true,
          });
          return { ok: true, id };
        });

      case "anularExcepcion":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular una excepción");
          if (denegado) return denegado;
          const actual = activeExcepciones(deps).find((e) => e.id === req.id);
          if (!actual) return { ok: false, error: "excepción no encontrada" };
          deps.store.appendRecord("excepciones", { ...actual, activo: false });
          return { ok: true };
        });

      // El «a sorteo» de la normativa, hecho de verdad y reproducible: misma mecánica que el
      // sorteo del Responsable (INV-14, decisión V-7a) — semilla generada por la app, sorteo
      // puro sobre (candidatos, semilla), y la fila queda en `sorteos` para recomputarlo. Un
      // booleano «hubo sorteo» no prueba nada; esto sí.
      case "sortearEvento":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "sortear un evento del servicio");
          if (denegado) return denegado;
          const evento = activeEventos(deps).find((e) => e.id === req.id);
          if (!evento) return { ok: false, error: "evento no encontrado" };
          if (evento.sorteoId) return { ok: false, error: "ese evento ya está sorteado" };

          const residentes = allResidentes(deps);
          const r2 = residentes
            .filter((r) => deps.domain.levelOn(deps.domain.periodsOfResident(r), evento.fecha) === "R2")
            .map((r) => r.id);
          // Si se ofrecen 2 o más voluntarios se sortea SOLO entre ellos, mismo criterio que
          // V-7(b) para el Responsable: la normativa cubre el sorteo, no el «gana el primero».
          const ofrecidos = (evento.voluntarios || []).filter((id) => r2.includes(id));
          const candidatos = ofrecidos.length >= 2 ? ofrecidos : r2;
          if (candidatos.length < 2) return { ok: false, error: `hacen falta al menos 2 R2 para sortear el evento (hay ${candidatos.length})` };

          const semilla = deps.newSeed();
          const primero = deps.domain.drawResponsible(candidatos, semilla);
          const segundo = deps.domain.drawResponsible(candidatos.filter((id) => id !== primero), semilla);
          const designados = [primero, segundo];

          const sorteoId = deps.store.appendRecord("sorteos", {
            fecha: deps.today, motivo: `EVENTO_${evento.tipo}_${evento.fecha}`, semilla, candidatos, resultado: designados,
          });
          deps.store.appendRecord("eventos", { ...evento, designados, sorteoId });
          return { ok: true, designados, sorteoId, semilla };
        });

      // IMAGINARIA (INV-13, decisión V-20). Es una HERRAMIENTA, no un validador: dice a quién
      // llamar. La cola se DERIVA del historial de coberturas, nunca se almacena.
      case "colaImaginaria":
        return authed(req, deps, () => {
          if (req.grupo !== "MAYOR" && req.grupo !== "PEQUENO") return { ok: false, error: "grupo inválido (MAYOR o PEQUENO)" };
          try { deps.domain.parseISO(req.fecha); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          // Las asignaciones de la víspera y del día siguiente deciden a quién se aparta, así
          // que el rango es fecha±1, no el mes: la incidencia puede caer en un día 1 o en un 31.
          const todas = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          const desde = deps.domain.addDays(req.fecha, -1);
          const hasta = deps.domain.addDays(req.fecha, 1);
          return {
            ok: true,
            cola: deps.domain.imaginariaQueue({
              residentes: allResidentes(deps),
              coberturas: activeImaginaria(deps),
              asignaciones: todas.filter((a) => a.fecha >= desde && a.fecha <= hasta),
              grupo: req.grupo, fechaIncidencia: req.fecha,
            }),
          };
        });

      case "registrarImaginaria":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "registrar una cobertura de imaginaria");
          if (denegado) return denegado;
          if (req.grupo !== "MAYOR" && req.grupo !== "PEQUENO") return { ok: false, error: "grupo inválido (MAYOR o PEQUENO)" };
          try { deps.domain.parseISO(req.fechaIncidencia); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
            return { ok: false, error: "el residente no existe" };
          }
          // NO se exige que sea el primero de la cola: la incidencia se resuelve por teléfono y
          // puede haber mil motivos legítimos para saltarse el orden (nadie cogía, se cambió).
          // Lo que importa es que la cobertura quede registrada, que es lo que mueve la cola.
          const id = deps.store.appendRecord("imaginaria", {
            grupo: req.grupo, fechaIncidencia: req.fechaIncidencia, residenteId: req.residenteId,
            registradaEn: deps.today, activo: true,
          });
          return { ok: true, id };
        });

      case "anularImaginaria":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular una cobertura de imaginaria");
          if (denegado) return denegado;
          const actual = deps.store.readLatest("imaginaria", (r) => r.id).find((c) => c.id === req.id);
          if (!actual) return { ok: false, error: "cobertura no encontrada" };
          deps.store.appendRecord("imaginaria", { ...actual, activo: false });
          return { ok: true };
        });

      case "listResponsables":
        return authed(req, deps, () => ({
          ok: true,
          mandatos: deps.store.readLatest("responsables", (r) => r.periodoInicio).sort((a, b) => (a.periodoInicio < b.periodoInicio ? -1 : 1)),
        }));

      case "estadoCuadrante":
        return authed(req, deps, () => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          // `sinResponsable` viaja aquí y no en una acción aparte porque el cliente ya llama a
          // estadoCuadrante al abrir el mes: es lo que le permite avisar de que nadie tiene el
          // mandato y habilitar el ciclo a un Mayor (decisión V-16) sin una petición de más.
          return { ok: true, estado: currentCuadranteEstado(deps, req.mes, req.anio), sinResponsable: mandatoVigente(deps) === null };
        });

      // BORRADOR->VALIDADO (Fase 6.2, decisión V-9/V-10): solo el Responsable en mandato, y
      // revalidado AQUÍ con los datos del store (nunca se confía en un `violaciones` que
      // mandara el cliente) — mismo principio que el rol derivado ("nunca un flag que el
      // cliente pueda falsear").
      case "marcarValidado":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "validar el cuadrante");
          if (denegado) return denegado;
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (estadoActual === "PUBLICADO") return { ok: false, error: "el cuadrante ya está publicado" };

          // Una sola lectura del store para las tres comprobaciones (mes, cierres de equidad,
          // tercer puesto).
          const snap = monthSnapshot(deps);
          const violaciones = [
            ...bloqueoCorruptoViolations(snap.bloqueosCorruptos),
            ...deps.domain.validateMonth(buildCuadranteCtx(deps, req.mes, req.anio, snap)),
            ...closeViolations(deps, req.mes, req.anio, snap),
            ...deps.domain.validateThirdPost(buildThirdPostCtx(deps, req.mes, req.anio, snap)),
          ];
          if (!deps.domain.canValidate(violaciones)) {
            return { ok: false, error: "el cuadrante tiene errores, no se puede validar", violaciones };
          }
          writeCuadranteEstado(deps, session, req.mes, req.anio, "VALIDADO");
          return { ok: true, estado: "VALIDADO", violaciones };
        });

      // Fase 7.1 (decisión V-11a): publicar proyecta de verdad al Sheet legible en el MISMO paso
      // — "publicar" pasa a significar publicar de verdad. Desde la Fase 7.2 son TRES hojas
      // (mensual + Resumen del curso + Contaje Trimestral del curso), así que la ventana en la que
      // el Sheet puede quedar a medias es de tres `rebuildSheet` y no de dos. Sigue sin ser una
      // transacción a propósito: cada uno es idempotente (shadow-swap) y volver a pulsar Publicar
      // lo sana, que es lo único que puede hacer alguien sin administrador. La proyección ocurre
      // ANTES de escribir el estado: ver projectCuadranteToSheets.
      case "publicarCuadrante":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "publicar el cuadrante");
          if (denegado) return denegado;
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (!deps.domain.canPublish(estadoActual)) return { ok: false, error: "el cuadrante debe estar VALIDADO antes de publicarse" };
          const proyeccion = projectCuadranteToSheets(deps, req.mes, req.anio);
          writeCuadranteEstado(deps, session, req.mes, req.anio, "PUBLICADO");
          return { ok: true, estado: "PUBLICADO", proyeccion };
        });

      case "despublicarCuadrante":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "despublicar el cuadrante");
          if (denegado) return denegado;
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (!deps.domain.canUnpublish(estadoActual)) return { ok: false, error: "el cuadrante no está publicado" };
          writeCuadranteEstado(deps, session, req.mes, req.anio, "VALIDADO");
          return { ok: true, estado: "VALIDADO" };
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

const PENDING_TTL = 300; // 5 min: solo para completar el alta tras un login fallido por email desconocido.

function handleLogin(req, deps) {
  const v = verifyIdentity(req, deps);
  if (!v.ok) return { ok: false, error: v.reason };

  const residente = allResidentes(deps).find((r) => (r.email || "").toLowerCase() === v.email);
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

  const yaExiste = allResidentes(deps).some((r) => (r.email || "").toLowerCase() === email);
  if (yaExiste) return { ok: false, error: "ese email ya está vinculado a un residente" };

  const id = deps.store.appendRecord("residentes", { nombre: req.nombre, email, fechaInicio: req.fechaInicio, fechaFin: req.fechaFin });
  return sessionFor({ id, nombre: req.nombre }, deps);
}

/** Prefijo "YYYY-MM" de una fecha ISO, para filtrar asignaciones de un mes concreto. */
function monthPrefix(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/**
 * Rango [desde,hasta] validado como ISO de verdad, no por orden lexicográfico. Devuelve
 * `{desde,hasta}` si está bien, o el propio `{ok:false,error}` que debe devolver la acción.
 *
 * Es el ÚNICO sitio donde se valida un rango de fechas de entrada: lo comparten `crearBloqueo`,
 * `listBloqueosRango`, `listAsignacionesRango` y `listFestivosRango`/`listEventosRango`. Las tres
 * primeras tenían su propio `!desde || !hasta || desde > hasta` en línea, que es una comparación
 * LEXICOGRÁFICA de lo que mandara el cliente y colaba cualquier cosa cuyo primer carácter ordenase
 * por debajo: `"30/02/2027"`, `"2027-13-45"`, `"9999"` y hasta un objeto entraron en la sonda del
 * 2026-08-02. En una tabla append-only sobre un Sheet editable a mano eso no es un detalle: una
 * fila BAJA con `desde` no-ISO se descarta sola del rango de `absences` —que compara cadenas a
 * propósito, V-19— y **desactiva INV-5 en silencio**. Medido: con `desde` válida, validar el mes
 * emitía 31 violaciones de INV-5 sobre la baja; con `desde="30/02/2026"`, cero.
 */
function validRango(req, deps) {
  if (!req.desde || !req.hasta) return { ok: false, error: "rango de fechas inválido" };
  try {
    deps.domain.parseISO(req.desde);
    deps.domain.parseISO(req.hasta);
  } catch (e) {
    return { ok: false, error: "rango con fecha inválida: " + e.message };
  }
  if (req.desde > req.hasta) return { ok: false, error: "rango de fechas inválido" };
  return { desde: req.desde, hasta: req.hasta };
}

/** Estado actual de la tabla de festivos (última reinserción gana). */
function allFestivos(deps) {
  return deps.store.readLatest("festivos", (r) => r.id);
}

/** Festivos ACTIVOS dentro de [desde,hasta]. */
function festivosInRange(deps, desde, hasta) {
  return allFestivos(deps).filter((f) => f.activo === true && f.fecha >= desde && f.fecha <= hasta);
}

/** Eventos del servicio vigentes (última reinserción gana; el sorteo reinserta la fila). */
function activeEventos(deps) {
  return deps.store.readLatest("eventos", (r) => r.id).filter((e) => e.activo === true);
}

/** Excepciones vigentes (INV-9, V-29): última reinserción gana; anular reinserta con activo=false. */
function activeExcepciones(deps) {
  return deps.store.readLatest("excepciones", (r) => r.id).filter((e) => e.activo === true);
}

/** Coberturas de imaginaria vigentes: son las que mueven la cola derivada. */
function activeImaginaria(deps) {
  return deps.store.readLatest("imaginaria", (r) => r.id).filter((c) => c.activo === true);
}

/**
 * Los residentes, con sus periodos formativos EDITADOS ya montados en `residente.periodos`.
 *
 * Lector único a propósito, y es el punto entero de la fase 2 de V-24: `periodsOfResident` solo
 * respeta los periodos editados si el residente los TRAE, así que hidratar en unas acciones y no en
 * otras sería peor que no hidratar — daría un nivel distinto según por qué endpoint entres. Había
 * trece `readRecords("residentes")` sueltos en este fichero.
 *
 * La tabla guarda `{id, residenteId, anio, fechaInicio, fechaFin}` y el dominio consume
 * `{year, start, end}`: la traducción de forma vive aquí y solo aquí. Nadie la había escrito, y era
 * el fallo silencioso más probable de este punto — unos `periodos` con las claves equivocadas no
 * lanzan, simplemente hacen que `levelOn` lea `undefined` y devuelva basura.
 *
 * Un residente sin las 4 filas NO recibe la clave, así que `periodsOfResident` sigue derivando de
 * las fechas: es el caso normal y el que tiene todo el mundo hoy. Las incompletas se ignoran
 * ENTERAS en vez de montar unos periodos a medias que nadie podría diagnosticar; quien las escribe
 * (`guardarPeriodos`) ya no deja que eso ocurra, pero el Sheet se edita a mano.
 */
function allResidentes(deps) {
  const porResidente = new Map();
  for (const f of deps.store.readLatest("periodos", PERIODO_KEY)) {
    if (!porResidente.has(f.residenteId)) porResidente.set(f.residenteId, []);
    porResidente.get(f.residenteId).push({ year: Number(f.anio), start: f.fechaInicio, end: f.fechaFin });
  }
  // `readLatest` y no `readRecords`: `residentes` es append-only como todo lo demás, y hasta que
  // existió `editarResidente` nadie reinsertaba una fila, así que leer todas y coger la primera
  // daba igual. Con la corrección de fechas ya no: `readRecords` devolvería la fila VIEJA y la
  // edición no tendría ningún efecto visible. Lo destapó el test, no la lectura del código.
  return deps.store.readLatest("residentes", (r) => r.id).map((r) => {
    const suyos = (porResidente.get(r.id) || []).sort((a, b) => a.year - b.year);
    if (suyos.length !== 4) return r;
    return { ...r, periodos: suyos };
  });
}

/** Estado actual de la tabla de bloqueos (última reinserción gana, como cancelarBloqueo). */
function allBloqueos(deps) {
  return deps.store.readLatest("bloqueos", (r) => r.id);
}

/**
 * Parte las ausencias ACTIVAS en las que se pueden usar y las que tienen una fecha que no es ISO.
 *
 * `crearBloqueo` ya no deja entrar una fecha mala, pero el Sheet es datastore y entregable a la
 * vez —se edita a mano— y las tablas son append-only, así que una fila corrupta puede estar ya
 * escrita y no se va a borrar nunca. Sin partirla, el problema NO es que el validador reviente
 * (`validateMonth` solo compara cadenas y nunca lanza por esto): es que **el veredicto de INV-5
 * sale a suerte**, según por dónde ordene la basura. Medido el 2026-08-02 con una guardia
 * asignada encima de la baja:
 *  - `hasta="no-es-fecha"` o `hasta="30/02/2028"` → INV-5 emite, pero por casualidad: la cadena
 *    basura ordena por encima del día, así que el rango "contiene" la fecha de puro accidente;
 *  - `desde="30/02/2027"` → INV-5 emite CERO. `absences` descarta la fila del rango —compara
 *    cadenas a propósito, V-19— y la baja médica deja de proteger EN SILENCIO.
 * Y los cierres de equidad de INV-3, que sí hacen aritmética de fechas, hacían que
 * `marcarValidado` respondiera «Fecha ISO inválida: "…"» sin decir de qué tabla, de quién ni cuál.
 *
 * La política (decisión V-22): apartarla del contexto —para que ningún invariante la juzgue con
 * una fecha inventada— y emitir un `error` que la nombre. Es `error` y no `aviso` porque no es una regla nueva que
 * bloquea: es INV-5 diciendo que no puede comprobarse, ya bloqueaba antes con un mensaje ciego, y
 * SÍ tiene salida dentro de la herramienta —cancelar la fila y recrearla, y desde V-19 eso vale
 * también para la ausencia de otro—. Por eso las lecturas de UI la siguen mostrando (ver
 * `activeBloqueosInMonth`): apartarla también de ahí la volvería incancelable.
 */
function partitionBloqueos(deps, bloqueos) {
  const usables = [];
  const corruptas = [];
  for (const b of deps.domain.absences(bloqueos)) { // solo activas: una cancelada ya no molesta
    try {
      deps.domain.parseISO(b.desde);
      deps.domain.parseISO(b.hasta);
      usables.push(b);
    } catch (e) {
      corruptas.push({ bloqueo: b, motivo: e.message });
    }
  }
  return { usables, corruptas };
}

/** Un `error` por ausencia con fecha ilegible, nombrando la fila para que se pueda cancelar. */
function bloqueoCorruptoViolations(corruptas) {
  return corruptas.map(({ bloqueo, motivo }) => ({
    invariante: "INV-5",
    severidad: "error",
    residenteId: bloqueo.residenteId,
    detalle: `Ausencia ${bloqueo.motivo || "(sin motivo)"} con fecha ilegible (${bloqueo.desde} → ${bloqueo.hasta}): ${motivo}. `
      + `Mientras siga así no se puede comprobar si hay guardias asignadas sobre ella; cancélala (id ${bloqueo.id}) y vuelve a crearla.`,
  }));
}

/**
 * Bloqueos activos que solapan [desde,hasta]. El filtro no vive aquí: lo hace el lector único
 * del dominio (`absences`), que es también quien descarta las filas canceladas. Antes el
 * `activo === true` de esta función era la ÚNICA defensa contra que un bloqueo cancelado
 * volviera a bloquear asignaciones, y bastaba con que un invocador nuevo no pasara por aquí.
 */
function bloqueosInRange(deps, bloqueos, desde, hasta) {
  return deps.domain.absences(bloqueos, { desde, hasta });
}

/**
 * Bloqueos activos (de cualquier residente) que solapan el mes dado, MÁS las filas con fecha
 * ilegible. Las corruptas se añaden en todos los meses a propósito: con la fecha ilegible no se
 * puede saber en cuál caen, y esconderlas las volvería incancelables desde la UI, que es la única
 * salida que tiene quien se las encuentre (ver `partitionBloqueos`).
 */
function activeBloqueosInMonth(deps, anio, mes) {
  const prefix = monthPrefix(anio, mes);
  const { usables, corruptas } = partitionBloqueos(deps, allBloqueos(deps));
  // Tope superior lexicográfico holgado: "-31" existe en ISO aunque el mes tenga 28/30 días.
  return [...bloqueosInRange(deps, usables, `${prefix}-01`, `${prefix}-31`), ...corruptas.map((c) => c.bloqueo)];
}

/**
 * Las tres tablas que necesitan las comprobaciones de un mes, leídas UNA vez. Existe porque
 * validar un mes ahora comprueba el mes (INV-1..14) y además los cierres de equidad de INV-3
 * (trimestral y anual): sin esto, la misma acción releería residentes/asignaciones/bloqueos
 * dos veces, y en Apps Script cada lectura es una llamada real a Sheets.
 */
function monthSnapshot(deps) {
  // Las ausencias con fecha ilegible se apartan aquí y viajan en `bloqueosCorruptos`: si entraran
  // en el contexto, INV-5 las juzgaría por comparación de cadenas (veredicto a suerte) y los
  // cierres de equidad tumbarían la petición con un «Fecha ISO inválida» que no dice de qué fila
  // habla (decisión V-22, ver `partitionBloqueos`).
  const { usables, corruptas } = partitionBloqueos(deps, allBloqueos(deps));
  return {
    residentes: allResidentes(deps),
    asignaciones: deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" }),
    bloqueos: usables,
    bloqueosCorruptos: corruptas,
    festivos: allFestivos(deps).filter((f) => f.activo === true),
    eventos: activeEventos(deps),
    excepciones: activeExcepciones(deps),
  };
}

/**
 * Contexto de `validateThirdPost` (INV-8) para un mes, reconstruido desde el store igual que
 * `buildCuadranteCtx`. Hasta la decisión V-18 este invariante estaba implementado y probado
 * desde la Fase 3 pero **no lo invocaba nadie** —mismo caso que el cierre anual de INV-3 antes
 * de P-8—, y le faltaba además la tabla de voluntarios: con la lista vacía, INV-8a marcaba
 * TODO 3P como no-voluntario, que es la razón por la que no se podía cablear antes.
 *
 * El rango del historial lo decide el dominio (`thirdPostHistoryStart`) y no este fichero: el
 * ciclo L-D de INV-8b arranca el día en que cada residente se apuntó, que puede ser de hace
 * año y medio, y adivinarlo aquí es el error que ya costó la regresión del contrato C-2.
 */
function buildThirdPostCtx(deps, mes, anio, snap) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const voluntarios = activeThirdPostVolunteers(deps);
  const desde = deps.domain.thirdPostHistoryStart(voluntarios, snap.residentes, mes, anio);

  // historial3P: solo los 3P ANTERIORES al mes, por residente y en orden. Los del propio mes
  // van por `asignaciones`, y meterlos también aquí los contaría dos veces en el ciclo.
  const historial3P = {};
  if (desde) {
    for (const a of snap.asignaciones) {
      if (a.codigo !== "3P" || a.fecha < desde || a.fecha >= monthStart) continue;
      (historial3P[a.residenteId] = historial3P[a.residenteId] || []).push(a.fecha);
    }
    for (const id of Object.keys(historial3P)) historial3P[id].sort();
  }

  return {
    mes, anio, residentes: snap.residentes,
    asignaciones: snap.asignaciones.filter((a) => a.fecha.startsWith(prefix)),
    voluntarios3P: voluntarios, // con `desde`: el ciclo de 8b arranca en el alta de cada uno (V-18b)
    historial3P,
    // INV-8a juzga "¿era voluntario ESE día?" con la historia completa (V-28), no con la lista de
    // HOY que usan 8b/8c (`voluntarios`, sin tocar a propósito: el ciclo y el cierre de equidad sí
    // son sobre el compromiso vigente).
    periodosVoluntario3P: allThirdPostPeriods(deps),
  };
}

/**
 * Violaciones de los cierres de equidad de INV-3 que caen en el mes validado, cada uno con la
 * severidad que le da spec.md §5: el TRIMESTRAL (agosto/noviembre/febrero/mayo; solo el eje
 * `total`, severidad aviso — P-8, decisión V-13) y el ANUAL (solo si algún residente cierra su
 * año de residencia ese mes; los seis ejes, severidad aviso como todo lo de equidad desde
 * V-14). Devuelve [] cuando el mes no
 * cierra ninguno de los dos, que es lo normal en 8 de cada 12 meses.
 *
 * Los rangos que hay que leer los decide el dominio (`quarterCloseWindow`,
 * `yearCloseHistoryStart`), no este fichero: el cierre anual arranca en el aniversario del
 * residente, que puede caer 11 meses atrás, y adivinarlo aquí es el error que ya costó una
 * regresión con el contrato C-2.
 */
function closeViolations(deps, mes, anio, snap) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const monthEnd = `${prefix}-31`;
  const violaciones = [];

  const trimestre = deps.domain.quarterCloseWindow(mes, anio);
  if (trimestre) {
    violaciones.push(...deps.domain.validateQuarterClose({
      mes, anio, residentes: snap.residentes,
      asignaciones: snap.asignaciones.filter((a) => a.fecha >= trimestre.start && a.fecha <= trimestre.end),
      bloqueos: bloqueosInRange(deps, snap.bloqueos, trimestre.start, trimestre.end),
    }));
  }

  const desdeAnual = deps.domain.yearCloseHistoryStart(snap.residentes, mes, anio);
  if (desdeAnual) {
    // El eje `puentesLibres` mira el año de residencia entero (fase 3 de V-17), que cruza dos
    // años naturales: el rango de festivos lo da el dominio, no se recorta aquí.
    const rangoFestivos = deps.domain.yearCloseFestivosRange(snap.residentes, mes, anio);
    violaciones.push(...deps.domain.validateResidencyYearClose(deps.domain.buildYearCloseContext({
      mes, anio, residentes: snap.residentes,
      historicas: snap.asignaciones.filter((a) => a.fecha >= desdeAnual && a.fecha < monthStart),
      asignacionesDelMes: snap.asignaciones.filter((a) => a.fecha.startsWith(prefix)),
      bloqueos: bloqueosInRange(deps, snap.bloqueos, desdeAnual, monthEnd),
      festivos: (snap.festivos || []).filter((f) => f.fecha >= rangoFestivos.desde && f.fecha <= rangoFestivos.hasta),
    })));
  }

  return violaciones;
}

function isYear(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 2000 && v < 2100;
}

function isMonth(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12;
}

/** Estado vigente (última fila gana, `readLatest` por mes|anio); sin fila = BORRADOR implícito. */
function currentCuadranteEstado(deps, mes, anio) {
  const fila = deps.store.readLatest("cuadrantes", CUAD_KEY).find((r) => r.mes === mes && r.anio === anio);
  return fila ? fila.estado : "BORRADOR";
}

/** mes/anio de `req` válidos → estado vigente; inválidos → null (Fase 6.2, 3 acciones de estado). */
function validCuadranteMesAnio(req, deps) {
  if (!isYear(req.anio) || !isMonth(req.mes)) return null;
  return currentCuadranteEstado(deps, req.mes, req.anio);
}

/** Añade la fila de transición de estado del cuadrante (Fase 6.2) — misma forma en las 4 acciones que la escriben. */
function writeCuadranteEstado(deps, session, mes, anio, estado) {
  deps.store.appendRecord("cuadrantes", { mes, anio, estado, actorId: session.sub, fecha: deps.today });
}

/** El mandato de Responsable que cubre `today`, o null si no hay ninguno vigente (INV-14). */
function mandatoVigente(deps) {
  return deps.store.readLatest("responsables", (r) => r.periodoInicio)
    .find((m) => m.periodoInicio <= deps.today && deps.today < m.periodoFin) || null;
}

/**
 * Permiso para mover el ciclo del cuadrante (validar/publicar/despublicar).
 *
 * Regla base (decisión V-9c): lo hace el Responsable en mandato. Añadido de la decisión V-16:
 * si NO hay mandato vigente el ciclo no se queda bloqueado — cualquier residente Mayor (R3/R4
 * a día de hoy, derivado de fechas como todo lo demás) puede moverlo, y el cliente avisa de que
 * no hay Responsable designado. El motivo es el de siempre: la app tiene que funcionar sin
 * administrador, y en algún enero de los próximos diez años nadie lanzará el sorteo. Un cuadrante
 * que no se puede publicar porque falta una fila en una tabla es peor que uno publicado por el
 * R4 que estaba delante.
 *
 * Ojo con `session.rol`: se calcula en el login y viaja firmado dentro del token, así que puede
 * ser de hace horas. La existencia del mandato se relee AQUÍ del store en cada llamada — si el
 * sorteo se resolvió a mitad de la sesión de alguien, el permiso deja de ser el de su token.
 */
function requireCicloPermiso(deps, session, accion) {
  const mandato = mandatoVigente(deps);
  if (mandato) {
    return mandato.residenteId === session.sub ? null : { ok: false, error: `solo el Responsable puede ${accion}` };
  }
  // Hidratado: `groupOnDate` deriva MAYOR/PEQUENO de los periodos, así que el permiso del ciclo
  // (V-16) depende de los editados. Leerlo crudo aquí sería justo la incoherencia por acción que
  // la fase 2 de V-24 viene a quitar — alguien sería Mayor para validar y Pequeño para el resto.
  const residente = allResidentes(deps).find((r) => r.id === session.sub);
  const grupo = residente ? deps.domain.groupOnDate(residente, deps.today) : null;
  if (grupo !== "MAYOR") {
    return { ok: false, error: `no hay Responsable designado para este periodo: hasta que se decida, solo un R3 o R4 puede ${accion}` };
  }
  return null;
}

/**
 * Contexto de `validateMonth` para un mes, reconstruido ENTERAMENTE desde el store — nunca se
 * confía en un `cuadrante` que mandara el cliente para decidir una transición de estado (mismo
 * principio que el rol derivado: "nunca un flag que el cliente pueda falsear"). Incluye el
 * histórico de rotación cross-mes (contrato C-2, spec.md §5), igual que Calendar.jsx/Generator.jsx
 * — mismo ensamblado que ambos, vía `deps.domain.buildMonthContext`.
 */
function buildCuadranteCtx(deps, mes, anio, snap = monthSnapshot(deps)) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const bloqueos = bloqueosInRange(deps, snap.bloqueos, monthStart, `${prefix}-31`);
  const asignacionesDelMes = snap.asignaciones.filter((a) => a.fecha.startsWith(prefix));
  const desdeRotacion = deps.domain.rotationHistoryStart(bloqueos, monthStart);
  const historicas = desdeRotacion ? snap.asignaciones.filter((a) => a.fecha >= desdeRotacion && a.fecha < monthStart) : [];
  // Con margen hacia atrás: el vecino del día 1 cae en el mes anterior y decide si es puente
  // (§3.4). Se cogen los festivos desde el 1 del mes anterior —de más, y son inertes: isHoliday
  // compara fechas exactas y bridgesOfMonth solo mira día±1— en vez de restar un día, para no
  // necesitar aritmética de fechas aquí. El filtro por mes SÍ importa: si la lista llegara
  // completa, un año sin cargar dejaría de disparar el aviso de "no hay festivos cargados".
  const mesAnterior = mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, "0")}`;
  const mesSiguiente = mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, "0")}`;
  const festivos = (snap.festivos || []).filter((f) => f.fecha >= `${mesAnterior}-01` && f.fecha <= `${mesSiguiente}-01`);
  // Los eventos van SIN filtrar por mes: `buildMonthContext` se queda con los del año académico,
  // que es lo que empareja la Navidad de diciembre con la despedida del mayo siguiente. Las
  // excepciones también van sin filtrar: `twoR2Justified` ya comprueba tipo y rango él mismo.
  return deps.domain.buildMonthContext({ mes, anio, residentes: snap.residentes, historicas, asignacionesDelMes, bloqueos, festivos, eventos: snap.eventos || [], excepciones: snap.excepciones || [] });
}

/**
 * Escribe la proyección legible del mes (pestaña mensual "YYYY-MM" + hoja "Resumen") en el
 * Sheet real — spec.md §7, decisión V-11a. Se llama ANTES de escribir el estado PUBLICADO
 * (publicarCuadrante): si `rebuildSheet` lanza (fallo real de la API de Sheets), la
 * excepción sube hasta el try/catch de `handleRequest` y el cuadrante queda intacto en
 * VALIDADO — nunca un PUBLICADO fantasma con el Sheet a medio escribir. `rebuildSheet` ya
 * es idempotente/autorreparable (sheets-store.js), así que basta con reintentar "Publicar".
 * `publishedMonths` incluye el mes que se está publicando AHORA aunque su fila de estado
 * todavía no exista en la tabla `cuadrantes` (se escribe después de esta función).
 *
 * Ventana de desincronización aceptada (revisión de 4 agentes, Fase 7.1): las dos llamadas a
 * `rebuildSheet` (mensual, luego Resumen) no son una transacción conjunta — si la mensual
 * tiene éxito pero Resumen falla, el Sheet queda con la pestaña "YYYY-MM" ya actualizada
 * mientras el cuadrante sigue en VALIDADO (nunca PUBLICADO: eso sí está garantizado). El
 * siguiente "Publicar" con éxito reescribe AMBAS pestañas desde cero y lo repara del todo;
 * no se ha construido nada más elaborado (dos fases, rollback) porque la ventana es estrecha
 * y de bajo impacto (~15 usuarios, latencia de Apps Script) frente a la complejidad de evitarla.
 */
function projectCuadranteToSheets(deps, mes, anio) {
  const residentes = allResidentes(deps);
  const prefix = monthPrefix(anio, mes);
  const asignacionesDelMes = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" })
    .filter((a) => a.fecha.startsWith(prefix));

  const mensual = deps.domain.buildMonthSheetRows({ anio, mes, residentes, asignaciones: asignacionesDelMes });
  deps.store.rebuildSheet(mensual.sheetName, mensual.rows);

  const otrosPublicados = deps.store.readLatest("cuadrantes", CUAD_KEY).filter((r) => r.estado === "PUBLICADO");
  const publishedMonths = [...otrosPublicados.map((r) => ({ mes: r.mes, anio: r.anio })), { mes, anio }];

  // Las dos hojas agregadas son del CURSO académico del mes que se publica (decisión V-25), y lo
  // llevan en el nombre: publicar una corrección de un curso anterior republica LA HOJA DE ESE
  // CURSO, sin tocar la del actual. Con un nombre fijo se habrían pisado.
  const curso = deps.domain.academicYearOf(deps.domain.toISO(anio, mes, 1));
  const resumen = deps.domain.buildResumenRows({ residentes, publishedMonths, curso });
  deps.store.rebuildSheet(resumen.sheetName, resumen.rows);

  const contaje = deps.domain.buildContajeTrimestralRows({ residentes, publishedMonths, curso });
  deps.store.rebuildSheet(contaje.sheetName, contaje.rows);

  return { mensual: mensual.sheetName, resumen: resumen.sheetName, contaje: contaje.sheetName };
}

/**
 * Estado del mandato de un periodo: quién es elegible (R3 en el 1 de enero, derivado), quién se
 * ha ofrecido, si ya está decidido. Extraído porque `estadoResponsable` lo devuelve para dos
 * periodos (el pedido y el siguiente) y reimplementarlo dos veces es cómo se desincronizan.
 */
function periodoResponsable(deps, anio, session, residentes) {
  const { periodoInicio, periodoFin } = mandatoPeriod(anio);
  const voluntarios = activeVolunteers(deps, periodoInicio);
  return {
    anio, periodoInicio, periodoFin,
    elegibles: deps.domain.eligibleCandidates(residentes, periodoInicio),
    voluntarios,
    meHeOfrecido: voluntarios.includes(session.sub),
    mandato: currentMandate(deps, periodoInicio),
  };
}

/**
 * Voluntarios ACTIVOS del tercer puesto (última reinserción gana, como `activeVolunteers`).
 * Devuelve los registros, no solo los ids: `desde` es lo que necesitan el compromiso de
 * permanencia y `thirdPostHistoryStart` (el ciclo de INV-8b arranca ahí, no en el mes).
 */
function activeThirdPostVolunteers(deps) {
  return deps.store.readLatest("voluntarios3P", (r) => r.residenteId)
    .filter((v) => v.activo === true)
    .map((v) => ({ residenteId: v.residenteId, desde: v.desde }));
}

/**
 * TODOS los periodos de voluntariado del 3P, activos e históricos (decisión V-28, corrige
 * INV-8a). `readLatest` colapsa a una fila por residente y por eso sirve para "¿es voluntario
 * AHORA?" pero no para "¿lo era ESE día?": alguien que se apuntó, se retiró y volvió a apuntarse
 * tiene más de un periodo, y el de en medio desaparecería. Se lee con `readRecords` (crudo, sin
 * colapsar) y se agrupa por `residenteId+desde` —la baja siempre reinserta el MISMO `desde` que
 * su alta, añadiendo `hasta` (ver `retirarVoluntariado3P`)— así que cada par alta/baja se funde
 * en un solo periodo `{residenteId, desde, hasta}`, con `hasta` ausente si sigue activo.
 */
function allThirdPostPeriods(deps) {
  const porClave = new Map();
  for (const f of deps.store.readRecords("voluntarios3P")) {
    const clave = `${f.residenteId}|${f.desde}`;
    const periodo = porClave.get(clave) || { residenteId: f.residenteId, desde: f.desde, hasta: undefined };
    if (f.hasta) periodo.hasta = f.hasta;
    porClave.set(clave, periodo);
  }
  return [...porClave.values()];
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

/**
 * Valida la sesión y ejecuta `fn(payload)`, o devuelve el error de sesión.
 *
 * El `pendingToken` de `handleLogin` (emitido a un email que Google verificó pero que NO está
 * vinculado a ningún residente) va firmado con el MISMO secreto que una sesión, así que sin la
 * segunda comprobación valdría como sesión completa: y como el endpoint es ANYONE_ANONYMOUS y el
 * client_id es público, cualquiera con una cuenta de Google podía conseguir uno abriendo la web.
 * Se exige un `sub` (id de residente) en POSITIVO, no se descarta `pending` en negativo: así
 * cualquier clase futura de token sin sujeto queda fuera por defecto en vez de por enumeración.
 */
function authed(req, deps, fn) {
  const s = verifySession(req.session, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid) return { ok: false, error: `sesión ${s.reason}` };
  if (typeof s.payload.sub !== "string" || !s.payload.sub) {
    return { ok: false, error: "el token no identifica a ningún residente (¿es un token de alta?)" };
  }
  return fn(s.payload);
}

/**
 * Rol derivado: 'responsable' si hoy cae dentro de un mandato de la tabla responsables.
 * `readLatest` por periodoInicio (no `readRecords` crudo): si un mandato se reemplaza por
 * una corrección posterior (misma clave), la fila vieja no debe seguir concediendo el rol.
 */
function resolveRol(store, residenteId, today) {
  // Una sola definición de "el mandato que cubre hoy": la comparten el rol del token y el
  // permiso del ciclo (requireCicloPermiso), que si no podrían discrepar.
  const mandato = mandatoVigente({ store, today });
  return mandato && mandato.residenteId === residenteId ? "responsable" : "residente";
}

  return { handleRequest };
})();

// ── API pública ──
var Server = Object.assign({}, SheetsSchema, SheetsStore, Session, VerifyToken, Router);

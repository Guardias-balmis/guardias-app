/**
 * Code.gs · Adaptador impuro (I/O) del Web App de guardias-app.
 *
 * Es la ÚNICA pieza escrita a mano para Apps Script y la ÚNICA no testeada en Node: es la
 * frontera hexagonal (UrlFetchApp, Utilities, SpreadsheetApp, LockService, CacheService,
 * PropertiesService). Fina a propósito — toda la lógica (dominio, auth, sesión, store,
 * router) es pura y vive en los artefactos generados `domain.gs` (global Domain) y
 * `server-lib.gs` (global Server), que Apps Script carga en el mismo ámbito global.
 *
 * Configuración en Script Properties (Proyecto → Configuración): OAUTH_CLIENT_ID, SPREADSHEET_ID.
 * Despliegue: "Ejecutar como: yo" + "Acceso: cualquiera" (ANYONE_ANONYMOUS). Ver README-deploy.md.
 */

var PROPS = PropertiesService.getScriptProperties();
var SESSION_TTL = 12 * 3600; // 12 h

// doGet: el cliente pide un nonce antes de invocar a GIS (anti-replay del login).
function doGet(e) {
  return json_(Server.handleRequest(JSON.stringify({ action: "getNonce" }), deps_()));
}

// doPost: el cliente manda el JSON como text/plain (D-1); leemos e.postData.contents.
function doPost(e) {
  var body = (e && e.postData && e.postData.contents) || "";
  return json_(Server.handleRequest(body, deps_()));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Construye las dependencias del router con las primitivas reales de Apps Script.
function deps_() {
  return {
    now: Math.floor(Date.now() / 1000),
    today: Utilities.formatDate(new Date(), "Europe/Madrid", "yyyy-MM-dd"),
    clientId: PROPS.getProperty("OAUTH_CLIENT_ID"),
    sessionSecret: sessionSecret_(),
    sessionTtl: SESSION_TTL,
    crypto: crypto_(),
    store: sheetsStore_(),
    domain: {
      validateMonth: Domain.validateMonth,
      buildMonthContext: Domain.buildMonthContext,
      rotationHistoryStart: Domain.rotationHistoryStart,
      parseISO: Domain.parseISO,
      validateThirdPost: Domain.validateThirdPost,
      validateResidencyYearClose: Domain.validateResidencyYearClose,
      eligibleCandidates: Domain.eligibleCandidates,
      resolveMethod: Domain.resolveMethod,
      drawResponsible: Domain.drawResponsible,
      validateResponsible: Domain.validateResponsible,
      canValidate: Domain.canValidate,
      canPublish: Domain.canPublish,
      canUnpublish: Domain.canUnpublish,
      canEdit: Domain.canEdit,
      stateAfterEdit: Domain.stateAfterEdit,
      buildMonthSheetRows: Domain.buildMonthSheetRows,
      buildResumenRows: Domain.buildResumenRows,
    },
    newSeed: newSeed_,
    issueNonce: issueNonce_,
    consumeNonce: consumeNonce_,
    fetchTokeninfo: fetchTokeninfo_,
  };
}

// Semilla del sorteo del Responsable (INV-14): generada por la app, nunca por el dominio
// (cero I/O ahí, S-6). Utilities.getUuid() es la misma fuente que ya usa el store para ids.
function newSeed_() {
  return Utilities.getUuid();
}

// HMAC + base64url con Utilities (base64EncodeWebSafe = base64url; quitamos el padding).
function crypto_() {
  return {
    hmac: function (msg, secret) {
      return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret)).replace(/=+$/, "");
    },
    b64urlEncode: function (str) {
      return Utilities.base64EncodeWebSafe(str).replace(/=+$/, "");
    },
    b64urlDecode: function (b64) {
      var padded = b64 + "===".slice((b64.length + 3) % 4);
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
    },
  };
}

// Secreto de sesión autogenerado, persistido en PropertiesService. Rotarlo solo re-loguea.
function sessionSecret_() {
  var s = PROPS.getProperty("SESSION_SECRET");
  if (s) return s;
  return withScriptLock_(function () {
    var v = PROPS.getProperty("SESSION_SECRET");
    if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); PROPS.setProperty("SESSION_SECRET", v); }
    return v;
  });
}

// Nonces de un solo uso en CacheService (5 min de vida).
function issueNonce_() {
  var n = Utilities.getUuid();
  CacheService.getScriptCache().put("nonce_" + n, "1", 300);
  return n;
}
function consumeNonce_(n) {
  var cache = CacheService.getScriptCache();
  if (cache.get("nonce_" + n) !== "1") return false;
  cache.remove("nonce_" + n);
  return true;
}

// Verificación del ID token contra tokeninfo, con reintentos + backoff (endpoint de debugging).
function fetchTokeninfo_(idToken) {
  var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  for (var i = 0; i < 3; i++) {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
    Utilities.sleep(200 * (i + 1));
  }
  throw new Error("tokeninfo no disponible");
}

// Adaptador de SpreadsheetApp que cumple el contrato `ss` de Server.makeStore.
function sheetsStore_() {
  var ss = SpreadsheetApp.openById(PROPS.getProperty("SPREADSHEET_ID"));
  var adapter = {
    listSheets: function () { return ss.getSheets().map(function (s) { return s.getName(); }); },
    exists: function (n) { return ss.getSheetByName(n) != null; },
    read: function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh || sh.getLastRow() === 0) return []; // hoja vacía → [] (no [['']])
      return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    },
    overwrite: function (n, rows) {
      var sh = ss.getSheetByName(n);
      sh.clearContents();
      if (rows.length) sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    },
    append: function (n, rows) {
      if (!rows.length) return;
      var sh = ss.getSheetByName(n);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    },
    createSheet: function (n) { ss.insertSheet(n); },
    deleteSheet: function (n) { var sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); },
    renameSheet: function (from, to) { ss.getSheetByName(from).setName(to); },
  };
  return Server.makeStore({ ss: adapter, withLock: withScriptLock_, newId: function () { return Utilities.getUuid(); } });
}

// Escritor único serializado para los 15 usuarios (script lock, no user lock).
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

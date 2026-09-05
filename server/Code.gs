/**
 * Code.gs · Adaptador impuro (I/O) del Web App de guardias-app.
 *
 * Es la ÚNICA pieza escrita a mano para Apps Script y la ÚNICA no testeada en Node: es la
 * frontera hexagonal (UrlFetchApp, Utilities, SpreadsheetApp, LockService, CacheService,
 * PropertiesService). Fina a propósito — toda la lógica (dominio, auth, sesión, store,
 * router) es pura y vive en los artefactos generados `domain.gs` (global Domain) y
 * `server-lib.gs` (global Server), que Apps Script carga en el mismo ámbito global.
 *
 * Configuración en Script Properties (Proyecto → Configuración): OAUTH_CLIENT_ID, SPREADSHEET_ID
 * y, para el generador con IA (decisión V-45), GEMINI_API_KEY — y opcionalmente GEMINI_MODEL, que
 * por defecto es "gemma-4-31b-it". Sin GEMINI_API_KEY todo lo demás sigue funcionando igual: la
 * única acción que deja de estar disponible es `generarCuadranteIA`, y lo dice nombrando la
 * propiedad que falta en vez de fallar con un error de Google.
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
    // El dominio COMPLETO, no una lista de claves a mano: enumerarlas obligaba a repegar este
    // fichero cada vez que el dominio crecía, y olvidarlo daba un "… is not a function" en
    // producción (pasó el 2026-07-26 con quarterCloseWindow). `Domain` es el objeto plano que
    // arma domain.gs; se ha verificado que ningún módulo del dominio exporta dos veces el mismo
    // nombre, así que aplanarlo no puede ensombrecer nada en silencio.
    domain: Domain,
    newSeed: newSeed_,
    issueNonce: issueNonce_,
    consumeNonce: consumeNonce_,
    fetchTokeninfo: fetchTokeninfo_,
    // Puerto de generación (V-45). El núcleo del generador (prompt, parseo y ciclo de reintentos)
    // es puro y vive en el bundle; esto es solo el cable a Google.
    llm: llm_(),
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
//
// Solo se reintenta lo TRANSITORIO (5xx, o una excepción de red): un 4xx es la respuesta de Google
// a un token caducado, mal formado o de otro cliente, no cambia por insistir, y reintentarlo tres
// veces costaba 1,2 s de esperas y acababa en «tokeninfo no disponible», culpando a Google cuando
// lo que toca es volver a iniciar sesión (2026-09-05). El cuerpo del 4xx se devuelve tal cual para
// que `verifyTokeninfo` (server-lib.gs, con tests) lo rechace con su propio mensaje.
function fetchTokeninfo_(idToken) {
  var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  for (var i = 0; i < 3; i++) {
    var res = null;
    try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); } catch (e) { res = null; }
    if (res) {
      var code = res.getResponseCode();
      if (code === 200) return JSON.parse(res.getContentText());
      if (code >= 400 && code < 500) {
        var cuerpo = null;
        try { cuerpo = JSON.parse(res.getContentText()); } catch (e) { cuerpo = null; }
        return (cuerpo && typeof cuerpo === "object") ? cuerpo : { error: "invalid_token", status: code };
      }
    }
    Utilities.sleep(200 * (i + 1));
  }
  throw new Error("tokeninfo no disponible");
}

/**
 * Adaptador del puerto de generación con IA (decisión V-45): el ÚNICO sitio del proyecto que sabe
 * que detrás hay una Gemini API y un modelo Gemma.
 *
 * Tres decisiones que no son de estilo:
 *  - La clave sale de Script Properties y viaja en la cabecera `x-goog-api-key`, NO en la query
 *    string: una clave en la URL acaba en los registros de ejecución de Apps Script, que puede
 *    leer cualquiera con acceso al proyecto, y ahí ya no se puede borrar.
 *  - El id del modelo es CONFIGURABLE (`GEMINI_MODEL`). Fijarlo en el código sería una bomba de
 *    relojería para una app cuyo requisito rector es durar diez años sin administrador: el listado
 *    de modelos servidos cambia varias veces al año, y el día que retiren este, cambiar una
 *    propiedad es algo que puede hacer el residente de turno; repegar un .gs, no.
 *  - `muteHttpExceptions` + devolver `{ok:false, error}` en vez de lanzar: el ciclo de reintentos
 *    trata un fallo de transporte como un intento gastado y sigue. Si esto lanzara, un 503 de
 *    Google dejaría al responsable con una pantalla de error de Apps Script en vez de con un
 *    «inténtalo otra vez».
 */
function llm_() {
  // La ausencia de la clave se comprueba AQUÍ, no dentro de `generar`: `deps.llm` tiene que salir
  // falsy para que el guard de `router.js:handleGenerarIA` (el mismo que usa `dev-server.mjs` con
  // `llm: undefined`) corte en un solo golpe, con el mensaje limpio que promete el comentario de
  // cabecera de este fichero — si `generar` existiera pero fallara al invocarse, el ciclo de
  // reintentos de `generateSchedule` lo trataría como un intento gastado y gastaría los 3 antes de
  // decir lo mismo, dejando además una fila `ERROR_MODELO, intentos:3` engañosa en `generaciones`.
  var apiKey = PROPS.getProperty("GEMINI_API_KEY");
  if (!apiKey) return null;
  var modelo = PROPS.getProperty("GEMINI_MODEL") || "gemma-4-31b-it";
  return {
    modelo: modelo,
    generar: function (prompt) {
      var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(modelo) + ":generateContent";
      // Un solo mensaje de usuario, sin `systemInstruction`: los modelos Gemma servidos por la
      // Gemini API no admiten instrucción de sistema, y mandarla es un 400 — el prompt ya lleva
      // dentro todo el encargo, así que no hace falta.
      var payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      };
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var codigo = res.getResponseCode();
      var cuerpo = res.getContentText();
      if (codigo !== 200) {
        // El mensaje de Google se recorta pero NO se sustituye: «modelo no encontrado» y «cuota
        // agotada» piden cosas distintas de quien lo lee, y un error genérico las confunde.
        return { ok: false, error: "el modelo respondió HTTP " + codigo + ": " + cuerpo.slice(0, 300) };
      }
      var texto;
      try {
        var json = JSON.parse(cuerpo);
        var partes = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
        texto = (partes || []).map(function (p) { return p.text || ""; }).join("");
      } catch (e) {
        return { ok: false, error: "no se pudo leer la respuesta del modelo: " + e.message };
      }
      if (!texto) return { ok: false, error: "el modelo respondió sin texto (¿respuesta cortada o filtrada?)" };
      return { ok: true, texto: texto };
    },
  };
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
      if (rows.length) ensureGrid_(sh, rows.length, rows[0].length).getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    },
    append: function (n, rows) {
      if (!rows.length) return;
      // Si la pestaña no existe, se crea: así el arranque no depende de haber creado a mano las
      // 9 hojas de datos (la cabecera la escribe sheets-store al ver la hoja vacía), y una tabla
      // nueva del esquema no revienta con "Cannot read properties of null". El fake de los tests
      // y el dev-server ya se comportaban así; producción era el único sitio que fallaba.
      var sh = ss.getSheetByName(n) || ss.insertSheet(n);
      var desde = sh.getLastRow() + 1;
      ensureGrid_(sh, desde + rows.length - 1, rows[0].length).getRange(desde, 1, rows.length, rows[0].length).setValues(rows);
    },
    createSheet: function (n) { ss.insertSheet(n); },
    deleteSheet: function (n) { var sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); },
    renameSheet: function (from, to) { ss.getSheetByName(from).setName(to); },
  };
  return Server.makeStore({ ss: adapter, withLock: withScriptLock_, newId: function () { return Utilities.getUuid(); } });
}

/**
 * Crece la rejilla de la hoja hasta que quepa lo que se va a escribir, y la devuelve.
 *
 * `getRange` NO amplía la hoja: pedir un rango fuera de la rejilla lanza, y una hoja nueva de
 * Apps Script nace con 1000 filas × 26 columnas. Eso son dos fallos garantizados sin esto:
 *  - Columnas: la pestaña mensual de la proyección tiene 9 columnas fijas + un día por columna =
 *    hasta 40. El PRIMER "Publicar" real habría lanzado antes de escribir una sola fórmula.
 *  - Filas: `asignaciones` crece ~700 filas/año y nunca se borra (append-only), así que el tope
 *    de 1000 se alcanza en año y medio y a partir de ahí NADA se puede guardar.
 * Los dos son invisibles para los tests: el `ss` falso es un array de arrays sin límites.
 */
function ensureGrid_(sh, filas, columnas) {
  var maxFilas = sh.getMaxRows();
  if (filas > maxFilas) sh.insertRowsAfter(maxFilas, filas - maxFilas);
  var maxCols = sh.getMaxColumns();
  if (columnas > maxCols) sh.insertColumnsAfter(maxCols, columnas - maxCols);
  return sh;
}

// Escritor único serializado para los 15 usuarios (script lock, no user lock).
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

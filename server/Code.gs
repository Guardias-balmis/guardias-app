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
 * propiedad que falta en vez de fallar con un error de Google. Opcional también
 * CONTAJE_SPREADSHEET_ID (decisión V-65): el id de la Hoja de Google del contaje del servicio, en la
 * que la app escribe al publicar; sin ella publicar responde «omitido» y no toca ningún fichero.
 * Despliegue: "Ejecutar como: yo" + "Acceso: cualquiera" (ANYONE_ANONYMOUS). Ver README-deploy.md.
 */

var PROPS = PropertiesService.getScriptProperties();
var SESSION_TTL = 12 * 3600; // 12 h

// doGet: la app no lo usa (todo va por POST, también el nonce del login). Un GET aquí es un POST
// que Google convirtió por el camino, y responder `ok:true` hacía pasar por buena una petición que
// no se había ejecutado (2026-10-07, ver `router.js:handleGet`). Ejecutarlo desde el editor sigue
// sirviendo para autorizar permisos nuevos (como el de correo de V-53).
function doGet(e) {
  return json_(Server.handleGet());
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
    // Reloj en milisegundos para que el generador con IA no empiece un intento que no le cabe
    // antes de que Google mate la ejecución a los 6 minutos (2026-10-08). `now` se toma aquí, al
    // empezar la petición, y es desde donde se cuenta.
    relojMs: function () { return Date.now(); },
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
    // Aviso por correo a quien puede aprobar una solicitud de acceso (V-53, V-54, V-57). Es solo
    // un aviso: la aprobación se hace dentro de la app. Necesita el permiso de Gmail/MailApp
    // (`script.send_mail`): la PRIMERA vez que se despliegue con esto, Apps Script pide autorizarlo.
    sendMail: function (para, asunto, cuerpo) { MailApp.sendEmail(para.join(","), asunto, cuerpo); },
    // Puerto de generación (V-45). El núcleo del generador (prompt, parseo y ciclo de reintentos)
    // es puro y vive en el bundle; esto es solo el cable a Google.
    llm: llm_(),
    // Puerto del Excel del servicio (decisión V-65): null sin CONTAJE_SPREADSHEET_ID, y entonces
    // publicar funciona exactamente como antes. El fichero NO se abre aquí, sino en la primera
    // llamada: `deps_()` se construye en cada petición y abrir otro fichero cuesta un viaje a Sheets.
    contaje: contaje_(),
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
      if (code >= 400 && code < 500 && code !== 429) { // 429 (cuota) SÍ es transitorio: sigue al reintento
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

/**
 * Adaptador del puerto `deps.contaje` (decisión V-65): el Excel del servicio convertido a Hoja de
 * Google. TONTO a propósito, porque es lo único de esta función que no tiene tests: abre el
 * fichero, lee rangos y ejecuta las operaciones genéricas (escribir, limpiar, unir…) que le manda
 * el dominio (`contajeExcel.js`), que es quien decide QUÉ se escribe y dónde. Mismo contrato que el
 * doble en memoria de `server/contaje-memoria.mjs`, que es el que usan los tests y el dev-server.
 *
 * `abrir()` devuelve un motivo en vez de lanzar si el fichero no se puede abrir (id equivocado, o
 * la cuenta que ejecuta la app no tiene acceso): el router responde entonces «omitido» y la
 * publicación sigue como siempre.
 */
function contaje_() {
  var id = PROPS.getProperty("CONTAJE_SPREADSHEET_ID");
  if (!id) return null;
  var libro = null;
  function abrirLibro() { if (!libro) libro = SpreadsheetApp.openById(id); return libro; }
  // Una entrada por hoja y ejecución: el objeto hoja y el tamaño de su rejilla. Cada lectura a
  // SpreadsheetApp en medio de escrituras obliga a aplicar lo pendiente (un viaje de ida y vuelta),
  // y el volcado va con el script lock cogido: sin esta memoria, `getSheetByName`/`getMaxRows`/
  // `getMaxColumns` en cada operación eran casi la mitad de las ~400 llamadas de un volcado.
  var cache = {};
  function entrada(n) {
    if (cache[n]) return cache[n];
    var sh = abrirLibro().getSheetByName(n);
    if (!sh) throw new Error("no existe la hoja «" + n + "» en el fichero de contaje");
    cache[n] = { sh: sh, filas: null, columnas: null };
    return cache[n];
  }
  // Amplía la rejilla si no llega (el fichero convertido trae hasta AL y la plantilla llega a AN).
  function rejilla(e, filas, columnas) {
    if (e.filas === null) { e.filas = e.sh.getMaxRows(); e.columnas = e.sh.getMaxColumns(); }
    if (filas > e.filas) { e.sh.insertRowsAfter(e.filas, filas - e.filas); e.filas = filas; }
    if (columnas > e.columnas) { e.sh.insertColumnsAfter(e.columnas, columnas - e.columnas); e.columnas = columnas; }
    return e;
  }
  return {
    // Además de abrirlo, comprueba que se puede EDITAR: con acceso de lector `openById` funciona y el
    // fallo llegaría a mitad del volcado. Fijar la zona horaria que ya tiene es una escritura que no
    // cambia nada; sin permiso de edición lanza, y entonces el volcado se omite con el motivo.
    abrir: function () {
      try { abrirLibro(); } catch (e) { return "no se puede abrir la hoja de contaje (CONTAJE_SPREADSHEET_ID): " + e.message; }
      try { libro.setSpreadsheetTimeZone(libro.getSpreadsheetTimeZone()); } catch (e) {
        return "la cuenta que ejecuta la app no puede editar la hoja de contaje (compártela con ella como editora): " + e.message;
      }
      return null;
    },
    hojas: function () { return abrirLibro().getSheets().map(function (s) { return s.getName(); }); },
    // Sin `filas`, hasta la última fila con contenido (como `getLastRow`); [] si no hay ninguna.
    // `getDisplayValues` y no `getValues`: lo que se ve, como texto. «Obs.» la teclean personas, y un
    // «15/7» que Sheets guarda como fecha llegaría como Date y el volcado lo reescribiría como
    // «Wed Jul 15 2026 00:00:00 GMT+0200…». Para las huellas da igual: comparan texto.
    leer: function (n, l) {
      var e = entrada(n);
      var filas = l.filas || (e.sh.getLastRow() - l.fila + 1);
      if (filas <= 0) return [];
      return rejilla(e, l.fila + filas - 1, l.columna + l.columnas - 1).sh.getRange(l.fila, l.columna, filas, l.columnas).getDisplayValues();
    },
    // La rejilla se amplía UNA vez por hoja, con lo que pide el plan entero, y no en cada operación.
    aplicar: function (n, ops) {
      var e = entrada(n), filas = 1, columnas = 1;
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op.fila) filas = Math.max(filas, op.fila + (op.valores ? op.valores.length : (op.filas || 1)) - 1);
        if (op.columna) columnas = Math.max(columnas, op.columna + (op.valores ? op.valores[0].length : (op.columnas || 1)) - 1);
      }
      rejilla(e, filas, columnas);
      for (var j = 0; j < ops.length; j++) aplicarContajeOp_(e, ops[j]);
    },
    // `copyTo` deja la copia al final, con el nombre «Copia de …» y oculta si el original lo estaba.
    duplicar: function (origen, destino) {
      var sh = entrada(origen).sh.copyTo(abrirLibro());
      sh.setName(destino);
      sh.showSheet();
      cache[destino] = { sh: sh, filas: null, columnas: null };
    },
    renombrar: function (a, b) { var e = entrada(a); e.sh.setName(b); cache[b] = e; delete cache[a]; },
    ocultar: function (n) { entrada(n).sh.hideSheet(); },
    borrar: function (n) { var sh = abrirLibro().getSheetByName(n); if (sh) abrirLibro().deleteSheet(sh); delete cache[n]; },
  };
}

// Una operación del plan de `contajeExcel.js` sobre una hoja (`e`: {sh, filas, columnas}, con la
// rejilla ya ampliada por `aplicar`). Coordenadas numéricas (fila, columna 1-based); `a1` viaja
// solo para los mensajes y los tests.
function aplicarContajeOp_(e, op) {
  var sh = e.sh, r;
  switch (op.op) {
    case "escribir":
      r = sh.getRange(op.fila, op.columna, op.valores.length, op.valores[0].length);
      r.setValues(op.valores);
      if (op.fondos) r.setBackgrounds(op.fondos);
      if (op.colores) r.setFontColors(op.colores);
      if (op.negritas) r.setFontWeights(op.negritas);
      return;
    case "limpiar":
      r = sh.getRange(op.fila, op.columna, op.filas || (e.filas - op.fila + 1), op.columnas);
      r.clearContent();
      r.setBackground(null);
      r.setFontColor(null);
      r.setFontWeight(null);
      return;
    case "unir":
      sh.getRange(op.fila, op.columna, op.filas, op.columnas).merge();
      return;
    case "desunir":
      sh.getRange(op.fila, op.columna, op.filas, op.columnas).breakApart();
      return;
    case "anchos":
      sh.setColumnWidths(op.columna, op.columnas, op.px);
      return;
    case "ocultarColumnas":
      sh.hideColumns(op.columna, op.columnas);
      return;
    case "congelar":
      sh.setFrozenRows(op.filas);
      sh.setFrozenColumns(op.columnas);
      return;
    case "proteger":
      // Una sola protección de hoja: si ya hay una (la de un volcado anterior, o una que puso alguien
      // a mano) se respeta tal cual. «Con advertencia» no impide editar a nadie, solo pregunta.
      if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
      var p = sh.protect().setDescription(op.descripcion).setWarningOnly(true);
      if (op.libres.length) p.setUnprotectedRanges(op.libres.map(function (a) { return sh.getRange(a); }));
      return;
    default:
      throw new Error("operación desconocida en el plan del contaje: " + op.op);
  }
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
// `SpreadsheetApp.flush()` ANTES de soltar el lock (2026-10-07), como pide la guía de LockService:
// Apps Script agrupa las escrituras de la hoja y las aplica al acabar el script (o al leer), así que
// sin él la siguiente ejecución que coge el lock podía leer la hoja todavía sin la última escritura
// de esta —el sorteo que no ve el mandato recién escrito, el generador que no ve la celda recién
// guardada— y su comprobar-y-escribir decidía con datos viejos aunque `sheets-store.js` relea todo
// al entrar. El try anidado suelta el lock aunque `flush` lance.
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

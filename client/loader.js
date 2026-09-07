// loader.js · Carga de las pantallas .jsx (Fase 3.4, sustituye a Babel Standalone como escáner
// automático de <script data-type="module">).
//
// Por qué existe: verificado en un navegador real que Babel Standalone, al procesar VARIOS
// <script type="text/babel" data-type="module" src="..."> a la vez (8 ficheros en esta app),
// pierde alguno EN SILENCIO — sin error en consola, sin excepción — probablemente por un
// límite interno de su escaneo automático del DOM. El código transpilado en sí es correcto
// (verificado inyectándolo a mano); el problema es solo el mecanismo de descubrimiento
// automático de Babel Standalone con múltiples ficheros.
//
// La solución es más simple que el problema: en vez de confiar en que Babel Standalone
// encuentre y procese cada <script> por su cuenta, este cargador hace lo mismo EXPLÍCITAMENTE
// — fetch, `Babel.transform` (la API núcleo, no el escáner automático), y `import()` de un Blob
// URL con el resultado. Es determinista, y si un fichero falla, el error señala CUÁL.
//
// DOS CORRECCIONES DEL 2026-08-31, por un síntoma reportado en producción: «hay veces que ni se
// abre la app». Las dos atacan la misma causa —el arranque dependía de una decena de peticiones
// encadenadas y sin red de seguridad— y ninguna toca la decisión C-1.
//
//  1. **Los fetch van EN PARALELO; transpilar e importar sigue EN ORDEN.** Antes cada fichero
//     esperaba a que el anterior terminara de descargarse, transpilarse e importarse: diez idas
//     y vueltas encadenadas, que en una conexión con latencia alta (móvil, wifi de hospital) es
//     casi todo el tiempo de arranque. El orden solo hace falta al IMPORTAR —`App.jsx` consume
//     los `window.Screens.*` de los anteriores—, no al descargar, así que se piden los diez a la
//     vez y se consumen por turno según van llegando.
//
//  2. **Cada fetch reintenta**, con el mismo criterio que `client/lib/api.js` (decisión V-26).
//     Sin esto, UN solo fallo de red transitorio en cualquiera de los diez ficheros dejaba la
//     aplicación sin arrancar, con un mensaje de error y nada que el residente pudiera hacer
//     salvo recargar a ciegas. `api.js` ya tenía esta red desde un bug real de producción; el
//     cargador —que es más frágil, porque sin él no hay aplicación— se había quedado sin ella.
//
// TRES MÁS DEL 2026-09-04, por un pedido directo del autor: «más velocidad al iniciar la
// aplicación, sobre todo al meter el correo con Google». Medido en un móvil, el arranque se iba
// casi entero en tres cosas que no dependen de la red del hospital sino de este cargador:
//
//  3. **El JSX transpilado se CACHEA en `localStorage`**, con la clave = la huella SHA-256 del
//     fuente de cada fichero. Transpilar diez ficheros con Babel son entre uno y dos segundos de
//     CPU en un teléfono, y son SIEMPRE los mismos ficheros dando SIEMPRE el mismo resultado hasta
//     el siguiente despliegue. Con la huella del fuente como clave, un despliegue nuevo invalida
//     la caché solo (el fuente cambia → la huella cambia → se transpila y se vuelve a guardar), y
//     un fuente sin cambios no vuelve a pasar por Babel nunca. Cualquier fallo de la caché —cuota
//     llena, modo privado, entrada corrupta— cae al camino de siempre: transpilar.
//
//  4. **Babel solo se descarga si hace falta.** Son ~2,3 MB, la descarga más pesada del arranque
//     con diferencia, y hasta ahora iba en un <script> bloqueante en la cabecera de index.html:
//     ni un byte de la app se pintaba hasta tenerlo entero, y luego había que compilarlo. Con la
//     caché del punto 3, la visita normal no necesita Babel para nada; se inyecta bajo demanda
//     solo cuando algún fichero no está en caché (primera visita o despliegue nuevo). En la
//     primera visita se pide desde el principio, en paralelo con los fuentes, para no pagarlo
//     en serie.
//
//  5. **El nonce del login se pide ANTES de que exista la pantalla de login.** El botón de
//     Google no se podía pintar hasta tener el nonce (viaja dentro del ID token, es el
//     antirreplay de ADR-002), y pedirlo era una ida y vuelta entera a Apps Script —más el
//     arranque en frío del script— que empezaba solo cuando Login.jsx ya estaba montado. Ahora
//     se pide aquí, en la primera línea del arranque, y para cuando la pantalla existe suele
//     estar ya de vuelta. Solo si no hay sesión guardada: con sesión no hay login que pintar.
//
// Los .jsx siguen sin poder importarse entre sí (ver decisión C-1, plan.md): la composición
// sigue siendo por namespaces globales (window.UI, window.Screens). Este cargador solo
// sustituye el mecanismo de CARGA, no la arquitectura de composición.

const JSX_FILES = [
  "client/ui/components.jsx",
  "client/screens/Login.jsx",
  "client/screens/Home.jsx",
  "client/screens/Calendar.jsx",
  "client/screens/Prefs.jsx",
  "client/screens/Settings.jsx",
  "client/screens/Responsable.jsx",
  "client/screens/DatosServicio.jsx",
  "client/screens/Residentes.jsx",
  "client/App.jsx", // siempre el último: usa window.Screens.* de todos los anteriores
];

// Misma versión y mismo origen que llevaba index.html. Si se sube de versión, la caché se invalida
// sola por el prefijo de abajo: un Babel distinto puede emitir código distinto para el mismo fuente.
const BABEL_URL = "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js";
const CACHE_PREFIX = "gapp_jsx:babel-7.23.2:";

// Los `blob:` URL son opacos (sin jerarquía de rutas): un import relativo DENTRO de un
// módulo cargado desde uno falla con "base scheme isn't hierarchical" (verificado). Antes
// de crear el blob, se reescriben los especificadores relativos a absolutos usando la URL
// del documento como base — coherente con que todos los .jsx ya escriben sus imports
// relativos a la raíz del sitio (decisión C-1), no a su propio fichero.
// Se hace al CARGAR y no al guardar en caché: así lo cacheado no lleva la URL del sitio dentro y
// sigue valiendo si la app se sirve desde otra ruta del mismo origen.
function absolutizeImports(code) {
  return code.replace(/from\s+(["'])(\.[^"']*)\1/g, (_, q, spec) => `from ${q}${new URL(spec, document.baseURI).href}${q}`);
}

// Mismos tiempos que `client/lib/api.js`: dos reintentos, porque hay una persona esperando
// delante de una pantalla en blanco. Un tercero no arregla una caída de red de verdad y solo
// alarga la espera antes de decirle que recargue.
const REINTENTOS_MS = [400, 1200];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Descarga el fuente de un .jsx, reintentando los fallos de TRANSPORTE. No distingue entre un
 * 5xx y una excepción de red a propósito: los dos son «no ha llegado», y los ficheros son
 * estáticos en Pages, así que repetir la petición no tiene ningún efecto secundario.
 */
async function fetchFuente(path) {
  let ultimo = "sin respuesta";
  for (let i = 0; i <= REINTENTOS_MS.length; i++) {
    if (i > 0) await espera(REINTENTOS_MS[i - 1]);
    try {
      const res = await fetch(path);
      if (res.ok) return await res.text();
      ultimo = `HTTP ${res.status}`;
    } catch (e) {
      ultimo = String((e && e.message) || e);
    }
  }
  throw new Error(`${ultimo} al pedir ${path}`);
}

// ── Caché del transpilado ──────────────────────────────────────────────────────────────────
// Todo lo que toca `localStorage` va en try/catch y devuelve «no hay»: en modo privado de
// Safari, con la cuota llena o con el almacenamiento bloqueado, la caché simplemente no existe
// y el arranque es el de siempre. Nunca puede impedir que la app arranque.

/** Huella SHA-256 (hex) del fuente, o null si el navegador no ofrece `crypto.subtle`. */
async function huella(src) {
  try {
    if (!(crypto && crypto.subtle)) return null;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function leerCache(path, hash) {
  if (!hash) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    const entrada = JSON.parse(raw);
    return entrada && entrada.hash === hash && typeof entrada.code === "string" ? entrada.code : null;
  } catch {
    return null;
  }
}

function guardarCache(path, hash, code) {
  if (!hash) return;
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ hash, code }));
  } catch {
    /* sin cuota o sin almacenamiento: se transpilará otra vez la próxima vez, y ya */
  }
}

function borrarCache(path) {
  try { localStorage.removeItem(CACHE_PREFIX + path); } catch { /* nada que borrar */ }
}

/** ¿Hay ALGUNA entrada de caché? Decide si Babel se pide desde el primer instante o solo si falta. */
function hayCache() {
  try {
    return JSX_FILES.some((path) => localStorage.getItem(CACHE_PREFIX + path) !== null);
  } catch {
    return false;
  }
}

/**
 * Limpia las entradas de versiones anteriores de la caché (otro Babel, otro esquema de claves) y
 * las de ficheros que ya no existen. Sin esto, cada cambio de versión dejaría ~300 KB huérfanos
 * en el `localStorage` del teléfono de cada residente, para siempre.
 */
function purgarCacheVieja() {
  try {
    const vigentes = new Set(JSX_FILES.map((path) => CACHE_PREFIX + path));
    const huerfanas = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("gapp_jsx:") && !vigentes.has(k)) huerfanas.push(k);
    }
    huerfanas.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* sin almacenamiento no hay nada que purgar */
  }
}

// ── Babel bajo demanda ─────────────────────────────────────────────────────────────────────
let babelPendiente = null;
function cargarBabel() {
  if (typeof Babel !== "undefined") return Promise.resolve();
  if (!babelPendiente) {
    babelPendiente = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = BABEL_URL;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("No se pudo cargar el compilador (Babel) desde el CDN. Comprueba la conexión y recarga la página."));
      document.head.appendChild(s);
    });
    // El fallo se entrega a quien haga `await`; sin esto, un CDN caído a mitad de la primera
    // visita se contaría además como «unhandled rejection» antes de llegar a decirlo en pantalla.
    babelPendiente.catch(() => {});
  }
  return babelPendiente;
}

async function transpilar(path, src) {
  await cargarBabel();
  const { code } = Babel.transform(src, {
    presets: [["react"], ["env", { modules: false }]],
    sourceType: "module",
    filename: path,
  });
  return code;
}

function importar(code) {
  const url = URL.createObjectURL(new Blob([absolutizeImports(code)], { type: "text/javascript" }));
  try {
    return import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Carga un .jsx: de la caché si el fuente no ha cambiado, transpilando si no. Una entrada de caché
 * que no se deja importar (corrupta, truncada por la cuota) se descarta y se transpila de nuevo,
 * en vez de dejar la app sin arrancar por un dato que solo existe para ahorrar tiempo.
 */
async function loadJSX(path, src) {
  const hash = await huella(src);
  const cacheado = leerCache(path, hash);
  if (cacheado !== null) {
    try {
      return await importar(cacheado);
    } catch (e) {
      console.warn(`[loader] la caché de ${path} no se pudo importar; se transpila de nuevo`, e);
      borrarCache(path);
    }
  }
  const code = await transpilar(path, src);
  const mod = await importar(code);
  guardarCache(path, hash, code); // solo si importó bien: una caché de algo roto no sirve de nada
  return mod;
}

/**
 * Punto 5: pide el nonce del login en cuanto arranca el cargador. Los tres módulos se importan
 * DINÁMICAMENTE y no con `import` estático a propósito: un import estático retrasaría el resto
 * del arranque (los fetch de los .jsx) hasta que llegaran, y aquí lo que se quiere es que salgan
 * todos a la vez. Son los MISMOS módulos que luego importa `Login.jsx` desde su blob —misma URL
 * absoluta en el mismo origen—, así que la promesa que guarda `prefetchNonce` es la que
 * `setupGoogleSignIn` consume. Con sesión guardada no hay login que pintar: no se pide nada.
 */
async function precargarNonce() {
  try {
    const [{ makeApi }, { getSession, prefetchNonce }, { EXEC_URL }] = await Promise.all([
      import("./lib/api.js"), import("./lib/auth.js"), import("./config.js"),
    ]);
    if (!getSession()) prefetchNonce(makeApi(EXEC_URL));
  } catch (e) {
    // Si esto falla, Login.jsx pedirá el nonce por su cuenta, como siempre: solo se pierde el adelanto.
    console.warn("[loader] no se pudo adelantar el nonce del login", e);
  }
}

function fallo(mensaje) {
  console.error("[loader] " + mensaje);
  document.getElementById("root").textContent = mensaje;
}

async function main() {
  // React y ReactDOM siguen viniendo de CDN en la cabecera. Si alguno no llegó, el fallo real
  // sería un «React is not defined» dentro del primer módulo, que no le dice nada a quien lo
  // sufre: se comprueba antes y se dice lo único accionable, que es volver a cargar.
  const falta = [
    typeof React === "undefined" && "React",
    typeof ReactDOM === "undefined" && "ReactDOM",
  ].filter(Boolean);
  if (falta.length) {
    return fallo(`No se pudo cargar ${falta.join(", ")} desde el CDN. Comprueba la conexión y recarga la página.`);
  }

  precargarNonce(); // sin await: va en paralelo con todo lo de abajo

  purgarCacheVieja();
  // Punto 4: sin ninguna entrada de caché (primera visita, o caché purgada), Babel hace falta
  // seguro — se pide YA, en paralelo con los fuentes, en vez de descubrirlo cuando ya llegaron.
  if (!hayCache()) cargarBabel();

  // Los diez fetch salen A LA VEZ. El `.then` de dos ramas captura el error COMO VALOR en vez de
  // dejar la promesa rechazada: si un fichero tardío falla, se consumiría varios turnos después
  // del `await`, y hasta entonces el navegador lo contaría como «unhandled rejection».
  const pendientes = JSX_FILES.map((path) =>
    fetchFuente(path).then((src) => ({ path, src }), (error) => ({ path, error }))
  );

  // Pero se transpilan e importan EN ORDEN: `App.jsx` va el último porque usa los
  // `window.Screens.*` que registran los anteriores (decisión C-1).
  for (const pendiente of pendientes) {
    const { path, src, error } = await pendiente;
    if (error) return fallo(`Error cargando ${path}: ${error.message} (revisa la consola)`);
    try {
      await loadJSX(path, src);
    } catch (e) {
      console.error(`[loader] fallo transpilando/importando ${path}`, e);
      return fallo(`Error cargando ${path}: ${e.message} (revisa la consola)`);
    }
  }

  if (!window.Screens || !window.Screens.App) {
    return fallo("Error: App no se registró tras cargar todos los ficheros.");
  }
  ReactDOM.render(React.createElement(window.Screens.App), document.getElementById("root"));
}

main();

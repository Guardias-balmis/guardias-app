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

// Los `blob:` URL son opacos (sin jerarquía de rutas): un import relativo DENTRO de un
// módulo cargado desde uno falla con "base scheme isn't hierarchical" (verificado). Antes
// de crear el blob, se reescriben los especificadores relativos a absolutos usando la URL
// del documento como base — coherente con que todos los .jsx ya escriben sus imports
// relativos a la raíz del sitio (decisión C-1), no a su propio fichero.
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

function loadJSX(path, src) {
  const { code } = Babel.transform(src, {
    presets: [["react"], ["env", { modules: false }]],
    sourceType: "module",
    filename: path,
  });
  const url = URL.createObjectURL(new Blob([absolutizeImports(code)], { type: "text/javascript" }));
  try {
    return import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fallo(mensaje) {
  console.error("[loader] " + mensaje);
  document.getElementById("root").textContent = mensaje;
}

async function main() {
  // Las tres bibliotecas vienen de CDN y son la dependencia externa más frágil del arranque
  // (Babel Standalone son ~2,3 MB). Si alguna no llegó, el fallo real es «Babel is not defined»
  // dentro del primer transform, que no le dice nada a quien lo sufre: se comprueba antes y se
  // dice lo único accionable, que es volver a cargar.
  const falta = [
    typeof Babel === "undefined" && "el compilador (Babel)",
    typeof React === "undefined" && "React",
    typeof ReactDOM === "undefined" && "ReactDOM",
  ].filter(Boolean);
  if (falta.length) {
    return fallo(`No se pudo cargar ${falta.join(", ")} desde el CDN. Comprueba la conexión y recarga la página.`);
  }

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

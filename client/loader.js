// loader.js · Carga secuencial de las pantallas .jsx (Fase 3.4, sustituye a Babel Standalone
// como escáner automático de <script data-type="module">).
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
// y EN SECUENCIA — fetch, `Babel.transform` (la API núcleo, no el escáner automático), y
// `import()` de un Blob URL con el resultado — esperando a que cada módulo termine antes de
// pasar al siguiente. Es determinista, y si un fichero falla, el error señala CUÁL.
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
  "client/screens/Generator.jsx",
  "client/screens/Settings.jsx",
  "client/screens/Responsable.jsx",
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

async function loadJSX(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} al pedir ${path}`);
  const src = await res.text();
  const { code } = Babel.transform(src, {
    presets: [["react"], ["env", { modules: false }]],
    sourceType: "module",
    filename: path,
  });
  const url = URL.createObjectURL(new Blob([absolutizeImports(code)], { type: "text/javascript" }));
  try {
    await import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function main() {
  for (const path of JSX_FILES) {
    try {
      await loadJSX(path);
    } catch (e) {
      console.error(`[loader] fallo cargando ${path}`, e);
      document.getElementById("root").textContent = `Error cargando ${path}: ${e.message} (revisa la consola)`;
      return;
    }
  }
  if (!window.Screens || !window.Screens.App) {
    document.getElementById("root").textContent = "Error: App no se registró tras cargar todos los ficheros.";
    return;
  }
  ReactDOM.render(React.createElement(window.Screens.App), document.getElementById("root"));
}

main();

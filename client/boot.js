// boot.js · Arranque de la SPA sin bundler (Fase 3, arquitectura "cero toolchain").
//
// Por qué existe: los ficheros de pantalla (.jsx) se cargan como
// `<script type="text/babel" data-type="module" src="...">`. Babel Standalone transpila
// cada uno e inyecta el resultado como un `<script type="module">` dinámico — y un script
// de módulo insertado por JS (no parseado en el HTML original) es `async` por defecto, así
// que Babel NO garantiza que se ejecuten en el orden de aparición en el HTML (verificado:
// sin este arranque, una pantalla puede intentar usar un componente compartido que aún no
// se ha registrado). Los ficheros JSX tampoco pueden importarse entre sí con `import`
// (Babel no resuelve ese grafo) — cada uno se registra en un espacio de nombres global:
// `window.UI.*` (componentes compartidos) y `window.Screens.*` (pantallas completas).
//
// La solución: en vez de confiar en el orden de carga, boot.js ESPERA (sondeo simple, sin
// dependencias) a que todos los globals necesarios existan antes de arrancar React. Es
// deliberadamente tonto y fácil de razonar para un futuro mantenedor — nada de promesas ni
// eventos personalizados, solo comprobar si algo existe todavía.

const NEEDED = [
  "UI.Card", "UI.Btn", "UI.Toast", "UI.SectionTitle",
  "Screens.Login", "Screens.Home", "Screens.Calendar", "Screens.Prefs", "Screens.Generator", "Screens.Settings",
  "Screens.App",
];

function has(path) {
  return path.split(".").reduce((o, k) => (o ? o[k] : undefined), window) !== undefined;
}

let tries = 0;
const MAX_TRIES = 600; // ~10s a 60fps; de sobra para cargar ficheros locales o de Pages

function tryBoot() {
  tries++;
  const faltan = NEEDED.filter((p) => !has(p));
  if (faltan.length > 0) {
    if (tries > MAX_TRIES) {
      console.error("[boot] tiempo de espera agotado. Faltan por cargar:", faltan);
      document.getElementById("root").textContent = "Error cargando la aplicación (revisa la consola).";
      return;
    }
    requestAnimationFrame(tryBoot);
    return;
  }
  ReactDOM.render(React.createElement(window.Screens.App), document.getElementById("root"));
}
tryBoot();

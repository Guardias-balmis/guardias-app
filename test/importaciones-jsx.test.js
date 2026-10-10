// Puerta de las importaciones de los .jsx: cada nombre que un .jsx importa de un módulo de
// `client/lib` o `v2/domain` tiene que EXISTIR en ese módulo.
//
// Los .jsx no se pueden ejecutar en Node (loader.js los transpila en el navegador), así que nada
// en `npm test` los enlazaba con los módulos que importan. Y un nombre que falta no avisa al
// escribirlo ni al hacer el merge: el navegador lo descubre al ENLAZAR el módulo («does not provide
// an export named …») y esa pantalla —o la app entera, si es una de las que cargan siempre— no
// arranca. Es justo lo que pasa en un despliegue a medias (ver «Branch / deploy model» de CLAUDE.md):
// durante los ~10 minutos de caché de GitHub Pages una recarga puede traer un `.jsx` nuevo con un
// módulo viejo, o al revés. Esto no puede evitar la ventana, pero sí que un nombre mal escrito o
// borrado llegue a main: comprueba el estado FINAL del repo, y la regla de despliegue se encarga del orden.
//
// Es un análisis por expresión regular de `import { … } from "…"`, no un parser: cubre lo que escribe
// este repo (imports con nombre, a una o varias líneas, con `as`). Un import por defecto o de
// espacio de nombres (`* as x`) no se comprueba aquí: no hay ninguno en los .jsx y loader.js no los
// soporta (CLAUDE.md, «Client»).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const leer = (ruta) => readFileSync(RAIZ + ruta, "utf8");

const JSX_FILES = [...leer("client/loader.js").match(/const JSX_FILES = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// Los comentarios fuera, para que un `import { x } from "./y.js"` citado en uno no cuente.
const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const IMPORT_CON_NOMBRES = /\bimport\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Los nombres que un `import { a, b as c }` pide al módulo (el nombre EXPORTADO, no el local). */
function nombresPedidos(llaves) {
  return llaves.split(",").map((n) => n.trim()).filter(Boolean).map((n) => n.split(/\s+as\s+/)[0].trim());
}

test("los .jsx se leen y hay imports que comprobar (la puerta no está vacía)", () => {
  assert.ok(JSX_FILES.length >= 8, "JSX_FILES debería traer los .jsx de loader.js");
  const total = JSX_FILES.flatMap((f) => [...sinComentarios(leer(f)).matchAll(IMPORT_CON_NOMBRES)]).length;
  assert.ok(total >= 10, `solo se encontraron ${total} imports con nombre: la expresión regular ya no ve los de los .jsx`);
});

for (const jsx of JSX_FILES) {
  test(`${jsx}: todo lo que importa lo exporta el módulo`, async () => {
    for (const m of sinComentarios(leer(jsx)).matchAll(IMPORT_CON_NOMBRES)) {
      const [, llaves, especificador] = m;
      // Los .jsx importan desde la raíz del sitio (decisión C-1): "./client/lib/x.js" → <raíz>/client/lib/x.js
      const modulo = await import(pathToFileURL(RAIZ + especificador.replace(/^\.\//, "")).href);
      for (const nombre of nombresPedidos(llaves)) {
        assert.ok(nombre in modulo, `${jsx} importa «${nombre}» de ${especificador}, que no lo exporta`);
      }
    }
  });
}

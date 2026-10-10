// Puerta de la precarga de `index.html` (2026-10-07, punto 7 de client/loader.js).
//
// `index.html` pide de antemano, todos a la vez, los `.jsx` que descarga el cargador
// (`<link rel="preload" as="fetch">`) y los módulos que esos `.jsx` importan sin transpilar
// (`<link rel="modulepreload">`). Sin esas listas, volver a la app eran ocho idas y vueltas
// encadenadas antes de pintar Inicio: el navegador solo descubre los imports de un `.jsx` al
// importarlo, y los `.jsx` se importan en orden.
//
// Las listas están escritas a mano, así que se desfasan en cuanto alguien añade un módulo. No rompe
// nada —el módulo que falte se pide igual, solo que tarde—, que es justo por lo que nadie lo
// notaría: esto recorre el grafo de imports real y dice qué añadir o quitar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const leer = (ruta) => readFileSync(RAIZ + ruta, "utf8");
const indexHtml = leer("index.html");
const loader = leer("client/loader.js");

// Comentarios fuera, para que un import citado en un comentario no cuente. Lo de `//` solo cuando
// empieza un comentario (principio de línea o tras un espacio): así una URL «https://…» se queda.
const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const especificadores = (src) => [...sinComentarios(src).matchAll(IMPORT)].map((m) => m[1]);

const JSX_FILES = [...loader.match(/const JSX_FILES = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** El grafo de módulos nativos: los `.jsx` importan desde la raíz del sitio (decisión C-1); los `.js`, relativo a sí mismos. */
function grafoNativo() {
  const pendientes = [
    ...JSX_FILES.flatMap((f) => especificadores(leer(f)).map((e) => posix.normalize(e))),
    ...especificadores(loader).map((e) => posix.join("client", e)),
  ];
  const vistos = new Set();
  while (pendientes.length) {
    const ruta = pendientes.shift();
    if (vistos.has(ruta)) continue;
    assert.ok(existsSync(RAIZ + ruta), `un import apunta a ${ruta}, que no existe`);
    vistos.add(ruta);
    for (const e of especificadores(leer(ruta))) pendientes.push(posix.join(posix.dirname(ruta), e));
  }
  return vistos;
}

const enlaces = (rel) => [...indexHtml.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
  .filter((tag) => new RegExp(`\\brel="${rel}"`).test(tag));
const href = (tag) => tag.match(/\bhref="([^"]+)"/)[1];

function mismoConjunto(listado, esperado, que) {
  const l = new Set(listado);
  const faltan = [...esperado].filter((x) => !l.has(x)).sort();
  const sobran = [...l].filter((x) => !esperado.has(x)).sort();
  assert.deepEqual({ faltan, sobran }, { faltan: [], sobran: [] }, `index.html: ${que}`);
  assert.equal(listado.length, l.size, `index.html: ${que} — hay alguno repetido`);
}

test("modulepreload: exactamente los módulos que importan los .jsx (y el cargador), sin transpilar", () => {
  const grafo = grafoNativo();
  assert.ok(grafo.has("client/lib/api.js") && grafo.has("v2/domain/validate.js"), "el recorrido del grafo no ha encontrado ni lo obvio");
  mismoConjunto(enlaces("modulepreload").map(href), grafo, '<link rel="modulepreload" href="…"> por cada módulo nativo');
});

test("preload as=fetch: exactamente los JSX_FILES del cargador, con crossorigin para que el fetch reutilice la precarga", () => {
  const tags = enlaces("preload").filter((t) => /\bas="fetch"/.test(t));
  mismoConjunto(tags.map(href), new Set(JSX_FILES), '<link rel="preload" as="fetch" crossorigin href="…"> por cada JSX_FILES');
  // Sin `crossorigin` la precarga va con otras credenciales que el `fetch(path)` del cargador, el
  // navegador no la reconoce como la misma petición y cada .jsx se descarga dos veces.
  for (const t of tags) assert.match(t, /\bcrossorigin\b/, `falta crossorigin en ${t}`);
});

/** El contenido de `<div id="root">`, hasta SU cierre (contando los `<div>` anidados). */
function contenidoDeRoot() {
  const inicio = indexHtml.indexOf('<div id="root">');
  assert.ok(inicio >= 0, 'index.html no tiene <div id="root">');
  const etiquetas = /<div\b|<\/div>/g;
  etiquetas.lastIndex = inicio;
  let abiertos = 0;
  for (let m; (m = etiquetas.exec(indexHtml));) {
    abiertos += m[0] === "</div>" ? -1 : 1;
    if (abiertos === 0) return indexHtml.slice(inicio, m.index);
  }
  assert.fail("el <div id=\"root\"> de index.html no se cierra");
}

test("la pantalla de arranque está dentro de #root y tiene el texto que el cargador cambia", () => {
  // Dentro, porque es lo que sustituye el primer render de React; fuera se quedaría debajo de la app.
  assert.match(contenidoDeRoot(), /id="gapp-arranque-texto"/);
  assert.match(loader, /getElementById\("gapp-arranque-texto"\)/);
});

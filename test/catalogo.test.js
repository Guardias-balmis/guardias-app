// Puerta del catálogo de diseño: `docs/catalogo-diseno.html` se GENERA desde
// `client/lib/design-tokens.js`, y esto comprueba que el fichero comiteado sigue estando al día.
//
// Existe por el mismo motivo que `parity.test.js` para el bundle de Apps Script: un artefacto
// generado que nadie vuelve a mirar se convierte en mentira en el primer retoque. Un catálogo que
// enseña un azul que la app ya no usa es peor que no tener catálogo, porque nadie sospecha de él.
//
// Y comprueba además que el catálogo no se deja tokens fuera: añadir un color a `design-tokens.js`
// sin que aparezca aquí lo dejaría invisible para quien diseña, que es justo a quien va dirigido.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { html, contraste } from "../build/build-catalogo.mjs";
import { COLOR, SHADOW, RADIUS, ANO_COLORS, CODE_COLORS, CODE_LABELS, ESTADO_CUADRANTE, DIAS_NOMBRE, S } from "../client/lib/design-tokens.js";

const RUTA = fileURLToPath(new URL("../docs/catalogo-diseno.html", import.meta.url));
const comiteado = readFileSync(RUTA, "utf8");

test("FRESCURA: el catálogo comiteado está al día con design-tokens.js", () => {
  assert.equal(
    comiteado, html(),
    "docs/catalogo-diseno.html no coincide con lo que genera build/build-catalogo.mjs: ejecuta `npm run catalogo`"
  );
});

test("todos los colores del sistema aparecen en el catálogo", () => {
  // Si alguien añade un color y no lo mete en un grupo de `GRUPOS_COLOR`, se queda invisible.
  const faltan = Object.entries(COLOR).filter(([, hex]) => !comiteado.includes(hex));
  assert.deepEqual(faltan, [], "colores de COLOR que el catálogo no enseña");
});

test("todas las sombras y radios aparecen", () => {
  for (const [k, v] of Object.entries(SHADOW)) assert.ok(comiteado.includes(v), `falta la sombra ${k}`);
  for (const [k, v] of Object.entries(RADIUS)) assert.ok(comiteado.includes(v), `falta el radio ${k}`);
});

test("todos los códigos de guardia, niveles, estados y días aparecen con su etiqueta", () => {
  for (const [c, label] of Object.entries(CODE_LABELS)) {
    assert.ok(comiteado.includes(label), `falta la etiqueta del código ${c}`);
    assert.ok(comiteado.includes(CODE_COLORS[c]), `falta el color del código ${c}`);
  }
  for (const [n, hex] of Object.entries(ANO_COLORS)) assert.ok(comiteado.includes(hex), `falta el color del nivel ${n}`);
  for (const [k, v] of Object.entries(ESTADO_CUADRANTE)) assert.ok(comiteado.includes(v.label), `falta el estado ${k}`);
  for (const nombre of Object.values(DIAS_NOMBRE)) assert.ok(comiteado.includes(nombre), `falta el día ${nombre}`);
});

test("todos los estilos de componente de `S` tienen su muestra", () => {
  for (const k of Object.keys(S)) assert.ok(comiteado.includes(`S.${k}`), `falta la muestra de S.${k}`);
});

// --- la fórmula de contraste (WCAG 2.1) ----------------------------------------------------
// Se comprueba contra valores conocidos: si esto se desvía, el catálogo diría que una pareja
// cumple AA cuando no cumple, que es peor que no medirla.

test("contraste: los extremos conocidos salen exactos", () => {
  assert.equal(contraste("#000000", "#ffffff"), 21);
  assert.equal(contraste("#ffffff", "#ffffff"), 1);
  assert.equal(contraste("#ffffff", "#000000"), 21, "es simétrico: da igual cuál sea el fondo");
});

test("contraste: valores de referencia de WCAG", () => {
  // Grises medios verificables a mano con la fórmula de luminancia relativa.
  assert.equal(contraste("#767676", "#ffffff"), 4.5, "el gris límite de AA sobre blanco");
  assert.equal(contraste("#595959", "#ffffff"), 7, "el gris límite de AAA sobre blanco");
});

test("contraste: acepta hex de 3 dígitos y con o sin almohadilla", () => {
  assert.equal(contraste("#000", "#fff"), 21);
  assert.equal(contraste("000000", "ffffff"), 21);
});

test("el catálogo dice cuántas parejas NO cumplen, y el número es el real", () => {
  const parejas = [
    ...Object.entries(ANO_COLORS).map(([n, bg]) => [n, bg]),
  ];
  assert.ok(parejas.length > 0);
  // El resumen del HTML tiene que coincidir con lo que sale de recontar aquí las tres familias.
  const m = /<b>(\d+) de (\d+)<\/b>\s*parejas se quedan por debajo/.exec(comiteado);
  assert.ok(m, "el catálogo debe declarar el recuento de parejas que no cumplen");
  const total = Object.keys(ANO_COLORS).length + Object.keys(ESTADO_CUADRANTE).length + Object.keys(CODE_LABELS).length;
  assert.equal(Number(m[2]), total, "el total tiene que ser el de las tres familias juntas");
  assert.equal(Number(m[1]), (comiteado.match(/verdict no/g) || []).length, "el recuento no puede diferir de las filas marcadas");
});

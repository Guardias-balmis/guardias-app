// Genera `docs/catalogo-diseno.html` DESDE `client/lib/design-tokens.js`.
//
// Existe porque un catálogo copiado a mano deja de ser cierto en el primer retoque y nadie se
// entera: enseñaría un azul que la app ya no usa. Aquí el único origen es el módulo de tokens —
// se importa, no se transcribe — y `test/catalogo.test.js` falla si el HTML comiteado no está al
// día, igual que `parity.test.js` hace con el bundle de Apps Script.
//
// Regenerar: `npm run catalogo`.
//
// Lo que el catálogo aporta además de la lista: comprueba el CONTRASTE de las tres parejas
// fondo/texto que la app usa de verdad (nivel de residencia, estado del cuadrante y código de
// guardia), con la fórmula de WCAG 2.1. Eso no se puede leer mirando los hex sueltos, y es lo que
// convierte la página en algo que sirve para revisar el diseño y no solo para admirarlo.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COLOR, RADIUS, SHADOW, ANO_COLORS, ANO_TEXT, ANOS,
  CODE_COLORS, CODE_LABELS, CODES_CYCLE, ESTADO_CUADRANTE, DIAS_SEMANA, DIAS_NOMBRE, S, pillBtn,
} from "../client/lib/design-tokens.js";

const OUT = fileURLToPath(new URL("../docs/catalogo-diseno.html", import.meta.url));

// ── contraste WCAG 2.1 ─────────────────────────────────────────────────────────────────────
const canal = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
function luminancia(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}
/** Ratio 1..21 entre dos colores, redondeado a una decimal. */
export function contraste(fg, bg) {
  const [a, b] = [luminancia(fg), luminancia(bg)].sort((x, y) => y - x);
  return Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Objeto de estilos de React → cadena CSS (camelCase → kebab, números → px donde toca). */
const SIN_PX = new Set(["fontWeight", "flex", "opacity", "zIndex", "lineHeight", "letterSpacing"]);
function css(obj) {
  return Object.entries(obj)
    .map(([k, v]) => {
      const prop = k.replace(/^Webkit/, "-webkit-").replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${prop}:${typeof v === "number" && !SIN_PX.has(k) ? `${v}px` : v}`;
    })
    .join(";");
}

// ── piezas ─────────────────────────────────────────────────────────────────────────────────
/** Los grupos del fichero de tokens, para que el catálogo se lea en el mismo orden que la fuente. */
const GRUPOS_COLOR = [
  ["Azules", ["blueDark", "blue", "blueLight", "bluePale"], "La identidad. `blueDark` es la cabecera y el texto de titular; `bluePale`, el fondo de todo lo seleccionable."],
  ["Verdes", ["green", "greenMid", "greenLight"], "Validar y publicar: lo que ha salido bien."],
  ["Naranjas y rojos", ["orange", "orangeLight", "red", "redLight"], "Aviso y error. Ojo: `redLight` y `orangeLight` son el MISMO hex, así que el fondo no distingue una baja de unas vacaciones — la distinción real es el borde."],
  ["Amarillos", ["yellow", "yellowLight"], "Vacaciones en la rejilla."],
  ["Grises y base", ["gray", "grayMid", "grayDark", "bodyBg", "bodyText"], "El suelo de la interfaz. `bodyBg` es el fondo de la app; `grayDark`, todo el texto secundario."],
  ["Rejilla", ["scrollThumb", "cellBorder", "cellText"], "Solo la tabla del cuadrante."],
];

function swatch(nombre, hex) {
  return `<figure class="sw">
  <div class="sw-color" style="background:${esc(hex)}"></div>
  <figcaption><span class="sw-name">${esc(nombre)}</span><code>${esc(hex)}</code></figcaption>
</figure>`;
}

function filaContraste({ etiqueta, muestra, fg, bg, minimo = 4.5 }) {
  const r = contraste(fg, bg);
  const ok = r >= minimo;
  return `<tr>
  <th scope="row">${esc(etiqueta)}</th>
  <td><span class="chip" style="background:${esc(bg)};color:${esc(fg)}">${esc(muestra)}</span></td>
  <td><code>${esc(fg)}</code> sobre <code>${esc(bg)}</code></td>
  <td class="num">${r}:1</td>
  <td><span class="verdict ${ok ? "ok" : "no"}">${ok ? "cumple AA" : `bajo (AA pide ${minimo})`}</span></td>
</tr>`;
}

function seccionContrastes() {
  const filas = [
    ...ANOS.map((n) => filaContraste({ etiqueta: `Nivel ${n}`, muestra: n, fg: ANO_TEXT[n], bg: ANO_COLORS[n] })),
    ...Object.entries(ESTADO_CUADRANTE).map(([k, v]) => filaContraste({ etiqueta: `Estado ${k}`, muestra: v.label, fg: v.color, bg: v.bg })),
    ...Object.keys(CODE_LABELS).map((c) => filaContraste({ etiqueta: `Código ${c}`, muestra: c, fg: COLOR.cellText, bg: CODE_COLORS[c] })),
  ];
  const fallos = filas.filter((f) => f.includes("verdict no")).length;
  return { filas: filas.join("\n"), fallos, total: filas.length };
}

// ── documento ──────────────────────────────────────────────────────────────────────────────
function render() {
  const { filas, fallos, total } = seccionContrastes();

  const colores = GRUPOS_COLOR.map(([titulo, claves, nota]) => `
<section class="grupo">
  <h3>${esc(titulo)}</h3>
  <p class="nota">${nota.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`)}</p>
  <div class="swatches">${claves.map((k) => swatch(k, COLOR[k])).join("")}</div>
</section>`).join("");

  const sombras = Object.entries(SHADOW).map(([k, v]) => `
<figure class="sombra">
  <div class="sombra-caja" style="box-shadow:${esc(v)};border-radius:${esc(RADIUS.md)}"></div>
  <figcaption><span class="sw-name">${esc(k)}</span><code>${esc(v)}</code></figcaption>
</figure>`).join("");

  const componentes = [
    ["S.input", `<input value="Texto de ejemplo" style="${esc(css(S.input))}">`],
    ["S.label", `<span style="${esc(css(S.label))}">Etiqueta de campo</span>`],
    ["S.smallBtn", `<button style="${esc(css({ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }))}">Acción</button>`],
    ["S.dayToggleBtn", `<button style="${esc(css({ ...S.dayToggleBtn, background: COLOR.orange, color: "#fff", border: "none" }))}">14</button>`],
    ["S.counterBtn", `<button style="${esc(css(S.counterBtn))}">+</button>`],
    ["S.navBtn", `<button style="${esc(css(S.navBtn))}">▶</button>`],
    ["S.iconBtn", `<span style="${esc(css({ ...S.iconBtn, background: COLOR.blueDark }))}">⚙️</span>`],
    ["pillBtn(color)", `<button style="${esc(css(pillBtn(COLOR.greenMid)))}">Publicar</button>`],
  ].map(([nombre, html]) => `
<div class="comp">
  <div class="comp-demo">${html}</div>
  <code class="comp-name">${esc(nombre)}</code>
</div>`).join("");

  // `S.th` y `S.td` no se enseñan sueltos: solos no son nada. La rejilla del cuadrante es el
  // componente más reconocible de la app, y es donde esos dos estilos significan algo.
  const rejilla = `
<table class="rejilla">
  <thead><tr>
    <th style="${esc(css({ ...S.th, background: COLOR.gray, color: COLOR.blueDark, fontSize: 11 }))}">Nivel</th>
    <th style="${esc(css({ ...S.th, background: COLOR.gray, color: COLOR.blueDark, fontSize: 11 }))}">Nombre</th>
    ${[1, 2, 3, 4].map((d) => `<th style="${esc(css({ ...S.th, background: COLOR.gray, color: COLOR.blueDark, fontSize: 11 }))}">${d}</th>`).join("")}
  </tr></thead>
  <tbody><tr>
    <td style="${esc(css({ ...S.td, background: ANO_COLORS.R3, color: ANO_TEXT.R3, textAlign: "center", fontWeight: 700, fontSize: 12 }))}">R3</td>
    <td style="${esc(css({ ...S.td, fontSize: 12, color: COLOR.cellText, padding: "3px 8px" }))}">Carlos</td>
    ${["G", "", "GF", "3P"].map((c) => `<td style="${esc(css({ ...S.td, background: CODE_COLORS[c] || "transparent", color: COLOR.cellText, textAlign: "center", fontWeight: c ? 700 : 400, fontSize: 12 }))}">${c || "·"}</td>`).join("")}
  </tr></tbody>
</table>`;

  const codigos = Object.keys(CODE_LABELS).map((c) => `
<div class="codigo">
  <span class="codigo-celda" style="background:${esc(CODE_COLORS[c])};color:${esc(COLOR.cellText)}">${esc(c)}</span>
  <div><b>${esc(CODE_LABELS[c])}</b><br><code>${esc(CODE_COLORS[c])}</code></div>
</div>`).join("");

  return `<title>Catálogo de diseño · Guardias Dr. Balmis</title>
<style>
:root{
  --ground:${COLOR.bodyBg}; --surface:#fff; --ink:${COLOR.bodyText}; --muted:${COLOR.grayDark};
  --line:${COLOR.grayMid}; --accent:${COLOR.blueDark}; --accent-soft:${COLOR.bluePale};
  --shadow:${SHADOW.card}; --radius:${RADIUS.md}; --radius-sm:${RADIUS.sm};
  --ok:#1B7F4B; --no:${COLOR.red}; --ok-bg:#E4F3EA; --no-bg:${COLOR.redLight};
}
/* El tema oscuro es del CATÁLOGO, no de la app (que es de un solo tema): los grises van sesgados
   hacia el azul del sistema para que no se lean como un gris cualquiera. Las MUESTRAS nunca se
   adaptan — un swatch que cambia de color con el tema deja de ser una muestra. */
@media (prefers-color-scheme: dark){
  :root{
    --ground:#0F1A24; --surface:#17242F; --ink:#E6EDF4; --muted:#93A4B5;
    --line:#263847; --accent:#7FB3DC; --accent-soft:#1B2E3E;
    --shadow:0 2px 12px rgba(0,0,0,.45);
    --ok:#5FCB92; --no:#FF8A80; --ok-bg:#12312150; --no-bg:#3A181850;
  }
}
:root[data-theme="dark"]{
  --ground:#0F1A24; --surface:#17242F; --ink:#E6EDF4; --muted:#93A4B5;
  --line:#263847; --accent:#7FB3DC; --accent-soft:#1B2E3E;
  --shadow:0 2px 12px rgba(0,0,0,.45);
  --ok:#5FCB92; --no:#FF8A80; --ok-bg:#12312150; --no-bg:#3A181850;
}
:root[data-theme="light"]{
  --ground:${COLOR.bodyBg}; --surface:#fff; --ink:${COLOR.bodyText}; --muted:${COLOR.grayDark};
  --line:${COLOR.grayMid}; --accent:${COLOR.blueDark}; --accent-soft:${COLOR.bluePale};
  --shadow:${SHADOW.card};
  --ok:#1B7F4B; --no:${COLOR.red}; --ok-bg:#E4F3EA; --no-bg:${COLOR.redLight};
}

/* La misma pila de fuentes que index.html: el catálogo tiene que verse con la tipografía real. */
body{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  line-height:1.55; -webkit-font-smoothing:antialiased;
}
code,.num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:940px;margin:0 auto;padding:40px 20px 80px;display:flex;flex-direction:column;gap:44px}

header h1{font-size:clamp(26px,4.5vw,38px);line-height:1.15;margin:0 0 6px;letter-spacing:-.02em;text-wrap:balance}
header .sub{color:var(--muted);max-width:62ch;margin:0}
.origen{
  margin-top:18px;padding:12px 14px;border-radius:var(--radius-sm);
  background:var(--accent-soft);border-left:4px solid var(--accent);
  font-size:13.5px;color:var(--ink);max-width:70ch;
}
.origen code{font-size:12.5px}

h2{
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
  color:var(--muted);margin:0 0 16px;padding-bottom:8px;border-bottom:1px solid var(--line);
}
h3{font-size:15px;margin:0 0 4px}
.nota{font-size:13px;color:var(--muted);margin:0 0 12px;max-width:68ch}
.grupo{margin-bottom:26px}
.grupo:last-child{margin-bottom:0}

.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px}
.sw{margin:0}
.sw-color{height:56px;border-radius:var(--radius-sm);border:1px solid var(--line)}
.sw figcaption{display:flex;flex-direction:column;gap:1px;margin-top:6px;font-size:12px}
.sw-name{font-weight:600}
.sw code,.sombra code{color:var(--muted);font-size:11.5px}

.tabla-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:520px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:700}
tbody th{font-weight:600;white-space:nowrap}
td.num{text-align:right;white-space:nowrap}
.chip{display:inline-block;padding:3px 10px;border-radius:var(--radius-sm);font-weight:700;font-size:12px;white-space:nowrap}
.verdict{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
.verdict.ok{color:var(--ok);background:var(--ok-bg)}
.verdict.no{color:var(--no);background:var(--no-bg)}
.resumen{margin:0 0 14px;font-size:13.5px;color:var(--muted);max-width:70ch}

.sombras{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px}
.sombra{margin:0}
.sombra-caja{height:60px;background:var(--surface);border:1px solid var(--line)}
.sombra figcaption{margin-top:10px;font-size:12px;display:flex;flex-direction:column;gap:1px;word-break:break-all}

.comps{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.comp{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.comp-demo{display:flex;align-items:center;min-height:40px}
.comp-name{font-size:12px;color:var(--muted)}

.codigos{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.codigo{display:flex;align-items:center;gap:10px;font-size:12.5px}
.codigo-celda{width:42px;flex:0 0 42px;text-align:center;padding:6px 0;border-radius:var(--radius-sm);border:1px solid var(--line);font-weight:700}
.codigo code{color:var(--muted);font-size:11.5px}

.rejilla{border-collapse:collapse;min-width:0;width:auto;background:var(--surface)}
.rejilla th,.rejilla td{border-bottom:0}
.pills{display:flex;flex-wrap:wrap;gap:8px}
.dia{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 12px;font-size:13px}
.dia b{color:var(--accent)}

footer{color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:18px;max-width:70ch}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<div class="wrap">
  <header>
    <h1>Catálogo de diseño</h1>
    <p class="sub">Los tokens visuales de <b>Guardias · Dr. Balmis</b>: colores, sombras, radios y estilos de componente tal y como los usa la aplicación.</p>
    <div class="origen">
      <b>Esta página se genera, no se escribe.</b> Su única fuente es
      <code>client/lib/design-tokens.js</code>; la produce <code>build/build-catalogo.mjs</code>
      (<code>npm run catalogo</code>) y un test de la suite falla si deja de estar al día. Si algo
      de aquí no te cuadra, el sitio donde cambiarlo es el módulo de tokens: cámbialo ahí y esta
      página lo reflejará sola.
    </div>
  </header>

  <section>
    <h2>Color</h2>
    ${colores}
  </section>

  <section>
    <h2>Contraste de las parejas que la app usa</h2>
    <p class="resumen">
      No son combinaciones inventadas para el catálogo: son las tres que la interfaz pinta de
      verdad — la insignia de nivel, el estado del cuadrante y la celda de la rejilla. Se mide con
      la fórmula de WCAG 2.1 contra el mínimo AA de texto normal (4,5:1); todos estos textos van
      en negrita y por debajo de 14px, así que no les vale el umbral de texto grande.
      <b>${fallos} de ${total}</b> parejas se quedan por debajo.
    </p>
    <div class="tabla-wrap">
      <table>
        <thead><tr><th scope="col">Uso</th><th scope="col">Cómo se ve</th><th scope="col">Texto / fondo</th><th scope="col">Ratio</th><th scope="col">AA</th></tr></thead>
        <tbody>
${filas}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Códigos de guardia</h2>
    <p class="nota">El vocabulario del servicio. No se traducen ni se renombran nunca: son los mismos en la interfaz, en el dominio y en la hoja de cálculo.</p>
    <div class="codigos">${codigos}</div>
    <p class="nota" style="margin-top:14px">Orden del ciclo al tocar una celda: ${CODES_CYCLE.map((c) => `<code>${c || "(vacío)"}</code>`).join(" → ")}</p>
  </section>

  <section>
    <h2>Nivel de residencia</h2>
    <p class="nota">Más oscuro, más veterano. El nivel nunca se almacena: se deriva de las fechas de cada residente.</p>
    <div class="pills">
      ${ANOS.map((n) => `<span class="chip" style="background:${ANO_COLORS[n]};color:${ANO_TEXT[n]};padding:6px 14px">${n}</span>`).join("")}
    </div>
  </section>

  <section>
    <h2>Estado del cuadrante</h2>
    <p class="nota">Un solo mapa por estado (color, fondo y etiqueta juntos), para que no puedan desincronizarse entre sí.</p>
    <div class="pills">
      ${Object.entries(ESTADO_CUADRANTE).map(([k, v]) => `<span class="chip" style="background:${v.bg};color:${v.color};padding:6px 14px" title="${esc(k)}">${esc(v.label)}</span>`).join("")}
    </div>
  </section>

  <section>
    <h2>Elevación y radios</h2>
    <p class="nota">Radios: <code>md ${RADIUS.md}</code> para tarjetas, <code>sm ${RADIUS.sm}</code> para controles.</p>
    <div class="sombras">${sombras}</div>
  </section>

  <section>
    <h2>Estilos de componente</h2>
    <p class="nota">Elementos reales con los estilos de <code>S</code> aplicados: lo que se ve aquí es exactamente lo que renderiza la app.</p>
    <div class="comps">${componentes}</div>

    <h3 style="margin-top:28px">La rejilla del cuadrante</h3>
    <p class="nota"><code>S.th</code> y <code>S.td</code> solos no son nada: aquí están donde significan algo, con el color de nivel y los de código encima.</p>
    <div class="tabla-wrap">${rejilla}</div>
  </section>

  <section>
    <h2>Días de la semana</h2>
    <p class="nota">Notación del servicio, la misma del Excel de referencia.</p>
    <div class="pills">
      ${DIAS_SEMANA.map((d) => `<span class="dia"><b>${d}</b> · ${DIAS_NOMBRE[d]}</span>`).join("")}
    </div>
  </section>

  <footer>
    Generado desde <code>client/lib/design-tokens.js</code>. Para cambiar cualquier valor, edita ese
    módulo y ejecuta <code>npm run catalogo</code>.
  </footer>
</div>
`;
}

export const html = render;

// Ejecutado directamente (`npm run catalogo`): escribe el fichero.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  fs.writeFileSync(OUT, render(), "utf8");
  console.log(`[catalogo] escrito ${OUT} (${fs.statSync(OUT).size} bytes)`);
}

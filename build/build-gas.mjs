// build-gas.mjs · Bundler mínimo del núcleo de dominio para Google Apps Script (ADR-002 D-4).
//
// Apps Script no soporta módulos ES: concatena todos los .gs en un ámbito global único. La
// fuente ESM de `v2/domain/*.js` es la ÚNICA fuente de verdad (la consumen el navegador y
// node:test sin build). Este bundler produce UN solo `server/domain.gs` envolviendo cada
// módulo en un IIFE (preserva su ámbito privado → sin colisiones) y exponiendo la API
// pública en un global `Domain`.
//
// Filosofía de durabilidad (requisito rector): cero dependencias (solo `node:fs`), y el
// bundle es un ARTEFACTO comiteado — si este bundler se pierde en el año 6, el último
// `domain.gs` sigue corriendo. El test de paridad (parity.test.js) garantiza que el bundle
// nunca diverge de la fuente. **El bundler FALLA RUIDOSAMENTE** ante cualquier sintaxis que
// no sepa transformar: un bundler que ignora en silencio reintroduce el fallo que evita.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Orden topológico: cada módulo se define después de sus dependencias.
// Orden topológico: un módulo solo puede importar de los anteriores (cada uno se envuelve en
// su propia IIFE y las lee del global ya creado). `accumulate` entra en el bundle desde P-8:
// el cierre anual de equidad (INV-3) se comprueba también en el servidor, y su ensamblado
// (`equity.buildYearCloseContext`) necesita el contaje acumulado.
// El orden importa: el bundler concatena IIFEs y cada módulo lee los anteriores por su
// global, así que un módulo va SIEMPRE después de aquellos de los que importa.
export const DOMAIN_MODULES = ["calendar", "apply", "residents", "tally", "absences", "blockPreview", "imaginaria", "accumulate", "thirdpost", "equity", "validate", "responsible", "cuadrante", "projection", "schedule"];
export const SERVER_MODULES = ["sheets-schema", "sheets-store", "session", "verify-token", "ai-prompt", "ai-generator", "router"];

const DOMAIN_DIR = fileURLToPath(new URL("../v2/domain/", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../server/src/", import.meta.url));
// Nombre de variable a partir del basename del módulo: "sheets-schema" → "SheetsSchema".
const cap = (s) => s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w-]+)\.js["'];?\s*$/;
const EXPORT_DECL_RE = /^(\s*)export\s+(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/;

/** Transforma un módulo ESM en `var Nombre = (function(){ ... return {exports}; })();`. */
export function transformModule(name, src) {
  const varName = cap(name);
  const exports = [];
  const body = [];
  // Sentencia `export const/var` que sigue abierta en las líneas siguientes (un literal de objeto o
  // una llamada multilínea): se sigue buscando la coma de nivel cero hasta que se cierre.
  let abierta = null;

  for (const line of src.split("\n")) {
    const t = line.trimStart();

    if (abierta) {
      if (abierta.dentro()) { // paréntesis/llave o cadena sin cerrar: la línea es parte de la sentencia
        const r = abierta.alimenta(line);
        if (r === "coma") fail(name, abierta.linea, "una sola declaración por `export const`: la segunda declaración (`, B = …`) de esta sentencia no se exportaría");
        if (r === "fin") abierta = null;
        body.push(line);
        continue;
      }
      // A nivel cero y sin `;`: solo una línea que EMPIECE por coma continúa la declaración.
      if (t.startsWith(",")) fail(name, abierta.linea, "una sola declaración por `export const`: la segunda declaración (`, B = …`) de esta sentencia no se exportaría");
      abierta = null; // la sentencia terminó sin `;`; esta línea se procesa como cualquier otra
    }

    // Límite de palabra: una línea de texto que empiece por «importante…» o «exportar…» (plausible
    // dentro de un template literal de ai-prompt.js) no es una sentencia.
    if (/^import\b/.test(t)) {
      const m = IMPORT_RE.exec(t);
      if (!m) fail(name, line, "solo se admite `import { a, b } from \"./modulo.js\"`");
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.some((n) => / as /.test(n))) fail(name, line, "los alias `as` no están soportados");
      body.push(`  const { ${names.join(", ")} } = ${cap(m[2])};`);
      continue;
    }

    if (/^export\b/.test(t)) {
      const em = EXPORT_DECL_RE.exec(line);
      if (!em) fail(name, line, "solo se admite `export function/const NOMBRE` (no default, no re-export, no `export {}`)");
      // Dos construcciones ESM válidas que este transformador convertía MAL y en silencio (2026-09-04):
      // `export let n` — el IIFE devuelve el VALOR en el momento del `return`, así que una
      // reasignación posterior la vería el ESM y no el bundle; y `export const A = 1, B = 2` —
      // la regex captura un solo nombre y B desaparecía del global sin ningún error (un
      // «Domain.B is not a function» solo en producción). La filosofía del bundler es fallar
      // ruidosamente ante lo que no sabe transformar: ahora lo hace.
      if (em[2] === "let") fail(name, line, "`export let` no está soportado: el bundle devolvería el valor inicial aunque el módulo lo reasigne (usa `const`, o una función que lo lea)");
      if (em[2] === "const" || em[2] === "var") {
        const escaner = escanerDeSentencia(line);
        const r = escaner.alimenta(line.slice(em[0].length));
        if (r === "coma") fail(name, line, "una sola declaración por `export const`: con `export const A = 1, B = 2` el bundle solo exportaría A");
        if (r !== "fin") abierta = escaner; // sin `;` todavía: la sentencia puede continuar en las líneas siguientes
      }
      exports.push(em[3]);
      body.push(line.replace(/^(\s*)export\s+/, "$1")); // quita el keyword export, conserva la declaración
      continue;
    }

    if (/\bimport\s*\(/.test(line)) fail(name, line, "el import() dinámico no está soportado");
    body.push(line);
  }

  if (exports.length === 0) fail(name, "", "el módulo no exporta nada");
  return `// ── ${name}.js ──\nvar ${varName} = (function () {\n${body.join("\n")}\n  return { ${exports.join(", ")} };\n})();`;
}

/**
 * Escáner de UNA sentencia `export const NOMBRE = …` que puede ocupar varias líneas. `alimenta(texto)`
 * devuelve "coma" si aparece una coma fuera de todo paréntesis/corchete/llave y de toda cadena —la
 * firma de una segunda declaración en la misma sentencia, que el bundle perdería en silencio—, "fin"
 * si la sentencia se cerró (un `;` a nivel cero) y "sigue" si puede continuar en la línea siguiente
 * (`dentro()` dice si es seguro que continúa: hay un paréntesis, llave o cadena sin cerrar). Un
 * literal de regex con coma daría un falso positivo — que fallaría ALTO en el build, no en silencio,
 * y no hay ninguno exportado hoy. Las cadenas (incluidos template literals) sobreviven entre líneas.
 */
function escanerDeSentencia(linea) {
  let depth = 0;
  let cadena = null;
  return {
    linea,
    dentro: () => cadena !== null || depth > 0,
    alimenta(texto) {
      for (let i = 0; i < texto.length; i++) {
        const ch = texto[i];
        if (cadena) {
          if (ch === "\\") i++;
          else if (ch === cadena) cadena = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") cadena = ch;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "/" && texto[i + 1] === "/") break; // comentario de línea: lo que sigue no cuenta
        else if (ch === "," && depth === 0) return "coma";
        else if (ch === ";" && depth === 0) return "fin";
      }
      return "sigue";
    },
  };
}

function fail(module, line, reason) {
  throw new Error(`[build-gas] ${module}.js: ${reason}` + (line ? `\n  → ${line.trim()}` : ""));
}

/** Construye un bundle (string) a partir de una lista de módulos. Puro: no toca disco. */
function bundle({ dir, modules, globalName, artifact, source }) {
  const header = [
    "/**",
    ` * ${artifact} · guardias-app para Google Apps Script.`,
    ` * ARTEFACTO GENERADO por build/build-gas.mjs desde ${source} — NO EDITAR A MANO.`,
    " * Regenerar: `npm run build`. La paridad con la fuente ESM la verifica parity.test.js.",
    " */",
    "",
  ].join("\n");
  const blocks = modules.map((m) => transformModule(m, fs.readFileSync(dir + m + ".js", "utf8")));
  // API pública: se aplanan los exports de todos los módulos (no colisionan entre sí).
  const footer = `// ── API pública ──\nvar ${globalName} = Object.assign({}, ${modules.map(cap).join(", ")});`;
  return [header, ...blocks, footer].join("\n\n") + "\n";
}

/** Bundle del núcleo de dominio → global `Domain`. */
export function buildBundle() {
  return bundle({ dir: DOMAIN_DIR, modules: DOMAIN_MODULES, globalName: "Domain", artifact: "domain.gs", source: "v2/domain/*.js" });
}

/** Bundle de la lógica de servidor pura (auth/sesión/store/router) → global `Server`. */
export function buildServerBundle() {
  return bundle({ dir: SERVER_DIR, modules: SERVER_MODULES, globalName: "Server", artifact: "server-lib.gs", source: "server/src/*.js" });
}

// Ejecutado directamente (`node build/build-gas.mjs`): escribe los artefactos.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const outDir = fileURLToPath(new URL("../server/", import.meta.url));
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, build] of [["domain.gs", buildBundle], ["server-lib.gs", buildServerBundle]]) {
    fs.writeFileSync(outDir + file, build());
    console.log(`[build-gas] escrito ${outDir}${file} (${build().length} bytes)`);
  }
}

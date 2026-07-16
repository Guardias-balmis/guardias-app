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
const MODULES = ["calendar", "residents", "tally", "thirdpost", "equity", "validate"];

const DOMAIN_DIR = fileURLToPath(new URL("../v2/domain/", import.meta.url));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w-]+)\.js["'];?\s*$/;
const EXPORT_DECL_RE = /^(\s*)export\s+(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/;

/** Transforma un módulo ESM en `var Nombre = (function(){ ... return {exports}; })();`. */
export function transformModule(name, src) {
  const varName = cap(name);
  const exports = [];
  const body = [];

  for (const line of src.split("\n")) {
    const t = line.trimStart();

    if (t.startsWith("import")) {
      const m = IMPORT_RE.exec(t);
      if (!m) fail(name, line, "solo se admite `import { a, b } from \"./modulo.js\"`");
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.some((n) => / as /.test(n))) fail(name, line, "los alias `as` no están soportados");
      body.push(`  const { ${names.join(", ")} } = ${cap(m[2])};`);
      continue;
    }

    if (t.startsWith("export")) {
      const em = EXPORT_DECL_RE.exec(line);
      if (!em) fail(name, line, "solo se admite `export function/const NOMBRE` (no default, no re-export, no `export {}`)");
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

function fail(module, line, reason) {
  throw new Error(`[build-gas] ${module}.js: ${reason}` + (line ? `\n  → ${line.trim()}` : ""));
}

/** Construye el bundle completo (string). Puro: no toca disco. */
export function buildBundle() {
  const header = [
    "/**",
    " * domain.gs · Núcleo de dominio de guardias-app para Google Apps Script.",
    " * ARTEFACTO GENERADO por build/build-gas.mjs desde v2/domain/*.js — NO EDITAR A MANO.",
    " * Regenerar: `npm run build`. La paridad con la fuente ESM la verifica parity.test.js.",
    " */",
    "",
  ].join("\n");

  const blocks = MODULES.map((m) => transformModule(m, fs.readFileSync(DOMAIN_DIR + m + ".js", "utf8")));

  // API pública: se aplanan los exports de todos los módulos (no colisionan entre sí).
  const namespaces = MODULES.map(cap).join(", ");
  const footer = `// ── API pública ──\nvar Domain = Object.assign({}, ${namespaces});`;

  return [header, ...blocks, footer].join("\n\n") + "\n";
}

// Ejecutado directamente (`node build/build-gas.mjs`): escribe el artefacto.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const out = fileURLToPath(new URL("../server/domain.gs", import.meta.url));
  fs.mkdirSync(fileURLToPath(new URL("../server/", import.meta.url)), { recursive: true });
  fs.writeFileSync(out, buildBundle());
  console.log(`[build-gas] escrito ${out} (${buildBundle().length} bytes)`);
}

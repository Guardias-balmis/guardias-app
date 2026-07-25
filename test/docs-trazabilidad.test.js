// Puerta de trazabilidad entre los documentos de propuesta (`docs/`) y el registro de
// invariantes (`spec.md` §5 / §8). Cero dependencias, solo node:test + node:fs (S-6).
//
// POR QUÉ EXISTE (julio 2026): aparecieron en `docs/` ocho documentos de propuesta de reglas de
// negocio que no citaban ni una sola vez un `INV-n` — usaban una numeración propia (`RN-nn`,
// `CN-nn`, `RF-nn`) y se apoyaban en diez documentos que NUNCA han existido en el repo. Ambos
// documentos fueron redactados con asistencia de IA, y las citas a ficheros inexistentes son el
// modo de fallo característico: se generan por plausibilidad y nadie las comprueba, así que una
// afirmación deja de ser auditable sin que salte ninguna alarma.
//
// Este test NO comprueba coherencia semántica: no puede detectar que "equidad por puntos
// ponderados" contradiga "dif ≤ 1 por eje" (eso lo decide una persona y se registra en §8).
// Comprueba trazabilidad, que es lo mecanizable: que los identificadores existan, que los estados
// sean del vocabulario y que ningún documento cite un fichero que no está.
//
// Mismo espíritu que `v2/domain/test/parity.test.js`: la garantía no es la convención, es el test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = readFileSync(join(ROOT, "spec.md"), "utf8");

const ESTADOS_VALIDOS = new Set(["propuesto", "aceptado", "implementado", "rechazado"]);

// Referencias documentales que sabemos ausentes y toleramos para no romper `main` con la deuda ya
// existente. La lista es el inventario de la deuda, no una excusa: cualquier referencia NUEVA a un
// documento inexistente hace fallar el test. Si algún día uno de estos aparece de verdad en el
// repo, el último test de este fichero exige quitarlo de aquí (para que la lista no se fosilice).
const AUSENTES_CONOCIDAS = new Set([
  "VACATION_IMPACT_MODEL.md",
  "DOMAIN_MODEL.md",
  "DOMAIN_DESIGN_CALENDARIO.md",
  "DOMAIN_DESIGN_PLANIFICACION.md",
  "FLEXIBLE_COHORTS_REVIEW.md",
  "INSTITUTIONAL_CONTINUITY.md",
  "Reglas_de_Negocio_App_Guardias.docx",
]);

function ficherosDelRepo(dir = ROOT, acc = []) {
  for (const nombre of readdirSync(dir)) {
    if (nombre === ".git" || nombre === "node_modules") continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) ficherosDelRepo(ruta, acc);
    else acc.push(ruta.slice(ROOT.length + 1));
  }
  return acc;
}

const FICHEROS = ficherosDelRepo();
const BASENAMES = new Set(FICHEROS.map((f) => basename(f)));

/** IDs de invariante declarados en la tabla de §5 (`| INV-1 | ... |`). */
function invariantesDeclarados() {
  return new Set([...SPEC.matchAll(/^\|\s*(INV-\d+)\s*\|/gm)].map((m) => m[1]));
}

/** IDs con procedencia normativa documentada en §5.1 (`- **INV-1** — ...`). */
function invariantesConProcedencia() {
  return new Set([...SPEC.matchAll(/^-\s+\*\*(INV-\d+)\*\*\s+—/gm)].map((m) => m[1]));
}

/** Filas del registro de propuestas de §8 (`| P-1 | ... | estado |`). */
function propuestas() {
  return [...SPEC.matchAll(/^\|\s*(P-\d+)\s*\|(.+)\|\s*`([a-z]+)`\s*\|\s*$/gm)].map((m) => ({
    id: m[1],
    cuerpo: m[2],
    estado: m[3],
  }));
}

const DOCS = readdirSync(join(ROOT, "docs"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ nombre: f, texto: readFileSync(join(ROOT, "docs", f), "utf8") }));

test("§5.1: cada invariante declarado en §5 tiene procedencia (normativa o decisión explícita)", () => {
  const declarados = invariantesDeclarados();
  const conProcedencia = invariantesConProcedencia();
  assert.ok(declarados.size >= 14, `se esperaban ≥14 invariantes en §5, hay ${declarados.size}`);
  const sinProcedencia = [...declarados].filter((id) => !conProcedencia.has(id));
  assert.deepEqual(
    sinProcedencia,
    [],
    `invariantes sin procedencia declarada en §5.1: ${sinProcedencia.join(", ")}. ` +
      `Añade una línea "- **INV-n** — cita de normativa.pdf" o declárala extensión sin respaldo normativo.`
  );
});

test("§5.1 no inventa procedencia para invariantes que no existen en §5", () => {
  const declarados = invariantesDeclarados();
  const huerfanos = [...invariantesConProcedencia()].filter((id) => !declarados.has(id));
  assert.deepEqual(huerfanos, [], `procedencia declarada para invariantes inexistentes: ${huerfanos.join(", ")}`);
});

test("§8: toda propuesta tiene un estado del vocabulario", () => {
  const props = propuestas();
  assert.ok(props.length > 0, "no se ha podido parsear ninguna fila de §8 (¿cambió el formato de la tabla?)");
  for (const p of props) {
    assert.ok(
      ESTADOS_VALIDOS.has(p.estado),
      `${p.id} tiene estado "${p.estado}"; válidos: ${[...ESTADOS_VALIDOS].join(", ")}`
    );
  }
});

test("§8: los invariantes que dice tocar cada propuesta existen en §5", () => {
  const declarados = invariantesDeclarados();
  for (const p of propuestas()) {
    for (const [, id] of p.cuerpo.matchAll(/\b(INV-\d+)\b/g)) {
      assert.ok(declarados.has(id), `${p.id} dice tocar ${id}, que no existe en la tabla de §5`);
    }
  }
});

test("docs/: ninguna referencia NUEVA a un documento que no existe en el repo", () => {
  const nuevas = [];
  for (const { nombre, texto } of DOCS) {
    for (const [, ref] of texto.matchAll(/\b([\w./-]+\.(?:md|docx|pdf))\b/g)) {
      const base = basename(ref);
      if (BASENAMES.has(base) || AUSENTES_CONOCIDAS.has(base)) continue;
      nuevas.push(`${nombre} cita "${ref}", que no existe`);
    }
  }
  assert.deepEqual(
    [...new Set(nuevas)],
    [],
    "referencias a documentos inexistentes no registradas como deuda conocida.\n" +
      "Si el documento debería existir, créalo o corrige la cita. Si es una cita generada por\n" +
      "plausibilidad (el modo de fallo típico al redactar con IA), bórrala: una afirmación que se\n" +
      "apoya en un documento inexistente no es auditable.\n" +
      `Detalle:\n  - ${[...new Set(nuevas)].join("\n  - ")}`
  );
});

test("la lista de deuda conocida no se fosiliza: no quedan entradas ya resueltas", () => {
  const resueltas = [...AUSENTES_CONOCIDAS].filter((f) => BASENAMES.has(f));
  assert.deepEqual(
    resueltas,
    [],
    `estos ficheros ya existen en el repo: quítalos de AUSENTES_CONOCIDAS para que el test vuelva ` +
      `a protegerlos: ${resueltas.join(", ")}`
  );
});

test("docs/: la taxonomía paralela RN-/CN-/RF- no crece sin mapearse a INV-", () => {
  // No se prohíbe la numeración ajena (viene de un corpus externo), pero un documento que use
  // RN-nn y no mencione ningún INV-n es exactamente el caso que dejó 32 choques sin detectar.
  const CONOCIDOS = new Set(["EQUITY_SYSTEM.md", "GUARD_COMPOSITION_RULES.md", "GUARD_SHIFT_TIME_RULES.md"]);
  const infractores = DOCS.filter(
    ({ nombre, texto }) =>
      !CONOCIDOS.has(nombre) && /\b(?:RN|CN|RF|RM)-\d+\b/.test(texto) && !/\bINV-\d+\b/.test(texto)
  ).map((d) => d.nombre);
  assert.deepEqual(
    infractores,
    [],
    `estos documentos usan numeración RN-/CN-/RF- sin citar ningún INV-n, así que nadie puede saber ` +
      `qué invariante tocan: ${infractores.join(", ")}. Añade el INV-n afectado o una fila en spec.md §8.`
  );
});

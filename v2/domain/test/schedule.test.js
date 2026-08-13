// Tests del generador determinista (v2/domain/schedule.js, decisión V-34).
//
// REGLA DE ORO, heredada del banco de V-32: el juez es SIEMPRE el dominio real
// (`validateMonth`, `validateResidencyYearClose`), nunca una reimplementación de las reglas
// dentro del test. Un generador que se juzga a sí mismo no demuestra nada — solo demuestra que
// dos copias del mismo error coinciden.

import test from "node:test";
import assert from "node:assert/strict";

import { generateMonth } from "../schedule.js";
import { buildMonthContext, validateMonth } from "../validate.js";
import { addDays, datesOfMonth } from "../calendar.js";

const mk = (prefijo, n, anio) => Array.from({ length: n }, (_, i) => ({
  id: `${prefijo}${i + 1}`, fechaInicio: `${anio}-05-27`, fechaFin: `${anio + 4}-05-26`,
}));
/** Plantilla real del servicio (hoja «Residentes» del .xlsm): 3 R4 · 4 R3 · 4 R2 · 4 R1. */
const PLANTILLA = [...mk("r4_", 3, 2023), ...mk("r3_", 4, 2024), ...mk("r2_", 4, 2025), ...mk("r1_", 4, 2026)];

function generar({ mes = 10, anio = 2026, residentes = PLANTILLA, historicas = [], bloqueos = [], festivos = [], ...op } = {}) {
  const ctx = buildMonthContext({ mes, anio, residentes, historicas, asignacionesDelMes: [], bloqueos, festivos });
  return generateMonth(ctx, op);
}
/** Somete la propuesta al validador real y devuelve solo lo que impide validar. */
function erroresDe(propuesta, { mes = 10, anio = 2026, residentes = PLANTILLA, bloqueos = [], festivos = [] } = {}) {
  return validateMonth(buildMonthContext({ mes, anio, residentes, asignacionesDelMes: propuesta, bloqueos, festivos }))
    .filter((v) => v.severidad === "error");
}
const fechasDe = (propuesta, id) => new Set(propuesta.filter((a) => a.residenteId === id).map((a) => a.fecha));

test("cubre el mes entero sin un solo error del validador (INV-1: 1 Mayor + 1 Pequeño cada día)", () => {
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026 });
  assert.equal(asignaciones.length, 31 * 2);
  assert.deepEqual(diagnostico.sinCubrir, []);
  assert.deepEqual(erroresDe(asignaciones), []);
});

test("nadie hace guardia dos días seguidos (INV-15), y el validador tampoco lo ve", () => {
  for (const mes of [6, 7, 10, 12]) {
    const { asignaciones, diagnostico } = generar({ mes, anio: 2026 });
    for (const id of PLANTILLA.map((r) => r.id)) {
      const fs = fechasDe(asignaciones, id);
      for (const f of fs) {
        assert.ok(!fs.has(addDays(f, 1)), `${id} tiene ${f} y ${addDays(f, 1)} seguidas (mes ${mes})`);
      }
    }
    assert.deepEqual(diagnostico.sinCubrir, [], `mes ${mes} debería cubrirse entero con la plantilla real`);
    assert.deepEqual(erroresDe(asignaciones, { mes }), []);
  }
});

test("la regla de días consecutivos cruza el borde de mes: la víspera del día 1 también cuenta", () => {
  // A todos menos a `r3_1` se les carga un acumulado alto, para que el generador quiera darle a
  // él el día 1: si la adyacencia solo mirase dentro del mes, se lo daría pegado a su 30-sep.
  const historicas = [];
  for (const r of PLANTILLA) {
    if (r.id === "r3_1") continue;
    for (let d = 1; d <= 12; d++) historicas.push({ fecha: `2026-09-${String(d).padStart(2, "0")}`, residenteId: r.id, codigo: "G" });
  }
  historicas.push({ fecha: "2026-09-30", residenteId: "r3_1", codigo: "G" });

  const { asignaciones } = generar({ mes: 10, anio: 2026, historicas });
  assert.ok(!fechasDe(asignaciones, "r3_1").has("2026-10-01"),
    "r3_1 hizo guardia el 30-sep, así que no puede tener el 1-oct");
});

test("INV-5: no asigna sobre una baja, ni siquiera si es quien menos guardias lleva", () => {
  const bloqueos = [{ residenteId: "r2_1", motivo: "BAJA", desde: "2026-10-01", hasta: "2026-10-31", activo: true }];
  const { asignaciones } = generar({ mes: 10, anio: 2026, bloqueos });
  assert.equal(fechasDe(asignaciones, "r2_1").size, 0);
  assert.deepEqual(erroresDe(asignaciones, { bloqueos }), []);
});

test("INV-11: ningún R1 coge guardia en junio, julio ni agosto", () => {
  for (const mes of [6, 7, 8]) {
    const { asignaciones } = generar({ mes, anio: 2026 });
    const r1 = asignaciones.filter((a) => a.residenteId.startsWith("r1_"));
    assert.deepEqual(r1, [], `mes ${mes} asignó a un R1`);
    assert.deepEqual(erroresDe(asignaciones, { mes }), []);
  }
});

test("INV-12: el código sale de los festivos cargados, nunca inventado (GF en festivo, GP en la víspera)", () => {
  const festivos = [{ fecha: "2026-10-12", nombre: "Fiesta Nacional", activo: true }];
  const { asignaciones } = generar({ mes: 10, anio: 2026, festivos });
  const codigoDe = (f) => [...new Set(asignaciones.filter((a) => a.fecha === f).map((a) => a.codigo))];
  assert.deepEqual(codigoDe("2026-10-12"), ["GF"]);
  assert.deepEqual(codigoDe("2026-10-11"), ["GP"]);
  assert.deepEqual(codigoDe("2026-10-13"), ["G"]);
  // Sin festivos cargados NO se deduce ninguno (S-4): todo sale G.
  const sinFestivos = generar({ mes: 10, anio: 2026 }).asignaciones;
  assert.deepEqual([...new Set(sinFestivos.map((a) => a.codigo))], ["G"]);
});

test("es determinista: misma entrada y misma semilla → mismo cuadrante, siempre", () => {
  const a = generar({ mes: 10, anio: 2026, semilla: 7 }).asignaciones;
  const b = generar({ mes: 10, anio: 2026, semilla: 7 }).asignaciones;
  assert.deepEqual(a, b);
  // Otra semilla da otra propuesta, y tiene que seguir siendo legal: la semilla elige entre
  // soluciones válidas, no relaja nada.
  const c = generar({ mes: 10, anio: 2026, semilla: 99 }).asignaciones;
  assert.notDeepEqual(a, c);
  assert.deepEqual(erroresDe(c), []);
});

// ── Las dos reglas de V-32 que deciden el diseño ────────────────────────────────────────────────

test("V-32 regla 1: persigue el ACUMULADO del año, no el mes (a quien llega cargado le da menos)", () => {
  // `r3_1` llega con 10 guardias de ventaja sobre sus tres compañeros de cohorte.
  const historicas = [];
  for (let d = 1; d <= 10; d++) historicas.push({ fecha: `2026-09-${String(d).padStart(2, "0")}`, residenteId: "r3_1", codigo: "G" });

  const { asignaciones } = generar({ mes: 10, anio: 2026, historicas });
  const n = (id) => fechasDe(asignaciones, id).size;
  // Un generador de ámbito mes le habría dado lo mismo que a los demás (reparto «justo» del mes);
  // uno que persigue el acumulado le da menos para compensar.
  for (const otro of ["r3_2", "r3_3", "r3_4"]) {
    assert.ok(n("r3_1") < n(otro), `r3_1 (${n("r3_1")}) debería llevar menos que ${otro} (${n(otro)})`);
  }
});

test("V-32 regla 2: divide por disponibilidad — a quien vuelve de una baja larga NO le iguala en crudo", () => {
  // Baja de medio año: su `f` es ~0,5, así que el juez espera que acabe con ~la mitad de guardias.
  // Igualarle el total EN CRUDO es exactamente lo que INV-3 penaliza (0/6 medido en V-32).
  const bloqueos = [{ residenteId: "r3_1", motivo: "BAJA", desde: "2026-05-27", hasta: "2026-11-26", activo: true }];
  const { asignaciones } = generar({ mes: 12, anio: 2026, bloqueos });
  const n = (id) => fechasDe(asignaciones, id).size;
  const sanos = ["r3_2", "r3_3", "r3_4"].map(n);
  assert.ok(n("r3_1") < Math.min(...sanos),
    `r3_1 (${n("r3_1")}) debería llevar menos que sus compañeros (${sanos.join(",")}): su disponibilidad es la mitad`);
  assert.deepEqual(erroresDe(asignaciones, { mes: 12, bloqueos }), []);
});

// ── Degradación: lo que hace cuando NO se puede cumplir todo ────────────────────────────────────

test("si un día no tiene a nadie elegible lo dice, no revienta ni inventa a alguien", () => {
  // Un solo Pequeño, y de baja el mes entero: el puesto es incubrible.
  const residentes = [...mk("r4_", 2, 2023), ...mk("r2_", 1, 2025)];
  const bloqueos = [{ residenteId: "r2_1", motivo: "BAJA", desde: "2026-10-01", hasta: "2026-10-31", activo: true }];
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, residentes, bloqueos });
  assert.equal(diagnostico.sinCubrir.length, 31);
  assert.ok(diagnostico.sinCubrir.every((s) => s.puesto === "Pequeño"));
  // Lo que sí puede cubrir, lo cubre: el puesto de Mayor sale entero.
  assert.equal(asignaciones.length, 31);
});

test("con un solo Pequeño deja los días alternos SIN CUBRIR: no propone lo que INV-15 prohíbe", () => {
  // Un único Pequeño para todo el mes. Encadenarle guardias sería ilegal (INV-15), así que el
  // generador cubre día sí día no y DICE que el resto no tiene solución legal con esta plantilla:
  // rellenarlo lo disfrazaría de cuadrante correcto y el validador lo rechazaría igual.
  const residentes = [...mk("r4_", 2, 2023), ...mk("r2_", 1, 2025)];
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, residentes });

  const suyas = [...fechasDe(asignaciones, "r2_1")].sort();
  assert.ok(suyas.length > 0 && suyas.length < 31, `debería cubrir algunos días, no todos (${suyas.length})`);
  for (const f of suyas) assert.ok(!suyas.includes(addDays(f, 1)), `${f} y el día siguiente, seguidas`);
  const porDescanso = diagnostico.sinCubrir.filter((s) => s.motivo === "descanso");
  assert.equal(porDescanso.length, 31 - suyas.length);
  assert.ok(porDescanso.every((s) => s.puesto === "Pequeño"));
  // Lo que propone NO tiene ni un INV-15: los errores que quedan son los días sin Pequeño (INV-1).
  const errores = erroresDe(asignaciones, { residentes });
  assert.ok(errores.every((v) => v.invariante === "INV-1"), errores.map((v) => v.invariante).join(","));
});

test("no propone nada para quien ya terminó la residencia ni para quien no ha empezado", () => {
  const residentes = [
    ...mk("r4_", 2, 2023),
    ...mk("r2_", 2, 2025),
    { id: "fin_1", fechaInicio: "2018-05-27", fechaFin: "2022-05-26" },   // FINALIZADO
    { id: "fut_1", fechaInicio: "2030-05-27", fechaFin: "2034-05-26" },   // aún no empieza
  ];
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, residentes });
  assert.equal(fechasDe(asignaciones, "fin_1").size, 0);
  assert.equal(fechasDe(asignaciones, "fut_1").size, 0);
  assert.ok(!diagnostico.residentes.some((r) => r.id === "fin_1" || r.id === "fut_1"));
  assert.deepEqual(erroresDe(asignaciones, { residentes }), []);
});

test("el histórico que cae DENTRO del mes se descarta: la propuesta reemplaza el mes, no se suma", () => {
  // El invocador pide el histórico con lookahead de doblete (contrato C-1), así que llegan filas
  // del propio mes. Si contaran, el generador perseguiría un acumulado inflado — y además esas
  // filas las va a borrar `apply-month.js` al aplicar (V-31).
  const historicas = [
    { fecha: "2026-10-01", residenteId: "r3_1", codigo: "G" },
    { fecha: "2026-10-02", residenteId: "r3_1", codigo: "G" },
  ];
  const conRuido = generar({ mes: 10, anio: 2026, historicas, semilla: 3 }).asignaciones;
  const limpio = generar({ mes: 10, anio: 2026, semilla: 3 }).asignaciones;
  assert.deepEqual(conRuido, limpio);
});

test("los seis ejes de INV-3 quedan dentro de ±1 en las cohortes comparables (coste duro a 0)", () => {
  for (const mes of [6, 10, 12]) {
    const { diagnostico } = generar({ mes, anio: 2026 });
    assert.equal(diagnostico.coste, 0, `mes ${mes} no llegó a repartir dentro de ±1`);
    assert.ok(diagnostico.cohortesComparadas >= 1);
  }
});

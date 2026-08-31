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
import { validateQuarterClose, quarterCloseWindow } from "../equity.js";
import { validateThirdPost } from "../thirdpost.js";
import { levelOn, periodsOfResident } from "../residents.js";
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
  // filas las va a borrar `v2/domain/apply.js` al aplicar (V-31).
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

// El generador persigue TAMBIÉN el cierre trimestral (V-37). Se juzga con `validateQuarterClose`
// de verdad, nunca con el coste interno, que es una imitación suya.
//
// La cadena arranca en JUNIO y el trimestre que se juzga es T3, y las dos cosas hacen falta para
// que el test signifique algo. Medido: un T2 generado desde septiembre —o sea con el trimestre
// empezando a la vez que el histórico— sale limpio en las 12 semillas probadas **también sin este
// objetivo**, porque no hay desequilibrio previo que arrastrar. El desajuste aparece cuando el
// trimestre cae sobre un año ya empezado, que es la situación normal. Con la semilla 2, el
// generador anterior dejaba T3 en `r3_1=13 vs r3_4=11`; con la 5, `r1_2=14 vs r1_1=12`.
test("el trimestre cierra dentro del ±1 sobre un año ya empezado (juez: validateQuarterClose)", () => {
  const acumulado = [];
  for (const [mes, anio] of [[6, 2026], [7, 2026], [8, 2026], [9, 2026], [10, 2026], [11, 2026], [12, 2026], [1, 2027], [2, 2027]]) {
    const ctx = buildMonthContext({
      mes, anio, residentes: PLANTILLA, historicas: [...acumulado], asignacionesDelMes: [], bloqueos: [], festivos: [],
    });
    const { asignaciones } = generateMonth(ctx, { semilla: 2, pasos: 20000 });
    assert.deepEqual(erroresDe(asignaciones, { mes, anio }), [], `el mes ${anio}-${mes} no debería tener errores`);
    acumulado.push(...asignaciones);
  }

  const win = quarterCloseWindow(2, 2027);
  assert.deepEqual(win, { trimestre: "T3", start: "2026-12-01", end: "2027-02-28" });
  const v = validateQuarterClose({
    mes: 2, anio: 2027, residentes: PLANTILLA, bloqueos: [],
    asignaciones: acumulado.filter((a) => a.fecha >= win.start && a.fecha <= win.end),
  });
  assert.deepEqual(v, [], "el cierre trimestral debería quedar dentro del ±1");
});

// ── Tercer puesto (INV-8, decisión V-38) ────────────────────────────────────────────────────────
// El juez vuelve a ser el dominio: `validateThirdPost` para INV-8 y `validateMonth` para INV-15.
// Aquí no se reimplementa ni el ciclo L-D ni la mochila.

const VOLS = [
  { residenteId: "r3_2", desde: "2026-06-01" },
  { residenteId: "r2_2", desde: "2026-06-01" },
  { residenteId: "r4_2", desde: "2026-06-01" },
];
const tresP = (propuesta) => propuesta.filter((a) => a.codigo === "3P");
/** Los avisos de INV-8 sobre la propuesta, según el validador real. */
function inv8De(propuesta, { mes = 10, anio = 2026, voluntarios3P = VOLS, historial3P = {} } = {}) {
  return validateThirdPost({ mes, anio, residentes: PLANTILLA, asignaciones: propuesta, voluntarios3P, historial3P });
}
/** Los días en que el Pequeño es un R1: los de «mochila» de INV-8d. */
function diasMochila(propuesta) {
  const out = new Set();
  for (const a of propuesta.filter((x) => x.codigo !== "3P")) {
    const r = PLANTILLA.find((x) => x.id === a.residenteId);
    if (r && levelOn(periodsOfResident(r), a.fecha) === "R1") out.add(a.fecha);
  }
  return out;
}

test("por defecto NO propone ningún 3P: el reparto del 3.º puesto sigue siendo una decisión humana", () => {
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, voluntarios3P: VOLS });
  assert.deepEqual(tresP(asignaciones), []);
  assert.equal(diagnostico.tercerPuesto.pedidas, 0);
});

test("propone los 3P que se le piden sin un solo aviso de INV-8 ni error de INV-15", () => {
  for (const n of [1, 4, 10]) {
    const { asignaciones } = generar({ mes: 10, anio: 2026, tercerPuesto: n, voluntarios3P: VOLS });
    assert.equal(tresP(asignaciones).length, n, `pedidas ${n}`);
    assert.deepEqual(inv8De(asignaciones), [], `pedidas ${n}: INV-8 debería callar`);
    assert.deepEqual(erroresDe(asignaciones), [], `pedidas ${n}: INV-15 debería callar`);
  }
});

test("INV-8a: el 3P solo va a quien consta voluntario, aunque otro lleve menos carga", () => {
  const { asignaciones } = generar({ mes: 10, anio: 2026, tercerPuesto: 8, voluntarios3P: [VOLS[0]] });
  const ids = new Set(tresP(asignaciones).map((a) => a.residenteId));
  assert.deepEqual([...ids], ["r3_2"]);
});

test("INV-8d: mientras quepa, todos los 3P caen en día de mochila (el Pequeño es R1)", () => {
  const { asignaciones } = generar({ mes: 10, anio: 2026, tercerPuesto: 5, voluntarios3P: VOLS });
  const mochila = diasMochila(asignaciones);
  for (const a of tresP(asignaciones)) {
    assert.ok(mochila.has(a.fecha), `el 3P del ${a.fecha} no cae en día de mochila`);
  }
});

test("INV-8b: el ciclo L-D arrastra del mes anterior, no empieza de cero cada mes", () => {
  const historial3P = { r3_2: ["2026-09-07", "2026-09-08", "2026-09-09"] }; // lunes, martes, miércoles
  const { asignaciones } = generar({ mes: 10, anio: 2026, tercerPuesto: 4, voluntarios3P: [VOLS[0]], historial3P });
  assert.deepEqual(inv8De(asignaciones, { voluntarios3P: [VOLS[0]], historial3P }), []);
});

test("INV-15: un 3P nunca queda pegado a una guardia (ni a otro 3P) del mismo residente", () => {
  const { asignaciones } = generar({ mes: 10, anio: 2026, tercerPuesto: 10, voluntarios3P: VOLS });
  for (const id of VOLS.map((v) => v.residenteId)) {
    const suyos = fechasDe(asignaciones, id);
    for (const f of suyos) assert.ok(!suyos.has(addDays(f, 1)), `${id} encadena ${f} con ${addDays(f, 1)}`);
  }
  assert.deepEqual(erroresDe(asignaciones), []);
});

test("un 3P del mes ANTERIOR veta el día 1, igual que una guardia (INV-15 cuenta el 3P)", () => {
  // Antes de V-38 el generador solo miraba G/GF/GP en el histórico, así que proponía la guardia
  // del 1-oct pegada al 3P del 30-sep y se producía él mismo un `error` de INV-15.
  const historicas = [];
  for (const r of PLANTILLA) {
    if (r.id === "r3_1") continue;
    for (let d = 1; d <= 12; d++) historicas.push({ fecha: `2026-09-${String(d).padStart(2, "0")}`, residenteId: r.id, codigo: "G" });
  }
  historicas.push({ fecha: "2026-09-30", residenteId: "r3_1", codigo: "3P" });

  const { asignaciones } = generar({ mes: 10, anio: 2026, historicas });
  assert.ok(!fechasDe(asignaciones, "r3_1").has("2026-10-01"),
    "r3_1 hizo 3P el 30-sep, así que el 1-oct le encadena igual que si hubiera sido guardia");
});

test("si no caben las pedidas lo DICE, en vez de colocarlas rompiendo el ciclo", () => {
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, tercerPuesto: 30, voluntarios3P: [VOLS[0]] });
  const d = diagnostico.tercerPuesto;
  assert.equal(d.pedidas, 30);
  assert.ok(d.colocadas > 0 && d.colocadas < 30, `colocadas ${d.colocadas}: el techo lo pone el ciclo L-D de un solo voluntario`);
  assert.equal(d.colocadas, tresP(asignaciones).length);
  assert.ok(d.motivo, "tiene que decir por qué no salieron todas");
  assert.deepEqual(inv8De(asignaciones, { voluntarios3P: [VOLS[0]] }), []);
});

test("sin voluntarios no inventa ninguno: 0 colocadas y el motivo dicho", () => {
  const { asignaciones, diagnostico } = generar({ mes: 10, anio: 2026, tercerPuesto: 5, voluntarios3P: [] });
  assert.deepEqual(tresP(asignaciones), []);
  assert.equal(diagnostico.tercerPuesto.motivo, "sin-voluntarios");
  assert.equal(typeof diagnostico.tercerPuesto.diasMochila, "number");
});

// ── Previsión sobre el eje escaso (decisión V-39) ───────────────────────────────────────────────

test("no gasta el puente de hoy en quien ya tiene perdido el de dentro de unos meses", () => {
  // Dos puentes en la ventana: el 22-jun (víspera del 23) y el 7-dic (víspera del 8). `r3_1` está
  // de baja en diciembre, así que el 7-dic NO le cuenta como libre (V-27) y nunca podrá
  // recuperarlo. Si el generador solo mira lo ya transcurrido, en junio los ve a todos a cero y no
  // tiene motivo para no darle el 22-jun — y en diciembre ya no queda puente con el que arreglarlo.
  const festivos = [{ fecha: "2026-06-23" }, { fecha: "2026-12-08" }].map((f) => ({ ...f, nombre: "f", activo: true }));
  const bloqueos = [{ residenteId: "r3_1", motivo: "BAJA", desde: "2026-11-15", hasta: "2026-12-31", activo: true }];
  // Se le carga el acumulado a TODOS menos a `r3_1`, para que el generador quiera darle a él los
  // días de junio: sin esto el puente le tocaría por azar y el test pasaría por suerte.
  const historicas = [];
  for (const r of PLANTILLA) {
    if (r.id === "r3_1") continue;
    for (let d = 1; d <= 10; d++) historicas.push({ fecha: `2026-06-${String(d).padStart(2, "0")}`, residenteId: r.id, codigo: "G" });
  }

  for (const semilla of [1, 2, 3, 4, 5]) {
    const { asignaciones } = generar({ mes: 6, anio: 2026, festivos, bloqueos, historicas, semilla });
    assert.ok(!fechasDe(asignaciones, "r3_1").has("2026-06-22"),
      `semilla ${semilla}: a r3_1 le queda un solo puente aprovechable en todo el año, así que no debería gastarlo`);
  }
});

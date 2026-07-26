// Equidad al cierre del año de residencia (INV-3) y exclusión del cómputo (INV-4). spec.md §5.
// La ventana es el año de residencia INDIVIDUAL (aniversario→aniversario), no el académico
// ni el natural. Solo se evalúa en el mes que contiene el cierre; en meses intermedios la
// desigualdad es compensable (no se reporta). Se compara entre residentes del mismo año
// formativo (cohorte). La entrada imita el "Resumen" del Excel: acumulados por mes +
// asignaciones del mes validado. tally excluye 3P y cedidas/compradas → INV-4 sale gratis.
//
// Desde P-8 (spec.md §8, decisión V-13) el mismo invariante tiene un SEGUNDO cierre, el
// trimestral (`validateQuarterClose`): la normativa p.2 lo llama «criterio obligatorio» —
// «una vez cerrado el cuadrante trimestral, la diferencia de número de guardias entre
// residentes del mismo año no supere 1». Dos diferencias deliberadas con el cierre anual,
// ambas leídas de esa misma frase: solo mide el eje `total` («número de guardias»; los demás
// ejes los ancla la normativa al año de residencia, p.1/p.4) y su severidad es `aviso`, no
// `error`, porque la propia frase prevé compensar el exceso «en los meses siguientes hasta
// equilibrar el cómputo dentro del año de residencia» (criterio V-4: lo compensable avisa).

import { compareISO, addDays, addYears, datesOfMonth, toISO, trimesterWindow } from "./calendar.js";
import { tally } from "./tally.js";
import { accumulatedTally } from "./accumulate.js";

const DIMS = ["total", "findes", "festivos", "prefestivos", "puentesLibres", "dobletes"];
const PROPORCIONAL = new Set(["total", "findes", "festivos", "prefestivos", "dobletes"]); // se normalizan por disponibilidad
const EPS = 1e-9;

const err = (detalle, extra = {}) => ({ invariante: "INV-3", severidad: "error", detalle, ...extra });
const warn = (detalle, extra = {}) => ({ invariante: "INV-3", severidad: "aviso", detalle, ...extra });
const cohortOf = (r) => Number(r.fechaInicio.slice(0, 4));
const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, acumulados, asignaciones?, puentesDelMes?, bloqueos? }
 *   - acumulados: { id: {total, findes, festivos, puentesLibres, dobletes} } hasta fin del mes anterior
 *   - asignaciones: del mes validado (G/GF/GP/3P, con origen? para cedidas/compradas)
 *   - puentesDelMes: [{desde, hasta}] puentes que caen en el mes validado (para puentesLibres)
 *   - bloqueos: del año (para el descuento proporcional por baja, nota [a])
 */
export function validateResidencyYearClose(ctx) {
  const { mes, anio, residentes, acumulados = {}, asignaciones = [], puentesDelMes = [], bloqueos = [] } = ctx;
  const violations = [];
  const monthDays = datesOfMonth(anio, mes);
  const monthStart = monthDays[0];
  const monthEnd = monthDays[monthDays.length - 1];

  // Métricas finales por residente que cierra su año este mes, agrupadas por cohorte.
  const byCohort = new Map();
  for (const r of residentes) {
    const win = closingWindowThisMonth(r, mes, anio);
    if (!win) continue; // no cierra este mes → no se evalúa

    const acc = acumulados[r.id] || { total: 0, findes: 0, festivos: 0, prefestivos: 0, puentesLibres: 0, dobletes: 0 };
    // Contribución del mes, respetando la fecha de cierre (guardias posteriores no cuentan).
    const contribEnd = compareISO(monthEnd, win.end) <= 0 ? monthEnd : win.end;
    const t = tally(asignaciones.filter((a) => a.residenteId === r.id), { start: monthStart, end: contribEnd });
    const puentesLibresMes = puentesDelMes.filter((p) => residentIsFreeOnBridge(r.id, asignaciones, p, win)).length;

    const dims = {
      total: acc.total + t.total,
      findes: acc.findes + t.finde,
      festivos: acc.festivos + t.festivos,
      prefestivos: (acc.prefestivos || 0) + t.prefestivos,
      dobletes: acc.dobletes + t.dobletes,
      puentesLibres: acc.puentesLibres + puentesLibresMes,
    };
    const f = availabilityFraction(win, bloqueos.filter((b) => b.residenteId === r.id && b.motivo === "BAJA"));

    const cohorte = cohortOf(r);
    if (!byCohort.has(cohorte)) byCohort.set(cohorte, []);
    byCohort.get(cohorte).push({ id: r.id, cierre: win.end, dims, f });
  }

  // Comparación por dimensión dentro de cada cohorte.
  for (const [, grupo] of byCohort) {
    if (grupo.length < 2) continue;
    for (const dim of DIMS) {
      const vals = grupo.map((x) => ({ id: x.id, cierre: x.cierre, v: PROPORCIONAL.has(dim) ? x.dims[dim] / x.f : x.dims[dim] }));
      const maxEntry = vals.reduce((a, b) => (b.v > a.v ? b : a));
      const minEntry = vals.reduce((a, b) => (b.v < a.v ? b : a));
      if (maxEntry.v - minEntry.v > 1 + EPS) {
        violations.push(err(
          `${labelDim(dim)} al cierre del año de residencia: ${maxEntry.id}=${round(maxEntry.v)} vs ${minEntry.id}=${round(minEntry.v)} (diferencia > 1)`,
          { fecha: maxEntry.cierre, residenteId: maxEntry.id }
        ));
      }
    }
  }

  return violations;
}

/**
 * Primer día de histórico que hace falta para evaluar el cierre ANUAL en este mes: el
 * aniversario más antiguo entre los residentes que cierran su año de residencia ese mes, o
 * `null` si no lo cierra ninguno (y entonces no hay nada que leer ni que comprobar).
 * Simétrico de `rotationHistoryStart` (contrato C-2): el invocador no puede adivinar el rango
 * que necesita el validador, así que lo pregunta al dominio en vez de reimplementarlo.
 */
export function yearCloseHistoryStart(residentes, mes, anio) {
  let min = null;
  for (const r of residentes) {
    const win = closingWindowThisMonth(r, mes, anio);
    if (win && (min === null || compareISO(win.start, min) < 0)) min = win.start;
  }
  return min;
}

/**
 * Ensambla el ctx de `validateResidencyYearClose` — mismo papel que `buildMonthContext` para
 * `validateMonth`: el acumulado del año se calcula UNA vez aquí (vía `accumulatedTally`) en
 * lugar de que cada pantalla y el servidor lo reimplementen con formas de objeto distintas.
 *
 * `historicas` y `asignacionesDelMes` se pasan JUNTAS a `accumulatedTally` a propósito: la
 * ventana acumulada termina el último día del mes ANTERIOR, pero un viernes de ese último día
 * empareja su domingo ya dentro del mes validado (contrato C-1, spec.md §5) — el mes entra
 * solo como lookahead y no se suma dos veces, porque `tally` cuenta únicamente lo que cae
 * dentro de la ventana que recibe. La contribución del mes la computa el validador aparte,
 * desde `asignaciones`.
 *
 * @param {object} args
 *   - historicas: asignaciones anteriores al mes (desde `yearCloseHistoryStart`)
 *   - asignacionesDelMes: las del mes validado (las que se están por validar, no las del store)
 *   - puentesDelMes: hueco conocido — no existe todavía tabla de festivos/puentes (mismo
 *     bloqueo que INV-12), así que por defecto va vacío y el eje `puentesLibres` compara ceros:
 *     ese eje de INV-3 NO está comprobado de verdad hasta que exista esa entrada.
 */
export function buildYearCloseContext({ mes, anio, residentes, historicas = [], asignacionesDelMes = [], bloqueos = [], puentesDelMes = [] }) {
  const acumulado = accumulatedTally(residentes, [...historicas, ...asignacionesDelMes], addDays(toISO(anio, mes, 1), -1));
  const acumulados = {};
  for (const [id, t] of acumulado) {
    // `tally` llama `finde` a lo que INV-3 compara como `findes`: la traducción vive aquí, una vez.
    acumulados[id] = { total: t.total, findes: t.finde, festivos: t.festivos, prefestivos: t.prefestivos, dobletes: t.dobletes, puentesLibres: 0 };
  }
  return { mes, anio, residentes, acumulados, asignaciones: asignacionesDelMes, bloqueos, puentesDelMes };
}

// --- Cierre de TRIMESTRE (INV-3 trimestral, P-8 / decisión V-13) ---------------------------

/**
 * Ventana del trimestre que CIERRA en este mes, o `null` si el mes no cierra ninguno (solo
 * agosto, noviembre, febrero y mayo lo hacen). Exportada porque el invocador la necesita
 * ANTES de llamar al validador, para saber qué rango de asignaciones leer del store.
 */
export function quarterCloseWindow(mes, anio) {
  const win = trimesterWindow(toISO(anio, mes, 1));
  return inMonth(win.end, mes, anio) ? win : null;
}

/**
 * Por debajo de esta disponibilidad el trimestre no se compara (decisión V-13). Normalizar
 * `total/f` con una `f` diminuta amplifica: media guardia en dos semanas disponibles se
 * convertiría en un "13" que dispararía un aviso falso cada trimestre. Quien esté de baja
 * más de medio trimestre sigue cubierto por el cierre anual, donde la ventana promedia.
 */
const MIN_DISPONIBILIDAD = 0.5;

/**
 * INV-3 al cierre del trimestre (P-8). Devuelve [] si `mes` no cierra trimestre: igual que el
 * cierre anual, en los meses intermedios la desigualdad es compensable y no se reporta.
 *
 * @param {object} ctx { mes, anio, residentes, asignaciones, bloqueos? }
 *   - asignaciones: TODAS las del trimestre, de cualquier residente (se filtran por residente
 *     aquí). No necesita el lookahead de doblete del contrato C-1: el único eje es `total`.
 *   - bloqueos: los que solapan el trimestre; solo `motivo=BAJA` descuenta disponibilidad
 *     (nota [a] de p.2: «se descontará de forma proporcional»).
 * @returns violaciones de severidad `aviso`
 */
export function validateQuarterClose(ctx) {
  const { mes, anio, residentes, asignaciones = [], bloqueos = [] } = ctx;
  const win = quarterCloseWindow(mes, anio);
  if (!win) return [];
  const quarterDays = daysInclusive(win.start, win.end);
  const violations = [];

  const byCohort = new Map();
  for (const r of residentes) {
    // Un residente que solo estaba parte del trimestre (alta a mitad, o R4 que termina) se
    // compara sobre la parte que le tocaba, no sobre el trimestre entero.
    const presente = intersect(win, { start: r.fechaInicio, end: r.fechaFin || addDays(addYears(r.fechaInicio, 4), -1) });
    if (!presente) continue;
    const disponibles = availableDays(presente, bloqueos.filter((b) => b.residenteId === r.id && b.motivo === "BAJA"));
    const f = disponibles / quarterDays;
    if (f < MIN_DISPONIBILIDAD) continue;

    const total = tally(asignaciones.filter((a) => a.residenteId === r.id), { start: win.start, end: win.end }).total;
    const cohorte = cohortOf(r);
    if (!byCohort.has(cohorte)) byCohort.set(cohorte, []);
    byCohort.get(cohorte).push({ id: r.id, v: total / f, ajustado: f < 1 });
  }

  for (const [, grupo] of byCohort) {
    if (grupo.length < 2) continue;
    const maxEntry = grupo.reduce((a, b) => (b.v > a.v ? b : a));
    const minEntry = grupo.reduce((a, b) => (b.v < a.v ? b : a));
    if (maxEntry.v - minEntry.v > 1 + EPS) {
      const ajuste = maxEntry.ajustado || minEntry.ajustado ? " — cifras ajustadas proporcionalmente por baja (nota [a])" : "";
      violations.push(warn(
        `Totales al cierre del trimestre ${win.trimestre} (${win.start}→${win.end}): ${maxEntry.id}=${round(maxEntry.v)} vs ${minEntry.id}=${round(minEntry.v)} (diferencia > 1)${ajuste}`,
        { fecha: win.end, residenteId: maxEntry.id }
      ));
    }
  }

  return violations;
}

function closingWindowThisMonth(r, mes, anio) {
  for (let k = 1; k <= 4; k++) {
    const cierre = addDays(addYears(r.fechaInicio, k), -1);
    if (inMonth(cierre, mes, anio)) return { start: addYears(r.fechaInicio, k - 1), end: cierre };
  }
  return null;
}

/** Fracción de disponibilidad = (días de la ventana − días de baja) / días de la ventana. */
function availabilityFraction(win, bajas) {
  const windowDays = daysInclusive(win.start, win.end);
  const avail = availableDays(win, bajas);
  return avail <= 0 ? 1 : avail / windowDays;
}

/**
 * Días de la ventana no cubiertos por ninguna baja. Separado de `availabilityFraction` porque
 * el cierre trimestral divide por los días del TRIMESTRE COMPLETO, no por los de la ventana
 * que se le pasa (que ahí es solo la parte del trimestre en la que el residente estaba).
 */
function availableDays(win, bajas) {
  let bajaDays = 0;
  for (const b of bajas) {
    const solape = intersect(win, { start: b.desde, end: b.hasta });
    if (solape) bajaDays += daysInclusive(solape.start, solape.end);
  }
  return daysInclusive(win.start, win.end) - bajaDays;
}

/** Intersección de dos rangos inclusivos, o null si no se solapan. */
function intersect(a, b) {
  const start = compareISO(a.start, b.start) >= 0 ? a.start : b.start;
  const end = compareISO(a.end, b.end) <= 0 ? a.end : b.end;
  return compareISO(start, end) <= 0 ? { start, end } : null;
}

function residentIsFreeOnBridge(id, asignaciones, puente, win) {
  const dias = daysOfRange(puente.desde, puente.hasta).filter((d) => inRange(d, win.start, win.end));
  if (!dias.length) return false; // el puente no cae en la ventana → no cuenta como libre
  const set = new Set(dias);
  return !asignaciones.some((a) => a.residenteId === id && ["G", "GF", "GP"].includes(a.codigo) && set.has(a.fecha));
}

function daysInclusive(a, b) {
  let n = 0;
  for (let d = a; compareISO(d, b) <= 0; d = addDays(d, 1)) n++;
  return n;
}
function daysOfRange(a, b) {
  const out = [];
  for (let d = a; compareISO(d, b) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}
const round = (x) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);
function labelDim(dim) {
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", prefestivos: "Prefestivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

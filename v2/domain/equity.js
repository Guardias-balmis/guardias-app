// Equidad al cierre del año de residencia (INV-3) y exclusión del cómputo (INV-4). spec.md §5.
// La ventana es el año de residencia INDIVIDUAL (aniversario→aniversario), no el académico
// ni el natural. Solo se evalúa en el mes que contiene el cierre; en meses intermedios la
// desigualdad es compensable (no se reporta). Se compara entre residentes del mismo año
// formativo (cohorte). La entrada imita el "Resumen" del Excel: acumulados por mes +
// asignaciones del mes validado. tally excluye 3P y cedidas/compradas → INV-4 sale gratis.

import { compareISO, addDays, addYears, datesOfMonth, toISO } from "./calendar.js";
import { tally } from "./tally.js";

const DIMS = ["total", "findes", "festivos", "puentesLibres", "dobletes"];
const PROPORCIONAL = new Set(["total", "findes", "festivos", "dobletes"]); // se normalizan por disponibilidad
const EPS = 1e-9;

const err = (detalle, extra = {}) => ({ invariante: "INV-3", severidad: "error", detalle, ...extra });
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

    const acc = acumulados[r.id] || { total: 0, findes: 0, festivos: 0, puentesLibres: 0, dobletes: 0 };
    // Contribución del mes, respetando la fecha de cierre (guardias posteriores no cuentan).
    const contribEnd = compareISO(monthEnd, win.end) <= 0 ? monthEnd : win.end;
    const t = tally(asignaciones.filter((a) => a.residenteId === r.id), { start: monthStart, end: contribEnd });
    const puentesLibresMes = puentesDelMes.filter((p) => residentIsFreeOnBridge(r.id, asignaciones, p, win)).length;

    const dims = {
      total: acc.total + t.total,
      findes: acc.findes + t.finde,
      festivos: acc.festivos + t.festivos,
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
  let bajaDays = 0;
  for (const b of bajas) {
    const start = compareISO(b.desde, win.start) >= 0 ? b.desde : win.start;
    const end = compareISO(b.hasta, win.end) <= 0 ? b.hasta : win.end;
    if (compareISO(start, end) <= 0) bajaDays += daysInclusive(start, end);
  }
  const avail = windowDays - bajaDays;
  return avail <= 0 ? 1 : avail / windowDays;
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
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

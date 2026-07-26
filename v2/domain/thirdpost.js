// Validación del tercer puesto (INV-8, spec.md §5). El 3P es siempre voluntario y se
// registra aparte. Cuatro reglas: (a) solo voluntarios; (b) rotación de días por
// residente (7 días L-D distintos antes de repetir, acumula entre meses, reinicia al
// completar el ciclo); (c) equidad ≤1 entre voluntarios al cierre del año de residencia;
// (d) prioridad a los días con R1 de "mochila". El 3P no computa en la equidad de
// guardias obligatorias (eso lo garantiza tally excluyendo 3P; aquí no se re-verifica).

import { weekday, compareISO, addDays, addYears, datesOfMonth } from "./calendar.js";
import { levelOn, defaultTrainingPeriods } from "./residents.js";

const err = (detalle, extra = {}) => ({ invariante: "INV-8", severidad: "error", detalle, ...extra });
const aviso = (detalle, extra = {}) => ({ invariante: "INV-8", severidad: "aviso", detalle, ...extra });

function periodsOf(r) {
  return r.periodos || defaultTrainingPeriods(r.fechaInicio, r.fechaFin || addDays(addYears(r.fechaInicio, 4), -1));
}
const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, voluntarios3P, historial3P }
 *   - asignaciones: del mes (incluye 3P y guardias G/GF/GP para detectar mochila)
 *   - voluntarios3P: string[] de ids
 *   - historial3P: { id: [fechas ISO de 3P previas, cronológicas] }
 * @returns {{invariante:'INV-8', severidad:string, fecha?:string, residenteId?:string, detalle:string}[]}
 */
export function validateThirdPost(ctx) {
  const { mes, anio, residentes, asignaciones = [], voluntarios3P = [], historial3P = {} } = ctx;
  const byId = new Map(residentes.map((r) => [r.id, r]));
  const voluntarios = new Set(voluntarios3P);
  const violations = [];

  const thisMonth3P = asignaciones.filter((a) => a.codigo === "3P").sort((a, b) => compareISO(a.fecha, b.fecha));

  // ── INV-8a: 3P solo a voluntarios ──
  for (const a of thisMonth3P) {
    if (!voluntarios.has(a.residenteId)) {
      violations.push(err(`3P asignado a ${a.residenteId}, que no consta en la lista de voluntarios`, { fecha: a.fecha, residenteId: a.residenteId }));
    }
  }

  // ── INV-8b: rotación de días por residente ──
  const idsCon3P = new Set([...Object.keys(historial3P), ...thisMonth3P.map((a) => a.residenteId)]);
  for (const id of idsCon3P) {
    const historial = (historial3P[id] || []).slice().sort(compareISO);
    const propiasMes = thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha);
    const combinadas = historial.concat(propiasMes); // ya cronológicas (historial < mes)
    let cycle = new Set();
    for (const fecha of combinadas) {
      const wd = weekday(fecha);
      if (cycle.has(wd)) {
        if (inMonth(fecha, mes, anio)) {
          violations.push(err(`${id} repite ${wd} en 3P el ${fecha} sin completar el ciclo de 7 días`, { fecha, residenteId: id }));
        }
        // no se reinicia el ciclo por una repetición; se sigue evaluando
      } else {
        cycle.add(wd);
        if (cycle.size === 7) cycle = new Set(); // ciclo completo → se reinicia
      }
    }
  }

  // ── INV-8d: prioridad mochila ──
  const days = datesOfMonth(anio, mes);
  const mochilaDays = new Set();
  for (const a of asignaciones) {
    if (!["G", "GF", "GP"].includes(a.codigo)) continue;
    const r = byId.get(a.residenteId);
    if (r && levelOn(periodsOf(r), a.fecha) === "R1") mochilaDays.add(a.fecha);
  }
  const days3P = new Set(thisMonth3P.map((a) => a.fecha));
  const uncoveredMochila = [...mochilaDays].filter((d) => !days3P.has(d)).sort(compareISO);
  const misplaced = thisMonth3P.filter((a) => !mochilaDays.has(a.fecha)); // 3P en día sin R1
  if (uncoveredMochila.length && misplaced.length) {
    const dia = uncoveredMochila[0];
    const culpable = misplaced[0];
    // AVISO: el 3P es voluntario; la mala priorización se señala pero no impide VALIDAR.
    violations.push(aviso(`Existe 3P el ${culpable.fecha} (día sin R1) mientras el día de mochila ${dia} queda sin 3P: los 3P deben cubrir primero los días con R1`, { fecha: dia, residenteId: culpable.residenteId }));
  }

  // ── INV-8c: equidad al cierre del año de residencia ──
  // Agrupa voluntarios que cierran su año de residencia ESTE mes, por cohorte.
  const cerrandoPorCohorte = new Map();
  for (const id of voluntarios) {
    const r = byId.get(id);
    if (!r) continue;
    const win = closingWindowThisMonth(r, mes, anio);
    if (!win) continue;
    const acumulado = countThirdPostInWindow(id, historial3P, thisMonth3P, win);
    const cohorte = Number(r.fechaInicio.slice(0, 4));
    if (!cerrandoPorCohorte.has(cohorte)) cerrandoPorCohorte.set(cohorte, []);
    cerrandoPorCohorte.get(cohorte).push({ id, acumulado });
  }
  for (const [, grupo] of cerrandoPorCohorte) {
    if (grupo.length < 2) continue;
    const cuentas = grupo.map((x) => x.acumulado);
    const max = Math.max(...cuentas), min = Math.min(...cuentas);
    if (max - min > 1) {
      const maxId = grupo.find((x) => x.acumulado === max).id;
      // Equidad → aviso, nunca error (decisión V-14): es el mismo criterio que INV-3.
      violations.push(aviso(`Diferencia de 3P acumulados > 1 al cierre del año de residencia: ${grupo.map((x) => `${x.id}: ${x.acumulado}`).join(", ")}`, { residenteId: maxId }));
    }
  }

  return violations;
}

/** Si el residente cierra un año de residencia dentro de [mes/anio], devuelve la ventana [inicio, cierre]. */
function closingWindowThisMonth(r, mes, anio) {
  for (let k = 1; k <= 4; k++) {
    const cierre = addDays(addYears(r.fechaInicio, k), -1);
    if (inMonth(cierre, mes, anio)) return { start: addYears(r.fechaInicio, k - 1), end: cierre };
  }
  return null;
}

function countThirdPostInWindow(id, historial3P, thisMonth3P, win) {
  const todas = (historial3P[id] || []).concat(thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha));
  return todas.filter((f) => inRange(f, win.start, win.end)).length;
}

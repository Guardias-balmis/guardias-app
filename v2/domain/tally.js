// Contaje de guardias (spec.md §4). Réplica de los SUMPRODUCT del Excel, con la
// mejora del doblete de borde de mes (S-5). Deliberadamente "tonto": cuenta códigos
// por fecha; la coherencia código-vs-festivo la valida otro invariante, no esto.
//
// Una guardia computable = código G/GF/GP sin `origen` (cedida/comprada). El 3P y las
// cedidas/compradas se registran en contadores propios y quedan fuera de la equidad
// (INV-4). Los contadores se SOLAPAN: una GF en sábado suma a total, finde y festivos.

import { weekday, addDays, compareISO, parseISO } from "./calendar.js";

const GUARDIA = new Set(["G", "GF", "GP"]);

/** ¿La asignación es una guardia computable (ocupa puesto y cuenta para equidad)? */
function isComputable(asig) {
  return GUARDIA.has(asig.codigo) && !asig.origen;
}

function inWindow(fecha, window) {
  return compareISO(fecha, window.start) >= 0 && compareISO(fecha, window.end) <= 0;
}

/**
 * Contaje de un ÚNICO residente sobre una ventana [start, end] inclusive.
 * @param {{residenteId?:string, fecha:string, codigo:string, origen?:string}[]} asignaciones
 *        Asignaciones de un solo residente. La lista completa (incluidas fechas fuera de
 *        la ventana) se usa para el lookahead del doblete; solo las de dentro cuentan.
 * @param {{start:string, end:string}} window
 * @returns {{total:number, finde:number, festivos:number, prefestivos:number,
 *            dobletes:number, tercerPuesto:number, cedidasCompradas:number}}
 */
export function tally(asignaciones, window) {
  parseISO(window.start);
  parseISO(window.end);
  // Defensa: mezclar residentes produciría dobletes fantasma (INV-C9).
  const ids = new Set(asignaciones.map((x) => x.residenteId).filter((v) => v !== undefined));
  if (ids.size > 1) {
    throw new Error(`tally espera asignaciones de un solo residente (hay ${ids.size}); usa tallyByResident`);
  }

  // Índice por fecha para el lookahead del doblete (código+origen del día).
  const byDate = new Map();
  for (const asg of asignaciones) byDate.set(asg.fecha, asg);

  const counters = { total: 0, finde: 0, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 };

  for (const asg of asignaciones) {
    if (!inWindow(asg.fecha, window)) continue; // solo cuenta lo de dentro de la ventana

    if (asg.codigo === "3P") { counters.tercerPuesto++; continue; }
    if (asg.origen) { counters.cedidasCompradas++; continue; } // registrada aparte, no computa

    if (!GUARDIA.has(asg.codigo)) continue; // V/R/B: no suman a ningún contador

    counters.total++;
    if (weekday(asg.fecha) === "S" || weekday(asg.fecha) === "D") counters.finde++;
    if (asg.codigo === "GF") counters.festivos++;
    if (asg.codigo === "GP") counters.prefestivos++;

    // Doblete V-D: viernes computable + domingo (+2) computable, mismo residente.
    // Lookahead más allá de la ventana; se atribuye al mes del VIERNES (S-5).
    if (weekday(asg.fecha) === "V") {
      const sunday = byDate.get(addDays(asg.fecha, 2));
      if (sunday && isComputable(sunday)) counters.dobletes++;
    }
  }
  return counters;
}

/**
 * Contaje de todos los residentes de una lista mixta.
 * @returns {Map<string, ReturnType<typeof tally>>} residenteId → contaje
 */
export function tallyByResident(asignaciones, window) {
  const groups = new Map();
  for (const asg of asignaciones) {
    if (asg.residenteId === undefined || asg.residenteId === null) {
      throw new Error("tallyByResident requiere residenteId en cada asignación");
    }
    if (!groups.has(asg.residenteId)) groups.set(asg.residenteId, []);
    groups.get(asg.residenteId).push(asg);
  }
  const out = new Map();
  for (const [id, list] of groups) out.set(id, tally(list, window));
  return out;
}

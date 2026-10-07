// Contaje acumulado por residente para el generador «prompt portátil» (Fase 6.1).
// spec.md §4: "la ventana es del residente (su año de residencia, aniversario→aniversario)".
// No reimplementa tally (§4, S-5): solo resuelve, por residente, la ventana [inicio de su
// periodo formativo en curso .. hasta] y delega el contaje.

import { addDays, addYears } from "./calendar.js";
import { periodsOfResident, periodOn } from "./residents.js";
import { tally } from "./tally.js";

const ZERO = { total: 0, finde: 0, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 };

/**
 * @param {{id:string, fechaInicio:string, fechaFin?:string}[]} residentes
 * @param {{residenteId:string, fecha:string, codigo:string, origen?:string}[]} asignaciones
 *        de cualquier residente y cualquier rango; se filtra por residente internamente.
 *        Debe incluir el lookahead de doblete (~2 días tras `hasta`, C-1) si se quiere que
 *        cuente el doblete de borde.
 * @param {string} hasta  ISO, normalmente el último día del mes anterior al que se genera
 * @returns {Map<string, ReturnType<typeof tally>>} residenteId → contaje acumulado (todo a
 *          cero si su año de residencia en curso, a la fecha `hasta`, aún no ha empezado)
 */
export function accumulatedTally(residentes, asignaciones, hasta) {
  const out = new Map();
  for (const r of residentes) {
    const periods = periodsOfResident(r);
    // El periodo se busca a `hasta+1` (el primer día del mes que se va a generar), no a
    // `hasta`: así, si el aniversario cae exactamente ese día, ya se usa el periodo NUEVO.
    // Caso límite intencional: cuando eso ocurre, `periodoActual.start` (el aniversario)
    // es POSTERIOR a `hasta` (el día anterior), así que la ventana pasada a `tally` queda
    // invertida (`start > end`) y `tally` la computa en silencio como todo-cero — que es
    // el resultado CORRECTO (spec.md §4: el año de residencia nuevo aún no lleva ninguna
    // guardia el día antes de empezar), no un bug de `tally`. No "arreglar" esto asumiendo
    // que hay que arrastrar el contaje del año saliente: ver el test del caso límite.
    const periodoActual = periodOn(periods, addDays(hasta, 1));
    if (!periodoActual) {
      out.set(r.id, { ...ZERO });
      continue;
    }
    const propias = asignaciones.filter((a) => a.residenteId === r.id);
    out.set(r.id, tally(propias, { start: periodoActual.start, end: hasta }));
  }
  return out;
}

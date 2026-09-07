// Periodos formativos, nivel y grupo (spec.md §3.1–3.3, decisiones S-2 y S-3).
// El nivel R1-R4 NUNCA se almacena: se deriva de fechas. Nadie "sube categorías",
// nadie borra residentes — FINALIZADO desaparece de las listas por cálculo con el
// historial intacto. (Sustituye a AdminScreen.subirCategoria del cliente v1 y a la
// fórmula por año-entero de Residentes!C6 del Excel, que no expresaba la nota [a].)

import { parseISO, addDays, addYears, compareISO } from "./calendar.js";

export const LEVELS = ["R1", "R2", "R3", "R4"];

/**
 * Genera los 4 periodos formativos por aniversario (spec §3.1).
 * R1..R3 terminan la víspera del aniversario; R4 termina en fechaFin
 * (que puede no ser aniversario exacto: las bajas alargan la residencia).
 * Los periodos generados son editables después — nota [a] de la normativa.
 * @param {string} startDate ISO — fecha de incorporación (p.ej. "2024-05-07")
 * @param {string} endDate ISO — fecha de fin de residencia
 * @returns {{year: number, start: string, end: string}[]}
 */
export function defaultTrainingPeriods(startDate, endDate) {
  parseISO(startDate);
  parseISO(endDate);
  const periods = [];
  for (let year = 1; year <= 4; year++) {
    const start = addYears(startDate, year - 1);
    const end = year < 4 ? addDays(addYears(startDate, year), -1) : endDate;
    periods.push({ year, start, end });
  }
  return periods;
}

/**
 * Nivel formativo en una fecha (spec §3.2):
 *  - PENDIENTE antes del primer periodo; FINALIZADO tras el último.
 *  - Si no: el último periodo cuyo inicio ≤ fecha. En un hueco entre periodos se
 *    conserva el nivel anterior (S-3: una baja retrasa la promoción, no des-promociona).
 * @returns {"R1"|"R2"|"R3"|"R4"|"PENDIENTE"|"FINALIZADO"}
 */
export function levelOn(periods, iso) {
  parseISO(iso);
  if (compareISO(iso, periods[0].start) < 0) return "PENDIENTE";
  const last = periods[periods.length - 1];
  if (compareISO(iso, last.end) > 0) return "FINALIZADO";
  let current = null;
  for (const p of periods) {
    if (compareISO(p.start, iso) <= 0) current = p;
  }
  return `R${current.year}`;
}

/**
 * El periodo formativo (objeto, no la etiqueta "R{k}") que contiene una fecha —
 * misma semántica que `levelOn` (S-3: en un hueco se conserva el periodo anterior),
 * pero devuelve el registro completo {year,start,end} en vez de la cadena. Base del
 * contaje acumulado del generador (spec §4: "la ventana es del residente").
 * @returns {{year:number,start:string,end:string}|null} null si PENDIENTE o FINALIZADO
 */
export function periodOn(periods, iso) {
  parseISO(iso);
  if (compareISO(iso, periods[0].start) < 0) return null;
  const last = periods[periods.length - 1];
  if (compareISO(iso, last.end) > 0) return null;
  let current = null;
  for (const p of periods) {
    if (compareISO(p.start, iso) <= 0) current = p;
  }
  return current;
}

/**
 * Grupo de guardia por nivel (normativa: dos puestos, Mayor y Pequeño).
 * @returns {"MAYOR"|"PEQUENO"|null} null si no es asignable (PENDIENTE/FINALIZADO)
 */
export function groupOf(level) {
  if (level === "R3" || level === "R4") return "MAYOR";
  if (level === "R1" || level === "R2") return "PEQUENO";
  return null;
}

/** Activo = tiene nivel R1-R4 en esa fecha. Derivado, jamás almacenado. */
export function isActiveOn(periods, iso) {
  return LEVELS.includes(levelOn(periods, iso));
}

/**
 * Periodos de un RESIDENTE (no de una lista de periodos ya calculada): usa los editados si los
 * trae —bajas, nota [a]— y si no los deriva de fechaInicio/fechaFin, con el fallback de 4 años
 * cuando no hay fechaFin. Existe para dejar de repetir ese mismo `fechaFin || addDays(addYears(
 * …, 4), -1)` en cada fichero que necesita el nivel de alguien: era la misma línea copiada en
 * siete sitios (deuda registrada en spec.md §6, retrospectiva de la Fase 6.1).
 */
export function periodsOfResident(residente) {
  if (residente.periodos) return residente.periodos;
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/**
 * Grupo de guardia de un residente en una fecha: MAYOR (R3/R4), PEQUENO (R1/R2) o null si ese
 * día no es asignable (PENDIENTE/FINALIZADO). Atajo sobre `periodsOfResident`+`levelOn`+
 * `groupOf` para quien parte del residente y no de sus periodos.
 */
export function groupOnDate(residente, iso) {
  return groupOf(levelOn(periodsOfResident(residente), iso));
}

/**
 * Valida una lista de periodos (tras edición manual): exactamente 4, años 1..4 en
 * orden, cada periodo con inicio ≤ fin, sin solapes. Los huecos SÍ se permiten (S-3).
 * @returns {string[]} lista de errores en español, vacía si es válida
 */
export function validateTrainingPeriods(periods) {
  const errors = [];
  if (!Array.isArray(periods) || periods.length !== 4) {
    errors.push(`Se esperan exactamente 4 periodos formativos (hay ${periods?.length ?? 0})`);
    return errors;
  }
  periods.forEach((p, i) => {
    if (p.year !== i + 1) errors.push(`El periodo ${i + 1} tiene anio=${p.year}; deben ser 1,2,3,4 en orden`);
    if (compareISO(p.start, p.end) > 0) errors.push(`Periodo R${p.year}: inicio (${p.start}) posterior al fin (${p.end})`);
  });
  for (let i = 1; i < periods.length; i++) {
    if (compareISO(periods[i].start, periods[i - 1].end) <= 0) {
      errors.push(`Periodo R${periods[i].year} se solapa con R${periods[i - 1].year} (${periods[i].start} ≤ ${periods[i - 1].end})`);
    }
  }
  return errors;
}

/**
 * La ventana [inicio, cierre] del año de residencia que TERMINA dentro de `mes/anio`, o null si
 * ese mes no cierra ninguno. ÚNICA definición (2026-09-04): `equity.js` la tenía sobre
 * `periodsOfResident` y `thirdpost.js` sobre el aniversario nominal, así que con unos periodos
 * editados (nota [a]) el mismo residente cerraba su año en un mes para INV-3 y en otro para INV-8
 * — justo la incoherencia entre módulos que V-24 vino a quitar.
 *
 * Devuelve también `year` (1..4) desde V-48: el cierre anual de INV-3 compara a quien cierra con
 * los de su cohorte que cerraron ESE MISMO año de residencia meses antes, y «el mismo año» es el
 * índice del periodo, no el año natural en que acaba.
 *
 * Dos casos que NO cierran nada, a propósito (`esCierreReal`):
 *  - Quien dejó la residencia antes del fin nominal (`fechaFin` dentro de R2, digamos): sus
 *    periodos R2/R3 derivados siguen «terminando» en mayo, pero ya no estaba — compararlo con su
 *    cohorte daría ceros contra guardias reales en todos los ejes, dos mayos seguidos.
 *  - Una ventana invertida (inicio > fin), que es lo que le queda a ese mismo residente como R4:
 *    `tally` no contaría nada en ella y saldrían los mismos ceros.
 */
export function closingPeriodOn(residente, mes, anio) {
  const periodos = periodsOfResident(residente);
  const finReal = periodos[periodos.length - 1].end;
  const prefijo = `${anio}-${String(mes).padStart(2, "0")}`;
  const p = periodos.find((per) => String(per.end).startsWith(prefijo));
  if (!p || !esCierreReal(p, finReal)) return null;
  return { year: p.year, start: p.start, end: p.end };
}

/**
 * Los años de residencia de este residente que CERRARON con fecha de cierre dentro de
 * [desde, hasta] (inclusive), con el mismo criterio de «cierre real» que `closingPeriodOn`.
 * Existe para V-48: `equity.js:earlierClosedPeers` busca con ella a los compañeros de cohorte
 * que ya cerraron el año que otro cierra este mes. Si el criterio de qué es un cierre cambia,
 * cambia aquí para los dos — no lo repitas en el invocador.
 */
export function closedPeriodsBetween(residente, desde, hasta) {
  const periodos = periodsOfResident(residente);
  const finReal = periodos[periodos.length - 1].end;
  // Tolerante con un periodo mal escrito a mano en el Sheet (una celda de `fechaFin` vaciada o
  // con «30/05/2024»): esto recorre TODOS los periodos de TODOS los residentes cada vez que
  // alguien cierra su año, incluidos los de un FINALIZADO de hace años, y `compareISO` lanza
  // ante lo que no es ISO. `closingPeriodOn` solo compara el periodo que acaba en el mes (y
  // `levelOn` el primero y el último), así que ese dato roto pasaba desapercibido hasta aquí —
  // y tumbaba la validación entera del mes con un «Fecha ISO inválida» que no nombraba fila.
  // Mismo criterio que el validador con `festivos`: una fila ilegible no tumba el cierre.
  if (!esISO(finReal)) return [];
  return periodos
    .filter((p) => esISO(p.start) && esISO(p.end) && compareISO(p.end, desde) >= 0 && compareISO(p.end, hasta) <= 0 && esCierreReal(p, finReal))
    .map((p) => ({ year: p.year, start: p.start, end: p.end }));
}

const esISO = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function esCierreReal(p, finReal) {
  return compareISO(p.end, finReal) <= 0 && compareISO(p.start, p.end) <= 0;
}

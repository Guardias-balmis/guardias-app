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

// Calendario puro de guardias-app (spec.md §3.4, decisión S-1).
// Convenciones que matan la clase de bug del cliente v1 (desfase +1 mes):
//   - Las fechas son SIEMPRE strings ISO "YYYY-MM-DD" validados estrictamente.
//   - Los meses son 1-12 en todo el dominio (nunca los índices 0-11 de JS).
//   - Toda la aritmética usa Date.UTC: inmune a la zona horaria del navegador.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Días de la semana en notación del servicio (coincide con el Excel: L,M,X,J,V,S,D).
// Indexado por getUTCDay() de JS (0 = domingo).
const WEEKDAY_BY_UTC_DAY = ["D", "L", "M", "X", "J", "V", "S"];

/**
 * Valida y descompone una fecha ISO "YYYY-MM-DD".
 * Rechaza formatos laxos ("2026-2-1") y fechas inexistentes ("2027-02-29").
 * @param {string} iso
 * @returns {{year: number, month: number, day: number}} mes 1-12
 */
export function parseISO(iso) {
  const match = typeof iso === "string" ? ISO_RE.exec(iso) : null;
  if (!match) throw new Error(`Fecha ISO inválida: ${JSON.stringify(iso)} (se espera "YYYY-MM-DD")`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip por UTC: si la fecha no existe, Date la normaliza y no coincide.
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`Fecha inexistente: ${iso}`);
  }
  return { year, month, day };
}

/**
 * Compone una fecha ISO con relleno de ceros.
 * @param {number} year @param {number} month 1-12 @param {number} day
 */
export function toISO(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const iso = `${year}-${mm}-${dd}`;
  parseISO(iso); // valida que la fecha exista
  return iso;
}

/** Día de la semana: "L","M","X","J","V","S","D". */
export function weekday(iso) {
  const { year, month, day } = parseISO(iso);
  return WEEKDAY_BY_UTC_DAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** Fin de semana = sábado o domingo. (El viernes NO lo es: cuenta aparte para dobletes V-D.) */
export function isWeekend(iso) {
  const w = weekday(iso);
  return w === "S" || w === "D";
}

/** Suma (o resta) días cruzando meses y años sin sorpresas de zona horaria. */
export function addDays(iso, days) {
  const { year, month, day } = parseISO(iso);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Suma años. Un 29-feb en año destino no bisiesto se ajusta a 28-feb
 * (spec §3.1: aniversarios de residencia).
 */
export function addYears(iso, years) {
  const { year, month, day } = parseISO(iso);
  const targetYear = year + years;
  const clampedDay = Math.min(day, daysInMonth(targetYear, month));
  return toISO(targetYear, month, clampedDay);
}

/** Días del mes (mes 1-12). */
export function daysInMonth(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Mes inválido: ${month} (se espera 1-12)`);
  }
  // Día 0 del mes siguiente = último día de este mes. UTC para evitar timezones.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Todas las fechas ISO del mes, en orden. */
export function datesOfMonth(year, month) {
  const n = daysInMonth(year, month);
  const dates = [];
  for (let day = 1; day <= n; day++) dates.push(toISO(year, month, day));
  return dates;
}

/**
 * Año académico del servicio: empieza en junio.
 * jun-2026 … may-2027 → 2026. (spec §3.4)
 */
export function academicYearOf(iso) {
  const { year, month } = parseISO(iso);
  return month >= 6 ? year : year - 1;
}

/**
 * Trimestre del contaje: T1 jun-ago, T2 sep-nov, T3 dic-feb, T4 mar-may.
 * T3 cruza el año natural — pertenencia por mes, jamás por posición de fila
 * (el .xlsm troceaba por rangos de fila y se desalineaba en silencio).
 */
export function trimesterOf(iso) {
  const { month } = parseISO(iso);
  if (month >= 6 && month <= 8) return "T1";
  if (month >= 9 && month <= 11) return "T2";
  if (month === 12 || month <= 2) return "T3";
  return "T4";
}

/** Comparación cronológica (-1/0/1). Valida ambas fechas: el orden lexicográfico solo es fiable en ISO estricto. */
export function compareISO(a, b) {
  parseISO(a);
  parseISO(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

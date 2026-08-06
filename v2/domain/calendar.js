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

/**
 * Suma (o resta) meses conservando el día, con el mismo recorte que `addYears` cuando el mes
 * destino es más corto (31-ene + 1 mes → 28-feb). La usa el compromiso de permanencia del
 * voluntariado de 3P (INV-8), que se cuenta en meses y no en días.
 */
export function addMonths(iso, months) {
  const { year, month, day } = parseISO(iso);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1; // siempre 1-12, también con `months` negativo
  return toISO(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
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

// Trimestre del contaje: T1 jun-ago, T2 sep-nov, T3 dic-feb, T4 mar-may. Definición ÚNICA
// (la comparten `trimesterOf` y `trimesterWindow`): duplicarla es cómo el .xlsm acabó
// troceando por rangos de fila y desalineándose en silencio al insertar un residente.
const TRIMESTRES = { T1: [6, 7, 8], T2: [9, 10, 11], T3: [12, 1, 2], T4: [3, 4, 5] };

/**
 * Trimestre del contaje al que pertenece la fecha.
 * T3 cruza el año natural — pertenencia por mes, jamás por posición de fila.
 */
export function trimesterOf(iso) {
  const { month } = parseISO(iso);
  return Object.keys(TRIMESTRES).find((t) => TRIMESTRES[t].includes(month));
}

/**
 * Ventana completa del trimestre que contiene la fecha: {trimestre, start, end}, ambos
 * extremos inclusive. En T3 el año de `start` (diciembre) es el ANTERIOR al de `end`
 * (febrero) — por eso no basta con el año de la fecha suelta.
 * La usa el cierre trimestral de equidad (INV-3 trimestral, decisión V-13).
 */
export function trimesterWindow(iso) {
  const { year, month } = parseISO(iso);
  const trimestre = trimesterOf(iso);
  const meses = TRIMESTRES[trimestre];
  // T3 = dic-ene-feb: si la fecha cae en ene/feb, el diciembre que abre el trimestre es del año anterior.
  const startYear = trimestre === "T3" && month <= 2 ? year - 1 : year;
  const endYear = trimestre === "T3" ? startYear + 1 : year;
  const endMonth = meses[meses.length - 1];
  return {
    trimestre,
    start: toISO(startYear, meses[0], 1),
    end: toISO(endYear, endMonth, daysInMonth(endYear, endMonth)),
  };
}

/**
 * ¿Es festivo esa fecha? Los festivos son DATOS DE ENTRADA (S-4, §3.4): esta función no calcula
 * nada, solo consulta la lista que le pasan. Acepta la lista como fechas ISO o como registros
 * `{fecha}` (que es lo que devuelve la tabla `festivos`) para que el invocador no tenga que
 * mapear antes.
 * @param {string} iso
 * @param {(string|{fecha:string})[]} festivos
 */
export function isHoliday(iso, festivos = []) {
  parseISO(iso);
  for (const f of festivos) {
    if ((typeof f === "string" ? f : f && f.fecha) === iso) return true;
  }
  return false;
}

/**
 * Puentes del mes (§3.4, literal): día laborable L-V no festivo cuyos DOS vecinos son cada uno
 * festivo o fin de semana. Cubre el viernes tras un jueves festivo y el lunes ante un martes
 * festivo.
 *
 * Ojo al borde: los vecinos del día 1 y del último día del mes caen FUERA del mes, así que la
 * lista de festivos tiene que cubrir también esos dos días — por eso el invocador pide el rango
 * con un día de margen a cada lado y no solo el mes.
 * @returns {string[]} fechas ISO de los puentes, en orden
 */
export function bridgesOfMonth(year, month, festivos = []) {
  const esNoLaborable = (iso) => isWeekend(iso) || isHoliday(iso, festivos);
  return datesOfMonth(year, month).filter((d) => {
    if (isWeekend(d) || isHoliday(d, festivos)) return false; // el puente es un día laborable
    return esNoLaborable(addDays(d, -1)) && esNoLaborable(addDays(d, 1));
  });
}

/**
 * Puentes de un rango cualquiera de fechas, en orden. Existe porque la ventana que compara el
 * eje `puentesLibres` de INV-3 es el AÑO DE RESIDENCIA (aniversario→aniversario), que cruza dos
 * años naturales y ~13 meses: iterar `bridgesOfMonth` mes a mes en cada invocador es cómo se
 * cuela un mes de menos en uno de ellos y el eje deja de cuadrar entre cliente y servidor.
 *
 * La lista de `festivos` tiene que cubrir un día por cada lado del rango, por el mismo motivo
 * que en `bridgesOfMonth`: los vecinos del primer y del último día caen fuera.
 * @returns {string[]} fechas ISO de los puentes dentro de [desde, hasta], ambos inclusive
 */
export function bridgesBetween(desde, hasta, festivos = []) {
  const a = parseISO(desde);
  const b = parseISO(hasta);
  if (compareISO(desde, hasta) > 0) return [];
  const out = [];
  for (let year = a.year, month = a.month; year < b.year || (year === b.year && month <= b.month); ) {
    for (const d of bridgesOfMonth(year, month, festivos)) {
      if (compareISO(d, desde) >= 0 && compareISO(d, hasta) <= 0) out.push(d);
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

/** Comparación cronológica (-1/0/1). Valida ambas fechas: el orden lexicográfico solo es fiable en ISO estricto. */
export function compareISO(a, b) {
  parseISO(a);
  parseISO(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

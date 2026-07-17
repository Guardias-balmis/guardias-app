/**
 * domain.gs · guardias-app para Google Apps Script.
 * ARTEFACTO GENERADO por build/build-gas.mjs desde v2/domain/*.js — NO EDITAR A MANO.
 * Regenerar: `npm run build`. La paridad con la fuente ESM la verifica parity.test.js.
 */


// ── calendar.js ──
var Calendar = (function () {
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
function parseISO(iso) {
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
function toISO(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const iso = `${year}-${mm}-${dd}`;
  parseISO(iso); // valida que la fecha exista
  return iso;
}

/** Día de la semana: "L","M","X","J","V","S","D". */
function weekday(iso) {
  const { year, month, day } = parseISO(iso);
  return WEEKDAY_BY_UTC_DAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** Fin de semana = sábado o domingo. (El viernes NO lo es: cuenta aparte para dobletes V-D.) */
function isWeekend(iso) {
  const w = weekday(iso);
  return w === "S" || w === "D";
}

/** Suma (o resta) días cruzando meses y años sin sorpresas de zona horaria. */
function addDays(iso, days) {
  const { year, month, day } = parseISO(iso);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Suma años. Un 29-feb en año destino no bisiesto se ajusta a 28-feb
 * (spec §3.1: aniversarios de residencia).
 */
function addYears(iso, years) {
  const { year, month, day } = parseISO(iso);
  const targetYear = year + years;
  const clampedDay = Math.min(day, daysInMonth(targetYear, month));
  return toISO(targetYear, month, clampedDay);
}

/** Días del mes (mes 1-12). */
function daysInMonth(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Mes inválido: ${month} (se espera 1-12)`);
  }
  // Día 0 del mes siguiente = último día de este mes. UTC para evitar timezones.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Todas las fechas ISO del mes, en orden. */
function datesOfMonth(year, month) {
  const n = daysInMonth(year, month);
  const dates = [];
  for (let day = 1; day <= n; day++) dates.push(toISO(year, month, day));
  return dates;
}

/**
 * Año académico del servicio: empieza en junio.
 * jun-2026 … may-2027 → 2026. (spec §3.4)
 */
function academicYearOf(iso) {
  const { year, month } = parseISO(iso);
  return month >= 6 ? year : year - 1;
}

/**
 * Trimestre del contaje: T1 jun-ago, T2 sep-nov, T3 dic-feb, T4 mar-may.
 * T3 cruza el año natural — pertenencia por mes, jamás por posición de fila
 * (el .xlsm troceaba por rangos de fila y se desalineaba en silencio).
 */
function trimesterOf(iso) {
  const { month } = parseISO(iso);
  if (month >= 6 && month <= 8) return "T1";
  if (month >= 9 && month <= 11) return "T2";
  if (month === 12 || month <= 2) return "T3";
  return "T4";
}

/** Comparación cronológica (-1/0/1). Valida ambas fechas: el orden lexicográfico solo es fiable en ISO estricto. */
function compareISO(a, b) {
  parseISO(a);
  parseISO(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

  return { parseISO, toISO, weekday, isWeekend, addDays, addYears, daysInMonth, datesOfMonth, academicYearOf, trimesterOf, compareISO };
})();

// ── residents.js ──
var Residents = (function () {
// Periodos formativos, nivel y grupo (spec.md §3.1–3.3, decisiones S-2 y S-3).
// El nivel R1-R4 NUNCA se almacena: se deriva de fechas. Nadie "sube categorías",
// nadie borra residentes — FINALIZADO desaparece de las listas por cálculo con el
// historial intacto. (Sustituye a AdminScreen.subirCategoria del cliente v1 y a la
// fórmula por año-entero de Residentes!C6 del Excel, que no expresaba la nota [a].)

  const { parseISO, addDays, addYears, compareISO } = Calendar;

const LEVELS = ["R1", "R2", "R3", "R4"];

/**
 * Genera los 4 periodos formativos por aniversario (spec §3.1).
 * R1..R3 terminan la víspera del aniversario; R4 termina en fechaFin
 * (que puede no ser aniversario exacto: las bajas alargan la residencia).
 * Los periodos generados son editables después — nota [a] de la normativa.
 * @param {string} startDate ISO — fecha de incorporación (p.ej. "2024-05-07")
 * @param {string} endDate ISO — fecha de fin de residencia
 * @returns {{year: number, start: string, end: string}[]}
 */
function defaultTrainingPeriods(startDate, endDate) {
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
function levelOn(periods, iso) {
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
function groupOf(level) {
  if (level === "R3" || level === "R4") return "MAYOR";
  if (level === "R1" || level === "R2") return "PEQUENO";
  return null;
}

/** Activo = tiene nivel R1-R4 en esa fecha. Derivado, jamás almacenado. */
function isActiveOn(periods, iso) {
  return LEVELS.includes(levelOn(periods, iso));
}

/**
 * Valida una lista de periodos (tras edición manual): exactamente 4, años 1..4 en
 * orden, cada periodo con inicio ≤ fin, sin solapes. Los huecos SÍ se permiten (S-3).
 * @returns {string[]} lista de errores en español, vacía si es válida
 */
function validateTrainingPeriods(periods) {
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

  return { LEVELS, defaultTrainingPeriods, levelOn, groupOf, isActiveOn, validateTrainingPeriods };
})();

// ── tally.js ──
var Tally = (function () {
// Contaje de guardias (spec.md §4). Réplica de los SUMPRODUCT del Excel, con la
// mejora del doblete de borde de mes (S-5). Deliberadamente "tonto": cuenta códigos
// por fecha; la coherencia código-vs-festivo la valida otro invariante, no esto.
//
// Una guardia computable = código G/GF/GP sin `origen` (cedida/comprada). El 3P y las
// cedidas/compradas se registran en contadores propios y quedan fuera de la equidad
// (INV-4). Los contadores se SOLAPAN: una GF en sábado suma a total, finde y festivos.

  const { weekday, addDays, compareISO, parseISO } = Calendar;

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
function tally(asignaciones, window) {
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
function tallyByResident(asignaciones, window) {
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

  return { tally, tallyByResident };
})();

// ── thirdpost.js ──
var Thirdpost = (function () {
// Validación del tercer puesto (INV-8, spec.md §5). El 3P es siempre voluntario y se
// registra aparte. Cuatro reglas: (a) solo voluntarios; (b) rotación de días por
// residente (7 días L-D distintos antes de repetir, acumula entre meses, reinicia al
// completar el ciclo); (c) equidad ≤1 entre voluntarios al cierre del año de residencia;
// (d) prioridad a los días con R1 de "mochila". El 3P no computa en la equidad de
// guardias obligatorias (eso lo garantiza tally excluyendo 3P; aquí no se re-verifica).

  const { weekday, compareISO, addDays, addYears, datesOfMonth } = Calendar;
  const { levelOn, defaultTrainingPeriods } = Residents;

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
function validateThirdPost(ctx) {
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
      violations.push(err(`Diferencia de 3P acumulados > 1 al cierre del año de residencia: ${grupo.map((x) => `${x.id}: ${x.acumulado}`).join(", ")}`, { residenteId: maxId }));
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

  return { validateThirdPost };
})();

// ── equity.js ──
var Equity = (function () {
// Equidad al cierre del año de residencia (INV-3) y exclusión del cómputo (INV-4). spec.md §5.
// La ventana es el año de residencia INDIVIDUAL (aniversario→aniversario), no el académico
// ni el natural. Solo se evalúa en el mes que contiene el cierre; en meses intermedios la
// desigualdad es compensable (no se reporta). Se compara entre residentes del mismo año
// formativo (cohorte). La entrada imita el "Resumen" del Excel: acumulados por mes +
// asignaciones del mes validado. tally excluye 3P y cedidas/compradas → INV-4 sale gratis.

  const { compareISO, addDays, addYears, datesOfMonth, toISO } = Calendar;
  const { tally } = Tally;

const DIMS = ["total", "findes", "festivos", "prefestivos", "puentesLibres", "dobletes"];
const PROPORCIONAL = new Set(["total", "findes", "festivos", "prefestivos", "dobletes"]); // se normalizan por disponibilidad
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
function validateResidencyYearClose(ctx) {
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
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", prefestivos: "Prefestivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

  return { validateResidencyYearClose };
})();

// ── validate.js ──
var Validate = (function () {
// Validador de cuadrante mensual (spec.md §5). "La IA propone, el validador dispone":
// recibe un mes y devuelve la lista de invariantes violados. Funciones puras, sin I/O.
//
// Cubre los invariantes de ámbito mensual: INV-1, INV-2, INV-5, INV-6, INV-7, INV-9,
// INV-10, INV-11. Los de cierre de año (INV-3 equidad, INV-8 tercer puesto) viven en
// módulos aparte porque operan sobre ventanas distintas (año de residencia, historial 3P).
//
// Reconciliación INV-1/INV-9 (decisión V-1): un día con dos Pequeños AMBOS R2 lo evalúa
// INV-9 (excepción 2×R2); cualquier otro día defectuoso, INV-1. El comportamiento
// aceptar/rechazar es el de la normativa; solo se unifica qué etiqueta lo reporta.

  const { datesOfMonth, weekday, compareISO, academicYearOf, toISO, addDays } = Calendar;
  const { defaultTrainingPeriods, levelOn, groupOf } = Residents;
  const { tally } = Tally;

const GUARDIA = new Set(["G", "GF", "GP"]);          // ocupan puesto obligatorio
const ASIGNACION = new Set(["G", "GF", "GP", "3P"]); // cualquier asignación (INV-5, INV-7)
const PROVINCIAS_CERCANAS = new Set(["alicante", "valencia", "murcia", "albacete"]);
// Decisión V-8 (Fase 5.x): solo BAJA bloquea la asignación — no se puede exigir una guardia
// a alguien de baja médica/embarazo, por seguridad/legalidad. VACACIONES y ROTACION dejaron
// de bloquear (antes ambas asignaciones aquí también contaban por igual): son informativas
// para el generador, igual que una preferencia BLANDA — pero sus fechas SIGUEN alimentando
// INV-2 (exención del mínimo mensual), INV-6 (ausencias simultáneas) e INV-7 (cobertura
// viernes/sábado en rotación cercana), que las leen de `bloqueos` directamente, no de este set.
const DURO = new Set(["BAJA"]);

const err = (invariante, detalle, extra = {}) => ({ invariante, severidad: "error", detalle, ...extra });
const aviso = (invariante, detalle, extra = {}) => ({ invariante, severidad: "aviso", detalle, ...extra });

function periodsOf(residente) {
  if (residente.periodos) return residente.periodos;
  const fin = residente.fechaFin || addDays(toISO(Number(residente.fechaInicio.slice(0, 4)) + 4, Number(residente.fechaInicio.slice(5, 7)), Number(residente.fechaInicio.slice(8, 10))), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}
const cohortOf = (residente) => Number(residente.fechaInicio.slice(0, 4)); // promoción = año de inicio

function inRange(fecha, desde, hasta) {
  return compareISO(fecha, desde) >= 0 && compareISO(fecha, hasta) <= 0;
}

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, bloqueos?, excepciones?,
 *                        eventos?, designadosNavidad? }
 * @returns {{invariante:string, severidad:'error'|'aviso', fecha?:string, residenteId?:string, detalle:string}[]}
 */
function validateMonth(ctx) {
  const { mes, anio, residentes, asignaciones = [], bloqueos = [], excepciones = [], eventos = {}, designadosNavidad = [] } = ctx;
  const byId = new Map(residentes.map((r) => [r.id, r]));
  const periods = new Map(residentes.map((r) => [r.id, periodsOf(r)]));
  const levelOnDay = (id, fecha) => (periods.has(id) ? levelOn(periods.get(id), fecha) : null);

  const days = datesOfMonth(anio, mes);
  const dayset = new Set(days);
  const violations = [];

  // Índice: fecha → asignaciones de ese día (solo del mes).
  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of asignaciones) if (byDay.has(a.fecha)) byDay.get(a.fecha).push(a);

  const twoR2Justified = (fecha) => {
    const windowOk = compareISO(fecha, toISO(academicYearOf(fecha), 12, 1)) >= 0; // desde 1-dic del año académico
    const evento = (eventos.navidad?.fecha === fecha) || (eventos.despedida?.fecha === fecha);
    const exc = excepciones.some((e) => e.tipo === "2xR2" && inRange(fecha, e.desde, e.hasta));
    // Los eventos (INV-10) son una sección distinta de la normativa y eximen el 2×R2 con
    // independencia de la ventana de diciembre; la excepción documentada solo desde diciembre.
    return evento || (windowOk && exc);
  };

  // ── INV-1 / INV-9: paridad Mayor+Pequeño por día ──
  for (const fecha of days) {
    const guardias = byDay.get(fecha).filter((a) => GUARDIA.has(a.codigo));
    const roles = guardias.map((a) => ({ id: a.residenteId, level: levelOnDay(a.residenteId, fecha), group: groupOf(levelOnDay(a.residenteId, fecha)) }));
    const mayores = roles.filter((r) => r.group === "MAYOR");
    const pequenos = roles.filter((r) => r.group === "PEQUENO");

    if (guardias.length === 2 && pequenos.length === 2 && pequenos.every((p) => p.level === "R2")) {
      // Candidato 2×R2 → lo gobierna INV-9
      if (!twoR2Justified(fecha)) {
        const antesDeDiciembre = compareISO(fecha, toISO(academicYearOf(fecha), 12, 1)) < 0;
        violations.push(err("INV-9", antesDeDiciembre
          ? `2×R2 el ${fecha}: la excepción solo aplica desde diciembre del año académico`
          : `2×R2 el ${fecha}: sin justificación documentada (rotaciones de mayores o necesidad organizativa)`,
          { fecha }));
      }
      continue; // no se evalúa INV-1 en un día 2×R2
    }

    if (mayores.length === 1 && pequenos.length === 1) continue; // día correcto

    // Cualquier otra combinación es INV-1
    let detalle;
    if (mayores.length >= 2) detalle = `Dos o más Residentes Mayores el ${fecha}; falta el puesto de Pequeño`;
    else if (pequenos.length >= 2) detalle = `Dos Residentes Pequeños el ${fecha} (la excepción 2×R2 exige que ambos sean R2)`;
    else if (mayores.length === 0 && pequenos.length === 1) detalle = `Falta el puesto de Residente Mayor el ${fecha}`;
    else if (pequenos.length === 0 && mayores.length === 1) detalle = `Falta el puesto de Residente Pequeño el ${fecha}`;
    else detalle = `Día ${fecha} sin cubrir con exactamente 1 Mayor y 1 Pequeño (mayores=${mayores.length}, pequeños=${pequenos.length})`;
    violations.push(err("INV-1", detalle, { fecha }));
  }

  // ── INV-5: asignación sobre bloqueo BAJA (único motivo DURO — decisión V-8) ──
  for (const a of asignaciones) {
    if (!dayset.has(a.fecha) || !ASIGNACION.has(a.codigo)) continue;
    const hit = bloqueos.find((b) => b.residenteId === a.residenteId && DURO.has(b.motivo) && inRange(a.fecha, b.desde, b.hasta));
    if (hit) violations.push(err("INV-5", `Asignación ${a.codigo} el ${a.fecha} sobre bloqueo ${hit.motivo}`, { fecha: a.fecha, residenteId: a.residenteId }));
  }

  // ── INV-2: 4..6 guardias computables/mes ──
  const monthWindow = { start: days[0], end: days[days.length - 1] };
  for (const r of residentes) {
    const propias = asignaciones.filter((a) => a.residenteId === r.id);
    if (propias.length === 0) continue; // residente sin actividad el mes: no se le exige mínimo
    const total = tally(propias, monthWindow).total;
    if (total > 6) {
      violations.push(err("INV-2", `${r.id}: ${total} guardias computables > máximo 6`, { residenteId: r.id }));
    } else if (total < 4) {
      const esFebrero = mes === 2;
      const tieneVoB = bloqueos.some((b) => b.residenteId === r.id && (b.motivo === "VACACIONES" || b.motivo === "BAJA") && rangeIntersectsMonth(b, days));
      const nivelMedio = levelOnDay(r.id, days[Math.floor(days.length / 2)]);
      const r1Verano = nivelMedio === "R1" && (mes === 6 || mes === 7 || mes === 8);
      if (!esFebrero && !tieneVoB && !r1Verano) {
        // La normativa admite que un Pequeño toque a solo 3 por infra-oferta estructural
        // ("R pequeños: 4 guardias, e incluso alguno podría tocar a solo 3"): AVISO, no DURA.
        if (total === 3 && groupOf(nivelMedio) === "PEQUENO") {
          violations.push(aviso("INV-2", `${r.id}: ${total} guardias computables (por debajo de 4; admisible en un Pequeño por infra-oferta estructural)`, { residenteId: r.id }));
        } else {
          violations.push(err("INV-2", `${r.id}: ${total} guardias computables < mínimo 4`, { residenteId: r.id }));
        }
      }
    }
  }

  // ── INV-6: ausencias simultáneas (R + V) por cohorte, máx 2 ──
  validateSimultaneousAbsences(days, residentes, bloqueos, cohortOf, violations);

  // ── INV-7: presencia mínima en rotación cercana (solo en el mes de fin) ──
  for (const b of bloqueos) {
    if (b.motivo !== "ROTACION" || !b.provincia || !PROVINCIAS_CERCANAS.has(b.provincia.toLowerCase())) continue;
    const finEnEsteMes = Number(b.hasta.slice(0, 4)) === anio && Number(b.hasta.slice(5, 7)) === mes;
    if (!finEnEsteMes) continue;
    const period = eachDate(b.desde, b.hasta);
    const hasFriday = period.some((f) => weekday(f) === "V");
    const hasSaturday = period.some((f) => weekday(f) === "S");
    const propias = asignaciones.filter((a) => a.residenteId === b.residenteId && ASIGNACION.has(a.codigo) && inRange(a.fecha, b.desde, b.hasta));
    const cubreV = propias.some((a) => weekday(a.fecha) === "V");
    const cubreS = propias.some((a) => weekday(a.fecha) === "S");
    const faltan = [];
    if (hasFriday && !cubreV) faltan.push("viernes");
    if (hasSaturday && !cubreS) faltan.push("sábado");
    if (faltan.length) {
      violations.push(err("INV-7", `${b.residenteId}: rotación en ${b.provincia} (${b.desde}..${b.hasta}) sin guardia de ${faltan.join(" ni ")} en el cuadrante propio`, { residenteId: b.residenteId }));
    }
  }

  // ── INV-9 adicional / INV-10: eventos del servicio ──
  validateEvents(eventos, designadosNavidad, byDay, levelOnDay, dayset, violations);

  // ── INV-11: verano sin R1 + recuento entre R2 del mismo año ──
  if (mes === 6 || mes === 7 || mes === 8) {
    for (const fecha of days) {
      for (const a of byDay.get(fecha)) {
        if (GUARDIA.has(a.codigo) && levelOnDay(a.residenteId, fecha) === "R1") {
          violations.push(err("INV-11", `R1 (${a.residenteId}) asignado a guardia el ${fecha}: en junio-agosto el puesto de Pequeño lo cubren R2`, { fecha, residenteId: a.residenteId }));
        }
      }
    }
    // recuento entre R2 del mismo año (cohorte), diferencia > 1
    const lastDay = days[days.length - 1];
    const r2 = residentes.filter((r) => levelOnDay(r.id, lastDay) === "R2");
    const byCohort = new Map();
    for (const r of r2) {
      const c = cohortOf(r);
      if (!byCohort.has(c)) byCohort.set(c, []);
      const total = tally(asignaciones.filter((a) => a.residenteId === r.id), monthWindow).total;
      byCohort.get(c).push({ id: r.id, total });
    }
    for (const [, grupo] of byCohort) {
      if (grupo.length < 2) continue;
      const totals = grupo.map((g) => g.total);
      const max = Math.max(...totals), min = Math.min(...totals);
      if (max - min > 1) {
        const detalle = "Recuento de verano entre R2 del mismo año con diferencia > 1: " + grupo.map((g) => `${g.id}: ${g.total}`).join(", ");
        violations.push(aviso("INV-11", detalle + " (compensable antes del cierre del año de residencia)", { fecha: null }));
      }
    }
  }

  return violations;
}

// ── helpers ──
function eachDate(desde, hasta) {
  const out = [];
  for (let d = desde; compareISO(d, hasta) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

function rangeIntersectsMonth(b, days) {
  return days.some((d) => inRange(d, b.desde, b.hasta));
}

function validateSimultaneousAbsences(days, residentes, bloqueos, cohortOf, violations) {
  const cohortOfId = new Map(residentes.map((r) => [r.id, cohortOf(r)]));
  const AUS = new Set(["ROTACION", "VACACIONES"]); // la baja no computa
  const emittedRun = new Map(); // cohorte → estaba en exceso el día anterior

  for (const fecha of days) {
    const cohorts = new Map(); // cohorte → [{id, motivo}]
    for (const b of bloqueos) {
      if (!AUS.has(b.motivo) || !inRange(fecha, b.desde, b.hasta)) continue;
      const c = cohortOfId.get(b.residenteId);
      if (c === undefined) continue;
      if (!cohorts.has(c)) cohorts.set(c, []);
      cohorts.get(c).push({ id: b.residenteId, motivo: b.motivo, desde: b.desde });
    }
    for (const [c, ausentes] of cohorts) {
      const excess = ausentes.length > 2;
      const wasInExcess = emittedRun.get(c) || false;
      if (excess && !wasInExcess) {
        // primer día del run de exceso: atribuir
        const vacs = ausentes.filter((x) => x.motivo === "VACACIONES");
        let culpable;
        if (vacs.length) culpable = vacs[vacs.length - 1].id;            // rotación prioritaria: cede el de vacaciones
        else culpable = ausentes.slice().sort((a, b) => compareISO(a.desde, b.desde)).pop().id; // el último en incorporarse
        violations.push(err("INV-6", `Más de 2 residentes de la promoción ${c} ausentes simultáneamente el ${fecha} (${ausentes.map((a) => a.id).join(", ")})`, { fecha, residenteId: culpable }));
      }
      emittedRun.set(c, excess);
    }
    // cohortes que ya no están en exceso hoy
    for (const c of emittedRun.keys()) if (!cohorts.has(c)) emittedRun.set(c, false);
  }
}

function validateEvents(eventos, designadosNavidad, byDay, levelOnDay, dayset, violations) {
  for (const [tipo, ev] of Object.entries(eventos)) {
    if (!ev || !dayset.has(ev.fecha)) continue;
    const guardias = (byDay.get(ev.fecha) || []).filter((a) => GUARDIA.has(a.codigo));
    // Los eventos del servicio son sociales: se señalan como AVISO, no bloquean la validación.
    // ambos puestos deben ser R2
    for (const a of guardias) {
      if (levelOnDay(a.residenteId, ev.fecha) !== "R2") {
        violations.push(aviso("INV-10", `Evento (${tipo}) el ${ev.fecha}: debe cubrirse con 2 R2 y ${a.residenteId} no es R2`, { fecha: ev.fecha, residenteId: a.residenteId }));
      }
    }
    // sorteo documentado salvo voluntario único
    const voluntarios = ev.voluntarios || [];
    if (voluntarios.length !== 1 && !ev.sorteoDocumentado) {
      violations.push(aviso("INV-10", `Evento (${tipo}) el ${ev.fecha}: asignación sin sorteo documentado (exigido salvo un único voluntario)`, { fecha: ev.fecha }));
    }
    // los designados de Navidad quedan libres en la despedida
    if (tipo === "despedida") {
      for (const a of (byDay.get(ev.fecha) || [])) {
        if (designadosNavidad.includes(a.residenteId)) {
          violations.push(aviso("INV-10", `${a.residenteId} cubrió Navidad y no puede tener guardia en la despedida (${ev.fecha})`, { fecha: ev.fecha, residenteId: a.residenteId }));
        }
      }
    }
  }
}

  return { validateMonth };
})();

// ── responsible.js ──
var Responsible = (function () {
// Responsable del contaje (INV-14, spec.md). Normativa (docs/normativa.pdf): "La
// responsabilidad del contaje y organización de guardias recae sobre un R3 de enero a
// enero de R4, en ese momento un R3 del año siguiente asumirá el contaje. Está designado
// por sorteo en ausencia de voluntarios."
//
// Decisiones Fase 5 (respuestas del autor):
//  - Si se ofrecen ≥2 voluntarios (la normativa no cubre ese caso), se sortea SOLO entre
//    ellos — no entre todo el grupo de R3.
//  - La semilla la genera la capa impura (servidor), no una fuente externa. El dominio
//    nunca tira dados por su cuenta (cero I/O, S-6): `drawResponsible` es puro y
//    determinista dado (candidatos, semilla), así que el resultado sigue siendo
//    recomputable/auditable a partir del registro guardado.

  const { addDays, toISO } = Calendar;
  const { defaultTrainingPeriods, levelOn } = Residents;

const err = (detalle, extra = {}) => ({ invariante: "INV-14", severidad: "error", detalle, ...extra });

// Mismo patrón que validate.js/periodsOf: usa periodos editados si el residente los trae
// (bajas, nota [a]), si no los genera por defecto a partir de fechaInicio/fechaFin.
function periodsOf(residente) {
  if (residente.periodos) return residente.periodos;
  const fin = residente.fechaFin || addDays(toISO(Number(residente.fechaInicio.slice(0, 4)) + 4, Number(residente.fechaInicio.slice(5, 7)), Number(residente.fechaInicio.slice(8, 10))), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/**
 * Residentes con nivel R3 en `periodoInicio` (candidatos naturales al mandato), en orden
 * canónico por id — el sorteo debe ser determinista con independencia del orden de llegada
 * de `residentes`.
 * @param {object[]} residentes {id, fechaInicio, fechaFin, periodos?}
 * @param {string} periodoInicio fecha ISO (el 1 de enero del mandato)
 * @returns {string[]} ids ordenados
 */
function eligibleCandidates(residentes, periodoInicio) {
  return residentes
    .filter((r) => levelOn(periodsOf(r), periodoInicio) === "R3")
    .map((r) => r.id)
    .sort();
}

/**
 * Decide método y pool de candidatos según la normativa + decisión Fase 5: sin voluntarios
 * → sorteo entre todos los elegibles; un solo voluntario → se le asigna directo, sin
 * sorteo; dos o más voluntarios → sorteo SOLO entre ellos.
 * @param {string[]} eligibles ids de residentes con nivel R3 en periodoInicio
 * @param {string[]} voluntarios ids que se ofrecieron (se filtran a los elegibles; defensivo)
 * @returns {{metodo:'VOLUNTARIO', residenteId:string}|{metodo:'SORTEO', candidatos:string[]}}
 */
function resolveMethod(eligibles, voluntarios) {
  const pool = [...new Set(voluntarios)].filter((id) => eligibles.includes(id)).sort();
  if (pool.length === 0) return { metodo: "SORTEO", candidatos: [...eligibles].sort() };
  if (pool.length === 1) return { metodo: "VOLUNTARIO", residenteId: pool[0] };
  return { metodo: "SORTEO", candidatos: pool };
}

/**
 * Sorteo puro y determinista (FNV-1a de `semilla|candidatos-ordenados`, módulo el tamaño
 * del pool). Recomputable por cualquiera a partir del registro guardado (semilla +
 * candidatos) — cambiar cualquiera de los dos a posteriori cambia el resultado, lo que
 * hace la manipulación detectable (INV-14 la comprueba).
 * @param {string[]} candidatos
 * @param {string} semilla generada por la capa impura (servidor) al ejecutar el sorteo
 * @returns {string} residenteId elegido
 */
function drawResponsible(candidatos, semilla) {
  if (!Array.isArray(candidatos) || candidatos.length === 0) throw new Error("drawResponsible: candidatos vacío");
  if (!semilla) throw new Error("drawResponsible: semilla obligatoria");
  const orden = [...candidatos].sort();
  const clave = `${semilla}|${orden.join(",")}`;
  let h = 0x811c9dc5; // FNV-1a de 32 bits — determinista, cero dependencias (S-6)
  for (let i = 0; i < clave.length; i++) {
    h ^= clave.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return orden[(h >>> 0) % orden.length];
}

/**
 * INV-14: el responsable debe tener nivel R3 en periodoInicio, el mandato debe ir de enero
 * a enero, y el método (VOLUNTARIO/SORTEO) debe corresponder a los `voluntarios`
 * registrados (decisión Fase 5). Si es SORTEO, el resultado debe ser reproducible a partir
 * de (candidatos, semilla) — sin ellos, o si no coinciden, no es auditable.
 * @param {object} responsable {periodoInicio, periodoFin, residenteId, metodo, voluntarios,
 *                              candidatos?, semilla?, fechaSorteo?}
 * @param {object} ctx {residentes}
 * @returns {{invariante:'INV-14', severidad:'error', detalle:string, residenteId?:string, fecha?:string}[]}
 */
function validateResponsible(responsable, ctx) {
  const { residentes } = ctx;
  const violations = [];
  const titular = residentes.find((r) => r.id === responsable.residenteId);
  if (!titular) {
    violations.push(err(`El residente ${responsable.residenteId} no existe`, { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }));
    return violations;
  }

  if (levelOn(periodsOf(titular), responsable.periodoInicio) !== "R3") {
    violations.push(err(
      `${responsable.residenteId} no tiene nivel R3 en ${responsable.periodoInicio} (el mandato exige R3 al inicio del periodo)`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  const anio = Number(responsable.periodoInicio.slice(0, 4));
  const finEsperado = `${anio + 1}-01-01`;
  if (responsable.periodoInicio.slice(5) !== "01-01" || responsable.periodoFin !== finEsperado) {
    violations.push(err(
      `El mandato debe ir de enero a enero (esperado ${anio}-01-01 → ${finEsperado}; hay ${responsable.periodoInicio} → ${responsable.periodoFin})`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  const eligibles = eligibleCandidates(residentes, responsable.periodoInicio);
  const voluntarios = responsable.voluntarios || [];
  const esperado = resolveMethod(eligibles, voluntarios);

  if (esperado.metodo === "VOLUNTARIO") {
    if (responsable.metodo !== "VOLUNTARIO" || responsable.residenteId !== esperado.residenteId) {
      violations.push(err(
        `Había un único voluntario elegible (${esperado.residenteId}) para ${responsable.periodoInicio}; debía asignarse por VOLUNTARIO, no ${responsable.metodo}`,
        { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
      ));
    }
    return violations;
  }

  // esperado.metodo === "SORTEO"
  if (responsable.metodo !== "SORTEO") {
    const motivo = voluntarios.length === 0 ? "sin voluntarios" : `${voluntarios.length} voluntarios`;
    violations.push(err(
      `${motivo}: el mandato debía decidirse por SORTEO, no por ${responsable.metodo}`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
    return violations;
  }

  if (!responsable.semilla) {
    violations.push(err("Falta la semilla del sorteo: el resultado no es recomputable", { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }));
  }

  const candidatosGuardados = [...(responsable.candidatos || [])].sort();
  const candidatosEsperados = [...esperado.candidatos].sort();
  if (JSON.stringify(candidatosGuardados) !== JSON.stringify(candidatosEsperados)) {
    violations.push(err(
      `El pool de candidatos guardado (${candidatosGuardados.join(",") || "vacío"}) no coincide con el esperado (${candidatosEsperados.join(",")})`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  if (responsable.semilla && candidatosGuardados.length) {
    const recomputado = drawResponsible(responsable.candidatos, responsable.semilla);
    if (recomputado !== responsable.residenteId) {
      violations.push(err(
        `El sorteo no es reproducible: recomputar (semilla, candidatos) da ${recomputado}, el registro dice ${responsable.residenteId}`,
        { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
      ));
    }
  }

  return violations;
}

  return { eligibleCandidates, resolveMethod, drawResponsible, validateResponsible };
})();

// ── API pública ──
var Domain = Object.assign({}, Calendar, Residents, Tally, Thirdpost, Equity, Validate, Responsible);

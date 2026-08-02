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

/**
 * Suma (o resta) meses conservando el día, con el mismo recorte que `addYears` cuando el mes
 * destino es más corto (31-ene + 1 mes → 28-feb). La usa el compromiso de permanencia del
 * voluntariado de 3P (INV-8), que se cuenta en meses y no en días.
 */
function addMonths(iso, months) {
  const { year, month, day } = parseISO(iso);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1; // siempre 1-12, también con `months` negativo
  return toISO(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
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

// Trimestre del contaje: T1 jun-ago, T2 sep-nov, T3 dic-feb, T4 mar-may. Definición ÚNICA
// (la comparten `trimesterOf` y `trimesterWindow`): duplicarla es cómo el .xlsm acabó
// troceando por rangos de fila y desalineándose en silencio al insertar un residente.
const TRIMESTRES = { T1: [6, 7, 8], T2: [9, 10, 11], T3: [12, 1, 2], T4: [3, 4, 5] };

/**
 * Trimestre del contaje al que pertenece la fecha.
 * T3 cruza el año natural — pertenencia por mes, jamás por posición de fila.
 */
function trimesterOf(iso) {
  const { month } = parseISO(iso);
  return Object.keys(TRIMESTRES).find((t) => TRIMESTRES[t].includes(month));
}

/**
 * Ventana completa del trimestre que contiene la fecha: {trimestre, start, end}, ambos
 * extremos inclusive. En T3 el año de `start` (diciembre) es el ANTERIOR al de `end`
 * (febrero) — por eso no basta con el año de la fecha suelta.
 * La usa el cierre trimestral de equidad (INV-3 trimestral, decisión V-13).
 */
function trimesterWindow(iso) {
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
function isHoliday(iso, festivos = []) {
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
function bridgesOfMonth(year, month, festivos = []) {
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
function bridgesBetween(desde, hasta, festivos = []) {
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
function compareISO(a, b) {
  parseISO(a);
  parseISO(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

  return { parseISO, toISO, weekday, isWeekend, addDays, addYears, addMonths, daysInMonth, datesOfMonth, academicYearOf, trimesterOf, trimesterWindow, isHoliday, bridgesOfMonth, bridgesBetween, compareISO };
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
 * El periodo formativo (objeto, no la etiqueta "R{k}") que contiene una fecha —
 * misma semántica que `levelOn` (S-3: en un hueco se conserva el periodo anterior),
 * pero devuelve el registro completo {year,start,end} en vez de la cadena. Base del
 * contaje acumulado del generador (spec §4: "la ventana es del residente").
 * @returns {{year:number,start:string,end:string}|null} null si PENDIENTE o FINALIZADO
 */
function periodOn(periods, iso) {
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
 * Periodos de un RESIDENTE (no de una lista de periodos ya calculada): usa los editados si los
 * trae —bajas, nota [a]— y si no los deriva de fechaInicio/fechaFin, con el fallback de 4 años
 * cuando no hay fechaFin. Existe para dejar de repetir ese mismo `fechaFin || addDays(addYears(
 * …, 4), -1)` en cada fichero que necesita el nivel de alguien: era la misma línea copiada en
 * siete sitios (deuda registrada en spec.md §6, retrospectiva de la Fase 6.1).
 */
function periodsOfResident(residente) {
  if (residente.periodos) return residente.periodos;
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/**
 * Grupo de guardia de un residente en una fecha: MAYOR (R3/R4), PEQUENO (R1/R2) o null si ese
 * día no es asignable (PENDIENTE/FINALIZADO). Atajo sobre `periodsOfResident`+`levelOn`+
 * `groupOf` para quien parte del residente y no de sus periodos.
 */
function groupOnDate(residente, iso) {
  return groupOf(levelOn(periodsOfResident(residente), iso));
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

  return { LEVELS, defaultTrainingPeriods, levelOn, periodOn, groupOf, isActiveOn, periodsOfResident, groupOnDate, validateTrainingPeriods };
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

// ── absences.js ──
var Absences = (function () {
// Lectura ÚNICA de la tabla `bloqueos` (spec.md §2, decisiones V-6 y V-8). Manda esta tabla:
// una «B» pintada en la rejilla es un código de asignación y no la lee ningún invariante — la
// ausencia real es una fila de `bloqueos`.
//
// Existe porque el mismo dato se filtraba en cinco sitios con criterios escritos a mano y
// distintos entre sí (INV-5, INV-2, INV-6, INV-7 y el descuento de disponibilidad de INV-3),
// más el rango del router. Las diferencias entre esos criterios son REALES —cada invariante
// mira motivos distintos a propósito— así que este módulo no las colapsa: les pone nombre. La
// constante dice para qué invariante vale cada conjunto de motivos, y el filtro es uno solo.
//
// Lo que sí unifica de verdad es `activo`: una fila cancelada (reinsertada con activo=false,
// nunca borrada) se descarta AQUÍ. Antes eso dependía de que cada invocador se acordara de
// filtrarla antes de llamar al dominio; el día que uno no lo hiciera, un bloqueo cancelado
// habría vuelto a bloquear asignaciones sin que ningún test lo notara.

/**
 * Motivos por invariante. Cada lista es una decisión, no un detalle: cambiarla cambia
 * comportamiento, y por eso está aquí y no repetida en cinco `filter` en línea.
 */
// INV-5 (decisión V-8): solo la baja médica impide asignar. No se puede exigir una guardia a
// quien está de baja o de permiso de embarazo/paternidad; vacaciones y rotación NO bloquean.
const BLOQUEA_ASIGNACION = ["BAJA"];
// INV-2: exime del mínimo de 4 guardias/mes (spec.md §5: «febrero/vacaciones/baja/R1-verano»).
// La rotación NO exime: se sigue haciendo guardia en el hospital de origen.
const EXIME_DEL_MINIMO = ["VACACIONES", "BAJA"];
// INV-6: cuentan como «ausente» para el máximo de 2 por promoción. La baja NO computa — no es
// una ausencia que nadie haya concedido ni que se pueda repartir.
const AUSENCIA_SIMULTANEA = ["ROTACION", "VACACIONES"];
// INV-3, nota [a] de p.2: «se descontará de forma proporcional». Solo la baja.
const DESCUENTA_DISPONIBILIDAD = ["BAJA"];

// INV-7: la rotación «cercana» que obliga a cubrir viernes y sábado del periodo. La lista de
// provincias vivía duplicada en `rotationHistoryStart` y en el propio INV-7.
const PROVINCIAS_CERCANAS = new Set(["alicante", "valencia", "murcia", "albacete"]);

/** ¿Es una rotación externa lo bastante cerca como para que aplique INV-7? */
function isNearbyRotation(bloqueo) {
  return bloqueo.motivo === "ROTACION"
    && !!bloqueo.provincia
    && PROVINCIAS_CERCANAS.has(bloqueo.provincia.toLowerCase());
}

/**
 * Una fila cancelada se reinserta con `activo=false` y la original se queda (append-only): lo
 * que cuenta es el proyectado. `undefined` se toma como activa a propósito — los tests del
 * dominio y los contextos armados a mano no arrastran la columna, y exigirla convertiría en
 * "sin ausencias" justo lo que se quiere comprobar.
 */
const estaActiva = (b) => b.activo !== false;

/**
 * El lector. Todos los criterios son opcionales y se combinan con AND; sin ninguno, devuelve
 * las ausencias activas tal cual.
 *
 * @param {{residenteId?:string, desde:string, hasta:string, motivo:string, activo?:boolean}[]} bloqueos
 * @param {object} [criterios]
 *   - residenteId: solo las de ese residente
 *   - motivos: string[] — uno de los conjuntos exportados arriba, nunca una lista suelta
 *   - fecha: ISO; solo las que CUBREN ese día
 *   - desde/hasta: ISO; solo las que SOLAPAN ese rango (no las contenidas: una baja de todo el
 *     trimestre tiene que aparecer al preguntar por un mes de dentro)
 * @returns las filas originales (no copias): quien las lea sigue viendo `provincia`, `id`, etc.
 *
 * Compara cadenas y no llama a `parseISO`: esto filtra datos que un humano puede haber editado
 * a mano en el Sheet, y una fila con la fecha mal escrita no debe tumbar la validación entera.
 * En ISO estricto el orden lexicográfico y el cronológico coinciden, así que no se pierde nada.
 */
function absences(bloqueos = [], criterios = {}) {
  const { residenteId, motivos, fecha, desde, hasta } = criterios;
  return bloqueos.filter((b) => {
    if (!b || !estaActiva(b)) return false;
    if (residenteId !== undefined && b.residenteId !== residenteId) return false;
    if (motivos && !motivos.includes(b.motivo)) return false;
    if (fecha !== undefined && !(fecha >= b.desde && fecha <= b.hasta)) return false;
    if (desde !== undefined && b.hasta < desde) return false;
    if (hasta !== undefined && b.desde > hasta) return false;
    return true;
  });
}

  return { BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA, DESCUENTA_DISPONIBILIDAD, PROVINCIAS_CERCANAS, isNearbyRotation, absences };
})();

// ── imaginaria.js ──
var Imaginaria = (function () {
// Imaginaria (INV-13, spec.md §5; decisión V-20). Normativa p.4, «-Imaginaria»:
//
//   «Se dispone de dos listas de Imaginaria. Una para residentes mayores y otra para residentes
//    pequeños. En caso de incidencia, se debe intentar suplir la guardia con un residente según
//    lista del grupo del que crea la incidencia. […] La cesión/compra de guardia de incidencia
//    NO descuenta de la imaginaria.»
//
// Esto es una HERRAMIENTA, no un validador: lo que hace falta a las ocho de la mañana con una
// baja encima es saber a quién llamar, por orden. No comprueba a posteriori que quien cubrió
// fuera el que tocaba — una incidencia se resuelve por teléfono en cinco minutos y el registro
// se hace después, así que ese aviso saltaría a menudo por motivos legítimos que la app no ve
// (nadie cogía el teléfono, se cambió con otro). Por eso `validateMonth` no llama aquí.
//
// La cola NO se almacena: se registra cada cobertura real (tabla `imaginaria`) y el orden se
// DERIVA de ese historial, igual que el nivel R1-R4 se deriva de fechas (§1). Una fila menos
// que mantener sincronizada, y el «cesión/compra no descuenta» sale gratis: si nadie de la
// lista cubrió, no hay fila, y por tanto nadie se mueve.

  const { addDays } = Calendar;
  const { groupOnDate, levelOn, periodsOfResident } = Residents;

const GUARDIA = new Set(["G", "GF", "GP"]); // el 3P no ocupa puesto obligatorio

/**
 * ¿Puede este residente entrar en la lista de Imaginaria de `grupo` en esa fecha?
 *
 * Un **R1 nunca entra en la lista de Pequeños**, aunque R1 y R2 formen el grupo Pequeño para
 * todo lo demás (INV-1, INV-11). Es una excepción explícita a la agrupación general, solo para
 * Imaginaria: **no está en la normativa**, es la práctica real del servicio (P-11, decisión
 * V-20) — un R1 no puede sostener solo una guardia que aparece sin previo aviso.
 */
function isEligibleForImaginaria(residente, grupo, fecha) {
  if (groupOnDate(residente, fecha) !== grupo) return false;
  if (grupo === "PEQUENO" && levelOn(periodsOfResident(residente), fecha) === "R1") return false;
  return true;
}

/**
 * La cola de Imaginaria de un grupo para una incidencia concreta, en orden de a quién llamar.
 *
 * Orden: quien lleva más tiempo sin cubrir una Imaginaria va primero (quien no ha cubierto
 * ninguna, el primero de todos), y a igualdad, por id — el desempate tiene que ser determinista
 * o dos pantallas darían órdenes distintas para la misma incidencia.
 *
 * Se aparta a quien tenga guardia el día ANTERIOR (estaría librando) o el SIGUIENTE (para no
 * comprometer el descanso previo a esa guardia), y a quien tenga guardia la propia noche de la
 * incidencia. Tampoco está en la normativa: práctica real del servicio (V-20).
 *
 * @param {object} p
 *   - residentes, coberturas: filas de `imaginaria` (solo las activas), asignaciones
 *   - grupo: "MAYOR" | "PEQUENO" — el del puesto que hay que cubrir
 *   - fechaIncidencia: ISO
 * @returns {{residenteId:string, ultimaCobertura:string|null, apartadoPor:string|null}[]}
 *   TODA la lista elegible, en orden, con el motivo de quien queda apartado — la pantalla
 *   enseña a quién llamar y también a quién no, que es lo que evita la llamada inútil.
 */
function imaginariaQueue({ residentes = [], coberturas = [], asignaciones = [], grupo, fechaIncidencia }) {
  const vispera = addDays(fechaIncidencia, -1);
  const siguiente = addDays(fechaIncidencia, 1);

  const ultimaPorResidente = new Map();
  for (const c of coberturas) {
    if (c.activo === false) continue;
    const previa = ultimaPorResidente.get(c.residenteId);
    if (!previa || c.fechaIncidencia > previa) ultimaPorResidente.set(c.residenteId, c.fechaIncidencia);
  }

  const guardiaEn = (id, fecha) => asignaciones.some((a) => a.residenteId === id && a.fecha === fecha && GUARDIA.has(a.codigo));

  return residentes
    .filter((r) => isEligibleForImaginaria(r, grupo, fechaIncidencia))
    .map((r) => ({
      residenteId: r.id,
      ultimaCobertura: ultimaPorResidente.get(r.id) || null,
      apartadoPor: guardiaEn(r.id, fechaIncidencia) ? "tiene guardia esa misma noche"
        : guardiaEn(r.id, vispera) ? `tiene guardia el día anterior (${vispera})`
          : guardiaEn(r.id, siguiente) ? `tiene guardia el día siguiente (${siguiente})`
            : null,
    }))
    .sort((a, b) => {
      // Los apartados van al final, pero se devuelven: la pantalla dice por qué no se les llama.
      if (!a.apartadoPor !== !b.apartadoPor) return a.apartadoPor ? 1 : -1;
      if (a.ultimaCobertura !== b.ultimaCobertura) {
        if (a.ultimaCobertura === null) return -1;
        if (b.ultimaCobertura === null) return 1;
        return a.ultimaCobertura < b.ultimaCobertura ? -1 : 1;
      }
      return a.residenteId < b.residenteId ? -1 : 1; // desempate determinista
    });
}

/** A quién le toca: el primero no apartado, o `null` si no queda nadie de la lista. */
function nextForImaginaria(args) {
  const cola = imaginariaQueue(args).filter((x) => !x.apartadoPor);
  return cola.length ? cola[0].residenteId : null;
}

  return { isEligibleForImaginaria, imaginariaQueue, nextForImaginaria };
})();

// ── accumulate.js ──
var Accumulate = (function () {
// Contaje acumulado por residente para el generador «prompt portátil» (Fase 6.1).
// spec.md §4: "la ventana es del residente (su año de residencia, aniversario→aniversario)".
// No reimplementa tally (§4, S-5): solo resuelve, por residente, la ventana [inicio de su
// periodo formativo en curso .. hasta] y delega el contaje.

  const { addDays, addYears } = Calendar;
  const { defaultTrainingPeriods, periodOn } = Residents;
  const { tally } = Tally;

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
function accumulatedTally(residentes, asignaciones, hasta) {
  const out = new Map();
  for (const r of residentes) {
    const fin = r.fechaFin || addDays(addYears(r.fechaInicio, 4), -1);
    const periods = defaultTrainingPeriods(r.fechaInicio, fin);
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

  return { accumulatedTally };
})();

// ── thirdpost.js ──
var Thirdpost = (function () {
// Validación del tercer puesto (INV-8, spec.md §5). El 3P es siempre voluntario y se
// registra aparte. Cuatro reglas: (a) solo voluntarios; (b) rotación de días por
// residente (7 días L-D distintos antes de repetir, acumula entre meses, reinicia al
// completar el ciclo); (c) equidad ≤1 entre voluntarios al cierre del año de residencia;
// (d) prioridad a los días con R1 de "mochila". El 3P no computa en la equidad de
// guardias obligatorias (eso lo garantiza tally excluyendo 3P; aquí no se re-verifica).
//
// Las CUATRO son `aviso` (decisión V-18, que extiende V-14): ninguna impide validar. Las dos
// que aún eran `error` —8a, 3P a quien no consta voluntario, y 8b, repetir día de semana— lo
// dejaron de ser por el mismo motivo estructural que el resto: su causa no siempre vive en el
// cuadrante del mes. Un 3P de alguien que se apuntó después, o un ciclo que arrastra de meses
// que ya nadie va a reabrir, no se arregla moviendo una celda; y bloquear por ellas dejaría al
// servicio sin cuadrante justo en la regla más blanda que tiene la normativa («será siempre
// voluntario»). Entran en `EQUITY_INVARIANTS` de cuadrante.js, así que validar con avisos de
// INV-8 sigue exigiendo la confirmación explícita de la UI.

  const { weekday, compareISO, addDays, addMonths, addYears, datesOfMonth } = Calendar;
  const { levelOn, defaultTrainingPeriods } = Residents;

const aviso = (detalle, extra = {}) => ({ invariante: "INV-8", severidad: "aviso", detalle, ...extra });

/**
 * Meses de permanencia que asume quien se apunta al 3P (decisión V-18). El 3P es voluntario y
 * cada uno empieza el mes que quiere, pero la rotación L-D solo tiene sentido si se sostiene:
 * apuntarse y salirse a las tres semanas deja el ciclo a medias y la equidad de 8c sin con
 * quién compararse. Vive aquí, y no en el servidor ni en la pantalla, para que el texto que
 * acepta el residente y la regla que aplica el backend no puedan divergir.
 */
const THIRD_POST_PERMANENCIA_MESES = 4;

/** Último día que cubre el compromiso de permanencia de quien se apuntó el `desde`. */
function thirdPostCommitmentEnd(desde) {
  return addDays(addMonths(desde, THIRD_POST_PERMANENCIA_MESES), -1);
}

/** ¿Puede ya retirarse del 3P quien se apuntó el `desde`? (decisión V-18) */
function canWithdrawThirdPost(desde, hoy) {
  return compareISO(hoy, thirdPostCommitmentEnd(desde)) > 0;
}

function periodsOf(r) {
  return r.periodos || defaultTrainingPeriods(r.fechaInicio, r.fechaFin || addDays(addYears(r.fechaInicio, 4), -1));
}
const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, voluntarios3P, historial3P }
 *   - asignaciones: del mes (incluye 3P y guardias G/GF/GP para detectar mochila)
 *   - voluntarios3P: los voluntarios, como `string[]` de ids o como `{residenteId, desde}[]`.
 *     Con `desde` (lo que manda la tabla `voluntarios3P`) el ciclo L-D de INV-8b **se recorta a
 *     partir de esa fecha**, que es lo que exige V-18(b): cada residente empieza su ciclo el día
 *     que se apunta. Sin él —los tests que solo comprueban otras reglas— no se recorta nada.
 *     El recorte tiene que vivir AQUÍ y no en el invocador: el histórico que se lee es común a
 *     8b y a 8c (que sí necesita el año de residencia entero, más antiguo), así que recortarlo
 *     al leerlo rompería 8c, y no recortarlo mete en el ciclo de alguien los 3P que hizo antes
 *     de apuntarse. Misma tolerancia de dos formas que `calendar.js:isHoliday`.
 *   - historial3P: { id: [fechas ISO de 3P previas, cronológicas] }
 * @returns {{invariante:'INV-8', severidad:string, fecha?:string, residenteId?:string, detalle:string}[]}
 */
function validateThirdPost(ctx) {
  const { mes, anio, residentes, asignaciones = [], voluntarios3P = [], historial3P = {} } = ctx;
  const byId = new Map(residentes.map((r) => [r.id, r]));
  const voluntarios = new Set(voluntarios3P.map((v) => (typeof v === "string" ? v : v && v.residenteId)));
  const altaDe = new Map(voluntarios3P.filter((v) => v && typeof v !== "string" && v.desde).map((v) => [v.residenteId, v.desde]));
  const violations = [];

  const thisMonth3P = asignaciones.filter((a) => a.codigo === "3P").sort((a, b) => compareISO(a.fecha, b.fecha));

  // ── INV-8a: 3P solo a voluntarios ──
  for (const a of thisMonth3P) {
    if (!voluntarios.has(a.residenteId)) {
      violations.push(aviso(`3P asignado a ${a.residenteId}, que no consta en la lista de voluntarios`, { fecha: a.fecha, residenteId: a.residenteId }));
    }
  }

  // ── INV-8b: rotación de días por residente ──
  const idsCon3P = new Set([...Object.keys(historial3P), ...thisMonth3P.map((a) => a.residenteId)]);
  for (const id of idsCon3P) {
    const historial = (historial3P[id] || []).slice().sort(compareISO);
    const propiasMes = thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha);
    // El ciclo arranca en el alta del residente (V-18b): lo que hiciera antes de apuntarse —o en
    // una etapa anterior, si se retiró y volvió— no cuenta. Sin recortar, esos 3P añaden
    // repeticiones falsas y, peor, pueden completar los 7 días y reiniciar el ciclo, tapando una
    // repetición real. El histórico llega sin recortar a propósito: 8c lo necesita entero.
    const alta = altaDe.get(id);
    const combinadas = historial.concat(propiasMes).filter((f) => !alta || compareISO(f, alta) >= 0);
    let cycle = new Set();
    for (const fecha of combinadas) {
      const wd = weekday(fecha);
      if (cycle.has(wd)) {
        if (inMonth(fecha, mes, anio)) {
          violations.push(aviso(`${id} repite ${wd} en 3P el ${fecha} sin completar el ciclo de 7 días`, { fecha, residenteId: id }));
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

/**
 * Primer día de histórico de 3P que hace falta para evaluar INV-8 en este mes, o `null` si no
 * hace falta ninguno (nadie apuntado y nadie cerrando: 8a y 8d se resuelven solo con el mes).
 * Mismo papel que `rotationHistoryStart` (C-2) y `yearCloseHistoryStart`: el rango lo decide el
 * dominio, no el invocador.
 *
 * Son dos necesidades distintas y se toma la más antigua de las dos:
 *  - **8b (ciclo L-D)**: arranca el día en que cada residente SE APUNTÓ, no en un borde de
 *    calendario. Es literal de cómo funciona el 3P (decisión V-18): cada uno empieza el mes que
 *    quiere y por el día de semana que quiera, y el ciclo corre desde ahí. Por eso el `desde`
 *    del voluntariado no es un adorno del registro: es lo que acota esta lectura.
 *  - **8c (equidad al cierre)**: la ventana del año de residencia de quien lo cierre este mes,
 *    igual que INV-3.
 *
 * @param {{residenteId:string, desde:string}[]} voluntarios3P  los ACTIVOS
 * @param {{id:string, fechaInicio:string, fechaFin?:string}[]} residentes
 */
function thirdPostHistoryStart(voluntarios3P = [], residentes = [], mes, anio) {
  const byId = new Map(residentes.map((r) => [r.id, r]));
  let min = null;
  const consider = (fecha) => { if (fecha && (min === null || compareISO(fecha, min) < 0)) min = fecha; };

  for (const v of voluntarios3P) {
    consider(v.desde);
    const r = byId.get(v.residenteId);
    const win = r ? closingWindowThisMonth(r, mes, anio) : null;
    if (win) consider(win.start);
  }
  return min;
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

  return { THIRD_POST_PERMANENCIA_MESES, thirdPostCommitmentEnd, canWithdrawThirdPost, validateThirdPost, thirdPostHistoryStart };
})();

// ── equity.js ──
var Equity = (function () {
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

  const { compareISO, addDays, addYears, datesOfMonth, toISO, trimesterWindow, bridgesOfMonth, bridgesBetween } = Calendar;
  const { tally } = Tally;
  const { absences, DESCUENTA_DISPONIBILIDAD } = Absences;
  const { accumulatedTally } = Accumulate;

const DIMS = ["total", "findes", "festivos", "prefestivos", "puentesLibres", "dobletes"];
// Los tres códigos que ocupan puesto. El 3P queda fuera a propósito (INV-4): es voluntario, así
// que quien lo hace en un puente renuncia él al puente — el eje mide si el reparto se lo quitó.
// Las cedidas/compradas SÍ cuentan aquí aunque no sumen a `total`: quien tiene la fila trabaja
// ese día, que es justo lo que este eje pregunta.
const GUARDIA = ["G", "GF", "GP"];
const PROPORCIONAL = new Set(["total", "findes", "festivos", "prefestivos", "dobletes"]); // se normalizan por disponibilidad
const EPS = 1e-9;

// Severidad SIEMPRE aviso, en los dos cierres (decisión V-14): un desequilibrio de equidad se
// avisa y quien valida decide si continúa — nunca bloquea. No hay aquí ningún constructor de
// severidad "error" a propósito; si algún día hiciera falta, sería un cambio de V-14, no un
// detalle de implementación.
const warn = (detalle, extra = {}) => ({ invariante: "INV-3", severidad: "aviso", detalle, ...extra });
const cohortOf = (r) => Number(r.fechaInicio.slice(0, 4));
const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, acumulados, asignaciones?, puentesDelMes?, bloqueos?, festivos? }
 *   - acumulados: { id: {total, findes, festivos, puentesLibres, dobletes} } hasta fin del mes anterior
 *   - asignaciones: del mes validado (G/GF/GP/3P, con origen? para cedidas/compradas)
 *   - puentesDelMes: [string] fechas ISO de los puentes del mes validado, derivadas de la tabla
 *     `festivos` con `bridgesOfMonth` (V-17b: los puentes se derivan, nunca se escriben)
 *   - bloqueos: del año (para el descuento proporcional por baja, nota [a])
 *   - festivos: la lista que se usó para derivar los puentes, por AÑOS NATURALES completos (el
 *     rango lo da `yearCloseFestivosRange`). Solo sirve para saber si el eje `puentesLibres` se
 *     ha podido comprobar de verdad: `undefined` significa "el invocador no pretende comprobar
 *     puentes" (los tests del propio validador, que inyectan `acumulados` a mano) y no avisa; un
 *     array al que le falte ENTERO alguno de los años que cubre la ventana significa "ese
 *     calendario no está cargado" y sí avisa, porque si no ese eje compararía ceros y se leería
 *     como verificado (el fallo que V-13(e) dejó anotado).
 */
function validateResidencyYearClose(ctx) {
  const { mes, anio, residentes, acumulados = {}, asignaciones = [], puentesDelMes = [], bloqueos = [], festivos } = ctx;
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
    const f = availabilityFraction(win, absences(bloqueos, { residenteId: r.id, motivos: DESCUENTA_DISPONIBILIDAD }));

    const cohorte = cohortOf(r);
    if (!byCohort.has(cohorte)) byCohort.set(cohorte, []);
    byCohort.get(cohorte).push({ id: r.id, cierre: win.end, win, dims, f });
  }

  // Solo se compara dentro de una cohorte con al menos dos miembros: quien cierra su año siendo
  // el único de su promoción no tiene con quién compararse en NINGÚN eje.
  const comparables = [...byCohort.values()].filter((grupo) => grupo.length >= 2);

  // El eje `puentesLibres` se deriva de la tabla `festivos` (V-17b), y si el calendario no está
  // cargado compararía ceros y saldría "cuadrado" sin haber mirado nada. La comprobación es por
  // AÑO NATURAL, no "¿hay algún festivo en la ventana?": la ventana del cierre cruza siempre dos
  // años (el aniversario cae en mayo) y `crearFestivos` carga un año de golpe (V-17a), así que
  // "2026 cargado y 2027 no" es el estado intermedio NORMAL del sistema — y con la pregunta
  // laxa bastaba un festivo de 2026 para dar por comprobados también los puentes de 2027.
  // Tampoco aplica aquí el matiz de V-17(d) —no avisar en un febrero sin festivos—: un año
  // natural español entero sin ningún festivo no existe, solo puede ser calendario sin cargar.
  if (festivos !== undefined && comparables.length) {
    // Comparación de cadenas, no `parseISO`: esto es una heurística de "¿está cargado el
    // calendario de este año?", no aritmética de fechas, y la tabla vive en un Sheet que alguien
    // puede editar a mano — una fila con una fecha mal escrita no debe tumbar el cierre entero.
    // Misma tolerancia que `isHoliday`, que tampoco valida lo que le pasan.
    const fechaDe = (f) => (typeof f === "string" ? f : f && f.fecha) || "";
    const ventanas = comparables.flat().map((x) => x.win);
    const desde = ventanas.reduce((min, w) => (w.start < min ? w.start : min), ventanas[0].start);
    const hasta = ventanas.reduce((max, w) => (w.end > max ? w.end : max), ventanas[0].end);
    const sinCargar = [];
    for (let y = Number(desde.slice(0, 4)); y <= Number(hasta.slice(0, 4)); y++) {
      if (!festivos.some((f) => fechaDe(f).startsWith(`${y}-`))) sinCargar.push(y);
    }
    if (sinCargar.length) {
      violations.push(warn(
        `Puentes libres: no hay ningún festivo cargado de ${sinCargar.join(" ni de ")}, así que ese eje del cierre anual (ventana ${desde}→${hasta}) no se ha podido comprobar`,
        { fecha: hasta }
      ));
    }
  }

  // Comparación por dimensión dentro de cada cohorte.
  for (const grupo of comparables) {
    for (const dim of DIMS) {
      const vals = grupo.map((x) => ({ id: x.id, cierre: x.cierre, v: PROPORCIONAL.has(dim) ? x.dims[dim] / x.f : x.dims[dim] }));
      const maxEntry = vals.reduce((a, b) => (b.v > a.v ? b : a));
      const minEntry = vals.reduce((a, b) => (b.v < a.v ? b : a));
      if (maxEntry.v - minEntry.v > 1 + EPS) {
        violations.push(warn(
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
function yearCloseHistoryStart(residentes, mes, anio) {
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
 * Los puentes (fase 3 de V-17) se DERIVAN aquí de `festivos`, nunca se reciben ya calculados:
 * los del mes validado con `bridgesOfMonth`, y los anteriores —el resto del año de residencia,
 * que es lo que INV-3 compara— con `bridgesBetween` sobre la ventana de CADA residente que
 * cierra. El reparto entre `acumulados` y `puentesDelMes` no es cosmético: la contribución del
 * mes tiene que salir de `asignacionesDelMes` (lo que hay en pantalla, ediciones sin guardar
 * incluidas), mientras que la del resto del año sale de `historicas` (el store), igual que ya
 * ocurre con los otros cinco ejes.
 *
 * @param {object} args
 *   - historicas: asignaciones anteriores al mes (desde `yearCloseHistoryStart`)
 *   - asignacionesDelMes: las del mes validado (las que se están por validar, no las del store)
 *   - festivos: los de TODA la ventana del cierre con un día de margen a cada lado — el rango
 *     lo da `yearCloseFestivosRange`, no se adivina. Cruza dos años naturales porque el año de
 *     residencia va de aniversario a aniversario (en la práctica, de mayo a mayo).
 */
function buildYearCloseContext({ mes, anio, residentes, historicas = [], asignacionesDelMes = [], bloqueos = [], festivos = [] }) {
  const finAcumulado = addDays(toISO(anio, mes, 1), -1);
  const acumulado = accumulatedTally(residentes, [...historicas, ...asignacionesDelMes], finAcumulado);
  const acumulados = {};
  for (const [id, t] of acumulado) {
    // `tally` llama `finde` a lo que INV-3 compara como `findes`: la traducción vive aquí, una vez.
    acumulados[id] = { total: t.total, findes: t.finde, festivos: t.festivos, prefestivos: t.prefestivos, dobletes: t.dobletes, puentesLibres: 0 };
  }

  // Puentes libres acumulados: solo hacen falta para quien cierra su año este mes (al resto ni
  // se le compara este eje), y su ventana es la suya, no una común.
  for (const r of residentes) {
    const win = closingWindowThisMonth(r, mes, anio);
    if (!win || !acumulados[r.id] || compareISO(win.start, finAcumulado) > 0) continue;
    acumulados[r.id].puentesLibres = bridgesBetween(win.start, finAcumulado, festivos)
      .filter((p) => residentIsFreeOnBridge(r.id, historicas, p, win)).length;
  }

  return {
    mes, anio, residentes, acumulados, asignaciones: asignacionesDelMes, bloqueos, festivos,
    puentesDelMes: bridgesOfMonth(anio, mes, festivos),
  };
}

/**
 * Rango de festivos que hay que leer para evaluar el cierre ANUAL en este mes, o `null` si no
 * cierra nadie. Mismo papel que `yearCloseHistoryStart` para las asignaciones (y misma razón:
 * el invocador no puede adivinar el rango del validador — es el error que ya costó la regresión
 * del contrato C-2).
 *
 * Devuelve los AÑOS NATURALES completos que toca la ventana, más un día por cada lado, no la
 * ventana recortada. Dos motivos, y ninguno es la comodidad: (1) los vecinos del primer y del
 * último día deciden si son puente y caen fuera (§3.4); (2) el validador necesita poder
 * distinguir «este año no está cargado» de «este tramo del año no tiene festivos», y eso solo se
 * puede preguntar si ve el año entero — la ventana cruza siempre dos años naturales y la carga
 * es por año (V-17a), así que «uno sí y otro no» es el estado intermedio normal. Son ~30 filas
 * de más en el peor caso, y son inertes: `bridgesOfMonth` solo mira las fechas que le tocan.
 */
function yearCloseFestivosRange(residentes, mes, anio) {
  const desde = yearCloseHistoryStart(residentes, mes, anio);
  if (!desde) return null;
  const monthDays = datesOfMonth(anio, mes);
  const primerAnio = Number(desde.slice(0, 4));
  const ultimoAnio = Number(monthDays[monthDays.length - 1].slice(0, 4));
  return { desde: toISO(primerAnio - 1, 12, 31), hasta: toISO(ultimoAnio + 1, 1, 1) };
}

// --- Cierre de TRIMESTRE (INV-3 trimestral, P-8 / decisión V-13) ---------------------------

/**
 * Ventana del trimestre que CIERRA en este mes, o `null` si el mes no cierra ninguno (solo
 * agosto, noviembre, febrero y mayo lo hacen). Exportada porque el invocador la necesita
 * ANTES de llamar al validador, para saber qué rango de asignaciones leer del store.
 */
function quarterCloseWindow(mes, anio) {
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
function validateQuarterClose(ctx) {
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
    const diasPresente = daysInclusive(presente.start, presente.end);
    const disponibles = availableDays(presente, absences(bloqueos, { residenteId: r.id, motivos: DESCUENTA_DISPONIBILIDAD }));
    const f = disponibles / quarterDays;
    if (f < MIN_DISPONIBILIDAD) continue;

    const total = tally(asignaciones.filter((a) => a.residenteId === r.id), { start: win.start, end: win.end }).total;
    const cohorte = cohortOf(r);
    if (!byCohort.has(cohorte)) byCohort.set(cohorte, []);
    // `ajustado` se separa en sus DOS causas: la baja de la nota [a] y el simple hecho de no
    // haber estado el trimestre entero (alta a mitad, o R4 que termina). Antes las dos colgaban
    // el mismo texto y el aviso afirmaba una baja que no existía ni en la tabla de bloqueos.
    byCohort.get(cohorte).push({ id: r.id, v: total / f, porBaja: disponibles < diasPresente, parcial: diasPresente < quarterDays });
  }

  for (const [, grupo] of byCohort) {
    if (grupo.length < 2) continue;
    const maxEntry = grupo.reduce((a, b) => (b.v > a.v ? b : a));
    const minEntry = grupo.reduce((a, b) => (b.v < a.v ? b : a));
    if (maxEntry.v - minEntry.v > 1 + EPS) {
      const porBaja = maxEntry.porBaja || minEntry.porBaja;
      const parcial = maxEntry.parcial || minEntry.parcial;
      const causa = porBaja ? "por baja (nota [a])" : "por el tramo del trimestre que le correspondía";
      const ajuste = porBaja || parcial ? ` — cifras ajustadas proporcionalmente ${causa}` : "";
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

/**
 * Un puente es un DÍA suelto (§3.4), no un fin de semana largo: «puentes libres» son, literal,
 * los «días puente en los que el residente no hace guardia» (§4). Una guardia la víspera, o el
 * fin de semana contiguo, no le quita el puente: eso sería medir el descanso largo, que es
 * justamente el modelo de puntos ponderados de P-1 —propuesto y no vigente, y en contra de la
 * normativa según §8—, no el recuento entero que exige «diferencia máxima de 1».
 */
function residentIsFreeOnBridge(id, asignaciones, puente, win) {
  if (!inRange(puente, win.start, win.end)) return false; // fuera de su ventana → no es suyo
  return !asignaciones.some((a) => a.residenteId === id && GUARDIA.includes(a.codigo) && a.fecha === puente);
}

function daysInclusive(a, b) {
  let n = 0;
  for (let d = a; compareISO(d, b) <= 0; d = addDays(d, 1)) n++;
  return n;
}
const round = (x) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);
function labelDim(dim) {
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", prefestivos: "Prefestivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

  return { validateResidencyYearClose, yearCloseHistoryStart, buildYearCloseContext, yearCloseFestivosRange, quarterCloseWindow, validateQuarterClose };
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
//
// SEVERIDADES (decisión V-14, ampliada el 2026-07-26): de todo lo que vive aquí, solo tres
// cosas bloquean el paso a VALIDADO, porque son las únicas imposibles de ejecutar o ilegales:
// un día que NADIE cubre y una composición de 2+ personas que no puede ser (INV-1), una
// guardia sobre una baja médica (INV-5) y un R1 asignado en junio-agosto (INV-11). Todo lo
// demás —recuento mensual (INV-2), ausencias simultáneas (INV-6), cobertura de la rotación
// cercana (INV-7), 2×R2 sin justificar (INV-9), eventos (INV-10), equidad de verano (INV-11)—
// es `aviso`: informa y deja que quien firma el cuadrante decida. El criterio es del autor y
// tiene un motivo estructural: la app debe funcionar sin administrador, y una regla que
// bloquea por algo que no se puede corregir DENTRO de la herramienta deja al servicio sin
// cuadrante. No subir nada a `error` sin revisar V-14 en spec.md §6.

  const { datesOfMonth, weekday, compareISO, academicYearOf, toISO, addDays, isHoliday } = Calendar;
  const { defaultTrainingPeriods, levelOn, groupOf } = Residents;
  const { tally } = Tally;
  const { absences, isNearbyRotation, BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA } = Absences;

const GUARDIA = new Set(["G", "GF", "GP"]);          // ocupan puesto obligatorio
const ASIGNACION = new Set(["G", "GF", "GP", "3P"]); // cualquier asignación (INV-5, INV-7)
// Qué motivo de `bloqueos` cuenta para qué invariante vive en `absences.js`, no aquí: eran
// cinco criterios escritos a mano en cinco sitios. Decisión V-8 (Fase 5.x): solo BAJA bloquea
// la asignación —no se puede exigir una guardia a alguien de baja médica/embarazo—, mientras
// VACACIONES y ROTACION son informativas para el generador pero SIGUEN alimentando INV-2
// (exención del mínimo), INV-6 (ausencias simultáneas) e INV-7 (rotación cercana).

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
 * Contrato C-2 (§5): INV-7 evalúa una rotación cercana solo en el mes en que termina,
 * pero necesita ver las guardias del residente de TODO el periodo, que puede empezar en
 * un mes anterior al validado/generado. El cliente (Calendar.jsx, Generator.jsx) no tiene
 * asignaciones de meses anteriores por defecto — esta función le dice desde qué fecha
 * pedirlas, para no reimplementar el mismo criterio de "¿esta rotación puede disparar
 * INV-7?" (motivo, provincia cercana) en cada pantalla con su propio código.
 * @param {{motivo:string, provincia?:string, desde:string}[]} bloqueos  del equipo, ya
 *        acotados al mes en curso (p.ej. la respuesta de listBloqueos)
 * @param {string} monthStart  ISO, primer día del mes a validar/generar
 * @returns {string|null} la fecha `desde` más antigua a incluir, o null si con las
 *          asignaciones del propio mes basta (ninguna rotación cercana lo cruza)
 */
function rotationHistoryStart(bloqueos, monthStart) {
  const desdes = absences(bloqueos)
    .filter((b) => isNearbyRotation(b) && b.desde < monthStart)
    .map((b) => b.desde);
  return desdes.length === 0 ? null : desdes.reduce((min, d) => (d < min ? d : min));
}

/**
 * Ensambla el ctx que espera `validateMonth` a partir de las piezas que cada pantalla/acción ya
 * tiene cargadas por separado (residentes completos, histórico de fuera del mes ya acotado por
 * `rotationHistoryStart`/contrato C-1, asignaciones del propio mes, bloqueos) — evita reimplementar
 * la misma forma de objeto de forma independiente en Calendar.jsx, Generator.jsx y el router.
 * @param {object} p { mes, anio, residentes, historicas?, asignacionesDelMes, bloqueos }
 */
function buildMonthContext({ mes, anio, residentes, historicas = [], asignacionesDelMes, bloqueos, festivos = [], eventos = [] }) {
  return {
    mes, anio,
    residentes: residentes.map((r) => ({ id: r.id, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin })),
    asignaciones: [...historicas, ...asignacionesDelMes],
    bloqueos,
    // Los eventos llegan como FILAS de la tabla y se moldean aquí, una sola vez. Se quedan los
    // del año académico del mes validado (jun→may), que es el que empareja la Navidad de
    // diciembre con la despedida del mayo siguiente — sin eso, validar mayo no encontraría la
    // Navidad con la que comparar y la regla «los de Navidad libres en la despedida» sería muda.
    eventos: shapeEventos(eventos, toISO(anio, mes, 1)),
    // Datos de entrada, jamás derivados (S-4). Se piden con un día de margen a cada lado del mes:
    // los vecinos del día 1 y del último día caen fuera y deciden si son puente (§3.4).
    festivos,
  };
}

/**
 * Filas de `eventos` → la forma que consume `validateEvents`: `{navidad, despedida}`, solo las
 * del año académico del mes validado. `sorteoDocumentado` se DERIVA de que exista `sorteoId`
 * (una fila real en la tabla `sorteos`, reproducible) y no de un booleano autodeclarado: la
 * normativa pide sorteo justamente para que el reparto no sea a dedo.
 */
function shapeEventos(filas, monthStart) {
  const curso = academicYearOf(monthStart);
  const out = {};
  for (const e of filas) {
    if (!e || e.activo === false || academicYearOf(e.fecha) !== curso) continue;
    const clave = String(e.tipo || "").toLowerCase();
    if (clave !== "navidad" && clave !== "despedida") continue;
    out[clave] = {
      fecha: e.fecha,
      voluntarios: e.voluntarios || [],
      designados: e.designados || [],
      sorteoDocumentado: Boolean(e.sorteoId),
    };
  }
  return out;
}

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, bloqueos?, excepciones?, eventos? }
 * @returns {{invariante:string, severidad:'error'|'aviso', fecha?:string, residenteId?:string, detalle:string}[]}
 */
function validateMonth(ctx) {
  const { mes, anio, residentes, asignaciones = [], bloqueos = [], excepciones = [], eventos = {}, festivos = [] } = ctx;
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
        // Aviso, no error (V-14): la Excepcion justificada todavía no se puede registrar desde
        // la app, así que bloquear aquí impide validar un mes por algo que nadie puede resolver
        // dentro de la herramienta.
        violations.push(aviso("INV-9", antesDeDiciembre
          ? `2×R2 el ${fecha}: la excepción solo aplica desde diciembre del año académico`
          : `2×R2 el ${fecha}: sin justificación documentada (rotaciones de mayores o necesidad organizativa)`,
          { fecha }));
      }
      continue; // no se evalúa INV-1 en un día 2×R2
    }

    if (mayores.length === 1 && pequenos.length === 1) continue; // día correcto

    if (mayores.length + pequenos.length === 1) {
      // Infra-cobertura puntual admisible (decisión V-12): comida de Navidad, despedida de
      // R4, sobrecarga con rotantes externos u otra circunstancia real — cubrir con 1 sola
      // persona no bloquea, pero se avisa para que el Responsable confirme que fue
      // intencionado. 0 personas ese día sigue sin ser admisible (cae al caso general).
      const faltante = mayores.length === 1 ? "Pequeño" : "Mayor";
      violations.push(aviso("INV-1", `Guardia del ${fecha} cubierta por 1 sola persona (falta el puesto de ${faltante})`, { fecha }));
      continue;
    }

    // Cualquier otra combinación (0 personas cubriendo, o 2+ en composición incorrecta) es INV-1 duro
    let detalle;
    if (mayores.length >= 2) detalle = `Dos o más Residentes Mayores el ${fecha}; falta el puesto de Pequeño`;
    else if (pequenos.length >= 2) detalle = `Dos Residentes Pequeños el ${fecha} (la excepción 2×R2 exige que ambos sean R2)`;
    else detalle = `Día ${fecha} sin cubrir con exactamente 1 Mayor y 1 Pequeño (mayores=${mayores.length}, pequeños=${pequenos.length})`;
    violations.push(err("INV-1", detalle, { fecha }));
  }

  // ── INV-5: asignación sobre bloqueo BAJA (único motivo DURO — decisión V-8) ──
  for (const a of asignaciones) {
    if (!dayset.has(a.fecha) || !ASIGNACION.has(a.codigo)) continue;
    const hit = absences(bloqueos, { residenteId: a.residenteId, motivos: BLOQUEA_ASIGNACION, fecha: a.fecha })[0];
    if (hit) violations.push(err("INV-5", `Asignación ${a.codigo} el ${a.fecha} sobre bloqueo ${hit.motivo}`, { fecha: a.fecha, residenteId: a.residenteId }));
  }

  // ── INV-2: 4..6 guardias computables/mes ──
  const monthWindow = { start: days[0], end: days[days.length - 1] };
  for (const r of residentes) {
    const propias = asignaciones.filter((a) => a.residenteId === r.id);
    if (propias.length === 0) continue; // residente sin actividad el mes: no se le exige mínimo
    const total = tally(propias, monthWindow).total;
    // Severidad AVISO en las dos direcciones (decisión V-14, ampliada a INV-2): la normativa
    // llama a estas cifras «orientativas» con todas las letras (p.2), y el reparto real depende
    // de cuánta gente haya disponible ese mes — bloquear por ellas dejaría al servicio sin
    // cuadrante por un motivo que la propia fuente no considera obligatorio.
    if (total > 6) {
      violations.push(aviso("INV-2", `${r.id}: ${total} guardias computables > máximo 6`, { residenteId: r.id }));
    } else if (total < 4) {
      const esFebrero = mes === 2;
      const tieneVoB = absences(bloqueos, { residenteId: r.id, motivos: EXIME_DEL_MINIMO, desde: days[0], hasta: days[days.length - 1] }).length > 0;
      const nivelMedio = levelOnDay(r.id, days[Math.floor(days.length / 2)]);
      const r1Verano = nivelMedio === "R1" && (mes === 6 || mes === 7 || mes === 8);
      if (!esFebrero && !tieneVoB && !r1Verano) {
        // El mensaje sí distingue el caso que la normativa contempla expresamente ("R pequeños:
        // 4 guardias, e incluso alguno podría tocar a solo 3"): la severidad ya no los separa,
        // pero quien lee el aviso necesita saber si es un desajuste o lo esperable.
        const detalle = total === 3 && groupOf(nivelMedio) === "PEQUENO"
          ? `${r.id}: 3 guardias computables (por debajo de 4; admisible en un Pequeño por infra-oferta estructural)`
          : `${r.id}: ${total} guardias computables < mínimo 4`;
        violations.push(aviso("INV-2", detalle, { residenteId: r.id }));
      }
    }
  }

  // ── INV-6: ausencias simultáneas (R + V) por cohorte, máx 2 ──
  validateSimultaneousAbsences(days, residentes, bloqueos, cohortOf, violations);

  // ── INV-7: presencia mínima en rotación cercana (solo en el mes de fin) ──
  for (const b of absences(bloqueos)) {
    if (!isNearbyRotation(b)) continue;
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
      // Aviso, no error (V-14): puede no existir hueco de viernes o sábado dentro del periodo
      // sin romper la composición del resto del grupo — no siempre se arregla en el cuadrante.
      violations.push(aviso("INV-7", `${b.residenteId}: rotación en ${b.provincia} (${b.desde}..${b.hasta}) sin guardia de ${faltan.join(" ni ")} en el cuadrante propio`, { residenteId: b.residenteId }));
    }
  }

  // ── INV-9 adicional / INV-10: eventos del servicio ──
  validateEvents(eventos, byDay, levelOnDay, dayset, violations);

  // ── INV-12: coherencia código↔festivo (aviso siempre, V-4/V-14) ──
  // GF solo en día festivo; G y GP nunca EN festivo (un prefestivo es la víspera, no el día).
  // Sin lista de festivos no se deriva ninguno (S-4: el v1 se los pedía a la IA, prohibido). Y
  // no se avisa "falta el calendario" en todo mes vacío de festivos: febrero no tiene ninguno en
  // España, así que sería un aviso falso cada febrero. Se avisa solo cuando la falta IMPIDE
  // comprobar algo que sí se ha escrito: hay GF en el mes y no hay festivos cargados.
  const gfDelMes = asignaciones.filter((a) => a.codigo === "GF" && dayset.has(a.fecha));
  if (festivos.length === 0) {
    if (gfDelMes.length) {
      violations.push(aviso("INV-12", `Hay ${gfDelMes.length} guardia(s) marcadas GF pero no hay festivos cargados para ${anio}-${String(mes).padStart(2, "0")}: no se puede comprobar que caigan en festivo`, { fecha: gfDelMes[0].fecha }));
    }
  } else {
    for (const a of asignaciones) {
      if (!dayset.has(a.fecha)) continue;
      const esFestivo = isHoliday(a.fecha, festivos);
      if (a.codigo === "GF" && !esFestivo) {
        violations.push(aviso("INV-12", `GF el ${a.fecha}, que no consta como festivo`, { fecha: a.fecha, residenteId: a.residenteId }));
      } else if ((a.codigo === "G" || a.codigo === "GP") && esFestivo) {
        violations.push(aviso("INV-12", `${a.codigo} el ${a.fecha}, que consta como festivo (debería ser GF)`, { fecha: a.fecha, residenteId: a.residenteId }));
      }
    }
  }

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
  const emittedRun = new Map(); // cohorte → estaba en exceso el día anterior

  for (const fecha of days) {
    const cohorts = new Map(); // cohorte → [{id, motivo}]
    for (const b of absences(bloqueos, { motivos: AUSENCIA_SIMULTANEA, fecha })) {
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
        // Aviso, no error (V-14): las ausencias vienen de vacaciones y rotaciones ya
        // concedidas; el cuadrante del mes no puede deshacerlas.
        violations.push(aviso("INV-6", `Más de 2 residentes de la promoción ${c} ausentes simultáneamente el ${fecha} (${ausentes.map((a) => a.id).join(", ")})`, { fecha, residenteId: culpable }));
      }
      emittedRun.set(c, excess);
    }
    // cohortes que ya no están en exceso hoy
    for (const c of emittedRun.keys()) if (!cohorts.has(c)) emittedRun.set(c, false);
  }
}

/**
 * INV-10. `designadosNavidad` ya no es un parámetro suelto: sale de la fila del evento de
 * Navidad (decisión V-20, se ALMACENA). Antes había que pasárselo aparte y nadie lo hacía —
 * ese es medio motivo de que este invariante llevara desde la Fase 3 mudo.
 */
function validateEvents(eventos, byDay, levelOnDay, dayset, violations) {
  const designadosNavidad = (eventos.navidad && eventos.navidad.designados) || [];
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

  return { rotationHistoryStart, buildMonthContext, validateMonth };
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

// ── cuadrante.js ──
var Cuadrante = (function () {
// Ciclo de estados del Cuadrante (spec.md §2, decisión V-9/V-10, Fase 6.2):
// BORRADOR -> VALIDADO -> PUBLICADO. PURO: solo las reglas de qué transición es válida en
// qué estado. La persistencia (tabla `cuadrantes`) y el permiso por rol de sesión (V-9c: solo
// el Responsable publica/despublica) viven en server/src/router.js.

const STATES = ["BORRADOR", "VALIDADO", "PUBLICADO"];

/** BORRADOR->VALIDADO exige cero violaciones DURAS (severidad "error", spec.md §5). */
function canValidate(violaciones) {
  return violaciones.every((v) => v.severidad !== "error");
}

/**
 * Invariantes que miden EQUIDAD del reparto. Ninguno bloquea nunca (decisión V-14): un
 * desequilibrio se avisa y quien valida decide si continúa. La lista existe para que la UI
 * pueda pedir esa confirmación explícita sin reconocer mensajes por su texto — y para que
 * quien mantenga esto en 2035 vea de un vistazo qué reglas son "de equidad".
 *  - INV-3: equidad al cierre del año de residencia y del trimestre.
 *  - INV-8: diferencia de 3.º puestos acumulados entre voluntarios al cierre.
 *  - INV-11: recuento de verano entre R2 de la misma promoción.
 */
const EQUITY_INVARIANTS = ["INV-3", "INV-8", "INV-11"];

/** Los avisos de equidad de una lista de violaciones (los que exigen confirmación, V-14). */
function equityWarnings(violaciones) {
  return violaciones.filter((v) => v.severidad === "aviso" && EQUITY_INVARIANTS.includes(v.invariante));
}

/** VALIDADO->PUBLICADO. */
function canPublish(estado) {
  return estado === "VALIDADO";
}

/** PUBLICADO->VALIDADO, para corregir un cuadrante ya publicado. */
function canUnpublish(estado) {
  return estado === "PUBLICADO";
}

/** PUBLICADO bloquea cualquier edición del mes (decisión V-9b); BORRADOR/VALIDADO se pueden tocar. */
function canEdit(estado) {
  return estado !== "PUBLICADO";
}

/** Estado tras editar asignaciones: un mes VALIDADO deja de estarlo (vuelve a BORRADOR) sin
 * fricción para quien edita. PUBLICADO nunca llega aquí: `canEdit` ya bloquea el guardado antes. */
function stateAfterEdit(estado) {
  return estado === "VALIDADO" ? "BORRADOR" : estado;
}

  return { STATES, canValidate, EQUITY_INVARIANTS, equityWarnings, canPublish, canUnpublish, canEdit, stateAfterEdit };
})();

// ── projection.js ──
var Projection = (function () {
// Proyección del cuadrante a Google Sheets legible por humanos (spec.md §7, Fase 7.1,
// decisión V-11). PURO: construye filas de celdas (algunas con fórmulas de hoja de cálculo
// como texto); la escritura real (`store.rebuildSheet`) vive en server/src/router.js.
//
// Dos entregables:
//  - `buildMonthSheetRows`: 1 pestaña por mes ("YYYY-MM"), con los códigos día a día como
//    VALORES (instantánea del momento de publicar) y los totales por fila como FÓRMULAS
//    (COUNTIF/SUMPRODUCT) que solo miran el rango de días de esa misma pestaña — igual
//    idioma que "Cuadrante Anual" del .xlsm legado, adaptado de "un bloque por mes en la
//    misma hoja" a "una pestaña por mes". El doblete V-D solo puede emparejar un viernes
//    con un domingo DENTRO del propio mes (nunca ve la pestaña del mes siguiente): la misma
//    limitación que ya tenía el .xlsm, documentada y aceptada en spec.md §4 (S-5) — el
//    dominio (`tally`) sí ve ese doblete de borde; esta proyección, deliberadamente, no.
//  - `buildResumenRows`: hoja "Resumen", una fila por residente activo en algún mes
//    publicado, con SUMIF encadenado cruzando TODAS las pestañas mensuales publicadas (por
//    nombre de hoja) y la comprobación de equidad (MAXIFS/MINIFS) agrupada por COHORTE de
//    ingreso — mismo criterio que INV-3/V-2, no por nivel actual como hacía el Excel viejo.
//    Alcance provisional: acumula TODOS los meses publicados desde siempre, no por año
//    académico como el .xlsm (que se recreaba cada año) — simplificación consciente,
//    revisar si con varios años de datos reales deja de ser una lectura útil.
//
// Limitaciones conocidas y aceptadas (puerta de consistencia, revisión de 4 agentes):
//  - El SUMIF de "Resumen" cruza por NOMBRE de residente (columna A de cada pestaña
//    mensual), no por id: dos residentes con el mismo nombre exacto activos el mismo mes
//    mezclarían sus totales. Mismo riesgo que ya tenía el .xlsm legado (también por nombre);
//    no se resuelve aquí (exigiría una columna de id oculta + INDEX/MATCH).
//  - "Nivel" es un único valor por fila: un residente activo TODO el mes pero cuyo
//    aniversario cae A MITAD del mes (cambia de nivel) muestra el nivel de su PRIMER día
//    activo del mes (normalmente el día 1), no el nuevo — mismo criterio "día-1 canónico"
//    que `accumulatedTally` (spec.md §4, Fase 6.1). Cosmético: no alimenta INV-3 ni ningún
//    contaje real, que siguen mirando la fecha exacta vía `tally`/`levelOn` en el dominio.

  const { datesOfMonth, weekday, addDays, addYears } = Calendar;
  const { defaultTrainingPeriods, levelOn, isActiveOn } = Residents;

const GUARDIA_CODES = new Set(["G", "GF", "GP"]);

const FIXED_HEADERS = ["Residente", "Nivel", "G", "GF", "GP", "3P", "Fines de Semana", "Dobl. V-D", "Total"];
const LEVEL_RANK = { R4: 4, R3: 3, R2: 2, R1: 1 };
const RESUMEN_HEADER = ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Equidad (dif. ≤ 1)"];

/** Nombre de pestaña mensual: "YYYY-MM" (ordena bien alfabéticamente, sin acentos ni espacios). */
function monthSheetName(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/** Letra(s) de columna de hoja de cálculo para un índice 1-based (1→A, 26→Z, 27→AA...). */
function columnLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Mismo fallback de fechaFin que accumulate.js/validate.js (deuda preexistente conocida,
// spec.md §6 retro Fase 6.1: duplicado en 7 sitios; no se consolida aquí, fuera de alcance).
function periodsOf(residente) {
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/** Residentes activos (R1-R4) en alguna de `dates`, con su primer día activo dentro de ese conjunto. */
function activeResidents(residentes, dates) {
  return residentes
    .map((r) => ({ ...r, periods: periodsOf(r) }))
    .map((r) => ({ ...r, firstActiveDate: dates.find((d) => isActiveOn(r.periods, d)) }))
    .filter((r) => r.firstActiveDate !== undefined);
}

function finesDeSemanaFormula(rowNum, firstCol, lastCol) {
  const wk = `$${firstCol}$2:$${lastCol}$2`;
  const dia = `${firstCol}${rowNum}:${lastCol}${rowNum}`;
  return `=SUMPRODUCT(((${wk}="S")+(${wk}="D"))*((${dia}="G")+(${dia}="GF")+(${dia}="GP")))`;
}

// Empareja el día `i` con el día `i+2` (viernes→domingo) DENTRO del propio mes: el lado
// "viernes" recorre los días 1..(n-2) y el lado "domingo" 3..n, ambos de igual longitud y
// alineados posicionalmente — mismo idioma que el .xlsm legado ($I$5:$AK$5 vs $K6:$AM6).
function dobleteFormula(rowNum, firstColIdx, n) {
  if (n <= 2) return "=0"; // ningún mes real tiene ≤2 días; defensivo, no alcanzable en la práctica
  const friStart = columnLetter(firstColIdx);
  const friEnd = columnLetter(firstColIdx + (n - 2) - 1);
  const sunStart = columnLetter(firstColIdx + 2);
  const sunEnd = columnLetter(firstColIdx + n - 1);
  const wk = `$${friStart}$2:$${friEnd}$2`;
  const fri = `${friStart}${rowNum}:${friEnd}${rowNum}`;
  const sun = `${sunStart}${rowNum}:${sunEnd}${rowNum}`;
  return `=SUMPRODUCT((${wk}="V")*((${fri}="G")+(${fri}="GF")+(${fri}="GP"))*((${sun}="G")+(${sun}="GF")+(${sun}="GP")))`;
}

/**
 * Filas de la pestaña mensual (spec.md §7).
 * @param {object} p { anio, mes, residentes:{id,nombre,fechaInicio,fechaFin}[], asignaciones:{residenteId,fecha,codigo,origen?}[] del propio mes }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
function buildMonthSheetRows({ anio, mes, residentes, asignaciones }) {
  const dias = datesOfMonth(anio, mes);
  const n = dias.length;
  const firstColIdx = FIXED_HEADERS.length + 1;
  const firstCol = columnLetter(firstColIdx);
  const lastCol = columnLetter(firstColIdx - 1 + n);

  const activos = activeResidents(residentes, dias)
    .map((r) => ({ id: r.id, nombre: r.nombre, nivel: levelOn(r.periods, r.firstActiveDate) }))
    .sort((a, b) => LEVEL_RANK[b.nivel] - LEVEL_RANK[a.nivel] || a.nombre.localeCompare(b.nombre));

  // Una cedida/comprada (`origen`) NO computa (tally.js `isComputable`/INV-4): se marca con
  // "*" para que COUNTIF/SUMPRODUCT (que comparan texto exacto) la excluyan sin cambiar las
  // fórmulas. El 3P NUNCA se marca: tally.js lo cuenta como tercerPuesto con independencia
  // del origen (el chequeo de origen en tally.js ocurre DESPUÉS del chequeo de "3P").
  const porResidenteDia = new Map();
  for (const a of asignaciones) {
    if (!porResidenteDia.has(a.residenteId)) porResidenteDia.set(a.residenteId, new Map());
    const marcado = a.origen && GUARDIA_CODES.has(a.codigo) ? `${a.codigo}*` : (a.codigo || "");
    porResidenteDia.get(a.residenteId).set(a.fecha, marcado);
  }

  const rows = [
    [...FIXED_HEADERS, ...dias.map((_, i) => i + 1)],
    [...FIXED_HEADERS.map(() => ""), ...dias.map((d) => weekday(d))],
  ];
  for (const r of activos) {
    const rowNum = rows.length + 1;
    const codigos = dias.map((d) => (porResidenteDia.get(r.id) || new Map()).get(d) || "");
    rows.push([
      r.nombre, r.nivel,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"G")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"GF")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"GP")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"3P")`,
      finesDeSemanaFormula(rowNum, firstCol, lastCol),
      dobleteFormula(rowNum, firstColIdx, n),
      `=C${rowNum}+D${rowNum}+E${rowNum}`,
      ...codigos,
    ]);
  }
  return { sheetName: monthSheetName(anio, mes), rows };
}

function sumifChain(mesesOrdenados, rowNum, col) {
  if (mesesOrdenados.length === 0) return 0;
  const terms = mesesOrdenados.map((m) => {
    const hoja = monthSheetName(m.anio, m.mes);
    return `SUMIF('${hoja}'!$A:$A,$A${rowNum},'${hoja}'!$${col}:$${col})`;
  });
  return `=${terms.join("+")}`;
}

/**
 * Filas de la hoja "Resumen" (spec.md §7): equidad acumulada por cohorte de ingreso,
 * agregando por SUMIF/MAXIFS/MINIFS sobre todas las pestañas mensuales PUBLICADAS.
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[] }
 * @returns {{sheetName:"Resumen", rows:Array<Array<string|number>>}}
 */
function buildResumenRows({ residentes, publishedMonths }) {
  const meses = [...new Map(publishedMonths.map((m) => [monthSheetName(m.anio, m.mes), m])).values()]
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
  const todasLasFechas = meses.flatMap((m) => datesOfMonth(m.anio, m.mes));
  const activos = activeResidents(residentes, todasLasFechas)
    .map((r) => ({ nombre: r.nombre, cohorte: Number(r.fechaInicio.slice(0, 4)) }))
    .sort((a, b) => a.cohorte - b.cohorte || a.nombre.localeCompare(b.nombre));

  const rows = [RESUMEN_HEADER];
  for (const r of activos) {
    const rowNum = rows.length + 1;
    rows.push([
      r.nombre, r.cohorte,
      sumifChain(meses, rowNum, "I"), // Total
      sumifChain(meses, rowNum, "G"), // Fines de Semana
      sumifChain(meses, rowNum, "D"), // Festivos (columna GF de la pestaña mensual)
      sumifChain(meses, rowNum, "E"), // Prefestivos (columna GP)
      sumifChain(meses, rowNum, "H"), // Dobletes V-D
      sumifChain(meses, rowNum, "F"), // 3P
      "", "", // equidad: se rellena abajo, una vez se conoce el rango completo de filas
    ]);
  }

  // Umbral de equidad = 1, el mismo que exige INV-3 (equity.js): no se deja como celda
  // editable (a diferencia del Excel viejo) porque el validador real de la app NO lo lee
  // de aquí — un umbral "editable" en el Sheet que no afecta a INV-3 sería engañoso.
  const lastRow = rows.length;
  for (let i = 2; i <= lastRow; i++) {
    rows[i - 1][8] = `=IF($B${i}="","",MAXIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i})-MINIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i}))`;
    rows[i - 1][9] = `=IF($B${i}="","",IF(I${i}<=1,"OK","REVISAR"))`;
  }
  return { sheetName: "Resumen", rows };
}

  return { monthSheetName, columnLetter, buildMonthSheetRows, buildResumenRows };
})();

// ── API pública ──
var Domain = Object.assign({}, Calendar, Residents, Tally, Absences, Imaginaria, Accumulate, Thirdpost, Equity, Validate, Responsible, Cuadrante, Projection);

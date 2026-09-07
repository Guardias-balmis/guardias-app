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
 * Código de guardia (G/GF/GP) que corresponde a `fecha` según el calendario de festivos
 * (decisión V-41): GF si la propia fecha es festiva, GP si la fecha SIGUIENTE lo es (la víspera),
 * G en cualquier otro caso. Mismo criterio que ya lee INV-12 al revés (`G`/`GP` nunca EN festivo,
 * `GF` solo en festivo) — aquí se usa para PROPONER el código en vez de solo comprobarlo después.
 *
 * Como `isHoliday`, es una consulta pura sobre la lista que le pasan: si `festivos` no cubre el
 * año de `fecha` (o de la fecha siguiente), esto no lo sabe y devuelve G por no asumir un festivo
 * que no está cargado — el invocador es quien tiene que decidir si avisar de que no pudo comprobarlo.
 */
function autoGuardCode(fecha, festivos = []) {
  if (isHoliday(fecha, festivos)) return "GF";
  if (isHoliday(addDays(fecha, 1), festivos)) return "GP";
  return "G";
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

  return { parseISO, toISO, weekday, isWeekend, addDays, addYears, addMonths, daysInMonth, datesOfMonth, academicYearOf, trimesterOf, trimesterWindow, isHoliday, autoGuardCode, bridgesOfMonth, bridgesBetween, compareISO };
})();

// ── apply.js ──
var Apply = (function () {
// Qué hay que escribir para que el mes quede EXACTAMENTE como la propuesta que el generador
// acaba de validar. Es el lote de `cambios` para `guardarAsignaciones`.
//
// Existe porque `guardarAsignaciones` es append-only con clave `fecha|residenteId`: mandar solo
// las filas nuevas AÑADE, nunca sustituye. Una guardia previa de OTRO residente el mismo día
// sobrevivía al "aplicar", y el día acababa con tres personas — justo después de que la pantalla
// dijera «✅ Sin violaciones», porque había validado la propuesta contra un mes que creía vacío.
// Bastaba generar dos veces y que el modelo moviera a alguien de día, o generar sobre un mes ya
// empezado a mano. Borrar una asignación es escribir su misma clave con `codigo` vacío, que
// `readLatest(..., {emptyField:"codigo"})` interpreta como baja: nunca se borra una fila.
//
// Vive en el DOMINIO (y no en `client/lib`, donde nació) desde la decisión V-45: la generación se
// hace ahora en el servidor, así que el mismo plan de reemplazo lo necesitan los dos lados. Es puro
// y sin I/O como el resto del dominio: calcula QUÉ escribir, no escribe nada — igual que projection.js.

  const { datesOfMonth } = Calendar;

// Los códigos que el generador propone (el FORMATO DE RESPUESTA del prompt) y, por tanto, los
// únicos que le pertenecen y puede borrar. V/R/B son marcadores de la rejilla que nadie le ha
// pedido y que ningún invariante lee (`tally.js` solo computa G/GF/GP): borrarlos sería destruir
// datos sobre los que el generador no tiene ninguna opinión. Y la ausencia de verdad, la que sí
// leen INV-2/5/6/7, es una fila de `bloqueos` — no una «B» en la rejilla (V-19).
const PROPONIBLES = new Set(["G", "GF", "GP"]);

/**
 * Los códigos que ESTA propuesta puede borrar. El 3P entra solo si la propuesta trae 3P
 * (decisión V-38). Antes estaba fijo en la lista, y como `schedule.js` no repartía 3P, regenerar
 * un mes se llevaba por delante los 3P colocados a mano —los únicos que había— y el aviso los
 * contaba como «guardias». Es la misma regla que ya justificaba dejar fuera a V/R/B, aplicada
 * también aquí: se borra lo que se propone, y solo eso.
 */
function borrablesDe(propuesta) {
  const s = new Set(PROPONIBLES);
  if (propuesta.some((a) => a.codigo === "3P")) s.add("3P");
  return s;
}

const clave = (a) => `${a.fecha}|${a.residenteId}`; // la misma ASIG_KEY que usa el servidor

// Los marcadores que la tarjeta del generador promete conservar («las vacaciones, rotaciones y
// bajas marcadas en la rejilla se conservan»). No son ausencias (V-19: la ausencia es la fila de
// `bloqueos`), pero son celdas que alguien apuntó a mano y una guardia propuesta encima las pisaría.
const MARCADORES_REJILLA = new Set(["V", "R", "B"]);

/**
 * Claves `fecha|residenteId` que la propuesta REPITE. La tabla es una rejilla por clave y
 * `readLatest` se queda con la última fila: si el modelo devuelve para la misma persona y día una
 * G y un 3P, el validador —que juzga la LISTA— ve un día correcto y lo que se escribe es otro
 * (gana el 3P y el día se queda sin Mayor). Es un defecto de la RESPUESTA, como `fueraDelMes`.
 */
function duplicadasDe(propuesta) {
  const porClave = new Map();
  for (const a of propuesta) {
    const k = clave(a);
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(a);
  }
  // Solo cuando los códigos DIFIEREN: una fila repetida idéntica (el modelo lista una fijada dos
  // veces, como se le pide repetirlas) es inocua al escribir y se descarta en `sinRepetidas`.
  return [...porClave.values()]
    .filter((filas) => new Set(filas.map((a) => a.codigo)).size > 1)
    .map((filas) => ({ fecha: filas[0].fecha, residenteId: filas[0].residenteId, codigos: filas.map((a) => a.codigo) }));
}

/** La propuesta sin filas repetidas idénticas (misma clave y mismo código): se escribe una vez. */
function sinRepetidas(propuesta) {
  const vistas = new Set();
  return propuesta.filter((a) => {
    const k = `${clave(a)}|${a.codigo}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

/** Filas de la propuesta que caen (misma clave) sobre una celda V/R/B de la rejilla. */
function pisadosDe(propuesta, existentes) {
  const marcadorPorClave = new Map(existentes.filter((a) => MARCADORES_REJILLA.has(a.codigo)).map((a) => [clave(a), a]));
  return propuesta
    .filter((a) => marcadorPorClave.has(clave(a)))
    .map((a) => ({ propuesta: a, marcador: marcadorPorClave.get(clave(a)) }));
}

/**
 * @param {object} p
 *   - mes/anio: el mes que se está generando
 *   - residentes: los del equipo, solo para reconocer ids
 *   - existentes: lo que YA tiene el mes (`api.listAsignaciones`), tal cual llega
 *   - propuesta: las asignaciones del JSON pegado, ya parseadas
 * @returns {{cambios:object[], borradas:object[], marcadores:object[], fueraDelMes:object[],
 *            desconocidos:object[]}}
 *   - cambios: la propuesta entera MÁS una fila de borrado por cada guardia previa que la
 *     propuesta no reemplaza por clave. Las filas de la propuesta van sin `origen`, así que
 *     reemplazar una cedida/comprada la devuelve al cómputo de INV-3/INV-4 — que es exactamente
 *     lo que juzgó el validador, que tampoco vio ningún `origen`.
 *   - borradas: esas guardias previas, para poder decir en pantalla cuántas se pierden ANTES
 *     de pulsar (aplicar sobre un mes lleno es destructivo aunque el histórico se conserve).
 *   - marcadores: las filas V/R/B que se conservan intactas.
 *   - fueraDelMes: filas de la propuesta cuya fecha no es un día real de este mes. No se filtran
 *     ni se corrigen aquí: quien llame decide, porque una fecha alucinada es motivo para NO
 *     aplicar. Ningún invariante de `validateMonth` la mira (`byDay`/`dayset` solo tienen días
 *     del mes) y sin embargo `guardarAsignaciones` la escribiría — en otro mes, y cambiándole
 *     el estado de paso.
 *   - desconocidos: filas cuyo `residenteId` no es de nadie. INV-1 las ve (V-21) pero solo como
 *     `aviso`, así que se aplicaban: filas que nadie puede ver ni corregir desde la rejilla, en
 *     una tabla que no se borra nunca. Con el reemplazo de arriba es además destructivo — el
 *     cuadrante bueno se borra y lo que lo sustituye es invisible. Mismo criterio que
 *     `fueraDelMes`: es un defecto de la RESPUESTA, no una regla de negocio incumplida, y
 *     rechazarlo no deja al servicio sin cuadrante (la rejilla sigue estando ahí).
 *   - duplicadas: claves `fecha|residenteId` que la propuesta trae más de una vez (ver
 *     `duplicadasDe`): el validador juzgaría una lista y el Sheet guardaría otra.
 *   - pisados: filas de la propuesta que caen sobre una celda V/R/B (ver `pisadosDe`): la rejilla
 *     las conserva solo si nadie escribe encima con la misma clave.
 */
function monthReplacementPlan({ mes, anio, residentes = [], existentes = [], propuesta = [] }) {
  const delMes = new Set(datesOfMonth(anio, mes));
  const conocidos = new Set(residentes.map((r) => r.id));
  const fueraDelMes = propuesta.filter((a) => !delMes.has(a.fecha));
  const desconocidos = propuesta.filter((a) => !conocidos.has(a.residenteId));
  const propuestaKeys = new Set(propuesta.map(clave));

  const borrables = borrablesDe(propuesta);
  const borradas = [];
  const marcadores = [];
  for (const a of existentes) {
    if (!borrables.has(a.codigo)) { marcadores.push(a); continue; }
    if (propuestaKeys.has(clave(a))) continue; // la propuesta ya la pisa por clave: nada que borrar
    borradas.push(a);
  }
  // Un 3P que este plan promete conservar (la propuesta no trae 3P, V-38) pero que la propuesta
  // pisa por clave con otro código: escribirlo lo sustituiría en silencio —«última fila gana»— y el
  // mes juzgado (3P + G a la vez) no sería el escrito. Mismo trato que las fijadas en completar.
  const conservadaPorClave = new Map(marcadores.filter((a) => a.codigo === "3P").map((a) => [clave(a), a]));
  const conflictos = propuesta
    .filter((a) => conservadaPorClave.has(clave(a)) && conservadaPorClave.get(clave(a)).codigo !== a.codigo)
    .map((a) => ({ propuesta: a, fijada: conservadaPorClave.get(clave(a)) }));

  return {
    cambios: [
      ...sinRepetidas(propuesta).map((a) => ({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo })),
      ...borradas.map((a) => ({ fecha: a.fecha, residenteId: a.residenteId, codigo: "" })),
    ],
    borradas,
    marcadores,
    conflictos,
    fueraDelMes,
    desconocidos,
    duplicadas: duplicadasDe(propuesta),
    pisados: pisadosDe(propuesta, existentes),
  };
}

// Lo que ocupa puesto en la rejilla (G/GF/GP/3P). Es el mismo conjunto que `validate.js:
// OCUPA_PUESTO`, copiado y no importado A PROPÓSITO: `apply.js` va segundo en el bundle de Apps
// Script (build/build-gas.mjs:DOMAIN_MODULES) y solo puede importar de `calendar.js`; importar
// `validate.js` desde aquí invertiría el orden topológico y el bundle dejaría de cargar.
const FIJABLES = new Set(["G", "GF", "GP", "3P"]);

/**
 * Plan para COMPLETAR el mes respetando lo que ya hay (decisión V-47): las guardias que ya están
 * en la rejilla —las que cada residente puso de antemano porque ya las tenía comprometidas, o las
 * que puso quien monta el cuadrante— son inamovibles, y la propuesta solo rellena lo que falta.
 *
 * Es el hermano de `monthReplacementPlan` con la regla contraria sobre lo existente: aquel BORRA
 * toda guardia previa que la propuesta no pise (para que el mes quede exactamente como la
 * propuesta); este NO borra ninguna. Existe porque el generador con IA se llevaba por delante lo
 * que los residentes habían apuntado a mano antes de generar, y esa era justo la información que
 * había que respetar.
 *
 * @returns {{cambios:object[], fijadas:object[], conflictos:object[], marcadores:object[],
 *            fueraDelMes:object[], desconocidos:object[], borradas:object[]}}
 *   - fijadas: las guardias (G/GF/GP/3P) que ya tiene el mes. Van al prompt como «ya fijadas» y a
 *     la validación JUNTO con la propuesta: lo que se juzga es el mes resultante, no la propuesta
 *     sola — si el modelo omite una fijada y pone a otro Mayor ese día, INV-1 lo ve.
 *   - cambios: SOLO las filas de la propuesta que aportan algo: se descartan las que repiten una
 *     fijada (misma clave y mismo código), que ya están escritas y así conservan su `origen`
 *     (cedida/comprada) intacto. Nunca hay filas de borrado.
 *   - conflictos: filas de la propuesta que pisan una fijada CON OTRO CÓDIGO. No se aplican
 *     (mandaría la propuesta sobre lo que se pidió respetar); quien llama decide qué hacer, y el
 *     router las convierte en un error de formato que vuelve al modelo en el reintento.
 *   - marcadores, fueraDelMes, desconocidos, duplicadas, pisados, borradas: mismo significado que
 *     en `monthReplacementPlan` (`borradas` siempre vacía aquí, se devuelve por simetría).
 */
function monthCompletionPlan({ mes, anio, residentes = [], existentes = [], propuesta = [] }) {
  const delMes = new Set(datesOfMonth(anio, mes));
  const conocidos = new Set(residentes.map((r) => r.id));
  const fueraDelMes = propuesta.filter((a) => !delMes.has(a.fecha));
  const desconocidos = propuesta.filter((a) => !conocidos.has(a.residenteId));

  const fijadas = existentes.filter((a) => FIJABLES.has(a.codigo));
  const marcadores = existentes.filter((a) => !FIJABLES.has(a.codigo));
  const fijadaPorClave = new Map(fijadas.map((a) => [clave(a), a]));

  const cambios = [];
  const conflictos = [];
  for (const a of sinRepetidas(propuesta)) {
    const fijada = fijadaPorClave.get(clave(a));
    if (!fijada) { cambios.push({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo }); continue; }
    if (fijada.codigo !== a.codigo) conflictos.push({ propuesta: a, fijada });
    // Misma clave y mismo código: ya está en la tabla, no hay nada que escribir.
  }

  return {
    cambios, fijadas, conflictos, marcadores, fueraDelMes, desconocidos, borradas: [],
    duplicadas: duplicadasDe(propuesta), pisados: pisadosDe(propuesta, existentes),
  };
}

  return { monthReplacementPlan, monthCompletionPlan };
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

/**
 * La ventana [inicio, cierre] del año de residencia que TERMINA dentro de `mes/anio`, o null si
 * ese mes no cierra ninguno. ÚNICA definición (2026-09-04): `equity.js` la tenía sobre
 * `periodsOfResident` y `thirdpost.js` sobre el aniversario nominal, así que con unos periodos
 * editados (nota [a]) el mismo residente cerraba su año en un mes para INV-3 y en otro para INV-8
 * — justo la incoherencia entre módulos que V-24 vino a quitar.
 *
 * Dos casos que NO cierran nada, a propósito:
 *  - Quien dejó la residencia antes del fin nominal (`fechaFin` dentro de R2, digamos): sus
 *    periodos R2/R3 derivados siguen «terminando» en mayo, pero ya no estaba — compararlo con su
 *    cohorte daría ceros contra guardias reales en todos los ejes, dos mayos seguidos.
 *  - Una ventana invertida (inicio > fin), que es lo que le queda a ese mismo residente como R4:
 *    `tally` no contaría nada en ella y saldrían los mismos ceros.
 */
function closingPeriodOn(residente, mes, anio) {
  const periodos = periodsOfResident(residente);
  const finReal = periodos[periodos.length - 1].end;
  const prefijo = `${anio}-${String(mes).padStart(2, "0")}`;
  const p = periodos.find((per) => String(per.end).startsWith(prefijo));
  if (!p) return null;
  if (compareISO(p.end, finReal) > 0) return null;
  if (compareISO(p.start, p.end) > 0) return null;
  return { start: p.start, end: p.end };
}

  return { LEVELS, defaultTrainingPeriods, levelOn, periodOn, groupOf, isActiveOn, periodsOfResident, groupOnDate, validateTrainingPeriods, closingPeriodOn };
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
// Eje `puentesLibres` de INV-3 (decisión V-27): un puente que cae dentro de CUALQUIER ausencia
// concedida no cuenta como "libre" — no fue el reparto quien se lo dio, no estaba en el hospital
// ese día. A diferencia de DESCUENTA_DISPONIBILIDAD (solo BAJA, nota [a] literal), aquí van los
// TRES motivos: el sesgo de que una ausencia inflara este eje no distinguía tipo de ausencia, y
// ROTACION/VACACIONES son más frecuentes que BAJA.
const AUSENTE_EN_PUENTE = ["BAJA", "VACACIONES", "ROTACION"];

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

  return { BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA, DESCUENTA_DISPONIBILIDAD, AUSENTE_EN_PUENTE, PROVINCIAS_CERCANAS, isNearbyRotation, absences };
})();

// ── blockPreview.js ──
var BlockPreview = (function () {
// Simulación preventiva de cobertura al registrar un `Bloqueo` (P-13, spec.md §8/§8.1,
// decisión directa del autor 2026-08-07). Todos los invariantes de `validate.js` evalúan un
// `Cuadrante` ya construido; esto evalúa el riesgo ANTES, al momento de aprobar una vacación o
// rotación, para no descubrir el problema recién cuando se arma el cuadrante (a 3 meses vista),
// que puede ser demasiado tarde para una vacación ya prometida.
//
// Solo VACACIONES y ROTACION pasan por aquí — BAJA es impredecible (no se puede "prevenir" con
// antelación como algo planeado) y ya la cubren INV-5 (bloquea la asignación) e INV-6 (ausencias
// simultáneas) aparte. El propio conjunto que ya usa INV-6 (`AUSENCIA_SIMULTANEA`) es, sin
// cambios, el que hace falta aquí: BAJA fuera, VACACIONES+ROTACION dentro.
//
// Cuatro riesgos:
//   1. Imposibilidad (espejo INV-1): algún día del periodo se quedaría sin NADIE disponible del
//      grupo (Mayor o Pequeño) del solicitante. Bloquea (`error`) SOLO si el periodo empieza
//      dentro de los 3 meses que ya cubre la sesión de armado del cuadrante — las vacaciones a
//      veces se piden con mucha más antelación que esa sesión, y bloquear un pedido ya hablado
//      con tutoría con un año de antelación dejaría a alguien sin poder registrarlo aunque las
//      cosas puedan cambiar antes. Más allá de la ventana, `aviso`.
//   2. Sobrecarga (espejo INV-2): los días del periodo que el grupo debe cubrir, divididos entre
//      los residentes que quedarían disponibles, superan el techo de 6 guardias/mes. Siempre
//      `aviso`.
//   3. Concentración por NIVEL: más de 2 residentes del mismo nivel exacto (R1, R2, R3 o R4 —
//      NUNCA grupo Mayor/Pequeño, NUNCA cohorte) ausentes a la vez, aunque el grupo en conjunto
//      siga teniendo gente para cubrir. Siempre `aviso`, nunca bloquea: sigue siendo factible
//      con el resto del grupo.
//   4. División Navidad/Año Nuevo (P-12, spec.md §8/§8.1, decisión 2026-08-08): el mismo
//      residente ausente en las DOS ventanas de fin de año a la vez — Navidad (23-26 dic) y Año
//      Nuevo (29 dic-6 ene, estirada hasta Reyes) — cuando lo ideal es que cada uno se
//      "sacrifique" en una sola de las dos. Por residente individual (contra sus propias
//      ausencias, no contra las de nadie más), siempre `aviso`.
//
// Cuidado al implementar sobre el eje 3: agrupa por `nivel` (R1-R4, derivado de fecha, cambia
// en el aniversario de cada residente), NO por `cohorte` (año calendario de `fechaInicio`, la
// que usa INV-6 para su propio "máx. 2 simultáneos" en rotación). Reutilizar por error la
// agrupación de INV-6 aquí mediría otra cosa sin que ningún test lo note, porque ambas reglas
// se VEN igual ("máx. 2 a la vez"). `CLAUDE.md` ya marca `cohorte` y `nivel` como "distintas —
// don't conflate them".

  const { compareISO, addDays, addMonths, parseISO } = Calendar;
  const { groupOnDate, levelOn, periodsOfResident } = Residents;
  const { absences, AUSENCIA_SIMULTANEA } = Absences;

const MESES_VENTANA_BLOQUEANTE = 3;
const TECHO_INV2 = 6;
// Días de un mes medio: la carga se mide POR MES, que es la unidad del techo de INV-2.
const DIAS_MES_MEDIO = 30.44;
const CONCENTRACION_MAX = 2;

const err = (tipo, detalle, extra = {}) => ({ tipo, severidad: "error", detalle, ...extra });
const aviso = (tipo, detalle, extra = {}) => ({ tipo, severidad: "aviso", detalle, ...extra });

function eachDate(desde, hasta) {
  const out = [];
  for (let d = desde; compareISO(d, hasta) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Último día en que un `Bloqueo` que EMPIECE hoy sigue dentro de la ventana bloqueante de 3 meses. */
function previewWindowEnd(today) {
  return addMonths(today, MESES_VENTANA_BLOQUEANTE);
}

/** Ventana de Navidad de un año calendario (P-12): 23-26 de diciembre, ambos inclusive. */
function navidadWindow(anio) {
  return { start: `${anio}-12-23`, end: `${anio}-12-26` };
}

/**
 * Ventana de Año Nuevo de un año calendario (P-12): 29 de diciembre - 6 de enero, estirada
 * hasta Reyes porque también es día de guardia especial. Cruza el año natural: `end` es del
 * año SIGUIENTE a `anio`.
 */
function anioNuevoWindow(anio) {
  return { start: `${anio}-12-29`, end: `${anio + 1}-01-06` };
}

function overlaps(aDesde, aHasta, bDesde, bHasta) {
  return compareISO(aDesde, bHasta) <= 0 && compareISO(bDesde, aHasta) <= 0;
}

/**
 * Años de Navidad candidatos a los que puede pertenecer un rango de fechas: el año natural de
 * cada extremo, retrocedido uno si el extremo cae en enero (la ventana de Año Nuevo de
 * diciembre de `anio` se cuenta como perteneciente a `anio`, no a `anio+1`).
 */
function seasonYearsOf(desde, hasta) {
  const y = (iso) => {
    const { year, month } = parseISO(iso);
    return month === 1 ? year - 1 : year;
  };
  return new Set([y(desde), y(hasta)]);
}

/**
 * Riesgo preventivo de un `Bloqueo` de VACACIONES/ROTACION antes de registrarlo (P-13).
 *
 * @param {{residenteId:string, desde:string, hasta:string, motivo:"VACACIONES"|"ROTACION"}} nuevo
 * @param {object} ctx
 *   - residentes: TODOS los residentes {id, fechaInicio, fechaFin?, periodos?} — hace falta la
 *     lista completa para saber quién más es del mismo grupo/nivel, no solo el solicitante.
 *   - bloqueosActivos: los `Bloqueo` YA existentes (de cualquier residente) — sin incluir
 *     `nuevo`, que todavía no se ha guardado y se simula aparte.
 *   - today: ISO — decide si `nuevo.desde` cae dentro de la ventana bloqueante de 3 meses.
 * @returns {{riesgos: object[], bloquea: boolean}} `bloquea` es el único campo que debe mirar
 *   quien decide si deja guardar el `Bloqueo`: es verdadero solo si hay un riesgo `error`.
 */
function previewBloqueoRisk(nuevo, { residentes, bloqueosActivos, today }) {
  const solicitante = residentes.find((r) => r.id === nuevo.residenteId);
  if (!solicitante) throw new Error(`previewBloqueoRisk: residenteId desconocido: ${nuevo.residenteId}`);

  const riesgos = [];
  const dias = eachDate(nuevo.desde, nuevo.hasta);
  const dentroDeVentana = compareISO(nuevo.desde, previewWindowEnd(today)) <= 0;

  let diaImposible = null;
  let minDisponibles = null;
  const concentracion = new Map(); // "fecha|nivel" → {fecha, nivel, ids}

  for (const fecha of dias) {
    const grupoDia = groupOnDate(solicitante, fecha);
    if (!grupoDia) continue; // el solicitante no es asignable ese día — nada que simular

    const delGrupo = residentes.filter((r) => groupOnDate(r, fecha) === grupoDia);
    const ausentesHoy = new Set(absences(bloqueosActivos, { motivos: AUSENCIA_SIMULTANEA, fecha }).map((b) => b.residenteId));
    ausentesHoy.add(nuevo.residenteId); // el propio bloqueo que se está simulando, ya "aprobado"

    const disponibles = delGrupo.filter((r) => !ausentesHoy.has(r.id));
    if (minDisponibles === null || disponibles.length < minDisponibles) minDisponibles = disponibles.length;
    if (disponibles.length === 0 && diaImposible === null) diaImposible = fecha;

    const ausentesDelGrupo = delGrupo.filter((r) => ausentesHoy.has(r.id));
    const porNivel = new Map();
    for (const r of ausentesDelGrupo) {
      const nivel = levelOn(periodsOfResident(r), fecha);
      if (!porNivel.has(nivel)) porNivel.set(nivel, []);
      porNivel.get(nivel).push(r.id);
    }
    for (const [nivel, ids] of porNivel) {
      const clave = `${fecha}|${nivel}`;
      if (ids.length > CONCENTRACION_MAX && !concentracion.has(clave)) {
        concentracion.set(clave, { fecha, nivel, ids });
      }
    }
  }

  // 1. Imposibilidad (espejo INV-1) — bloquea solo dentro de la ventana de 3 meses.
  if (diaImposible) {
    const detalle = `El ${diaImposible} no quedaría ningún residente disponible de ese grupo si se aprueba este bloqueo`;
    riesgos.push(dentroDeVentana
      ? err("IMPOSIBILIDAD", detalle, { fecha: diaImposible })
      : aviso("IMPOSIBILIDAD", `${detalle} (fuera de la ventana de 3 meses: no bloquea, puede resolverse antes)`, { fecha: diaImposible }));
  }

  // 2. Sobrecarga (espejo INV-2) — siempre aviso. El grupo cubre UNA guardia por día, así que
  // los días del periodo que caen en un mismo mes se reparten entre los disponibles del peor día:
  // eso es lo que cada uno carga DE MÁS ese mes, y se compara con el techo mensual de INV-2. Un
  // periodo más largo que un mes no carga más por mes —cada mes se reparten sus ~30 días—, de ahí
  // el tope a los días de un mes. Antes se dividían los días del periodo ENTERO entre los
  // disponibles y se comparaba eso con «6/mes» (corregido el 2026-09-04): una rotación de tres
  // meses con seis Mayores libres daba «15,3 > 6» cuando la carga real es ~5 al mes, y cualquier
  // ausencia de más de cinco semanas avisaba, la absorbiera el grupo o no.
  if (minDisponibles > 0) {
    const porMes = Math.min(dias.length, DIAS_MES_MEDIO) / minDisponibles;
    if (porMes > TECHO_INV2) {
      riesgos.push(aviso("SOBRECARGA",
        `Con ${minDisponibles} residente(s) disponible(s) en el peor día del periodo (${dias.length} día(s)), a cada uno le tocarían ${porMes.toFixed(1)} guardias en un mes, por encima del techo de ${TECHO_INV2}/mes`,
        { diasPeriodo: dias.length, disponibles: minDisponibles }));
    }
  }

  // 3. Concentración por nivel — siempre aviso, nunca bloquea.
  for (const { fecha, nivel, ids } of concentracion.values()) {
    riesgos.push(aviso("CONCENTRACION_NIVEL",
      `Más de ${CONCENTRACION_MAX} residentes de nivel ${nivel} ausentes a la vez el ${fecha} (${ids.join(", ")})`,
      { fecha, nivel, residentes: ids }));
  }

  // 4. División Navidad/Año Nuevo (P-12) — por residente individual, contra sus propias
  // ausencias. Solo se evalúa si `nuevo` toca alguna de las dos ventanas de algún año candidato;
  // si no las toca, este `Bloqueo` no puede cambiar el resultado y no hace falta mirar nada más.
  const propiasExistentes = absences(bloqueosActivos, { residenteId: nuevo.residenteId, motivos: AUSENCIA_SIMULTANEA });
  const todasPropias = [...propiasExistentes, nuevo];
  for (const anio of seasonYearsOf(nuevo.desde, nuevo.hasta)) {
    const nav = navidadWindow(anio);
    const anioNuevo = anioNuevoWindow(anio);
    const tocaAlguna = overlaps(nuevo.desde, nuevo.hasta, nav.start, nav.end) || overlaps(nuevo.desde, nuevo.hasta, anioNuevo.start, anioNuevo.end);
    if (!tocaAlguna) continue;

    const tieneNavidad = todasPropias.some((b) => overlaps(b.desde, b.hasta, nav.start, nav.end));
    const tieneAnioNuevo = todasPropias.some((b) => overlaps(b.desde, b.hasta, anioNuevo.start, anioNuevo.end));
    if (tieneNavidad && tieneAnioNuevo) {
      riesgos.push(aviso("DIVISION_NAVIDAD_ANIO_NUEVO",
        `${nuevo.residenteId} queda ausente en Navidad (${nav.start}..${nav.end}) y en Año Nuevo (${anioNuevo.start}..${anioNuevo.end}) del mismo periodo festivo — lo ideal es sacrificar una sola de las dos`,
        { anio, residenteId: nuevo.residenteId }));
    }
  }

  return { riesgos, bloquea: riesgos.some((r) => r.severidad === "error") };
}

  return { previewWindowEnd, navidadWindow, anioNuevoWindow, previewBloqueoRisk };
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
  const { absences } = Absences;

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
 * Y se aparta a quien tenga una AUSENCIA registrada ese día (2026-09-04): a quien está de baja no
 * se le puede exigir una guardia (el fundamento de INV-5), y quien está de vacaciones o rotando
 * fuera no está en el hospital para cogerla. Sin esto la lista proponía llamar primero a quien
 * llevaba un mes de baja, justo en el único momento en que la herramienta se usa (las ocho de la
 * mañana con un puesto sin cubrir).
 *
 * @param {object} p
 *   - residentes, coberturas: filas de `imaginaria` (solo las activas), asignaciones
 *   - bloqueos: filas de `bloqueos` (las activas las filtra `absences`, V-19); opcional
 *   - grupo: "MAYOR" | "PEQUENO" — el del puesto que hay que cubrir
 *   - fechaIncidencia: ISO
 * @returns {{residenteId:string, ultimaCobertura:string|null, apartadoPor:string|null}[]}
 *   TODA la lista elegible, en orden, con el motivo de quien queda apartado — la pantalla
 *   enseña a quién llamar y también a quién no, que es lo que evita la llamada inútil.
 */
const AUSENCIA_LABEL = { BAJA: "está de baja", VACACIONES: "está de vacaciones", ROTACION: "está de rotación externa" };

function imaginariaQueue({ residentes = [], coberturas = [], asignaciones = [], bloqueos = [], grupo, fechaIncidencia }) {
  const vispera = addDays(fechaIncidencia, -1);
  const siguiente = addDays(fechaIncidencia, 1);

  const ultimaPorResidente = new Map();
  for (const c of coberturas) {
    if (c.activo === false) continue;
    const previa = ultimaPorResidente.get(c.residenteId);
    if (!previa || c.fechaIncidencia > previa) ultimaPorResidente.set(c.residenteId, c.fechaIncidencia);
  }

  const guardiaEn = (id, fecha) => asignaciones.some((a) => a.residenteId === id && a.fecha === fecha && GUARDIA.has(a.codigo));
  const ausenciaEn = (id) => absences(bloqueos, { residenteId: id, fecha: fechaIncidencia })[0] || null;

  return residentes
    .filter((r) => isEligibleForImaginaria(r, grupo, fechaIncidencia))
    .map((r) => {
      const ausencia = ausenciaEn(r.id);
      return {
        residenteId: r.id,
        ultimaCobertura: ultimaPorResidente.get(r.id) || null,
        apartadoPor: ausencia ? (AUSENCIA_LABEL[ausencia.motivo] || `tiene una ausencia registrada (${ausencia.motivo})`)
          : guardiaEn(r.id, fechaIncidencia) ? "tiene guardia esa misma noche"
            : guardiaEn(r.id, vispera) ? `tiene guardia el día anterior (${vispera})`
              : guardiaEn(r.id, siguiente) ? `tiene guardia el día siguiente (${siguiente})`
                : null,
      };
    })
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
  const { periodsOfResident, periodOn } = Residents;
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
  const { levelOn, periodsOfResident, closingPeriodOn } = Residents;

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

const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, voluntarios3P, historial3P, periodosVoluntario3P? }
 *   - asignaciones: del mes (incluye 3P y guardias G/GF/GP para detectar mochila)
 *   - voluntarios3P: los voluntarios ACTIVOS ahora, como `string[]` de ids o como
 *     `{residenteId, desde}[]`. Con `desde` (lo que manda la tabla `voluntarios3P`) el ciclo L-D
 *     de INV-8b **se recorta a partir de esa fecha**, que es lo que exige V-18(b): cada residente
 *     empieza su ciclo el día que se apunta. Sin él —los tests que solo comprueban otras reglas—
 *     no se recorta nada. El recorte tiene que vivir AQUÍ y no en el invocador: el histórico que
 *     se lee es común a 8b y a 8c (que sí necesita el año de residencia entero, más antiguo), así
 *     que recortarlo al leerlo rompería 8c, y no recortarlo mete en el ciclo de alguien los 3P que
 *     hizo antes de apuntarse. Misma tolerancia de dos formas que `calendar.js:isHoliday`.
 *   - historial3P: { id: [fechas ISO de 3P previas, cronológicas] }
 *   - periodosVoluntario3P?: `{residenteId, desde, hasta?}[]` — TODOS los periodos de
 *     voluntariado, activos e históricos (decisión V-28, corrige INV-8a). Sin este campo, 8a cae
 *     al criterio antiguo «¿lo es AHORA?» (`voluntarios3P`); con él, juzga «¿lo era ESE día?»,
 *     que es lo correcto para un mes que no es el actual — ver el comentario en la propia regla.
 * @returns {{invariante:'INV-8', severidad:string, fecha?:string, residenteId?:string, detalle:string}[]}
 */
function validateThirdPost(ctx) {
  const { mes, anio, residentes, asignaciones = [], voluntarios3P = [], historial3P = {}, periodosVoluntario3P = null } = ctx;
  const byId = new Map(residentes.map((r) => [r.id, r]));
  const voluntarios = new Set(voluntarios3P.map((v) => (typeof v === "string" ? v : v && v.residenteId)));
  const altaDe = new Map(voluntarios3P.filter((v) => v && typeof v !== "string" && v.desde).map((v) => [v.residenteId, v.desde]));
  const violations = [];

  const thisMonth3P = asignaciones.filter((a) => a.codigo === "3P").sort((a, b) => compareISO(a.fecha, b.fecha));

  // ── INV-8a: 3P solo a voluntarios ──
  // «¿Era voluntario ESE día?», no «¿lo es AHORA?» (decisión V-28). Sin `periodosVoluntario3P`
  // —los tests que no lo pasan, y cualquier invocador viejo— se conserva el criterio anterior
  // (`voluntarios`, la lista de HOY) para no romper nada existente; el corregido solo se activa
  // cuando el invocador provee la historia completa de periodos, activos y retirados.
  const eraVoluntarioEl = (residenteId, fecha) => {
    if (periodosVoluntario3P === null) return voluntarios.has(residenteId);
    return periodosVoluntario3P.some((p) => p.residenteId === residenteId
      && compareISO(fecha, p.desde) >= 0
      && (!p.hasta || compareISO(fecha, p.hasta) <= 0));
  };
  for (const a of thisMonth3P) {
    if (!eraVoluntarioEl(a.residenteId, a.fecha)) {
      violations.push(aviso(`3P asignado a ${a.residenteId}, que no consta en la lista de voluntarios`, { fecha: a.fecha, residenteId: a.residenteId }));
    }
  }

  // ── INV-8b: rotación de días por residente ──
  const idsCon3P = new Set([...Object.keys(historial3P), ...thisMonth3P.map((a) => a.residenteId)]);
  for (const id of idsCon3P) {
    const historial = (historial3P[id] || []).slice().sort(compareISO);
    const propiasMes = thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha);
    for (const fecha of thirdPostCycleRepeats(historial.concat(propiasMes), altaDe.get(id))) {
      if (inMonth(fecha, mes, anio)) {
        violations.push(aviso(`${id} repite ${weekday(fecha)} en 3P el ${fecha} sin completar el ciclo de 7 días`, { fecha, residenteId: id }));
      }
    }
  }

  // ── INV-8d: prioridad mochila ──
  const days = datesOfMonth(anio, mes);
  const mochilaDays = new Set();
  for (const a of asignaciones) {
    if (!["G", "GF", "GP"].includes(a.codigo)) continue;
    const r = byId.get(a.residenteId);
    if (r && levelOn(periodsOfResident(r), a.fecha) === "R1") mochilaDays.add(a.fecha);
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
 * Las fechas de `fechas` que REPITEN día de la semana sin haber completado el ciclo de 7 (INV-8b).
 *
 * Se exporta porque el generador (`schedule.js`, V-38) tiene que saber si un 3P que se plantea
 * proponer va a repetir día ANTES de proponerlo — y la única forma de que no acabe habiendo dos
 * versiones del ciclo es que use esta misma. Es el mismo motivo por el que `equity.js` exporta
 * `DIMS`/`PROPORCIONAL` y `validate.js` exporta `OCUPA_PUESTO`: la copia es lo que se
 * desincroniza en silencio, y aquí sería peor de ver, porque el ciclo depende del orden.
 *
 * El ciclo arranca en el alta del residente (V-18b): lo que hiciera antes de apuntarse —o en una
 * etapa anterior, si se retiró y volvió— no cuenta. Sin recortar, esos 3P añaden repeticiones
 * falsas y, peor, pueden completar los 7 días y reiniciar el ciclo, tapando una repetición real.
 * El histórico llega sin recortar a propósito: 8c lo necesita entero.
 *
 * @param {string[]} fechas  todas las de ese residente, se ordenan aquí
 * @param {string=} alta     su `voluntarios3P.desde`; sin él no se recorta nada
 */
function thirdPostCycleRepeats(fechas, alta) {
  const repes = [];
  let cycle = new Set();
  for (const fecha of fechas.slice().sort(compareISO).filter((f) => !alta || compareISO(f, alta) >= 0)) {
    const wd = weekday(fecha);
    if (cycle.has(wd)) {
      repes.push(fecha);
      // no se reinicia el ciclo por una repetición; se sigue evaluando
    } else {
      cycle.add(wd);
      if (cycle.size === 7) cycle = new Set(); // ciclo completo → se reinicia
    }
  }
  return repes;
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

/**
 * Si el residente cierra un año de residencia dentro de [mes/anio], devuelve la ventana [inicio,
 * cierre]. Es la misma definición que usa el cierre anual de INV-3 (`residents.js:closingPeriodOn`,
 * 2026-09-04): antes se calculaba aquí sobre el aniversario NOMINAL, ignorando los periodos
 * editados de la nota [a] y la `fechaFin` real, y un R2 con la promoción retrasada cerraba su año
 * en mayo para INV-8c y en junio para INV-3.
 */
function closingWindowThisMonth(r, mes, anio) {
  return closingPeriodOn(r, mes, anio);
}

function countThirdPostInWindow(id, historial3P, thisMonth3P, win) {
  const todas = (historial3P[id] || []).concat(thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha));
  return todas.filter((f) => inRange(f, win.start, win.end)).length;
}

  return { THIRD_POST_PERMANENCIA_MESES, thirdPostCommitmentEnd, canWithdrawThirdPost, validateThirdPost, thirdPostCycleRepeats, thirdPostHistoryStart };
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
  const { absences, DESCUENTA_DISPONIBILIDAD, AUSENTE_EN_PUENTE } = Absences;
  const { accumulatedTally } = Accumulate;
  const { periodsOfResident, closingPeriodOn } = Residents;

// Los seis ejes de INV-3 y cuáles se normalizan por disponibilidad. Se EXPORTAN porque el
// generador (`schedule.js`) y el banco de equidad tienen que perseguir exactamente lo que este
// validador va a medirles: cuando cada uno tenía su copia, la entrada de `puentesLibres` en
// PROPORCIONAL (V-27) los dejó a los dos optimizando un objetivo distinto del juez sin que nada
// fallara. Mismo motivo que `OCUPA_PUESTO` en validate.js.
const DIMS = ["total", "findes", "festivos", "prefestivos", "puentesLibres", "dobletes"];
// Los tres códigos que ocupan puesto. El 3P queda fuera a propósito (INV-4): es voluntario, así
// que quien lo hace en un puente renuncia él al puente — el eje mide si el reparto se lo quitó.
// Las cedidas/compradas SÍ cuentan aquí aunque no sumen a `total`: quien tiene la fila trabaja
// ese día, que es justo lo que este eje pregunta.
const GUARDIA = ["G", "GF", "GP"];
// Se normalizan por disponibilidad (÷f, la fracción de la ventana sin BAJA — nota [a], V-8).
// `puentesLibres` entra desde V-27: junto con la exclusión de `residentIsFreeOnBridge`, una
// ausencia larga deja de inflar este eje sin más que quitarle oportunidad de ganarlo.
const PROPORCIONAL = new Set(["total", "findes", "festivos", "prefestivos", "dobletes", "puentesLibres"]);
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
    const puentesLibresMes = puentesDelMes.filter((p) => residentIsFreeOnBridge(r.id, asignaciones, p, win, bloqueos)).length;

    const dims = {
      total: acc.total + t.total,
      findes: acc.findes + t.finde,
      festivos: acc.festivos + t.festivos,
      prefestivos: (acc.prefestivos || 0) + t.prefestivos,
      dobletes: acc.dobletes + t.dobletes,
      puentesLibres: acc.puentesLibres + puentesLibresMes,
    };
    const bajas = absences(bloqueos, { residenteId: r.id, motivos: DESCUENTA_DISPONIBILIDAD });
    // Sin un solo día disponible en todo el año (baja de principio a fin: el embarazo largo que
    // V-5 modela como BAJA) no hay nada que comparar: `availabilityFraction` devolvería 1 —su
    // salida para el caso degenerado— y el cierre lo juzgaría como plenamente disponible con cero
    // guardias, avisando en los seis ejes contra toda su cohorte. Mismo criterio que la cohorte
    // de uno: se queda fuera de la comparación.
    if (availableDays(win, bajas) <= 0) continue;
    const f = availabilityFraction(win, bajas);

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
      const vals = grupo.map((x) => ({ id: x.id, cierre: x.cierre, f: x.f, v: PROPORCIONAL.has(dim) ? x.dims[dim] / x.f : x.dims[dim] }));
      const par = excedeElUno(vals, PROPORCIONAL.has(dim));
      if (par) {
        const { maxEntry, minEntry } = par;
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
      .filter((p) => residentIsFreeOnBridge(r.id, historicas, p, win, bloqueos)).length;
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
    // El rango de presencia sale de los periodos (V-24), no de reconstruir `fechaInicio +4 años`:
    // con los periodos editados de la nota [a] el primero y el último son los que mandan.
    const suyos = periodsOfResident(r);
    const presente = intersect(win, { start: suyos[0].start, end: suyos[suyos.length - 1].end });
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
    byCohort.get(cohorte).push({ id: r.id, f, v: total / f, porBaja: disponibles < diasPresente, parcial: diasPresente < quarterDays });
  }

  for (const [, grupo] of byCohort) {
    if (grupo.length < 2) continue;
    // El eje del cierre trimestral es `total`, que SIEMPRE se normaliza (está en PROPORCIONAL).
    const par = excedeElUno(grupo, true);
    if (par) {
      const { maxEntry, minEntry } = par;
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

/**
 * La ventana del año de residencia que CIERRA en este mes, o `null` si no cierra ninguno.
 *
 * Sale de `periodsOfResident` (unificación de V-24) y no de reconstruir el aniversario a mano.
 * Antes iteraba `addYears(r.fechaInicio, k)`, lo que ignoraba **las dos** vías por las que un año
 * de residencia puede no acabar en su aniversario nominal: `fechaFin` y los periodos editados de
 * la nota [a]. Medido al unificar: con `fechaFin` nominal el resultado es idéntico mes a mes —o
 * sea, para todos los residentes de hoy no cambia nada—, y donde cambia es donde estaba mal: un
 * R4 que deja la residencia el 15 de marzo cerraba su año en MAYO, dos meses después de irse, con
 * una ventana que se extendía más allá de su último día.
 */
function closingWindowThisMonth(r, mes, anio) {
  // La definición vive en residents.js desde 2026-09-04, compartida con thirdpost.js.
  return closingPeriodOn(r, mes, anio);
}

/** Fracción de disponibilidad = (días de la ventana − días de baja) / días de la ventana. */
/**
 * Exportada desde V-34: `schedule.js` divide por el MISMO `f` que este validador, o el generador
 * perseguiría un objetivo distinto del que el cierre le va a medir (regla 2 de V-32). Duplicarla
 * allí era la vía rápida y es justo lo que V-19 prohíbe: dos definiciones de la misma pregunta
 * que empiezan iguales y se separan sin que nadie lo note.
 */
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
 *
 * Un puente dentro de una ausencia concedida (BAJA/VACACIONES/ROTACION) NO cuenta como libre
 * (decisión V-27): sin guardia porque no estaba, no porque el reparto se lo diera. Antes
 * cualquier ausencia larga inflaba este eje sin límite —ni siquiera la BAJA se descontaba aquí,
 * a diferencia de los demás ejes (nota [a])—, y era el sesgo más frecuente porque ROTACION y
 * VACACIONES no bloquean la asignación (V-8) pero tampoco generan guardia en la práctica.
 */
function residentIsFreeOnBridge(id, asignaciones, puente, win, bloqueos = []) {
  if (!inRange(puente, win.start, win.end)) return false; // fuera de su ventana → no es suyo
  if (absences(bloqueos, { residenteId: id, motivos: AUSENTE_EN_PUENTE, fecha: puente }).length) return false;
  return !asignaciones.some((a) => a.residenteId === id && GUARDIA.includes(a.codigo) && a.fecha === puente);
}

function daysInclusive(a, b) {
  let n = 0;
  for (let d = a; compareISO(d, b) <= 0; d = addDays(d, 1)) n++;
  return n;
}
/**
 * ¿Se pasa del ±1 esta cohorte en este eje? Devuelve el par (máximo, mínimo) que hay que nombrar,
 * o `null` si no hay nada que avisar. La usan LOS DOS cierres: la regla del ±1 se escribe una vez.
 *
 * LA TOLERANCIA VIAJA CON LA NORMALIZACIÓN (decisión V-37). El ±1 son UNA GUARDIA de verdad, y
 * al dividir por `f` una guardia deja de valer 1: vale `1/f`. Comparar el cociente contra un 1
 * fijo mezclaba las dos escalas, y el efecto no es teórico — cuando toda una cohorte comparte la
 * misma `f` < 1, el cociente escala también la DIFERENCIA mientras la tolerancia se quedaba
 * quieta, así que el ±1 se encogía a `f` y solo pasaba el empate exacto. Medido: la cohorte de R4
 * que termina la residencia el 26 de mayo tiene f = 87/92 en el trimestre T4, que acaba el 31, de
 * modo que **cada mayo** un reparto de 11 y 10 guardias —diferencia exactamente 1, o sea dentro
 * de la norma— salía como 11,63 vs 10,57 y avisaba. Y como INV-3 está en `EQUITY_INVARIANTS`, eso
 * obligaba al «Validar de todas formas» de V-14 justo cuando el reparto era perfecto: enseñar a
 * saltarse el aviso es lo último que le conviene a esto.
 *
 * La `f` que manda es la MENOR de las dos que se comparan, o sea `1/f` la mayor: el margen tiene
 * que dar para una guardia real de cualquiera de los dos, y para el menos disponible una guardia
 * pesa más. Cuando la cohorte comparte `f` las dos coinciden y la escala se cancela exacta.
 *
 * Lo que esto NO hace es apagar la normalización, que es lo que primero se intentó —poner un
 * suelo de «diferencia cruda ≤ 1 nunca avisa»— y que el propio banco tumbó: con ese suelo, dar
 * las MISMAS 30 guardias en crudo a quien estuvo tres meses de baja dejaba de ser violación, y
 * eso es exactamente lo que INV-3 existe para penalizar (regla 2 de V-32, y su test). Aquí ese
 * caso sigue avisando, porque 30/0,751 = 39,95 frente a 30 se pasa de largo de la tolerancia de
 * 1/0,751 = 1,33.
 */
function excedeElUno(vals, normalizado) {
  const maxEntry = vals.reduce((a, b) => (b.v > a.v ? b : a));
  const minEntry = vals.reduce((a, b) => (b.v < a.v ? b : a));
  const tolerancia = normalizado ? 1 / Math.min(maxEntry.f, minEntry.f) : 1;
  return maxEntry.v - minEntry.v > tolerancia + EPS ? { maxEntry, minEntry } : null;
}

const round = (x) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);
function labelDim(dim) {
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", prefestivos: "Prefestivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

  return { DIMS, PROPORCIONAL, validateResidencyYearClose, yearCloseHistoryStart, buildYearCloseContext, yearCloseFestivosRange, quarterCloseWindow, validateQuarterClose, availabilityFraction, residentIsFreeOnBridge };
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
  const { periodsOfResident, levelOn, groupOf } = Residents;
  const { tally } = Tally;
  const { absences, isNearbyRotation, BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA } = Absences;

const GUARDIA = new Set(["G", "GF", "GP"]);          // ocupan puesto obligatorio
// Los códigos que OCUPAN un puesto de guardia esa noche (INV-5, INV-7 y el descanso de INV-15).
// V/R/B no están: son marcas de la rejilla, no presencia en el hospital. Se exporta porque el
// cliente necesita el mismo conjunto para avisar en el momento de escribir una celda, y tenerlo
// dos veces es la clase de duplicado que se desincroniza sin que nada falle (ver `absences.js`,
// que existe por lo mismo).
const OCUPA_PUESTO = new Set(["G", "GF", "GP", "3P"]);
const ASIGNACION = OCUPA_PUESTO;
// Qué motivo de `bloqueos` cuenta para qué invariante vive en `absences.js`, no aquí: eran
// cinco criterios escritos a mano en cinco sitios. Decisión V-8 (Fase 5.x): solo BAJA bloquea
// la asignación —no se puede exigir una guardia a alguien de baja médica/embarazo—, mientras
// VACACIONES y ROTACION son informativas para el generador pero SIGUEN alimentando INV-2
// (exención del mínimo), INV-6 (ausencias simultáneas) e INV-7 (rotación cercana).

const err = (invariante, detalle, extra = {}) => ({ invariante, severidad: "error", detalle, ...extra });
const aviso = (invariante, detalle, extra = {}) => ({ invariante, severidad: "aviso", detalle, ...extra });

// `periodsOfResident` (residents.js) es la ÚNICA derivación de periodos del dominio desde la
// unificación de V-24: antes cada módulo tenía su propia copia del `fechaFin || addYears(+4)` y
// tres de ellas —projection, accumulate y el `closingWindowThisMonth` de equity— NO miraban
// `residente.periodos`, así que con la tabla `periodos` rellena el mismo residente habría tenido
// dos niveles distintos DENTRO de una misma llamada a `marcarValidado`. Medido antes de unificar:
// `projection.js` daba R2 el mismo día que `validate.js` daba R1.
const cohortOf = (residente) => Number(residente.fechaInicio.slice(0, 4)); // promoción = año de inicio

function inRange(fecha, desde, hasta) {
  return compareISO(fecha, desde) >= 0 && compareISO(fecha, hasta) <= 0;
}

/**
 * Por qué un residente no es asignable en una fecha, en palabras y con la fecha frontera.
 * `groupOf` devuelve null para los tres casos (residents.js:74-77) y son indistinguibles
 * desde el grupo; el Responsable necesita saber cuál es para arreglarlo.
 * @param {"PENDIENTE"|"FINALIZADO"|null} nivel  null = el id no está en `residentes`
 * @param {{start:string,end:string}[]|undefined} periodos
 */
function reasonNotAssignable(nivel, periodos) {
  if (nivel === null || !periodos) return "no figura en la lista de residentes";
  if (nivel === "FINALIZADO") return `su residencia terminó el ${periodos[periodos.length - 1].end}`;
  if (nivel === "PENDIENTE") return `su residencia empieza el ${periodos[0].start}`;
  return `nivel ${nivel}, sin grupo de guardia`; // defensivo: hoy inalcanzable
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
function buildMonthContext({ mes, anio, residentes, historicas = [], asignacionesDelMes, bloqueos, festivos = [], eventos = [], excepciones = [] }) {
  return {
    mes, anio,
    // `periodos` viaja SIEMPRE que venga: es lo único que expresa la nota [a] («los periodos
    // generados son editables después»), y recortarlo aquí hacía inalcanzable el punto entero —
    // por mucho que el router hidrate desde la tabla, este `map` los borraba y `levelOn` volvía a
    // derivar del aniversario nominal. Un fallo perfectamente silencioso: no lanza, solo devuelve
    // el nivel equivocado. La proyección sigue siendo explícita a propósito (no arrastrar campos
    // que el validador no debe ver), así que un campo nuevo hay que añadirlo aquí a mano.
    residentes: residentes.map((r) => ({ id: r.id, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin, periodos: r.periodos })),
    asignaciones: [...historicas, ...asignacionesDelMes],
    bloqueos,
    // Filas de la tabla `excepciones`, tal cual: `twoR2Justified` ya filtra por `tipo` y por rango
    // de fechas él mismo, así que no hace falta moldearlas aquí (a diferencia de `eventos`, que sí
    // necesita recortarse al año académico antes de llegar al validador).
    excepciones,
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
  const periods = new Map(residentes.map((r) => [r.id, periodsOfResident(r)]));
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
    const noAsignables = roles.filter((r) => r.group === null);

    // Asignaciones a quien no es asignable ese día (residencia terminada, no empezada, o id
    // que no está en `residentes`). Antes se contaban como "nadie" y el día salía con el
    // MISMO objeto que un día vacío —«sin cubrir (mayores=0, pequeños=0)»—, un diagnóstico
    // falso, sin `residenteId` y por tanto sin nada que traducir en client/lib/violations.js.
    // Es `aviso` y no `error` (decisión V-21) porque la causa vive en las fechas del
    // residente y hoy no hay forma de corregirlas desde la app (no existe `editarResidente`):
    // bloquear dejaría al servicio sin cuadrante por algo que nadie puede arreglar DENTRO de
    // la herramienta, que es el criterio de V-12/V-14/V-16.
    for (const r of noAsignables) {
      violations.push(aviso("INV-1",
        `Guardia del ${fecha} asignada a ${r.id}, que no es residente asignable en esa fecha (${reasonNotAssignable(r.level, periods.get(r.id))})`,
        { fecha, residenteId: r.id }));
    }

    if (guardias.length === 2 && pequenos.length === 2 && pequenos.every((p) => p.level === "R2")) {
      // Candidato 2×R2 → lo gobierna INV-9
      if (!twoR2Justified(fecha)) {
        const antesDeDiciembre = compareISO(fecha, toISO(academicYearOf(fecha), 12, 1)) < 0;
        // Aviso, no error (V-14): sigue siendo aviso aunque desde V-29 la Excepcion ya se pueda
        // registrar desde la app — subir a error dejaría el mes bloqueado mientras alguien va a
        // buscar el permiso del ciclo para justificarlo, y esta regla nunca fue de las tres que
        // protegen lo imposible/ilegal.
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
    else if (noAsignables.length > 0) {
      // El día TIENE nombres escritos en la rejilla: decirlo así, y no «sin cubrir», que es lo
      // que lo hacía indistinguible de un día vacío. Aviso por lo mismo que el bucle de arriba
      // (V-21) — el aviso de cada asignación ya dice a quién hay que arreglar.
      violations.push(aviso("INV-1",
        `Guardia del ${fecha} sin nadie asignable: el día solo lo cubre ${noAsignables.map((r) => r.id).join(", ")}`,
        { fecha }));
      continue;
    }
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
    // Solo las del MES: `asignaciones` trae también el histórico (el mes anterior entero desde que
    // INV-15 mira el borde, 2026-09-04) y con él quien hizo guardias en junio y ninguna en julio
    // dejaba de caer en este atajo y recibía «0 guardias < mínimo 4» — el caso normal de una
    // rotación externa, que no exime del mínimo (V-8) pero tampoco es «actividad».
    const propias = asignaciones.filter((a) => a.residenteId === r.id && dayset.has(a.fecha));
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
      // Presencia PARCIAL (2026-09-04): el R1 que se incorpora el 27 de mayo, o quien termina la
      // residencia a mitad de mes, no puede llegar a 4 en los días que estuvo — la normativa ya
      // dice «salvo excepciones», y este es un aviso falso predecible cada mayo.
      const presenteTodoElMes = groupOf(levelOnDay(r.id, days[0])) !== null && groupOf(levelOnDay(r.id, days[days.length - 1])) !== null;
      if (!esFebrero && !tieneVoB && !r1Verano && presenteTodoElMes) {
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
  // Disyunción, no conjunción (decisión P-6, 2026-08-06): basta con UNA guardia de viernes
  // O de sábado dentro del periodo, no las dos. La normativa es ambigua en sí misma ("al
  // menos una de las guardias de viernes y sábado"); el autor decidió la lectura menos
  // exigente directamente, sin consultar a tutoría — ver spec.md §5.1/§8.1.
  for (const b of absences(bloqueos)) {
    if (!isNearbyRotation(b)) continue;
    const finEnEsteMes = Number(b.hasta.slice(0, 4)) === anio && Number(b.hasta.slice(5, 7)) === mes;
    if (!finEnEsteMes) continue;
    const period = eachDate(b.desde, b.hasta);
    const hasFriday = period.some((f) => weekday(f) === "V");
    const hasSaturday = period.some((f) => weekday(f) === "S");
    if (!hasFriday && !hasSaturday) continue;
    const propias = asignaciones.filter((a) => a.residenteId === b.residenteId && ASIGNACION.has(a.codigo) && inRange(a.fecha, b.desde, b.hasta));
    const cubreV = propias.some((a) => weekday(a.fecha) === "V");
    const cubreS = propias.some((a) => weekday(a.fecha) === "S");
    if (!cubreV && !cubreS) {
      // Aviso, no error (V-14): puede no existir hueco de viernes ni de sábado dentro del
      // periodo sin romper la composición del resto del grupo — no siempre se arregla en
      // el cuadrante.
      violations.push(aviso("INV-7", `${b.residenteId}: rotación en ${b.provincia} (${b.desde}..${b.hasta}) sin guardia de viernes ni de sábado en el cuadrante propio`, { residenteId: b.residenteId }));
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

  // ── INV-15: descanso obligatorio tras una guardia (decisión del autor, 2026-08-10) ──
  // Nadie hace dos guardias en días consecutivos. Es `error`, y eso NO es una excepción a V-14
  // sino un caso suyo: V-14 bloquea «lo imposible y lo ILEGAL», y tras una guardia de 24 h el
  // descanso del día siguiente es una obligación legal, igual que INV-5 (no se le puede exigir
  // una guardia a quien está de baja). No hay respaldo en `normativa.pdf` — está declarado como
  // extensión en §5.1.
  //
  // Se juzga el PAR, así que se recorre una sola vez por asignación mirando el día siguiente. El
  // par que cruza el borde del mes entra porque `asignaciones` trae el histórico (contrato C-2):
  // por eso se exige que al menos uno de los dos días sea del mes validado, o validar octubre
  // reportaría también un par ocurrido entero en agosto.
  //
  // Cuenta el 3P: es «tercer puesto de guardia», la misma noche en el hospital, y el descanso
  // legal no distingue si era voluntario. Excluirlo dejaría que la herramienta bendijera
  // exactamente el encadenamiento que esta regla existe para impedir.
  const conPuesto = asignaciones.filter((a) => ASIGNACION.has(a.codigo));
  const puestoPorClave = new Set(conPuesto.map((a) => `${a.residenteId}|${a.fecha}`));
  for (const a of conPuesto) {
    const siguiente = addDays(a.fecha, 1);
    if (!dayset.has(a.fecha) && !dayset.has(siguiente)) continue;
    if (!puestoPorClave.has(`${a.residenteId}|${siguiente}`)) continue;
    violations.push(err("INV-15",
      `Guardias en días consecutivos: ${a.fecha} y ${siguiente} (tras una guardia corresponde el descanso del día siguiente)`,
      { fecha: siguiente, residenteId: a.residenteId }));
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
    // Se cuentan RESIDENTES, no filas (2026-09-04): unas vacaciones registradas dentro de una
    // rotación —o la misma ausencia dada de alta dos veces— son dos filas de la misma persona, y
    // contarlas por separado hacía saltar el aviso con solo dos ausentes y el mismo id repetido.
    // Si alguien tiene ROTACION y VACACIONES el mismo día, manda la rotación (es la prioritaria en
    // la atribución de abajo).
    const cohorts = new Map(); // cohorte → [{id, motivo}]
    const vistos = new Map(); // residenteId → entrada ya añadida
    for (const b of absences(bloqueos, { motivos: AUSENCIA_SIMULTANEA, fecha })) {
      const c = cohortOfId.get(b.residenteId);
      if (c === undefined) continue;
      const previa = vistos.get(b.residenteId);
      if (previa) {
        if (previa.motivo === "VACACIONES" && b.motivo === "ROTACION") { previa.motivo = "ROTACION"; previa.desde = b.desde; }
        continue;
      }
      const entrada = { id: b.residenteId, motivo: b.motivo, desde: b.desde };
      vistos.set(b.residenteId, entrada);
      if (!cohorts.has(c)) cohorts.set(c, []);
      cohorts.get(c).push(entrada);
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

  return { OCUPA_PUESTO, rotationHistoryStart, buildMonthContext, validateMonth };
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
  const { periodsOfResident, levelOn } = Residents;

const err = (detalle, extra = {}) => ({ invariante: "INV-14", severidad: "error", detalle, ...extra });


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
    .filter((r) => levelOn(periodsOfResident(r), periodoInicio) === "R3")
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

  if (levelOn(periodsOfResident(titular), responsable.periodoInicio) !== "R3") {
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
//  - `buildResumenRows`: hoja "Resumen YYYY-YY", una fila por residente activo en el CURSO
//    académico (jun–may), con SUMIF encadenado cruzando las pestañas mensuales publicadas de
//    ese curso y la diferencia máx-mín agrupada por COHORTE de ingreso — mismo criterio de
//    agrupación que INV-3/V-2, no por nivel actual como hacía el Excel viejo.
//  - `buildContajeTrimestralRows`: hoja "Contaje Trimestral YYYY-YY", el total por residente
//    y trimestre del contaje (T1 jun-ago … T4 mar-may) más la diferencia máx-mín por cohorte
//    en cada trimestre. Es lo que el Responsable comunica a tutoría al cerrar el trimestre.
//
// LA VENTANA ES EL CURSO ACADÉMICO (decisión V-25), y las dos hojas la llevan en el NOMBRE
// para que la del curso pasado no se sobreescriba — es lo que hacía el .xlsm recreándose cada
// año, y encima acota la cadena SUMIF a ≤12 términos por celda en vez de crecer sin techo (a
// diez años eran ~10.800 SUMIF de columna completa por recálculo).
//
// NINGUNA de las dos hojas puede reproducir el veredicto de INV-3, y por eso ninguna dice
// "dif ≤ 1" ni habla de equidad: son una LECTURA, no una validación (ver `NOTA_LIMITES`). Las
// diferencias son estructurales, no de precisión, y están medidas:
//  - la ventana de INV-3 anual es el AÑO DE RESIDENCIA de cada residente, que arranca en su
//    aniversario y no en junio; cuatro cierres anuales con dif=1 —los cuatro OK para INV-3—
//    acumulan una dif de por vida de 4;
//  - los dos cierres de INV-3 NORMALIZAN por disponibilidad (descuentan la baja médica), y eso
//    no es expresable en una fórmula de hoja: con una baja de 6 meses INV-3 calla y un
//    MAXIFS/MINIFS sobre totales brutos marcaría una diferencia de 25;
//  - la hoja solo ve meses PUBLICADOS, así que un trimestre está incompleto hasta que se
//    publica su tercer mes.
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

  const { datesOfMonth, weekday, addDays, addYears, academicYearOf, trimesterOf, toISO } = Calendar;
  const { periodsOfResident, levelOn, isActiveOn } = Residents;

const GUARDIA_CODES = new Set(["G", "GF", "GP"]);

const FIXED_HEADERS = ["Residente", "Nivel", "G", "GF", "GP", "3P", "Fines de Semana", "Dobl. V-D", "Total"];
const LEVEL_RANK = { R4: 4, R3: 3, R2: 2, R1: 1 };
// «Dif. máx-mín (cohorte)» es un HECHO y se queda. La segunda columna era «Equidad (dif. ≤ 1)»,
// que invocaba el umbral de INV-3 sobre una ventana y unos totales que no son los suyos (ver la
// cabecera del fichero): ahora dice de qué curso habla y que es orientativo, decisión V-25.
const RESUMEN_HEADER = ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Reparto del curso (orientativo)"];
const TRIMESTRES_ORDEN = [
  { clave: "T1", etiqueta: "T1 jun-ago" },
  { clave: "T2", etiqueta: "T2 sep-nov" },
  { clave: "T3", etiqueta: "T3 dic-feb" },
  { clave: "T4", etiqueta: "T4 mar-may" },
];
const CONTAJE_HEADER = ["Residente", "Cohorte", ...TRIMESTRES_ORDEN.map((t) => t.etiqueta)];

// La nota va DENTRO de la hoja, no solo en este comentario: el Sheet es el entregable y lo lee
// gente que no abre el repo. Sin ella, «Dif. máx-mín» invita a leerse como el «dif ≤ 1» de la
// normativa, que es justo lo que estas hojas no pueden comprobar.
const NOTA_LIMITES = "Lectura orientativa, no es la comprobación de INV-3: solo cuenta meses ya PUBLICADOS de este curso (un trimestre está incompleto hasta publicar su tercer mes), no descuenta bajas médicas (el validador de la app sí lo hace) y la equidad de la normativa se cierra por año de residencia de cada uno, que empieza en su aniversario y no en junio.";

/** Etiqueta del curso académico: 2026 → "2026-27". Ordena bien y no colisiona entre cursos. */
function cursoLabel(curso) {
  return `${curso}-${String((curso + 1) % 100).padStart(2, "0")}`;
}

/**
 * Rellena todas las filas hasta el ancho de la más ancha, con "".
 *
 * OBLIGATORIO en todo lo que devuelva este módulo: `Code.gs` escribe con
 * `getRange(1,1,rows.length,rows[0].length).setValues(rows)`, y `setValues` exige una matriz
 * RECTANGULAR — una fila más corta lanza «The number of columns in the data does not match». Una
 * fila de nota o de separación es lo primero que rompe eso, y ningún test lo vería: el `ss` de los
 * fakes es un array de arrays sin límites (la misma ceguera que dejó pasar el fallo de la rejilla
 * de 26 columnas hasta que se probó en vivo).
 */
function rectangular(rows) {
  const ancho = rows.reduce((max, f) => Math.max(max, f.length), 0);
  return rows.map((f) => (f.length === ancho ? f : [...f, ...Array(ancho - f.length).fill("")]));
}

/** Los meses publicados que caen en el curso académico dado, ordenados cronológicamente. */
function monthsOfCurso(publishedMonths, curso) {
  return [...new Map(publishedMonths.map((m) => [monthSheetName(m.anio, m.mes), m])).values()]
    .filter((m) => academicYearOf(toISO(m.anio, m.mes, 1)) === curso)
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
}

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


/** Residentes activos (R1-R4) en alguna de `dates`, con su primer día activo dentro de ese conjunto. */
function activeResidents(residentes, dates) {
  return residentes
    .map((r) => ({ ...r, periods: periodsOfResident(r) }))
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
  return { sheetName: monthSheetName(anio, mes), rows: rectangular(rows) };
}

function sumifChain(mesesOrdenados, rowNum, col) {
  if (mesesOrdenados.length === 0) return 0;
  const terms = mesesOrdenados.map((m) => {
    const hoja = monthSheetName(m.anio, m.mes);
    return `SUMIF('${hoja}'!$A:$A,$A${rowNum},'${hoja}'!$${col}:$${col})`;
  });
  return `=${terms.join("+")}`;
}

/** Residentes activos en alguno de esos meses, con su cohorte, ordenados por cohorte y nombre. */
function activosDeLosMeses(residentes, meses) {
  const fechas = meses.flatMap((m) => datesOfMonth(m.anio, m.mes));
  return activeResidents(residentes, fechas)
    .map((r) => ({ nombre: r.nombre, cohorte: Number(r.fechaInicio.slice(0, 4)) }))
    .sort((a, b) => a.cohorte - b.cohorte || a.nombre.localeCompare(b.nombre));
}

/** MAXIFS-MINIFS de `col` entre las filas de la MISMA cohorte (columna B), para la fila `i`. */
function difCohorteFormula(col, i, lastRow) {
  const rango = `$${col}$2:$${col}$${lastRow}`;
  const cohortes = `$B$2:$B$${lastRow}`;
  return `=IF($B${i}="","",MAXIFS(${rango},${cohortes},$B${i})-MINIFS(${rango},${cohortes},$B${i}))`;
}

/**
 * Filas de la hoja "Resumen YYYY-YY" (spec.md §7): carga por residente en el CURSO académico,
 * agregando por SUMIF sobre las pestañas mensuales publicadas de ese curso, con la diferencia
 * máx-mín por cohorte de ingreso.
 *
 * La ventana es el curso (decisión V-25) y va en el nombre de la hoja: sin eso, republicar un mes
 * de otro curso sobreescribiría la hoja del anterior. NO reproduce el veredicto de INV-3 y no lo
 * pretende — ver la cabecera del fichero y `NOTA_LIMITES`, que se escribe en la propia hoja.
 *
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[], curso:number }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
function buildResumenRows({ residentes, publishedMonths, curso }) {
  const meses = monthsOfCurso(publishedMonths, curso);
  const rows = [RESUMEN_HEADER];
  for (const r of activosDeLosMeses(residentes, meses)) {
    const rowNum = rows.length + 1;
    rows.push([
      r.nombre, r.cohorte,
      sumifChain(meses, rowNum, "I"), // Total
      sumifChain(meses, rowNum, "G"), // Fines de Semana
      sumifChain(meses, rowNum, "D"), // Festivos (columna GF de la pestaña mensual)
      sumifChain(meses, rowNum, "E"), // Prefestivos (columna GP)
      sumifChain(meses, rowNum, "H"), // Dobletes V-D
      sumifChain(meses, rowNum, "F"), // 3P
      "", "", // dif y lectura: se rellenan abajo, una vez se conoce el rango completo de filas
    ]);
  }

  // El umbral no se deja como celda editable (a diferencia del Excel viejo) porque el validador
  // real de la app NO lo lee de aquí: un umbral editable en el Sheet que no afecta a INV-3 sería
  // engañoso. Y el veredicto ya no dice "OK/REVISAR" sobre "dif ≤ 1", que era invocar el umbral de
  // INV-3 sobre una ventana y unos totales que no son los suyos (V-25).
  const lastRow = rows.length;
  for (let i = 2; i <= lastRow; i++) {
    rows[i - 1][8] = difCohorteFormula("C", i, lastRow);
    rows[i - 1][9] = `=IF($B${i}="","",IF(I${i}<=1,"equilibrado","desigual: mirar en la app"))`;
  }
  rows.push([], [NOTA_LIMITES]);
  return { sheetName: `Resumen ${cursoLabel(curso)}`, rows: rectangular(rows) };
}

/**
 * Filas de la hoja "Contaje Trimestral YYYY-YY" (spec.md §7, Fase 7.2): el total por residente en
 * cada trimestre del contaje, más la diferencia máx-mín por cohorte en cada uno. Es lo que el
 * Responsable tiene que comunicar a tutoría al cerrar cada trimestre y hasta ahora no existía
 * fuera de la app.
 *
 * Los trimestres se agrupan por MES (`trimesterOf`), nunca por posición de fila: trocear por
 * rangos fijos es el «bug de trimestres posicionales» que el .xlsm tenía y que ADR-001 manda
 * eliminar — al insertar un residente se desalineaba en silencio. Y T3 (dic-feb) cruza el año
 * natural, así que agrupar por año de calendario tampoco valdría.
 *
 * Muestra los ejes de INV-3 TRIMESTRAL (solo el total, decisión V-13/P-8), no la carga anual por
 * nivel del .xlsm: enseñar una cifra distinta de la que juzga el invariante es la trampa que
 * V-11(c) ya evitó en el Resumen.
 *
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[], curso:number }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
function buildContajeTrimestralRows({ residentes, publishedMonths, curso }) {
  const meses = monthsOfCurso(publishedMonths, curso);
  const porTrimestre = TRIMESTRES_ORDEN.map((t) => meses.filter((m) => trimesterOf(toISO(m.anio, m.mes, 1)) === t.clave));

  const rows = [CONTAJE_HEADER];
  for (const r of activosDeLosMeses(residentes, meses)) {
    const rowNum = rows.length + 1;
    // Columna I de la pestaña mensual = Total (G+GF+GP), el único eje del cierre trimestral.
    rows.push([r.nombre, r.cohorte, ...porTrimestre.map((ms) => sumifChain(ms, rowNum, "I"))]);
  }

  const lastRow = rows.length;
  if (lastRow > 1) {
    // Una fila por cohorte, que es la comparación que hace INV-3 (dentro de la promoción). Las de
    // UN SOLO miembro se omiten: su MAXIFS-MINIFS vale 0 por definición y una fila permanente a 0
    // se lee como «equilibrado» cuando en realidad no hay con quién comparar. INV-3 tampoco compara
    // ahí (es el mismo criterio del aviso de C-3: solo cuando alguna cohorte tiene ≥2 miembros).
    const porCohorte = new Map();
    for (const f of rows.slice(1, lastRow)) porCohorte.set(f[1], (porCohorte.get(f[1]) || 0) + 1);
    const cohortes = [...porCohorte.keys()].filter((c) => porCohorte.get(c) >= 2).sort();
    if (cohortes.length === 0) return { sheetName: `Contaje Trimestral ${cursoLabel(curso)}`, rows: rectangular([...rows, [], [NOTA_LIMITES]]) };

    rows.push([]);
    rows.push(["Dif. máx-mín por cohorte", "", ...TRIMESTRES_ORDEN.map(() => "")]);
    for (const c of cohortes) {
      const fila = [`Cohorte ${c}`, c];
      for (let t = 0; t < TRIMESTRES_ORDEN.length; t++) {
        const col = columnLetter(3 + t); // C, D, E, F
        fila.push(`=MAXIFS($${col}$2:$${col}$${lastRow},$B$2:$B$${lastRow},$B${rows.length + 1})-MINIFS($${col}$2:$${col}$${lastRow},$B$2:$B$${lastRow},$B${rows.length + 1})`);
      }
      rows.push(fila);
    }
  }
  rows.push([], [NOTA_LIMITES]);
  return { sheetName: `Contaje Trimestral ${cursoLabel(curso)}`, rows: rectangular(rows) };
}

  return { cursoLabel, monthSheetName, columnLetter, buildMonthSheetRows, buildResumenRows, buildContajeTrimestralRows };
})();

// ── schedule.js ──
var Schedule = (function () {
// Generador determinista de cuadrante mensual (spec.md §5, decisión V-34). PURO: sin red, sin
// Sheets, sin React y sin dependencias — recibe el MISMO `ctx` que arma `buildMonthContext` y
// devuelve una propuesta de asignaciones. No la escribe en ningún sitio: quien la aplique pasa
// por `comprobar()`/`aplicar()` como si la hubiera pegado a mano, así que sigue vigente todo el
// guardarraíl de V-31 (reemplazo del mes, rechazo de fechas ajenas e ids inventados) y sigue
// mandando el validador — «la IA propone, el validador dispone» vale igual para esto, que no es
// más que otro proponente.
//
// LAS TRES REGLAS DE V-32, QUE SON LO QUE DECIDE EL DISEÑO. No son preferencias de estilo: se
// midieron el 2026-08-08 contra el juez real y cada una tiene un contraejemplo medido.
//   1. Se persigue el ACUMULADO DEL AÑO DE RESIDENCIA, nunca el mes. Equilibrar dentro del mes
//      da 0/6 al cierre anual: un mes perfectamente repartido encima de un acumulado torcido lo
//      deja igual de torcido. Por eso la métrica de cada residente arranca en SU aniversario y
//      no el día 1.
//   2. Se compara `total/f` y no `total`, con `f` = fracción de días disponibles (las bajas
//      descuentan). Igualar en crudo falla 0/6 en cuanto hay una baja, porque igualar en crudo a
//      quien vuelve de tres meses de baja es EXACTAMENTE lo que INV-3 penaliza: el juez lo lee
//      como 68,19 frente a 51. Dividiendo sube a 4/6.
//   3. Hace falta un operador que REASIGNE, no solo que intercambie: un intercambio conserva el
//      número de guardias de cada uno, así que un buscador de solo-swap no puede mover nunca el
//      eje `total`. Aquí `MOVER` es la mitad de los pasos por eso.
//
// DÍAS CONSECUTIVOS (INV-15): nadie hace dos guardias seguidas. Es restricción dura y se poda
// por construcción, igual que INV-5 e INV-11 — las otras dos que producen `error`. La adyacencia
// se mira también contra el mes ANTERIOR (el histórico): la última guardia de septiembre veta el
// 1 de octubre, o la regla se cumpliría solo por dentro de cada mes y se rompería justo en el
// borde, que es donde nadie mira.
//
// Si ningún elegible puede coger el día sin encadenar, el puesto se queda SIN CUBRIR y se dice
// (`sinCubrir`, con `motivo: "descanso"`). No se rellena: proponerlo sería proponer algo ilegal
// —y algo que el validador va a marcar como error de todas formas—, y un día vacío al menos dice
// la verdad, que es que ese día no tiene solución legal con esta plantilla y hay que resolverlo
// fuera de la aplicación. El generador nunca propone lo que el validador rechaza.
//
// El juez de la equidad sigue siendo `equity.js` en el cierre; esto solo es quien propone. La
// función de coste de aquí IMITA a `validateResidencyYearClose` (mismos seis ejes, misma
// normalización, misma agrupación por cohorte) pero no lo llama: el validador juzga un cierre
// —solo habla en el mes del aniversario— y el generador necesita orientarse en CUALQUIER mes.
// Si algún día divergen, manda el validador y hay que corregir esto.

  const { datesOfMonth, addDays, isHoliday, bridgesOfMonth, bridgesBetween, compareISO, trimesterWindow } = Calendar;
  const { periodsOfResident, levelOn, groupOf, periodOn } = Residents;
  const { tally } = Tally;
  const { absences, BLOQUEA_ASIGNACION, DESCUENTA_DISPONIBILIDAD } = Absences;
  const { thirdPostCycleRepeats } = Thirdpost;
  const { OCUPA_PUESTO } = Validate;
  const { availabilityFraction, residentIsFreeOnBridge, DIMS, PROPORCIONAL } = Equity;

// Los seis ejes y su normalización vienen de `equity.js`, no de una copia aquí: el generador
// tiene que perseguir EXACTAMENTE lo que el cierre le va a medir. La copia que había se quedó
// desfasada en cuanto `puentesLibres` pasó a normalizarse (V-27) y el generador estuvo
// optimizando un objetivo distinto del juez sin que ningún test fallara.
const EPS = 1e-9;
const VERANO = new Set([6, 7, 8]);

/**
 * PRNG determinista (LCG). `Math.random` está prohibido aquí: dos ejecuciones con el mismo `ctx`
 * y la misma semilla tienen que dar el MISMO cuadrante, o revisar una propuesta no significaría
 * nada y no se podría reproducir un reparto discutido.
 */
function rng(semilla) {
  let s = semilla >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * Código que le toca al día: GF si es festivo, GP si es la VÍSPERA de uno, G en el resto. Es la
 * regla que comprueba INV-12 leída al derecho — el generador no puede escribir un código que el
 * validador vaya a marcar como incoherente. Sin festivos cargados todo sale G, que es lo correcto
 * (S-4: los festivos son dato de entrada, jamás se deducen).
 */
function codigoDe(fecha, festivos) {
  if (isHoliday(fecha, festivos)) return "GF";
  if (isHoliday(addDays(fecha, 1), festivos)) return "GP";
  return "G";
}

const cohorteDe = (r) => Number(r.fechaInicio.slice(0, 4));

/**
 * Genera una propuesta de cuadrante para el mes de `ctx`.
 *
 * @param {object} ctx El mismo objeto que devuelve `buildMonthContext`. Se usan `mes`, `anio`,
 *   `residentes`, `asignaciones` (el HISTÓRICO; lo que caiga dentro del mes se descarta, ver
 *   abajo), `bloqueos` y `festivos`. `eventos` no se usa: INV-10 es aviso y su reparto es un
 *   sorteo documentado (V-20), no algo que deba inventar un generador.
 * @param {object} opciones
 *   - semilla: entero, cambia la propuesta sin cambiar su calidad esperada (permite pedir «otra»)
 *   - pasos: tope de iteraciones de la búsqueda local
 * @returns {{asignaciones: {fecha:string, residenteId:string, codigo:string}[], diagnostico: object}}
 */
function generateMonth(ctx, opciones = {}) {
  const { mes, anio, residentes = [], asignaciones: historicoBruto = [], bloqueos = [], festivos = [] } = ctx;
  // `tercerPuesto`, `voluntarios3P` e `historial3P` viajan por OPCIONES y no por `ctx` a
  // propósito: `ctx` es el que arma `buildMonthContext` para `validateMonth`, y INV-8 no lo
  // valida `validateMonth` sino `validateThirdPost`, con sus propias entradas. Meterlos en el ctx
  // habría hecho creer que el validador del mes los mira.
  const { semilla = 1, pasos = 20000, tercerPuesto = 0, voluntarios3P = [], historial3P = {} } = opciones;

  const dias = datesOfMonth(anio, mes);
  const monthStart = dias[0];
  const monthEnd = dias[dias.length - 1];

  // El histórico se recorta a lo ANTERIOR al mes. `buildMonthContext` concatena histórico y mes,
  // y la pantalla además pide el histórico con 1-2 días de lookahead dentro del mes (contrato
  // C-1): si esas filas se colaran, contarían a la vez que la propuesta que estamos construyendo
  // para esos mismos días y el generador perseguiría un acumulado inflado. Se filtra AQUÍ y no se
  // confía en que el invocador lo haya hecho, que es el error que ya se pagó una vez en
  // `Generator.jsx`.
  const historico = historicoBruto.filter((a) => compareISO(a.fecha, monthStart) < 0);
  const historicoDe = new Map();
  for (const a of historico) {
    if (!historicoDe.has(a.residenteId)) historicoDe.set(a.residenteId, []);
    historicoDe.get(a.residenteId).push(a);
  }

  const puentesDelMes = bridgesOfMonth(anio, mes, festivos);

  // ── Quién puede coger guardia, y con qué ventana se le mide ────────────────────────────────
  // Se ordena por id: el resultado tiene que ser el mismo en cualquier motor de JS, y un empate
  // resuelto por orden de llegada del array haría que dos cargas distintas del mismo mes dieran
  // cuadrantes distintos.
  const activos = [];
  for (const r of [...residentes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const periodos = periodsOfResident(r);
    const nivelPorDia = new Map();
    let ancla = null;
    for (const f of dias) {
      const nivel = levelOn(periodos, f);
      nivelPorDia.set(f, nivel);
      if (ancla === null && groupOf(nivel) !== null) ancla = f;
    }
    if (ancla === null) continue; // ni un solo día asignable este mes (FINALIZADO o sin empezar)

    // La ventana es SU año de residencia en curso, anclado al primer día del mes en que está
    // activo — el mismo criterio de `projection.js` (V-23): con `monthStart` a secas, quien
    // empieza a mitad de mes no tendría ventana y se quedaría fuera de la equidad de su cohorte.
    const win = periodOn(periodos, ancla);
    if (!win) continue;

    const bajas = absences(bloqueos, { residenteId: r.id, motivos: DESCUENTA_DISPONIBILIDAD });
    activos.push({
      id: r.id,
      cohorte: cohorteDe(r),
      nivelPorDia,
      win,
      // `f` se mide sobre la ventana ENTERA del año, no sobre lo transcurrido: es lo que va a
      // dividir el juez en el cierre, así que perseguir otra cosa sería perseguir otro objetivo.
      // Una baja futura ya baja `f` hoy, y eso es correcto: marca el ritmo al que ese residente
      // debe acumular para acabar cuadrado.
      f: availabilityFraction(win, bajas),
      // Las mismas filas que descuentan disponibilidad en el juez. NO se reusa `vetados`, que
      // hoy da la misma lista pero responde a otra pregunta (BLOQUEA_ASIGNACION, INV-5): los
      // conjuntos de `absences.js` están separados a propósito y confundirlos es justo lo que
      // V-19 prohíbe.
      bajasDescuento: bajas,
      // Fin de la ventana de medida: su aniversario si cae dentro del mes, si no el fin de mes.
      medidaHasta: compareISO(win.end, monthEnd) < 0 ? win.end : monthEnd,
      historico: historicoDe.get(r.id) || [],
      // Días en que NO puede coger guardia: BAJA es el único motivo DURO (INV-5, V-8).
      vetados: new Set(diasCubiertosPor(absences(bloqueos, { residenteId: r.id, motivos: BLOQUEA_ASIGNACION }), dias)),
      // Guardias YA hechas antes del mes. Solo importa la víspera del día 1, pero se guardan
      // todas: un Set es más barato de leer que de recortar, y así la regla de adyacencia no
      // depende de que el invocador haya pedido el histórico con el borde justo.
      // OCUPA_PUESTO y no una lista propia: INV-15 cuenta el 3P (V-35), así que un 3P del mes
      // anterior veta el día 1 igual que una guardia. Con el conjunto local de G/GF/GP que había
      // aquí no lo vetaba, y el generador proponía —medido— una guardia el 1-oct pegada a un 3P
      // del 30-sep: un `error` de INV-15 producido por el propio generador, que dice no proponer
      // nunca lo que el validador rechaza. Cuarta vez que una copia de un conjunto del dominio se
      // desincroniza; `validate.js` lo exporta desde V-36 justo para esto.
      previas: new Set((historicoDe.get(r.id) || []).filter((x) => OCUPA_PUESTO.has(x.codigo)).map((x) => x.fecha)),
      fechas: new Set(), // lo que le vaya asignando la búsqueda
    });
  }
  const porId = new Map(activos.map((a) => [a.id, a]));

  // ── Elegibilidad por día y puesto ──────────────────────────────────────────────────────────
  // Los dos pools son DISJUNTOS por construcción (un residente es Mayor o Pequeño ese día, nunca
  // las dos cosas), así que nadie puede acabar cubriendo los dos puestos del mismo día.
  const esVerano = VERANO.has(mes);
  const poolDe = (puesto, fecha) => activos.filter((a) => {
    if (a.vetados.has(fecha)) return false;                       // INV-5
    const nivel = a.nivelPorDia.get(fecha);
    if (groupOf(nivel) !== (puesto === "M" ? "MAYOR" : "PEQUENO")) return false;
    if (puesto === "P" && esVerano && nivel === "R1") return false; // INV-11
    return true;
  });

  /**
   * ¿Puede `a` coger `fecha` sin quedar con dos guardias seguidas? Mira el día anterior y el
   * siguiente, tanto en lo propuesto este mes como en el histórico (el borde con el mes anterior).
   * Se usa también DESPUÉS de mutar, para validar un movimiento: por eso pregunta por los vecinos
   * y nunca por `fecha` misma.
   */
  const tieneVecino = (a, fecha) => {
    const antes = addDays(fecha, -1), despues = addDays(fecha, 1);
    return a.fechas.has(antes) || a.previas.has(antes) || a.fechas.has(despues) || a.previas.has(despues);
  };

  // ── Métrica de un residente: acumulado del año + lo que lleve propuesto este mes ────────────
  // Se computa de una vez sobre [aniversario .. fin de la medida] en vez de sumar «acumulado +
  // mes» por separado, y eso NO es una simplificación: el doblete de borde (contrato C-1) empareja
  // el viernes del último día del mes anterior con el domingo de este, así que partir la ventana
  // lo perdería justo en el borde que S-5 existe para no perder.
  // El código de cada día del mes es fijo (depende solo del calendario), y `puentesPrevios` —los
  // puentes del año ya transcurrido que el residente no cubrió— depende solo del histórico, que
  // la búsqueda nunca toca. Las dos cosas se calculan UNA vez: dentro de `metrica` costaban un
  // `bridgesBetween` sobre medio año de calendario en cada uno de los ~40.000 pasos, y eran el
  // 95% del tiempo de generación (6,6 s → 0,2 s en el escenario peor medido).
  const codigoPorDia = new Map(dias.map((f) => [f, codigoDe(f, festivos)]));
  const puentesDelMesHasta = new Map();
  for (const a of activos) {
    // Quién tiene un puente LIBRE lo decide `equity.js:residentIsFreeOnBridge`, no un filtro de
    // aquí. El que había —«no lo trabajó»— se quedó desfasado con V-27, que además de normalizar
    // este eje dejó de contar como libre el puente caído dentro de CUALQUIER ausencia: no fue el
    // reparto quien se lo dio, no estaba en el hospital ese día. Medido, el generador le acreditaba
    // a quien estaba de baja en diciembre el puente del 7-dic que el juez no le cuenta, y por eso
    // su coste y el del cierre no hablaban de lo mismo. Quinta copia de una regla del dominio que
    // se desincroniza en silencio.
    a.puentesPrevios = bridgesBetween(a.win.start, addDays(monthStart, -1), festivos)
      .filter((p) => residentIsFreeOnBridge(a.id, a.historico, p, a.win, bloqueos)).length;
    // Los puentes del mes que PUEDEN ser suyos: dentro de su ventana de medida y fuera de una
    // ausencia. Se precalcula con el reparto VACÍO —igual que hace el banco— para que la regla la
    // siga poniendo el dominio sin recorrer un array en cada uno de los ~20.000 pasos: lo que
    // queda por preguntar en cada paso es solo «¿lo trabaja?», que es un `has` sobre un Set.
    puentesDelMesHasta.set(a.id, puentesDelMes.filter((p) => compareISO(p, a.medidaHasta) <= 0
      && residentIsFreeOnBridge(a.id, [], p, a.win, bloqueos)));
    // PREVISIÓN SOBRE UN EJE ESCASO (decisión V-39). `puentesLibres` no se parece a los otros
    // cinco: no se gana haciendo guardias, se conserva NO haciéndolas, y el año entero trae 3 o 4
    // oportunidades. Midiéndolo solo hasta hoy, el generador de junio ve a todos a cero y no tiene
    // motivo para no darle el puente de junio a quien en diciembre va a estar de baja — y cuando
    // en diciembre se ve el desequilibrio ya no queda puente con el que arreglarlo. Medido: eso
    // era el aviso de `puentesLibres` que quedaba en «dos bajas simultáneas».
    //
    // La previsión es el techo de cada uno: los puentes que aún le quedan por delante y podrían
    // ser suyos (dentro de su ventana y fuera de una ausencia). Es constante para la búsqueda —los
    // meses futuros no existen todavía— pero DISTINTA por residente, y esa diferencia es justo la
    // que hace visible hoy que a alguien le quedan menos oportunidades que a los demás.
    //
    // Solo se proyecta este eje, y no por comodidad: los otros cinco cuentan lo que SÍ ocurrió y
    // sus oportunidades futuras son muchas y compartidas, así que suponer que se las llevará todas
    // no dice nada. Este cuenta lo que NO ocurrió sobre un calendario cerrado y conocido de
    // antemano, que es lo que lo hace proyectable.
    a.puentesFuturos = compareISO(addDays(monthEnd, 1), a.win.end) > 0 ? 0
      : bridgesBetween(addDays(monthEnd, 1), a.win.end, festivos)
        .filter((p) => residentIsFreeOnBridge(a.id, [], p, a.win, bloqueos)).length;
  }

  // ── El trimestre en curso (INV-3 trimestral, V-13 — objetivo añadido en V-37) ───────────────
  // El cierre anual y el trimestral miden ventanas DISTINTAS, y perseguir solo la anual no trae
  // la otra: medido, el óptimo anual falla el trimestral en los seis escenarios del banco (17-33
  // avisos) porque nada le impide amontonar un trimestre y vaciar otro mientras el año cuadra.
  // Y no son incompatibles — pidiendo los dos salen los dos, 3/3 —, así que aquí se piden.
  //
  // La ventana que se persigue es el trimestre HASTA EL FIN DE ESTE MES, no el trimestre entero:
  // los meses que aún no existen no se pueden repartir, y equilibrar lo que va corriendo es lo
  // que deja el trimestre cuadrado el día que cierra. `trimesterWindow` la da el dominio, igual
  // que `quarterCloseWindow` se la da al router: aquí no se adivina ningún borde de trimestre.
  const trimestre = trimesterWindow(monthStart);
  const trimHasta = { start: trimestre.start, end: monthEnd };
  let diasTrim = 0;
  for (let d = trimHasta.start; compareISO(d, trimHasta.end) <= 0; d = addDays(d, 1)) diasTrim++;
  for (const a of activos) {
    // Lo que ya llevaba del trimestre antes de este mes es constante: la búsqueda no lo toca.
    a.trimPrevio = tally(a.historico, { start: trimHasta.start, end: addDays(monthStart, -1) }).total;
    // Disponibilidad DENTRO del trimestre en curso, que es distinta de la del año: quien está de
    // baja justo estos tres meses tiene `f` anual alta y `fTrim` baja, y es la segunda la que el
    // cierre trimestral le va a dividir.
    let disponibles = 0;
    for (let d = trimHasta.start; compareISO(d, trimHasta.end) <= 0; d = addDays(d, 1)) {
      if (compareISO(d, a.win.start) < 0 || compareISO(d, a.win.end) > 0) continue;
      if (a.bajasDescuento.some((b) => compareISO(d, b.desde) >= 0 && compareISO(d, b.hasta) <= 0)) continue;
      disponibles++;
    }
    a.fTrim = disponibles / diasTrim;
  }

  const metrica = (a) => {
    const t = tally([...a.historico, ...[...a.fechas].map((f) => ({ fecha: f, codigo: codigoPorDia.get(f) }))],
      { start: a.win.start, end: a.medidaHasta });
    // `puentesLibres` cuenta los puentes de su ventana que NO cubre: los del año ya transcurrido
    // (constantes) más los de este mes que la propuesta le deja libres.
    const delMes = puentesDelMesHasta.get(a.id).filter((p) => !a.fechas.has(p)).length;
    return {
      total: t.total, findes: t.finde, festivos: t.festivos,
      prefestivos: t.prefestivos, dobletes: t.dobletes,
      // + `puentesFuturos`: el techo que aún le queda (V-39). Sube el valor de todos, pero de
      // cada uno lo suyo, y es la diferencia lo que el coste mira.
      puentesLibres: a.puentesPrevios + delMes + a.puentesFuturos,
      // Guardias del trimestre en curso. Todo lo que propone la búsqueda cae dentro del mes, y el
      // mes cae entero dentro del trimestre, así que basta sumar el tamaño del Set: no hace falta
      // un segundo `tally` en cada uno de los ~40.000 pasos.
      trimestre: a.trimPrevio + a.fechas.size,
    };
  };

  // ── Coste: lo mismo que mide INV-3, por cohorte ────────────────────────────────────────────
  // Devuelve DOS números a propósito (igual que el banco de V-32). `duro` es lo que se pasa de
  // ±1 y llega a 0 exacto, que es lo que permite parar en cuanto hay solución; `guia` es la
  // dispersión total, que orienta cuando el duro ya está a 0 en un eje pero no en otro — pero
  // nunca llega a cero, así que mezclarlos dejaría el bucle sin condición de parada.
  const cohortes = new Map();
  for (const a of activos) {
    if (!cohortes.has(a.cohorte)) cohortes.set(a.cohorte, []);
    cohortes.get(a.cohorte).push(a);
  }
  // Una cohorte de uno no se compara con nadie, igual que en el validador.
  const comparables = [...cohortes.entries()].filter(([, g]) => g.length >= 2).map(([c]) => c);

  const costeCohorte = (cohorte, M) => {
    const grupo = cohortes.get(cohorte);
    let duro = 0, guia = 0;
    for (const eje of DIMS) {
      let mx = -Infinity, mn = Infinity, fMx = 1, fMn = 1;
      for (const a of grupo) {
        const v = PROPORCIONAL.has(eje) ? M[a.id][eje] / a.f : M[a.id][eje];
        if (v > mx) { mx = v; fMx = a.f; }
        if (v < mn) { mn = v; fMn = a.f; }
      }
      // La tolerancia es la del juez, `1/min(f)` del par (V-37): el ±1 es una guardia de verdad y
      // al dividir por la disponibilidad una guardia vale `1/f`. Con un 1 fijo aquí, el generador
      // se exigiría más de lo que el cierre le va a medir en cuanto alguien tenga `f` < 1 — que es
      // la misma clase de desajuste que ya costó que persiguiera otro `puentesLibres` que el juez.
      duro += Math.max(0, mx - mn - (PROPORCIONAL.has(eje) ? 1 / Math.min(fMx, fMn) : 1));
      guia += mx - mn;
    }
    // El cierre TRIMESTRAL: un solo eje (`total`), normalizado por la disponibilidad DEL TRIMESTRE
    // y no por la del año, y fuera quien no llegue a media disponibilidad (V-13).
    {
      let mx = -Infinity, mn = Infinity, fMx = 1, fMn = 1, n = 0;
      for (const a of grupo) {
        if (a.fTrim < 0.5) continue;
        const v = M[a.id].trimestre / a.fTrim;
        if (v > mx) { mx = v; fMx = a.fTrim; }
        if (v < mn) { mn = v; fMn = a.fTrim; }
        n++;
      }
      if (n >= 2) {
        duro += Math.max(0, mx - mn - 1 / Math.min(fMx, fMn));
        guia += mx - mn;
      }
    }
    return { duro, guia };
  };
  const peor = (x, y) => x.duro > y.duro + EPS || (Math.abs(x.duro - y.duro) <= EPS && x.guia > y.guia + EPS);

  // ── Siembra: el que menos lleva, primero ───────────────────────────────────────────────────
  // Greedy por `total/f` (regla 2 de V-32 desde el primer reparto, no solo en la búsqueda). Sin
  // esta siembra la búsqueda local parte de un reparto aleatorio y necesita un orden de magnitud
  // más de pasos para llegar al mismo sitio.
  const slots = [];
  const sinCubrir = [];
  for (const fecha of dias) {
    for (const puesto of ["M", "P"]) {
      const base = poolDe(puesto, fecha);
      if (!base.length) {
        sinCubrir.push({ fecha, puesto: puesto === "M" ? "Mayor" : "Pequeño", motivo: "sin elegibles" });
        continue;
      }
      // INV-15 poda el pool igual que INV-5 o INV-11, y si lo vacía el puesto se queda SIN
      // CUBRIR: proponer la guardia consecutiva sería proponer algo ilegal, y el generador no
      // propone nada que el validador vaya a marcar como error. Un día sin nadie dice la verdad
      // —«este día no tiene solución legal con esta plantilla»— y se arregla fuera de la app;
      // rellenarlo lo disfrazaría de cuadrante correcto.
      const pool = base.filter((a) => !tieneVecino(a, fecha));
      if (!pool.length) {
        sinCubrir.push({ fecha, puesto: puesto === "M" ? "Mayor" : "Pequeño", motivo: "descanso" });
        continue;
      }
      const elegido = pool.reduce((mejor, cand) => {
        const vc = metrica(cand).total / cand.f;
        const vm = metrica(mejor).total / mejor.f;
        // Empate → el id menor: sin desempate explícito el resultado dependería del orden del array.
        return vc < vm - EPS || (Math.abs(vc - vm) <= EPS && cand.id < mejor.id) ? cand : mejor;
      });
      elegido.fechas.add(fecha);
      slots.push({ fecha, puesto, id: elegido.id });
    }
  }

  // ── Búsqueda local ─────────────────────────────────────────────────────────────────────────
  const rnd = rng(semilla);
  const M = {};
  for (const a of activos) M[a.id] = metrica(a);
  const C = {};
  for (const c of comparables) C[c] = costeCohorte(c, M);
  const duroTotal = () => comparables.reduce((s, c) => s + C[c].duro, 0);

  // Parada por estancamiento. El tope de `pasos` solo se llega a gastar cuando el reparto NO se
  // puede cuadrar —alguien llega con tanta ventaja acumulada que un mes no basta para
  // compensarla—, y ahí seguir iterando no mejora nada: medido sobre 30 meses reales, la búsqueda
  // converge por debajo de 2.000 pasos o no converge nunca. Sin esto, el caso imposible costaba
  // 20.000 pasos para devolver exactamente el mismo cuadrante.
  const ESTANCAMIENTO = 2000;
  let aceptados = 0;
  let desdeLaUltimaMejora = 0;
  let mejorCoste = Infinity;
  for (let k = 0; k < pasos && slots.length && duroTotal() > EPS; k++) {
    if (desdeLaUltimaMejora >= ESTANCAMIENTO) break;
    desdeLaUltimaMejora++;
    const a = slots[(rnd() * slots.length) | 0];
    // MOVER la mitad de los pasos es imprescindible (regla 3 de V-32): un intercambio conserva el
    // número de guardias de cada uno, así que sin mover el eje `total` es inalcanzable.
    const mover = rnd() < 0.5;
    const actual = porId.get(a.id);

    let otro, b = null;
    if (mover) {
      // La adyacencia se filtra ANTES de mutar: quien ya tiene el día de al lado no es candidato.
      const cand = poolDe(a.puesto, a.fecha).filter((x) => x.id !== a.id && !tieneVecino(x, a.fecha));
      if (!cand.length) continue;
      otro = cand[(rnd() * cand.length) | 0];
    } else {
      b = slots[(rnd() * slots.length) | 0];
      if (b.puesto !== a.puesto || b.id === a.id) continue;
      otro = porId.get(b.id);
      // El intercambio tiene que dejar a los dos en un día en que siguieran siendo elegibles.
      if (!poolDe(a.puesto, b.fecha).some((x) => x.id === a.id)) continue;
      if (!poolDe(b.puesto, a.fecha).some((x) => x.id === b.id)) continue;
    }

    // Aplica, mide, y deshace si empeora.
    actual.fechas.delete(a.fecha); otro.fechas.add(a.fecha);
    if (!mover) { otro.fechas.delete(b.fecha); actual.fechas.add(b.fecha); }

    // El intercambio se comprueba DESPUÉS de mutar: cada uno suelta un día y coge otro, así que
    // la adyacencia solo se puede juzgar sobre el estado resultante. Si el movimiento crearía dos
    // guardias seguidas se deshace, pase lo que pase con el coste: es restricción, no preferencia.
    if (!mover && (tieneVecino(otro, a.fecha) || tieneVecino(actual, b.fecha))) {
      actual.fechas.add(a.fecha); otro.fechas.delete(a.fecha);
      otro.fechas.add(b.fecha); actual.fechas.delete(b.fecha);
      continue;
    }

    const previoA = M[actual.id], previoB = M[otro.id];
    M[actual.id] = metrica(actual); M[otro.id] = metrica(otro);
    const tocadas = [...new Set([actual.cohorte, otro.cohorte])].filter((c) => comparables.includes(c));
    const antes = tocadas.reduce((x, c) => ({ duro: x.duro + C[c].duro, guia: x.guia + C[c].guia }), { duro: 0, guia: 0 });
    const nuevos = tocadas.map((c) => costeCohorte(c, M));
    const desp = nuevos.reduce((x, y) => ({ duro: x.duro + y.duro, guia: x.guia + y.guia }), { duro: 0, guia: 0 });

    if (peor(desp, antes)) {
      actual.fechas.add(a.fecha); otro.fechas.delete(a.fecha);
      if (!mover) { otro.fechas.add(b.fecha); actual.fechas.delete(b.fecha); }
      M[actual.id] = previoA; M[otro.id] = previoB;
    } else {
      tocadas.forEach((c, i) => (C[c] = nuevos[i]));
      if (mover) a.id = otro.id;
      else { const t = a.id; a.id = b.id; b.id = t; }
      aceptados++;
      // Solo una mejora ESTRICTA reinicia el contador: aceptar movimientos de coste igual es lo
      // que deja a la búsqueda recorrer mesetas, pero si solo hay meseta ya no está avanzando.
      const coste = comparables.reduce((s, c) => s + C[c].duro + C[c].guia, 0);
      if (coste < mejorCoste - EPS) { mejorCoste = coste; desdeLaUltimaMejora = 0; }
    }
  }

  // ── Salida ─────────────────────────────────────────────────────────────────────────────────
  // Ordenada por fecha y puesto: una propuesta que cambia de orden entre ejecuciones es
  // imposible de comparar a ojo con la anterior.
  const guardias = slots
    .slice()
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.puesto < y.puesto ? -1 : 1))
    .map((s) => ({ fecha: s.fecha, residenteId: s.id, codigo: codigoDe(s.fecha, festivos) }));

  const tp = repartirTercerPuesto({ dias, guardias, activos, porId, rnd, tercerPuesto, voluntarios3P, historial3P });
  const asignaciones = [...guardias, ...tp.asignaciones]
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.codigo < y.codigo ? -1 : x.codigo > y.codigo ? 1 : 0));

  return {
    asignaciones,
    diagnostico: {
      // Días que el generador NO ha podido cubrir por falta de gente elegible. No es un fallo del
      // buscador y no se puede «mejorar» con más pasos: ese día no había nadie. Se dice para que
      // quien mire la propuesta sepa que el INV-1 que va a saltar viene de la plantilla.
      sinCubrir,
      cohortesComparadas: comparables.length,
      pasosAceptados: aceptados,
      // `duro` a 0 significa «los seis ejes dentro de ±1 en todas las cohortes comparables», que
      // es exactamente lo que pide INV-3. No es una promesa sobre el cierre: el cierre mide el año
      // entero y aquí solo se ha decidido un mes.
      coste: comparables.reduce((s, c) => s + C[c].duro, 0),
      residentes: activos.map((a) => ({
        id: a.id, cohorte: a.cohorte, guardiasDelMes: a.fechas.size,
        disponibilidad: Math.round(a.f * 100) / 100, acumulado: M[a.id],
      })),
      tercerPuesto: tp.diagnostico,
    },
  };
}

/**
 * Reparte `tercerPuesto` 3P sobre el mes ya resuelto (decisión V-38). Devuelve las asignaciones y
 * un diagnóstico que dice cuántas se pidieron, cuántas salieron y por qué no más.
 *
 * VA DESPUÉS DE LAS GUARDIAS, y eso lo permite INV-4: `tally` excluye el 3P de los seis ejes, así
 * que colocarlo no puede estropear la equidad que la búsqueda acaba de cuadrar. Al revés sí
 * importaría: un 3P puesto antes bloquearía días por adyacencia y estrecharía el reparto de lo
 * obligatorio por lo voluntario, que es al revés de como manda la normativa.
 *
 * Las cuatro reglas de INV-8, todas por construcción y ninguna reimplementada aquí:
 *  - **8a** solo a quien constaba voluntario ESE día (su `desde`, y su `hasta` si se retiró).
 *  - **8b** el ciclo L-D lo juzga `thirdpost.js:thirdPostCycleRepeats`, la MISMA función que usa
 *    el validador. Copiarla habría sido peor que de costumbre: el ciclo depende del orden, así
 *    que dos versiones divergen en cuanto una coloca los días en otra secuencia.
 *  - **8c** entre dos candidatos gana el que menos 3P lleva en SU año de residencia (histórico
 *    incluido), que es lo que compara el cierre.
 *  - **8d** primero los días de mochila (los que cubre un R1), y NO se sale de ellos mientras
 *    quede alguno sin cubrir. Así el aviso de 8d no puede llegar a existir: solo salta cuando hay
 *    un 3P en un día sin R1 *y* un día de mochila descubierto. En verano no hay ninguno (INV-11
 *    saca a los R1), y entonces cualquier día vale, que es justo lo que dice la regla.
 *
 * Y **INV-15**, que es `error`: el 3P es tercer puesto de GUARDIA y encadena igual, así que no se
 * propone pegado a nada que ese residente ya ocupe —guardia, 3P o el borde con el mes anterior—,
 * ni el mismo día en que ya tiene guardia.
 */
function repartirTercerPuesto({ dias, guardias, activos, porId, rnd, tercerPuesto, voluntarios3P, historial3P }) {
  const pedidas = Math.max(0, Math.floor(Number(tercerPuesto) || 0));

  // Días de mochila: los que cubre un R1 (INV-8d). Se leen de la propuesta ya hecha, no de una
  // regla propia: el nivel del día lo decidió `nivelPorDia` al armar los activos. Se cuentan
  // SIEMPRE, incluso al salir sin colocar nada: el diagnóstico tiene una sola forma, o la pantalla
  // que lo pinte tendría que distinguir «cero» de «no se miró».
  const mochila = new Set();
  for (const g of guardias) {
    const a = porId.get(g.residenteId);
    if (a && a.nivelPorDia.get(g.fecha) === "R1") mochila.add(g.fecha);
  }
  const base = { pedidas, colocadas: 0, motivo: null, diasMochila: mochila.size, porResidente: [] };
  if (!pedidas) return { asignaciones: [], diagnostico: base };
  if (!voluntarios3P.length) return { asignaciones: [], diagnostico: { ...base, motivo: "sin-voluntarios" } };

  // Estado por voluntario: sus 3P previos (para el ciclo y para la equidad) y lo que se le va
  // colocando. `ocupados` son los días en que ya está puesto para algo, que es lo que mira INV-15.
  const vol = [];
  for (const v of voluntarios3P) {
    const a = porId.get(v.residenteId);
    if (!a) continue; // no está activo este mes: ni puede coger 3P ni hay a quién medirle nada
    const previas = (historial3P[v.residenteId] || []).slice();
    vol.push({
      a, desde: v.desde, hasta: v.hasta || null,
      previas,
      // Solo los de SU año de residencia en curso cuentan para 8c, que es la ventana del cierre.
      acumulado: previas.filter((f) => compareISO(f, a.win.start) >= 0 && compareISO(f, a.win.end) <= 0).length,
      puestas: [],
    });
  }
  if (!vol.length) return { asignaciones: [], diagnostico: { ...base, motivo: "sin-voluntarios-activos" } };

  const ocupado = (v, f) => v.a.fechas.has(f) || v.a.previas.has(f) || v.puestas.includes(f);
  const puede = (v, f) => {
    if (compareISO(f, v.desde) < 0 || (v.hasta && compareISO(f, v.hasta) > 0)) return false; // 8a
    if (v.a.vetados.has(f)) return false;                                                    // INV-5
    if (ocupado(v, f) || ocupado(v, addDays(f, -1)) || ocupado(v, addDays(f, 1))) return false; // INV-15
    // 8b: ¿repetiría día de semana? Se le pregunta al dominio con la secuencia COMPLETA, porque
    // el ciclo depende del orden y un 3P colocado hoy puede volver repetición a uno de después.
    const todas = v.previas.concat(v.puestas, [f]);
    return thirdPostCycleRepeats(todas, v.desde).length <= thirdPostCycleRepeats(v.previas.concat(v.puestas), v.desde).length;
  };

  const barajar = (xs) => { const o = xs.slice(); for (let i = o.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const diasMochila = barajar(dias.filter((f) => mochila.has(f)));
  const diasResto = barajar(dias.filter((f) => !mochila.has(f)));

  const asignaciones = [];
  let motivo = null;
  for (const grupo of [diasMochila, diasResto]) {
    // No se pasa al resto de días mientras quede mochila por cubrir: ese es justo el par que
    // hace saltar 8d. Con `pedidas` por debajo de los días de mochila, el corte lo pone `pedidas`
    // y no esto; con la mochila entera cubierta, `quedanMochila` es 0 y se puede seguir.
    const quedanMochila = grupo === diasResto && diasMochila.some((f) => !asignaciones.some((x) => x.fecha === f));
    if (quedanMochila) { motivo = motivo || "mochila-sin-cubrir"; break; }
    for (const f of grupo) {
      if (asignaciones.length >= pedidas) break;
      const candidatos = vol.filter((v) => puede(v, f));
      if (!candidatos.length) { motivo = motivo || "sin-candidato"; continue; }
      // 8c: el que menos lleva en su año; empate por id, que no depende del orden de llegada.
      candidatos.sort((x, y) => (x.acumulado + x.puestas.length) - (y.acumulado + y.puestas.length)
        || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0));
      const elegido = candidatos[0];
      elegido.puestas.push(f);
      asignaciones.push({ fecha: f, residenteId: elegido.a.id, codigo: "3P" });
    }
    if (asignaciones.length >= pedidas) break;
  }

  asignaciones.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
  return {
    asignaciones,
    diagnostico: {
      pedidas,
      colocadas: asignaciones.length,
      // Solo se nombra el motivo si de verdad faltaron: pedir 3 y colocar 3 no tiene motivo.
      motivo: asignaciones.length < pedidas ? (motivo || "sin-hueco") : null,
      diasMochila: mochila.size,
      porResidente: vol.filter((v) => v.puestas.length).map((v) => ({ id: v.a.id, n: v.puestas.length })),
    },
  };
}


/** Los días del mes cubiertos por alguno de esos bloqueos. */
function diasCubiertosPor(bloqueos, dias) {
  const out = [];
  for (const f of dias) {
    if (bloqueos.some((b) => compareISO(f, b.desde) >= 0 && compareISO(f, b.hasta) <= 0)) out.push(f);
  }
  return out;
}

  return { generateMonth };
})();

// ── API pública ──
var Domain = Object.assign({}, Calendar, Apply, Residents, Tally, Absences, BlockPreview, Imaginaria, Accumulate, Thirdpost, Equity, Validate, Responsible, Cuadrante, Projection, Schedule);

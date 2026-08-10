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

import { compareISO, addDays, addYears, datesOfMonth, toISO, trimesterWindow, bridgesOfMonth, bridgesBetween } from "./calendar.js";
import { tally } from "./tally.js";
import { absences, DESCUENTA_DISPONIBILIDAD, AUSENTE_EN_PUENTE } from "./absences.js";
import { accumulatedTally } from "./accumulate.js";
import { periodsOfResident } from "./residents.js";

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
export function validateResidencyYearClose(ctx) {
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
export function yearCloseHistoryStart(residentes, mes, anio) {
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
export function buildYearCloseContext({ mes, anio, residentes, historicas = [], asignacionesDelMes = [], bloqueos = [], festivos = [] }) {
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
export function yearCloseFestivosRange(residentes, mes, anio) {
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
export function quarterCloseWindow(mes, anio) {
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
export function validateQuarterClose(ctx) {
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
  const p = periodsOfResident(r).find((per) => inMonth(per.end, mes, anio));
  return p ? { start: p.start, end: p.end } : null;
}

/** Fracción de disponibilidad = (días de la ventana − días de baja) / días de la ventana. */
/**
 * Exportada desde V-30: `schedule.js` divide por el MISMO `f` que este validador, o el generador
 * perseguiría un objetivo distinto del que el cierre le va a medir (regla 2 de V-28). Duplicarla
 * allí era la vía rápida y es justo lo que V-19 prohíbe: dos definiciones de la misma pregunta
 * que empiezan iguales y se separan sin que nadie lo note.
 */
export function availabilityFraction(win, bajas) {
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
const round = (x) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);
function labelDim(dim) {
  return { total: "Totales", findes: "Fines de semana", festivos: "Festivos", prefestivos: "Prefestivos", puentesLibres: "Puentes libres", dobletes: "Dobletes V-D" }[dim];
}

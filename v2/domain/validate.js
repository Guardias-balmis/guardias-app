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

import { datesOfMonth, weekday, compareISO, academicYearOf, toISO, addDays, isHoliday } from "./calendar.js";
import { periodsOfResident, levelOn, groupOf } from "./residents.js";
import { tally } from "./tally.js";
import { absences, isNearbyRotation, BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA } from "./absences.js";

const GUARDIA = new Set(["G", "GF", "GP"]);          // ocupan puesto obligatorio
const ASIGNACION = new Set(["G", "GF", "GP", "3P"]); // cualquier asignación (INV-5, INV-7)
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
export function rotationHistoryStart(bloqueos, monthStart) {
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
export function buildMonthContext({ mes, anio, residentes, historicas = [], asignacionesDelMes, bloqueos, festivos = [], eventos = [] }) {
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
export function validateMonth(ctx) {
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

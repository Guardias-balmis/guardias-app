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

import { datesOfMonth, weekday, compareISO, academicYearOf, toISO, addDays } from "./calendar.js";
import { defaultTrainingPeriods, levelOn, groupOf } from "./residents.js";
import { tally } from "./tally.js";

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
export function validateMonth(ctx) {
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

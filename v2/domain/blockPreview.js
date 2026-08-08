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

import { compareISO, addDays, addMonths, parseISO } from "./calendar.js";
import { groupOnDate, levelOn, periodsOfResident } from "./residents.js";
import { absences, AUSENCIA_SIMULTANEA } from "./absences.js";

const MESES_VENTANA_BLOQUEANTE = 3;
const TECHO_INV2 = 6;
const CONCENTRACION_MAX = 2;

const err = (tipo, detalle, extra = {}) => ({ tipo, severidad: "error", detalle, ...extra });
const aviso = (tipo, detalle, extra = {}) => ({ tipo, severidad: "aviso", detalle, ...extra });

function eachDate(desde, hasta) {
  const out = [];
  for (let d = desde; compareISO(d, hasta) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Último día en que un `Bloqueo` que EMPIECE hoy sigue dentro de la ventana bloqueante de 3 meses. */
export function previewWindowEnd(today) {
  return addMonths(today, MESES_VENTANA_BLOQUEANTE);
}

/** Ventana de Navidad de un año calendario (P-12): 23-26 de diciembre, ambos inclusive. */
export function navidadWindow(anio) {
  return { start: `${anio}-12-23`, end: `${anio}-12-26` };
}

/**
 * Ventana de Año Nuevo de un año calendario (P-12): 29 de diciembre - 6 de enero, estirada
 * hasta Reyes porque también es día de guardia especial. Cruza el año natural: `end` es del
 * año SIGUIENTE a `anio`.
 */
export function anioNuevoWindow(anio) {
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
export function previewBloqueoRisk(nuevo, { residentes, bloqueosActivos, today }) {
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

  // 2. Sobrecarga (espejo INV-2) — siempre aviso. Días del periodo que el grupo debe cubrir
  // (uno por día) divididos entre los que quedarían disponibles en el peor día del periodo.
  if (minDisponibles > 0) {
    const promedio = dias.length / minDisponibles;
    if (promedio > TECHO_INV2) {
      riesgos.push(aviso("SOBRECARGA",
        `${dias.length} día(s) del periodo repartidos entre ${minDisponibles} residente(s) disponible(s): ${promedio.toFixed(1)} de media, por encima del techo de ${TECHO_INV2}/mes`,
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

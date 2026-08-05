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
// Vive en client/lib (módulo .js real, testeable con node:test) y no dentro de la pantalla porque
// un .jsx no puede importar otro .jsx — mismo motivo que closes.js y thirdpost.js.

import { datesOfMonth } from "../../v2/domain/calendar.js";

// Los códigos que el generador propone (el FORMATO DE RESPUESTA del prompt) y, por tanto, los
// únicos que le pertenecen y puede borrar. V/R/B son marcadores de la rejilla que nadie le ha
// pedido y que ningún invariante lee (`tally.js` solo computa G/GF/GP): borrarlos sería destruir
// datos sobre los que el generador no tiene ninguna opinión. Y la ausencia de verdad, la que sí
// leen INV-2/5/6/7, es una fila de `bloqueos` — no una «B» en la rejilla (V-19).
const PROPONIBLES = new Set(["G", "GF", "GP", "3P"]);

const clave = (a) => `${a.fecha}|${a.residenteId}`; // la misma ASIG_KEY que usa el servidor

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
 */
export function monthReplacementPlan({ mes, anio, residentes = [], existentes = [], propuesta = [] }) {
  const delMes = new Set(datesOfMonth(anio, mes));
  const conocidos = new Set(residentes.map((r) => r.id));
  const fueraDelMes = propuesta.filter((a) => !delMes.has(a.fecha));
  const desconocidos = propuesta.filter((a) => !conocidos.has(a.residenteId));
  const propuestaKeys = new Set(propuesta.map(clave));

  const borradas = [];
  const marcadores = [];
  for (const a of existentes) {
    if (!PROPONIBLES.has(a.codigo)) { marcadores.push(a); continue; }
    if (propuestaKeys.has(clave(a))) continue; // la propuesta ya la pisa por clave: nada que borrar
    borradas.push(a);
  }

  return {
    cambios: [
      ...propuesta.map((a) => ({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo })),
      ...borradas.map((a) => ({ fecha: a.fecha, residenteId: a.residenteId, codigo: "" })),
    ],
    borradas,
    marcadores,
    fueraDelMes,
    desconocidos,
  };
}

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

import { datesOfMonth } from "./calendar.js";

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

  const borrables = borrablesDe(propuesta);
  const borradas = [];
  const marcadores = [];
  for (const a of existentes) {
    if (!borrables.has(a.codigo)) { marcadores.push(a); continue; }
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
 *   - marcadores, fueraDelMes, desconocidos, borradas: mismo significado que en
 *     `monthReplacementPlan` (`borradas` siempre vacía aquí, se devuelve por simetría).
 */
export function monthCompletionPlan({ mes, anio, residentes = [], existentes = [], propuesta = [] }) {
  const delMes = new Set(datesOfMonth(anio, mes));
  const conocidos = new Set(residentes.map((r) => r.id));
  const fueraDelMes = propuesta.filter((a) => !delMes.has(a.fecha));
  const desconocidos = propuesta.filter((a) => !conocidos.has(a.residenteId));

  const fijadas = existentes.filter((a) => FIJABLES.has(a.codigo));
  const marcadores = existentes.filter((a) => !FIJABLES.has(a.codigo));
  const fijadaPorClave = new Map(fijadas.map((a) => [clave(a), a]));

  const cambios = [];
  const conflictos = [];
  for (const a of propuesta) {
    const fijada = fijadaPorClave.get(clave(a));
    if (!fijada) { cambios.push({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo }); continue; }
    if (fijada.codigo !== a.codigo) conflictos.push({ propuesta: a, fijada });
    // Misma clave y mismo código: ya está en la tabla, no hay nada que escribir.
  }

  return { cambios, fijadas, conflictos, marcadores, fueraDelMes, desconocidos, borradas: [] };
}

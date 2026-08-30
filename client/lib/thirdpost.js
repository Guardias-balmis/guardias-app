// Tercer puesto (INV-8) visto desde el cliente. Mismo papel que closes.js para los cierres de
// equidad: decide qué rango hace falta, se lo pide al backend y devuelve las violaciones.
//
// Vive en client/lib (módulo .js real, testeable con node:test) y no dentro de la pantalla
// porque un .jsx no puede importar otro .jsx —loader.js transpila cada uno aislado—, así que
// esto es lo único que permite que Calendar.jsx y cualquier pantalla futura compartan el
// ensamblado en vez de copiarlo.
//
// El servidor revalida por su cuenta en `marcarValidado` y es quien decide de verdad. Esto
// existe para que quien pulsa Validar vea los MISMOS avisos, que desde la decisión V-18 son
// además los cuatro de INV-8: ninguno bloquea, pero todos entran en `equityWarnings` y por
// tanto en la confirmación explícita de «Validar de todas formas».

import { toISO, daysInMonth } from "../../v2/domain/calendar.js";
import { validateThirdPost, thirdPostHistoryStart } from "../../v2/domain/thirdpost.js";

/**
 * @param {object} args
 *   - api: cliente de api.js (inyectado; en tests, un doble)
 *   - mes/anio: el mes que se está validando
 *   - residentes: [{id, fechaInicio, fechaFin}]
 *   - asignacionesDelMes: las del mes TAL Y COMO las muestra la pantalla (incluye ediciones sin
 *     guardar). No se reusan las del rango pedido al backend: mezclar ambas fuentes es el bug de
 *     duplicación que ya apareció una vez en el generador.
 * @returns {Promise<{ok:true, violaciones:object[]}|{ok:false, error:string}>} nunca lanza; un
 *   fallo de red se devuelve como {ok:false} para que la pantalla no dé por comprobado INV-8.
 */
export async function thirdPostViolations({ api, mes, anio, residentes, asignacionesDelMes = [] }) {
  const rVol = await api.estadoVoluntariado3P();
  if (!rVol.ok) return { ok: false, error: rVol.error };
  const voluntarios = rVol.voluntarios || [];
  // `periodos` (activos e históricos, V-40) es lo que permite a INV-8a juzgar "¿era voluntario
  // ESE día?" en vez de "¿lo es AHORA?" — igual que `buildThirdPostCtx` en el servidor desde
  // V-28. Sin él (una API vieja en un test que no lo devuelve) cae al criterio de HOY.
  const periodos = rVol.periodos || null;

  const monthStart = toISO(anio, mes, 1);
  const desde = thirdPostHistoryStart(voluntarios, residentes, mes, anio);

  // Sin voluntarios no hay historial que leer: 8a (3P a quien no consta) y 8d (prioridad de
  // mochila) se resuelven con lo que ya hay en pantalla, sin una sola petición de más.
  //
  // El `desde` puede ser POSTERIOR al mes que se valida: es la fecha de alta del voluntario más
  // antiguo, y validar un mes anterior a que nadie se hubiera apuntado es lo normal ahora mismo
  // (la tabla acaba de nacer). En ese caso no hay histórico que pedir — pedirlo mandaría un
  // rango invertido, que el backend rechaza con «rango de fechas inválido» y dejaría INV-8 sin
  // comprobar en la pantalla mientras el servidor sí lo comprueba: dos veredictos distintos
  // sobre el mismo mes, que es justo lo que este módulo existe para evitar.
  const monthEnd = toISO(anio, mes, daysInMonth(anio, mes));
  const historial3P = {};
  if (desde && desde <= monthEnd) {
    const rAsig = await api.listAsignacionesRango(desde, monthEnd);
    if (!rAsig.ok) return { ok: false, error: rAsig.error };
    Object.assign(historial3P, shapeThirdPostHistory(rAsig.asignaciones, monthStart));
  }

  return {
    ok: true,
    violaciones: validateThirdPost({
      mes, anio, residentes,
      asignaciones: asignacionesDelMes,
      voluntarios3P: voluntarios, // con `desde`: el ciclo de 8b arranca en el alta de cada uno (V-18b)
      historial3P,
      periodosVoluntario3P: periodos, // solo para 8a (V-40); 8b/8c siguen sobre el compromiso vigente
    }),
  };
}

/**
 * Asignaciones crudas → el `historial3P` que esperan `validateThirdPost` y el generador:
 * `{ residenteId: [fechas ordenadas] }`, SOLO con los 3P anteriores al mes.
 *
 * Ese recorte es el contrato C-4 y no es opcional: los 3P del propio mes llegan por
 * `asignaciones` (lo que se ve en la rejilla, o lo que el generador está proponiendo), y
 * contarlos por las dos vías rompe el ciclo de 7 días de INV-8b — el mismo día aparecería dos
 * veces en la secuencia y saldría como repetición.
 *
 * Se exportaba para `Generator.jsx`, que montaba el mismo historial desde el histórico que ya
 * tenía cargado. Esa pantalla desapareció con la decisión V-43 (la generación se hace ahora en el
 * servidor), así que hoy el único invocador es la función de arriba y el `export` se queda como
 * punto de entrada probado por si otra pantalla vuelve a necesitar el recorte — la alternativa,
 * copiarlo, es exactamente la clase de duplicado que se desincroniza sin que falle ningún test.
 */
export function shapeThirdPostHistory(asignaciones, monthStart) {
  const historial3P = {};
  for (const a of asignaciones) {
    if (a.codigo !== "3P" || a.fecha >= monthStart) continue;
    (historial3P[a.residenteId] = historial3P[a.residenteId] || []).push(a.fecha);
  }
  for (const id of Object.keys(historial3P)) historial3P[id].sort();
  return historial3P;
}

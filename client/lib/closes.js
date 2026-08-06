// Cierres de equidad de INV-3 vistos desde el cliente: el TRIMESTRAL (P-8, decisión V-13) y
// el ANUAL. Decide si el mes cierra alguno de los dos, pide al backend solo el rango que ese
// cierre necesita y devuelve las violaciones.
//
// Vive en client/lib (módulo .js real, testeable con node:test) y no dentro de la pantalla
// porque un .jsx no puede importar otro .jsx —loader.js transpila cada uno aislado—, así que
// esto es lo único que permite que Calendar.jsx y cualquier pantalla futura compartan el
// ensamblado en vez de copiarlo.
//
// El servidor revalida por su cuenta en `marcarValidado` y es quien decide de verdad. Esto
// existe para que quien pulsa Validar vea la MISMA razón por la que el servidor va a
// rechazarle el cuadrante: sin ello, un cierre anual incumplido bloquearía la validación sin
// ninguna explicación en pantalla.

import { toISO, daysInMonth } from "../../v2/domain/calendar.js";
import {
  quarterCloseWindow, validateQuarterClose,
  yearCloseHistoryStart, yearCloseFestivosRange, buildYearCloseContext, validateResidencyYearClose,
} from "../../v2/domain/equity.js";

/**
 * @param {object} args
 *   - api: cliente de api.js (inyectado; en tests, un doble)
 *   - mes/anio: el mes que se está validando
 *   - residentes: [{id, fechaInicio, fechaFin}]
 *   - asignacionesDelMes: las del mes TAL Y COMO las muestra la pantalla (incluye ediciones
 *     sin guardar). No se reusan las del rango pedido al backend para el mes: mezclar ambas
 *     fuentes es el bug de duplicación que ya apareció una vez en el generador.
 * @returns {Promise<{ok:true, violaciones:object[]}|{ok:false, error:string}>} nunca lanza; un
 *   fallo de red se devuelve como {ok:false} para que la pantalla no dé por comprobado un
 *   cierre que nunca llegó a comprobarse (mismo patrón de bug corregido ya en 6.1 y 6.2).
 */
export async function closeViolations({ api, mes, anio, residentes, asignacionesDelMes = [] }) {
  const trimestre = quarterCloseWindow(mes, anio);
  const desdeAnual = yearCloseHistoryStart(residentes, mes, anio);
  // 8 de cada 12 meses no cierran nada: ni una petición de más.
  if (!trimestre && !desdeAnual) return { ok: true, violaciones: [] };

  const monthStart = toISO(anio, mes, 1);
  const monthEnd = toISO(anio, mes, daysInMonth(anio, mes));
  const desde = [trimestre ? trimestre.start : null, desdeAnual]
    .filter(Boolean)
    .reduce((min, d) => (d < min ? d : min));

  // Los festivos solo los pide el cierre ANUAL, para derivar los puentes del eje `puentesLibres`
  // (fase 3 de V-17): el trimestral mide únicamente `total`. El rango lo da el dominio y abarca
  // el año de residencia entero, que cruza dos años naturales.
  const rangoFestivos = yearCloseFestivosRange(residentes, mes, anio);

  const [rAsig, rBloq, rFest] = await Promise.all([
    api.listAsignacionesRango(desde, monthEnd),
    api.listBloqueosRango(desde, monthEnd),
    rangoFestivos ? api.listFestivosRango(rangoFestivos.desde, rangoFestivos.hasta) : Promise.resolve({ ok: true, festivos: [] }),
  ]);
  if (!rAsig.ok) return { ok: false, error: rAsig.error };
  if (!rBloq.ok) return { ok: false, error: rBloq.error };
  // Un fallo al cargar los festivos NO se degrada a "no hay puentes": eso daría el eje por
  // cuadrado sin haberlo mirado, que es exactamente lo que este módulo existe para no hacer.
  if (!rFest.ok) return { ok: false, error: rFest.error };

  const previas = rAsig.asignaciones.filter((a) => a.fecha < monthStart);
  const bloqueos = rBloq.bloqueos;
  const violaciones = [];

  if (trimestre) {
    violaciones.push(...validateQuarterClose({
      mes, anio, residentes, bloqueos,
      asignaciones: [...previas.filter((a) => a.fecha >= trimestre.start), ...asignacionesDelMes],
    }));
  }

  if (desdeAnual) {
    violaciones.push(...validateResidencyYearClose(buildYearCloseContext({
      mes, anio, residentes, bloqueos,
      historicas: previas.filter((a) => a.fecha >= desdeAnual),
      asignacionesDelMes,
      festivos: rFest.festivos,
    })));
  }

  return { ok: true, violaciones };
}

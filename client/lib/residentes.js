// Qué residentes puede pintar la app y cuáles no (decisiones V-22/V-24, 2026-09-04).
//
// Cada pantalla deriva el nivel de TODOS los residentes al renderizar (`levelOn(periodsOfResident)`),
// y `parseISO` lanza ante una fecha que no es ISO estricta. Con una sola fila mal tecleada en la hoja
// («31/05/2026», o «25/05/2029» en `fechaFin`), la excepción subía al render y React desmontaba la
// SPA entera para todo el equipo. Esto aparta a esos residentes ANTES de que ninguna pantalla los
// toque: los legibles se pintan como siempre; los ilegibles se enseñan aparte, con el motivo, y la
// pantalla de Residentes ofrece su editor de fechas para corregirlos desde la app.
//
// Se comprueban las dos fechas de la ficha ADEMÁS de la derivación del nivel: `periodsOfResident`
// devuelve las filas de `periodos` sin mirar `fechaInicio`/`fechaFin` cuando hay cuatro, así que un
// residente con periodos editados y una `fechaFin` ilegible pasaba por legible en Inicio y en el
// cuadrante — y justo la pantalla de Residentes, la única desde la que se puede corregir esa fecha,
// era la que lanzaba al derivar los periodos automáticos para compararlos.

import { parseISO } from "../../v2/domain/calendar.js";
import { levelOn, periodsOfResident } from "../../v2/domain/residents.js";

/**
 * @param {object[]} residentes  tal cual llegan del servidor
 * @param {string} hoy  ISO del día (para derivar el nivel)
 * @returns {{legibles: object[], ilegibles: {residente: object, motivo: string}[]}}
 */
export function partirResidentesLegibles(residentes, hoy) {
  const legibles = [];
  const ilegibles = [];
  for (const r of residentes || []) {
    try {
      if (r.fechaInicio !== undefined && r.fechaInicio !== "") parseISO(r.fechaInicio);
      if (r.fechaFin !== undefined && r.fechaFin !== "") parseISO(r.fechaFin);
      levelOn(periodsOfResident(r), hoy);
      legibles.push(r);
    } catch (e) {
      ilegibles.push({ residente: r, motivo: (e && e.message) || String(e) });
    }
  }
  return { legibles, ilegibles };
}

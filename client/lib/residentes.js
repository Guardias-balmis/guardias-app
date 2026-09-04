// Residentes cuyas fechas se pueden leer, separados de los que no (2026-09-04).
//
// Por qué existe: el Sheet es datastore y entregable a la vez y se edita a mano, así que una
// `fechaInicio` tecleada como "31/05/2026" en la hoja `residentes` es algo que PUEDE pasar (el
// alta y `editarResidente` ya no lo dejan entrar, pero la hoja sí). El nivel se deriva de esas
// fechas en CADA pantalla y para TODOS los residentes al pintar —Inicio, el cuadrante, el
// equipo— y `periodsOfResident`/`levelOn` lanzan con una fecha ilegible: una excepción en render
// desmonta el árbol entero, o sea que una fila mal tecleada dejaba la app en blanco para las
// quince personas, sin ningún mensaje. `App.jsx` aparta aquí a los ilegibles al cargar la lista y
// avisa nombrándolos; `Residentes.jsx` los enseña con su error y el editor de fechas, que es la
// salida dentro de la herramienta (nadie va a poder arreglar la hoja a mano dentro de diez años).
//
// Módulo `.js` real (no `.jsx`) para poder probarse con node:test y compartirse entre pantallas.

import { periodsOfResident, levelOn } from "../../v2/domain/residents.js";

/**
 * @param {object[]} residentes  tal y como llegan de `listResidentes`/`login`
 * @param {string} hoy  fecha ISO con la que se comprueba que el nivel se puede derivar
 * @returns {{legibles: object[], ilegibles: {residente: object, motivo: string}[]}}
 */
export function partirResidentesLegibles(residentes, hoy) {
  const legibles = [];
  const ilegibles = [];
  for (const r of residentes || []) {
    try {
      levelOn(periodsOfResident(r), hoy);
      legibles.push(r);
    } catch (e) {
      ilegibles.push({ residente: r, motivo: String((e && e.message) || e) });
    }
  }
  return { legibles, ilegibles };
}

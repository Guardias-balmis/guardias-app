// Aviso de descanso (INV-15) en el momento de escribir una celda de la rejilla.
//
// POR QUÉ EXISTE. `schedule.js` no reparte 3P, así que el tercer puesto lo pone SIEMPRE una
// persona a mano, encima de un mes que el generador ya ha dejado limpio. Y el sitio libre es mucho
// menor de lo que parece: medido sobre años generados, un residente con sus ~4,6 guardias del mes
// tiene el 42% del mes vetado para un 3P —sus días más los dos vecinos de cada uno—, y en el peor
// caso observado (un R2 con 8 guardias en agosto) le quedaban 6 días de 31. Medido también el
// daño: colocando el 3P a ciegas, uno de cada tres crea un error de INV-15, y con 4 al mes el 74%
// de los meses dejan de poder validarse.
//
// Como INV-15 es `error`, basta uno para bloquear la validación. Sin este aviso el fallo se
// descubre mucho después, al pulsar Validar, y el mensaje habla de días consecutivos sin mencionar
// el 3P que acaba de escribirse — que es justo el dato que le falta a quien tiene que arreglarlo.
//
// Esto NO bloquea nada (V-14): la celda se escribe igual. Solo dice, en el instante en que se
// comete, lo que si no se sabría al final.
//
// Vive en client/lib porque un .jsx no puede importar otro .jsx, mismo motivo que closes.js,
// thirdpost.js y closes.js.

import { addDays } from "../../v2/domain/calendar.js";
import { OCUPA_PUESTO } from "../../v2/domain/validate.js";

/**
 * ¿La celda que se acaba de escribir encadena con un día vecino del mismo residente?
 * @param {object} p
 *   - codigos: {[fecha]: codigo} de ESE residente, tal y como los tiene la rejilla (incluye la
 *     celda recién escrita; se ignora, porque lo que se juzga es su vecindad)
 *   - bordes: [{fecha, codigo}] del MISMO residente en los días de fuera del mes. Sin ellos el par
 *     que cruza el borde (día 1 con el último del mes anterior) sería invisible, que es el mismo
 *     agujero del contrato C-1 y el que tenía el banco de equidad hasta que se corrigió.
 *   - fecha, codigo: la celda escrita
 * @returns {string|null} la fecha vecina con la que encadena, o null si no hay conflicto
 */
export function chainedNeighbour({ codigos = {}, bordes = [], fecha, codigo }) {
  // V/R/B no ocupan puesto: marcar vacaciones el día después de una guardia no es encadenar.
  if (!OCUPA_PUESTO.has(codigo)) return null;

  const ocupadas = new Set();
  for (const f of Object.keys(codigos)) {
    if (f !== fecha && OCUPA_PUESTO.has(codigos[f])) ocupadas.add(f);
  }
  for (const b of bordes) {
    if (b.fecha !== fecha && OCUPA_PUESTO.has(b.codigo)) ocupadas.add(b.fecha);
  }

  // El día anterior primero: si encadena por los dos lados, el de antes es el que ya estaba.
  for (const vecina of [addDays(fecha, -1), addDays(fecha, 1)]) {
    if (ocupadas.has(vecina)) return vecina;
  }
  return null;
}

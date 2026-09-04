// Imaginaria (INV-13, spec.md §5; decisión V-20). Normativa p.4, «-Imaginaria»:
//
//   «Se dispone de dos listas de Imaginaria. Una para residentes mayores y otra para residentes
//    pequeños. En caso de incidencia, se debe intentar suplir la guardia con un residente según
//    lista del grupo del que crea la incidencia. […] La cesión/compra de guardia de incidencia
//    NO descuenta de la imaginaria.»
//
// Esto es una HERRAMIENTA, no un validador: lo que hace falta a las ocho de la mañana con una
// baja encima es saber a quién llamar, por orden. No comprueba a posteriori que quien cubrió
// fuera el que tocaba — una incidencia se resuelve por teléfono en cinco minutos y el registro
// se hace después, así que ese aviso saltaría a menudo por motivos legítimos que la app no ve
// (nadie cogía el teléfono, se cambió con otro). Por eso `validateMonth` no llama aquí.
//
// La cola NO se almacena: se registra cada cobertura real (tabla `imaginaria`) y el orden se
// DERIVA de ese historial, igual que el nivel R1-R4 se deriva de fechas (§1). Una fila menos
// que mantener sincronizada, y el «cesión/compra no descuenta» sale gratis: si nadie de la
// lista cubrió, no hay fila, y por tanto nadie se mueve.

import { addDays } from "./calendar.js";
import { groupOnDate, levelOn, periodsOfResident } from "./residents.js";
import { absences } from "./absences.js";

const GUARDIA = new Set(["G", "GF", "GP"]); // el 3P no ocupa puesto obligatorio

/**
 * ¿Puede este residente entrar en la lista de Imaginaria de `grupo` en esa fecha?
 *
 * Un **R1 nunca entra en la lista de Pequeños**, aunque R1 y R2 formen el grupo Pequeño para
 * todo lo demás (INV-1, INV-11). Es una excepción explícita a la agrupación general, solo para
 * Imaginaria: **no está en la normativa**, es la práctica real del servicio (P-11, decisión
 * V-20) — un R1 no puede sostener solo una guardia que aparece sin previo aviso.
 */
export function isEligibleForImaginaria(residente, grupo, fecha) {
  if (groupOnDate(residente, fecha) !== grupo) return false;
  if (grupo === "PEQUENO" && levelOn(periodsOfResident(residente), fecha) === "R1") return false;
  return true;
}

/**
 * La cola de Imaginaria de un grupo para una incidencia concreta, en orden de a quién llamar.
 *
 * Orden: quien lleva más tiempo sin cubrir una Imaginaria va primero (quien no ha cubierto
 * ninguna, el primero de todos), y a igualdad, por id — el desempate tiene que ser determinista
 * o dos pantallas darían órdenes distintas para la misma incidencia.
 *
 * Se aparta a quien tenga guardia el día ANTERIOR (estaría librando) o el SIGUIENTE (para no
 * comprometer el descanso previo a esa guardia), y a quien tenga guardia la propia noche de la
 * incidencia. Tampoco está en la normativa: práctica real del servicio (V-20).
 *
 * Y se aparta a quien tenga una AUSENCIA registrada ese día (2026-09-04): a quien está de baja no
 * se le puede exigir una guardia (el fundamento de INV-5), y quien está de vacaciones o rotando
 * fuera no está en el hospital para cogerla. Sin esto la lista proponía llamar primero a quien
 * llevaba un mes de baja, justo en el único momento en que la herramienta se usa (las ocho de la
 * mañana con un puesto sin cubrir).
 *
 * @param {object} p
 *   - residentes, coberturas: filas de `imaginaria` (solo las activas), asignaciones
 *   - bloqueos: filas de `bloqueos` (las activas las filtra `absences`, V-19); opcional
 *   - grupo: "MAYOR" | "PEQUENO" — el del puesto que hay que cubrir
 *   - fechaIncidencia: ISO
 * @returns {{residenteId:string, ultimaCobertura:string|null, apartadoPor:string|null}[]}
 *   TODA la lista elegible, en orden, con el motivo de quien queda apartado — la pantalla
 *   enseña a quién llamar y también a quién no, que es lo que evita la llamada inútil.
 */
const AUSENCIA_LABEL = { BAJA: "está de baja", VACACIONES: "está de vacaciones", ROTACION: "está de rotación externa" };

export function imaginariaQueue({ residentes = [], coberturas = [], asignaciones = [], bloqueos = [], grupo, fechaIncidencia }) {
  const vispera = addDays(fechaIncidencia, -1);
  const siguiente = addDays(fechaIncidencia, 1);

  const ultimaPorResidente = new Map();
  for (const c of coberturas) {
    if (c.activo === false) continue;
    const previa = ultimaPorResidente.get(c.residenteId);
    if (!previa || c.fechaIncidencia > previa) ultimaPorResidente.set(c.residenteId, c.fechaIncidencia);
  }

  const guardiaEn = (id, fecha) => asignaciones.some((a) => a.residenteId === id && a.fecha === fecha && GUARDIA.has(a.codigo));
  const ausenciaEn = (id) => absences(bloqueos, { residenteId: id, fecha: fechaIncidencia })[0] || null;

  return residentes
    .filter((r) => isEligibleForImaginaria(r, grupo, fechaIncidencia))
    .map((r) => {
      const ausencia = ausenciaEn(r.id);
      return {
        residenteId: r.id,
        ultimaCobertura: ultimaPorResidente.get(r.id) || null,
        apartadoPor: ausencia ? (AUSENCIA_LABEL[ausencia.motivo] || `tiene una ausencia registrada (${ausencia.motivo})`)
          : guardiaEn(r.id, fechaIncidencia) ? "tiene guardia esa misma noche"
            : guardiaEn(r.id, vispera) ? `tiene guardia el día anterior (${vispera})`
              : guardiaEn(r.id, siguiente) ? `tiene guardia el día siguiente (${siguiente})`
                : null,
      };
    })
    .sort((a, b) => {
      // Los apartados van al final, pero se devuelven: la pantalla dice por qué no se les llama.
      if (!a.apartadoPor !== !b.apartadoPor) return a.apartadoPor ? 1 : -1;
      if (a.ultimaCobertura !== b.ultimaCobertura) {
        if (a.ultimaCobertura === null) return -1;
        if (b.ultimaCobertura === null) return 1;
        return a.ultimaCobertura < b.ultimaCobertura ? -1 : 1;
      }
      return a.residenteId < b.residenteId ? -1 : 1; // desempate determinista
    });
}

/** A quién le toca: el primero no apartado, o `null` si no queda nadie de la lista. */
export function nextForImaginaria(args) {
  const cola = imaginariaQueue(args).filter((x) => !x.apartadoPor);
  return cola.length ? cola[0].residenteId : null;
}

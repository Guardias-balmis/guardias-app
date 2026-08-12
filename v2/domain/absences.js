// Lectura ÚNICA de la tabla `bloqueos` (spec.md §2, decisiones V-6 y V-8). Manda esta tabla:
// una «B» pintada en la rejilla es un código de asignación y no la lee ningún invariante — la
// ausencia real es una fila de `bloqueos`.
//
// Existe porque el mismo dato se filtraba en cinco sitios con criterios escritos a mano y
// distintos entre sí (INV-5, INV-2, INV-6, INV-7 y el descuento de disponibilidad de INV-3),
// más el rango del router. Las diferencias entre esos criterios son REALES —cada invariante
// mira motivos distintos a propósito— así que este módulo no las colapsa: les pone nombre. La
// constante dice para qué invariante vale cada conjunto de motivos, y el filtro es uno solo.
//
// Lo que sí unifica de verdad es `activo`: una fila cancelada (reinsertada con activo=false,
// nunca borrada) se descarta AQUÍ. Antes eso dependía de que cada invocador se acordara de
// filtrarla antes de llamar al dominio; el día que uno no lo hiciera, un bloqueo cancelado
// habría vuelto a bloquear asignaciones sin que ningún test lo notara.

/**
 * Motivos por invariante. Cada lista es una decisión, no un detalle: cambiarla cambia
 * comportamiento, y por eso está aquí y no repetida en cinco `filter` en línea.
 */
// INV-5 (decisión V-8): solo la baja médica impide asignar. No se puede exigir una guardia a
// quien está de baja o de permiso de embarazo/paternidad; vacaciones y rotación NO bloquean.
export const BLOQUEA_ASIGNACION = ["BAJA"];
// INV-2: exime del mínimo de 4 guardias/mes (spec.md §5: «febrero/vacaciones/baja/R1-verano»).
// La rotación NO exime: se sigue haciendo guardia en el hospital de origen.
export const EXIME_DEL_MINIMO = ["VACACIONES", "BAJA"];
// INV-6: cuentan como «ausente» para el máximo de 2 por promoción. La baja NO computa — no es
// una ausencia que nadie haya concedido ni que se pueda repartir.
export const AUSENCIA_SIMULTANEA = ["ROTACION", "VACACIONES"];
// INV-3, nota [a] de p.2: «se descontará de forma proporcional». Solo la baja.
export const DESCUENTA_DISPONIBILIDAD = ["BAJA"];
// Eje `puentesLibres` de INV-3 (decisión V-27): un puente que cae dentro de CUALQUIER ausencia
// concedida no cuenta como "libre" — no fue el reparto quien se lo dio, no estaba en el hospital
// ese día. A diferencia de DESCUENTA_DISPONIBILIDAD (solo BAJA, nota [a] literal), aquí van los
// TRES motivos: el sesgo de que una ausencia inflara este eje no distinguía tipo de ausencia, y
// ROTACION/VACACIONES son más frecuentes que BAJA.
export const AUSENTE_EN_PUENTE = ["BAJA", "VACACIONES", "ROTACION"];

// INV-7: la rotación «cercana» que obliga a cubrir viernes y sábado del periodo. La lista de
// provincias vivía duplicada en `rotationHistoryStart` y en el propio INV-7.
export const PROVINCIAS_CERCANAS = new Set(["alicante", "valencia", "murcia", "albacete"]);

/** ¿Es una rotación externa lo bastante cerca como para que aplique INV-7? */
export function isNearbyRotation(bloqueo) {
  return bloqueo.motivo === "ROTACION"
    && !!bloqueo.provincia
    && PROVINCIAS_CERCANAS.has(bloqueo.provincia.toLowerCase());
}

/**
 * Una fila cancelada se reinserta con `activo=false` y la original se queda (append-only): lo
 * que cuenta es el proyectado. `undefined` se toma como activa a propósito — los tests del
 * dominio y los contextos armados a mano no arrastran la columna, y exigirla convertiría en
 * "sin ausencias" justo lo que se quiere comprobar.
 */
const estaActiva = (b) => b.activo !== false;

/**
 * El lector. Todos los criterios son opcionales y se combinan con AND; sin ninguno, devuelve
 * las ausencias activas tal cual.
 *
 * @param {{residenteId?:string, desde:string, hasta:string, motivo:string, activo?:boolean}[]} bloqueos
 * @param {object} [criterios]
 *   - residenteId: solo las de ese residente
 *   - motivos: string[] — uno de los conjuntos exportados arriba, nunca una lista suelta
 *   - fecha: ISO; solo las que CUBREN ese día
 *   - desde/hasta: ISO; solo las que SOLAPAN ese rango (no las contenidas: una baja de todo el
 *     trimestre tiene que aparecer al preguntar por un mes de dentro)
 * @returns las filas originales (no copias): quien las lea sigue viendo `provincia`, `id`, etc.
 *
 * Compara cadenas y no llama a `parseISO`: esto filtra datos que un humano puede haber editado
 * a mano en el Sheet, y una fila con la fecha mal escrita no debe tumbar la validación entera.
 * En ISO estricto el orden lexicográfico y el cronológico coinciden, así que no se pierde nada.
 */
export function absences(bloqueos = [], criterios = {}) {
  const { residenteId, motivos, fecha, desde, hasta } = criterios;
  return bloqueos.filter((b) => {
    if (!b || !estaActiva(b)) return false;
    if (residenteId !== undefined && b.residenteId !== residenteId) return false;
    if (motivos && !motivos.includes(b.motivo)) return false;
    if (fecha !== undefined && !(fecha >= b.desde && fecha <= b.hasta)) return false;
    if (desde !== undefined && b.hasta < desde) return false;
    if (hasta !== undefined && b.desde > hasta) return false;
    return true;
  });
}

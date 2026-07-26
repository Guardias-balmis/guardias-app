// Presentación de las violaciones del validador. El dominio compara y reporta SIEMPRE por
// `residenteId` a propósito: es puro (no recibe nombres) y volver a indexar por nombre fue un
// bug real del cliente v1 que Calendar.jsx tiene documentado como convención anti-regresión.
// Pero en producción los ids son UUID del store, así que un residente leía literalmente
// "[INV-2] 7f3a1b9c-…: 7 guardias computables > máximo 6". Traducir id→nombre es, por tanto,
// trabajo de la capa de UI, y vive aquí (módulo .js real, testeable con node:test) para que
// Calendar.jsx y Generator.jsx no lo dupliquen — un .jsx no puede importar otro.
//
// Por qué se sustituye dentro del texto en vez de prefijar el nombre de `v.residenteId`: hay
// violaciones que hablan de VARIOS residentes en la misma frase y el campo `residenteId` solo
// puede apuntar a uno — INV-3 compara dos ("a=6 vs b=3"), e INV-6, INV-8 e INV-11 (recuento de
// verano) enumeran una lista. Reescribir esos mensajes para no nombrar a nadie los dejaría sin
// la información que los hace útiles.

/**
 * Texto de una violación listo para mostrar a una persona:
 *  1. sustituye cada id de residente que aparezca en el texto por su nombre;
 *  2. si la violación apunta a un residente (`residenteId`) cuyo nombre no aparece en el texto
 *     —el caso de INV-5, que dice "Asignación G el … sobre bloqueo BAJA" sin nombrar a nadie—,
 *     lo prefija.
 * Un id desconocido (residente que ya no está en la lista, o un id que no es de residente) se
 * deja tal cual: es preferible un UUID visible a ocultar de quién habla la violación.
 *
 * @param {{invariante?:string, detalle?:string, residenteId?:string}} violacion
 * @param {{id:string, nombre:string}[]} residentes  los del contexto de la app
 */
export function violationText(violacion, residentes = []) {
  const nombrePor = nombresPorId(residentes);
  let texto = String((violacion && violacion.detalle) || "");

  // De más largo a más corto: si un id fuera prefijo de otro ("res-ana" y "res-ana-2"),
  // sustituir primero el corto partiría el largo por la mitad.
  for (const id of [...nombrePor.keys()].sort((a, b) => b.length - a.length)) {
    if (texto.includes(id)) texto = texto.split(id).join(nombrePor.get(id));
  }

  const propio = nombrePor.get(violacion && violacion.residenteId);
  return propio && !texto.includes(propio) ? `${propio} — ${texto}` : texto;
}

function nombresPorId(residentes) {
  const out = new Map();
  for (const r of residentes || []) {
    if (r && r.id && r.nombre) out.set(r.id, r.nombre);
  }
  return out;
}

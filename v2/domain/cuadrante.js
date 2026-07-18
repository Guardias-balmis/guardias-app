// Ciclo de estados del Cuadrante (spec.md §2, decisión V-9/V-10, Fase 6.2):
// BORRADOR -> VALIDADO -> PUBLICADO. PURO: solo las reglas de qué transición es válida en
// qué estado. La persistencia (tabla `cuadrantes`) y el permiso por rol de sesión (V-9c: solo
// el Responsable publica/despublica) viven en server/src/router.js.

export const STATES = ["BORRADOR", "VALIDADO", "PUBLICADO"];

/** BORRADOR->VALIDADO exige cero violaciones DURAS (severidad "error", spec.md §5). */
export function canValidate(violaciones) {
  return violaciones.every((v) => v.severidad !== "error");
}

/** VALIDADO->PUBLICADO. */
export function canPublish(estado) {
  return estado === "VALIDADO";
}

/** PUBLICADO->VALIDADO, para corregir un cuadrante ya publicado. */
export function canUnpublish(estado) {
  return estado === "PUBLICADO";
}

/** PUBLICADO bloquea cualquier edición del mes (decisión V-9b); BORRADOR/VALIDADO se pueden tocar. */
export function canEdit(estado) {
  return estado !== "PUBLICADO";
}

/** Estado tras editar asignaciones: un mes VALIDADO deja de estarlo (vuelve a BORRADOR) sin
 * fricción para quien edita. PUBLICADO nunca llega aquí: `canEdit` ya bloquea el guardado antes. */
export function stateAfterEdit(estado) {
  return estado === "VALIDADO" ? "BORRADOR" : estado;
}

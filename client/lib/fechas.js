// Fechas que vienen de un `<input type="date">`, vistas desde el render.
//
// Chromium emite eventos `input` con valores INTERMEDIOS mientras se teclea el año en un campo de
// fecha ("0002-09-04" tras la primera cifra, "0020-…" tras la segunda), y al borrar un segmento
// deja la cadena vacía. `calendar.js:parseISO` los rechaza —con razón: no son fechas— lanzando, y
// una excepción durante el render desmonta la SPA entera: `#root` vacío, sin mensaje, sin vuelta
// atrás salvo recargar (y en el alta de un R1 nuevo, con un pendingToken que caduca mientras
// recarga). Pasó en el alta, en el formulario de ausencias, en los periodos y en los eventos.
//
// Esto envuelve el dominio para el único caso en que una fecha ilegible NO es un error sino un
// estado transitorio del teclado. El servidor sigue validando de verdad (V-22); aquí solo se decide
// si el botón se ofrece y si el texto de ayuda se pinta. Vive en client/lib porque un .jsx no puede
// importar otro .jsx, y son cuatro pantallas las que lo necesitan.

import { parseISO, compareISO } from "../../v2/domain/calendar.js";

/** ¿`iso` es una fecha completa y real? Nunca lanza. */
export function fechaValida(iso) {
  if (typeof iso !== "string" || iso === "") return false;
  try { parseISO(iso); return true; } catch { return false; }
}

/** ¿`desde` y `hasta` son fechas válidas y están en orden (desde ≤ hasta)? Nunca lanza. */
export function rangoValido(desde, hasta) {
  if (!fechaValida(desde) || !fechaValida(hasta)) return false;
  return compareISO(desde, hasta) <= 0;
}

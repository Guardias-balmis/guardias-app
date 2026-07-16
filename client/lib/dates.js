// Envoltorio trivial sobre v2/domain/calendar.js para el "hoy" del navegador. La única
// pieza no-pura del cliente que toca `new Date()` sin argumentos; se inyecta para tests.
import { toISO } from "../../v2/domain/calendar.js";

export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

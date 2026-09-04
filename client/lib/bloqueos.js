// Las ausencias con fecha ilegible, apartadas ANTES de validar en el cliente (2026-09-04).
//
// El servidor lo hace en `router.js:partitionBloqueos` (decisión V-22): una fila de `bloqueos`
// tecleada a mano en la hoja con "30/02/2027" no se puede juzgar, así que se aparta del contexto
// y se emite un `error` INV-5 que la nombra para poder cancelarla. Pero `listBloqueos` la
// DEVUELVE a propósito (si no, no se podría cancelar desde la app), y `Calendar.jsx` la pasaba tal
// cual a `validateMonth`: INV-7 hace aritmética de fechas sobre las rotaciones cercanas y lanzaba,
// dejando el botón en «Validando…». Aquí se replica la misma política, con el mismo texto que el
// servidor, para que el veredicto local y el de `marcarValidado` digan lo mismo.
//
// Módulo `.js` real (un `.jsx` no puede importar otro) y sin tocar el dominio: `absences` compara
// cadenas a propósito y no debe empezar a lanzar por esto.

import { parseISO } from "../../v2/domain/calendar.js";
import { absences } from "../../v2/domain/absences.js";

/** @returns {{usables: object[], corruptas: {bloqueo: object, motivo: string}[]}} solo las activas */
export function partirBloqueosLegibles(bloqueos) {
  const usables = [];
  const corruptas = [];
  for (const b of absences(bloqueos || [])) {
    try {
      parseISO(b.desde);
      parseISO(b.hasta);
      usables.push(b);
    } catch (e) {
      corruptas.push({ bloqueo: b, motivo: String((e && e.message) || e) });
    }
  }
  return { usables, corruptas };
}

/** Un `error` INV-5 por ausencia ilegible, calcado del que emite el servidor (`bloqueoCorruptoViolations`). */
export function violacionesBloqueoIlegible(corruptas) {
  return corruptas.map(({ bloqueo, motivo }) => ({
    invariante: "INV-5",
    severidad: "error",
    residenteId: bloqueo.residenteId,
    detalle: `Ausencia ${bloqueo.motivo || "(sin motivo)"} con fecha ilegible (${bloqueo.desde} → ${bloqueo.hasta}): ${motivo}. `
      + `Mientras siga así no se puede comprobar si hay guardias asignadas sobre ella; cancélala (id ${bloqueo.id}) y vuelve a crearla.`,
  }));
}

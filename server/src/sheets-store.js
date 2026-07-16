// Almacén sobre Google Sheets (ADR-002 D-3, paso 2.3). La lógica (append-only, shadow-swap)
// es pura y testeable; las operaciones de hoja se delegan en un `ss` inyectado (en Apps
// Script, un adaptador de SpreadsheetApp; en los tests, un fake en memoria). Toda escritura
// pasa por `withLock` (un único `LockService.getScriptLock()` para los 15 usuarios, porque el
// Web App corre "Execute as Me" bajo una sola identidad → un lock por usuario no serializaría).
//
// `ss` debe ofrecer: listSheets, exists, read, overwrite, append, createSheet, deleteSheet,
// renameSheet. `newId()` genera UUID (Utilities.getUuid en Apps Script).

import { TABLES, headerOf, recordToRow, rowsToRecords } from "./sheets-schema.js";

const TMP_PREFIX = "_tmp_";

export function makeStore({ ss, withLock, newId }) {
  function table(nameOrTable) {
    const t = typeof nameOrTable === "string" ? TABLES[nameOrTable] : nameOrTable;
    if (!t) throw new Error(`tabla desconocida: ${nameOrTable}`);
    return t;
  }

  /** Añade un registro (append-only). Genera `id` si no lo trae. Devuelve el id. */
  function appendRecord(nameOrTable, record) {
    const t = table(nameOrTable);
    return withLock(() => {
      if (ss.read(t.name).length === 0) ss.append(t.name, [headerOf(t)]); // cabecera si falta
      const id = record.id || newId();
      ss.append(t.name, [recordToRow(t, { ...record, id })]);
      return id;
    });
  }

  /** Lee todos los registros de una tabla normalizada. */
  function readRecords(nameOrTable) {
    const t = table(nameOrTable);
    return rowsToRecords(t, ss.read(t.name));
  }

  /**
   * Reescribe una pestaña (entregable proyectado) de forma idempotente y crash-safe por
   * "shadow-swap": se vuelca a una temporal, se borra la vieja y se renombra la temporal.
   * Si un intento previo cayó a mitad, se limpia el `_tmp_` residual antes de empezar.
   */
  function rebuildSheet(name, rows) {
    return withLock(() => {
      const tmp = TMP_PREFIX + name;
      if (ss.exists(tmp)) ss.deleteSheet(tmp); // limpia residuo de una caída anterior
      ss.createSheet(tmp);
      ss.overwrite(tmp, rows);
      if (ss.exists(name)) ss.deleteSheet(name); // ventana de inconsistencia: dos metadata ops rápidas
      ss.renameSheet(tmp, name);
    });
  }

  return { appendRecord, readRecords, rebuildSheet };
}

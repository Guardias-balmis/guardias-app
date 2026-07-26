// Almacén sobre Google Sheets (ADR-002 D-3, paso 2.3). La lógica (append-only, shadow-swap)
// es pura y testeable; las operaciones de hoja se delegan en un `ss` inyectado (en Apps
// Script, un adaptador de SpreadsheetApp; en los tests, un fake en memoria). Toda escritura
// pasa por `withLock` (un único `LockService.getScriptLock()` para los 15 usuarios, porque el
// Web App corre "Execute as Me" bajo una sola identidad → un lock por usuario no serializaría).
//
// `ss` debe ofrecer: listSheets, exists, read, overwrite, append, createSheet, deleteSheet,
// renameSheet. `newId()` genera UUID (Utilities.getUuid en Apps Script).
//
// Contrato del adaptador, fijado tras un fallo que ningún test podía ver (2026-07-27):
//  - `append(nombre, filas)` CREA la hoja si no existe (este módulo escribe luego la cabecera).
//  - `overwrite` y `append` deben AMPLIAR la rejilla si hace falta. En Apps Script una hoja nace
//    con 1000 filas × 26 columnas y `getRange` fuera de rango lanza: la pestaña mensual de la
//    proyección necesita hasta 40 columnas, y una tabla append-only pasa de 1000 filas sola.
//    El `ss` de los tests es un array de arrays sin límites, así que esto NO lo cubre ningún
//    test: vive en server/Code.gs y se verifica a mano contra el Sheet real.

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
   * Vista de "estado actual" sobre un almacén append-only: para cada clave (`keyFn`), la
   * ÚLTIMA fila insertada gana. Si `opts.emptyField` se indica y el registro ganador tiene
   * ese campo vacío/ausente, es un borrado explícito y se excluye del resultado.
   * Conserva el orden de PRIMERA aparición de cada clave (una reedición no reordena).
   */
  function readLatest(nameOrTable, keyFn, opts = {}) {
    const records = readRecords(nameOrTable);
    const order = [];
    const byKey = new Map();
    for (const r of records) {
      const k = keyFn(r);
      if (!byKey.has(k)) order.push(k);
      byKey.set(k, r); // sobreescribe: la última fila de esta clave gana
    }
    return order
      .map((k) => byKey.get(k))
      .filter((r) => !opts.emptyField || (r[opts.emptyField] !== undefined && r[opts.emptyField] !== ""));
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

  return { appendRecord, readRecords, readLatest, rebuildSheet };
}

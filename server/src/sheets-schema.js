// Esquema de las pestañas de datos normalizadas (ADR-002 D-3). PURO: solo define las tablas
// y el mapeo fila↔registro por tipos. La fuente de verdad es append-only con clave UUID
// (spec §2 / ADR-001 §3): nunca se reescribe una fila cruda, solo se añaden.
//
// Los valores viajan a/desde el Sheet como celdas; cada columna declara su tipo para
// recuperar números/booleanos/JSON sin ambigüedad (un `anio` debe volver como number, no "3").

const col = (key, type = "string") => ({ key, type });

export const TABLES = {
  residentes: { name: "residentes", columns: [col("id"), col("nombre"), col("email"), col("fechaInicio"), col("fechaFin")] },
  periodos: { name: "periodos", columns: [col("id"), col("residenteId"), col("anio", "number"), col("fechaInicio"), col("fechaFin")] },
  bloqueos: { name: "bloqueos", columns: [col("id"), col("residenteId"), col("desde"), col("hasta"), col("motivo"), col("provincia"), col("guardiasEnCentroExterno", "bool"), col("activo", "bool")] },
  asignaciones: { name: "asignaciones", columns: [col("id"), col("fecha"), col("residenteId"), col("codigo"), col("puesto"), col("origen")] },
  responsables: { name: "responsables", columns: [col("id"), col("periodoInicio"), col("periodoFin"), col("residenteId"), col("metodo"), col("voluntarios", "json"), col("semilla"), col("candidatos", "json"), col("fechaSorteo")] },
  voluntariosResponsable: { name: "voluntariosResponsable", columns: [col("id"), col("residenteId"), col("periodoInicio"), col("activo", "bool")] },
  sorteos: { name: "sorteos", columns: [col("id"), col("fecha"), col("motivo"), col("semilla"), col("candidatos", "json"), col("resultado", "json")] },
  // Fase 4: diasPreferidos/diasEvitar (día de semana genérico) y rotDe/rotHasta/vacDe/vacHasta
  // (número de día suelto) del v1 se sustituyen por fechas concretas (BLANDO) y por la tabla
  // `bloqueos` — spec.md §5 Fase 4: "distingue DURO vs BLANDO, son cosas distintas". Desde V-8
  // (Fase 5.x) la severidad dentro de `bloqueos` ya no es uniforme: solo motivo BAJA bloquea
  // la asignación (INV-5); VACACIONES/ROTACION son informativas.
  preferencias: { name: "preferencias", columns: [col("id"), col("residenteId"), col("anio", "number"), col("mes", "number"), col("maxGuardias", "number"), col("preferDobles", "bool"), col("fechasEvitar", "json"), col("notas")] },
};

/** Cabecera (nombres de columna) de una tabla. */
export function headerOf(table) {
  return table.columns.map((c) => c.key);
}

/** Registro → fila de celdas, en el orden de las columnas. */
export function recordToRow(table, record) {
  return table.columns.map((c) => serialize(record[c.key], c.type));
}

/** [cabecera, ...filas] → registros. Ignora la cabecera y mapea por posición de columna. */
export function rowsToRecords(table, values) {
  if (!values || values.length <= 1) return [];
  return values.slice(1).map((row) => {
    const rec = {};
    table.columns.forEach((c, i) => {
      const v = deserialize(row[i], c.type);
      if (v !== undefined) rec[c.key] = v;
    });
    return rec;
  });
}

function serialize(value, type) {
  if (value === undefined || value === null) return "";
  switch (type) {
    case "number": return String(value);
    case "bool": return value ? "TRUE" : "FALSE";
    case "json": return JSON.stringify(value);
    default: return String(value);
  }
}

function deserialize(cell, type) {
  if (cell === undefined || cell === null || cell === "") return undefined;
  switch (type) {
    case "number": return Number(cell);
    case "bool": return cell === true || cell === "TRUE" || cell === "true";
    case "json": try { return JSON.parse(cell); } catch { return undefined; }
    default: return String(cell);
  }
}

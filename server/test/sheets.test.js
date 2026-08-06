// Tests de server/src/sheets-schema.js y sheets-store.js (ADR-002 D-3, paso 2.3).
// El almacén opera sobre un `ss` inyectado (aquí un fake en memoria; en Apps Script, un
// adaptador de SpreadsheetApp). Se prueba: mapeo fila↔registro por tipos, append-only con
// UUID, y la reescritura idempotente crash-safe por shadow-swap (incluida la recuperación
// tras una caída a media reescritura).
import test from "node:test";
import assert from "node:assert/strict";
import { TABLES, recordToRow, rowsToRecords, headerOf } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";

// ── fake de hoja de cálculo en memoria ──
function fakeSS(initial = {}) {
  const sheets = new Map(Object.entries(initial).map(([k, v]) => [k, v.map((r) => r.slice())]));
  const guard = (n) => { if (!sheets.has(n)) throw new Error(`hoja inexistente: ${n}`); };
  return {
    listSheets: () => [...sheets.keys()],
    exists: (n) => sheets.has(n),
    read: (n) => (sheets.get(n) || []).map((r) => r.slice()),
    overwrite: (n, rows) => { guard(n); sheets.set(n, rows.map((r) => r.slice())); },
    append: (n, rows) => { guard(n); sheets.get(n).push(...rows.map((r) => r.slice())); },
    createSheet: (n) => { if (sheets.has(n)) throw new Error(`ya existe: ${n}`); sheets.set(n, []); },
    deleteSheet: (n) => { guard(n); sheets.delete(n); },
    renameSheet: (from, to) => { guard(from); sheets.set(to, sheets.get(from)); sheets.delete(from); },
    _sheets: sheets,
  };
}
const sync = (fn) => fn(); // withLock trivial en tests
let counter = 0;
const seqId = () => `id-${++counter}`;
const store = (ss) => makeStore({ ss, withLock: sync, newId: seqId });

// ── sheets-schema ──
test("recordToRow / rowsToRecords hacen round-trip respetando tipos", () => {
  const rec = { id: "id-1", residenteId: "r1", anio: 3, fechaInicio: "2026-05-07", fechaFin: "2027-05-06" };
  const row = recordToRow(TABLES.periodos, rec);
  const back = rowsToRecords(TABLES.periodos, [headerOf(TABLES.periodos), row]);
  assert.deepEqual(back[0], rec);
  assert.equal(typeof back[0].anio, "number"); // el tipo number se recupera, no queda como string
});

test("tipos bool y json se serializan y recuperan", () => {
  const rec = { id: "b1", residenteId: "r1", desde: "2026-10-01", hasta: "2026-10-10", motivo: "ROTACION", provincia: "Valencia", guardiasEnCentroExterno: true };
  const row = recordToRow(TABLES.bloqueos, rec);
  const back = rowsToRecords(TABLES.bloqueos, [headerOf(TABLES.bloqueos), row])[0];
  assert.equal(back.guardiasEnCentroExterno, true);
  assert.equal(back.provincia, "Valencia");
});

// ── tipo "date": bug real encontrado en el primer uso en vivo (Fase 2.6/7.1, 2026-07-21) ──
// Google Sheets detecta un string "YYYY-MM-DD" y convierte la celda a tipo Fecha interno;
// Apps Script (SpreadsheetApp.getValues()) devuelve entonces un Date real, no el string
// original. serialize() prefija con un apóstrofe (fuerza texto plano en Sheets — invisible
// tras guardar, tanto por UI como por API) para que esto no vuelva a pasar; deserialize()
// recupera "YYYY-MM-DD" tanto de un Date real (ya corrompido antes de este fix, o si algún
// borde de Sheets ignora el apóstrofe) como del string con apóstrofe (el fake `ss` de los
// tests no simula el despojo de Sheets, así que el apóstrofe SÍ llega literal a deserialize).
test('serialize de tipo "date" prefija con apóstrofe (fuerza texto plano en Sheets)', () => {
  const row = recordToRow(TABLES.residentes, { id: "r1", nombre: "Ana", email: "a@x.com", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" });
  assert.equal(row[3], "'2024-05-07");
  assert.equal(row[4], "'2028-05-06");
});

test('deserialize de tipo "date" despoja el apóstrofe de un string (round-trip vía el fake ss)', () => {
  const back = rowsToRecords(TABLES.residentes, [headerOf(TABLES.residentes), recordToRow(TABLES.residentes, { id: "r1", nombre: "Ana", email: "a@x.com", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" })])[0];
  assert.equal(back.fechaInicio, "2024-05-07");
  assert.equal(back.fechaFin, "2028-05-06");
});

test('deserialize de tipo "date" recupera "YYYY-MM-DD" de un Date real (celda ya autoconvertida por Sheets)', () => {
  // new Date(y, m, d) interpreta los componentes en hora LOCAL — igual que los getters
  // locales que usa deserialize — así que el test es portable con independencia del huso
  // horario de la máquina que lo ejecute (no hace falta que coincida con Europe/Madrid).
  const back = rowsToRecords(TABLES.residentes, [headerOf(TABLES.residentes), ["r1", "Ana", "a@x.com", new Date(2024, 4, 7), new Date(2028, 4, 6)]])[0];
  assert.equal(back.fechaInicio, "2024-05-07");
  assert.equal(back.fechaFin, "2028-05-06");
});

test('deserialize de tipo "date" con celda vacía sigue dando undefined (borrado lógico intacto)', () => {
  const back = rowsToRecords(TABLES.residentes, [headerOf(TABLES.residentes), ["r1", "Ana", "a@x.com", "", ""]])[0];
  assert.equal(back.fechaInicio, undefined);
  assert.equal(back.fechaFin, undefined);
});

// ── append-only ──
test("appendRecord genera UUID, escribe cabecera si falta y NO reescribe filas previas", () => {
  const ss = fakeSS();
  ss.createSheet("residentes");
  const st = store(ss);
  const id1 = st.appendRecord("residentes", { nombre: "Ana", email: "ana@gmail.com", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" });
  const id2 = st.appendRecord("residentes", { nombre: "Bea", email: "bea@gmail.com", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" });
  assert.notEqual(id1, id2);
  const rows = ss.read("residentes");
  assert.deepEqual(rows[0], headerOf(TABLES.residentes)); // cabecera
  assert.equal(rows.length, 3); // cabecera + 2
  const recs = st.readRecords("residentes");
  assert.equal(recs.length, 2);
  assert.equal(recs.find((r) => r.id === id1).nombre, "Ana");
});

test("un id explícito se respeta (no se regenera)", () => {
  const ss = fakeSS({ residentes: [headerOf(TABLES.residentes)] });
  const st = store(ss);
  const id = st.appendRecord("residentes", { id: "fijo-123", nombre: "Ana", email: "a@x.com", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" });
  assert.equal(id, "fijo-123");
});

test("readRecords de una hoja vacía o solo-cabecera devuelve []", () => {
  const ss = fakeSS({ residentes: [] });
  assert.deepEqual(store(ss).readRecords("residentes"), []);
  ss.createSheet("periodos");
  ss.append?.("periodos", []);
});

// ── shadow-swap idempotente y crash-safe ──
test("rebuildSheet deja la pestaña con exactamente las filas dadas (idempotente)", () => {
  const ss = fakeSS({ Jun: [["viejo"]] });
  const st = store(ss);
  const rows = [["a", 1], ["b", 2]];
  st.rebuildSheet("Jun", rows);
  assert.deepEqual(ss.read("Jun"), rows);
  st.rebuildSheet("Jun", rows); // idempotente: segunda vez, mismo resultado
  assert.deepEqual(ss.read("Jun"), rows);
  assert.ok(!ss.listSheets().some((n) => n.startsWith("_tmp_"))); // sin temporales residuales
});

test("rebuildSheet funciona si la pestaña destino aún no existe", () => {
  const ss = fakeSS();
  store(ss).rebuildSheet("Jul", [["x"]]);
  assert.deepEqual(ss.read("Jul"), [["x"]]);
});

test("crash a media reescritura: el siguiente rebuild se autorrepara y limpia el _tmp_", () => {
  const ss = fakeSS({ Jun: [["dato-bueno-previo"]] });
  // ss que revienta justo tras borrar el destino, antes del rename (peor momento)
  let boom = true;
  const crashingSS = Object.assign({}, ss, {
    deleteSheet: (n) => { ss.deleteSheet(n); if (boom && n === "Jun") throw new Error("crash simulado tras borrar destino"); },
  });
  assert.throws(() => store(crashingSS).rebuildSheet("Jun", [["nuevo"]]), /crash simulado/);
  // estado tras el crash: destino borrado, existe un _tmp_ con datos a medias
  assert.ok(ss.listSheets().some((n) => n.startsWith("_tmp_")));
  // el siguiente rebuild (ss sano) limpia el _tmp_ y reconstruye el destino desde la fuente
  boom = false;
  store(ss).rebuildSheet("Jun", [["nuevo"]]);
  assert.deepEqual(ss.read("Jun"), [["nuevo"]]);
  assert.ok(!ss.listSheets().some((n) => n.startsWith("_tmp_")));
});

test("todas las escrituras pasan por withLock", () => {
  const ss = fakeSS({ residentes: [headerOf(TABLES.residentes)] });
  let locks = 0;
  const st = makeStore({ ss, withLock: (fn) => { locks++; return fn(); }, newId: seqId });
  st.appendRecord("residentes", { nombre: "Ana", email: "a@x.com", fechaInicio: "2024-05-07", fechaFin: "2028-05-06" });
  st.rebuildSheet("Jun", [["x"]]);
  assert.equal(locks, 2);
});


// --- appendRecords: una escritura, un lock, una comprobación de cabecera --------------------
// Lo que se protege es el COSTE, no solo el resultado: fila a fila, aplicar un mes del generador
// (~60-90 cambios) tomaba el lock y releía la tabla entera por cada cambio.

test("appendRecords escribe el lote con UN lock y UNA lectura, y devuelve los ids en orden", () => {
  const ss = fakeSS({ asignaciones: [] });
  let locks = 0, lecturas = 0;
  const espia = { ...ss, read: (n) => { lecturas++; return ss.read(n); } };
  const st = makeStore({ ss: espia, withLock: (fn) => { locks++; return fn(); }, newId: seqId });

  const cambios = Array.from({ length: 60 }, (_, i) => ({
    fecha: `2027-03-${String((i % 28) + 1).padStart(2, "0")}`, residenteId: `r${i}`, codigo: "G",
  }));
  const ids = st.appendRecords("asignaciones", cambios);

  assert.equal(locks, 1, "un solo lock para todo el lote");
  assert.equal(lecturas, 1, "una sola lectura (la comprobación de cabecera)");
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60, "un id distinto por registro");
  const filas = st.readRecords("asignaciones");
  assert.equal(filas.length, 60);
  assert.equal(filas[0].residenteId, "r0");
  assert.equal(filas[59].residenteId, "r59");
});

test("appendRecords con lote vacío no escribe ni toma el lock", () => {
  const ss = fakeSS({ asignaciones: [] });
  let locks = 0;
  const st = makeStore({ ss, withLock: (fn) => { locks++; return fn(); }, newId: seqId });
  assert.deepEqual(st.appendRecords("asignaciones", []), []);
  assert.equal(locks, 0);
  assert.equal(ss.read("asignaciones").length, 0, "ni siquiera se escribe la cabecera");
});

test("appendRecord sigue funcionando (es appendRecords de un elemento) y respeta un id dado", () => {
  const ss = fakeSS({ bloqueos: [] });
  const st = store(ss);
  const id = st.appendRecord("bloqueos", { residenteId: "r1", desde: "2027-01-01", hasta: "2027-01-05", motivo: "BAJA", activo: true });
  assert.ok(id);
  assert.equal(st.appendRecord("bloqueos", { id, residenteId: "r1", desde: "2027-01-01", hasta: "2027-01-05", motivo: "BAJA", activo: false }), id);
  assert.equal(st.readLatest("bloqueos", (r) => r.id).length, 1, "la reinserción con el mismo id es una cancelación, no una fila nueva");
});

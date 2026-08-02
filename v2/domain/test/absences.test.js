// Tests de v2/domain/absences.js — el lector único de la tabla `bloqueos`. Lo que aquí se fija
// no es "un filtro": son los criterios de CINCO invariantes que antes vivían escritos a mano en
// cinco sitios (INV-5, INV-2, INV-6, INV-7 y el descuento de disponibilidad de INV-3), más el
// rango del router. Que cada conjunto de motivos sea el que es no es un detalle: es la decisión.
import test from "node:test";
import assert from "node:assert/strict";
import {
  absences, isNearbyRotation,
  BLOQUEA_ASIGNACION, EXIME_DEL_MINIMO, AUSENCIA_SIMULTANEA, DESCUENTA_DISPONIBILIDAD,
} from "../absences.js";

const b = (residenteId, desde, hasta, motivo, extra = {}) => ({ residenteId, desde, hasta, motivo, ...extra });

const BAJA = b("ana", "2026-09-01", "2026-09-30", "BAJA");
const VACA = b("bruno", "2026-09-10", "2026-09-20", "VACACIONES");
const ROTA = b("carla", "2026-08-15", "2026-09-15", "ROTACION", { provincia: "Valencia" });
const TODOS = [BAJA, VACA, ROTA];

test("sin criterios devuelve las activas tal cual, y son las filas originales", () => {
  const r = absences(TODOS);
  assert.equal(r.length, 3);
  assert.equal(r[2].provincia, "Valencia", "no se copian ni se recortan: quien lea sigue viendo provincia");
});

test("una fila cancelada (activo=false) no la ve NADIE, aunque el invocador no la filtrara", () => {
  // Es lo único que este módulo unifica de verdad. Antes dependía de que cada invocador se
  // acordara de filtrar antes de llamar al dominio: el día que uno no lo hiciera, un bloqueo
  // cancelado volvía a bloquear asignaciones y ningún test lo habría notado.
  const cancelada = { ...BAJA, activo: false };
  assert.deepEqual(absences([cancelada]), []);
  assert.deepEqual(absences([cancelada], { fecha: "2026-09-05", motivos: BLOQUEA_ASIGNACION }), []);
});

test("`activo` ausente cuenta como activa: los ctx armados a mano no arrastran la columna", () => {
  assert.equal(absences([BAJA]).length, 1);
  assert.equal(absences([{ ...BAJA, activo: true }]).length, 1);
});

test("por residente y por motivo, combinados con AND", () => {
  assert.deepEqual(absences(TODOS, { residenteId: "ana" }), [BAJA]);
  assert.deepEqual(absences(TODOS, { motivos: DESCUENTA_DISPONIBILIDAD }), [BAJA]);
  assert.deepEqual(absences(TODOS, { residenteId: "bruno", motivos: DESCUENTA_DISPONIBILIDAD }), []);
});

test("por fecha: solo las que CUBREN ese día, extremos incluidos", () => {
  assert.deepEqual(absences(TODOS, { fecha: "2026-09-01" }).map((x) => x.residenteId), ["ana", "carla"]);
  assert.deepEqual(absences(TODOS, { fecha: "2026-09-30" }).map((x) => x.residenteId), ["ana"]);
  assert.deepEqual(absences(TODOS, { fecha: "2026-10-01" }), []);
});

test("por rango: SOLAPA, no contiene — una baja larga aparece al preguntar por un mes de dentro", () => {
  const larga = b("ana", "2026-06-01", "2027-05-31", "BAJA");
  assert.equal(absences([larga], { desde: "2026-09-01", hasta: "2026-09-30" }).length, 1);
  // Y los bordes: un día de solape basta, cero días no.
  assert.equal(absences([larga], { desde: "2027-05-31", hasta: "2027-06-30" }).length, 1);
  assert.equal(absences([larga], { desde: "2027-06-01", hasta: "2027-06-30" }).length, 0);
  assert.equal(absences([larga], { desde: "2026-05-01", hasta: "2026-05-31" }).length, 0);
});

test("los conjuntos de motivos son los que exige cada invariante, y NO son intercambiables", () => {
  // INV-5 (V-8): solo la baja impide asignar.
  assert.deepEqual(BLOQUEA_ASIGNACION, ["BAJA"]);
  // INV-2: la rotación NO exime del mínimo (se sigue haciendo guardia en el hospital de origen).
  assert.deepEqual(EXIME_DEL_MINIMO, ["VACACIONES", "BAJA"]);
  // INV-6: la baja NO computa como ausencia simultánea; nadie la ha concedido ni se reparte.
  assert.deepEqual(AUSENCIA_SIMULTANEA, ["ROTACION", "VACACIONES"]);
  // INV-3, nota [a]: solo la baja descuenta disponibilidad.
  assert.deepEqual(DESCUENTA_DISPONIBILIDAD, ["BAJA"]);
});

test("isNearbyRotation: motivo Y provincia, sin distinguir mayúsculas", () => {
  assert.equal(isNearbyRotation(ROTA), true);
  assert.equal(isNearbyRotation({ ...ROTA, provincia: "ALICANTE" }), true);
  assert.equal(isNearbyRotation({ ...ROTA, provincia: "Barcelona" }), false);
  assert.equal(isNearbyRotation({ ...ROTA, provincia: undefined }), false, "sin provincia no se puede saber");
  assert.equal(isNearbyRotation({ ...VACA, provincia: "Valencia" }), false, "unas vacaciones no son rotación");
});

test("tolera basura: una fila nula o una fecha mal escrita no tumban la validación entera", () => {
  // La tabla vive en un Sheet que alguien puede editar a mano. Se filtra por comparación de
  // cadenas y sin `parseISO` a propósito: una fila rota se descarta, no lanza.
  assert.doesNotThrow(() => absences([null, undefined, BAJA], { fecha: "2026-09-05" }));
  assert.deepEqual(absences([null, BAJA], { fecha: "2026-09-05" }), [BAJA]);
  assert.doesNotThrow(() => absences([{ ...BAJA, desde: "05/09/2026" }], { fecha: "2026-09-05" }));
});

test("sin bloqueos, o con la lista ausente, devuelve []", () => {
  assert.deepEqual(absences(), []);
  assert.deepEqual(absences([], { motivos: BLOQUEA_ASIGNACION }), []);
});

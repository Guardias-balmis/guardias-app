// Tests de client/lib/violations.js — la traducción id→nombre al MOSTRAR una violación.
// Los mensajes de ejemplo son literales de los que produce el dominio hoy (validate.js,
// equity.js, thirdpost.js): si alguno cambia de forma, estos tests son el sitio donde se ve.
import test from "node:test";
import assert from "node:assert/strict";
import { violationText } from "../violations.js";

const RESIDENTES = [
  { id: "7f3a1b9c-0000-4000-8000-000000000001", nombre: "Ana Gómez" },
  { id: "7f3a1b9c-0000-4000-8000-000000000002", nombre: "Bea Server" },
];
const [ANA, BEA] = RESIDENTES.map((r) => r.id);

test("INV-2: el id embebido en el texto se sustituye por el nombre", () => {
  const v = { invariante: "INV-2", severidad: "error", detalle: `${ANA}: 7 guardias computables > máximo 6`, residenteId: ANA };
  assert.equal(violationText(v, RESIDENTES), "Ana Gómez: 7 guardias computables > máximo 6");
});

test("INV-3: una violación que compara DOS residentes traduce los dos", () => {
  const v = {
    invariante: "INV-3", severidad: "aviso", residenteId: ANA,
    detalle: `Totales al cierre del trimestre T2 (2026-09-01→2026-11-30): ${ANA}=4 vs ${BEA}=1 (diferencia > 1)`,
  };
  assert.equal(
    violationText(v, RESIDENTES),
    "Totales al cierre del trimestre T2 (2026-09-01→2026-11-30): Ana Gómez=4 vs Bea Server=1 (diferencia > 1)"
  );
});

test("INV-11 (verano) e INV-6: también traducen una LISTA de ids", () => {
  const v = { invariante: "INV-11", severidad: "aviso", detalle: `Recuento de verano entre R2 del mismo año con diferencia > 1: ${ANA}: 6, ${BEA}: 3 (compensable antes del cierre del año de residencia)` };
  assert.equal(violationText(v, RESIDENTES), "Recuento de verano entre R2 del mismo año con diferencia > 1: Ana Gómez: 6, Bea Server: 3 (compensable antes del cierre del año de residencia)");
});

test("INV-5: si el texto no nombra a nadie, se prefija el residente al que apunta", () => {
  const v = { invariante: "INV-5", severidad: "error", detalle: "Asignación G el 2026-11-05 sobre bloqueo BAJA", fecha: "2026-11-05", residenteId: BEA };
  assert.equal(violationText(v, RESIDENTES), "Bea Server — Asignación G el 2026-11-05 sobre bloqueo BAJA");
});

test("no se prefija dos veces cuando el nombre ya aparece en el texto", () => {
  const v = { invariante: "INV-11", severidad: "error", detalle: `R1 (${ANA}) asignado a guardia el 2026-07-03: en junio-agosto el puesto de Pequeño lo cubren R2`, residenteId: ANA };
  assert.equal(violationText(v, RESIDENTES), "R1 (Ana Gómez) asignado a guardia el 2026-07-03: en junio-agosto el puesto de Pequeño lo cubren R2");
});

test("INV-1: una violación de día, sin residente, se deja intacta", () => {
  const v = { invariante: "INV-1", severidad: "error", detalle: "Día 2026-11-01 sin cubrir con exactamente 1 Mayor y 1 Pequeño (mayores=0, pequeños=0)", fecha: "2026-11-01" };
  assert.equal(violationText(v, RESIDENTES), v.detalle);
});

test("un id desconocido se deja visible en vez de ocultar de quién habla la violación", () => {
  const v = { invariante: "INV-2", severidad: "error", detalle: "id-borrado: 7 guardias computables > máximo 6", residenteId: "id-borrado" };
  assert.equal(violationText(v, RESIDENTES), "id-borrado: 7 guardias computables > máximo 6");
});

test("un id que es prefijo de otro no parte al más largo (se sustituye de más largo a más corto)", () => {
  const residentes = [{ id: "res-ana", nombre: "Ana" }, { id: "res-ana-2", nombre: "Ana Segunda" }];
  const v = { invariante: "INV-3", detalle: "Totales: res-ana-2=6 vs res-ana=3 (diferencia > 1)" };
  assert.equal(violationText(v, residentes), "Totales: Ana Segunda=6 vs Ana=3 (diferencia > 1)");
});

test("tolera entradas incompletas: sin residentes, sin detalle o con residentes sin nombre", () => {
  assert.equal(violationText({ detalle: "algo" }), "algo");
  assert.equal(violationText({ detalle: "algo" }, []), "algo");
  assert.equal(violationText({}, RESIDENTES), "");
  assert.equal(violationText({ detalle: `${ANA}: 7 guardias` }, [{ id: ANA }]), `${ANA}: 7 guardias`);
});

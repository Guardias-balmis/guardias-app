// Tests de client/lib/closes.js — los cierres de equidad de INV-3 tal y como los comprueba el
// cliente antes de validar (trimestral P-8/V-13 y anual). Se verifica sobre todo el CONTRATO
// con el backend: qué rango se pide, que un fallo de red no se traga, y que las asignaciones
// del mes salen de la pantalla y no del rango (duplicarlas ya fue un bug real del generador).
import test from "node:test";
import assert from "node:assert/strict";
import { closeViolations } from "../closes.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });
const A = R("r3a", "2024-05-27", "2028-05-26"); // cierra su año de residencia el 2027-05-26
const B = R("r3b", "2024-05-27", "2028-05-26");

function fakeApi({ asignaciones = [], bloqueos = [], failAsig = false, failBloq = false } = {}) {
  const calls = [];
  return {
    calls,
    listAsignacionesRango: async (desde, hasta) => {
      calls.push({ tipo: "asignaciones", desde, hasta });
      return failAsig ? { ok: false, error: "sin red" } : { ok: true, asignaciones };
    },
    listBloqueosRango: async (desde, hasta) => {
      calls.push({ tipo: "bloqueos", desde, hasta });
      return failBloq ? { ok: false, error: "sin red" } : { ok: true, bloqueos };
    },
  };
}

test("un mes que no cierra trimestre ni año no pide nada al backend", async () => {
  const api = fakeApi();
  const r = await closeViolations({ api, mes: 10, anio: 2026, residentes: [A, B], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: true, violaciones: [] });
  assert.equal(api.calls.length, 0);
});

test("cierre trimestral: pide el rango desde el inicio del trimestre y devuelve el aviso", async () => {
  const api = fakeApi({
    asignaciones: [g("r3a", "2026-09-02"), g("r3a", "2026-09-09"), g("r3a", "2026-09-16"), g("r3b", "2026-10-07")],
  });
  const r = await closeViolations({
    api, mes: 11, anio: 2026, residentes: [A, B],
    asignacionesDelMes: [g("r3a", "2026-11-04"), g("r3a", "2026-11-11")],
  });
  assert.deepEqual(api.calls.map((c) => [c.desde, c.hasta]), [["2026-09-01", "2026-11-30"], ["2026-09-01", "2026-11-30"]]);
  assert.equal(r.violaciones.length, 1);
  assert.equal(r.violaciones[0].severidad, "aviso");
  assert.match(r.violaciones[0].detalle, /trimestre T2/);
});

test("las asignaciones del mes vienen de la pantalla, no del rango: no se cuentan dos veces", async () => {
  const delMes = [g("r3a", "2026-11-04"), g("r3a", "2026-11-11")];
  const api = fakeApi({
    // El backend devuelve TAMBIÉN las filas del mes (ya guardadas): no deben sumarse otra vez.
    asignaciones: [g("r3a", "2026-09-02"), g("r3a", "2026-09-09"), g("r3a", "2026-09-16"), ...delMes, g("r3b", "2026-10-07")],
  });
  const r = await closeViolations({ api, mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: delMes });
  assert.equal(r.violaciones.length, 1);
  assert.match(r.violaciones[0].detalle, /r3a=5 vs r3b=1/); // 5, no 7
});

test("cierre anual en un mes que no cierra trimestre: pide desde el aniversario", async () => {
  const C = R("r3c", "2024-10-15", "2028-10-14"); // cierra el 2027-10-14; octubre no cierra trimestre
  const D = R("r3d", "2024-10-15", "2028-10-14");
  const api = fakeApi({
    asignaciones: [
      ...["2026-11-03", "2026-12-01", "2027-01-05", "2027-02-02", "2027-03-02", "2027-04-06"].map((f) => g("r3c", f)),
      ...["2026-11-04"].map((f) => g("r3d", f)),
    ],
  });
  const r = await closeViolations({ api, mes: 10, anio: 2027, residentes: [C, D], asignacionesDelMes: [] });
  assert.deepEqual(api.calls[0], { tipo: "asignaciones", desde: "2026-10-15", hasta: "2027-10-31" });
  const errores = r.violaciones.filter((v) => v.severidad === "error");
  assert.equal(errores.length, 1); // 6 vs 1 en totales
  assert.match(errores[0].detalle, /año de residencia/);
});

test("mayo cierra los dos a la vez (T4 y el año de residencia) con un solo par de peticiones", async () => {
  const api = fakeApi({
    asignaciones: [...["2026-06-02", "2026-06-09", "2026-07-07"].map((f) => g("r3a", f)), g("r3b", "2026-06-03")],
  });
  const r = await closeViolations({ api, mes: 5, anio: 2027, residentes: [A, B], asignacionesDelMes: [] });
  // El rango arranca en el aniversario (2026-05-27), anterior al inicio de T4 (2027-03-01).
  assert.deepEqual(api.calls.map((c) => c.desde), ["2026-05-27", "2026-05-27"]);
  assert.equal(api.calls.length, 2);
  assert.equal(r.violaciones.filter((v) => v.severidad === "error").length, 1); // anual: 3 vs 1
  assert.equal(r.violaciones.filter((v) => v.severidad === "aviso").length, 0); // T4: nadie tiene guardias
});

test("un fallo cargando asignaciones NO se da por comprobado", async () => {
  const api = fakeApi({ failAsig: true });
  const r = await closeViolations({ api, mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: false, error: "sin red" });
});

test("un fallo cargando bloqueos NO se da por comprobado", async () => {
  const api = fakeApi({ failBloq: true });
  const r = await closeViolations({ api, mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: false, error: "sin red" });
});

test("los bloqueos del rango llegan al descuento proporcional de la baja (nota [a])", async () => {
  const asignaciones = [
    ...["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07"].map((f) => g("r3a", f)),
    ...["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"].map((f) => g("r3b", f)),
  ];
  const conBaja = await closeViolations({
    api: fakeApi({ asignaciones, bloqueos: [{ residenteId: "r3b", desde: "2026-10-01", hasta: "2026-10-31", motivo: "BAJA", activo: true }] }),
    mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: [],
  });
  const sinBaja = await closeViolations({
    api: fakeApi({ asignaciones }), mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: [],
  });
  assert.equal(conBaja.violaciones.length, 0); // 31 de 91 días de baja → 4/0.66 ≈ 6.07 vs 6
  assert.equal(sinBaja.violaciones.length, 1); // sin la baja, 6 vs 4 → avisa
});

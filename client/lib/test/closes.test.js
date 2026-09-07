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

// Festivos reales del tramo que usan los tests del cierre anual. El 8-dic-2026 es martes y el
// 6-dic domingo, así que el lunes 7 es puente; el 12-oct-2027 es martes, así que el lunes 11
// también. Uno cae en un año natural y el otro en el siguiente: es el caso que obliga a pedir
// dos años de festivos (fase 3 de V-17).
const FESTIVOS = ["2026-12-06", "2026-12-08", "2026-12-25", "2027-01-01", "2027-01-06", "2027-10-12"];

function fakeApi({ asignaciones = [], bloqueos = [], festivos = FESTIVOS, failAsig = false, failBloq = false, failFest = false } = {}) {
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
    listFestivosRango: async (desde, hasta) => {
      calls.push({ tipo: "festivos", desde, hasta });
      return failFest ? { ok: false, error: "sin red" } : { ok: true, festivos };
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
  // Dos días más allá del mes: el lookahead del doblete (C-1) para quien cierra ahora.
  assert.deepEqual(api.calls[0], { tipo: "asignaciones", desde: "2026-10-15", hasta: "2027-11-02" });
  // Los festivos se piden por AÑOS NATURALES completos (más un día de margen): además de los
  // vecinos del borde (§3.4), el validador necesita ver el año entero para poder distinguir
  // «ese año no está cargado» de «ese tramo del año no tiene festivos».
  assert.deepEqual(api.calls.find((c) => c.tipo === "festivos"), { tipo: "festivos", desde: "2025-12-31", hasta: "2028-01-01" });
  // Decisión V-14: el cierre anual avisa, no bloquea.
  assert.equal(r.violaciones.filter((v) => v.severidad === "error").length, 0);
  const avisos = r.violaciones.filter((v) => v.severidad === "aviso");
  assert.equal(avisos.length, 1); // 6 vs 1 en totales
  assert.match(avisos[0].detalle, /año de residencia/);
});

test("mayo cierra los dos a la vez (T4 y el año de residencia) con un solo par de peticiones", async () => {
  const api = fakeApi({
    asignaciones: [...["2026-06-02", "2026-06-09", "2026-07-07"].map((f) => g("r3a", f)), g("r3b", "2026-06-03")],
  });
  const r = await closeViolations({ api, mes: 5, anio: 2027, residentes: [A, B], asignacionesDelMes: [] });
  // El rango arranca en el aniversario (2026-05-27), anterior al inicio de T4 (2027-03-01); el
  // de festivos abarca los dos años naturales que cruza la ventana.
  assert.deepEqual(api.calls.map((c) => c.desde), ["2026-05-27", "2026-05-27", "2025-12-31"]);
  assert.equal(api.calls.length, 3);
  assert.equal(r.violaciones.filter((v) => v.severidad === "error").length, 0); // la equidad nunca bloquea (V-14)
  const avisos = r.violaciones.filter((v) => v.severidad === "aviso");
  assert.equal(avisos.length, 1); // solo el anual (3 vs 1); en T4 nadie tiene guardias
  assert.match(avisos[0].detalle, /año de residencia/);
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

test("un fallo cargando festivos NO se da por comprobado (el eje de puentes no se supone cuadrado)", async () => {
  const api = fakeApi({ failFest: true });
  const r = await closeViolations({ api, mes: 5, anio: 2027, residentes: [A, B], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: false, error: "sin red" });
});

test("el trimestre NO pide festivos: solo mide `total` (V-13a)", async () => {
  const api = fakeApi();
  await closeViolations({ api, mes: 11, anio: 2026, residentes: [A, B], asignacionesDelMes: [] });
  assert.equal(api.calls.filter((c) => c.tipo === "festivos").length, 0);
});

test("puentes libres: el puente de DICIEMBRE cuenta para el cierre de MAYO (la ventana cruza el año natural)", async () => {
  // La ventana de A y B es 2026-05-27→2027-05-26 y tiene dos puentes: el 7-dic-2026, en el año
  // natural ANTERIOR y que llega por el histórico, y el 3-may-2027, dentro del mes que se valida
  // y que llega por `puentesDelMes`. r3a hace guardia en los dos, r3b en ninguno → 0 vs 2.
  // El aviso solo existe si el rango de festivos cruza el año: si el eje volviera a compararse
  // sobre ceros, este test se pondría en rojo (es lo que le faltaba a su primera versión).
  const api = fakeApi({
    festivos: [...FESTIVOS, "2027-05-04"], // martes: convierte el lunes 3 en puente
    asignaciones: [g("r3a", "2026-12-07"), g("r3b", "2026-12-14")],
  });
  const r = await closeViolations({
    api, mes: 5, anio: 2027, residentes: [A, B], asignacionesDelMes: [g("r3a", "2027-05-03")],
  });
  assert.equal(r.ok, true);
  const puentes = r.violaciones.filter((v) => /puentes libres/i.test(v.detalle));
  assert.equal(puentes.length, 1);
  assert.match(puentes[0].detalle, /r3b=2.*r3a=0/);
});

test("puentes libres: diferencia 2 avisa, y el aviso nombra el eje", async () => {
  // C y D cierran en octubre-2027: su ventana contiene los DOS puentes (7-dic-2026 y 11-oct-2027).
  const C = R("r3c", "2024-10-15", "2028-10-14");
  const D = R("r3d", "2024-10-15", "2028-10-14");
  const api = fakeApi({ asignaciones: [g("r3c", "2026-12-07")] }); // el otro puente va en el mes validado
  const r = await closeViolations({
    api, mes: 10, anio: 2027, residentes: [C, D],
    asignacionesDelMes: [g("r3c", "2027-10-11")], // C pierde los dos puentes; D, ninguno
  });
  const puentes = r.violaciones.filter((v) => /puentes libres/i.test(v.detalle));
  assert.equal(puentes.length, 1, "0 vs 2 puentes libres tiene que avisar");
  assert.equal(puentes[0].severidad, "aviso"); // la equidad nunca bloquea (V-14)
  assert.match(puentes[0].detalle, /r3d=2.*r3c=0/);
});

test("sin festivos cargados el cierre anual lo DICE, en vez de cuadrar el eje con ceros", async () => {
  const api = fakeApi({ festivos: [] });
  const r = await closeViolations({ api, mes: 5, anio: 2027, residentes: [A, B], asignacionesDelMes: [] });
  const sinCalendario = r.violaciones.filter((v) => /no hay ningún festivo cargado/i.test(v.detalle));
  assert.equal(sinCalendario.length, 1);
  assert.equal(sinCalendario[0].severidad, "aviso");
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

// ── Contrato C-1 en el cierre anual: el viernes 30/31 de quien cierra ahora empareja su domingo
// en el mes siguiente, que no está en pantalla. Se pide al store y entra solo como lookahead.
test("cierre anual: los dos primeros días del mes siguiente se piden y cierran el doblete de quien cierra ahora", async () => {
  // Año de residencia 2026-05-01→2027-04-30 (viernes) para los dos; ambos cierran en abril.
  const X = R("x", "2024-05-01", "2028-04-30");
  const Y = R("y", "2024-05-01", "2028-04-30");
  const delMes = [g("x", "2027-04-16"), g("x", "2027-04-18"), g("x", "2027-04-30")]; // V, D, V
  const conDomingo = fakeApi({ asignaciones: [g("x", "2027-05-02")] }); // el domingo del viernes 30
  const r = await closeViolations({ api: conDomingo, mes: 4, anio: 2027, residentes: [X, Y], asignacionesDelMes: delMes });
  assert.deepEqual(conDomingo.calls[0], { tipo: "asignaciones", desde: "2026-05-01", hasta: "2027-05-02" });
  const dobletes = r.violaciones.filter((v) => /Dobletes/.test(v.detalle));
  assert.equal(dobletes.length, 1, "2 dobletes de x frente a 0 de y");
  assert.match(dobletes[0].detalle, /x=2 vs y=0/);

  const sinDomingo = fakeApi({ asignaciones: [] });
  const r2 = await closeViolations({ api: sinDomingo, mes: 4, anio: 2027, residentes: [X, Y], asignacionesDelMes: delMes });
  assert.equal(r2.violaciones.filter((v) => /Dobletes/.test(v.detalle)).length, 0, "sin el domingo solo hay un doblete: diferencia 1");
});

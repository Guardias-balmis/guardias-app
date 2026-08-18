// Tests de client/lib/thirdpost.js — INV-8 tal y como lo comprueba el cliente antes de validar.
// Se verifica sobre todo el CONTRATO con el backend: qué se pide y cuándo no se pide nada, que
// un fallo de red no se traga, y que los 3P del mes salen de la pantalla y no del rango
// (duplicarlos rompería el ciclo de 7 días, y esa duplicación ya fue un bug real del generador).
import test from "node:test";
import assert from "node:assert/strict";
import { thirdPostViolations } from "../thirdpost.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const p3 = (residenteId, fecha) => ({ residenteId, fecha, codigo: "3P" });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });

const ANA = R("r3-ana", "2024-05-25", "2028-05-24");
const BRUNO = R("r2-bruno", "2025-05-25", "2029-05-24");
const EVA = R("r1-eva", "2026-05-25", "2030-05-24");

function fakeApi({ voluntarios = [], periodos = null, asignaciones = [], failVol = false, failAsig = false } = {}) {
  const calls = [];
  return {
    calls,
    estadoVoluntariado3P: async () => {
      calls.push({ tipo: "voluntarios" });
      // Por defecto, cada voluntario ACTIVO es también su único periodo (sin `hasta`): así los
      // tests que no le prestan atención a esto siguen viendo el mismo veredicto de antes.
      const periodosEfectivos = periodos !== null ? periodos : voluntarios.map((v) => ({ residenteId: v.residenteId, desde: v.desde }));
      return failVol
        ? { ok: false, error: "sin red" }
        : { ok: true, voluntarios, periodos: periodosEfectivos, permanenciaMeses: 4, mio: null };
    },
    listAsignacionesRango: async (desde, hasta) => {
      calls.push({ tipo: "asignaciones", desde, hasta });
      return failAsig ? { ok: false, error: "sin red" } : { ok: true, asignaciones };
    },
  };
}

test("sin voluntarios no se pide histórico: 8a y 8d se resuelven con lo que hay en pantalla", async () => {
  const api = fakeApi();
  const r = await thirdPostViolations({
    api, mes: 10, anio: 2026, residentes: [ANA],
    asignacionesDelMes: [p3("r3-ana", "2026-10-06")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(api.calls.map((c) => c.tipo), ["voluntarios"]); // ni una petición de más
  assert.equal(r.violaciones.length, 1); // INV-8a: nadie consta voluntario
  assert.match(r.violaciones[0].detalle, /no consta en la lista de voluntarios/);
  assert.equal(r.violaciones[0].severidad, "aviso"); // V-18: no bloquea
});

test("el rango del histórico arranca en el alta del voluntario, no en el mes", async () => {
  const api = fakeApi({ voluntarios: [{ residenteId: "r3-ana", desde: "2026-06-15" }] });
  await thirdPostViolations({ api, mes: 10, anio: 2026, residentes: [ANA], asignacionesDelMes: [] });
  assert.deepEqual(api.calls[1], { tipo: "asignaciones", desde: "2026-06-15", hasta: "2026-10-31" });
});

test("el ciclo de INV-8b ve el histórico y avisa de la repetición del mes", async () => {
  const api = fakeApi({
    voluntarios: [{ residenteId: "r2-bruno", desde: "2026-09-01" }],
    asignaciones: [p3("r2-bruno", "2026-09-04"), p3("r2-bruno", "2026-09-15")], // V, M
  });
  const r = await thirdPostViolations({
    api, mes: 10, anio: 2026, residentes: [BRUNO],
    asignacionesDelMes: [p3("r2-bruno", "2026-10-02")], // otro viernes
  });
  assert.equal(r.violaciones.length, 1);
  assert.match(r.violaciones[0].detalle, /repite V .* 2026-10-02/);
});

test("los 3P del mes vienen de la pantalla, no del rango: no se cuentan dos veces", async () => {
  const delMes = [p3("r2-bruno", "2026-10-07")];
  const api = fakeApi({
    voluntarios: [{ residenteId: "r2-bruno", desde: "2026-09-01" }],
    // El backend devuelve TAMBIÉN la fila del mes (ya guardada): si se sumara al histórico, el
    // ciclo vería dos miércoles y avisaría de una repetición inexistente.
    asignaciones: [...delMes],
  });
  const r = await thirdPostViolations({ api, mes: 10, anio: 2026, residentes: [BRUNO], asignacionesDelMes: delMes });
  assert.deepEqual(r.violaciones, []);
});

test("un fallo cargando la lista de voluntarios NO se da por comprobado", async () => {
  const api = fakeApi({ failVol: true });
  const r = await thirdPostViolations({ api, mes: 10, anio: 2026, residentes: [ANA], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: false, error: "sin red" });
});

test("un fallo cargando el histórico NO se da por comprobado", async () => {
  const api = fakeApi({ voluntarios: [{ residenteId: "r3-ana", desde: "2026-06-15" }], failAsig: true });
  const r = await thirdPostViolations({ api, mes: 10, anio: 2026, residentes: [ANA], asignacionesDelMes: [] });
  assert.deepEqual(r, { ok: false, error: "sin red" });
});

test("INV-8d (mochila) llega hasta la pantalla, y como aviso", async () => {
  const api = fakeApi({ voluntarios: [{ residenteId: "r2-bruno", desde: "2026-09-01" }] });
  const r = await thirdPostViolations({
    api, mes: 9, anio: 2026, residentes: [EVA, BRUNO],
    // Eva (R1) de guardia el día 11 sin 3P, y el único 3P cae el 12, que no tiene R1.
    asignacionesDelMes: [g("r1-eva", "2026-09-11"), p3("r2-bruno", "2026-09-12")],
  });
  assert.equal(r.violaciones.length, 1);
  assert.equal(r.violaciones[0].severidad, "aviso");
  assert.match(r.violaciones[0].detalle, /deben cubrir primero los días con R1/);
});

test("un mes ANTERIOR al alta más antigua no pide histórico (y no manda un rango invertido)", async () => {
  // Estado normal cuando la tabla acaba de nacer: alguien se apunta hoy y el Responsable abre un
  // mes pasado para retocarlo. Pedir [alta, finDeMes] mandaría desde > hasta, el backend lo
  // rechaza y la pantalla se quedaría sin comprobar INV-8 mientras el servidor sí lo comprueba.
  const api = fakeApi({ voluntarios: [{ residenteId: "r3-ana", desde: "2026-11-20" }] });
  const r = await thirdPostViolations({
    api, mes: 7, anio: 2026, residentes: [ANA],
    asignacionesDelMes: [p3("r2-bruno", "2026-07-08")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(api.calls.map((c) => c.tipo), ["voluntarios"], "ni una petición con rango invertido");
  assert.equal(r.violaciones.length, 1); // INV-8a sigue comprobándose
  assert.match(r.violaciones[0].detalle, /no consta en la lista de voluntarios/);
});

test("INV-8a por fecha (V-40): un 3P de julio de quien se retiró en diciembre NO avisa, aunque hoy no conste activo", async () => {
  const api = fakeApi({
    voluntarios: [], // ya no consta activo
    periodos: [{ residenteId: "r2-bruno", desde: "2026-05-01", hasta: "2026-12-01" }],
  });
  const r = await thirdPostViolations({
    api, mes: 7, anio: 2026, residentes: [BRUNO],
    asignacionesDelMes: [p3("r2-bruno", "2026-07-03")],
  });
  assert.deepEqual(r.violaciones, []);
});

test("INV-8a por fecha (V-40): un 3P de junio de quien recién se apuntó en septiembre SÍ avisa, aunque hoy conste activo", async () => {
  const api = fakeApi({
    voluntarios: [{ residenteId: "r2-bruno", desde: "2026-09-01" }],
    periodos: [{ residenteId: "r2-bruno", desde: "2026-09-01" }],
  });
  const r = await thirdPostViolations({
    api, mes: 6, anio: 2026, residentes: [BRUNO],
    asignacionesDelMes: [p3("r2-bruno", "2026-06-05")],
  });
  assert.equal(r.violaciones.length, 1);
  assert.match(r.violaciones[0].detalle, /no consta en la lista de voluntarios/);
});

test("el ciclo de INV-8b arranca en el alta: un 3P anterior no cuenta (mismo veredicto que el servidor)", async () => {
  const api = fakeApi({
    voluntarios: [{ residenteId: "r2-bruno", desde: "2027-06-01" }],
    asignaciones: [p3("r2-bruno", "2027-01-04")], // lunes de antes de apuntarse
  });
  const r = await thirdPostViolations({
    api, mes: 7, anio: 2027, residentes: [BRUNO],
    asignacionesDelMes: [p3("r2-bruno", "2027-07-05")], // otro lunes
  });
  assert.deepEqual(r.violaciones, []);
});

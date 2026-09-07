// Los periodos formativos se derivan en UN solo sitio: `periodsOfResident` (decisión V-24).
//
// Estos tests no prueban un módulo, prueban la COHERENCIA entre módulos, que es donde estaba el
// fallo: cada consumidor tenía su propia copia del `residente.fechaFin || addYears(+4)`, y tres de
// ellas —`projection`, `accumulate` y el `closingWindowThisMonth` de `equity`— no miraban
// `residente.periodos`. Medido antes de unificar: para el MISMO residente y el MISMO día,
// `projection.js` decía R2 mientras `validate.js` decía R1. Con la tabla `periodos` rellena eso
// habría dado dos niveles distintos dentro de una sola llamada a `marcarValidado`.
//
// Ninguno de los tests existentes lo cubría: antes de este fichero, `periodos:` solo aparecía en
// `residents.test.js`, así que los consumidores nunca se probaban con periodos editados y la
// unificación no la sostenía nada.
import test from "node:test";
import assert from "node:assert/strict";
import { periodsOfResident, levelOn, periodOn } from "../residents.js";
import { validateMonth } from "../validate.js";
import { buildMonthSheetRows } from "../projection.js";
import { accumulatedTally } from "../accumulate.js";
import { yearCloseHistoryStart, validateQuarterClose } from "../equity.js";
import { validateThirdPost } from "../thirdpost.js";
import { eligibleCandidates } from "../responsible.js";

// El caso real de la nota [a]: una baja larga alarga el R1 un año entero, así que a mitad de 2027
// esta persona SIGUE siendo R1 aunque su aniversario nominal ya haya pasado.
const PERIODOS_R1_ALARGADO = [
  { year: 1, start: "2026-05-25", end: "2028-05-24" }, // el doble de largo
  { year: 2, start: "2028-05-25", end: "2029-05-24" },
  { year: 3, start: "2029-05-25", end: "2030-05-24" },
  { year: 4, start: "2030-05-25", end: "2031-05-24" },
];
const ALARGADO = {
  id: "x", nombre: "Xisco", fechaInicio: "2026-05-25", fechaFin: "2031-05-24",
  periodos: PERIODOS_R1_ALARGADO,
};
// Mismo residente SIN periodos editados: derivando de las fechas sería R2 el mismo día. Es el
// contraste que hace visible la divergencia.
const SIN_EDITAR = { ...ALARGADO, periodos: undefined };
const DIA = "2027-07-15";

test("el nivel derivado con periodos editados difiere del nominal — si no, estos tests no probarían nada", () => {
  assert.equal(levelOn(periodsOfResident(ALARGADO), DIA), "R1");
  assert.equal(levelOn(periodsOfResident(SIN_EDITAR), DIA), "R2");
});

test("projection.js usa los periodos editados en la columna Nivel", () => {
  // Daba R2 mientras el validador daba R1: la pestaña publicada contradecía al validador.
  const fila = (r) => buildMonthSheetRows({ anio: 2027, mes: 7, residentes: [r], asignaciones: [] })
    .rows.find((f) => f[0] === "Xisco");
  assert.equal(fila(ALARGADO)[1], "R1");
  assert.equal(fila(SIN_EDITAR)[1], "R2");
});

test("validate.js usa los periodos editados: INV-11 ve al R1 alargado en verano", () => {
  // Es la consecuencia grave de la divergencia: un R1 que se deriva como R2 pasa a ser asignable
  // en junio-agosto sin que INV-11 lo vea (INV-11 es uno de los tres que BLOQUEAN).
  const inv11 = (r) => validateMonth({
    mes: 7, anio: 2027, residentes: [r], asignaciones: [{ residenteId: "x", fecha: DIA, codigo: "G" }],
  }).filter((v) => v.invariante === "INV-11");
  assert.equal(inv11(ALARGADO).length, 1);
  assert.equal(inv11(SIN_EDITAR).length, 0, "sin periodos editados es R2 y INV-11 no aplica");
});

test("accumulate.js cuenta el año de residencia editado, no el nominal", () => {
  // Dos guardias separadas por más de un año: con los periodos editados son del MISMO año de
  // residencia (el R1 alargado) y suman 2; derivando del aniversario serían de dos años distintos.
  const asg = [
    { residenteId: "x", fecha: "2026-06-10", codigo: "G" },
    { residenteId: "x", fecha: "2027-07-15", codigo: "G" },
  ];
  assert.equal(accumulatedTally([ALARGADO], asg, "2027-07-31").get("x").total, 2);
  assert.equal(accumulatedTally([SIN_EDITAR], asg, "2027-07-31").get("x").total, 1, "el nominal solo ve la del año en curso");
  assert.deepEqual(periodOn(periodsOfResident(ALARGADO), "2027-08-01"), PERIODOS_R1_ALARGADO[0]);
});

test("equity.js cierra el año cuando acaba el periodo EDITADO, no en el aniversario nominal", () => {
  // El R1 alargado cierra su año 1 en mayo-2028, no en mayo-2027.
  assert.equal(yearCloseHistoryStart([ALARGADO], 5, 2027), null);
  assert.equal(yearCloseHistoryStart([ALARGADO], 5, 2028), "2026-05-25");
  // Y el nominal cierra en mayo-2027, que es justo lo que dejaría de cuadrar si no se unificara.
  assert.equal(yearCloseHistoryStart([SIN_EDITAR], 5, 2027), "2026-05-25");
});

test("equity.js: el cierre trimestral acota la presencia por los periodos, no por fechaInicio+4", () => {
  // `validateQuarterClose` deja fuera a quien no llega a media disponibilidad del trimestre. Quien
  // empieza sus periodos DESPUÉS del trimestre no estaba presente y no debe compararse.
  const tarde = {
    id: "t", nombre: "Tere", fechaInicio: "2026-05-25", fechaFin: "2031-05-24",
    periodos: [
      { year: 1, start: "2027-06-01", end: "2028-05-31" }, // incorporación real un año más tarde
      { year: 2, start: "2028-06-01", end: "2029-05-31" },
      { year: 3, start: "2029-06-01", end: "2030-05-31" },
      { year: 4, start: "2030-06-01", end: "2031-05-31" },
    ],
  };
  // Misma cohorte que Tere (INV-3 compara dentro de la promoción) y con 3 guardias frente a sus 0:
  // así la diferencia es 3 y el veredicto DEPENDE de si Tere entra en la comparación. Con la
  // diferencia a 1 el test pasaba en los dos casos y no probaba nada — lo destapó mutar el código.
  const otro = { id: "o", nombre: "Olga", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" };
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [tarde, otro],
    asignaciones: ["2026-09-02", "2026-10-07", "2026-11-04"].map((fecha) => ({ residenteId: "o", fecha, codigo: "G" })),
  });
  // Según sus periodos, en T2 (sep-nov 2026) Tere aún no se había incorporado: no hay con quién
  // comparar a Olga, así que el trimestre no puede cerrar con un aviso de equidad.
  assert.deepEqual(v, [], `Tere no estaba presente en T2, no debe compararse: ${JSON.stringify(v)}`);

  // Y el contraste: si Tere no tuviera periodos editados, sí estaría presente y la dif de 3 avisaría.
  const sinEditar = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [{ ...tarde, periodos: undefined }, otro],
    asignaciones: ["2026-09-02", "2026-10-07", "2026-11-04"].map((fecha) => ({ residenteId: "o", fecha, codigo: "G" })),
  });
  assert.equal(sinEditar.length, 1);
  assert.match(sinEditar[0].detalle, /diferencia > 1/);
});

test("thirdpost.js y responsible.js ya respetaban los periodos, y siguen haciéndolo", () => {
  // Estos dos NO eran el problema (su copia local sí miraba `residente.periodos`), pero pasaron a
  // `periodsOfResident` con los demás: el test fija que la unificación no los ha roto.
  // INV-8d: prioridad de los días con R1 de mochila — el R1 alargado sigue siendo R1 en jul-2027.
  const tp = validateThirdPost({
    mes: 7, anio: 2027, residentes: [ALARGADO],
    voluntarios3P: [], historial3P: {},
    asignaciones: [{ residenteId: "x", fecha: DIA, codigo: "G" }],
  });
  assert.ok(Array.isArray(tp), "validateThirdPost sigue devolviendo violaciones sin lanzar");

  // INV-14: elegible al mandato = R3 el 1 de enero. El año alargado desplaza la elegibilidad un
  // año entero: el alargado es R3 en enero-2030 y el nominal ya lo era en enero-2029.
  assert.deepEqual(eligibleCandidates([ALARGADO], "2029-01-01"), [], "en enero-2029 el alargado aún es R2");
  assert.deepEqual(eligibleCandidates([ALARGADO], "2030-01-01"), ["x"]);
  assert.deepEqual(eligibleCandidates([SIN_EDITAR], "2029-01-01"), ["x"], "el nominal es R3 un año antes");
  assert.deepEqual(eligibleCandidates([SIN_EDITAR], "2030-01-01"), [], "y en 2030 ya es R4");
});

test("con fechaFin nominal, unificar NO cambió nada — es lo que hace seguro el cambio", () => {
  // Todos los residentes de hoy tienen fechaFin en el aniversario-1, y ahí las dos derivaciones
  // coinciden mes a mes. Medido al unificar antes de tocar `closingWindowThisMonth`.
  const nominal = { id: "n", nombre: "Nora", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
  for (const anio of [2025, 2026, 2027, 2028]) {
    assert.equal(yearCloseHistoryStart([nominal], 5, anio), `${anio - 1}-05-27`);
  }
  // Y el R4 que deja la residencia antes cierra en SU mes, no dos meses después de irse.
  const antes = { id: "a", nombre: "Aitor", fechaInicio: "2024-05-27", fechaFin: "2028-03-15" };
  assert.equal(yearCloseHistoryStart([antes], 5, 2028), null);
  assert.equal(yearCloseHistoryStart([antes], 3, 2028), "2027-05-27");
});

// ── 2026-09-04: INV-8c cierra el año el MISMO mes que INV-3 (definición única en residents.js) ──
import { closingPeriodOn } from "../residents.js";
import { thirdPostHistoryStart as tphs2, validateThirdPost as vtp2 } from "../thirdpost.js";
import { yearCloseHistoryStart as ychs3 } from "../equity.js";

test("con la promoción retrasada por periodos editados, el tercer puesto y la equidad cierran el año el mismo mes", () => {
  const b = {
    id: "b", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2025-05-26" },
      { year: 2, start: "2025-05-27", end: "2026-06-30" }, // R2 alargado por una baja (nota [a])
      { year: 3, start: "2026-07-01", end: "2027-05-26" },
      { year: 4, start: "2027-05-27", end: "2028-05-26" },
    ],
  };
  const vol = [{ residenteId: "b", desde: "2026-04-01" }];
  assert.equal(closingPeriodOn(b, 5, 2026), null, "en mayo no cierra nada");
  assert.equal(tphs2(vol, [b], 5, 2026), "2026-04-01", "en mayo solo pide desde su alta como voluntario, no una ventana de cierre");
  assert.deepEqual(closingPeriodOn(b, 6, 2026), { start: "2025-05-27", end: "2026-06-30" });
  assert.equal(tphs2(vol, [b], 6, 2026), "2025-05-27");
  assert.equal(ychs3([b], 6, 2026), "2025-05-27", "la misma ventana que el cierre anual de INV-3");
});

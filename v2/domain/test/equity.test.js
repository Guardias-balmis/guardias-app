// Tests de v2/domain/equity.js — INV-3 (equidad al cierre del año de residencia y del
// trimestre) + INV-4. Ninguna de las dos bloquea nunca: son avisos (decisión V-14).
// La ventana es el año de residencia INDIVIDUAL (aniversario), no el académico. Solo se
// evalúa en el mes que contiene el cierre. Entrada tipo "Resumen del Excel": acumulados
// hasta el mes anterior + asignaciones del mes (tally excluye 3P y cedidas/compradas → INV-4).
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateResidencyYearClose, validateQuarterClose, quarterCloseWindow,
  yearCloseHistoryStart, yearCloseFestivosRange, buildYearCloseContext,
} from "../equity.js";

// Festivos reales del tramo 2026-2027. El 8-dic-2026 es martes y el 6-dic domingo → el lunes 7
// es puente (§3.4). Cae en el año natural anterior al del cierre de mayo-2027: es justo el caso
// que obliga a que la lista abarque DOS años (fase 3 de V-17).
const FESTIVOS = ["2026-12-06", "2026-12-08", "2026-12-25", "2027-01-01", "2027-01-06"];

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const acc = (total, findes = 0, festivos = 0, puentesLibres = 0, dobletes = 0, prefestivos = 0) => ({ total, findes, festivos, puentesLibres, dobletes, prefestivos });
const g = (residenteId, fecha, codigo = "G", extra = {}) => ({ residenteId, fecha, codigo, ...extra });

const A = R("r3a", "2024-05-27", "2028-05-26"); // cierre R3 el 2027-05-26
const B = R("r3b", "2024-05-27", "2028-05-26");
const R2A = R("r2a", "2025-05-26", "2029-05-25"); // cierre R2 el 2027-05-25
const R2B = R("r2b", "2025-05-26", "2029-05-25");
// Desde la decisión V-14 las dos vertientes de INV-3 (cierre anual y trimestral) son AVISO:
// filtrar por severidad aquí ocultaría justo lo que hay que comprobar, así que se filtra por
// invariante y la severidad se asserta explícitamente en el test que la fija.
const inv3 = (v) => v.filter((x) => x.invariante === "INV-3");

test("INV-3: mes intermedio desigual no viola (no es mes de cierre)", () => {
  const v = validateResidencyYearClose({
    mes: 10, anio: 2026, residentes: [A, B],
    acumulados: { r3a: acc(18), r3b: acc(18) },
    asignaciones: ["2026-10-02", "2026-10-06", "2026-10-10", "2026-10-15", "2026-10-20", "2026-10-24"].map((f) => g("r3a", f))
      .concat(["2026-10-04", "2026-10-08", "2026-10-17", "2026-10-28"].map((f) => g("r3b", f))),
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3: al cierre, diferencia 2 en totales es violación", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(54), r3b: acc(54) },
    asignaciones: ["2027-05-04", "2027-05-12", "2027-05-20"].map((f) => g("r3a", f)).concat([g("r3b", "2027-05-06")]),
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2027-05-26");
  assert.match(e[0].detalle, /57|55|total/i);
});

test("INV-3: el cierre anual AVISA, nunca bloquea (decisión V-14)", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(54), r3b: acc(48) }, // diferencia 6, lo más lejos posible de cumplir
    asignaciones: [],
  });
  assert.ok(v.length > 0, "un desequilibrio de 6 guardias tiene que reportarse");
  assert.deepEqual([...new Set(v.map((x) => x.severidad))], ["aviso"]);
});

test("INV-3: guardias posteriores al aniversario no cuentan", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(55), r3b: acc(55) },
    asignaciones: [g("r3a", "2027-05-05"), g("r3a", "2027-05-28"), g("r3a", "2027-05-30"), g("r3b", "2027-05-11")],
  });
  assert.equal(inv3(v).length, 0); // 56 vs 56 dentro de la ventana [.., 2027-05-26]
});

test("INV-3: guardia en el día exacto de cierre sí cuenta", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(55), r3b: acc(54) },
    asignaciones: [g("r3a", "2027-05-19"), g("r3a", "2027-05-26"), g("r3b", "2027-05-24")],
  });
  assert.equal(inv3(v).length, 1); // 57 vs 55
});

test("INV-3: no se compara entre años formativos distintos", () => {
  const MARTA = R("r4a", "2023-05-31", "2027-05-30"); // única R4, cierra 2027-05-30
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [MARTA, A, B],
    acumulados: { r4a: acc(48), r3a: acc(57), r3b: acc(57) },
    asignaciones: [],
  });
  assert.equal(inv3(v).length, 0); // Marta sin pares; R3 empatados
});

test("INV-3: totales iguales pero fines de semana con diferencia 2", () => {
  // r2a suma findes en mayo (sáb 08, dom 16); r2b no
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(51, 12, 4, 3, 2), r2b: acc(51, 12, 4, 3, 2) },
    asignaciones: [g("r2a", "2027-05-03"), g("r2a", "2027-05-08"), g("r2a", "2027-05-16"),
      g("r2b", "2027-05-04"), g("r2b", "2027-05-13"), g("r2b", "2027-05-17")],
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /semana|finde/i);
});

test("INV-3: doblete real vs falso doblete de semanas distintas", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(52, 12, 4, 0, 3), r2b: acc(52, 12, 4, 0, 2) },
    asignaciones: [g("r2a", "2027-05-07"), g("r2a", "2027-05-09"), // vie+dom mismo finde → doblete
      g("r2b", "2027-05-14"), g("r2b", "2027-05-23")],             // vie+dom semanas distintas → no
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /doblete/i);
});

test("INV-4: 3P no infla el cómputo (queda enmascarado un desequilibrio real)", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(50), r2b: acc(53) },
    asignaciones: [g("r2a", "2027-05-05"), g("r2a", "2027-05-12"), g("r2a", "2027-05-06", "3P"), g("r2a", "2027-05-13", "3P"),
      g("r2b", "2027-05-07")],
  });
  const e = inv3(v); // r2a 52 (los 2 3P no cuentan), r2b 54 → diff 2
  assert.equal(e.length, 1);
});

test("INV-4: guardias compradas no cuentan para quien las realiza", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54), r2b: acc(53) },
    asignaciones: [g("r2b", "2027-05-08"), g("r2b", "2027-05-06", "G", { origen: "COMPRADA", cedentePrevio: "r2a" })],
  });
  assert.equal(inv3(v).length, 0); // r2a 54, r2b 54 (la comprada no suma) → diff 0
});

test("INV-3: tres residentes, max−min > 1 aunque los pares adyacentes cumplan", () => {
  const C = R("r1c", "2026-06-01", "2030-05-31");
  const E = R("r1a", "2026-06-01", "2030-05-31");
  const F = R("r1b", "2026-06-01", "2030-05-31");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [E, F, C],
    acumulados: { r1a: acc(49), r1b: acc(48), r1c: acc(47) },
    asignaciones: [],
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2027-05-31");
});

test("INV-3: frontera exacta diff 1 en todas las dimensiones no viola", () => {
  const E = R("r1a", "2026-06-01", "2030-05-31");
  const F = R("r1b", "2026-06-01", "2030-05-31");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [E, F],
    acumulados: { r1a: acc(48, 11, 4, 2, 2), r1b: acc(47, 10, 3, 1, 1) },
    asignaciones: [],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3: aniversario en junio → mayo no es cierre", () => {
  const A2 = R("r3a", "2024-06-10", "2028-06-09");
  const B2 = R("r3b", "2024-06-10", "2028-06-09");
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A2, B2],
    acumulados: { r3a: acc(54), r3b: acc(52) },
    asignaciones: [],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3: puentes libres con diferencia 2 es violación", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54, 12, 4, 4, 2), r2b: acc(55, 12, 5, 2, 2) },
    asignaciones: [],
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /puente/i);
});

test("INV-3: prefestivos con diferencia 2 al cierre es violación (la normativa los nombra en el recuento)", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54, 12, 4, 3, 2, 5), r2b: acc(54, 12, 4, 3, 2, 3) }, // prefestivos 5 vs 3
    asignaciones: [],
  });
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /prefestivo/i);
});

test("INV-3: baja médica se descuenta proporcionalmente (nota [a])", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(54, 12, 4, 3, 2), r2b: acc(50, 12, 4, 3, 2) },
    asignaciones: [],
    bloqueos: [{ residenteId: "r2b", desde: "2027-02-01", hasta: "2027-02-28", motivo: "BAJA" }],
  });
  // ventana 2026-05-26..2027-05-25 (365 d); baja 28 d → f≈0.923; 50/0.923≈54.2 vs 54 → diff <1
  assert.equal(inv3(v).length, 0);
});

// --- Cierre de TRIMESTRE (INV-3 trimestral, P-8 / decisión V-13) ---------------------------
// Solo el eje `total` («diferencia de número de guardias», p.2) y severidad `aviso` (la misma
// frase prevé compensar el exceso en los meses siguientes). T2 = sep-nov: ventana de 91 días.
const nGuardias = (id, mesPrefix, dias, extra = {}) => dias.map((d) => g(id, `${mesPrefix}-${String(d).padStart(2, "0")}`, "G", extra));

test("quarterCloseWindow: solo agosto, noviembre, febrero y mayo cierran trimestre", () => {
  assert.deepEqual(quarterCloseWindow(11, 2026), { trimestre: "T2", start: "2026-09-01", end: "2026-11-30" });
  assert.deepEqual(quarterCloseWindow(2, 2027), { trimestre: "T3", start: "2026-12-01", end: "2027-02-28" });
  assert.equal(quarterCloseWindow(10, 2026), null);
  assert.equal(quarterCloseWindow(12, 2026), null); // abre T3, no lo cierra
});

test("INV-3 trimestral: mes que no cierra trimestre no reporta nada aunque la diferencia sea enorme", () => {
  const v = validateQuarterClose({
    mes: 10, anio: 2026, residentes: [A, B],
    asignaciones: nGuardias("r3a", "2026-10", [2, 6, 10, 15, 20, 24]),
  });
  assert.equal(v.length, 0);
});

test("INV-3 trimestral: diferencia 2 al cierre de T2 es AVISO, no error", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-09", [3, 12, 21]),
      ...nGuardias("r3a", "2026-11", [4, 18]),
      ...nGuardias("r3b", "2026-10", [5, 14, 27]),
    ],
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].severidad, "aviso");
  assert.equal(v[0].invariante, "INV-3");
  assert.equal(v[0].fecha, "2026-11-30");
  assert.equal(v[0].residenteId, "r3a");
  assert.match(v[0].detalle, /trimestre T2/);
  assert.match(v[0].detalle, /r3a=5.*r3b=3/);
});

test("INV-3 trimestral: diferencia exactamente 1 no avisa", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [...nGuardias("r3a", "2026-09", [3, 12, 21, 28]), ...nGuardias("r3b", "2026-10", [5, 14, 27])],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3 trimestral: solo mide totales — findes/festivos dispares con igual total no avisan", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      // r3a: 4 festivas en fin de semana; r3b: 4 ordinarias en días de semana. Mismo total.
      ...[5, 6, 12, 13].map((d) => g("r3a", `2026-09-${String(d).padStart(2, "0")}`, "GF")),
      ...nGuardias("r3b", "2026-09", [7, 8, 14, 15]),
    ],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3 trimestral: no compara entre cohortes distintas", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, R2A], // cohortes 2024 y 2025
    asignaciones: nGuardias("r3a", "2026-09", [3, 12, 21, 25, 28]),
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3 trimestral: 3P y cedidas/compradas fuera del cómputo (INV-4 vía tally)", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-09", [3, 12, 21]),
      ...[4, 11].map((d) => g("r3a", `2026-10-${String(d).padStart(2, "0")}`, "3P")),
      ...nGuardias("r3b", "2026-10", [5, 14, 27]),
      ...nGuardias("r3b", "2026-11", [6, 13], { origen: "CEDIDA" }),
    ],
  });
  assert.equal(inv3(v).length, 0); // 3 vs 3 computables
});

test("INV-3 trimestral: las asignaciones de fuera de la ventana no cuentan", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-09", [3, 12, 21]),
      ...nGuardias("r3a", "2026-08", [4, 11, 18]), // trimestre anterior
      ...nGuardias("r3a", "2026-12", [2, 9, 16]), // trimestre siguiente
      ...nGuardias("r3b", "2026-10", [5, 14, 27]),
    ],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3 trimestral: T3 cruza el año natural — febrero cuenta las guardias de diciembre", () => {
  const v = validateQuarterClose({
    mes: 2, anio: 2027, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-12", [3, 12, 21]),
      ...nGuardias("r3a", "2027-02", [4, 18, 25]),
      ...nGuardias("r3b", "2027-01", [5, 14, 27, 30]),
    ],
  });
  const a = inv3(v);
  assert.equal(a.length, 1);
  assert.equal(a[0].fecha, "2027-02-28");
  assert.match(a[0].detalle, /2026-12-01→2027-02-28/);
});

test("INV-3 trimestral: la baja se descuenta proporcionalmente (nota [a]) y evita el aviso falso", () => {
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-09", [3, 12, 21, 25, 28, 30]), // 6
      ...nGuardias("r3b", "2026-09", [5, 14, 27]), // 4 (una más en noviembre)
      ...nGuardias("r3b", "2026-11", [6]),
    ],
    bloqueos: [{ residenteId: "r3b", desde: "2026-10-01", hasta: "2026-10-31", motivo: "BAJA" }],
  });
  // 91 días de trimestre, 31 de baja → f≈0.66; 4/0.66≈6.07 vs 6 → diferencia < 1
  assert.equal(inv3(v).length, 0);
  assert.equal(inv3(validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B],
    asignaciones: [
      ...nGuardias("r3a", "2026-09", [3, 12, 21, 25, 28, 30]),
      ...nGuardias("r3b", "2026-09", [5, 14, 27]),
      ...nGuardias("r3b", "2026-11", [6]),
    ],
  })).length, 1); // sin la baja, la misma diferencia sí avisa
});

test("INV-3 trimestral: con menos de medio trimestre disponible no se compara (evita el aviso falso por normalizar)", () => {
  const C = R("r3c", "2024-05-27", "2028-05-26");
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, B, C],
    asignaciones: [...nGuardias("r3a", "2026-09", [3, 12, 21, 25, 28, 30]), ...nGuardias("r3c", "2026-10", [4, 11, 18, 22, 26, 29])],
    // r3b de baja 77 de los 91 días del trimestre y 0 guardias: 0 vs 6 dispararía un aviso
    bloqueos: [{ residenteId: "r3b", desde: "2026-09-15", hasta: "2026-11-30", motivo: "BAJA" }],
  });
  assert.equal(inv3(v).length, 0);
});

test("INV-3 trimestral: un residente que no estaba en el trimestre no se compara", () => {
  const SALIENTE = R("r3c", "2024-05-27", "2026-08-31"); // misma cohorte, termina antes de T2
  const v = validateQuarterClose({
    mes: 11, anio: 2026, residentes: [A, SALIENTE],
    asignaciones: nGuardias("r3a", "2026-09", [3, 12, 21, 25, 28, 30]),
  });
  assert.equal(inv3(v).length, 0); // queda 1 solo residente comparable en la cohorte
});

// --- Ensamblado del cierre anual (buildYearCloseContext / yearCloseHistoryStart) ------------

test("yearCloseHistoryStart: null si nadie cierra su año de residencia ese mes", () => {
  assert.equal(yearCloseHistoryStart([A, B], 10, 2026), null);
});

test("yearCloseHistoryStart: el aniversario MÁS ANTIGUO entre los que cierran ese mes", () => {
  // A cierra el 2027-05-26 (año en curso desde 2026-05-27); R2A el 2027-05-25 (desde 2026-05-26).
  assert.equal(yearCloseHistoryStart([A, R2A], 5, 2027), "2026-05-26");
});

test("buildYearCloseContext: acumula el año en curso y traduce finde→findes", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A],
    historicas: [g("r3a", "2026-06-05"), g("r3a", "2026-09-12"), g("r3a", "2027-03-06")], // 12-sep y 6-mar son sábados
    asignacionesDelMes: [g("r3a", "2027-05-04"), g("r3a", "2027-05-11")],
  });
  assert.equal(ctx.acumulados.r3a.total, 3); // las 2 del mes NO entran en el acumulado
  assert.equal(ctx.acumulados.r3a.findes, 2);
  assert.equal(ctx.acumulados.r3a.puentesLibres, 0); // sin festivos no hay puentes que derivar
  assert.deepEqual(ctx.asignaciones, [g("r3a", "2027-05-04"), g("r3a", "2027-05-11")]);
  assert.deepEqual(ctx.puentesDelMes, []);
});

test("buildYearCloseContext: cuenta el doblete de borde de mes (contrato C-1)", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A],
    historicas: [g("r3a", "2027-04-30")], // viernes, último día de la ventana acumulada
    asignacionesDelMes: [g("r3a", "2027-05-02")], // su domingo, ya dentro del mes validado
  });
  assert.equal(ctx.acumulados.r3a.dobletes, 1);
  assert.equal(ctx.acumulados.r3a.total, 1); // el domingo pertenece al mes, no al acumulado
});

test("buildYearCloseContext: el ctx que produce es el que consume validateResidencyYearClose", () => {
  const asignacionesDelMes = [g("r3a", "2027-05-04"), g("r3a", "2027-05-11"), g("r3a", "2027-05-18")];
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B],
    // Todo en días de semana a propósito: así el único eje desequilibrado es `total`.
    historicas: [...nGuardias("r3a", "2026-06", [2, 9, 16]), ...nGuardias("r3b", "2026-06", [1, 8, 15])],
    asignacionesDelMes,
    festivos: FESTIVOS, // ninguno de los dos hace guardia en el puente → ese eje empata
  }));
  const e = inv3(v);
  assert.equal(e.length, 1); // 6 vs 3 en totales
  assert.match(e[0].detalle, /r3a=6.*r3b=3/);
});

// --- Eje `puentesLibres` (fase 3 de V-17) ---------------------------------------------------
// Hasta aquí este eje comparaba ceros: `buildYearCloseContext` lo fijaba a 0 y no derivaba
// ningún puente. Lo que estos tests fijan es que ahora sale de la tabla `festivos` y cubre la
// ventana ENTERA del año de residencia, no solo el mes que se valida.

test("buildYearCloseContext: los puentes salen de los festivos, y la ventana cruza dos años naturales", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A], // ventana 2026-05-27→2027-05-26
    historicas: [],
    asignacionesDelMes: [],
    festivos: FESTIVOS,
  });
  // El puente del 7-dic-2026 está en el año natural ANTERIOR al del mes validado.
  assert.equal(ctx.acumulados.r3a.puentesLibres, 1);
  assert.deepEqual(ctx.puentesDelMes, []); // mayo-2027 no tiene ninguno con estos festivos
});

test("buildYearCloseContext: una guardia EN el puente se lo quita a quien la hace", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B],
    historicas: [g("r3a", "2026-12-07")], // A está de guardia justo el puente
    asignacionesDelMes: [],
    festivos: FESTIVOS,
  });
  assert.equal(ctx.acumulados.r3a.puentesLibres, 0);
  assert.equal(ctx.acumulados.r3b.puentesLibres, 1);
});

test("buildYearCloseContext: un 3P en el puente NO se lo quita (es voluntario, INV-4)", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A],
    historicas: [g("r3a", "2026-12-07", "3P")],
    asignacionesDelMes: [], festivos: FESTIVOS,
  });
  assert.equal(ctx.acumulados.r3a.puentesLibres, 1);
});

// --- Sesgo de las ausencias en `puentesLibres` (decisión V-27) -----------------------------
// Antes, `residentIsFreeOnBridge` solo miraba si hubo guardia: una ROTACION/VACACIONES/BAJA
// larga hacía "libres" TODOS los puentes de ese tramo sin límite, y ni siquiera la BAJA se
// descontaba en este eje (a diferencia de los otros cinco, nota [a]).

test("buildYearCloseContext: un puente dentro de ROTACION/VACACIONES NO cuenta como libre", () => {
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B],
    historicas: [], // ninguno de los dos tiene guardia el puente
    asignacionesDelMes: [],
    bloqueos: [{ residenteId: "r3a", desde: "2026-12-01", hasta: "2026-12-15", motivo: "ROTACION" }],
    festivos: FESTIVOS,
  });
  assert.equal(ctx.acumulados.r3a.puentesLibres, 0, "estaba de rotación: no fue el reparto quien le dio el puente");
  assert.equal(ctx.acumulados.r3b.puentesLibres, 1);
});

test("INV-3: puentesLibres se normaliza por disponibilidad igual que los demás ejes", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    acumulados: { r2a: acc(0, 0, 0, 4), r2b: acc(0, 0, 0, 2) },
    asignaciones: [],
    bloqueos: [{ residenteId: "r2b", desde: "2026-08-01", hasta: "2026-11-30", motivo: "BAJA" }],
  });
  // ventana 365 d; baja 122 d → f≈0.666; 2/0.666≈3.0 vs 4 → diff≈1 (no viola); en crudo 4−2=2 sí violaría
  const puentes = inv3(v).filter((x) => /puentes libres/i.test(x.detalle));
  assert.equal(puentes.length, 0);
});

test("puentesDelMes sale del mes validado y respeta la fecha de cierre", () => {
  // R2A cierra el 2027-05-25. Con el 27-may festivo (jueves) el viernes 28 es puente, pero cae
  // DESPUÉS de su aniversario: pertenece a su año siguiente, no al que se está cerrando.
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [R2A, R2B],
    historicas: [], asignacionesDelMes: [], festivos: [...FESTIVOS, "2027-05-27"],
  });
  assert.deepEqual(ctx.puentesDelMes, ["2027-05-28"]);
  const v = validateResidencyYearClose({ ...ctx, asignaciones: [g("r2a", "2027-05-28")] });
  assert.equal(inv3(v).length, 0, "un puente posterior al cierre no cuenta para ninguno de los dos");
});

test("INV-3: el eje de puentes libres avisa de punta a punta desde los festivos", () => {
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B],
    // Dos puentes en la ventana (7-dic-2026 y 3-may-2027); A hace guardia en los dos.
    historicas: [g("r3a", "2026-12-07")],
    asignacionesDelMes: [g("r3a", "2027-05-03")],
    festivos: [...FESTIVOS, "2027-04-30", "2027-05-04"],
  }));
  const puentes = inv3(v).filter((x) => /puentes libres/i.test(x.detalle));
  assert.equal(puentes.length, 1);
  assert.equal(puentes[0].severidad, "aviso"); // la equidad nunca bloquea (V-14)
  assert.match(puentes[0].detalle, /r3b=2.*r3a=0/);
});

test("INV-3: sin ningún festivo se avisa de que el eje no se ha podido comprobar, y de qué años faltan", () => {
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B], historicas: [], asignacionesDelMes: [], festivos: [],
  }));
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].severidad, "aviso");
  assert.match(e[0].detalle, /no hay ningún festivo cargado de 2026 ni de 2027/);
  assert.match(e[0].detalle, /2026-05-27→2027-05-26/);
});

test("INV-3: con MEDIO calendario cargado también avisa, y nombra el año que falta", () => {
  // El estado intermedio normal del sistema: `crearFestivos` carga un año de golpe (V-17a) y la
  // ventana del cierre cruza dos. Preguntar «¿hay algún festivo en la ventana?» daría por
  // comprobados los puentes de 2027 con solo tener cargado 2026 — y los de 2027 no existirían.
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B], historicas: [], asignacionesDelMes: [],
    festivos: ["2026-12-06", "2026-12-08", "2026-12-25"], // 2026 sí, 2027 no
  }));
  const e = inv3(v);
  assert.equal(e.length, 1);
  assert.match(e[0].detalle, /no hay ningún festivo cargado de 2027\b/);
  assert.doesNotMatch(e[0].detalle, /de 2026/);
});

test("INV-3: con los dos años cargados no se avisa de calendario, aunque un tramo no tenga festivos", () => {
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, B], historicas: [], asignacionesDelMes: [],
    festivos: ["2026-12-08", "2027-01-06"],
  }));
  assert.equal(inv3(v).length, 0);
});

test("INV-3: si quien cierra está solo en su cohorte no se avisa de nada (no hay con quién comparar)", () => {
  const SOLO = R("r9", "2024-05-27", "2028-05-26");
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [SOLO], historicas: [], asignacionesDelMes: [], festivos: [],
  }));
  assert.equal(inv3(v).length, 0);
});

test("INV-3: el validador a secas NO inventa ese aviso (sin `festivos` no pretende comprobar puentes)", () => {
  // Los tests que inyectan `acumulados` a mano no pasan `festivos`: no deben ver el aviso nuevo.
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B],
    acumulados: { r3a: acc(54), r3b: acc(54) }, asignaciones: [],
  });
  assert.equal(inv3(v).length, 0);
});

test("yearCloseFestivosRange: años naturales COMPLETOS con un día de margen, y null si nadie cierra", () => {
  // No la ventana recortada (2026-05-27→2027-05-26): el validador tiene que poder distinguir
  // «2027 no está cargado» de «este tramo de 2027 no tiene festivos», y eso exige ver el año.
  assert.deepEqual(yearCloseFestivosRange([A, B], 5, 2027), { desde: "2025-12-31", hasta: "2028-01-01" });
  assert.equal(yearCloseFestivosRange([A, B], 10, 2026), null);
});

// --- La tolerancia viaja con la normalización (decisión V-37) --------------------------------
// El ±1 es UNA GUARDIA de verdad. Al dividir por `f`, una guardia deja de valer 1 y pasa a valer
// `1/f`, así que compararla contra un 1 fijo encogía el margen a `f` y solo dejaba pasar el
// empate exacto. Lo que sigue fija los dos lados: que el margen ya no se encoge, y que la
// normalización NO se ha apagado por el camino.

// Cohorte que TERMINA la residencia el 26 de mayo: en T4 (mar→31 de mayo) sus dos miembros
// comparten f = 87/92, que es el caso real que destapó el fallo — se repite cada mayo.
const SALE_A = R("r4a", "2023-05-27", "2027-05-26");
const SALE_B = R("r4b", "2023-05-27", "2027-05-26");
const enT4 = (id, n) => Array.from({ length: n }, (_, i) => g(id, `2027-03-${String(i + 1).padStart(2, "0")}`));

test("INV-3 trimestral: una cohorte que sale a media ventana conserva el ±1 (no se encoge a f)", () => {
  const v = validateQuarterClose({
    mes: 5, anio: 2027, residentes: [SALE_A, SALE_B],
    asignaciones: [...enT4("r4a", 10), ...enT4("r4b", 11)], // diferencia CRUDA exactamente 1
  });
  // Antes de V-37: 11/0,9456 = 11,63 vs 10,57 → 1,06 > 1 → avisaba por un reparto correcto.
  assert.deepEqual(inv3(v), []);
});

test("INV-3 trimestral: a esa misma cohorte, una diferencia de 2 le sigue avisando", () => {
  const v = validateQuarterClose({
    mes: 5, anio: 2027, residentes: [SALE_A, SALE_B],
    asignaciones: [...enT4("r4a", 10), ...enT4("r4b", 12)],
  });
  assert.equal(inv3(v).length, 1);
  assert.equal(inv3(v)[0].severidad, "aviso");
});

test("INV-3 trimestral: la normalización SIGUE mordiendo cuando las `f` son distintas", () => {
  // `debaja` está fuera media ventana, así que sus 10 guardias son el ritmo de 20 y `sano` hizo
  // 11: en crudo se llevan 1, pero el ritmo se lleva 9. Esto es lo que INV-3 existe para cazar y
  // es justo lo que se perdía con la primera versión de V-37 (poner un suelo en la diferencia
  // cruda), que además tumbaba el test hermano de las «MISMAS guardias en crudo tras una baja».
  const SANO = R("r3s", "2024-05-27", "2028-05-26");
  const BAJA = R("r3b2", "2024-05-27", "2028-05-26");
  const v = validateQuarterClose({
    mes: 5, anio: 2027, residentes: [SANO, BAJA],
    bloqueos: [{ residenteId: "r3b2", motivo: "BAJA", desde: "2027-03-01", hasta: "2027-04-15", activo: true }],
    asignaciones: [...enT4("r3s", 11), ...enT4("r3b2", 10)],
  });
  assert.equal(inv3(v).length, 1);
  assert.match(inv3(v)[0].detalle, /nota \[a\]/);
});

test("INV-3 anual: una baja IDÉNTICA en toda la cohorte tampoco encoge el ±1", () => {
  const bloqueos = ["r3a", "r3b"].map((id) => ({ residenteId: id, motivo: "BAJA", desde: "2026-09-01", hasta: "2026-11-30", activo: true }));
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B], bloqueos,
    acumulados: { r3a: acc(20), r3b: acc(21) }, // diferencia CRUDA exactamente 1
    asignaciones: [],
  });
  // Antes de V-37: f = 0,75 para los dos → 26,64 vs 27,97 → avisaba en `total`, `findes` y más.
  assert.deepEqual(inv3(v), []);
});

// ── 2026-09-04: quien dejó la residencia no «cierra» años que no cursó; sin disponibilidad no se compara ──
import { validateResidencyYearClose as vryc2, buildYearCloseContext as bycc2, yearCloseHistoryStart as ychs2 } from "../equity.js";

test("un residente que se fue en marzo (fechaFin en su R2) no cierra su año en mayo ni el siguiente: sin avisos de ceros contra su cohorte", () => {
  const salio = { id: "salio", fechaInicio: "2024-05-27", fechaFin: "2026-03-15" };
  const sigue = { id: "sigue", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
  const historicas = Array.from({ length: 12 }, (_, i) => ({ residenteId: "sigue", fecha: `2025-${String(6 + (i % 6)).padStart(2, "0")}-${String(1 + i).padStart(2, "0")}`, codigo: "G" }));
  for (const [mes, anio] of [[5, 2026], [5, 2027]]) {
    const v = vryc2(bycc2({ mes, anio, residentes: [salio, sigue], historicas, asignacionesDelMes: [], bloqueos: [] }));
    assert.deepEqual(v.filter((x) => x.invariante === "INV-3" && /salio/.test(x.detalle)), [], `${mes}/${anio}: nada que comparar con quien ya no está`);
  }
  assert.equal(ychs2([salio], 5, 2027), null, "tampoco pide histórico para alguien que se fue");
});

test("baja durante TODO el año de residencia: se excluye de la comparación en vez de juzgarse como plenamente disponible con cero guardias", () => {
  const a = { id: "a", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
  const baja = { id: "baja", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
  const historicas = Array.from({ length: 12 }, (_, i) => ({ residenteId: "a", fecha: `2025-${String(6 + (i % 6)).padStart(2, "0")}-${String(1 + i).padStart(2, "0")}`, codigo: "G" }));
  const bloqueos = [{ residenteId: "baja", desde: "2025-05-27", hasta: "2026-05-26", motivo: "BAJA", activo: true }];
  const v = vryc2(bycc2({ mes: 5, anio: 2026, residentes: [a, baja], historicas, asignacionesDelMes: [], bloqueos }));
  assert.deepEqual(v.filter((x) => x.invariante === "INV-3" && /baja/.test(x.detalle)), []);
});

// ── V-48: compañeros de la misma cohorte que cerraron ese mismo año en un mes ANTERIOR ──────────
// Antes solo se comparaban entre sí los que cerraban el MISMO mes, así que dos compañeros con
// `fechaInicio` distinta dentro del mismo año natural (o con periodos editados, nota [a]) no se
// comparaban nunca. Ahora quien cierra se compara, por parejas, con los de su cohorte que ya
// cerraron ese año dentro de los doce meses anteriores; cada uno sobre su propio año completo.
import { earlierClosedPeers } from "../equity.js";
import { addDays as addDays48 } from "../calendar.js";

// `n` guardias en el MISMO día de la semana, una por semana: si `desde` es martes, todo martes —
// ni findes ni viernes, así que solo el eje `total` se mueve.
const cadaSemana = (id, desde, n) => Array.from({ length: n }, (_, i) => g(id, addDays48(desde, 7 * i)));
const deParejas = (v) => inv3(v).filter((x) => /cerró su año/.test(x.detalle));
const E_MARZO = R("r3e", "2024-03-11", "2028-03-10"); // cohorte 2024; su R3 cierra el 2027-03-10
const E_ENERO = R("r3e1", "2024-01-15", "2028-01-14"); // cohorte 2024; su R3 cierra el 2027-01-14

test("V-48: quien cierra en mayo se compara con el compañero de cohorte que cerró ese mismo año en marzo, cada uno sobre su propio año", () => {
  assert.deepEqual(earlierClosedPeers([A, E_MARZO], 5, 2027), [
    { id: "r3e", cohorte: 2024, year: 3, win: { start: "2026-03-11", end: "2027-03-10" } },
  ]);
  assert.equal(yearCloseHistoryStart([A, E_MARZO], 5, 2027), "2026-03-11", "el histórico arranca en la ventana del que cerró antes");

  const historicas = [...cadaSemana("r3a", "2026-06-02", 20), ...cadaSemana("r3e", "2026-03-17", 10)];
  const v = validateResidencyYearClose(buildYearCloseContext({ mes: 5, anio: 2027, residentes: [A, E_MARZO], historicas }));
  const parejas = deParejas(v);
  assert.equal(parejas.length, 1, "solo el eje total se descuadra");
  assert.match(parejas[0].detalle, /^Totales al cierre del año de residencia: r3a=20 vs r3e=10 \(diferencia > 1; r3e cerró su año el 2027-03-10\)$/);
  assert.equal(parejas[0].fecha, "2027-05-26", "el aviso se fecha en el cierre de quien cierra AHORA, dentro del mes validado");
  assert.equal(parejas[0].residenteId, "r3a");
  assert.equal(parejas[0].severidad, "aviso");

  const cuadrado = validateResidencyYearClose(buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, E_MARZO],
    historicas: [...cadaSemana("r3a", "2026-06-02", 11), ...cadaSemana("r3e", "2026-03-17", 10)],
  }));
  assert.deepEqual(deParejas(cuadrado), [], "diferencia 1 sigue dentro de la norma");
});

test("V-48: en el mes en que cierra el PRIMERO de los dos no hay con quién comparar (el otro aún no ha cerrado)", () => {
  assert.deepEqual(earlierClosedPeers([A, E_MARZO], 3, 2027), []);
  assert.equal(yearCloseHistoryStart([A, E_MARZO], 3, 2027), "2026-03-11", "solo su propia ventana");
  const historicas = [...cadaSemana("r3a", "2026-06-02", 20), ...cadaSemana("r3e", "2026-03-17", 2)];
  const v = validateResidencyYearClose(buildYearCloseContext({ mes: 3, anio: 2027, residentes: [A, E_MARZO], historicas }));
  assert.deepEqual(deParejas(v), []);
});

test("V-48: con tres cierres en meses distintos, el último se compara con los dos anteriores y ellos entre sí NO (cada pareja, una vez)", () => {
  const residentes = [A, E_MARZO, E_ENERO];
  assert.deepEqual(earlierClosedPeers(residentes, 5, 2027).map((e) => e.id).sort(), ["r3e", "r3e1"]);
  assert.equal(yearCloseHistoryStart(residentes, 5, 2027), "2026-01-15");
  // r3a=10, r3e1=10, r3e=20: si r3e1 y r3e se compararan entre sí habría DOS avisos de totales.
  const historicas = [...cadaSemana("r3a", "2026-06-02", 10), ...cadaSemana("r3e", "2026-03-17", 20), ...cadaSemana("r3e1", "2026-01-20", 10)];
  const v = validateResidencyYearClose(buildYearCloseContext({ mes: 5, anio: 2027, residentes, historicas }));
  const parejas = deParejas(v);
  assert.equal(parejas.length, 1);
  assert.match(parejas[0].detalle, /r3e=20 vs r3a=10 .* r3e cerró su año el 2027-03-10/);
  assert.equal(parejas[0].residenteId, "r3a", "se le atribuye a quien cierra ahora aunque el que tiene más sea el otro");
  assert.equal(parejas[0].fecha, "2027-05-26");
});

test("V-48: ni otra cohorte ni otro año de residencia cuentan como «el mismo año», y un cierre de hace más de doce meses tampoco", () => {
  // Cohorte 2023 cuyo R3 cierra dentro de los doce meses anteriores a mayo-2027: no es su cohorte.
  const otraCohorte = R("r3c", "2023-09-01", "2027-08-31");
  assert.deepEqual(earlierClosedPeers([A, otraCohorte], 5, 2027), []);
  // Misma cohorte, pero lo que cerró en ese tramo fue su R2 alargado (nota [a]), no un R3.
  const otroAnio = {
    id: "r2d", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2025-05-26" },
      { year: 2, start: "2025-05-27", end: "2026-08-31" },
      { year: 3, start: "2026-09-01", end: "2027-08-31" },
      { year: 4, start: "2027-09-01", end: "2028-05-26" },
    ],
  };
  assert.deepEqual(earlierClosedPeers([A, otroAnio], 5, 2027), []);
  // Misma cohorte y mismo año, pero cerrado el 2026-04-30: más de un año antes del mes → fuera.
  const lejos = {
    id: "r3lejos", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2024-12-31" },
      { year: 2, start: "2025-01-01", end: "2025-08-31" },
      { year: 3, start: "2025-09-01", end: "2026-04-30" },
      { year: 4, start: "2026-05-01", end: "2028-05-26" },
    ],
  };
  assert.deepEqual(earlierClosedPeers([A, lejos], 5, 2027), []);
  assert.equal(yearCloseHistoryStart([A, lejos], 5, 2027), "2026-05-27", "y no estira el histórico");
  // Un día más tarde (2026-05-01, justo doce meses antes) sí entra.
  const borde = { ...lejos, id: "r3borde", periodos: lejos.periodos.map((p) => (p.year === 3 ? { ...p, end: "2026-05-01" } : p.year === 4 ? { ...p, start: "2026-05-02" } : p)) };
  assert.deepEqual(earlierClosedPeers([A, borde], 5, 2027).map((e) => [e.id, e.win.end]), [["r3borde", "2026-05-01"]]);
  assert.equal(yearCloseHistoryStart([A, borde], 5, 2027), "2025-09-01");
});

test("V-48: si este mes no cierra nadie, haber cerrado hace poco no pide histórico ni compara nada", () => {
  assert.deepEqual(earlierClosedPeers([A, E_MARZO], 8, 2027), []);
  assert.equal(yearCloseHistoryStart([A, E_MARZO], 8, 2027), null);
  assert.equal(yearCloseFestivosRange([A, E_MARZO], 8, 2027), null);
});

test("V-48: el compañero que cerró antes se mide sobre SU ventana — puentes libres desde `festivos`, doblete con lookahead al mes validado, y sin disponibilidad no entra", () => {
  // El puente del 7-dic-2026 cae dentro de la ventana de r3e (2026-03-11→2027-03-10).
  const conGuardiaEnPuente = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, E_MARZO], festivos: FESTIVOS,
    historicas: [g("r3e", "2026-12-07", "G")],
  });
  assert.equal(conGuardiaEnPuente.cerradosAntes.length, 1);
  assert.equal(conGuardiaEnPuente.cerradosAntes[0].dims.puentesLibres, 0);
  const libre = buildYearCloseContext({ mes: 5, anio: 2027, residentes: [A, E_MARZO], festivos: FESTIVOS, historicas: [] });
  assert.equal(libre.cerradosAntes[0].dims.puentesLibres, 1);
  assert.equal(libre.cerradosAntes[0].f, 1);
  assert.equal(libre.cerradosAntes[0].cierre, "2027-03-10");

  // Año 3 editado para cerrar el viernes 30-abr-2027: su doblete V-D se completa con el domingo
  // 2 de mayo, que está en el mes validado (contrato C-1) y no en el histórico.
  const viernes = {
    id: "r3v", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2025-05-26" },
      { year: 2, start: "2025-05-27", end: "2026-04-30" },
      { year: 3, start: "2026-05-01", end: "2027-04-30" },
      { year: 4, start: "2027-05-01", end: "2028-05-26" },
    ],
  };
  const ctx = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, viernes],
    historicas: [g("r3v", "2027-04-30", "G")], asignacionesDelMes: [g("r3v", "2027-05-02", "G")],
  });
  assert.deepEqual(ctx.cerradosAntes.map((e) => [e.id, e.dims.total, e.dims.dobletes]), [["r3v", 1, 1]], "el domingo no suma al total (está fuera de su año) pero sí cierra el doblete");

  // Baja durante toda su ventana: mismo criterio que para quien cierra ahora, fuera.
  const baja = buildYearCloseContext({
    mes: 5, anio: 2027, residentes: [A, E_MARZO], historicas: [],
    bloqueos: [{ residenteId: "r3e", motivo: "BAJA", desde: "2026-03-11", hasta: "2027-03-10", activo: true }],
  });
  assert.deepEqual(baja.cerradosAntes, []);
});

test("V-48: el aviso de calendario sin cargar mira también los años que toca la ventana del que cerró antes", () => {
  const borde = {
    id: "r3borde", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2024-12-31" },
      { year: 2, start: "2025-01-01", end: "2025-08-31" },
      { year: 3, start: "2025-09-01", end: "2026-05-01" },
      { year: 4, start: "2026-05-02", end: "2028-05-26" },
    ],
  };
  const v = validateResidencyYearClose(buildYearCloseContext({ mes: 5, anio: 2027, residentes: [A, borde], festivos: FESTIVOS, historicas: [] }));
  const sinCargar = inv3(v).filter((x) => /no hay ningún festivo cargado/.test(x.detalle));
  assert.equal(sinCargar.length, 1);
  assert.match(sinCargar[0].detalle, /de 2025,? .*ventana 2025-09-01→2027-05-26|de 2025.*2025-09-01→2027-05-26/);
});

test("V-48: un ctx armado a mano sin `cerradosAntes` se comporta exactamente como antes", () => {
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, E_MARZO],
    acumulados: { r3a: acc(20), r3e: acc(0) },
    asignaciones: [],
  });
  assert.deepEqual(inv3(v), [], "r3e no cierra este mes y nadie ha medido su año: cohorte de uno, nada que comparar");
});

// ── Verificación adversarial de V-48 (2026-09-07): tres defectos confirmados y corregidos ──────
test("V-48: un periodo con la fecha de fin vaciada o mal escrita a mano no tumba el cierre del mes de nadie", () => {
  // Un FINALIZADO de hace años con la celda `fechaFin` de su R2 borrada en el Sheet (o «30/05/2024»):
  // antes de V-48 nadie leía ese dato en la validación; `closedPeriodsBetween` recorre TODOS los
  // periodos de TODOS los residentes, así que tiene que tolerarlo.
  for (const roto of [undefined, "", "30/05/2024"]) {
    const Z = {
      id: "z", fechaInicio: "2022-05-30", fechaFin: "2026-05-29",
      periodos: [
        { year: 1, start: "2022-05-30", end: "2023-05-29" },
        { year: 2, start: "2023-05-30", end: roto },
        { year: 3, start: "2024-05-30", end: "2025-05-29" },
        { year: 4, start: "2025-05-30", end: "2026-05-29" },
      ],
    };
    assert.equal(yearCloseHistoryStart([A, B, Z], 5, 2027), "2026-05-27", `fin roto=${JSON.stringify(roto)}`);
    assert.deepEqual(earlierClosedPeers([A, B, Z], 5, 2027), []);
    const v = validateResidencyYearClose(buildYearCloseContext({ mes: 5, anio: 2027, residentes: [A, B, Z], historicas: [] }));
    assert.deepEqual(deParejas(v), []);
  }
});

test("V-48: con ventanas de distinta longitud (año alargado por la nota [a]) se compara el RITMO por día disponible, no el total proyectado", () => {
  // B tiene el R3 alargado a 15 meses (2026-08-27→2027-11-26, 457 días) y cierra en noviembre;
  // A (365 días) cerró en mayo y es su compañero anterior. Misma carga semanal: 52 vs 65 en crudo.
  const B15 = {
    id: "b15", fechaInicio: "2024-05-27", fechaFin: "2028-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2025-05-26" },
      { year: 2, start: "2025-05-27", end: "2026-08-26" },
      { year: 3, start: "2026-08-27", end: "2027-11-26" },
      { year: 4, start: "2027-11-27", end: "2028-05-26" },
    ],
  };
  assert.deepEqual(earlierClosedPeers([A, B15], 11, 2027).map((e) => e.id), ["r3a"]);
  const todas = [...cadaSemana("r3a", "2026-06-02", 52), ...cadaSemana("b15", "2026-09-01", 65)];
  const enMes = (a) => a.fecha.startsWith("2027-11");
  const ctx = buildYearCloseContext({
    mes: 11, anio: 2027, residentes: [A, B15],
    historicas: todas.filter((a) => !enMes(a)), asignacionesDelMes: todas.filter(enMes),
  });
  assert.deepEqual(deParejas(validateResidencyYearClose(ctx)), [], "65 en 457 días es el mismo ritmo que 52 en 365: antes salía 65 vs 52");

  // Y si de verdad hace más (80 en 15 meses ≈ 64 al ritmo de 12), avisa y el texto explica la escala.
  const mas = [...cadaSemana("r3a", "2026-06-02", 52), ...cadaSemana("b15", "2026-09-01", 65), ...cadaSemana("b15", "2026-09-03", 15)];
  const v = validateResidencyYearClose(buildYearCloseContext({
    mes: 11, anio: 2027, residentes: [A, B15],
    historicas: mas.filter((a) => !enMes(a)), asignacionesDelMes: mas.filter(enMes),
  }));
  const totales = deParejas(v).filter((x) => /^Totales/.test(x.detalle));
  assert.equal(totales.length, 1);
  assert.match(totales[0].detalle, /b15=63\.89 vs r3a=52 .*años de 457 y 365 días, cifras a ritmo de 365 días/);

  // Nota [a] de verdad: 15 meses con 3 de BAJA, 52 guardias en los 12 disponibles. A la par.
  const bajaB = [{ residenteId: "b15", motivo: "BAJA", desde: "2026-12-01", hasta: "2027-03-01", activo: true }];
  const conBaja = [...cadaSemana("r3a", "2026-06-02", 52), ...cadaSemana("b15", "2026-09-01", 13), ...cadaSemana("b15", "2027-03-02", 39)];
  const v2 = validateResidencyYearClose(buildYearCloseContext({
    mes: 11, anio: 2027, residentes: [A, B15], bloqueos: bajaB,
    historicas: conBaja.filter((a) => !enMes(a)), asignacionesDelMes: conBaja.filter(enMes),
  }));
  assert.deepEqual(deParejas(v2), [], "antes: 52/0,80 = 65 vs 52, el aviso falso en el escenario para el que se escribió V-48");
});

test("V-48: los que cierran el mismo mes se agrupan por cohorte Y año de residencia — un R2 alargado no se compara con los R3", () => {
  const bea = {
    id: "bea", fechaInicio: "2024-05-27", fechaFin: "2029-05-26",
    periodos: [
      { year: 1, start: "2024-05-27", end: "2025-05-26" },
      { year: 2, start: "2025-05-27", end: "2027-05-26" }, // 24 meses, cierra el mismo día que el R3 de A y B
      { year: 3, start: "2027-05-27", end: "2028-05-26" },
      { year: 4, start: "2028-05-27", end: "2029-05-26" },
    ],
  };
  const v = validateResidencyYearClose({
    mes: 5, anio: 2027, residentes: [A, B, bea],
    acumulados: { r3a: acc(20), r3b: acc(20), bea: acc(0) },
    asignaciones: [],
  });
  assert.deepEqual(inv3(v).filter((x) => /bea/.test(x.detalle)), [], "Pequeño y Mayor no reparten las mismas guardias");
  assert.deepEqual(inv3(v), [], "y A y B siguen comparándose entre sí");
});

test("V-48: el doblete del viernes 30 de quien cierra ahora se cierra con el domingo del mes siguiente que le pasa el invocador (C-1)", () => {
  // Año de residencia 2026-05-01→2027-04-30 (viernes) para los dos.
  const X = R("x", "2024-05-01", "2028-04-30");
  const Y = R("y", "2024-05-01", "2028-04-30");
  const delMes = [g("x", "2027-04-16"), g("x", "2027-04-18"), g("x", "2027-04-30")]; // V, D, V
  const con = validateResidencyYearClose(buildYearCloseContext({ mes: 4, anio: 2027, residentes: [X, Y], asignacionesDelMes: [...delMes, g("x", "2027-05-02")] }));
  const dobletes = inv3(con).filter((v) => /^Dobletes/.test(v.detalle));
  assert.equal(dobletes.length, 1);
  assert.match(dobletes[0].detalle, /x=2 vs y=0/);
  // Y la fila del mes siguiente no suma en ningún otro eje: totales 3 (no 4).
  assert.match(inv3(con).find((v) => /^Totales/.test(v.detalle)).detalle, /x=3 vs y=0/);
  const sin = validateResidencyYearClose(buildYearCloseContext({ mes: 4, anio: 2027, residentes: [X, Y], asignacionesDelMes: delMes }));
  assert.equal(inv3(sin).filter((v) => /^Dobletes/.test(v.detalle)).length, 0, "sin lookahead: 1 vs 0, diferencia 1");
});

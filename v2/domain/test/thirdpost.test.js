// Tests de v2/domain/thirdpost.js — INV-8 (tercer puesto). spec.md §5.
// Reglas: (a) solo voluntarios; (b) rotación de días por residente sobre su historial de
// 3P (7 días distintos antes de repetir, acumula entre meses, reinicia al completarse);
// (c) equidad ≤1 entre voluntarios al cierre del año de residencia; (d) prioridad mochila.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateThirdPost, thirdPostHistoryStart, canWithdrawThirdPost,
  thirdPostCommitmentEnd, THIRD_POST_PERMANENCIA_MESES,
} from "../thirdpost.js";

const R = (id, fechaInicio, fechaFin) => ({ id, fechaInicio, fechaFin });
const p3 = (residenteId, fecha) => ({ residenteId, fecha, codigo: "3P" });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });

const ANA = R("r3-ana", "2024-05-25", "2028-05-24");
const BRUNO = R("r2-bruno", "2025-05-25", "2029-05-24");
const CARLA = R("r2-carla", "2025-05-25", "2029-05-24");
const DAVID = R("r4-david", "2023-05-25", "2027-05-24");
const EVA = R("r1-eva", "2026-05-25", "2030-05-24");

// Desde la decisión V-18 NINGUNA de las cuatro reglas de INV-8 bloquea: las cuatro son aviso.
// Filtrar aquí por severidad ocultaría justo lo que hay que comprobar, así que se filtra por
// invariante —igual que en equity.test.js— y la severidad se asserta donde se fija.
const only8 = (v) => v.filter((x) => x.invariante === "INV-8");
const rotacion8 = (v) => only8(v).filter((x) => /repite|no consta en la lista/.test(x.detalle));

test("INV-8b: ciclo completo permite repetir día", () => {
  const historial3P = { "r3-ana": ["2026-06-01", "2026-06-09", "2026-06-17", "2026-06-25", "2026-07-03", "2026-07-11", "2026-07-19"] };
  const v = validateThirdPost({ mes: 8, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2026-08-03")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: repetición de día entre meses con ciclo incompleto", () => {
  const historial3P = { "r2-bruno": ["2026-09-04", "2026-09-15"] }; // V, M
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [BRUNO], voluntarios3P: ["r2-bruno"], historial3P, asignaciones: [p3("r2-bruno", "2026-10-02")] }); // viernes: repite V
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-10-02");
  assert.equal(e[0].residenteId, "r2-bruno");
});

test("INV-8b: mismo día de semana en dos residentes distintos es válido", () => {
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [CARLA, BRUNO], voluntarios3P: ["r2-carla", "r2-bruno"], historial3P: {}, asignaciones: [p3("r2-carla", "2026-10-03"), p3("r2-bruno", "2026-10-10")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: repetición dentro del segundo ciclo", () => {
  const historial3P = { "r3-ana": ["2026-06-01", "2026-06-09", "2026-06-17", "2026-06-25", "2026-07-03", "2026-07-11", "2026-07-19", "2026-08-03"] };
  const v = validateThirdPost({ mes: 8, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2026-08-17")] }); // L repetido en ciclo 2
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-08-17");
});

test("INV-8b: repetición dentro del mismo mes (segunda asignación viola)", () => {
  const v = validateThirdPost({ mes: 11, anio: 2026, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P: {}, asignaciones: [p3("r2-carla", "2026-11-06"), p3("r2-carla", "2026-11-20")] }); // dos viernes
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-11-20");
});

test("INV-8b: orden libre dentro del ciclo (D→L→J no repite)", () => {
  const historial3P = { "r2-bruno": ["2026-09-06", "2026-09-14"] }; // D, L
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [BRUNO], voluntarios3P: ["r2-bruno"], historial3P, asignaciones: [p3("r2-bruno", "2026-10-01")] }); // J
  assert.equal(only8(v).length, 0);
});

test("INV-8b: el ciclo no se reinicia por el cambio de año natural", () => {
  const historial3P = { "r3-ana": ["2026-12-28", "2026-12-30"] }; // L, X
  const v = validateThirdPost({ mes: 1, anio: 2027, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones: [p3("r3-ana", "2027-01-04")] }); // L repetido
  assert.equal(rotacion8(v).length, 1);
});

test("INV-8a: 3P asignado a un no voluntario", () => {
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA, BRUNO, CARLA, DAVID], voluntarios3P: ["r3-ana", "r2-bruno", "r2-carla"], historial3P: {}, asignaciones: [p3("r4-david", "2026-10-17")] });
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].residenteId, "r4-david");
});

// ── INV-8a con `periodosVoluntario3P` (decisión V-28): "¿era voluntario ESE día?", no "¿lo es
// AHORA?". Sin este campo (los tests de arriba) se conserva el criterio antiguo a propósito.

test("INV-8a + periodosVoluntario3P: retirado HOY no invalida un 3P legítimo de cuando SÍ era voluntario", () => {
  // Bruno se apuntó en mayo y se retiró en diciembre — hoy ya no está en `voluntarios3P` (activos),
  // pero en agosto sí lo era. Antes de V-28 esto se marcaba en falso: `voluntarios` (solo activos)
  // no lo incluye, así que `voluntarios.has()` daba false.
  const v = validateThirdPost({
    mes: 8, anio: 2026, residentes: [BRUNO], voluntarios3P: [], historial3P: {},
    asignaciones: [p3("r2-bruno", "2026-08-07")],
    periodosVoluntario3P: [{ residenteId: "r2-bruno", desde: "2026-05-01", hasta: "2026-12-01" }],
  });
  assert.equal(only8(v).length, 0);
});

test("INV-8a + periodosVoluntario3P: apuntado HOY no exime un 3P de ANTES de apuntarse", () => {
  // Carla se apuntó en septiembre. Antes de V-28 un 3P en junio (de cuando no era voluntaria)
  // se daba por bueno porque `voluntarios` (la lista de HOY) ya la incluye.
  const v = validateThirdPost({
    mes: 6, anio: 2026, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P: {},
    asignaciones: [p3("r2-carla", "2026-06-05")],
    periodosVoluntario3P: [{ residenteId: "r2-carla", desde: "2026-09-01" }],
  });
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].residenteId, "r2-carla");
});

test("INV-8a + periodosVoluntario3P: dos periodos separados (se apuntó, se retiró, volvió) cubren cada uno su tramo", () => {
  const periodos = [
    { residenteId: "r2-bruno", desde: "2026-01-01", hasta: "2026-03-31" }, // primer periodo, cerrado
    { residenteId: "r2-bruno", desde: "2026-08-01" },                     // segundo periodo, activo
  ];
  // Un 3P en febrero (dentro del primer periodo) es válido...
  const feb = validateThirdPost({
    mes: 2, anio: 2026, residentes: [BRUNO], voluntarios3P: [], historial3P: {},
    asignaciones: [p3("r2-bruno", "2026-02-06")], periodosVoluntario3P: periodos,
  });
  assert.equal(only8(feb).length, 0);
  // ...pero uno en mayo (el hueco entre los dos periodos) no lo es, aunque hoy vuelva a ser voluntario.
  const mayo = validateThirdPost({
    mes: 5, anio: 2026, residentes: [BRUNO], voluntarios3P: [], historial3P: {},
    asignaciones: [p3("r2-bruno", "2026-05-01")], periodosVoluntario3P: periodos,
  });
  assert.equal(rotacion8(mayo).length, 1);
});

test("INV-8c: diferencia 2 a mitad de año no es error", () => {
  const historial3P = {
    "r3-ana": ["2026-06-03", "2026-07-07", "2026-08-13", "2026-09-05"],
    "r2-bruno": ["2026-06-15", "2026-07-26", "2026-08-29"],
  };
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones: [p3("r3-ana", "2026-10-23")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8c: diferencia 2 al cierre del año de residencia AVISA, no bloquea (decisión V-14)", () => {
  const historial3P = {
    "r2-bruno": ["2026-06-08", "2026-07-14", "2026-09-16", "2026-11-19", "2027-02-13"],
    "r2-carla": ["2026-06-22", "2026-08-19", "2026-12-11", "2027-03-06"],
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [BRUNO, CARLA], voluntarios3P: ["r2-bruno", "r2-carla"], historial3P, asignaciones: [p3("r2-bruno", "2027-05-14")] });
  const av = v.filter((x) => x.invariante === "INV-8" && x.severidad === "aviso");
  assert.equal(av.length, 1); // Bruno 6, Carla 4 → diferencia 2 al cierre 2027-05-24
  assert.equal(v.filter((x) => x.severidad === "error").length, 0); // la equidad no bloquea nunca
  assert.match(av[0].detalle, /3P acumulados/);
});

test("INV-8c: 3P posterior al aniversario cuenta el año siguiente", () => {
  const historial3P = {
    "r2-bruno": ["2026-06-08", "2026-07-14", "2026-09-16", "2026-11-19", "2027-02-13"], // 5 en el año que cierra
    "r2-carla": ["2026-06-22", "2026-08-19", "2026-12-11", "2027-03-06"], // 4
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [BRUNO, CARLA], voluntarios3P: ["r2-bruno", "r2-carla"], historial3P, asignaciones: [p3("r2-bruno", "2027-05-28")] }); // tras el cierre
  assert.equal(only8(v).length, 0); // al cierre: 5 vs 4, diferencia 1
});

test("INV-8c: no voluntario excluido del cómputo de equidad", () => {
  const historial3P = {
    "r3-ana": ["2026-07-06", "2026-10-13", "2027-01-20"],
    "r2-bruno": ["2026-08-27", "2027-02-19"],
  };
  const v = validateThirdPost({ mes: 5, anio: 2027, residentes: [ANA, BRUNO, DAVID], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones: [] });
  assert.equal(only8(v).length, 0); // Ana 3, Bruno 2 → diferencia 1; David (no voluntario) fuera
});

test("INV-8d: mochila descubierta con 3P mal priorizado (AVISO, no bloquea)", () => {
  // r1-eva de mochila el 2026-09-11 (V); único 3P el 2026-09-12 (S, sin R1)
  // Es AVISO: el 3P es voluntario, la mala priorización se señala pero no impide VALIDAR.
  const asignaciones = [g("r1-eva", "2026-09-11", "G"), p3("r2-bruno", "2026-09-12")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, BRUNO], voluntarios3P: ["r2-bruno"], historial3P: {}, asignaciones });
  const av = v.filter((x) => x.invariante === "INV-8" && x.severidad === "aviso");
  assert.equal(av.length, 1);
  assert.equal(av[0].fecha, "2026-09-11");
  assert.equal(rotacion8(v).length, 0); // el aviso es el de mochila, no uno de rotación
});

test("INV-8d: 3P extra válido con mochilas cubiertas", () => {
  const asignaciones = [
    g("r1-eva", "2026-09-11", "G"), g("r1-eva", "2026-09-25", "G"),
    p3("r3-ana", "2026-09-11"), p3("r2-carla", "2026-09-25"),
    p3("r2-bruno", "2026-09-19"), // extra en día sin R1
  ];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, CARLA, BRUNO], voluntarios3P: ["r3-ana", "r2-carla", "r2-bruno"], historial3P: {}, asignaciones });
  assert.equal(only8(v).length, 0);
});

test("INV-8d: mochila descubierta sin ningún 3P no es error (3P es voluntario)", () => {
  const asignaciones = [g("r1-eva", "2026-09-11", "G"), g("r1-eva", "2026-09-18", "G")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P: {}, asignaciones });
  assert.equal(only8(v).length, 0);
});

test("INV-8d: prioridad mochila no exime la rotación", () => {
  // mochila 2026-09-20 (D) cubierta por r3-ana, pero ana repite domingo (ciclo incompleto con D)
  const historial3P = { "r3-ana": ["2026-09-06"] }; // D
  const asignaciones = [g("r1-eva", "2026-09-20", "G"), p3("r3-ana", "2026-09-20")];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, BRUNO], voluntarios3P: ["r3-ana", "r2-bruno"], historial3P, asignaciones });
  const e = rotacion8(v);
  assert.equal(e.length, 1);
  assert.equal(e[0].fecha, "2026-09-20");
  assert.equal(e[0].residenteId, "r3-ana");
});

test("INV-8: voluntario nuevo con historial ausente no lanza", () => {
  const v = validateThirdPost({ mes: 1, anio: 2027, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P: {}, asignaciones: [p3("r2-carla", "2027-01-13")] });
  assert.equal(only8(v).length, 0);
});

test("INV-8b: la rotación solo mira códigos 3P, no las G", () => {
  const historial3P = { "r3-ana": ["2026-10-06"] }; // M
  const asignaciones = [g("r3-ana", "2026-10-05", "G"), g("r3-ana", "2026-10-19", "G"), p3("r3-ana", "2026-10-26")]; // 3P lunes
  const v = validateThirdPost({ mes: 10, anio: 2026, residentes: [ANA], voluntarios3P: ["r3-ana"], historial3P, asignaciones });
  assert.equal(only8(v).length, 0); // lunes no está en su ciclo 3P (solo martes)
});

test("INV-8b: ciclo repartido en tres meses cruzando febrero se completa", () => {
  const historial3P = { "r2-carla": ["2026-12-25", "2027-01-16", "2027-01-24"] }; // V, S, D
  const asignaciones = ["2027-02-01", "2027-02-09", "2027-02-17", "2027-02-25"].map((f) => p3("r2-carla", f)); // L, M, X, J
  const v = validateThirdPost({ mes: 2, anio: 2027, residentes: [CARLA], voluntarios3P: ["r2-carla"], historial3P, asignaciones });
  assert.equal(only8(v).length, 0); // 7 días distintos, sin repetición
});

// --- Severidades (decisión V-18) -----------------------------------------------------------

test("INV-8: NINGUNA de las cuatro reglas bloquea; las cuatro son aviso (V-18)", () => {
  // Un mes que incumple 8a (David no es voluntario), 8b (Ana repite domingo) y 8d (la mochila
  // de Eva queda sin 3P mientras hay un 3P en día sin R1).
  const historial3P = { "r3-ana": ["2026-09-06"] }; // D
  const asignaciones = [
    g("r1-eva", "2026-09-11", "G"),
    p3("r3-ana", "2026-09-20"), // D repetido, y día sin R1
    p3("r4-david", "2026-09-22"), // no voluntario
  ];
  const v = validateThirdPost({ mes: 9, anio: 2026, residentes: [EVA, ANA, DAVID], voluntarios3P: ["r3-ana"], historial3P, asignaciones });
  assert.ok(v.length >= 3, "tienen que salir las tres");
  assert.deepEqual([...new Set(v.map((x) => x.severidad))], ["aviso"]);
});

// --- Permanencia del voluntariado (decisión V-18) ------------------------------------------

test("permanencia: son 4 meses desde el día en que se apunta, y el mes corto se recorta", () => {
  assert.equal(THIRD_POST_PERMANENCIA_MESES, 4);
  assert.equal(thirdPostCommitmentEnd("2026-08-02"), "2026-12-01");
  // 31-oct + 4 meses cae en un febrero de 28: se recorta como en addYears (§3.1).
  assert.equal(thirdPostCommitmentEnd("2026-10-31"), "2027-02-27");
});

test("permanencia: no se puede retirar antes de cumplirla, sí el día siguiente", () => {
  assert.equal(canWithdrawThirdPost("2026-08-02", "2026-08-02"), false);
  assert.equal(canWithdrawThirdPost("2026-08-02", "2026-12-01"), false, "el último día aún cuenta");
  assert.equal(canWithdrawThirdPost("2026-08-02", "2026-12-02"), true);
});

// --- thirdPostHistoryStart -----------------------------------------------------------------

test("thirdPostHistoryStart: null si no hay voluntarios (8a y 8d se resuelven con el mes)", () => {
  assert.equal(thirdPostHistoryStart([], [ANA, BRUNO], 10, 2026), null);
});

test("thirdPostHistoryStart: el ciclo de 8b arranca el día en que CADA UNO se apuntó", () => {
  const voluntarios = [
    { residenteId: "r3-ana", desde: "2026-09-01" },
    { residenteId: "r2-bruno", desde: "2026-06-15" }, // el más antiguo
  ];
  assert.equal(thirdPostHistoryStart(voluntarios, [ANA, BRUNO], 10, 2026), "2026-06-15");
});

test("thirdPostHistoryStart: si alguien cierra su año, alcanza también SU ventana de 8c", () => {
  // Bruno se apuntó hace nada, pero cierra su año de residencia en mayo-2027: la equidad de 8c
  // necesita el año entero (desde 2026-05-25), más atrás que su alta como voluntario.
  const voluntarios = [{ residenteId: "r2-bruno", desde: "2027-04-01" }];
  assert.equal(thirdPostHistoryStart(voluntarios, [BRUNO], 5, 2027), "2026-05-25");
});

test("thirdPostHistoryStart: un voluntario que ya no está en residentes no rompe el cálculo", () => {
  const voluntarios = [{ residenteId: "fantasma", desde: "2026-07-01" }];
  assert.equal(thirdPostHistoryStart(voluntarios, [ANA], 10, 2026), "2026-07-01");
});

// --- El ciclo arranca en el alta de cada voluntario (V-18b) ---------------------------------
// El histórico se lee entero a propósito (8c necesita el año de residencia), así que el recorte
// por residente vive DENTRO del validador. Sin él, los 3P de antes de apuntarse entran en el
// ciclo de alguien: añaden repeticiones falsas y, peor, pueden completar los 7 días y reiniciar
// el ciclo, tapando una repetición real.

test("INV-8b: un 3P anterior al alta del voluntario NO entra en su ciclo", () => {
  const historial3P = { "r2-bruno": ["2027-01-04"] }; // lunes, de antes de apuntarse
  const v = validateThirdPost({
    mes: 7, anio: 2027, residentes: [BRUNO],
    voluntarios3P: [{ residenteId: "r2-bruno", desde: "2027-06-01" }],
    historial3P, asignaciones: [p3("r2-bruno", "2027-07-05")], // otro lunes, el primero de su etapa
  });
  assert.deepEqual(rotacion8(v), [], "su ciclo empieza el 2027-06-01 y no tiene ningún lunes");
});

test("INV-8b: sin el recorte, ese mismo caso avisaría en falso (fija el porqué del recorte)", () => {
  const historial3P = { "r2-bruno": ["2027-01-04"] };
  const v = validateThirdPost({
    mes: 7, anio: 2027, residentes: [BRUNO],
    voluntarios3P: ["r2-bruno"], // forma sin `desde`: no hay alta que respetar
    historial3P, asignaciones: [p3("r2-bruno", "2027-07-05")],
  });
  assert.equal(rotacion8(v).length, 1);
});

test("INV-8b: los 3P de antes del alta no pueden completar el ciclo y tapar una repetición real", () => {
  // Seis días distintos ANTES del alta + un séptimo después completarían el ciclo y lo
  // reiniciarían, dejando pasar la repetición del 2027-07-05 (lunes, ya usado el 2027-06-07).
  const historial3P = { "r2-bruno": [
    "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08", "2027-01-09", "2027-01-10", // M X J V S D
    "2027-06-07", // L, ya dentro de su etapa
  ] };
  const v = validateThirdPost({
    mes: 7, anio: 2027, residentes: [BRUNO],
    voluntarios3P: [{ residenteId: "r2-bruno", desde: "2027-06-01" }],
    historial3P, asignaciones: [p3("r2-bruno", "2027-07-05")], // L repetido dentro de su etapa
  });
  assert.equal(rotacion8(v).length, 1, "la repetición real tiene que salir");
  assert.match(rotacion8(v)[0].detalle, /repite L .* 2027-07-05/);
});

test("INV-8: las dos formas de `voluntarios3P` (ids o registros) valen para INV-8a", () => {
  const base = { mes: 10, anio: 2026, residentes: [ANA, BRUNO], historial3P: {}, asignaciones: [p3("r2-bruno", "2026-10-07")] };
  const conIds = validateThirdPost({ ...base, voluntarios3P: ["r2-bruno"] });
  const conRegistros = validateThirdPost({ ...base, voluntarios3P: [{ residenteId: "r2-bruno", desde: "2026-09-01" }] });
  assert.deepEqual(only8(conIds), []);
  assert.deepEqual(only8(conRegistros), []);
});

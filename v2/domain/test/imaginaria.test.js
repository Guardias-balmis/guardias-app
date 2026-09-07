// Tests de v2/domain/imaginaria.js — INV-13 (decisión V-20). Es una HERRAMIENTA: dice a quién
// llamar cuando una incidencia deja una guardia sin cubrir. La cola no se almacena, se deriva
// del historial de coberturas, igual que el nivel R1-R4 se deriva de fechas (§1).
//
// De las cuatro reglas que ordenan la cola, solo una está en la normativa (dos listas, una por
// grupo). El orden por última cobertura, la exclusión del R1 y la exclusión por proximidad a
// otra guardia son práctica real del servicio, marcadas como extensión en spec.md §5.1.
import test from "node:test";
import assert from "node:assert/strict";
import { imaginariaQueue, nextForImaginaria, isEligibleForImaginaria } from "../imaginaria.js";

// A 2026-10-21: David R4, Ana R3, Bruno y Carla R2, Eva R1.
const R = (id, fechaInicio) => ({ id, fechaInicio, fechaFin: `${Number(fechaInicio.slice(0, 4)) + 4}${fechaInicio.slice(4)}` });
const DAVID = R("david", "2023-05-25");
const ANA = R("ana", "2024-05-25");
const BRUNO = R("bruno", "2025-05-25");
const CARLA = R("carla", "2025-05-25");
const EVA = R("eva", "2026-05-25");
const TODOS = [DAVID, ANA, BRUNO, CARLA, EVA];

const cob = (residenteId, fechaIncidencia, grupo = "PEQUENO") => ({ residenteId, fechaIncidencia, grupo });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });
const ids = (cola) => cola.map((x) => x.residenteId);
const INC = "2026-10-21";

test("dos listas, una por grupo: cada uno solo aparece en la suya", () => {
  assert.deepEqual(ids(imaginariaQueue({ residentes: TODOS, grupo: "MAYOR", fechaIncidencia: INC })), ["ana", "david"]);
  assert.deepEqual(ids(imaginariaQueue({ residentes: TODOS, grupo: "PEQUENO", fechaIncidencia: INC })), ["bruno", "carla"]);
});

test("un R1 NUNCA entra en la lista de Pequeños, aunque sea del grupo Pequeño para todo lo demás", () => {
  // Excepción explícita a la agrupación general (INV-1, INV-11): no está en la normativa, es la
  // práctica real — un R1 no puede sostener solo una guardia que aparece sin previo aviso.
  assert.equal(isEligibleForImaginaria(EVA, "PEQUENO", INC), false);
  assert.equal(isEligibleForImaginaria(BRUNO, "PEQUENO", INC), true);
  assert.ok(!ids(imaginariaQueue({ residentes: TODOS, grupo: "PEQUENO", fechaIncidencia: INC })).includes("eva"));
});

test("orden: quien nunca ha cubierto va primero; luego, por cobertura más antigua", () => {
  const coberturas = [cob("carla", "2026-09-01"), cob("bruno", "2026-06-15")];
  // Bruno cubrió antes que Carla → Bruno primero. Nadie sin cubrir en este grupo.
  assert.deepEqual(ids(imaginariaQueue({ residentes: TODOS, coberturas, grupo: "PEQUENO", fechaIncidencia: INC })), ["bruno", "carla"]);
  // Si Carla no hubiera cubierto nunca, iría ella delante pese a que Bruno sea más antiguo.
  assert.deepEqual(
    ids(imaginariaQueue({ residentes: TODOS, coberturas: [cob("bruno", "2026-06-15")], grupo: "PEQUENO", fechaIncidencia: INC })),
    ["carla", "bruno"]
  );
});

test("empate: desempata por id, o dos pantallas darían órdenes distintas para la misma incidencia", () => {
  const coberturas = [cob("bruno", "2026-09-01"), cob("carla", "2026-09-01")];
  assert.deepEqual(ids(imaginariaQueue({ residentes: TODOS, coberturas, grupo: "PEQUENO", fechaIncidencia: INC })), ["bruno", "carla"]);
  // Y el orden de entrada de `residentes` no cambia el resultado.
  assert.deepEqual(ids(imaginariaQueue({ residentes: [...TODOS].reverse(), coberturas, grupo: "PEQUENO", fechaIncidencia: INC })), ["bruno", "carla"]);
});

test("se aparta a quien tenga guardia la víspera, el día siguiente o esa misma noche", () => {
  const casos = [
    [g("bruno", "2026-10-20"), /día anterior/],
    [g("bruno", "2026-10-22"), /día siguiente/],
    [g("bruno", "2026-10-21"), /esa misma noche/],
  ];
  for (const [asignacion, motivo] of casos) {
    const cola = imaginariaQueue({ residentes: TODOS, asignaciones: [asignacion], grupo: "PEQUENO", fechaIncidencia: INC });
    const bruno = cola.find((x) => x.residenteId === "bruno");
    assert.match(bruno.apartadoPor, motivo);
    assert.equal(ids(cola)[ids(cola).length - 1], "bruno", "los apartados van al final");
    assert.equal(nextForImaginaria({ residentes: TODOS, asignaciones: [asignacion], grupo: "PEQUENO", fechaIncidencia: INC }), "carla");
  }
});

test("los apartados se DEVUELVEN con su motivo: la pantalla dice también a quién no llamar", () => {
  const cola = imaginariaQueue({ residentes: TODOS, asignaciones: [g("bruno", "2026-10-20")], grupo: "PEQUENO", fechaIncidencia: INC });
  assert.equal(cola.length, 2, "bruno sigue en la lista, apartado, no desaparecido");
  assert.equal(cola.find((x) => x.residenteId === "carla").apartadoPor, null);
});

test("un 3P la víspera NO aparta: no ocupa puesto obligatorio", () => {
  const cola = imaginariaQueue({ residentes: TODOS, asignaciones: [g("bruno", "2026-10-20", "3P")], grupo: "PEQUENO", fechaIncidencia: INC });
  assert.equal(cola.find((x) => x.residenteId === "bruno").apartadoPor, null);
});

test("una cobertura anulada no mueve a nadie en la cola", () => {
  // Append-only: corregir un registro es reinsertarlo con activo=false, y entonces deja de contar.
  const coberturas = [{ ...cob("bruno", "2026-09-01"), activo: false }];
  assert.deepEqual(ids(imaginariaQueue({ residentes: TODOS, coberturas, grupo: "PEQUENO", fechaIncidencia: INC })), ["bruno", "carla"]);
});

test("si toda la lista queda apartada, nextForImaginaria devuelve null (no inventa a nadie)", () => {
  const asignaciones = [g("bruno", "2026-10-20"), g("carla", "2026-10-22")];
  assert.equal(nextForImaginaria({ residentes: TODOS, asignaciones, grupo: "PEQUENO", fechaIncidencia: INC }), null);
  // Pero la cola sigue devolviendo a los dos, con su motivo: alguien tendrá que decidir.
  assert.equal(imaginariaQueue({ residentes: TODOS, asignaciones, grupo: "PEQUENO", fechaIncidencia: INC }).length, 2);
});

test("la cesión/compra no descuenta de la imaginaria: sin fila, la cola no se mueve", () => {
  // Literal de la normativa p.4. Sale gratis del modelo: solo genera fila quien cubre DESDE la
  // lista, así que una incidencia resuelta por cesión no deja rastro aquí y nadie avanza.
  const antes = ids(imaginariaQueue({ residentes: TODOS, grupo: "PEQUENO", fechaIncidencia: INC }));
  const despues = ids(imaginariaQueue({ residentes: TODOS, coberturas: [], grupo: "PEQUENO", fechaIncidencia: INC }));
  assert.deepEqual(antes, despues);
});

test("el nivel se deriva a la fecha de la incidencia, no a hoy", () => {
  // Eva es R1 en octubre-2026 y R2 desde su aniversario de mayo-2027: entra en la lista después.
  assert.equal(isEligibleForImaginaria(EVA, "PEQUENO", "2026-10-21"), false);
  assert.equal(isEligibleForImaginaria(EVA, "PEQUENO", "2027-10-21"), true);
});

// ── 2026-09-04: las ausencias apartan de la cola ──
import { imaginariaQueue as iq2 } from "../imaginaria.js";

test("quien está de baja (o de vacaciones/rotación) ese día queda apartado con el motivo, no el primero de la lista", () => {
  const residentes = [
    { id: "r3a", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
    { id: "r3b", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
    { id: "r3c", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
  ];
  const bloqueos = [
    { residenteId: "r3a", desde: "2026-10-01", hasta: "2026-10-31", motivo: "BAJA", activo: true },
    { residenteId: "r3b", desde: "2026-10-10", hasta: "2026-10-10", motivo: "VACACIONES", activo: true },
    { residenteId: "r3c", desde: "2026-10-10", hasta: "2026-10-12", motivo: "ROTACION", activo: false }, // cancelada: no aparta
  ];
  const cola = iq2({ residentes, coberturas: [], asignaciones: [], bloqueos, grupo: "MAYOR", fechaIncidencia: "2026-10-10" });
  assert.equal(cola[0].residenteId, "r3c");
  assert.equal(cola[0].apartadoPor, null);
  assert.equal(cola.find((x) => x.residenteId === "r3a").apartadoPor, "está de baja");
  assert.equal(cola.find((x) => x.residenteId === "r3b").apartadoPor, "está de vacaciones");
  // Sin `bloqueos` (invocadores viejos) todo sigue igual que antes.
  assert.equal(iq2({ residentes, coberturas: [], asignaciones: [], grupo: "MAYOR", fechaIncidencia: "2026-10-10" })[0].apartadoPor, null);
});

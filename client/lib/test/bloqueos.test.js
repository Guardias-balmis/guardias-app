import test from "node:test";
import assert from "node:assert/strict";
import { partirBloqueosLegibles, violacionesBloqueoIlegible } from "../bloqueos.js";
import { validateMonth, buildMonthContext } from "../../../v2/domain/validate.js";

const R = { id: "r3a", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

test("una rotación cercana con fecha ilegible se aparta y produce el mismo error INV-5 que el servidor; validateMonth ya no lanza", () => {
  const bloqueos = [
    { id: "b1", residenteId: "r3a", desde: "30/02/2027", hasta: "2027-10-10", motivo: "ROTACION", provincia: "Alicante", activo: true },
    { id: "b2", residenteId: "r3a", desde: "2027-10-20", hasta: "2027-10-22", motivo: "VACACIONES", activo: true },
    { id: "b3", residenteId: "r3a", desde: "2027-10-01", hasta: "2027-10-02", motivo: "BAJA", activo: false },
  ];
  assert.throws(() => validateMonth(buildMonthContext({ mes: 10, anio: 2027, residentes: [R], asignacionesDelMes: [], bloqueos })), /Fecha ISO inválida/, "sin partir, lanza");
  const { usables, corruptas } = partirBloqueosLegibles(bloqueos);
  assert.deepEqual(usables.map((b) => b.id), ["b2"], "la cancelada no cuenta y la ilegible se aparta");
  assert.equal(corruptas.length, 1);
  const v = violacionesBloqueoIlegible(corruptas);
  assert.equal(v[0].invariante, "INV-5");
  assert.equal(v[0].severidad, "error");
  assert.match(v[0].detalle, /30\/02\/2027/);
  assert.match(v[0].detalle, /id b1/);
  assert.doesNotThrow(() => validateMonth(buildMonthContext({ mes: 10, anio: 2027, residentes: [R], asignacionesDelMes: [], bloqueos: usables })));
});

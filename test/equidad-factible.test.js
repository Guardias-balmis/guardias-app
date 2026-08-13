// Lo que se midió el 2026-08-08 sobre la factibilidad de INV-3 y de INV-2, fijado como test para
// que la respuesta no haya que volver a calcularla (decisión V-32). Cero dependencias, node:test.
//
// POR QUÉ EXISTE. Al revisar el generador surgió la duda de si el «±1 en seis ejes» de INV-3 es
// siquiera ALCANZABLE: si no lo fuera, dejaría de ser una restricción que perseguir y habría que
// tratarlo como un objetivo aproximado, y el diseño de cualquier generador cambiaría entero. Se
// midió con tres implementaciones independientes y el veredicto fue que SÍ es alcanzable — pero
// por el camino aparecieron dos propiedades que no son opinables y que conviene que no se puedan
// romper en silencio. Son las dos que fija este fichero.
//
// Lo que este test NO hace: buscar cuadrantes. Eso es una búsqueda aleatorizada de segundos y vive
// aparte, en `test/bench/equidad-factible.mjs`, fuera de `npm test`. Aquí solo va lo determinista.

import { test } from "node:test";
import assert from "node:assert/strict";
import { datesOfMonth, toISO } from "../v2/domain/calendar.js";
import { buildMonthContext, validateMonth } from "../v2/domain/validate.js";
import { buildYearCloseContext, validateResidencyYearClose } from "../v2/domain/equity.js";

const R = (id, anioInicio) => ({ id, fechaInicio: `${anioInicio}-05-27`, fechaFin: `${anioInicio + 4}-05-26` });
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });

// ── 1. INV-2 en verano es aritméticamente inalcanzable, y por eso NO puede ser `error` ──────────
//
// En junio, julio y agosto INV-11 saca a los R1, así que el puesto de Pequeño lo cubren solo los
// R2. Con la plantilla real del servicio (4 R2, extraída de docs/guardias_radiodiagnostico_balmis_v2.xlsm)
// son 92 días para 4 personas: 7,67 guardias/mes por cabeza, contra un máximo de 6. El techo que
// permite INV-2 son 4×6×3 = 72 puestos y hacen falta 92. Faltan 20 días, y no hay reparto que lo
// arregle: cada verano, o alguien pasa de 6 (aviso INV-2) o hay días sin Pequeño (aviso INV-1 por
// infracobertura, V-12). No hay tercera opción.
//
// De ahí que estos tests importen: si alguien "arregla" INV-2 subiéndolo a `error`, el servicio se
// queda literalmente sin cuadrante de verano válido — que es exactamente el fallo que V-14 existe
// para evitar («una regla que bloquea por algo que no se puede corregir dentro de la herramienta»).

const R2_REALES = 4;
const MAX_INV2 = 6;

test("INV-2: el verano no cabe en el máximo de 6 con los R2 que tiene el servicio", () => {
  const puestosDeVerano = [6, 7, 8].reduce((n, mes) => n + datesOfMonth(2026, mes).length, 0);
  const techo = R2_REALES * MAX_INV2 * 3;

  assert.equal(puestosDeVerano, 92);
  assert.equal(techo, 72);
  assert.ok(puestosDeVerano > techo, "si esto deja de ser cierto, revisar el comentario de arriba");
  // Harían falta 6 R2 para que cupiera; con 5 tampoco.
  assert.ok(5 * MAX_INV2 * 3 < puestosDeVerano);
  assert.ok(6 * MAX_INV2 * 3 >= puestosDeVerano);
});

test("INV-2: un junio real con 4 R2 avisa pero NO bloquea (V-14)", () => {
  const mayores = [R("may1", 2023), R("may2", 2023), R("may3", 2023), R("may4", 2023), R("may5", 2023)];
  const pequenos = [R("r2a", 2025), R("r2b", 2025), R("r2c", 2025), R("r2d", 2025)];
  const residentes = [...mayores, ...pequenos];
  const dias = datesOfMonth(2026, 6);

  // Reparto tan bueno como se pueda: 30 días entre 5 Mayores (6 cada uno, justo en el máximo) y
  // entre 4 R2 (7-8 cada uno, forzosamente por encima).
  const asignacionesDelMes = dias.flatMap((fecha, i) => [
    g(mayores[i % mayores.length].id, fecha),
    g(pequenos[i % pequenos.length].id, fecha),
  ]);

  const violaciones = validateMonth(buildMonthContext({ mes: 6, anio: 2026, residentes, asignacionesDelMes, bloqueos: [] }));

  // Ningún día queda sin cubrir ni mal compuesto, y aun así INV-2 protesta: es la tensión estructural.
  assert.equal(violaciones.filter((v) => v.severidad === "error").length, 0,
    "el mejor reparto posible de un junio real no puede producir ningún error bloqueante");
  const exceso = violaciones.filter((v) => v.invariante === "INV-2" && v.detalle.includes("máximo"));
  assert.ok(exceso.length > 0, "los R2 tienen que salir por encima de 6: es aritmética, no reparto");
  assert.ok(exceso.every((v) => v.severidad === "aviso"),
    "INV-2 NO puede ser error: en verano es inalcanzable y bloquearía el cuadrante entero (V-14)");
});

// ── 2. INV-3 normaliza por disponibilidad: igualar en CRUDO tras una baja es lo que penaliza ────
//
// Este es el hallazgo que cambia el diseño de cualquier generador. Cinco de los seis ejes se
// comparan divididos por la fracción de disponibilidad (equity.js), así que a quien vuelve de una
// baja hay que darle MENOS guardias en crudo, no las mismas. Medido: un generador incremental que
// iguala totales en crudo falla el cierre anual en 0/6 intentos; el mismo generador dividiendo por
// disponibilidad sube a 4/6. Quien escriba el solver tiene que perseguir `total/f`, nunca `total`.

const VENTANA_FIN = { mes: 5, anio: 2027 }; // el año de residencia que cierra en mayo de 2027
const BAJA = { id: "b1", residenteId: "conBaja", motivo: "BAJA", desde: "2026-09-01", hasta: "2026-11-30", activo: true };

/** n guardias en martes consecutivos: ni finde, ni festivo, ni prefestivo, ni doblete — solo `total`. */
function martes(residenteId, n, desde = "2026-06-02") {
  const out = [];
  let d = new Date(`${desde}T00:00:00Z`);
  for (let i = 0; i < n; i++) { out.push(g(residenteId, d.toISOString().slice(0, 10))); d = new Date(d.getTime() + 7 * 86400000); }
  return out;
}
const totalesDe = (violaciones) => violaciones.filter((v) => v.invariante === "INV-3" && v.detalle.startsWith("Totales"));

function cierre(asignaciones, residentes) {
  const monthStart = toISO(VENTANA_FIN.anio, VENTANA_FIN.mes, 1);
  return validateResidencyYearClose(buildYearCloseContext({
    ...VENTANA_FIN, residentes, bloqueos: [BAJA], festivos: [],
    historicas: asignaciones.filter((a) => a.fecha < monthStart),
    asignacionesDelMes: asignaciones.filter((a) => a.fecha >= monthStart),
  }));
}

test("INV-3: dar las MISMAS guardias en crudo a quien tuvo una baja es una violación", () => {
  const residentes = [R("conBaja", 2024), R("sano", 2024)];
  // 30 guardias cada uno, en semanas distintas para que no coincidan en el mismo día.
  const asignaciones = [...martes("conBaja", 30), ...martes("sano", 30, "2026-06-03")];

  const v = totalesDe(cierre(asignaciones, residentes));
  assert.equal(v.length, 1, "el eje `total` se compara dividido por disponibilidad: 30 crudas no son 30");
  assert.match(v[0].detalle, /conBaja/);
});

test("INV-3: proporcionalmente menos guardias tras la baja SÍ cuadra", () => {
  const residentes = [R("conBaja", 2024), R("sano", 2024)];
  // La baja son 91 de los 365 días de la ventana → f ≈ 0,751. 30 × 0,751 ≈ 22,5.
  const asignaciones = [...martes("conBaja", 23), ...martes("sano", 30, "2026-06-03")];

  assert.deepEqual(totalesDe(cierre(asignaciones, residentes)), [],
    "23/0,751 ≈ 30,6 frente a 30: dentro del ±1");
});

test("INV-3: sin baja, la disponibilidad no distorsiona (f = 1 para ambos)", () => {
  const residentes = [R("sanoA", 2024), R("sanoB", 2024)];
  const asignaciones = [...martes("sanoA", 30), ...martes("sanoB", 31, "2026-06-03")];

  assert.deepEqual(totalesDe(cierre(asignaciones, residentes)), [],
    "30 contra 31 es exactamente el ±1 que INV-3 permite");
});

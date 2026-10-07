// Tests de v2/domain/tally.js — contaje (spec.md §4).
// Derivados de 17 casos adversariales (grupo INV-C1..C9). El contaje es "tonto a
// propósito": cuenta códigos por fecha, réplica de los SUMPRODUCT del Excel. La
// coherencia código-vs-festivo es responsabilidad de otro invariante, no del contador.
import test from "node:test";
import assert from "node:assert/strict";
import { tally, tallyByResident } from "../tally.js";

const W = (start, end) => ({ start, end });
// helper: asignación de un residente (residenteId implícito "r" salvo que se indique)
const a = (fecha, codigo, extra = {}) => ({ residenteId: "r", fecha, codigo, ...extra });

test("base: mes completo, V no suma a ningún contador", () => {
  const asg = [
    a("2026-09-02", "G"), a("2026-09-08", "G"), a("2026-09-12", "G"),
    a("2026-09-20", "G"), a("2026-09-24", "G"), a("2026-09-26", "V"),
  ];
  assert.deepEqual(tally(asg, W("2026-09-01", "2026-09-30")), {
    total: 5, finde: 2, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0,
  });
});

test("GF en sábado suma total, finde y festivos a la vez (contadores solapados)", () => {
  const asg = [a("2027-05-01", "GF")]; // sábado
  const t = tally(asg, W("2027-05-01", "2027-05-31"));
  assert.deepEqual(t, { total: 1, finde: 1, festivos: 1, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("GP en domingo suma finde y prefestivos, NUNCA festivos", () => {
  const asg = [a("2026-12-06", "GP")]; // domingo
  const t = tally(asg, W("2026-12-01", "2026-12-31"));
  assert.equal(t.finde, 1);
  assert.equal(t.prefestivos, 1);
  assert.equal(t.festivos, 0);
  assert.equal(t.total, 1);
});

test("doblete V-D estándar: viernes no cuenta como finde", () => {
  const asg = [a("2026-06-05", "G"), a("2026-06-07", "G")]; // vie + dom
  const t = tally(asg, W("2026-06-01", "2026-06-30"));
  assert.equal(t.total, 2);
  assert.equal(t.finde, 1); // solo el domingo
  assert.equal(t.dobletes, 1);
});

test("sábado + domingo NO es doblete; finde cuenta por día (=2)", () => {
  const asg = [a("2026-06-13", "G"), a("2026-06-14", "G")]; // sab + dom
  const t = tally(asg, W("2026-06-01", "2026-06-30"));
  assert.equal(t.finde, 2);
  assert.equal(t.dobletes, 0);
});

test("viernes + sábado NO es doblete (offset +1, no +2)", () => {
  const asg = [a("2026-06-19", "G"), a("2026-06-20", "G")]; // vie + sab
  const t = tally(asg, W("2026-06-01", "2026-06-30"));
  assert.equal(t.finde, 1);
  assert.equal(t.dobletes, 0);
});

test("viernes festivo (GF Navidad) + domingo SÍ es doblete", () => {
  const asg = [a("2026-12-25", "GF"), a("2026-12-27", "G")]; // vie festivo + dom
  const t = tally(asg, W("2026-12-01", "2026-12-31"));
  assert.equal(t.festivos, 1);
  assert.equal(t.finde, 1); // solo el domingo
  assert.equal(t.dobletes, 1);
});

test("doblete cruza borde jul→ago: se atribuye al mes del viernes, sin doble conteo", () => {
  const asg = [a("2026-07-31", "G"), a("2026-08-02", "G")]; // vie 31-jul + dom 2-ago
  const jul = tally(asg, W("2026-07-01", "2026-07-31"));
  const ago = tally(asg, W("2026-08-01", "2026-08-31"));
  assert.equal(jul.total, 1); assert.equal(jul.finde, 0); assert.equal(jul.dobletes, 1);
  assert.equal(ago.total, 1); assert.equal(ago.finde, 1); assert.equal(ago.dobletes, 0);
  assert.equal(jul.dobletes + ago.dobletes, 1); // agregado anual exacto
});

test("doblete oct→nov con GP sábado intermedio y GF domingo fuera de ventana", () => {
  const asg = [a("2026-10-30", "G"), a("2026-10-31", "GP"), a("2026-11-01", "GF")];
  const oct = tally(asg, W("2026-10-01", "2026-10-31"));
  const nov = tally(asg, W("2026-11-01", "2026-11-30"));
  assert.deepEqual(oct, { total: 2, finde: 1, festivos: 0, prefestivos: 1, dobletes: 1, tercerPuesto: 0, cedidasCompradas: 0 });
  // el domingo 1-nov (GF) NO cuenta en festivos/total/finde de octubre pese al lookahead
  assert.deepEqual(nov, { total: 1, finde: 1, festivos: 1, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("doblete abr→may con GP viernes día 30 (día+2 desborda el mes)", () => {
  const asg = [a("2027-04-30", "GP"), a("2027-05-02", "G")];
  const abr = tally(asg, W("2027-04-01", "2027-04-30"));
  assert.deepEqual(abr, { total: 1, finde: 0, festivos: 0, prefestivos: 1, dobletes: 1, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("viernes 31 sin domingo: sin doblete, sin crash", () => {
  const asg = [a("2026-07-31", "G")];
  const t = tally(asg, W("2026-07-01", "2026-07-31"));
  assert.equal(t.total, 1); assert.equal(t.finde, 0); assert.equal(t.dobletes, 0);
});

test("ventana trimestral T3 cruza el año natural y febrero de 28 días", () => {
  const asg = [
    a("2026-12-25", "GF"), a("2026-12-27", "G"),
    a("2027-01-01", "GF"), a("2027-01-03", "G"),
    a("2027-02-26", "G"), a("2027-02-28", "G"),
  ];
  const t = tally(asg, W("2026-12-01", "2027-02-28"));
  assert.deepEqual(t, { total: 6, finde: 3, festivos: 2, prefestivos: 0, dobletes: 3, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("tercer puesto aparte y sin formar doblete", () => {
  const asg = [a("2026-06-06", "3P"), a("2026-06-26", "G"), a("2026-06-28", "3P")];
  const t = tally(asg, W("2026-06-01", "2026-06-30"));
  assert.deepEqual(t, { total: 1, finde: 0, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 2, cedidasCompradas: 0 });
});

test("guardia comprada: registrada aparte, excluida del cómputo y rompe el doblete", () => {
  const asg = [
    a("2026-11-06", "G"),
    a("2026-11-08", "G", { origen: "COMPRADA", cedentePrevio: "r2-fatima" }),
    a("2026-11-21", "G"),
  ];
  const t = tally(asg, W("2026-11-01", "2026-11-30"));
  assert.equal(t.total, 2);        // vie 6 y sab 21; la comprada del dom 8 NO
  assert.equal(t.finde, 1);        // solo sab 21
  assert.equal(t.dobletes, 0);     // vie 6 + dom 8(comprada) no forma doblete
  assert.equal(t.cedidasCompradas, 1);
});

test("cedente de una guardia no la cuenta (no está en su lista)", () => {
  const asg = []; // r2-fatima cedió su guardia: no aparece en sus asignaciones
  const t = tally(asg, W("2026-11-01", "2026-11-30"));
  assert.deepEqual(t, { total: 0, finde: 0, festivos: 0, prefestivos: 0, dobletes: 0, tercerPuesto: 0, cedidasCompradas: 0 });
});

test("ventana parcial (media mensualidad) con lookahead — prorrateo de baja/incorporación", () => {
  const asg = [
    a("2026-10-10", "G"), // ANTERIOR a la ventana: no cuenta
    a("2026-10-17", "G"),
    a("2026-10-30", "G"),
    a("2026-11-01", "GF"), // posterior al fin de ventana: solo participa en el doblete
  ];
  const t = tally(asg, W("2026-10-15", "2026-10-31"));
  assert.equal(t.total, 2);     // 17 y 30
  assert.equal(t.finde, 1);     // sab 17
  assert.equal(t.dobletes, 1);  // vie 30 + dom 1-nov (lookahead)
  assert.equal(t.festivos, 0);  // la GF del 1-nov está fuera de ventana
});

test("contaje por código, no por lista de festivos (D4: el contador es tonto)", () => {
  const asg = [
    a("2027-01-05", "GP"), // víspera de Reyes, código correcto
    a("2027-01-06", "G"),  // Reyes marcado G (incoherente) — se cuenta como G
    a("2027-01-10", "GF"), // domingo NO festivo marcado GF (incoherente) — cuenta festivos por código
  ];
  const festivos = ["2027-01-01", "2027-01-06"];
  const t = tally(asg, W("2027-01-01", "2027-01-31"));
  assert.equal(t.total, 3);
  assert.equal(t.finde, 1);      // dom 10
  assert.equal(t.festivos, 1);   // la GF del 10, por código — NO deriva de la lista
  assert.equal(t.prefestivos, 1);
  // el contaje ignora la lista de festivos: mismo resultado con o sin ella
  assert.deepEqual(tally(asg, W("2027-01-01", "2027-01-31"), { festivos }), t);
});

test("doblete exige el MISMO residente (no cruza filas)", () => {
  const asg = [
    { residenteId: "ana", fecha: "2026-06-12", codigo: "G" }, // vie
    { residenteId: "bea", fecha: "2026-06-14", codigo: "G" }, // dom
  ];
  const porResidente = tallyByResident(asg, W("2026-06-01", "2026-06-30"));
  assert.equal(porResidente.get("ana").dobletes, 0);
  assert.equal(porResidente.get("bea").dobletes, 0);
  assert.equal(porResidente.get("ana").total, 1);
  assert.equal(porResidente.get("bea").finde, 1);
});

test("tally con lista mixta de residentes lanza (defensa contra dobletes fantasma)", () => {
  const asg = [
    { residenteId: "ana", fecha: "2026-06-12", codigo: "G" },
    { residenteId: "bea", fecha: "2026-06-14", codigo: "G" },
  ];
  assert.throws(() => tally(asg, W("2026-06-01", "2026-06-30")), /residente/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  prefsPorDefecto, fechasDelMes, prefsDelServidor, prefsParaGuardar,
  cargaEmpezada, cargaTerminada, faseDe, sePuedeEditar, guardadoConfirmado,
  mismasPrefs, hayCambiosSinGuardar,
} from "../preferencias.js";

const GUARDADAS_NOV = { id: "p1", residenteId: "res-quique", anio: 2026, mes: 11, maxGuardias: 6, fechasEvitar: ["2026-11-10"], notas: "NOTA-NOV", tercerPuesto: true };

test("prefsPorDefecto devuelve siempre un objeto nuevo (la pantalla lo edita)", () => {
  const a = prefsPorDefecto();
  a.fechasEvitar.push("2026-11-01");
  assert.deepEqual(prefsPorDefecto(), { maxGuardias: 4, fechasEvitar: [], notas: "", tercerPuesto: false });
});

test("fechasDelMes se queda solo con las del mes en pantalla, y no lanza con basura", () => {
  assert.deepEqual(fechasDelMes(["2026-11-10", "2026-10-31", "2026-11-30", 7, null], 2026, 11), ["2026-11-10", "2026-11-30"]);
  assert.deepEqual(fechasDelMes(undefined, 2026, 11), []);
  assert.deepEqual(fechasDelMes(["2026-01-05"], 2026, 1), ["2026-01-05"]);
});

test("prefsDelServidor: lo guardado tal cual; sin nada guardado, los valores por defecto", () => {
  assert.deepEqual(prefsDelServidor(GUARDADAS_NOV, 2026, 11), GUARDADAS_NOV);
  assert.deepEqual(prefsDelServidor(null, 2026, 11), prefsPorDefecto());
});

test("prefsDelServidor: un campo vacío en la hoja cae al de por defecto, y las fechas de otro mes no entran", () => {
  const p = prefsDelServidor({ maxGuardias: undefined, notas: undefined, tercerPuesto: "true", fechasEvitar: ["2026-10-31", "2026-11-02"] }, 2026, 11);
  assert.equal(p.maxGuardias, 4);
  assert.equal(p.notas, "");
  assert.equal(p.tercerPuesto, false, "solo un booleano verdadero es un «sí» (V-55)");
  assert.deepEqual(p.fechasEvitar, ["2026-11-02"]);
});

test("prefsParaGuardar no manda fechas de otro mes", () => {
  const p = prefsParaGuardar({ ...GUARDADAS_NOV, fechasEvitar: ["2026-11-10", "2026-12-01"] }, 2026, 11);
  assert.deepEqual(p.fechasEvitar, ["2026-11-10"]);
  assert.equal(p.notas, "NOTA-NOV");
});

test("la carga empieza sin poder editar ni guardar: guardar ahí pisaba lo guardado con los valores por defecto", () => {
  const c = cargaEmpezada(2026, 11);
  assert.equal(faseDe(c, 2026, 11), "cargando");
  assert.equal(sePuedeEditar(c, 2026, 11), false);
});

test("con la respuesta de misPreferencias se puede editar, haya algo guardado o no", () => {
  const conAlgo = cargaTerminada(2026, 11, { ok: true, prefs: GUARDADAS_NOV });
  assert.equal(sePuedeEditar(conAlgo, 2026, 11), true);
  assert.deepEqual(conAlgo.guardadas, GUARDADAS_NOV);
  const sinNada = cargaTerminada(2026, 11, { ok: true, prefs: null });
  assert.equal(sePuedeEditar(sinNada, 2026, 11), true);
  assert.deepEqual(sinNada.guardadas, prefsPorDefecto());
});

test("si misPreferencias falla no se puede guardar, y la fase lo dice para poder reintentar", () => {
  const c = cargaTerminada(2026, 11, { ok: false, error: "sin conexión" });
  assert.equal(faseDe(c, 2026, 11), "error");
  assert.equal(sePuedeEditar(c, 2026, 11), false);
  assert.equal(c.error, "sin conexión");
  // Reintentar es empezar otra carga: vuelve a "cargando" y, con respuesta, a "lista".
  assert.equal(faseDe(cargaEmpezada(2026, 11), 2026, 11), "cargando");
  assert.equal(faseDe(cargaTerminada(2026, 11, { ok: true, prefs: null }), 2026, 11), "lista");
});

test("un ok:true sin el campo prefs no es «nada guardado»: es un fallo (si no, se volvería a poder pisar)", () => {
  const c = cargaTerminada(2026, 11, { ok: true });
  assert.equal(faseDe(c, 2026, 11), "error");
  assert.equal(sePuedeEditar(c, 2026, 11), false);
  assert.equal(faseDe(cargaTerminada(2026, 11, undefined), 2026, 11), "error");
});

test("una carga de OTRO mes cuenta como cargando: en el render del cambio de mes aún enseña lo del anterior", () => {
  const octubre = cargaTerminada(2026, 10, { ok: true, prefs: null });
  assert.equal(faseDe(octubre, 2026, 11), "cargando");
  assert.equal(sePuedeEditar(octubre, 2026, 11), false);
  assert.equal(faseDe(cargaTerminada(2025, 11, { ok: true, prefs: null }), 2026, 11), "cargando", "mismo mes de otro año");
  assert.equal(hayCambiosSinGuardar(octubre, 2026, 11, { ...prefsPorDefecto(), notas: "x" }), false);
});

test("sin tocar nada no hay cambios; tocar cualquier campo sí; volver a lo guardado los quita", () => {
  const c = cargaTerminada(2026, 11, { ok: true, prefs: GUARDADAS_NOV });
  const pantalla = prefsDelServidor(GUARDADAS_NOV, 2026, 11);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, pantalla), false);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, tercerPuesto: false }), true);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, notas: "otra" }), true);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, maxGuardias: 5 }), true);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, fechasEvitar: [] }), true);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, fechasEvitar: ["2026-11-10", "2026-11-11"] }), true);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, notas: "otra", tercerPuesto: false }), true);
  // Marcar y desmarcar la misma fecha, o escribir y borrar, deja lo guardado: nada que perder.
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...pantalla, fechasEvitar: ["2026-11-10"], notas: "NOTA-NOV" }), false);
});

test("el «Sí» al tercer puesto sin guardar es un cambio (V-55: la respuesta es por mes)", () => {
  const c = cargaTerminada(2026, 11, { ok: true, prefs: null });
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, { ...prefsPorDefecto(), tercerPuesto: true }), true);
});

test("ni el orden de las fechas ni un espacio al final de las notas son un cambio: el servidor ordena y recorta", () => {
  const guardadas = { ...prefsPorDefecto(), fechasEvitar: ["2026-11-03", "2026-11-10"], notas: "hola" };
  assert.equal(mismasPrefs(guardadas, { ...guardadas, fechasEvitar: ["2026-11-10", "2026-11-03"] }), true);
  assert.equal(mismasPrefs(guardadas, { ...guardadas, notas: "hola  " }), true);
  assert.equal(mismasPrefs(guardadas, { ...guardadas, notas: "hola, adiós" }), false);
  // Lo que la pantalla no edita (id, residenteId, columnas legadas) no cuenta.
  assert.equal(mismasPrefs({ ...guardadas, id: "p1", preferDobles: "" }, guardadas), true);
});

test("mientras carga o tras un fallo no hay nada que perder: no se puede editar", () => {
  const pantalla = { ...prefsPorDefecto(), notas: "x" };
  assert.equal(hayCambiosSinGuardar(cargaEmpezada(2026, 11), 2026, 11, pantalla), false);
  assert.equal(hayCambiosSinGuardar(cargaTerminada(2026, 11, { ok: false, error: "x" }), 2026, 11, pantalla), false);
});

test("guardar con éxito convierte lo enviado en lo guardado, y los cambios desaparecen", () => {
  const c = cargaTerminada(2026, 11, { ok: true, prefs: GUARDADAS_NOV });
  const enviadas = prefsParaGuardar({ ...GUARDADAS_NOV, notas: "nueva", tercerPuesto: false }, 2026, 11);
  assert.equal(hayCambiosSinGuardar(c, 2026, 11, enviadas), true);
  const tras = guardadoConfirmado(c, 2026, 11, enviadas);
  assert.equal(hayCambiosSinGuardar(tras, 2026, 11, enviadas), false);
  // Lo que se escriba mientras el guardado está en vuelo sigue contando como sin guardar.
  assert.equal(hayCambiosSinGuardar(tras, 2026, 11, { ...enviadas, notas: "nueva y más" }), true);
});

test("un guardado que responde con la pantalla ya en otro mes no toca la carga de ese otro mes", () => {
  const diciembre = cargaTerminada(2026, 12, { ok: true, prefs: null });
  assert.equal(guardadoConfirmado(diciembre, 2026, 11, GUARDADAS_NOV), diciembre);
  const recargando = cargaEmpezada(2026, 11);
  assert.equal(guardadoConfirmado(recargando, 2026, 11, GUARDADAS_NOV), recargando);
});

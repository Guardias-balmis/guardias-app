// Tests de client/lib/permisos.js — quién ve qué en la interfaz.
//
// Existen sobre todo por `puedeGenerarCuadrante` (decisión V-45): el encargo pide que el botón de
// generar el cuadrante con IA solo lo vea el responsable de guardias, y esa regla es exactamente
// el tipo de cosa que se rompe sin que nadie lo note — un botón de más no da error, solo se lo
// enseña a quien no debe. Como un `.jsx` no es testeable en Node (Babel en el navegador), la
// decisión vive en un módulo `.js` real y se prueba aquí; `Home.jsx` solo la consume.
//
// Lo que estos tests NO son: un control de acceso. El permiso de verdad lo comprueba
// `requireCicloPermiso` en el servidor (ver server/test/router-generar-ia.test.js) y esconder un
// botón nunca ha impedido a nadie mandar la petición a mano.

import test from "node:test";
import assert from "node:assert/strict";
import { puedeMoverCiclo, puedeGenerarCuadrante, esAccesoDesarrolladorIA } from "../permisos.js";

const RESPONSABLE = { isResponsable: true, grupo: "MAYOR", sinResponsable: false };
const MAYOR = { isResponsable: false, grupo: "MAYOR", sinResponsable: false };
const PEQUENO = { isResponsable: false, grupo: "PEQUENO", sinResponsable: false };

test("puedeMoverCiclo: el Responsable del mandato vigente, siempre", () => {
  assert.equal(puedeMoverCiclo(RESPONSABLE), true);
});

test("puedeMoverCiclo: sin mandato vigente, cualquier Mayor (V-16); un Pequeño no", () => {
  assert.equal(puedeMoverCiclo({ ...MAYOR, sinResponsable: true }), true);
  assert.equal(puedeMoverCiclo({ ...PEQUENO, sinResponsable: true }), false);
});

test("puedeMoverCiclo: con mandato vigente, un Mayor que no es el titular no mueve el ciclo", () => {
  assert.equal(puedeMoverCiclo(MAYOR), false);
});

// ── el botón de generar con IA (V-45) ─────────────────────────────────────────────────────────

test("el Responsable ve el botón en Borrador", () => {
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE, estado: "BORRADOR" }), true);
});

test("un mes VALIDADO ya no ofrece el botón (V-46): no reescribir en silencio lo que el equipo ya revisó", () => {
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE, estado: "VALIDADO" }), false);
});

test("el resto de residentes NO lo ve, que es el requisito del encargo", () => {
  assert.equal(puedeGenerarCuadrante({ ...PEQUENO, estado: "BORRADOR" }), false);
  assert.equal(puedeGenerarCuadrante({ ...MAYOR, estado: "BORRADOR" }), false);
});

test("sin Responsable designado lo ve cualquier Mayor: el ciclo no se bloquea (V-16)", () => {
  // Es la misma razón de siempre: el año que nadie se ofrezca y el sorteo no se haya lanzado,
  // alguien tiene que poder montar el cuadrante o el servicio se queda sin él.
  assert.equal(puedeGenerarCuadrante({ ...MAYOR, sinResponsable: true, estado: "BORRADOR" }), true);
  assert.equal(puedeGenerarCuadrante({ ...PEQUENO, sinResponsable: true, estado: "BORRADOR" }), false);
});

test("un mes PUBLICADO no ofrece el botón ni al Responsable", () => {
  // Generar reescribe el mes entero y el servidor lo rechazaría: ofrecerlo sería prometer algo
  // que no va a pasar. Se despublica primero.
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE, estado: "PUBLICADO" }), false);
});

test("sin saber el estado del mes no se ofrece: no saber no es saber que no", () => {
  // `estado` llega null mientras carga y también si `estadoCuadrante` falló. En los dos casos la
  // respuesta prudente es la misma — es el mismo criterio con el que el resto de pantallas tratan
  // un fallo de red: no se asume el permiso.
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE, estado: null }), false);
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE, estado: undefined }), false);
  assert.equal(puedeGenerarCuadrante({ ...RESPONSABLE }), false);
});

test("una sesión sin datos todavía no ve el botón", () => {
  assert.equal(puedeGenerarCuadrante({}), false);
  assert.equal(puedeGenerarCuadrante({ grupo: null, estado: "BORRADOR" }), false);
});

// ── acceso de desarrollador, solo para este botón (V-46) ─────────────────────────────────────

test("esAccesoDesarrolladorIA: email exacto sí, cualquier otro no", () => {
  assert.equal(esAccesoDesarrolladorIA("agustinlagioiosa@gmail.com"), true);
  assert.equal(esAccesoDesarrolladorIA("otro@gmail.com"), false);
  assert.equal(esAccesoDesarrolladorIA(undefined), false);
  assert.equal(esAccesoDesarrolladorIA(null), false);
});

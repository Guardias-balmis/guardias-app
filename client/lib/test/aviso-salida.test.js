import test from "node:test";
import assert from "node:assert/strict";
import { avisarAlSalir } from "../aviso-salida.js";

function ventanaFalsa() {
  const escuchadores = [];
  return {
    escuchadores,
    addEventListener: (tipo, fn) => escuchadores.push({ tipo, fn }),
    removeEventListener: (tipo, fn) => {
      const i = escuchadores.findIndex((e) => e.tipo === tipo && e.fn === fn);
      if (i >= 0) escuchadores.splice(i, 1);
    },
  };
}

test("sin cambios no se pone ningún escuchador: un beforeunload fijo saca la página de la bfcache", () => {
  const v = ventanaFalsa();
  const quitar = avisarAlSalir(v, false);
  assert.equal(v.escuchadores.length, 0);
  quitar(); // y quitar lo que no se puso no rompe nada
  assert.equal(v.escuchadores.length, 0);
});

test("con cambios pide el aviso del navegador (preventDefault y returnValue), y la limpieza lo quita", () => {
  const v = ventanaFalsa();
  const quitar = avisarAlSalir(v, true);
  assert.equal(v.escuchadores.length, 1);
  assert.equal(v.escuchadores[0].tipo, "beforeunload");
  const evento = { prevenido: false, returnValue: undefined, preventDefault() { this.prevenido = true; } };
  v.escuchadores[0].fn(evento);
  assert.equal(evento.prevenido, true);
  assert.equal(evento.returnValue, "");
  quitar();
  assert.equal(v.escuchadores.length, 0);
});

test("cada llamada pone y quita el suyo: dos pantallas no se pisan el aviso", () => {
  const v = ventanaFalsa();
  const quitarA = avisarAlSalir(v, true);
  const quitarB = avisarAlSalir(v, true);
  assert.equal(v.escuchadores.length, 2);
  quitarA();
  assert.equal(v.escuchadores.length, 1);
  quitarB();
  assert.equal(v.escuchadores.length, 0);
});

// Tests de client/lib/navegacion.js — el botón «atrás» del móvil navega dentro de la app.
// El historial es un doble con la misma semántica que `window.history`: pushState corta lo que había
// delante, back/forward mueven el cursor y disparan `popstate` con el estado de la entrada de destino.
import test from "node:test";
import assert from "node:assert/strict";
import { crearNavegacion, CLAVE_PANTALLA } from "../navegacion.js";

function historialFalso() {
  const entradas = [{ state: null }]; // la página tal como se cargó
  let i = 0;
  const oyentes = new Set();
  const dispara = () => oyentes.forEach((f) => f({ state: entradas[i].state }));
  return {
    get state() { return entradas[i].state; },
    get length() { return entradas.length; },
    get indice() { return i; },
    pushState(state) { entradas.splice(i + 1); entradas.push({ state }); i++; },
    replaceState(state) { entradas[i] = { state }; },
    back() { if (i === 0) return "salió de la app"; i--; dispara(); },
    forward() { if (i < entradas.length - 1) { i++; dispara(); } },
    addEventListener(tipo, f) { if (tipo === "popstate") oyentes.add(f); },
    removeEventListener(tipo, f) { if (tipo === "popstate") oyentes.delete(f); },
    oyentes,
  };
}
function montar({ alVolver } = {}) {
  const h = historialFalso();
  const visitas = [];
  const nav = crearNavegacion({ historial: h, ventana: h, inicial: "home", alVolver: alVolver || ((p) => visitas.push(p)) });
  return { h, nav, visitas };
}

test("la entrada en la que se carga la app pasa a ser la pantalla inicial, sin crear otra", () => {
  const { h } = montar();
  assert.equal(h.length, 1);
  assert.equal(h.state[CLAVE_PANTALLA], "home");
});

test("«atrás» vuelve a la pantalla anterior y, desde la inicial, sale de la app", () => {
  const { h, nav, visitas } = montar();
  nav.ir("calendar");
  nav.ir("settings");
  nav.ir("residentes");
  assert.equal(h.back(), undefined); assert.deepEqual(visitas, ["settings"]);
  h.back(); assert.deepEqual(visitas, ["settings", "calendar"]);
  h.back(); assert.deepEqual(visitas, ["settings", "calendar", "home"]);
  assert.equal(h.back(), "salió de la app", "desde Inicio, atrás sale como en cualquier app de Android");
});

test("«adelante» también navega, y volver a cambiar de pantalla corta lo que había delante", () => {
  const { h, nav, visitas } = montar();
  nav.ir("calendar");
  h.back();
  h.forward();
  assert.deepEqual(visitas, ["home", "calendar"]);
  h.back();
  nav.ir("prefs");
  h.forward(); // no hay nada delante: «calendar» se perdió al ir a «prefs»
  assert.deepEqual(visitas, ["home", "calendar", "home"]);
  assert.equal(h.state[CLAVE_PANTALLA], "prefs");
});

test("cancelar un «atrás» (celdas sin guardar) vuelve a poner delante la pantalla en la que se queda", () => {
  let pantalla = "home";
  let pregunta = false;
  const h = historialFalso();
  const nav = crearNavegacion({
    historial: h, ventana: h, inicial: "home",
    alVolver: (p) => { if (pregunta) { nav.ir(pantalla); return; } pantalla = p; },
  });
  nav.ir("calendar"); pantalla = "calendar";
  pregunta = true; // el cuadrante tiene cambios sin guardar y el usuario dice «quedarme»
  h.back();
  assert.equal(pantalla, "calendar");
  assert.equal(h.state[CLAVE_PANTALLA], "calendar", "la entrada actual vuelve a ser el cuadrante");
  pregunta = false;
  h.back();
  assert.equal(pantalla, "home", "y el siguiente atrás, ya sin cambios, sí vuelve a Inicio");
});

test("una entrada sin estado de la app (otra página, un ancla) se trata como la pantalla inicial", () => {
  const { h, visitas } = montar();
  h.pushState({ otraCosa: 1 });
  h.pushState(null);
  h.back();
  assert.deepEqual(visitas, ["home"]);
});

test("reemplazar cambia la entrada actual sin crear otra, y desmontar deja de escuchar", () => {
  const { h, nav, visitas } = montar();
  nav.ir("calendar");
  nav.reemplazar("home");
  assert.equal(h.length, 2);
  assert.equal(h.state[CLAVE_PANTALLA], "home");
  nav.desmontar();
  assert.equal(h.oyentes.size, 0);
  h.back();
  assert.deepEqual(visitas, []);
});

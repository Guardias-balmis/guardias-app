// Tests de client/lib/navegacion.js — el botón «atrás» del móvil navega dentro de la app, con Inicio
// como raíz.
//
// El historial es un doble con la semántica de `window.history` que aquí importa: pushState corta lo
// que había delante; go/back son ASÍNCRONOS (el `popstate` llega en otra vuelta del bucle, como en el
// navegador, y por eso los tests esperan con `asentar`); el estado se clona al guardarlo; y cada
// entrada pertenece a un documento —tras una recarga, las entradas de debajo son de otro, y llegar a
// ellas vuelve a cargar la app (sin `popstate`) con el estado de esa entrada—. Delante de la app hay
// una página de otra web: llegar a ella es «haber salido de la app».
import test from "node:test";
import assert from "node:assert/strict";
import { crearNavegacion, pantallaGuardada, leerEntrada, CLAVE_NAVEGACION } from "../navegacion.js";

const PANTALLAS = ["home", "prefs", "calendar", "settings", "responsable", "datos-servicio", "residentes"];
const OPC = { raiz: "home", pantallas: PANTALLAS };

function historialFalso() {
  let documentos = 1;
  let docActual = 1;
  const entradas = [{ state: null, doc: 0, fuera: true }, { state: null, doc: 1 }];
  let i = 1;
  const oyentes = new Set();
  const viajes = [];
  const h = {
    salio: false, cargas: 0, apiladas: 0, alCargar: null,
    get state() { return entradas[i].state; },
    get length() { return entradas.length; },
    get indice() { return i; },
    entradas,
    pushState(state) { h.apiladas++; entradas.splice(i + 1); entradas.push({ state: structuredClone(state), doc: docActual }); i++; },
    replaceState(state) { entradas[i] = { ...entradas[i], state: structuredClone(state) }; },
    go(delta) { viajes.push(delta); setTimeout(procesa, 0); },
    back() { h.go(-1); },
    forward() { h.go(1); },
    addEventListener(tipo, f) { if (tipo === "popstate") oyentes.add(f); },
    removeEventListener(tipo, f) { if (tipo === "popstate") oyentes.delete(f); },
    oyentes,
    /** F5 / tirar hacia abajo: documento nuevo para la entrada actual, el resto se queda en el viejo. */
    recargar() { carga(entradas[i]); },
    /** Espera a que acaben todos los viajes, incluidos los que pidan los `popstate`. */
    async asentar() { for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 0)); },
    /** Las pantallas de la raíz (o del principio) a la entrada actual, para comparar de un vistazo. */
    pila() { return entradas.slice(1, i + 1).map((e) => (e.state && e.state[CLAVE_NAVEGACION] ? e.state[CLAVE_NAVEGACION].pantalla : null)); },
  };
  function carga(entrada) {
    docActual = ++documentos;
    entrada.doc = docActual;
    oyentes.clear();
    h.cargas++;
    if (h.alCargar) h.alCargar();
  }
  function procesa() {
    const delta = viajes.shift();
    const j = i + delta;
    if (!delta || j < 0 || j >= entradas.length) return;
    i = j;
    const e = entradas[i];
    if (e.fuera) { h.salio = true; oyentes.clear(); docActual = 0; return; }
    if (e.doc !== docActual) { carga(e); return; }
    oyentes.forEach((f) => f({ state: structuredClone(e.state) }));
  }
  return h;
}

/**
 * Una «app» mínima con las mismas reglas que App.jsx: arranca en la pantalla guardada si hay
 * sesión; sin sesión el historial no cambia la pantalla; con cambios sin guardar pregunta.
 */
function montar({ h = historialFalso(), sesion = true } = {}) {
  const app = { h, sesion, pantalla: null, avisos: [], cambios: 0, respuestas: [], preguntas: 0, nav: null };
  const confirma = () => { app.preguntas++; return app.respuestas.length ? app.respuestas.shift() : true; };
  const arrancar = () => {
    app.pantalla = (app.sesion && pantallaGuardada(h, OPC)) || "home";
    app.nav = crearNavegacion({
      historial: h, ventana: h, ...OPC, restaurar: app.sesion,
      alVolver: (p) => {
        app.avisos.push(p);
        if (!app.sesion) return false;
        if (p === app.pantalla) return true;
        if (app.cambios && !confirma()) return false;
        app.pantalla = p;
        return true;
      },
    });
  };
  h.alCargar = arrancar;
  arrancar();
  app.ir = (p) => { if (p === app.pantalla) return; if (app.cambios && !confirma()) return; app.nav.ir(p); app.pantalla = p; };
  app.irYAsentar = async (...ps) => { for (const p of ps) { app.ir(p); await h.asentar(); } };
  app.cerrarSesion = () => { app.sesion = false; app.cambios = 0; app.pantalla = "home"; app.nav.aLaRaiz(); };
  app.entrar = () => { app.sesion = true; app.pantalla = "home"; };
  app.atras = async () => { h.back(); await h.asentar(); };
  app.adelante = async () => { h.forward(); await h.asentar(); };
  return app;
}

test("al cargar, la entrada actual pasa a ser la raíz (Inicio) sin crear otra ni pisar otras claves", () => {
  const h = historialFalso();
  h.replaceState({ otraCosa: 1 });
  montar({ h });
  assert.equal(h.length, 2);
  assert.deepEqual(h.state, { otraCosa: 1, [CLAVE_NAVEGACION]: { pantalla: "home", profundidad: 0, anterior: null } });
});

test("«atrás» vuelve a la pantalla anterior y, desde Inicio, sale de la app", async () => {
  const app = montar();
  await app.irYAsentar("calendar", "settings", "residentes");
  assert.deepEqual(app.h.pila(), ["home", "calendar", "settings", "residentes"]);
  await app.atras(); assert.equal(app.pantalla, "settings");
  await app.atras(); assert.equal(app.pantalla, "calendar");
  await app.atras(); assert.equal(app.pantalla, "home");
  assert.equal(app.h.salio, false);
  await app.atras();
  assert.equal(app.h.salio, true, "desde Inicio, atrás sale como en cualquier app de Android");
});

test("(2) Inicio es la raíz: pasar por él desde la barra no apila, y un solo «atrás» desde Inicio sale", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "home", "calendar", "home", "prefs", "home");
  assert.equal(app.pantalla, "home");
  assert.deepEqual(app.h.pila(), ["home"]);
  await app.atras();
  assert.equal(app.h.salio, true);
  assert.deepEqual(app.avisos, [], "los viajes que pide la propia app no se notifican como un «atrás»");
});

test("ir a Inicio desde lo hondo desapila de una vez, aunque haya pantallas en medio", async () => {
  const app = montar();
  await app.irYAsentar("calendar", "settings", "datos-servicio");
  await app.irYAsentar("home");
  assert.equal(app.h.indice, 1);
  assert.equal(app.h.state[CLAVE_NAVEGACION].profundidad, 0);
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("(3) «← Volver» a la pantalla anterior deshace en vez de apilar: el siguiente «atrás» no vuelve a la subpantalla", async () => {
  const app = montar();
  await app.irYAsentar("settings", "datos-servicio", "settings", "residentes", "settings", "responsable", "settings");
  assert.deepEqual(app.h.pila(), ["home", "settings"]);
  await app.atras();
  assert.equal(app.pantalla, "home");
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("volver a una pantalla que NO es la anterior sí apila (y la de delante se pierde, como siempre)", async () => {
  const app = montar();
  await app.irYAsentar("calendar", "prefs", "settings", "calendar");
  assert.deepEqual(app.h.pila(), ["home", "calendar", "prefs", "settings", "calendar"]);
  await app.atras();                 // a settings, cuya anterior es prefs
  await app.irYAsentar("prefs");
  assert.deepEqual(app.h.pila(), ["home", "calendar", "prefs"], "prefs era la anterior: back, no otra entrada");
  assert.equal(app.h.length, 6, "settings y calendar siguen delante hasta que se apile otra cosa");
});

test("«adelante» también navega, y la entrada guarda su anterior al llegar por un viaje", async () => {
  const app = montar();
  await app.irYAsentar("calendar", "settings");
  await app.atras();
  assert.equal(app.pantalla, "calendar");
  await app.adelante();
  assert.equal(app.pantalla, "settings");
  // tras el atrás/adelante, «← Volver» a calendar sigue sabiendo que es la anterior
  await app.irYAsentar("calendar");
  assert.deepEqual(app.h.pila(), ["home", "calendar"]);
});

test("un cambio de pantalla pedido mientras hay un viaje en curso espera a que llegue", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "settings");
  app.ir("home");      // go(-2), asíncrono
  app.ir("calendar");  // llega antes del popstate: no puede apilar sobre «settings»
  await app.h.asentar();
  assert.equal(app.pantalla, "calendar");
  assert.deepEqual(app.h.pila(), ["home", "calendar"]);
  await app.atras();
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("(1) cerrar sesión desapila hasta la raíz: en el login, «atrás» sale de la app", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "calendar");
  app.cerrarSesion();
  await app.h.asentar();
  assert.deepEqual(app.h.pila(), ["home"]);
  assert.deepEqual(app.avisos, []);
  await app.atras();
  assert.equal(app.h.salio, true, "no hay entradas de la sesión anterior que consumir");
});

test("(1) tras cerrar sesión, quien entre después empieza en Inicio y «atrás» sale", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "calendar");
  app.cerrarSesion();
  await app.h.asentar();
  // en el login, «adelante» llevaría a las pantallas de antes: sin sesión se rechaza y vuelve
  await app.adelante();
  assert.equal(app.pantalla, "home");
  assert.equal(app.h.state[CLAVE_NAVEGACION].profundidad, 0);
  app.entrar();
  assert.equal(app.pantalla, "home");
  await app.irYAsentar("settings");
  assert.deepEqual(app.h.pila(), ["home", "settings"], "lo de la sesión anterior se ha cortado");
  await app.atras();
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("cerrar sesión en mitad de un viaje también acaba en la raíz", async () => {
  const app = montar();
  await app.irYAsentar("settings", "residentes");
  app.ir("settings"); // back(), en curso
  app.cerrarSesion();
  await app.h.asentar();
  assert.deepEqual(app.h.pila(), ["home"]);
});

test("(4) al recargar con sesión, la app arranca en la pantalla de la entrada y «atrás» sigue la pila", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "calendar");
  app.h.recargar();
  assert.equal(app.pantalla, "calendar");
  assert.equal(app.h.length, 4, "recargar no crea ni pisa entradas");
  assert.deepEqual(app.h.state[CLAVE_NAVEGACION], { pantalla: "calendar", profundidad: 2, anterior: "prefs" });
  await app.atras();                 // la de debajo es del documento viejo: vuelve a cargar la app
  assert.equal(app.pantalla, "prefs");
  await app.atras();
  assert.equal(app.pantalla, "home");
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("(4) tras recargar, Inicio y «← Volver» siguen desapilando (aunque crucen al documento de antes)", async () => {
  const app = montar();
  await app.irYAsentar("settings", "residentes");
  app.h.recargar();
  assert.equal(app.pantalla, "residentes");
  await app.irYAsentar("settings");
  assert.equal(app.pantalla, "settings");
  assert.deepEqual(app.h.pila(), ["home", "settings"]);
  await app.irYAsentar("home");
  assert.equal(app.pantalla, "home");
  await app.atras();
  assert.equal(app.h.salio, true);
});

test("al recargar SIN sesión no se restaura la pantalla: se desapila hasta la raíz", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "calendar");
  app.sesion = false; // caducó, o se cerró en otra pestaña
  app.h.recargar();
  await app.h.asentar();
  assert.equal(app.pantalla, "home");
  assert.equal(app.h.indice, 1);
  app.entrar();
  await app.atras();
  assert.equal(app.h.salio, true, "tras entrar, «atrás» desde Inicio no lleva a la sesión anterior");
});

test("cancelar un «atrás» (celdas sin guardar) vuelve a la pantalla actual sin apilar nada", async () => {
  const app = montar();
  await app.irYAsentar("prefs", "calendar");
  app.cambios = 1;
  const apiladas = app.h.apiladas;
  app.respuestas.push(false);  // «quedarme»
  await app.atras();
  assert.equal(app.pantalla, "calendar");
  assert.equal(app.h.state[CLAVE_NAVEGACION].pantalla, "calendar", "la entrada actual vuelve a ser el cuadrante");
  assert.equal(app.h.apiladas, apiladas, "sin crear ninguna entrada: Chrome se salta al ir atrás las creadas sin gesto");
  assert.equal(app.h.length, 4);
  assert.equal(app.preguntas, 1, "volver a la entrada del cuadrante no pregunta otra vez");
  app.respuestas.push(true);   // ahora sí, salir
  await app.atras();
  assert.equal(app.pantalla, "prefs");
  assert.equal(app.preguntas, 2);
});

test("cancelar un «adelante» también se deshace", async () => {
  const app = montar();
  await app.irYAsentar("calendar", "prefs");
  await app.atras();
  app.cambios = 1;
  app.respuestas.push(false);
  await app.adelante();
  assert.equal(app.pantalla, "calendar");
  assert.equal(app.h.state[CLAVE_NAVEGACION].pantalla, "calendar");
});

test("una entrada sin estado de la app se adopta como raíz", async () => {
  const app = montar();
  app.h.pushState({ otraCosa: 1 });
  app.h.pushState(null);
  await app.atras();
  assert.equal(app.pantalla, "home");
  assert.equal(app.h.state[CLAVE_NAVEGACION].profundidad, 0);
  assert.equal(app.h.state.otraCosa, 1);
});

test("leerEntrada solo acepta entradas coherentes", () => {
  const e = (nav) => ({ [CLAVE_NAVEGACION]: nav });
  assert.deepEqual(leerEntrada(e({ pantalla: "calendar", profundidad: 1, anterior: "home" }), OPC), { pantalla: "calendar", profundidad: 1, anterior: "home" });
  assert.equal(leerEntrada(null, OPC), null);
  assert.equal(leerEntrada({ gappPantalla: "calendar" }, OPC), null, "la forma de la versión anterior no trae profundidad");
  assert.equal(leerEntrada(e({ pantalla: "calendar", profundidad: 0, anterior: null }), OPC), null, "a profundidad 0 solo está la raíz");
  assert.equal(leerEntrada(e({ pantalla: "home", profundidad: 2, anterior: "prefs" }), OPC), null, "y la raíz solo a profundidad 0");
  assert.equal(leerEntrada(e({ pantalla: "admin", profundidad: 1, anterior: "home" }), OPC), null, "una pantalla que la app ya no pinta");
  assert.equal(leerEntrada(e({ pantalla: "calendar", profundidad: 1.5, anterior: "home" }), OPC), null);
  assert.equal(pantallaGuardada({ state: e({ pantalla: "prefs", profundidad: 1, anterior: "home" }) }, OPC), "prefs");
  assert.equal(pantallaGuardada({ state: null }, OPC), null);
});

test("desmontar deja de escuchar", async () => {
  const app = montar();
  await app.irYAsentar("calendar");
  app.nav.desmontar();
  assert.equal(app.h.oyentes.size, 0);
  await app.atras();
  assert.deepEqual(app.avisos, []);
});

// `NAVEGACION.pantallas` (App.jsx) se mantiene a mano junto al `switch` que pinta las pantallas. Si
// una pantalla nueva entra en el switch y no en la lista, `ir()` la apila igual, pero al volver a
// ella con «atrás» `leerEntrada` la toma por ajena: la app salta a Inicio y esa entrada se reescribe
// como raíz en mitad de la pila, sin ningún error. Esto lee el código fuente y lo dice.
test("NAVEGACION.pantallas de App.jsx es exactamente lo que pinta su switch, y todo setTab apunta a una de ellas", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const raiz = new URL("../../../", import.meta.url);
  const app = readFileSync(new URL("client/App.jsx", raiz), "utf8");
  const lista = app.match(/const NAVEGACION = \{[^}]*pantallas: \[([^\]]*)\]/);
  assert.ok(lista, "no encuentro NAVEGACION.pantallas en App.jsx");
  const pantallas = new Set([...lista[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const pintadas = new Set([...app.matchAll(/tabVisible === "([^"]+)" \?/g)].map((m) => m[1]));
  assert.deepEqual([...pantallas].sort(), [...pintadas].sort(), "NAVEGACION.pantallas y el switch de App.jsx no coinciden");
  const jsx = ["client/App.jsx", ...readdirSync(new URL("client/screens/", raiz)).map((f) => "client/screens/" + f)];
  for (const f of jsx) {
    for (const m of readFileSync(new URL(f, raiz), "utf8").matchAll(/setTab\("([^"]+)"\)/g)) {
      assert.ok(pantallas.has(m[1]), `${f} hace setTab("${m[1]}"), que no está en NAVEGACION.pantallas`);
    }
  }
});

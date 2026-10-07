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
import { puedeMoverCiclo, puedeGenerarCuadrante, esAccesoDesarrollador } from "../permisos.js";

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

// ── acceso de desarrollador, para todo el ciclo (V-49, amplía V-46) ──────────────────────────

test("esAccesoDesarrollador: email exacto sí (dentro de plazo), cualquier otro no", () => {
  assert.equal(esAccesoDesarrollador("agustinlagioiosa@gmail.com", "2026-09-03"), true);
  assert.equal(esAccesoDesarrollador("otro@gmail.com", "2026-09-03"), false);
  assert.equal(esAccesoDesarrollador(undefined, "2026-09-03"), false);
  assert.equal(esAccesoDesarrollador(null, "2026-09-03"), false);
});

test("esAccesoDesarrollador: caduca sola pasada la fecha límite (V-49)", () => {
  assert.equal(esAccesoDesarrollador("agustinlagioiosa@gmail.com", "2027-03-31"), true, "el último día cuenta");
  assert.equal(esAccesoDesarrollador("agustinlagioiosa@gmail.com", "2027-04-01"), false);
});

test("V-49: el acceso de desarrollador destraba puedeMoverCiclo entero, no solo generar", () => {
  const dev = { isResponsable: false, grupo: "PEQUENO", sinResponsable: false, accesoDesarrollador: true };
  assert.equal(puedeMoverCiclo(dev), true, "aunque sea Pequeño y haya Responsable vigente");
});

test("V-49: sin el acceso de desarrollador, puedeMoverCiclo sigue las reglas de siempre", () => {
  assert.equal(puedeMoverCiclo({ ...PEQUENO, accesoDesarrollador: false }), false);
});

test("puedeValidarCuadrante: en la ventana solo los administradores; pasada, el permiso del ciclo (V-52)", async () => {
  const { puedeValidarCuadrante } = await import("../permisos.js");
  const hoy = "2026-10-06";
  assert.equal(puedeValidarCuadrante({ email: "agustinlagioiosa@gmail.com", puedeMoverCiclo: false, hoy }), true);
  assert.equal(puedeValidarCuadrante({ email: "quiquemm14@gmail.com", puedeMoverCiclo: false, hoy }), true);
  assert.equal(puedeValidarCuadrante({ email: "resp@gmail.com", puedeMoverCiclo: true, hoy }), false, "ni el Responsable");
  assert.equal(puedeValidarCuadrante({ email: "resp@gmail.com", puedeMoverCiclo: true, hoy: "2027-04-01" }), true, "caducada: vuelve V-16");
  assert.equal(puedeValidarCuadrante({ email: "otro@gmail.com", puedeMoverCiclo: false, hoy: "2027-04-01" }), false);
});

test("quienApruebaSolicitudes: los administradores en la ventana; el ciclo normal después (V-57)", async () => {
  const { quienApruebaSolicitudes } = await import("../permisos.js");
  assert.equal(quienApruebaSolicitudes("2027-03-31"), "un administrador");
  assert.match(quienApruebaSolicitudes("2027-04-01"), /^el Responsable .*R3 o R4/);
});

test("textoAvisoSolicitud: solo dice que hay correo si el servidor confirma que salió (V-57)", async () => {
  const { textoAvisoSolicitud } = await import("../permisos.js");
  assert.match(textoAvisoSolicitud(2), /aviso por correo/);
  assert.match(textoAvisoSolicitud(1), /aviso por correo/);
  assert.match(textoAvisoSolicitud(0), /No se ha podido avisar.*avisa tú/);
  assert.equal(textoAvisoSolicitud(undefined), "", "sin el dato (reutilizada o servidor viejo) no afirma nada");
});

test("esAccesoDesarrollador compara el email normalizado, como el servidor y el login (V-57)", () => {
  assert.equal(esAccesoDesarrollador("  Quiquemm14@gmail.com ", "2026-10-07"), true);
  assert.equal(esAccesoDesarrollador(undefined, "2026-10-07"), false);
});

test("P-17: la fase de quintas y 3P se ofrece en Borrador y en Validado, nunca en Publicado", async () => {
  const { puedeAnadirExtras } = await import("../permisos.js");
  assert.equal(puedeAnadirExtras({ ...RESPONSABLE, estado: "BORRADOR" }), true);
  assert.equal(puedeAnadirExtras({ ...RESPONSABLE, estado: "VALIDADO" }), true);
  assert.equal(puedeAnadirExtras({ ...RESPONSABLE, estado: "PUBLICADO" }), false);
  assert.equal(puedeAnadirExtras({ ...PEQUENO, estado: "VALIDADO" }), false);
});

// ── la tarjeta del generador de Inicio: cuándo se ve y qué ofrece (vistaGenerador) ─────────────
//
// El fallo que esto fija: esconder la tarjeta escondía también su selector de mes. Un ◀ hacia un
// mes PUBLICADO la hacía desaparecer y desde Inicio no se podía volver; y mientras se comprobaba el
// estado del mes encogía sin flechas, así que una ráfaga de toques caía en otra tarjeta.

test("vistaGenerador: en Borrador ofrece las dos fases si el servidor entiende la segunda", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const v = vistaGenerador({ ...RESPONSABLE, estado: "BORRADOR", extrasDisponible: true });
  assert.deepEqual(v, { fases: ["obligatorias", "extras"], motivo: null, estado: "BORRADOR", comprobando: false, error: null, activa: true, flechas: true });
  assert.deepEqual(vistaGenerador({ ...RESPONSABLE, estado: "BORRADOR", extrasDisponible: false }).fases, ["obligatorias"], "servidor viejo: solo la fase 1");
});

test("vistaGenerador: un mes PUBLICADO no esconde la tarjeta (ni sus flechas): dice por qué no se genera", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const v = vistaGenerador({ ...RESPONSABLE, estado: "PUBLICADO", extrasDisponible: true });
  assert.notEqual(v, null);
  assert.deepEqual(v.fases, []);
  assert.equal(v.motivo, "PUBLICADO");
  assert.equal(v.activa, false);
  assert.equal(v.flechas, true, "y se puede salir de él con ◀/▶");
});

test("vistaGenerador: un mes VALIDADO ofrece solo la fase 2 (V-59), y si el servidor no la entiende, dice por qué", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const con = vistaGenerador({ ...RESPONSABLE, estado: "VALIDADO", extrasDisponible: true });
  assert.deepEqual([con.fases, con.motivo, con.activa], [["extras"], "VALIDADO", true]);
  const sin = vistaGenerador({ ...RESPONSABLE, estado: "VALIDADO", extrasDisponible: false });
  assert.notEqual(sin, null, "antes desaparecía la tarjeta entera, flechas incluidas");
  assert.deepEqual([sin.fases, sin.motivo, sin.activa], [[], "VALIDADO", false]);
});

test("vistaGenerador: un estado desconocido tampoco la esconde ni ofrece nada", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const v = vistaGenerador({ ...RESPONSABLE, estado: "ARCHIVADO", extrasDisponible: true });
  assert.deepEqual([v.fases, v.motivo, v.estado, v.activa], [[], "OTRO", "ARCHIVADO", false]);
});

test("vistaGenerador: sabido el estado, quien no tiene el permiso del ciclo no ve la tarjeta", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  for (const estado of ["BORRADOR", "VALIDADO", "PUBLICADO"]) {
    assert.equal(vistaGenerador({ ...MAYOR, estado, extrasDisponible: true }), null, `Mayor con Responsable vigente, ${estado}`);
    assert.equal(vistaGenerador({ ...PEQUENO, estado, extrasDisponible: true }), null, `Pequeño, ${estado}`);
    assert.equal(vistaGenerador({ ...PEQUENO, sinResponsable: true, estado, extrasDisponible: true }), null, `Pequeño sin Responsable, ${estado}`);
  }
  assert.notEqual(vistaGenerador({ ...MAYOR, sinResponsable: true, estado: "PUBLICADO" }), null, "sin Responsable, un Mayor sí (V-16)");
  assert.notEqual(vistaGenerador({ ...PEQUENO, accesoDesarrollador: true, estado: "PUBLICADO" }), null, "acceso de desarrollador (V-49)");
});

test("vistaGenerador: mientras se comprueba, cualquier Mayor la ve aunque aún no se sepa si hay Responsable", async () => {
  // `sinResponsable` viaja en la misma respuesta que el estado: hasta que llega vale false, y
  // esconderla por eso dejaba sin tarjeta a un Mayor justo en el caso real (sin Responsable).
  const { vistaGenerador } = await import("../permisos.js");
  const v = vistaGenerador({ ...MAYOR, estado: null });
  assert.deepEqual(v, { fases: [], motivo: null, estado: null, comprobando: true, error: null, activa: false, flechas: false });
  assert.equal(vistaGenerador({ ...PEQUENO, estado: null }), null, "un Pequeño no la tendría ni sin Responsable");
});

test("vistaGenerador: las flechas solo se pulsan con el permiso confirmado, nunca con el «a lo mejor»", async () => {
  // Un Mayor con Responsable vigente ve la tarjeta el segundo que tarda la primera comprobación:
  // si pudiera cambiar de mes ahí, al llegar la respuesta la tarjeta desaparecería y se quedaría
  // en ese mes sin forma de volver desde Inicio — el mismo fallo que esto viene a quitar.
  const { vistaGenerador } = await import("../permisos.js");
  assert.equal(vistaGenerador({ ...MAYOR, estado: null }).flechas, false);
  assert.equal(vistaGenerador({ ...MAYOR, sinResponsable: true, estado: null }).flechas, true, "ya se sabe que no hay Responsable (meses siguientes)");
  assert.equal(vistaGenerador({ ...RESPONSABLE, estado: null }).flechas, true);
  assert.equal(vistaGenerador({ ...PEQUENO, accesoDesarrollador: true, estado: null }).flechas, true);
  assert.equal(vistaGenerador({ ...RESPONSABLE, estado: null, estadoError: "x" }).flechas, true, "con un fallo también se puede ir a otro mes");
});

test("vistaGenerador: mientras se comprueba conserva la forma de la última vista, sin nada pulsable", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const borrador = vistaGenerador({ ...RESPONSABLE, estado: "BORRADOR", extrasDisponible: true });
  const v = vistaGenerador({ ...RESPONSABLE, estado: null, extrasDisponible: true, anterior: borrador });
  assert.deepEqual(v.fases, ["obligatorias", "extras"], "misma forma: la ráfaga de ◀ no mueve nada");
  assert.equal(v.comprobando, true);
  assert.equal(v.activa, false, "no saber si el mes está publicado no es saber que no lo está");
  const publicado = vistaGenerador({ ...RESPONSABLE, estado: "PUBLICADO" });
  const w = vistaGenerador({ ...RESPONSABLE, estado: null, anterior: publicado });
  assert.deepEqual([w.fases, w.motivo, w.activa], [[], "PUBLICADO", false]);
});

test("vistaGenerador: un fallo al comprobar el estado no es «comprobando»: se dice, con la tarjeta (y las flechas) puestas", async () => {
  const { vistaGenerador } = await import("../permisos.js");
  const v = vistaGenerador({ ...RESPONSABLE, estado: null, estadoError: "sin respuesta del servidor" });
  assert.deepEqual(v, { fases: [], motivo: null, estado: null, comprobando: false, error: "sin respuesta del servidor", activa: false, flechas: true });
  // Tras un fallo Home deja `sinResponsable` en false; un Mayor sigue viendo el error para poder reintentar.
  assert.equal(vistaGenerador({ ...MAYOR, estado: null, estadoError: "x" }).error, "x");
  assert.equal(vistaGenerador({ ...PEQUENO, estado: null, estadoError: "x" }), null);
});

// Tests de client/lib/solicitudes.js — el estado de la tarjeta «Solicitudes de acceso» de Inicio.
// Fija el fallo de producción del 2026-10-07: la tarjeta guardaba `r.solicitudes` sin mirar qué
// era, y con `undefined` el render hacía `.length` y tumbaba el componente.
import test from "node:test";
import assert from "node:assert/strict";
import { ESTADO_INICIAL, recibirSolicitudes, vistaSolicitudes } from "../solicitudes.js";

test("arranca en «cargando», sin lista ni error", () => {
  assert.deepEqual(ESTADO_INICIAL, { fase: "cargando", lista: [], error: null });
  assert.deepEqual(vistaSolicitudes(ESTADO_INICIAL), { mostrar: false, lista: [], error: null });
});

test("una respuesta undefined (o null, o sin `ok`) no revienta: es un error, con la lista como array", () => {
  for (const r of [undefined, null, {}, "x"]) {
    const e = recibirSolicitudes(ESTADO_INICIAL, r);
    assert.equal(e.fase, "error", `respuesta ${JSON.stringify(r)}`);
    assert.ok(Array.isArray(e.lista));
    assert.equal(typeof e.error, "string");
    const v = vistaSolicitudes(e);
    assert.equal(v.mostrar, true, "el error se enseña: si no, quien aprueba no sabe que no está viendo las solicitudes");
    assert.ok(Array.isArray(v.lista));
  }
});

test("ok:true con `solicitudes` undefined (el caso de producción): error explícito, nunca lista undefined", () => {
  const e = recibirSolicitudes(ESTADO_INICIAL, { ok: true, solicitudes: undefined });
  assert.equal(e.fase, "error");
  assert.deepEqual(e.lista, []);
  assert.match(e.error, /solicitudes/);
});

test("ok:false (backend caído, 404, sin permiso): error con el motivo del servidor", () => {
  const e = recibirSolicitudes(ESTADO_INICIAL, { ok: false, error: "el servidor de Google no respondió bien (HTTP 404)" });
  assert.equal(e.fase, "error");
  assert.match(e.error, /HTTP 404/);
});

test("un fallo NO borra la lista que ya se tenía: se sigue pudiendo aprobar lo que se veía", () => {
  const conUna = recibirSolicitudes(ESTADO_INICIAL, { ok: true, solicitudes: [{ id: "s1" }] });
  const tras404 = recibirSolicitudes(conUna, { ok: false, error: "HTTP 404" });
  assert.equal(tras404.fase, "error");
  assert.deepEqual(tras404.lista, [{ id: "s1" }]);
  assert.deepEqual(vistaSolicitudes(tras404).lista, [{ id: "s1" }]);
});

test("respuesta válida vacía: «vacío», y la tarjeta no se pinta (solo aparece cuando hay algo que decidir)", () => {
  const e = recibirSolicitudes(ESTADO_INICIAL, { ok: true, solicitudes: [] });
  assert.deepEqual(e, { fase: "vacio", lista: [], error: null });
  assert.equal(vistaSolicitudes(e).mostrar, false);
});

test("respuesta válida con solicitudes: «lista», se pinta, y un acierto tras un fallo limpia el error", () => {
  const sol = [{ id: "s1", email: "a@b.com", tipo: "INVITADO" }];
  const fallo = recibirSolicitudes(ESTADO_INICIAL, { ok: false, error: "x" });
  const e = recibirSolicitudes(fallo, { ok: true, solicitudes: sol });
  assert.deepEqual(e, { fase: "lista", lista: sol, error: null });
  assert.deepEqual(vistaSolicitudes(e), { mostrar: true, lista: sol, error: null });
});

test("un estado corrupto (undefined) tampoco revienta la vista", () => {
  assert.deepEqual(vistaSolicitudes(undefined), { mostrar: false, lista: [], error: null });
  assert.deepEqual(vistaSolicitudes({ fase: "lista", lista: undefined }), { mostrar: false, lista: [], error: null });
});

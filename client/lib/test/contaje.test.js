// Tests de client/lib/contaje.js — el aviso del volcado al Excel del servicio (V-65).
import test from "node:test";
import assert from "node:assert/strict";
import { avisoContaje, avisoDespublicado } from "../contaje.js";

test("avisoContaje: un servidor anterior a V-65 no manda nada y no se dice nada", () => {
  assert.equal(avisoContaje(undefined), null);
});

test("avisoContaje: éxito nombra el curso y el mes que enseña el Cuadrante Mensual", () => {
  const a = avisoContaje({ ok: true, cursos: [{ curso: "2027-28", mesMostrado: { mes: 7, anio: 2027 }, mesesPublicados: 2 }] });
  assert.equal(a.tipo, "ok");
  assert.match(a.texto, /2027-28 \(Cuadrante Mensual con julio de 2027\)/);
});

test("avisoContaje: «omitido» en las dos formas (publicar y volcarContaje)", () => {
  assert.equal(avisoContaje({ omitido: "no está configurada la propiedad CONTAJE_SPREADSHEET_ID" }).tipo, "omitido");
  const v = avisoContaje({ ok: false, omitido: true, error: "no está configurada la propiedad CONTAJE_SPREADSHEET_ID" });
  assert.equal(v.tipo, "omitido");
  assert.match(v.texto, /CONTAJE_SPREADSHEET_ID/);
});

test("avisoContaje: un fallo tras publicar dice que el cuadrante SÍ está publicado y cómo reintentar", () => {
  const a = avisoContaje({ ok: false, error: "Service Spreadsheets failed" }, { trasPublicar: true });
  assert.equal(a.tipo, "error");
  assert.match(a.texto, /está publicado/);
  assert.match(a.texto, /Volcar al contaje/);
  assert.doesNotMatch(avisoContaje({ ok: false, error: "x" }).texto, /está publicado/);
});

test("avisoContaje: un curso sin meses publicados no es un éxito silencioso", () => {
  assert.equal(avisoContaje({ ok: true, cursos: [] }).tipo, "omitido");
});

test("avisoContaje: sin Excel configurado, publicar no dice nada (la app funciona como antes de V-65)", () => {
  assert.equal(avisoContaje({ omitido: "no está configurada la propiedad CONTAJE_SPREADSHEET_ID", configurado: false }, { trasPublicar: true }), null);
  // Pero un fichero configurado que no se puede abrir sí se avisa.
  assert.equal(avisoContaje({ omitido: "no se puede abrir la hoja de contaje" }, { trasPublicar: true }).tipo, "omitido");
});

test("avisoDespublicado: sin Excel no dice nada; con Excel avisa de que el siguiente volcado quita el mes", () => {
  assert.equal(avisoDespublicado(false), null);
  const a = avisoDespublicado(true);
  assert.equal(a.tipo, "omitido");
  assert.match(a.texto, /siguiente volcado/);
  assert.match(a.texto, /republicarlo/);
});

test("avisoContaje: si el servidor dice cuánto tardó el volcado, se enseña en segundos", () => {
  const a = avisoContaje({ ok: true, ms: 4230, cursos: [{ curso: "2027-28", mesMostrado: { mes: 7, anio: 2027 }, mesesPublicados: 1 }] });
  assert.match(a.texto, /\(4,2 s\)\.$/);
  assert.doesNotMatch(avisoContaje({ ok: true, cursos: [{ curso: "2027-28" }] }).texto, / s\)/);
});

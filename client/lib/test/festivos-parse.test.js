// Tests de client/lib/festivos-parse.js — el pegado en lote de festivos (V-17a).
// Lo que se fija aquí no es cosmético: una línea mal leída mete una fecha equivocada en la tabla
// que INV-12 usa para decidir si una GF es correcta, y no da ningún error visible.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFestivos } from "../festivos-parse.js";

test("una fecha suelta por línea basta", () => {
  const r = parseFestivos("2026-12-25\n2027-01-01");
  assert.deepEqual(r.festivos, [
    { fecha: "2026-12-25", nombre: "", ambito: "" },
    { fecha: "2027-01-01", nombre: "", ambito: "" },
  ]);
  assert.deepEqual(r.errores, []);
});

test("fecha y nombre separados por espacios: el nombre puede llevar espacios", () => {
  const r = parseFestivos("2026-12-25 Navidad\n2026-10-09 Día de la Comunitat");
  assert.deepEqual(r.festivos.map((f) => f.nombre), ["Navidad", "Día de la Comunitat"]);
});

test("campos explícitos con `;` o tabulador, con ámbito", () => {
  const r = parseFestivos("2026-12-25;Navidad;NACIONAL\n2026-06-24\tSan Juan\tLOCAL");
  assert.deepEqual(r.festivos, [
    { fecha: "2026-12-25", nombre: "Navidad", ambito: "NACIONAL" },
    { fecha: "2026-06-24", nombre: "San Juan", ambito: "LOCAL" },
  ]);
});

test("el ámbito no distingue mayúsculas, pero uno inventado se rechaza", () => {
  assert.equal(parseFestivos("2026-12-25;Navidad;nacional").festivos[0].ambito, "NACIONAL");
  const r = parseFestivos("2026-12-25;Navidad;REGIONAL");
  assert.deepEqual(r.festivos, []);
  assert.match(r.errores[0].motivo, /ámbito "REGIONAL" desconocido/);
});

test("se ignoran líneas vacías y comentarios, y el número de línea sigue siendo el real", () => {
  const r = parseFestivos("# festivos 2026\n\n2026-12-25 Navidad\n\n25/12/2026 mal");
  assert.equal(r.festivos.length, 1);
  assert.equal(r.errores[0].linea, 5, "el número tiene que servir para encontrar la línea en el textarea");
});

test("una fecha inválida NO tumba el resto: se separa lo bueno de lo malo", () => {
  const r = parseFestivos("2026-12-25 Navidad\n2026-13-01 Mes catorce\n2027-02-29 No existe\n2027-01-06 Reyes");
  assert.deepEqual(r.festivos.map((f) => f.fecha), ["2026-12-25", "2027-01-06"]);
  assert.equal(r.errores.length, 2);
  assert.match(r.errores[1].motivo, /no es una fecha/); // 29-feb de un año no bisiesto
});

test("formatos laxos que parecen fechas se rechazan (parseISO es estricto)", () => {
  const r = parseFestivos("2026-2-1 Uno\n26-02-01 Dos");
  assert.deepEqual(r.festivos, []);
  assert.equal(r.errores.length, 2);
});

test("una fecha repetida DENTRO del pegado se marca, no se duplica la fila", () => {
  const r = parseFestivos("2026-12-25 Navidad\n2026-12-25 Navidad otra vez");
  assert.equal(r.festivos.length, 1);
  assert.match(r.errores[0].motivo, /ya está cargada/);
});

test("una fecha que YA está en la tabla se marca: la tabla es append-only y no se limpia", () => {
  const r = parseFestivos("2026-12-25 Navidad\n2027-01-01 Año nuevo", ["2026-12-25"]);
  assert.deepEqual(r.festivos.map((f) => f.fecha), ["2027-01-01"]);
  assert.match(r.errores[0].motivo, /ya está cargada/);
});

test("entrada vacía o solo espacios no produce nada ni lanza", () => {
  for (const t of ["", "   \n\n\t", null, undefined]) {
    assert.deepEqual(parseFestivos(t), { festivos: [], errores: [] });
  }
});

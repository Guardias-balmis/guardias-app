// Tests de v2/domain/projection.js (Fase 7.1, spec.md §7, decisión V-11).
// buildMonthSheetRows: filas de la pestaña mensual (código día a día + fórmulas de
// totales LOCALES a la propia fila — COUNTIF/SUMPRODUCT, mismo idioma que el .xlsm legado).
// buildResumenRows: filas de la hoja "Resumen" (SUMIF encadenado cruzando pestañas
// mensuales por nombre + MAXIFS/MINIFS de equidad agrupando por cohorte de ingreso).
import test from "node:test";
import assert from "node:assert/strict";
import { weekday, addDays, datesOfMonth } from "../calendar.js";
import { columnLetter, monthSheetName, buildMonthSheetRows, buildResumenRows } from "../projection.js";

// ── columnLetter ──
test("columnLetter: 1..26 son A..Z", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(26), "Z");
});
test("columnLetter: cruces de doble letra", () => {
  assert.equal(columnLetter(27), "AA");
  assert.equal(columnLetter(40), "AN"); // cruce con el .xlsm legado: I..AM = 31 columnas de día (9..39)
  assert.equal(columnLetter(52), "AZ");
  assert.equal(columnLetter(53), "BA");
});

// ── monthSheetName ──
test("monthSheetName: rellena el mes con cero", () => {
  assert.equal(monthSheetName(2027, 1), "2027-01");
  assert.equal(monthSheetName(2027, 12), "2027-12");
});

// ── buildMonthSheetRows ──
const ANA = { id: "ana", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" }; // R3 en abr-2027
const BETO = { id: "beto", nombre: "Beto", fechaInicio: "2026-05-20", fechaFin: "2030-05-19" }; // R1 en abr-2027
const CARLA = { id: "carla", nombre: "Carla", fechaInicio: "2020-05-20", fechaFin: "2024-05-19" }; // FINALIZADO antes de abr-2027
const DAVID = { id: "david", nombre: "David", fechaInicio: "2027-04-15", fechaFin: "2031-04-14" }; // empieza a mitad de abr-2027
const ELENA = { id: "elena", nombre: "Elena", fechaInicio: "2023-04-20", fechaFin: "2027-04-15" }; // termina la residencia a mitad de abr-2027 (opuesto de DAVID)
const FELISA = { id: "felisa", nombre: "Felisa", fechaInicio: "2024-04-15", fechaFin: "2028-04-14" }; // activa TODO abril-2027, pero su aniversario (R3→R4) cae el día 15

const ANIO = 2027, MES = 4; // abril-2027, 30 días
const DIAS = datesOfMonth(ANIO, MES);
const N = DIAS.length;
const FIRST_COL_IDX = 10; // 9 columnas fijas (Residente..Total) + 1
const lastCol = columnLetter(FIRST_COL_IDX - 1 + N);
const firstCol = columnLetter(FIRST_COL_IDX);

test("buildMonthSheetRows: nombre de pestaña y filas de cabecera (números de día + fila de día de semana)", () => {
  const { sheetName, rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones: [] });
  assert.equal(sheetName, "2027-04");
  assert.deepEqual(rows[0], ["Residente", "Nivel", "G", "GF", "GP", "3P", "Fines de Semana", "Dobl. V-D", "Total", ...DIAS.map((_, i) => i + 1)]);
  assert.deepEqual(rows[1].slice(0, 9), ["", "", "", "", "", "", "", "", ""]);
  assert.deepEqual(rows[1].slice(9), DIAS.map((d) => weekday(d)));
});

test("buildMonthSheetRows: excluye a quien ya ha finalizado y a quien aún no ha empezado", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA, CARLA], asignaciones: [] });
  const nombres = rows.slice(2).map((r) => r[0]);
  assert.deepEqual(nombres, ["Ana"]); // Carla (FINALIZADO en abr-2027) no aparece
});

test("buildMonthSheetRows: un residente que empieza A MITAD del mes se incluye con su nivel real (no PENDIENTE)", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [DAVID], asignaciones: [] });
  assert.equal(rows.length, 3); // cabecera + fila semana + 1 residente
  assert.equal(rows[2][0], "David");
  assert.equal(rows[2][1], "R1"); // nunca "PENDIENTE": el nivel se lee en su primer día activo del mes, no en el día 1
});

test("buildMonthSheetRows: un residente que TERMINA la residencia a mitad de mes sigue apareciendo con su nivel correcto (opuesto de David)", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ELENA], asignaciones: [] });
  assert.equal(rows.length, 3);
  assert.equal(rows[2][0], "Elena");
  assert.equal(rows[2][1], "R4");
});

test("buildMonthSheetRows: LIMITACIÓN CONOCIDA — un residente activo TODO el mes cuyo nivel cambia a mitad (aniversario) muestra el nivel del día 1, no el nuevo", () => {
  // Felisa pasa de R3 a R4 el 15-abr-2027 pero está activa desde el día 1: al haber un
  // único valor de "Nivel" por fila, no se puede mostrar ambos — se elige el del primer
  // día activo del mes (día 1), igual criterio que accumulatedTally (día-1 canónico,
  // spec.md §4/Fase 6.1). Es cosmético: no afecta a ningún invariante ni al contaje real.
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [FELISA], asignaciones: [] });
  assert.equal(rows[2][0], "Felisa");
  assert.equal(rows[2][1], "R3"); // no "R4", aunque sea R4 la segunda mitad del mes
});

test("buildMonthSheetRows: ordena Mayor→Pequeño (nivel desc) y por nombre dentro del mismo nivel", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [BETO, ANA], asignaciones: [] });
  assert.deepEqual(rows.slice(2).map((r) => r[0]), ["Ana", "Beto"]); // Ana=R3 (Mayor) antes que Beto=R1 (Pequeño)
});

test("buildMonthSheetRows: vuelca los códigos día a día (en blanco donde no hay asignación)", () => {
  const asignaciones = [
    { residenteId: "ana", fecha: DIAS[0], codigo: "G" },
    { residenteId: "ana", fecha: DIAS[4], codigo: "GF" },
  ];
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones });
  const codigos = rows[2].slice(9);
  assert.equal(codigos[0], "G");
  assert.equal(codigos[4], "GF");
  assert.equal(codigos[1], ""); // sin asignación ese día
});

test("buildMonthSheetRows: un código vacío explícito (borrado) se vuelca en blanco, no como el string vacío del propio código", () => {
  const asignaciones = [{ residenteId: "ana", fecha: DIAS[0], codigo: "" }];
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones });
  assert.equal(rows[2].slice(9)[0], "");
});

test("buildMonthSheetRows: una guardia CEDIDA/COMPRADA (origen) se marca con \"*\" para que COUNTIF/SUMPRODUCT la excluyan de los totales (igual que tally.js/INV-4)", () => {
  const asignaciones = [
    { residenteId: "ana", fecha: DIAS[0], codigo: "G", origen: "cedida" },
    { residenteId: "ana", fecha: DIAS[1], codigo: "G" }, // sin origen: computable, sin marcar
  ];
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones });
  const codigos = rows[2].slice(9);
  assert.equal(codigos[0], "G*"); // "G*" ≠ "G": COUNTIF(rango,"G") no la cuenta
  assert.equal(codigos[1], "G");
});

test("buildMonthSheetRows: un 3P con origen NO se marca — tally.js cuenta todo 3P como tercerPuesto con independencia del origen", () => {
  const asignaciones = [{ residenteId: "ana", fecha: DIAS[0], codigo: "3P", origen: "comprada" }];
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones });
  assert.equal(rows[2].slice(9)[0], "3P"); // no "3P*": el COUNTIF(rango,"3P") debe seguir contándola
});

test("buildMonthSheetRows: fórmulas COUNTIF/Total sobre el rango de días de la PROPIA fila", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones: [] });
  const r = 3; // Ana es la única fila de residente: fila 3 (tras cabecera+semana)
  const range = `${firstCol}${r}:${lastCol}${r}`;
  assert.equal(rows[2][2], `=COUNTIF(${range},"G")`);
  assert.equal(rows[2][3], `=COUNTIF(${range},"GF")`);
  assert.equal(rows[2][4], `=COUNTIF(${range},"GP")`);
  assert.equal(rows[2][5], `=COUNTIF(${range},"3P")`);
  assert.equal(rows[2][8], `=C${r}+D${r}+E${r}`); // Total = G+GF+GP, mismo patrón que Resumen Anual del .xlsm (O=C+D+M)
});

test("buildMonthSheetRows: fórmula de Fines de Semana referencia la fila 2 (días de semana) fijada con $", () => {
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones: [] });
  const r = 3;
  const range = `${firstCol}${r}:${lastCol}${r}`;
  const wk = `$${firstCol}$2:$${lastCol}$2`;
  assert.equal(rows[2][6], `=SUMPRODUCT(((${wk}="S")+(${wk}="D"))*((${range}="G")+(${range}="GF")+(${range}="GP")))`);
});

test("buildMonthSheetRows: fórmula de Dobletes V-D empareja viernes con domingo (+2 días) dentro del propio mes", () => {
  const viernes = DIAS.find((d) => weekday(d) === "V");
  const domingo = addDays(viernes, 2);
  assert.ok(DIAS.includes(domingo), "fixture inválido: el domingo+2 debe caer dentro del mismo mes");
  const asignaciones = [
    { residenteId: "ana", fecha: viernes, codigo: "G" },
    { residenteId: "ana", fecha: domingo, codigo: "G" },
  ];
  const { rows } = buildMonthSheetRows({ anio: ANIO, mes: MES, residentes: [ANA], asignaciones });
  const r = 3;
  const fridaySideEnd = columnLetter(FIRST_COL_IDX + (N - 2) - 1);
  const sundaySideStart = columnLetter(FIRST_COL_IDX + 2);
  const wk = `$${firstCol}$2:$${fridaySideEnd}$2`;
  const fri = `${firstCol}${r}:${fridaySideEnd}${r}`;
  const sun = `${sundaySideStart}${r}:${lastCol}${r}`;
  const expected = `=SUMPRODUCT((${wk}="V")*((${fri}="G")+(${fri}="GF")+(${fri}="GP"))*((${sun}="G")+(${sun}="GF")+(${sun}="GP")))`;
  assert.equal(rows[2][7], expected);
});

// ── buildResumenRows ──
test("buildResumenRows: sin meses publicados, solo la cabecera", () => {
  const { sheetName, rows } = buildResumenRows({ residentes: [ANA, BETO], publishedMonths: [] });
  assert.equal(sheetName, "Resumen");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Equidad (dif. ≤ 1)"]);
});

test("buildResumenRows: excluye a quien no estuvo activo en NINGÚN mes publicado", () => {
  const { rows } = buildResumenRows({ residentes: [ANA, CARLA], publishedMonths: [{ mes: 4, anio: 2027 }] });
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ["Ana"]);
});

test("buildResumenRows: un mes publicado → cadena SUMIF de un solo término, por columna correcta de la pestaña mensual", () => {
  const { rows } = buildResumenRows({ residentes: [ANA], publishedMonths: [{ mes: 4, anio: 2027 }] });
  const r = 2;
  assert.equal(rows[1][0], "Ana");
  assert.equal(rows[1][1], 2024); // cohorte = año de fechaInicio
  assert.equal(rows[1][2], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$I:$I)`); // Total → columna I (Total) de la pestaña mensual
  assert.equal(rows[1][3], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$G:$G)`); // Fines de Semana → columna G
  assert.equal(rows[1][4], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$D:$D)`); // Festivos → columna D (GF)
  assert.equal(rows[1][5], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$E:$E)`); // Prefestivos → columna E (GP)
  assert.equal(rows[1][6], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$H:$H)`); // Dobletes → columna H
  assert.equal(rows[1][7], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$F:$F)`); // 3P → columna F
});

test("buildResumenRows: varios meses publicados → cadena SUMIF con un término por mes, en orden cronológico", () => {
  const { rows } = buildResumenRows({ residentes: [ANA], publishedMonths: [{ mes: 5, anio: 2027 }, { mes: 4, anio: 2027 }] });
  const r = 2;
  assert.equal(rows[1][2], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$I:$I)+SUMIF('2027-05'!$A:$A,$A${r},'2027-05'!$I:$I)`);
});

test("buildResumenRows: un mes repetido en publishedMonths NO duplica su término en la cadena SUMIF", () => {
  const { rows } = buildResumenRows({ residentes: [ANA], publishedMonths: [{ mes: 4, anio: 2027 }, { mes: 4, anio: 2027 }] });
  const r = 2;
  assert.equal(rows[1][2], `=SUMIF('2027-04'!$A:$A,$A${r},'2027-04'!$I:$I)`); // un solo término, no dos
});

test("buildResumenRows: agrupa la cohorte por AÑO DE INGRESO (no por nivel actual — decisión V-11)", () => {
  const RES_2024 = { id: "r24", nombre: "Zeta", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const RES_2024B = { id: "r24b", nombre: "Yago", fechaInicio: "2024-06-01", fechaFin: "2028-05-31" };
  const { rows } = buildResumenRows({ residentes: [RES_2024, RES_2024B], publishedMonths: [{ mes: 4, anio: 2027 }] });
  // orden: cohorte asc, luego nombre asc dentro de la cohorte
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ["Yago", "Zeta"]);
  assert.equal(rows[1][1], 2024);
  assert.equal(rows[2][1], 2024);
});

test("buildResumenRows: fórmulas de equidad (MAXIFS/MINIFS por cohorte + etiqueta OK/REVISAR)", () => {
  const A = { id: "a", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const B = { id: "b", nombre: "Bea", fechaInicio: "2024-06-01", fechaFin: "2028-05-31" };
  const { rows } = buildResumenRows({ residentes: [A, B], publishedMonths: [{ mes: 4, anio: 2027 }] });
  const lastRow = rows.length;
  for (let i = 2; i <= lastRow; i++) {
    assert.equal(rows[i - 1][8], `=IF($B${i}="","",MAXIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i})-MINIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i}))`);
    assert.equal(rows[i - 1][9], `=IF($B${i}="","",IF(I${i}<=1,"OK","REVISAR"))`);
  }
});

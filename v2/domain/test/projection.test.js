// Tests de v2/domain/projection.js (Fase 7.1, spec.md §7, decisión V-11).
// buildMonthSheetRows: filas de la pestaña mensual (código día a día + fórmulas de
// totales LOCALES a la propia fila — COUNTIF/SUMPRODUCT, mismo idioma que el .xlsm legado).
// buildResumenRows / buildContajeTrimestralRows: las dos hojas agregadas del CURSO académico
// (SUMIF encadenado cruzando pestañas mensuales por nombre + MAXIFS/MINIFS agrupando por cohorte
// de ingreso). Ninguna reproduce el veredicto de INV-3 y ninguna dice que lo haga (decisión V-23).
import test from "node:test";
import assert from "node:assert/strict";
import { weekday, addDays, datesOfMonth } from "../calendar.js";
import { columnLetter, monthSheetName, cursoLabel, buildMonthSheetRows, buildResumenRows, buildContajeTrimestralRows } from "../projection.js";

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
// La ventana es el CURSO académico (decisión V-23) y va en el nombre de la hoja. Abril y mayo de
// 2027 pertenecen al curso 2026-27 (`academicYearOf`: de junio a mayo), así que `curso: 2026`.
const CURSO = 2026;
const resumen = (residentes, publishedMonths, curso = CURSO) => buildResumenRows({ residentes, publishedMonths, curso });
// Filas de residente: sin la cabecera y sin el bloque de nota del final (separador + NOTA_LIMITES).
const filasResidente = (rows) => rows.slice(1).filter((f) => f[0] !== "" && !/^Lectura orientativa/.test(String(f[0])));

test("buildResumenRows: el nombre de la hoja lleva el curso, para que no se pise la del curso anterior", () => {
  assert.equal(resumen([ANA], [{ mes: 4, anio: 2027 }]).sheetName, "Resumen 2026-27");
  assert.equal(resumen([ANA], [{ mes: 7, anio: 2027 }], 2027).sheetName, "Resumen 2027-28");
});

test("buildResumenRows: sin meses publicados, la cabecera y la nota de límites", () => {
  const { rows } = resumen([ANA, BETO], []);
  assert.deepEqual(rows[0], ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Reparto del curso (orientativo)"]);
  assert.equal(filasResidente(rows).length, 0);
  // La nota va en la hoja, no solo en un comentario del código: el Sheet lo lee gente que no abre
  // el repo, y «Dif. máx-mín» invita a leerse como el «dif ≤ 1» de la normativa.
  assert.ok(rows.some((f) => /no es la comprobación de INV-3/.test(String(f[0]))));
});

test("buildResumenRows: la cabecera ya NO invoca el umbral de INV-3 (V-23)", () => {
  // El cartel decía «Equidad (dif. ≤ 1)» y era falso en las dos direcciones: la ventana de INV-3 es
  // el año de residencia de cada uno (cuatro cierres con dif=1 acumulan 4 de por vida) y los dos
  // cierres normalizan por disponibilidad, que no es expresable en fórmula de hoja.
  const { rows } = resumen([ANA], [{ mes: 4, anio: 2027 }]);
  assert.ok(!rows[0].some((c) => /dif\. ≤ 1|Equidad/i.test(String(c))), `cabecera: ${JSON.stringify(rows[0])}`);
});

test("buildResumenRows: solo cuenta los meses DEL CURSO, no los de otros cursos", () => {
  // junio-2027 abre el curso siguiente: no puede colarse en el Resumen del 2026-27.
  const { rows } = resumen([ANA], [{ mes: 4, anio: 2027 }, { mes: 6, anio: 2027 }]);
  assert.match(filasResidente(rows)[0][2], /'2027-04'!/);
  assert.doesNotMatch(filasResidente(rows)[0][2], /'2027-06'!/);
});

test("buildResumenRows: excluye a quien no estuvo activo en NINGÚN mes publicado", () => {
  const { rows } = resumen([ANA, CARLA], [{ mes: 4, anio: 2027 }]);
  assert.deepEqual(filasResidente(rows).map((r) => r[0]), ["Ana"]);
});

test("buildResumenRows: un mes publicado → cadena SUMIF de un solo término, por columna correcta de la pestaña mensual", () => {
  const { rows } = resumen([ANA], [{ mes: 4, anio: 2027 }]);
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
  const { rows } = resumen([ANA], [{ mes: 5, anio: 2027 }, { mes: 4, anio: 2027 }]);
  assert.equal(rows[1][2], `=SUMIF('2027-04'!$A:$A,$A2,'2027-04'!$I:$I)+SUMIF('2027-05'!$A:$A,$A2,'2027-05'!$I:$I)`);
});

test("buildResumenRows: la cadena SUMIF no puede pasar de 12 términos, porque el curso tiene 12 meses", () => {
  // Es la razón práctica de acotar la ventana (V-23): de por vida crecía un término por mes
  // publicado y por celda, ~10.800 SUMIF de columna completa por recálculo a los diez años.
  const doceMeses = [6, 7, 8, 9, 10, 11].map((mes) => ({ mes, anio: 2026 }))
    .concat([1, 2, 3, 4, 5].map((mes) => ({ mes, anio: 2027 })), [{ mes: 12, anio: 2026 }]);
  const { rows } = resumen([ANA], doceMeses);
  assert.equal(rows[1][2].split("+").length, 12);
});

test("buildResumenRows: un mes repetido en publishedMonths NO duplica su término en la cadena SUMIF", () => {
  const { rows } = resumen([ANA], [{ mes: 4, anio: 2027 }, { mes: 4, anio: 2027 }]);
  assert.equal(rows[1][2], `=SUMIF('2027-04'!$A:$A,$A2,'2027-04'!$I:$I)`); // un solo término, no dos
});

test("buildResumenRows: agrupa la cohorte por AÑO DE INGRESO (no por nivel actual — decisión V-11)", () => {
  const RES_2024 = { id: "r24", nombre: "Zeta", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const RES_2024B = { id: "r24b", nombre: "Yago", fechaInicio: "2024-06-01", fechaFin: "2028-05-31" };
  const { rows } = resumen([RES_2024, RES_2024B], [{ mes: 4, anio: 2027 }]);
  // orden: cohorte asc, luego nombre asc dentro de la cohorte
  assert.deepEqual(filasResidente(rows).map((r) => r[0]), ["Yago", "Zeta"]);
  assert.equal(rows[1][1], 2024);
  assert.equal(rows[2][1], 2024);
});

test("buildResumenRows: dif máx-mín por cohorte, y la lectura ya no dice OK/REVISAR sobre «dif ≤ 1»", () => {
  const A = { id: "a", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const B = { id: "b", nombre: "Bea", fechaInicio: "2024-06-01", fechaFin: "2028-05-31" };
  const { rows } = resumen([A, B], [{ mes: 4, anio: 2027 }]);
  const ultimaFilaResidente = 1 + filasResidente(rows).length; // 1-based, sin contar el bloque de nota
  assert.equal(ultimaFilaResidente, 3);
  for (let i = 2; i <= ultimaFilaResidente; i++) {
    assert.equal(rows[i - 1][8], `=IF($B${i}="","",MAXIFS($C$2:$C$${ultimaFilaResidente},$B$2:$B$${ultimaFilaResidente},$B${i})-MINIFS($C$2:$C$${ultimaFilaResidente},$B$2:$B$${ultimaFilaResidente},$B${i}))`);
    assert.equal(rows[i - 1][9], `=IF($B${i}="","",IF(I${i}<=1,"equilibrado","desigual: mirar en la app"))`);
    assert.doesNotMatch(rows[i - 1][9], /REVISAR/);
  }
});

// ── buildContajeTrimestralRows (Fase 7.2) ──
// La pieza que faltaba del entregable: el Responsable tiene que comunicar el contaje a tutoría al
// cerrar cada trimestre y no había nada que enseñar fuera de la app.
const contaje = (residentes, publishedMonths, curso = CURSO) => buildContajeTrimestralRows({ residentes, publishedMonths, curso });

test("buildContajeTrimestralRows: cabecera con los cuatro trimestres del contaje y el curso en el nombre", () => {
  const { sheetName, rows } = contaje([ANA], [{ mes: 4, anio: 2027 }]);
  assert.equal(sheetName, "Contaje Trimestral 2026-27");
  assert.deepEqual(rows[0].slice(0, 6), ["Residente", "Cohorte", "T1 jun-ago", "T2 sep-nov", "T3 dic-feb", "T4 mar-may"]);
});

test("buildContajeTrimestralRows: cada mes cae en su trimestre POR MES, nunca por posición", () => {
  // Trocear por rangos fijos de fila es el «bug de trimestres posicionales» que ADR-001 manda
  // eliminar: al insertar un residente el .xlsm se desalineaba en silencio.
  const meses = [{ mes: 7, anio: 2026 }, { mes: 10, anio: 2026 }, { mes: 1, anio: 2027 }, { mes: 4, anio: 2027 }];
  const { rows } = contaje([ANA], meses);
  assert.match(rows[1][2], /'2026-07'!/); // T1 jun-ago
  assert.match(rows[1][3], /'2026-10'!/); // T2 sep-nov
  assert.match(rows[1][4], /'2027-01'!/); // T3 dic-feb
  assert.match(rows[1][5], /'2027-04'!/); // T4 mar-may
});

test("buildContajeTrimestralRows: T3 cruza el año natural (dic del año anterior + ene/feb)", () => {
  // Agrupar por año de calendario partiría T3 en dos: diciembre es 2026 y febrero 2027, y los tres
  // meses son el MISMO trimestre del curso 2026-27.
  const { rows } = contaje([ANA], [{ mes: 12, anio: 2026 }, { mes: 2, anio: 2027 }]);
  assert.match(rows[1][4], /'2026-12'!/);
  assert.match(rows[1][4], /'2027-02'!/);
  assert.equal(rows[1][2], 0, "T1 sin meses publicados suma 0, no una fórmula vacía");
});

test("buildContajeTrimestralRows: solo el TOTAL, que es el único eje del cierre trimestral (V-13/P-8)", () => {
  // El .xlsm mostraba la carga anual agrupada por nivel. Enseñar una cifra distinta de la que juzga
  // el invariante es la trampa que V-11(c) ya evitó en el Resumen.
  const { rows } = contaje([ANA], [{ mes: 4, anio: 2027 }]);
  assert.equal(rows[1][5], `=SUMIF('2027-04'!$A:$A,$A2,'2027-04'!$I:$I)`); // columna I = Total (G+GF+GP)
  assert.equal(rows[0].length, 6, "ni findes, ni festivos, ni dobletes: el cierre trimestral solo compara el total");
});

test("buildContajeTrimestralRows: un bloque de dif máx-mín por cohorte, que es como compara INV-3", () => {
  const A = { id: "a", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const B = { id: "b", nombre: "Bea", fechaInicio: "2024-06-01", fechaFin: "2028-05-31" };
  const C = { id: "c", nombre: "Cira", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };
  const { rows } = contaje([A, B, C], [{ mes: 4, anio: 2027 }]);
  const cabecera = rows.findIndex((f) => f[0] === "Dif. máx-mín por cohorte");
  assert.ok(cabecera > 0, `debe haber bloque de dif: ${JSON.stringify(rows.map((f) => f[0]))}`);
  const cohortes = rows.slice(cabecera + 1).filter((f) => /^Cohorte /.test(String(f[0])));
  // Cira está sola en la 2025: su MAXIFS-MINIFS valdría 0 por definición y una fila permanente a 0
  // se lee como «equilibrado» cuando no hay con quién comparar. INV-3 tampoco compara ahí.
  assert.deepEqual(cohortes.map((f) => f[0]), ["Cohorte 2024"]);
  // La fórmula compara dentro de la cohorte (columna B) y sobre el rango de filas de RESIDENTE
  // (2..4), no sobre el bloque de dif — si el rango se colara a sí mismo, la dif se realimentaría.
  // «Cohorte 2024» es la fila 7: 1 cabecera + 3 residentes + separador + cabecera del bloque.
  assert.equal(cohortes[0][2], "=MAXIFS($C$2:$C$4,$B$2:$B$4,$B7)-MINIFS($C$2:$C$4,$B$2:$B$4,$B7)");
});

test("buildContajeTrimestralRows: sin ninguna cohorte de 2+ miembros no hay bloque de dif", () => {
  const A = { id: "a", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const C = { id: "c", nombre: "Cira", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };
  const { rows } = contaje([A, C], [{ mes: 4, anio: 2027 }]);
  assert.equal(rows.filter((f) => f[0] === "Dif. máx-mín por cohorte").length, 0);
  assert.equal(rows.filter((f) => /^Cohorte /.test(String(f[0]))).length, 0);
  // pero las filas de residente y la nota siguen ahí
  assert.deepEqual(rows.slice(1, 3).map((f) => f[0]), ["Ana", "Cira"]);
  assert.ok(rows.some((f) => /no es la comprobación de INV-3/.test(String(f[0]))));
});

test("buildContajeTrimestralRows: sin meses del curso no inventa filas, pero deja la nota", () => {
  const { rows } = contaje([ANA], [{ mes: 6, anio: 2027 }]); // junio-2027 es del curso siguiente
  assert.equal(rows.filter((f) => f[0] === "Ana").length, 0);
  assert.ok(rows.some((f) => /no es la comprobación de INV-3/.test(String(f[0]))));
});

// ── Rectangularidad: contrato con `setValues` de Apps Script ──
test("las TRES hojas devuelven una matriz RECTANGULAR (setValues lanza si no lo es)", () => {
  // `Code.gs` escribe con getRange(1,1,rows.length,rows[0].length).setValues(rows), y setValues
  // exige que todas las filas tengan el mismo ancho. Ningún otro test lo vería: el `ss` de los
  // fakes es un array de arrays sin límites — la misma ceguera que dejó pasar el fallo de la
  // rejilla de 26 columnas hasta probarlo en vivo. Las filas de nota y de separación son
  // justamente las que lo rompen.
  const A = { id: "a", nombre: "Ana", fechaInicio: "2024-05-20", fechaFin: "2028-05-19" };
  const B = { id: "b", nombre: "Bea", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" };
  const meses = [{ mes: 4, anio: 2027 }, { mes: 12, anio: 2026 }];
  const hojas = [
    buildMonthSheetRows({ anio: 2027, mes: 4, residentes: [A, B], asignaciones: [{ residenteId: "a", fecha: "2027-04-03", codigo: "G" }] }),
    resumen([A, B], meses),
    contaje([A, B], meses),
  ];
  for (const { sheetName, rows } of hojas) {
    const anchos = [...new Set(rows.map((f) => f.length))];
    assert.equal(anchos.length, 1, `${sheetName}: filas de anchos distintos ${JSON.stringify(anchos)}`);
    assert.ok(anchos[0] > 0, `${sheetName}: ancho 0`);
  }
});

test("cursoLabel: etiqueta legible y ordenable del curso académico", () => {
  assert.equal(cursoLabel(2026), "2026-27");
  assert.equal(cursoLabel(2099), "2099-00"); // cruce de siglo: dos dígitos con cero a la izquierda
});

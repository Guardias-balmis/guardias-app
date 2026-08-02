// Proyección del cuadrante a Google Sheets legible por humanos (spec.md §7, Fase 7.1,
// decisión V-11). PURO: construye filas de celdas (algunas con fórmulas de hoja de cálculo
// como texto); la escritura real (`store.rebuildSheet`) vive en server/src/router.js.
//
// Dos entregables:
//  - `buildMonthSheetRows`: 1 pestaña por mes ("YYYY-MM"), con los códigos día a día como
//    VALORES (instantánea del momento de publicar) y los totales por fila como FÓRMULAS
//    (COUNTIF/SUMPRODUCT) que solo miran el rango de días de esa misma pestaña — igual
//    idioma que "Cuadrante Anual" del .xlsm legado, adaptado de "un bloque por mes en la
//    misma hoja" a "una pestaña por mes". El doblete V-D solo puede emparejar un viernes
//    con un domingo DENTRO del propio mes (nunca ve la pestaña del mes siguiente): la misma
//    limitación que ya tenía el .xlsm, documentada y aceptada en spec.md §4 (S-5) — el
//    dominio (`tally`) sí ve ese doblete de borde; esta proyección, deliberadamente, no.
//  - `buildResumenRows`: hoja "Resumen YYYY-YY", una fila por residente activo en el CURSO
//    académico (jun–may), con SUMIF encadenado cruzando las pestañas mensuales publicadas de
//    ese curso y la diferencia máx-mín agrupada por COHORTE de ingreso — mismo criterio de
//    agrupación que INV-3/V-2, no por nivel actual como hacía el Excel viejo.
//  - `buildContajeTrimestralRows`: hoja "Contaje Trimestral YYYY-YY", el total por residente
//    y trimestre del contaje (T1 jun-ago … T4 mar-may) más la diferencia máx-mín por cohorte
//    en cada trimestre. Es lo que el Responsable comunica a tutoría al cerrar el trimestre.
//
// LA VENTANA ES EL CURSO ACADÉMICO (decisión V-23), y las dos hojas la llevan en el NOMBRE
// para que la del curso pasado no se sobreescriba — es lo que hacía el .xlsm recreándose cada
// año, y encima acota la cadena SUMIF a ≤12 términos por celda en vez de crecer sin techo (a
// diez años eran ~10.800 SUMIF de columna completa por recálculo).
//
// NINGUNA de las dos hojas puede reproducir el veredicto de INV-3, y por eso ninguna dice
// "dif ≤ 1" ni habla de equidad: son una LECTURA, no una validación (ver `NOTA_LIMITES`). Las
// diferencias son estructurales, no de precisión, y están medidas:
//  - la ventana de INV-3 anual es el AÑO DE RESIDENCIA de cada residente, que arranca en su
//    aniversario y no en junio; cuatro cierres anuales con dif=1 —los cuatro OK para INV-3—
//    acumulan una dif de por vida de 4;
//  - los dos cierres de INV-3 NORMALIZAN por disponibilidad (descuentan la baja médica), y eso
//    no es expresable en una fórmula de hoja: con una baja de 6 meses INV-3 calla y un
//    MAXIFS/MINIFS sobre totales brutos marcaría una diferencia de 25;
//  - la hoja solo ve meses PUBLICADOS, así que un trimestre está incompleto hasta que se
//    publica su tercer mes.
//
// Limitaciones conocidas y aceptadas (puerta de consistencia, revisión de 4 agentes):
//  - El SUMIF de "Resumen" cruza por NOMBRE de residente (columna A de cada pestaña
//    mensual), no por id: dos residentes con el mismo nombre exacto activos el mismo mes
//    mezclarían sus totales. Mismo riesgo que ya tenía el .xlsm legado (también por nombre);
//    no se resuelve aquí (exigiría una columna de id oculta + INDEX/MATCH).
//  - "Nivel" es un único valor por fila: un residente activo TODO el mes pero cuyo
//    aniversario cae A MITAD del mes (cambia de nivel) muestra el nivel de su PRIMER día
//    activo del mes (normalmente el día 1), no el nuevo — mismo criterio "día-1 canónico"
//    que `accumulatedTally` (spec.md §4, Fase 6.1). Cosmético: no alimenta INV-3 ni ningún
//    contaje real, que siguen mirando la fecha exacta vía `tally`/`levelOn` en el dominio.

import { datesOfMonth, weekday, addDays, addYears, academicYearOf, trimesterOf, toISO } from "./calendar.js";
import { defaultTrainingPeriods, levelOn, isActiveOn } from "./residents.js";

const GUARDIA_CODES = new Set(["G", "GF", "GP"]);

const FIXED_HEADERS = ["Residente", "Nivel", "G", "GF", "GP", "3P", "Fines de Semana", "Dobl. V-D", "Total"];
const LEVEL_RANK = { R4: 4, R3: 3, R2: 2, R1: 1 };
// «Dif. máx-mín (cohorte)» es un HECHO y se queda. La segunda columna era «Equidad (dif. ≤ 1)»,
// que invocaba el umbral de INV-3 sobre una ventana y unos totales que no son los suyos (ver la
// cabecera del fichero): ahora dice de qué curso habla y que es orientativo, decisión V-23.
const RESUMEN_HEADER = ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Reparto del curso (orientativo)"];
const TRIMESTRES_ORDEN = [
  { clave: "T1", etiqueta: "T1 jun-ago" },
  { clave: "T2", etiqueta: "T2 sep-nov" },
  { clave: "T3", etiqueta: "T3 dic-feb" },
  { clave: "T4", etiqueta: "T4 mar-may" },
];
const CONTAJE_HEADER = ["Residente", "Cohorte", ...TRIMESTRES_ORDEN.map((t) => t.etiqueta)];

// La nota va DENTRO de la hoja, no solo en este comentario: el Sheet es el entregable y lo lee
// gente que no abre el repo. Sin ella, «Dif. máx-mín» invita a leerse como el «dif ≤ 1» de la
// normativa, que es justo lo que estas hojas no pueden comprobar.
const NOTA_LIMITES = "Lectura orientativa, no es la comprobación de INV-3: solo cuenta meses ya PUBLICADOS de este curso (un trimestre está incompleto hasta publicar su tercer mes), no descuenta bajas médicas (el validador de la app sí lo hace) y la equidad de la normativa se cierra por año de residencia de cada uno, que empieza en su aniversario y no en junio.";

/** Etiqueta del curso académico: 2026 → "2026-27". Ordena bien y no colisiona entre cursos. */
export function cursoLabel(curso) {
  return `${curso}-${String((curso + 1) % 100).padStart(2, "0")}`;
}

/**
 * Rellena todas las filas hasta el ancho de la más ancha, con "".
 *
 * OBLIGATORIO en todo lo que devuelva este módulo: `Code.gs` escribe con
 * `getRange(1,1,rows.length,rows[0].length).setValues(rows)`, y `setValues` exige una matriz
 * RECTANGULAR — una fila más corta lanza «The number of columns in the data does not match». Una
 * fila de nota o de separación es lo primero que rompe eso, y ningún test lo vería: el `ss` de los
 * fakes es un array de arrays sin límites (la misma ceguera que dejó pasar el fallo de la rejilla
 * de 26 columnas hasta que se probó en vivo).
 */
function rectangular(rows) {
  const ancho = rows.reduce((max, f) => Math.max(max, f.length), 0);
  return rows.map((f) => (f.length === ancho ? f : [...f, ...Array(ancho - f.length).fill("")]));
}

/** Los meses publicados que caen en el curso académico dado, ordenados cronológicamente. */
function monthsOfCurso(publishedMonths, curso) {
  return [...new Map(publishedMonths.map((m) => [monthSheetName(m.anio, m.mes), m])).values()]
    .filter((m) => academicYearOf(toISO(m.anio, m.mes, 1)) === curso)
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
}

/** Nombre de pestaña mensual: "YYYY-MM" (ordena bien alfabéticamente, sin acentos ni espacios). */
export function monthSheetName(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/** Letra(s) de columna de hoja de cálculo para un índice 1-based (1→A, 26→Z, 27→AA...). */
export function columnLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Mismo fallback de fechaFin que accumulate.js/validate.js (deuda preexistente conocida,
// spec.md §6 retro Fase 6.1: duplicado en 7 sitios; no se consolida aquí, fuera de alcance).
function periodsOf(residente) {
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/** Residentes activos (R1-R4) en alguna de `dates`, con su primer día activo dentro de ese conjunto. */
function activeResidents(residentes, dates) {
  return residentes
    .map((r) => ({ ...r, periods: periodsOf(r) }))
    .map((r) => ({ ...r, firstActiveDate: dates.find((d) => isActiveOn(r.periods, d)) }))
    .filter((r) => r.firstActiveDate !== undefined);
}

function finesDeSemanaFormula(rowNum, firstCol, lastCol) {
  const wk = `$${firstCol}$2:$${lastCol}$2`;
  const dia = `${firstCol}${rowNum}:${lastCol}${rowNum}`;
  return `=SUMPRODUCT(((${wk}="S")+(${wk}="D"))*((${dia}="G")+(${dia}="GF")+(${dia}="GP")))`;
}

// Empareja el día `i` con el día `i+2` (viernes→domingo) DENTRO del propio mes: el lado
// "viernes" recorre los días 1..(n-2) y el lado "domingo" 3..n, ambos de igual longitud y
// alineados posicionalmente — mismo idioma que el .xlsm legado ($I$5:$AK$5 vs $K6:$AM6).
function dobleteFormula(rowNum, firstColIdx, n) {
  if (n <= 2) return "=0"; // ningún mes real tiene ≤2 días; defensivo, no alcanzable en la práctica
  const friStart = columnLetter(firstColIdx);
  const friEnd = columnLetter(firstColIdx + (n - 2) - 1);
  const sunStart = columnLetter(firstColIdx + 2);
  const sunEnd = columnLetter(firstColIdx + n - 1);
  const wk = `$${friStart}$2:$${friEnd}$2`;
  const fri = `${friStart}${rowNum}:${friEnd}${rowNum}`;
  const sun = `${sunStart}${rowNum}:${sunEnd}${rowNum}`;
  return `=SUMPRODUCT((${wk}="V")*((${fri}="G")+(${fri}="GF")+(${fri}="GP"))*((${sun}="G")+(${sun}="GF")+(${sun}="GP")))`;
}

/**
 * Filas de la pestaña mensual (spec.md §7).
 * @param {object} p { anio, mes, residentes:{id,nombre,fechaInicio,fechaFin}[], asignaciones:{residenteId,fecha,codigo,origen?}[] del propio mes }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
export function buildMonthSheetRows({ anio, mes, residentes, asignaciones }) {
  const dias = datesOfMonth(anio, mes);
  const n = dias.length;
  const firstColIdx = FIXED_HEADERS.length + 1;
  const firstCol = columnLetter(firstColIdx);
  const lastCol = columnLetter(firstColIdx - 1 + n);

  const activos = activeResidents(residentes, dias)
    .map((r) => ({ id: r.id, nombre: r.nombre, nivel: levelOn(r.periods, r.firstActiveDate) }))
    .sort((a, b) => LEVEL_RANK[b.nivel] - LEVEL_RANK[a.nivel] || a.nombre.localeCompare(b.nombre));

  // Una cedida/comprada (`origen`) NO computa (tally.js `isComputable`/INV-4): se marca con
  // "*" para que COUNTIF/SUMPRODUCT (que comparan texto exacto) la excluyan sin cambiar las
  // fórmulas. El 3P NUNCA se marca: tally.js lo cuenta como tercerPuesto con independencia
  // del origen (el chequeo de origen en tally.js ocurre DESPUÉS del chequeo de "3P").
  const porResidenteDia = new Map();
  for (const a of asignaciones) {
    if (!porResidenteDia.has(a.residenteId)) porResidenteDia.set(a.residenteId, new Map());
    const marcado = a.origen && GUARDIA_CODES.has(a.codigo) ? `${a.codigo}*` : (a.codigo || "");
    porResidenteDia.get(a.residenteId).set(a.fecha, marcado);
  }

  const rows = [
    [...FIXED_HEADERS, ...dias.map((_, i) => i + 1)],
    [...FIXED_HEADERS.map(() => ""), ...dias.map((d) => weekday(d))],
  ];
  for (const r of activos) {
    const rowNum = rows.length + 1;
    const codigos = dias.map((d) => (porResidenteDia.get(r.id) || new Map()).get(d) || "");
    rows.push([
      r.nombre, r.nivel,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"G")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"GF")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"GP")`,
      `=COUNTIF(${firstCol}${rowNum}:${lastCol}${rowNum},"3P")`,
      finesDeSemanaFormula(rowNum, firstCol, lastCol),
      dobleteFormula(rowNum, firstColIdx, n),
      `=C${rowNum}+D${rowNum}+E${rowNum}`,
      ...codigos,
    ]);
  }
  return { sheetName: monthSheetName(anio, mes), rows: rectangular(rows) };
}

function sumifChain(mesesOrdenados, rowNum, col) {
  if (mesesOrdenados.length === 0) return 0;
  const terms = mesesOrdenados.map((m) => {
    const hoja = monthSheetName(m.anio, m.mes);
    return `SUMIF('${hoja}'!$A:$A,$A${rowNum},'${hoja}'!$${col}:$${col})`;
  });
  return `=${terms.join("+")}`;
}

/** Residentes activos en alguno de esos meses, con su cohorte, ordenados por cohorte y nombre. */
function activosDeLosMeses(residentes, meses) {
  const fechas = meses.flatMap((m) => datesOfMonth(m.anio, m.mes));
  return activeResidents(residentes, fechas)
    .map((r) => ({ nombre: r.nombre, cohorte: Number(r.fechaInicio.slice(0, 4)) }))
    .sort((a, b) => a.cohorte - b.cohorte || a.nombre.localeCompare(b.nombre));
}

/** MAXIFS-MINIFS de `col` entre las filas de la MISMA cohorte (columna B), para la fila `i`. */
function difCohorteFormula(col, i, lastRow) {
  const rango = `$${col}$2:$${col}$${lastRow}`;
  const cohortes = `$B$2:$B$${lastRow}`;
  return `=IF($B${i}="","",MAXIFS(${rango},${cohortes},$B${i})-MINIFS(${rango},${cohortes},$B${i}))`;
}

/**
 * Filas de la hoja "Resumen YYYY-YY" (spec.md §7): carga por residente en el CURSO académico,
 * agregando por SUMIF sobre las pestañas mensuales publicadas de ese curso, con la diferencia
 * máx-mín por cohorte de ingreso.
 *
 * La ventana es el curso (decisión V-23) y va en el nombre de la hoja: sin eso, republicar un mes
 * de otro curso sobreescribiría la hoja del anterior. NO reproduce el veredicto de INV-3 y no lo
 * pretende — ver la cabecera del fichero y `NOTA_LIMITES`, que se escribe en la propia hoja.
 *
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[], curso:number }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
export function buildResumenRows({ residentes, publishedMonths, curso }) {
  const meses = monthsOfCurso(publishedMonths, curso);
  const rows = [RESUMEN_HEADER];
  for (const r of activosDeLosMeses(residentes, meses)) {
    const rowNum = rows.length + 1;
    rows.push([
      r.nombre, r.cohorte,
      sumifChain(meses, rowNum, "I"), // Total
      sumifChain(meses, rowNum, "G"), // Fines de Semana
      sumifChain(meses, rowNum, "D"), // Festivos (columna GF de la pestaña mensual)
      sumifChain(meses, rowNum, "E"), // Prefestivos (columna GP)
      sumifChain(meses, rowNum, "H"), // Dobletes V-D
      sumifChain(meses, rowNum, "F"), // 3P
      "", "", // dif y lectura: se rellenan abajo, una vez se conoce el rango completo de filas
    ]);
  }

  // El umbral no se deja como celda editable (a diferencia del Excel viejo) porque el validador
  // real de la app NO lo lee de aquí: un umbral editable en el Sheet que no afecta a INV-3 sería
  // engañoso. Y el veredicto ya no dice "OK/REVISAR" sobre "dif ≤ 1", que era invocar el umbral de
  // INV-3 sobre una ventana y unos totales que no son los suyos (V-23).
  const lastRow = rows.length;
  for (let i = 2; i <= lastRow; i++) {
    rows[i - 1][8] = difCohorteFormula("C", i, lastRow);
    rows[i - 1][9] = `=IF($B${i}="","",IF(I${i}<=1,"equilibrado","desigual: mirar en la app"))`;
  }
  rows.push([], [NOTA_LIMITES]);
  return { sheetName: `Resumen ${cursoLabel(curso)}`, rows: rectangular(rows) };
}

/**
 * Filas de la hoja "Contaje Trimestral YYYY-YY" (spec.md §7, Fase 7.2): el total por residente en
 * cada trimestre del contaje, más la diferencia máx-mín por cohorte en cada uno. Es lo que el
 * Responsable tiene que comunicar a tutoría al cerrar cada trimestre y hasta ahora no existía
 * fuera de la app.
 *
 * Los trimestres se agrupan por MES (`trimesterOf`), nunca por posición de fila: trocear por
 * rangos fijos es el «bug de trimestres posicionales» que el .xlsm tenía y que ADR-001 manda
 * eliminar — al insertar un residente se desalineaba en silencio. Y T3 (dic-feb) cruza el año
 * natural, así que agrupar por año de calendario tampoco valdría.
 *
 * Muestra los ejes de INV-3 TRIMESTRAL (solo el total, decisión V-13/P-8), no la carga anual por
 * nivel del .xlsm: enseñar una cifra distinta de la que juzga el invariante es la trampa que
 * V-11(c) ya evitó en el Resumen.
 *
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[], curso:number }
 * @returns {{sheetName:string, rows:Array<Array<string|number>>}}
 */
export function buildContajeTrimestralRows({ residentes, publishedMonths, curso }) {
  const meses = monthsOfCurso(publishedMonths, curso);
  const porTrimestre = TRIMESTRES_ORDEN.map((t) => meses.filter((m) => trimesterOf(toISO(m.anio, m.mes, 1)) === t.clave));

  const rows = [CONTAJE_HEADER];
  for (const r of activosDeLosMeses(residentes, meses)) {
    const rowNum = rows.length + 1;
    // Columna I de la pestaña mensual = Total (G+GF+GP), el único eje del cierre trimestral.
    rows.push([r.nombre, r.cohorte, ...porTrimestre.map((ms) => sumifChain(ms, rowNum, "I"))]);
  }

  const lastRow = rows.length;
  if (lastRow > 1) {
    // Una fila por cohorte, que es la comparación que hace INV-3 (dentro de la promoción). Las de
    // UN SOLO miembro se omiten: su MAXIFS-MINIFS vale 0 por definición y una fila permanente a 0
    // se lee como «equilibrado» cuando en realidad no hay con quién comparar. INV-3 tampoco compara
    // ahí (es el mismo criterio del aviso de C-3: solo cuando alguna cohorte tiene ≥2 miembros).
    const porCohorte = new Map();
    for (const f of rows.slice(1, lastRow)) porCohorte.set(f[1], (porCohorte.get(f[1]) || 0) + 1);
    const cohortes = [...porCohorte.keys()].filter((c) => porCohorte.get(c) >= 2).sort();
    if (cohortes.length === 0) return { sheetName: `Contaje Trimestral ${cursoLabel(curso)}`, rows: rectangular([...rows, [], [NOTA_LIMITES]]) };

    rows.push([]);
    rows.push(["Dif. máx-mín por cohorte", "", ...TRIMESTRES_ORDEN.map(() => "")]);
    for (const c of cohortes) {
      const fila = [`Cohorte ${c}`, c];
      for (let t = 0; t < TRIMESTRES_ORDEN.length; t++) {
        const col = columnLetter(3 + t); // C, D, E, F
        fila.push(`=MAXIFS($${col}$2:$${col}$${lastRow},$B$2:$B$${lastRow},$B${rows.length + 1})-MINIFS($${col}$2:$${col}$${lastRow},$B$2:$B$${lastRow},$B${rows.length + 1})`);
      }
      rows.push(fila);
    }
  }
  rows.push([], [NOTA_LIMITES]);
  return { sheetName: `Contaje Trimestral ${cursoLabel(curso)}`, rows: rectangular(rows) };
}

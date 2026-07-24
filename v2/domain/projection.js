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
//  - `buildResumenRows`: hoja "Resumen", una fila por residente activo en algún mes
//    publicado, con SUMIF encadenado cruzando TODAS las pestañas mensuales publicadas (por
//    nombre de hoja) y la comprobación de equidad (MAXIFS/MINIFS) agrupada por COHORTE de
//    ingreso — mismo criterio que INV-3/V-2, no por nivel actual como hacía el Excel viejo.
//    Alcance provisional: acumula TODOS los meses publicados desde siempre, no por año
//    académico como el .xlsm (que se recreaba cada año) — simplificación consciente,
//    revisar si con varios años de datos reales deja de ser una lectura útil.
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

import { datesOfMonth, weekday, addDays, addYears } from "./calendar.js";
import { defaultTrainingPeriods, levelOn, isActiveOn } from "./residents.js";

const GUARDIA_CODES = new Set(["G", "GF", "GP"]);

const FIXED_HEADERS = ["Residente", "Nivel", "G", "GF", "GP", "3P", "Fines de Semana", "Dobl. V-D", "Total"];
const LEVEL_RANK = { R4: 4, R3: 3, R2: 2, R1: 1 };
const RESUMEN_HEADER = ["Residente", "Cohorte", "Total", "Fines de Semana", "Festivos", "Prefestivos", "Dobletes V-D", "3P", "Dif. máx-mín (cohorte)", "Equidad (dif. ≤ 1)"];

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
  return { sheetName: monthSheetName(anio, mes), rows };
}

function sumifChain(mesesOrdenados, rowNum, col) {
  if (mesesOrdenados.length === 0) return 0;
  const terms = mesesOrdenados.map((m) => {
    const hoja = monthSheetName(m.anio, m.mes);
    return `SUMIF('${hoja}'!$A:$A,$A${rowNum},'${hoja}'!$${col}:$${col})`;
  });
  return `=${terms.join("+")}`;
}

/**
 * Filas de la hoja "Resumen" (spec.md §7): equidad acumulada por cohorte de ingreso,
 * agregando por SUMIF/MAXIFS/MINIFS sobre todas las pestañas mensuales PUBLICADAS.
 * @param {object} p { residentes:{id,nombre,fechaInicio}[], publishedMonths:{mes,anio}[] }
 * @returns {{sheetName:"Resumen", rows:Array<Array<string|number>>}}
 */
export function buildResumenRows({ residentes, publishedMonths }) {
  const meses = [...new Map(publishedMonths.map((m) => [monthSheetName(m.anio, m.mes), m])).values()]
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
  const todasLasFechas = meses.flatMap((m) => datesOfMonth(m.anio, m.mes));
  const activos = activeResidents(residentes, todasLasFechas)
    .map((r) => ({ nombre: r.nombre, cohorte: Number(r.fechaInicio.slice(0, 4)) }))
    .sort((a, b) => a.cohorte - b.cohorte || a.nombre.localeCompare(b.nombre));

  const rows = [RESUMEN_HEADER];
  for (const r of activos) {
    const rowNum = rows.length + 1;
    rows.push([
      r.nombre, r.cohorte,
      sumifChain(meses, rowNum, "I"), // Total
      sumifChain(meses, rowNum, "G"), // Fines de Semana
      sumifChain(meses, rowNum, "D"), // Festivos (columna GF de la pestaña mensual)
      sumifChain(meses, rowNum, "E"), // Prefestivos (columna GP)
      sumifChain(meses, rowNum, "H"), // Dobletes V-D
      sumifChain(meses, rowNum, "F"), // 3P
      "", "", // equidad: se rellena abajo, una vez se conoce el rango completo de filas
    ]);
  }

  // Umbral de equidad = 1, el mismo que exige INV-3 (equity.js): no se deja como celda
  // editable (a diferencia del Excel viejo) porque el validador real de la app NO lo lee
  // de aquí — un umbral "editable" en el Sheet que no afecta a INV-3 sería engañoso.
  const lastRow = rows.length;
  for (let i = 2; i <= lastRow; i++) {
    rows[i - 1][8] = `=IF($B${i}="","",MAXIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i})-MINIFS($C$2:$C$${lastRow},$B$2:$B$${lastRow},$B${i}))`;
    rows[i - 1][9] = `=IF($B${i}="","",IF(I${i}<=1,"OK","REVISAR"))`;
  }
  return { sheetName: "Resumen", rows };
}

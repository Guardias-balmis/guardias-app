// Contaje oficial en el Excel del servicio (decisión V-65). PURO: construye un PLAN de
// operaciones genéricas sobre hojas (escribir, limpiar, unir celdas…) que el adaptador de
// `server/Code.gs` ejecuta a ciegas sobre la Hoja de Google cuyo id está en la propiedad
// CONTAJE_SPREADSHEET_ID. Aquí no se toca ninguna hoja: así el adaptador impuro, que no tiene
// tests, se queda en «abrir, leer, aplicar», y todo lo que decide QUÉ se escribe está probado.
//
// Qué es este fichero y en qué se diferencia de `projection.js`:
//  - `projection.js` escribe en el Sheet PROPIO de la app (pestañas «YYYY-MM» y «Resumen YYYY-YY»)
//    con fórmulas, y su doblete V-D solo empareja días del mismo mes (S-5, documentado allí).
//  - Esto escribe en el Excel que el servicio ya usaba (convertido a Hoja de Google), con la
//    disposición de ese Excel —«Cuadrante Mensual», «Resumen Anual», «Contaje Trimestral»,
//    «Tercer Puesto»— y TODO como VALORES calculados con `tally`, que sí ve el doblete de un
//    viernes de fin de mes con el domingo del mes siguiente (contrato C-1). Por decisión del autor
//    (V-65) ESTE es el contaje oficial, y por eso solo mira meses PUBLICADOS: si el lookahead leyera
//    un mes en borrador, el contaje «publicado» llevaría datos que nadie ha publicado.
//  - Valores y no fórmulas: con fórmulas la hoja tendría que reimplementar el contaje del dominio
//    (justo lo que evitan V-11 y V-25), y mezclar fórmulas y valores en una fila deja la fila
//    incoherente en silencio en cuanto alguien toca una celda a mano.
//
// La ventana es el CURSO académico (jun-may), una pestaña por curso en el mismo fichero, creada
// por la app duplicando una «Plantilla · …» oculta: un fichero nuevo cada junio exigiría que
// alguien lo creara y cambiara la propiedad, es decir, un administrador.
//
// Ninguna celda da un veredicto de equidad. «Dif. máx-mín (cohorte)» es un HECHO; el «≤ 1» y el
// OK/REVISAR del Excel original no se escriben porque INV-3 se cierra por año de residencia de
// cada uno y descuenta las bajas, y una hoja no puede hacer ninguna de las dos cosas (V-25).

import { datesOfMonth, weekday, academicYearOf, trimesterWindow, toISO, daysInMonth, compareISO } from "./calendar.js";
import { periodsOfResident, levelOn, isActiveOn } from "./residents.js";
import { tally } from "./tally.js";
import { thirdPostVolunteersInCourse } from "./thirdpost.js";
import { cursoLabel, columnLetter } from "./projection.js";

const PREFIJO_PLANTILLA = "Plantilla · ";
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const NIVELES = ["R4", "R3", "R2", "R1"];
const GUARDIA = new Set(["G", "GF", "GP"]);
const DIAS_SEMANA = ["L", "M", "X", "J", "V", "S", "D"];

// Colores del Excel original (se reescriben porque el número de filas por nivel ya no es fijo:
// una fila que en la plantilla era una franja oscura puede pasar a ser de un residente).
const CAB = "#203864";
const BLANCO = "#ffffff";
const NEGRO = "#000000";
const ALTERNA = "#ebf3fb";
const SECCION = "#deeaf1";
const FONDO_NIVEL = { R4: "#1f4e79", R3: "#2e75b6", R2: "#5ba3d0", R1: "#9dc3e6" };
const FONDO_CODIGO = { G: "#e2efda", GF: "#fce4d6", GP: "#fff2cc", "3P": "#deeaf1", V: "#ffe699", R: "#c6efce", B: "#f4cccc", C: "#e4dfec" };
const AMARILLO = "#ffe699";

const NOTA_CONTAJE = "Contaje oficial del servicio (decisión V-65): lo escribe la app al publicar un mes, con los meses PUBLICADOS del curso (junio a mayo). El doblete de un viernes de fin de mes cuenta en el mes del viernes y aparece cuando se publica el mes siguiente. «Dif. máx-mín (cohorte)» es una lectura, no el veredicto de equidad: la normativa la cierra por año de residencia de cada uno y descuenta las bajas, y eso lo comprueba la app al validar. No edites esta hoja: el siguiente volcado la reescribe.";
const NOTA_3P = "Tercer puesto del curso por día de la semana, con los meses PUBLICADOS. «Voluntario» = dijo que sí algún mes del curso. El ciclo L-D y el reparto entre voluntarios se cuentan por año de residencia y los comprueba la app al validar: esta hoja no los juzga. «Obs.» es libre y la app la conserva.";
const DESCRIPCION_PROTECCION = "La escribe la app de guardias al publicar (V-65): lo que se cambie a mano aquí se pierde en el siguiente volcado.";
const NOTA_IMAGINARIA = "La cola de imaginaria se consulta en la app de guardias (Imaginaria): depende de quién cubrió cada incidencia y cambia después de publicar, así que esta hoja ya no se rellena.";

// ── Disposición de cada hoja (después de preparar la plantilla) ──
const CUAD = { filaCab: 6, filaSemana: 7, filaDatos: 8, colDia1: 10, ancho: 40 }; // A..AN
const CUAD_CAB = ["Año", "Residente", "G", "GF", "GP", "Total", "3P", "Fines\nSemana", "Dobl.\nV-D"];
const RES = { filaCab: 4, filaDatos: 5, ancho: 12, anchoLimpiar: 14 }; // A..L (M, N eran del original)
const RES_CAB = ["Año", "Residente", "G", "GF", "GP", "Total\n(G+GF+GP)", "3P", "Fines\nSemana", "Dobletes\nV-D", "Marcadas\ncedida", "Marcadas\ncomprada", "Dif. máx-mín\n(cohorte)"];
const GRUPO = ["G", "GF", "GP", "Total", "3P", "FS", "Dobl"];
const TRIM = [
  { etiqueta: "T1 (Jun-Ago)", mes: 6, deltaAnio: 0 },
  { etiqueta: "T2 (Sep-Nov)", mes: 9, deltaAnio: 0 },
  { etiqueta: "T3 (Dic-Feb)", mes: 12, deltaAnio: 0 },
  { etiqueta: "T4 (Mar-May)", mes: 3, deltaAnio: 1 },
];
const CONT = { filaCab: 3, filaSub: 4, filaDatos: 5, colGrupo1: 3, colDif: 3 + 5 * GRUPO.length, ancho: 3 + 5 * GRUPO.length }; // A..AL
const TP = { filaCab: 4, filaDatos: 5, ancho: 13, colObs: 12, colId: 13 }; // A..M (M oculta)
const TP_CAB = ["Año", "Residente", "Voluntario\n(algún mes)", "Total 3P", "3P-L", "3P-M", "3P-X", "3P-J", "3P-V", "3P-S", "3P-D", "Obs.", "id (no tocar)"];

const TITULO = {
  cuadrante: "CUADRANTE DE GUARDIAS  ·  RADIODIAGNÓSTICO  ·  Hospital Dr. Balmis",
  resumen: "RESUMEN ANUAL · RADIODIAGNÓSTICO · Hospital Dr. Balmis",
  contaje: "CONTAJE TRIMESTRAL · RADIODIAGNÓSTICO · Hospital Dr. Balmis",
  tercerPuesto: "REGISTRO DE TERCER PUESTO (VOLUNTARIO) · Radiodiagnóstico · Dr. Balmis",
};

// Huellas: lo que se comprueba ANTES de escribir. La de la plantilla ya preparada (con GP) y la
// del Excel original (sin GP), que es como se reconoce la hoja la primera vez. Una sola fila por
// comprobación para que el adaptador haga una lectura por comprobación.
const HUELLA = {
  cuadrante: [{ fila: 6, columna: 1, columnas: 6, esperado: ["Año", "Residente", "G", "GF", "GP", "Total"] }],
  resumen: [{ fila: 4, columna: 1, columnas: 6, esperado: ["Año", "Residente", "G", "GF", "GP", "Total (G+GF+GP)"] }],
  contaje: [
    { fila: 3, columna: 1, columnas: 3, esperado: ["Año", "Residente", "T1 (Jun-Ago)"] },
    { fila: 4, columna: 3, columnas: 4, esperado: ["G", "GF", "GP", "Total"] },
  ],
  tercerPuesto: [{ fila: 4, columna: 1, columnas: 13, esperado: ["Año", "Residente", null, "Total 3P", "3P-L", null, null, null, null, null, "3P-D", "Obs.", "id (no tocar)"] }],
};
const HUELLA_ORIGINAL = {
  cuadrante: [{ fila: 6, columna: 1, columnas: 5, esperado: ["Año", "Residente", "G Total", "GF Total", "3P Total"] }],
  resumen: [{ fila: 4, columna: 1, columnas: 5, esperado: ["Año", "Residente", "G Total", "GF Total", "3P Total"] }],
  contaje: [
    { fila: 3, columna: 1, columnas: 3, esperado: ["Año", "Residente", "T1 (Jun-Ago)"] },
    { fila: 4, columna: 3, columnas: 3, esperado: ["G", "GF", "3P"] },
  ],
  tercerPuesto: [{ fila: 4, columna: 1, columnas: 5, esperado: ["Año", "Residente", "Voluntario", "Total 3P", "3P-L"] }],
};
const ORIGINAL = { cuadrante: "Cuadrante Mensual", resumen: "Resumen Anual", contaje: "Contaje Trimestral", tercerPuesto: "Tercer Puesto" };
const CLAVES = ["cuadrante", "resumen", "contaje", "tercerPuesto"];

/** Dónde se leen las «Obs.» de Tercer Puesto (con su id) antes de reescribir la hoja: L:M desde la fila 5 hasta la última. */
export const CONTAJE_LECTURA_OBS = { fila: TP.filaDatos, columna: TP.colObs, columnas: 2 };

/**
 * Cursos que hay que volcar al publicar (o volcar a mano) el mes `mes/anio`: el suyo y el del mes
 * ANTERIOR. Publicar junio cambia el contaje de mayo —el doblete de un viernes 31 de mayo con el
 * domingo 2 de junio se atribuye a mayo (S-5) y solo se ve con junio publicado (C-1)—, y mayo es
 * del curso anterior: sin esto ese doblete se perdería para siempre en las pestañas que ya no se
 * vuelven a escribir.
 * @returns {number[]}
 */
export function contajeCourses(mes, anio) {
  const este = academicYearOf(toISO(anio, mes, 1));
  const anterior = academicYearOf(mes === 1 ? toISO(anio - 1, 12, 1) : toISO(anio, mes - 1, 1));
  return este === anterior ? [este] : [este, anterior];
}

/** Las cuatro pestañas de un curso: nombre, plantilla de la que salen y huella que deben tener. */
export function contajeSheets(curso) {
  const etiqueta = cursoLabel(curso);
  return CLAVES.map((clave) => ({
    clave,
    original: ORIGINAL[clave],
    plantilla: PREFIJO_PLANTILLA + ORIGINAL[clave],
    nombre: `${ORIGINAL[clave]} ${etiqueta}`,
    huella: HUELLA[clave],
  }));
}

/**
 * ¿La hoja tiene la forma que esperamos? `lecturas[i]` es la matriz leída para `huella[i]`.
 * Devuelve null si cuadra o un texto que dice qué celda no cuadra. Compara sin apóstrofo inicial
 * y con los espacios y saltos de línea colapsados (el Excel original escribe «G⏎Total»); `null`
 * en `esperado` es «da igual qué haya».
 */
export function contajeFingerprintMismatch(huella, lecturas) {
  const norm = (v) => String(v === undefined || v === null ? "" : v).replace(/^'/, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < huella.length; i++) {
    const c = huella[i];
    const fila = (lecturas && lecturas[i] && lecturas[i][0]) || [];
    for (let j = 0; j < c.esperado.length; j++) {
      if (c.esperado[j] === null) continue;
      const leido = norm(fila[j]);
      if (leido !== norm(c.esperado[j])) return `${columnLetter(c.columna + j)}${c.fila} dice «${leido}», se esperaba «${norm(c.esperado[j])}»`;
    }
  }
  return null;
}

/**
 * La preparación ÚNICA del fichero convertido (idempotente: cada operación se puede repetir):
 *  - `originales`: cada hoja del Excel original se reconvierte en su plantilla (cabeceras con GP,
 *    sin botones de macro, sin los nombres de ejemplo) y luego el invocador la renombra a
 *    «Plantilla · …» y la oculta. `huellaOriginal` reconoce el original; `huellaPlantilla`, una
 *    hoja que ya se reconvirtió pero no llegó a renombrarse (una ejecución que murió a medias).
 *  - `fijas`: Instrucciones (el flujo real, sin macros ni «dif ≤ 1») e Imaginaria (una nota que
 *    remite a la app: la cola es una herramienta, INV-13, y una foto de ella engaña), cada una con
 *    la huella que tiene que tener para tocarla.
 *  - `borrar`: la hoja oculta `__DATA__` que nunca guardó nada.
 */
export function contajePreparation() {
  return {
    originales: CLAVES.map((clave) => ({
      original: ORIGINAL[clave],
      plantilla: PREFIJO_PLANTILLA + ORIGINAL[clave],
      huellaOriginal: HUELLA_ORIGINAL[clave],
      huellaPlantilla: HUELLA[clave],
      ops: PREPARAR[clave](),
    })),
    fijas: [
      { hoja: "Instrucciones", huella: [{ fila: 1, columna: 1, columnas: 1, esperado: ["INSTRUCCIONES DE USO · Excel de Guardias · Dr. Balmis"] }], ops: prepararInstrucciones() },
      { hoja: "Imaginaria", huella: [{ fila: 1, columna: 1, columnas: 1, esperado: ["LISTA DE IMAGINARIA · Radiodiagnóstico · Dr. Balmis"] }], ops: prepararImaginaria() },
    ],
    borrar: ["__DATA__"],
  };
}

/**
 * El plan de volcado de UN curso, o null si el curso no tiene ningún mes PUBLICADO (entonces no se
 * crea ninguna pestaña: una hoja de ceros no es un contaje).
 *
 * @param {object} p
 *   - residentes: hidratados (`periodos` editados si los hay), como los de `allResidentes`
 *   - asignaciones: TODAS (se filtran aquí a los meses publicados, de cualquier curso: el
 *     lookahead del doblete necesita los dos primeros días del mes siguiente si está publicado)
 *   - publicados: `{mes, anio}[]` en estado PUBLICADO ahora mismo
 *   - preferencias: todas (para «Voluntario» de Tercer Puesto)
 *   - curso: año en que empieza (jun-2026 … may-2027 → 2026)
 *   - actualizado: texto de la fecha del volcado (el router pasa `deps.today`)
 *   - observaciones: lo leído en `CONTAJE_LECTURA_OBS` (pares [obs, residenteId])
 * @returns {null | {curso:number, etiqueta:string, mesMostrado:{mes:number,anio:number}, mesesPublicados:{mes:number,anio:number}[], hojas:{clave:string,nombre:string,ops:object[]}[]}}
 */
export function buildContajePlan({ residentes, asignaciones, publicados, preferencias, curso, actualizado, observaciones = [] }) {
  const clavesPub = new Set((publicados || []).map((m) => mesClave(m.anio, m.mes)));
  const mesesCurso = [...clavesPub]
    .map((k) => ({ anio: Number(k.slice(0, 4)), mes: Number(k.slice(5, 7)) }))
    .filter((m) => academicYearOf(toISO(m.anio, m.mes, 1)) === curso)
    .sort((x, y) => x.anio - y.anio || x.mes - y.mes);
  if (mesesCurso.length === 0) return null;
  const mesMostrado = mesesCurso[mesesCurso.length - 1];

  // Solo las asignaciones de meses PUBLICADOS, de cualquier curso (V-65 + C-1).
  const porResidente = new Map();
  for (const x of asignaciones || []) {
    if (!x || typeof x.fecha !== "string" || !clavesPub.has(x.fecha.slice(0, 7))) continue;
    if (!porResidente.has(x.residenteId)) porResidente.set(x.residenteId, []);
    porResidente.get(x.residenteId).push(x);
  }
  const suyas = (id) => porResidente.get(id) || [];

  const etiqueta = cursoLabel(curso);
  const sello = `Actualizado por la app: ${actualizado} · meses publicados del curso: ${mesesCurso.map((m) => MESES[m.mes - 1].slice(0, 3).toLowerCase()).join(", ")}`;
  const nombres = Object.fromEntries(contajeSheets(curso).map((h) => [h.clave, h.nombre]));
  const fechasCurso = mesesCurso.flatMap((m) => datesOfMonth(m.anio, m.mes));
  const delCurso = activos(residentes, fechasCurso);

  return {
    curso, etiqueta, mesMostrado, mesesPublicados: mesesCurso,
    hojas: [
      { clave: "cuadrante", nombre: nombres.cuadrante, ops: opsCuadrante(residentes, suyas, mesMostrado, sello) },
      { clave: "resumen", nombre: nombres.resumen, ops: opsResumen(delCurso, suyas, curso, etiqueta, sello) },
      { clave: "contaje", nombre: nombres.contaje, ops: opsContaje(delCurso, suyas, curso, etiqueta, sello) },
      { clave: "tercerPuesto", nombre: nombres.tercerPuesto, ops: opsTercerPuesto(delCurso, suyas, curso, etiqueta, sello, preferencias, observaciones) },
    ],
  };
}

// ───────────────────────────── cálculo ─────────────────────────────

function mesClave(anio, mes) { return `${anio}-${String(mes).padStart(2, "0")}`; }

/** Residentes activos en alguna de `fechas`, con nivel (el de su primer día activo, como projection.js) y cohorte. */
function activos(residentes, fechas) {
  const out = [];
  for (const r of residentes || []) {
    const periodos = periodsOfResident(r);
    const primero = fechas.find((d) => isActiveOn(periodos, d));
    if (primero === undefined) continue;
    out.push({ id: r.id, nombre: r.nombre || "", nivel: levelOn(periodos, primero), cohorte: Number(String(r.fechaInicio).slice(0, 4)) });
  }
  return out;
}

/** Los ejes del Excel en una ventana: tally (con su lookahead) más lo que tally no separa. */
function contar(lista, win) {
  const t = tally(lista, win);
  const dentro = lista.filter((x) => compareISO(x.fecha, win.start) >= 0 && compareISO(x.fecha, win.end) <= 0);
  // Las dos columnas reparten EXACTAMENTE las guardias que llevan «*» en la rejilla, que son las que
  // `tally` deja fuera del total (cualquier `origen`). Un `origen` que no es COMPRADA cuenta como
  // cedida: los únicos válidos hoy son CEDIDA y COMPRADA, y la fila sobrante de un REFUERZO (V-56,
  // retirado por V-58) es «lo más parecido a una cedida/comprada» según la propia V-58. Contar solo
  // CEDIDA dejaría esa guardia con «*» en la rejilla y en ninguna columna del Resumen.
  const marcadas = (comprada) => dentro.filter((x) => x.origen && GUARDIA.has(x.codigo) && (x.origen === "COMPRADA") === comprada).length;
  const porDia = DIAS_SEMANA.map((d) => dentro.filter((x) => x.codigo === "3P" && weekday(x.fecha) === d).length);
  return {
    g: t.total - t.festivos - t.prefestivos, gf: t.festivos, gp: t.prefestivos, total: t.total,
    tp: t.tercerPuesto, finde: t.finde, dobletes: t.dobletes,
    cedidas: marcadas(false), compradas: marcadas(true), tpPorDia: porDia,
  };
}

function ventanaMes(m) { return { start: toISO(m.anio, m.mes, 1), end: toISO(m.anio, m.mes, daysInMonth(m.anio, m.mes)) }; }
function ventanaCurso(curso) { return { start: toISO(curso, 6, 1), end: toISO(curso + 1, 5, 31) }; }
function ventanasTrimestre(curso) {
  return TRIM.map((t) => { const w = trimesterWindow(toISO(curso + t.deltaAnio, t.mes, 1)); return { start: w.start, end: w.end }; });
}

/** Diferencia máx-mín de `valor` dentro de cada cohorte; "" si la cohorte no tiene con quién comparar. */
function difPorCohorte(filas, valor) {
  const porCohorte = new Map();
  for (const f of filas) {
    if (!porCohorte.has(f.cohorte)) porCohorte.set(f.cohorte, []);
    porCohorte.get(f.cohorte).push(valor(f));
  }
  return (f) => {
    const vs = porCohorte.get(f.cohorte);
    return vs.length < 2 ? "" : Math.max(...vs) - Math.min(...vs);
  };
}

// ───────────────────────────── celdas y operaciones ─────────────────────────────

const cel = (v, bg = BLANCO, fg = NEGRO, b = false) => ({ v, bg, fg, b });
// Todo texto con apóstrofo, como sheets-schema.js: `setValues` convierte en fórmula lo que empieza
// por «=» y en fecha o número lo que lo parece («2026-27», un id con pinta de número).
const valor = (v) => (typeof v === "string" && v !== "" ? `'${v}` : v);

function a1(fila, columna, filas, columnas) {
  return `${columnLetter(columna)}${fila}:${columnLetter(columna + columnas - 1)}${fila + filas - 1}`;
}

/** Escribe valores y formato (fondo, color y peso de letra) de una región rectangular de celdas `cel`. */
function escribir(fila, columna, celdas) {
  const ancho = Math.max(...celdas.map((f) => f.length));
  const rect = celdas.map((f) => (f.length === ancho ? f : [...f, ...Array.from({ length: ancho - f.length }, () => cel(""))]));
  return {
    op: "escribir", a1: a1(fila, columna, rect.length, ancho), fila, columna,
    valores: rect.map((f) => f.map((c) => valor(c.v))),
    fondos: rect.map((f) => f.map((c) => c.bg)),
    colores: rect.map((f) => f.map((c) => c.fg)),
    negritas: rect.map((f) => f.map((c) => (c.b ? "bold" : "normal"))),
  };
}

/** Escribe solo valores, conservando el formato de la plantilla (títulos, notas, sello). */
function escribirValores(fila, columna, valores) {
  const ancho = Math.max(...valores.map((f) => f.length));
  return { op: "escribir", a1: a1(fila, columna, valores.length, ancho), fila, columna, valores: valores.map((f) => [...f, ...Array(ancho - f.length).fill("")].map(valor)) };
}

/** Vacía contenido y formato (fondo, color, negrita) desde `fila` hasta la última fila de la hoja, o `filas` filas. */
function limpiar(fila, columna, columnas, filas) {
  const op = { op: "limpiar", a1: filas ? a1(fila, columna, filas, columnas) : `${columnLetter(columna)}${fila}:${columnLetter(columna + columnas - 1)}`, fila, columna, columnas };
  if (filas) op.filas = filas;
  return op;
}
const unir = (fila, columna, filas, columnas) => ({ op: "unir", a1: a1(fila, columna, filas, columnas), fila, columna, filas, columnas });
const desunir = (fila, columna, filas, columnas) => ({ op: "desunir", a1: a1(fila, columna, filas, columnas), fila, columna, filas, columnas });
const anchos = (columna, columnas, px) => ({ op: "anchos", columna, columnas, px });
const congelar = (filas, columnas) => ({ op: "congelar", filas, columnas });
const ocultarColumnas = (columna, columnas) => ({ op: "ocultarColumnas", columna, columnas });
// Protección «con advertencia» de la hoja entera salvo `libres` (rangos A1). Solo avisa: no impide
// editar a nadie, y el script escribe sin aviso. El adaptador no la duplica si ya hay una.
const proteger = (libres = []) => ({ op: "proteger", descripcion: DESCRIPCION_PROTECCION, libres });

const cab = (v) => cel(v, CAB, BLANCO, true);
const franja = (ancho) => Array.from({ length: ancho }, () => cel("", CAB));

/**
 * Filas de datos agrupadas por nivel (R4→R1, por nombre dentro del bloque) con una franja oscura
 * tras cada bloque, como el Excel. `celdasDe(r, i)` da las celdas de la columna C en adelante.
 */
function filasPorNivel(residentes, ancho, celdasDe) {
  const filas = [];
  for (const nivel of NIVELES) {
    const bloque = residentes.filter((r) => r.nivel === nivel).sort((x, y) => x.nombre.localeCompare(y.nombre, "es"));
    if (bloque.length === 0) continue;
    bloque.forEach((r, i) => {
      const fondo = i % 2 === 0 ? BLANCO : ALTERNA;
      filas.push([cel(i === 0 ? nivel : "", FONDO_NIVEL[nivel], BLANCO, true), cel(r.nombre, fondo, NEGRO, i === 0), ...celdasDe(r, fondo)]);
    });
    filas.push(franja(ancho));
  }
  return filas;
}

// ── Cuadrante Mensual ──

function opsCuadrante(residentes, suyas, m, sello) {
  const dias = datesOfMonth(m.anio, m.mes);
  const win = ventanaMes(m);
  const filasRes = activos(residentes, dias);
  const cabDias = Array.from({ length: 31 }, (_, i) => cab(i < dias.length ? i + 1 : ""));
  const semana = Array.from({ length: 31 }, (_, i) => cel(i < dias.length ? weekday(dias[i]) : "", SECCION, "#4472c4", true));

  const datos = filasPorNivel(filasRes, CUAD.ancho, (r, fondo) => {
    const lista = suyas(r.id);
    const c = contar(lista, win);
    const porDia = new Map(lista.filter((x) => x.fecha.startsWith(mesClave(m.anio, m.mes))).map((x) => [x.fecha, x]));
    const rejilla = Array.from({ length: 31 }, (_, i) => {
      const x = i < dias.length ? porDia.get(dias[i]) : undefined;
      if (!x || !x.codigo) return cel("", fondo);
      // Una cedida/comprada se marca con «*»: la hace quien aparece, pero no suma (INV-4). El 3P no
      // se marca nunca, igual que en projection.js: tally lo cuenta con independencia del origen.
      const codigo = x.origen && GUARDIA.has(x.codigo) ? `${x.codigo}*` : x.codigo;
      return cel(codigo, FONDO_CODIGO[x.codigo] || fondo);
    });
    return [
      cel(c.g, FONDO_CODIGO.G, NEGRO, true), cel(c.gf, FONDO_CODIGO.GF, NEGRO, true), cel(c.gp, FONDO_CODIGO.GP, NEGRO, true),
      cel(c.total, FONDO_CODIGO.G, NEGRO, true), cel(c.tp, FONDO_CODIGO["3P"], NEGRO, true),
      cel(c.finde, AMARILLO), cel(c.dobletes, AMARILLO), ...rejilla,
    ];
  });

  const ops = [
    proteger(),
    escribirValores(2, 1, [["Mes:", MESES[m.mes - 1], "Año:", m.anio]]),
    escribir(CUAD.filaCab, CUAD.colDia1, [cabDias]),
    escribir(CUAD.filaSemana, CUAD.colDia1, [semana]),
    limpiar(CUAD.filaDatos, 1, CUAD.ancho),
  ];
  if (datos.length) ops.push(escribir(CUAD.filaDatos, 1, datos));
  ops.push(escribirValores(2, 6, [[sello]]));
  return ops;
}

// ── Resumen Anual ──

function opsResumen(delCurso, suyas, curso, etiqueta, sello) {
  const win = ventanaCurso(curso);
  const conteos = new Map(delCurso.map((r) => [r.id, contar(suyas(r.id), win)]));
  const dif = difPorCohorte(delCurso, (r) => conteos.get(r.id).total);
  const datos = filasPorNivel(delCurso, RES.ancho, (r, fondo) => {
    const c = conteos.get(r.id);
    return [
      cel(c.g, fondo), cel(c.gf, fondo), cel(c.gp, fondo), cel(c.total, fondo, NEGRO, true), cel(c.tp, fondo),
      cel(c.finde, fondo), cel(c.dobletes, fondo), cel(c.cedidas, fondo), cel(c.compradas, fondo), cel(dif(r), AMARILLO),
    ];
  });
  const ops = [proteger(), escribirValores(1, 1, [[`${TITULO.resumen} · ${etiqueta}`]]), limpiar(RES.filaDatos, 1, RES.anchoLimpiar)];
  if (datos.length) ops.push(escribir(RES.filaDatos, 1, datos));
  ops.push(escribirValores(3, 1, [[sello]]));
  return ops;
}

// ── Contaje Trimestral ──

function opsContaje(delCurso, suyas, curso, etiqueta, sello) {
  const ventanas = ventanasTrimestre(curso);
  const ejes = (c) => [c.g, c.gf, c.gp, c.total, c.tp, c.finde, c.dobletes];
  const porTrim = new Map(delCurso.map((r) => [r.id, ventanas.map((w) => ejes(contar(suyas(r.id), w)))]));
  // El total del curso es la SUMA de los trimestres (que lo parten sin solaparse): así la fila
  // cuadra a la vista, y el doblete va al trimestre de su viernes como en tally.
  const totales = new Map([...porTrim].map(([id, ts]) => [id, ts[0].map((_, k) => ts.reduce((s, t) => s + t[k], 0))]));
  const dif = difPorCohorte(delCurso, (r) => totales.get(r.id)[3]);
  const datos = filasPorNivel(delCurso, CONT.ancho, (r, fondo) => [
    ...porTrim.get(r.id).flatMap((t) => t.map((v, k) => cel(v, fondo, NEGRO, k === 3))),
    ...totales.get(r.id).map((v, k) => cel(v, FONDO_CODIGO.G, NEGRO, k === 3)),
    cel(dif(r), AMARILLO),
  ]);
  const ops = [proteger(), escribirValores(1, 1, [[`${TITULO.contaje} · ${etiqueta}`]]), limpiar(CONT.filaDatos, 1, CONT.ancho)];
  if (datos.length) ops.push(escribir(CONT.filaDatos, 1, datos));
  // La nota va DEBAJO de la tabla (la fila 2 es la del sello): se mueve con el número de filas.
  ops.push(escribirValores(CONT.filaDatos + datos.length + 1, 1, [[NOTA_CONTAJE]]));
  ops.push(escribirValores(2, 1, [[sello]]));
  return ops;
}

// ── Tercer Puesto ──

function opsTercerPuesto(delCurso, suyas, curso, etiqueta, sello, preferencias, observaciones) {
  const win = ventanaCurso(curso);
  const voluntarios = thirdPostVolunteersInCourse(preferencias, curso);
  // «Obs.» la escriben las personas: se relee por id antes de borrar y se recoloca, porque las
  // filas se mueven al cambiar quién está en cada nivel. Por nombre se mezclarían dos homónimos.
  const obs = new Map();
  for (const f of observaciones || []) {
    const texto = String((f && f[0]) ?? "").replace(/^'/, "");
    const id = String((f && f[1]) ?? "").replace(/^'/, "");
    if (id && texto) obs.set(id, texto);
  }
  const listados = new Set(delCurso.map((r) => r.id));
  const datos = filasPorNivel(delCurso, TP.ancho, (r, fondo) => {
    const c = contar(suyas(r.id), win);
    return [
      cel(voluntarios.has(r.id) ? "Sí" : "No", AMARILLO), cel(c.tp, FONDO_CODIGO.G, NEGRO, true),
      ...c.tpPorDia.map((n) => cel(n, fondo)), cel(obs.get(r.id) || "", fondo), cel(r.id, fondo),
    ];
  });
  // Una «Obs.» de alguien que ya no sale en este curso no se tira: queda al final con su id.
  for (const [id, texto] of obs) {
    if (listados.has(id)) continue;
    datos.push([cel(""), cel("(no aparece en este curso)"), ...Array.from({ length: 9 }, () => cel("")), cel(texto), cel(id)]);
  }
  // «Obs.» es de las personas: fuera de la protección, para que escribirla no pida confirmación. La
  // columna del id se vuelve a ocultar en cada volcado: no consta que la copia de la plantilla
  // conserve las columnas ocultas, y repetirlo no cuesta nada.
  const ops = [
    proteger([`${columnLetter(TP.colObs)}${TP.filaDatos}:${columnLetter(TP.colObs)}`]),
    escribirValores(1, 1, [[`${TITULO.tercerPuesto} · ${etiqueta}`]]), limpiar(TP.filaDatos, 1, TP.ancho), ocultarColumnas(TP.colId, 1),
  ];
  if (datos.length) ops.push(escribir(TP.filaDatos, 1, datos));
  ops.push(escribirValores(3, 1, [[sello]]));
  return ops;
}

// ───────────────────────────── preparación de plantillas ─────────────────────────────

// Ninguna celda combinada cruza el borde de las columnas fijadas (la 2, Residente), ni al combinar
// ni al fijar: Google Sheets rechaza las dos cosas («it is not possible to freeze columns that
// contain only part of a merged cell»). Por eso el título NO se combina (el texto desborda solo,
// con B1 vacía) y en Cuadrante se deshace «LEYENDA →» (A4:D4 en el Excel). El doble de
// `contaje-memoria.mjs` lanza igual que Sheets para que un test lo vea.
const PREPARAR = {
  cuadrante() {
    const leyenda = [["G", "Guardia"], ["GF", "Guardia festiva"], ["GP", "Guardia prefestivo"], ["3P", "3.º puesto"], ["V", "Vacaciones"], ["R", "Rotación ext."], ["B", "Baja"], ["C", "Congreso (no cuenta)"], ["G*", "Cedida o comprada (no cuenta)"]];
    return [
      // Los «botones» ◀ ▶ 💾 🔄 eran celdas de colores de una macro que no existe.
      escribirValores(2, 1, [["Mes:", "", "Año:", ""]]),
      limpiar(2, 5, CUAD.ancho - 4, 1),
      limpiar(4, 5, CUAD.ancho - 4, 1),
      escribir(4, 5, [leyenda.flatMap(([c, t]) => [cel(c, FONDO_CODIGO[c.replace("*", "")] || BLANCO, NEGRO, true), cel(t)])]),
      desunir(1, 1, 1, CUAD.ancho),
      desunir(4, 1, 1, 4),
      escribirValores(1, 1, [[TITULO.cuadrante]]),
      escribir(CUAD.filaCab, 1, [[...CUAD_CAB.map(cab), ...Array.from({ length: 31 }, (_, i) => cab(i + 1))]]),
      escribir(CUAD.filaSemana, 1, [[cel("", SECCION), cel("← día semana", SECCION, "#808080"), ...Array.from({ length: CUAD.ancho - 2 }, () => cel("", SECCION))]]),
      limpiar(CUAD.filaDatos, 1, CUAD.ancho),
      anchos(3, 7, 52),
      anchos(CUAD.colDia1, 31, 30),
      congelar(CUAD.filaSemana, 2),
    ];
  },
  resumen() {
    return [
      escribirValores(1, 1, [[TITULO.resumen]]),
      escribirValores(2, 1, [[NOTA_CONTAJE]]),
      escribir(RES.filaCab, 1, [RES_CAB.map(cab)]),
      limpiar(RES.filaCab, RES.ancho + 1, RES.anchoLimpiar - RES.ancho, 1),
      limpiar(RES.filaDatos, 1, RES.anchoLimpiar),
      anchos(3, RES.ancho - 2, 72),
    ];
  },
  contaje() {
    const grupos = [...TRIM.map((t) => t.etiqueta), "TOTAL CURSO"];
    const fila3 = [cab("Año"), cab("Residente")];
    grupos.forEach((g, i) => { for (let k = 0; k < GRUPO.length; k++) fila3.push(cel(k === 0 ? g : "", i < 4 ? "#2e75b6" : "#1f4e79", BLANCO, true)); });
    fila3.push(cab("Dif. máx-mín\n(cohorte)"));
    const fila4 = [cab(""), cab("")];
    grupos.forEach((_, i) => { for (const s of GRUPO) fila4.push(cel(s, i < 4 ? "#3a86c8" : "#1f4e79", BLANCO, true)); });
    fila4.push(cab(""));
    return [
      // Las combinadas del original (cinco columnas por trimestre) no cuadran con siete: se
      // deshacen, se escribe y se vuelven a unir con el ancho nuevo. El título no se vuelve a unir
      // (ver arriba: cruzaría las columnas fijadas).
      desunir(1, 1, CONT.filaSub, CONT.ancho),
      escribirValores(1, 1, [[TITULO.contaje]]),
      escribir(CONT.filaCab, 1, [fila3]),
      escribir(CONT.filaSub, 1, [fila4]),
      ...grupos.map((_, i) => unir(CONT.filaCab, CONT.colGrupo1 + i * GRUPO.length, 1, GRUPO.length)),
      unir(CONT.filaCab, CONT.colDif, 2, 1),
      limpiar(CONT.filaDatos, 1, CONT.ancho),
      anchos(CONT.colGrupo1, 5 * GRUPO.length, 40),
      anchos(CONT.colDif, 1, 96),
      congelar(CONT.filaSub, 2),
    ];
  },
  tercerPuesto() {
    return [
      escribirValores(1, 1, [[TITULO.tercerPuesto]]),
      escribirValores(2, 1, [[NOTA_3P]]),
      escribir(TP.filaCab, 1, [TP_CAB.map(cab)]),
      limpiar(TP.filaDatos, 1, TP.ancho),
      ocultarColumnas(TP.colId, 1),
    ];
  },
};

function prepararInstrucciones() {
  const S = "SECCION";
  const filas = [
    [S, "CÓMO SE USA ESTE FICHERO", ""],
    ["1", "En la app", "El cuadrante se hace, se valida y se publica en la app de guardias. Esta hoja no se edita a mano: la app la reescribe cada vez que se publica un mes."],
    ["2", "Al publicar", "La app vuelca el contaje del curso (junio a mayo) en las pestañas «… <curso>»: Cuadrante Mensual (el último mes publicado), Resumen Anual, Contaje Trimestral y Tercer Puesto. Al publicar junio vuelve a volcar también el curso anterior."],
    ["3", "Volcar al contaje", "Si cambia algo que no pasa por publicar (las fechas de un residente, sus periodos, las respuestas de tercer puesto) o un volcado falló, quien puede publicar pulsa «Volcar al contaje» en la pantalla del cuadrante de un mes publicado."],
    ["4", "Cursos", "Cada curso tiene sus pestañas, que la app crea copiando las «Plantilla · …» ocultas; las de cursos pasados se quedan como estaban. Están protegidas «con advertencia»: se pueden editar, pero el siguiente volcado lo reescribe. Solo «Obs.» de Tercer Puesto es de las personas y la app la conserva."],
    ["", "", ""],
    [S, "CÓDIGOS", ""],
    ["G", "Guardia ordinaria", "Guardia en día laborable que no es víspera de festivo."],
    ["GF", "Guardia festiva", "Guardia en día festivo, según el calendario de festivos de la app."],
    ["GP", "Guardia prefestivo", "Guardia en la víspera de un festivo."],
    ["3P", "Tercer puesto", "Voluntario, hasta las 20 h. No cuenta en el total de guardias."],
    ["V", "Vacaciones", "Marca del cuadrante."],
    ["R", "Rotación externa", "Marca del cuadrante."],
    ["B", "Baja", "Marca del cuadrante. La baja que descuenta para la equidad es la registrada como ausencia en la app, no esta letra."],
    ["C", "Congreso", "Marca del cuadrante; no cuenta en ningún total."],
    ["G*", "Cedida o comprada", "La guardia la hace quien aparece, pero no suma a su total: se cuenta en «Marcadas cedida» o «Marcadas comprada» del Resumen."],
    ["", "", ""],
    [S, "CÓMO SE CUENTA", ""],
    ["Meses", "Solo publicados", "Solo cuentan los meses PUBLICADOS en la app, tal como están al volcar. Despublicar un mes no escribe aquí, pero mientras siga despublicado el siguiente volcado de su curso (publicar otro mes o «Volcar al contaje») lo quita del contaje; vuelve a contar al republicarlo."],
    ["Dobletes V-D", "Viernes + domingo", "Viernes con guardia y domingo siguiente con guardia. Cuenta en el mes del viernes; si el domingo cae en el mes siguiente, aparece cuando se publica ese mes."],
    ["Equidad", "Dif. máx-mín (cohorte)", "Es una lectura, no un veredicto: la normativa cierra la equidad por año de residencia de cada uno y descuenta las bajas, y eso lo comprueba la app al validar el cuadrante."],
    ["Imaginaria", "En la app", "La cola de imaginaria se consulta en la app; la pestaña Imaginaria ya no se rellena."],
    ["Responsable", "R3 de turno", "Comunica el contaje a tutoría al cerrar cada trimestre y envía el cuadrante definitivo a Coordinación de Técnicos."],
  ];
  const celdas = filas.map(([a, b, c]) => (a === S
    ? [cel(b, SECCION, NEGRO, true), cel("", ALTERNA), cel("")]
    : [cel(a, a ? SECCION : BLANCO, NEGRO, true), cel(b, b ? ALTERNA : BLANCO, NEGRO, true), cel(c)]));
  return [limpiar(3, 1, 3), escribir(3, 1, celdas)];
}

function prepararImaginaria() {
  return [escribirValores(2, 1, [[NOTA_IMAGINARIA]]), limpiar(4, 1, 7)];
}

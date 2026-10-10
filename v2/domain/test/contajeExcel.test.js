// Tests de v2/domain/contajeExcel.js — el contaje oficial que la app escribe en el Excel del
// servicio (decisión V-65). Los nombres son inventados: el fichero real lleva nombres de
// residentes y nada de él se copia al repo.
//
// El módulo devuelve un PLAN de operaciones genéricas (escribir/limpiar/unir…) que el adaptador de
// `Code.gs` ejecuta a ciegas. Para afirmar sobre el resultado y no sobre la forma del plan, los
// tests aplican las operaciones a una rejilla en memoria (`aplicar`) y leen celdas por A1.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContajePlan, contajeCourses, contajeSheets, contajePreparation, contajeFingerprintMismatch,
  CONTAJE_LECTURA_OBS,
} from "../contajeExcel.js";
import { columnLetter } from "../projection.js";

const R = (id, nombre, fechaInicio, fechaFin) => ({ id, nombre, fechaInicio, fechaFin });
const RES = [
  R("r4a", "Lucía Prado", "2023-05-22", "2027-05-21"),
  R("r4b", "Marta Sanz", "2023-05-22", "2027-05-21"),
  R("r3a", "Pablo Ríos", "2024-05-27", "2028-05-26"),
  R("r1a", "Nora Vidal", "2026-05-25", "2030-05-24"),
  R("fin", "Teo Final", "2021-05-24", "2025-05-23"), // FINALIZADO en el curso 2026: no sale
];
const a = (residenteId, fecha, codigo = "G", origen) => (origen ? { residenteId, fecha, codigo, origen } : { residenteId, fecha, codigo });
const ASIG = [
  a("r4a", "2026-07-31"), a("r4a", "2026-08-02"), // viernes 31 + domingo 2: doblete de borde (C-1)
  a("r4a", "2026-07-15", "GF"), a("r4a", "2026-07-20", "V"),
  a("r4b", "2026-07-04"), a("r4b", "2026-07-10", "G", "CEDIDA"), a("r4b", "2026-07-11", "GP", "COMPRADA"),
  a("r3a", "2026-07-06", "3P"), a("r3a", "2026-07-13", "3P"), a("r3a", "2026-08-08", "3P"),
  a("r1a", "2026-09-05"), // septiembre NO está publicado: no cuenta
];
const PUB_JUL_AGO = [{ mes: 7, anio: 2026 }, { mes: 8, anio: 2026 }];
const PREFS = [{ residenteId: "r3a", anio: 2026, mes: 8, tercerPuesto: true }, { residenteId: "r4a", anio: 2026, mes: 7, tercerPuesto: false }];

function plan(over = {}) {
  return buildContajePlan({ residentes: RES, asignaciones: ASIG, publicados: PUB_JUL_AGO, preferencias: PREFS, curso: 2026, actualizado: "2026-10-08", observaciones: [], ...over });
}

// ── rejilla en memoria: aplica las operaciones del plan como lo haría Sheets ──
function hojaVacia() { return { celdas: new Map(), fondos: new Map(), ocultas: new Set(), unidas: [] }; }
function aplicar(hoja, ops) {
  for (const op of ops) {
    if (op.op === "escribir") {
      op.valores.forEach((fila, i) => fila.forEach((v, j) => {
        const k = `${op.fila + i},${op.columna + j}`;
        // Sheets se come el apóstrofo inicial y deja el texto tal cual.
        hoja.celdas.set(k, typeof v === "string" ? v.replace(/^'/, "") : v);
        if (op.fondos) hoja.fondos.set(k, op.fondos[i][j]);
      }));
    } else if (op.op === "limpiar") {
      for (const k of [...hoja.celdas.keys()]) {
        const [f, c] = k.split(",").map(Number);
        const hasta = op.filas ? op.fila + op.filas - 1 : Infinity;
        if (f >= op.fila && f <= hasta && c >= op.columna && c < op.columna + op.columnas) { hoja.celdas.delete(k); hoja.fondos.delete(k); }
      }
    } else if (op.op === "ocultarColumnas") {
      for (let c = op.columna; c < op.columna + op.columnas; c++) hoja.ocultas.add(c);
    } else if (op.op === "unir") hoja.unidas.push(op.a1);
  }
  return hoja;
}
function a1ToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), c];
}
const celda = (hoja, ref) => { const [f, c] = a1ToRC(ref); const v = hoja.celdas.get(`${f},${c}`); return v === undefined ? "" : v; };
const fondo = (hoja, ref) => { const [f, c] = a1ToRC(ref); return hoja.fondos.get(`${f},${c}`); };
function hojaDe(p, clave) { return aplicar(hojaVacia(), p.hojas.find((h) => h.clave === clave).ops); }
/** Fila (1-based) en la que aparece `nombre` en la columna B, o -1. */
function filaDe(hoja, nombre) {
  for (const [k, v] of hoja.celdas) { const [f, c] = k.split(",").map(Number); if (c === 2 && v === nombre) return f; }
  return -1;
}
const col = (n) => columnLetter(n);

// ── qué cursos se vuelcan ──

test("contajeCourses: el curso del mes y el del mes anterior (el de junio arrastra a mayo, C-1)", () => {
  assert.deepEqual(contajeCourses(6, 2027), [2027, 2026]);
  assert.deepEqual(contajeCourses(7, 2027), [2027]);
  assert.deepEqual(contajeCourses(1, 2027), [2026]); // enero y diciembre son del mismo curso
});

test("contajeSheets: una pestaña por curso de cada hoja, sacada de su «Plantilla · …»", () => {
  const hojas = contajeSheets(2026);
  assert.deepEqual(hojas.map((h) => h.nombre), ["Cuadrante Mensual 2026-27", "Resumen Anual 2026-27", "Contaje Trimestral 2026-27", "Tercer Puesto 2026-27"]);
  assert.deepEqual(hojas.map((h) => h.plantilla), ["Plantilla · Cuadrante Mensual", "Plantilla · Resumen Anual", "Plantilla · Contaje Trimestral", "Plantilla · Tercer Puesto"]);
  for (const h of hojas) assert.ok(Array.isArray(h.huella) && h.huella.length > 0);
});

// ── sin meses publicados no hay nada que escribir ──

test("buildContajePlan: un curso sin ningún mes PUBLICADO no produce plan (no se crea ninguna pestaña)", () => {
  assert.equal(plan({ publicados: [{ mes: 6, anio: 2026 - 1 }] }), null);
  assert.equal(plan({ publicados: [] }), null);
});

// ── Resumen Anual ──

test("Resumen: G, GF, GP y Total por separado; solo meses PUBLICADOS; el doblete de borde cuenta (C-1, V-65)", () => {
  const h = hojaDe(plan(), "resumen");
  const f = filaDe(h, "Lucía Prado");
  assert.ok(f > 0);
  // C G · D GF · E GP · F Total · G 3P · H Fines · I Dobletes · J Marcadas cedida · K Marcadas comprada · L Dif
  assert.deepEqual(["C", "D", "E", "F", "G", "H", "I", "J", "K"].map((c) => celda(h, `${c}${f}`)), [2, 1, 0, 3, 0, 1, 1, 0, 0]);
  // Septiembre está VALIDADO, no publicado: la guardia de Nora no cuenta.
  assert.equal(celda(h, `F${filaDe(h, "Nora Vidal")}`), 0);
});

test("Resumen: sin agosto publicado, el doblete del viernes 31 de julio todavía no aparece", () => {
  const h = hojaDe(plan({ publicados: [{ mes: 7, anio: 2026 }] }), "resumen");
  assert.equal(celda(h, `I${filaDe(h, "Lucía Prado")}`), 0);
});

test("Resumen: cedidas y compradas se marcan aparte y no suman al Total (INV-4)", () => {
  const h = hojaDe(plan(), "resumen");
  const f = filaDe(h, "Marta Sanz");
  assert.deepEqual(["C", "D", "E", "F", "H", "J", "K"].map((c) => celda(h, `${c}${f}`)), [1, 0, 0, 1, 1, 1, 1]);
});

test("una fila sobrante con otro `origen` (REFUERZO, V-58) lleva «*» y cuenta en «Marcadas cedida»: el Resumen explica la rejilla", () => {
  const p = plan({ asignaciones: [...ASIG, a("r4b", "2026-07-21", "G", "REFUERZO")], publicados: [{ mes: 7, anio: 2026 }] });
  const cu = hojaDe(p, "cuadrante");
  assert.equal(celda(cu, `${col(9 + 21)}${filaDe(cu, "Marta Sanz")}`), "G*");
  const h = hojaDe(p, "resumen");
  const f = filaDe(h, "Marta Sanz");
  // Total sin cambios (tally la deja fuera, V-58); cedida 1 → 2; comprada sigue en 1.
  assert.deepEqual(["F", "J", "K"].map((c) => celda(h, `${c}${f}`)), [1, 2, 1]);
});

test("Resumen: «Dif. máx-mín (cohorte)» compara el Total dentro de la cohorte; sin compañeros queda vacía", () => {
  const h = hojaDe(plan(), "resumen");
  assert.equal(celda(h, `L${filaDe(h, "Lucía Prado")}`), 2);
  assert.equal(celda(h, `L${filaDe(h, "Marta Sanz")}`), 2);
  assert.equal(celda(h, `L${filaDe(h, "Pablo Ríos")}`), "");
});

test("Resumen: bloques por nivel derivado de la fecha (R4→R1) con una franja tras cada bloque; el FINALIZADO no sale", () => {
  const h = hojaDe(plan(), "resumen");
  assert.equal(celda(h, "A5"), "R4");
  assert.equal(celda(h, "B5"), "Lucía Prado");
  assert.equal(celda(h, "A6"), "");
  assert.equal(celda(h, "B6"), "Marta Sanz");
  assert.equal(celda(h, "B7"), "");
  assert.equal(fondo(h, "B7"), "#203864"); // franja separadora
  assert.equal(celda(h, "A8"), "R3");
  assert.equal(celda(h, "A10"), "R1");
  assert.equal(filaDe(h, "Teo Final"), -1);
  assert.match(celda(h, "A1"), /2026-27/);
});

test("Resumen: las cabeceras no traen veredicto ni «≤ 1»", () => {
  const prep = contajePreparation().originales.find((o) => o.original === "Resumen Anual");
  const h = aplicar(hojaVacia(), prep.ops);
  const cab = Array.from({ length: 14 }, (_, i) => celda(h, `${col(i + 1)}4`));
  assert.deepEqual(cab.slice(0, 12).map((x) => String(x).replace(/\s+/g, " ")),
    ["Año", "Residente", "G", "GF", "GP", "Total (G+GF+GP)", "3P", "Fines Semana", "Dobletes V-D", "Marcadas cedida", "Marcadas comprada", "Dif. máx-mín (cohorte)"]);
  assert.deepEqual(cab.slice(12), ["", ""]);
});

// ── Contaje Trimestral ──

test("Contaje Trimestral: siete columnas por trimestre y el total del curso es su suma", () => {
  const h = hojaDe(plan(), "contaje");
  const f = filaDe(h, "Lucía Prado");
  // T1 = C..I (G, GF, GP, Total, 3P, FS, Dobl)
  assert.deepEqual(["C", "D", "E", "F", "G", "H", "I"].map((c) => celda(h, `${c}${f}`)), [2, 1, 0, 3, 0, 1, 1]);
  // T2 = J..P vacío de guardias (septiembre no está publicado)
  assert.deepEqual(["J", "M"].map((c) => celda(h, `${c}${f}`)), [0, 0]);
  // TOTAL = AE..AK, Dif = AL
  assert.deepEqual(["AE", "AF", "AG", "AH", "AI", "AJ", "AK"].map((c) => celda(h, `${c}${f}`)), [2, 1, 0, 3, 0, 1, 1]);
  assert.equal(celda(h, `AL${f}`), 2);
});

test("Contaje Trimestral: el doblete del viernes 31 de mayo cuenta en T4 del curso que acaba cuando se publica junio", () => {
  const res = [R("x", "Ada Ruiz", "2021-05-24", "2025-05-23"), R("y", "Bruno Gil", "2021-05-24", "2025-05-23")];
  const asig = [a("x", "2024-05-31"), a("x", "2024-06-02")];
  const conJunio = buildContajePlan({ residentes: res, asignaciones: asig, publicados: [{ mes: 5, anio: 2024 }, { mes: 6, anio: 2024 }], preferencias: [], curso: 2023, actualizado: "2024-07-01", observaciones: [] });
  const sinJunio = buildContajePlan({ residentes: res, asignaciones: asig, publicados: [{ mes: 5, anio: 2024 }], preferencias: [], curso: 2023, actualizado: "2024-07-01", observaciones: [] });
  const t4Dobl = (p) => { const h = hojaDe(p, "contaje"); return celda(h, `AD${filaDe(h, "Ada Ruiz")}`); };
  assert.equal(t4Dobl(conJunio), 1);
  assert.equal(t4Dobl(sinJunio), 0);
  // …y la guardia del domingo 2 de junio es del curso siguiente: aquí no suma.
  const h = hojaDe(conJunio, "contaje");
  assert.equal(celda(h, `AH${filaDe(h, "Ada Ruiz")}`), 1);
});

// ── Cuadrante Mensual ──

test("Cuadrante Mensual: muestra el último mes PUBLICADO por calendario, no el último en publicarse", () => {
  const p = plan({ publicados: [{ mes: 8, anio: 2026 }, { mes: 7, anio: 2026 }] });
  assert.deepEqual(p.mesMostrado, { mes: 8, anio: 2026 });
  const h = hojaDe(p, "cuadrante");
  assert.equal(celda(h, "B2"), "Agosto");
  assert.equal(celda(h, "D2"), 2026);
});

test("Cuadrante Mensual: días y día de la semana desde J; columnas sobrantes vacías en un mes de 30", () => {
  const h = hojaDe(plan({ publicados: [{ mes: 6, anio: 2026 }] }), "cuadrante");
  assert.equal(celda(h, "J6"), 1);
  assert.equal(celda(h, "AM6"), 30);
  assert.equal(celda(h, "AN6"), "");
  assert.equal(celda(h, "J7"), "L"); // 1 de junio de 2026 es lunes
  assert.equal(celda(h, "AN7"), "");
});

test("Cuadrante Mensual: la rejilla son los códigos de `asignaciones`; los totales son valores del mes", () => {
  const h = hojaDe(plan(), "cuadrante");
  const f = filaDe(h, "Lucía Prado");
  assert.equal(celda(h, `${col(9 + 2)}${f}`), "G"); // día 2
  // C G · D GF · E GP · F Total · G 3P · H Fines · I Dobl.
  assert.deepEqual(["C", "D", "E", "F", "G", "H", "I"].map((c) => celda(h, `${c}${f}`)), [1, 0, 0, 1, 0, 1, 0]);
  const fp = filaDe(h, "Pablo Ríos");
  assert.equal(celda(h, `${col(9 + 8)}${fp}`), "3P");
  assert.equal(celda(h, `G${fp}`), 1);
});

test("Cuadrante Mensual: una guardia cedida o comprada se marca con «*» y no suma", () => {
  const h = hojaDe(plan({ publicados: [{ mes: 7, anio: 2026 }] }), "cuadrante");
  const f = filaDe(h, "Marta Sanz");
  assert.equal(celda(h, `${col(9 + 10)}${f}`), "G*");
  assert.equal(celda(h, `${col(9 + 11)}${f}`), "GP*");
  assert.equal(celda(h, `${col(9 + 4)}${f}`), "G");
  assert.equal(celda(h, `F${f}`), 1);
  // Las marcas V/R/B/C también son de `asignaciones`, como en la pestaña YYYY-MM de la app.
  assert.equal(celda(h, `${col(9 + 20)}${filaDe(h, "Lucía Prado")}`), "V");
});

test("Cuadrante Mensual: mayo, último mes del curso, ya cuenta el doblete del viernes 31 si junio está publicado", () => {
  const res = [R("x", "Ada Ruiz", "2021-05-24", "2025-05-23")];
  const asig = [a("x", "2024-05-31"), a("x", "2024-06-02")];
  const p = buildContajePlan({ residentes: res, asignaciones: asig, publicados: [{ mes: 5, anio: 2024 }, { mes: 6, anio: 2024 }], preferencias: [], curso: 2023, actualizado: "x", observaciones: [] });
  assert.deepEqual(p.mesMostrado, { mes: 5, anio: 2024 });
  const h = hojaDe(p, "cuadrante");
  assert.equal(celda(h, `I${filaDe(h, "Ada Ruiz")}`), 1);
});

// ── Tercer Puesto ──

test("Tercer Puesto: «Sí» si dijo que sí algún mes del curso, 3P por día de la semana y total", () => {
  const h = hojaDe(plan(), "tercerPuesto");
  const f = filaDe(h, "Pablo Ríos");
  // C Voluntario · D Total · E..K L,M,X,J,V,S,D
  assert.deepEqual(["C", "D", "E", "F", "G", "H", "I", "J", "K"].map((c) => celda(h, `${c}${f}`)), ["Sí", 3, 2, 0, 0, 0, 0, 1, 0]);
  assert.equal(celda(h, `C${filaDe(h, "Lucía Prado")}`), "No");
  assert.equal(celda(h, `M${f}`), "r3a"); // id en la columna oculta, para recolocar «Obs.»
});

test("Tercer Puesto: «Obs.» se conserva recolocada por residenteId, y la de quien ya no sale no se pierde", () => {
  const obs = [["Prefiere lunes", "r3a"], ["Nota huérfana", "id-viejo"], ["", ""], ["Sin id", ""]];
  const h = hojaDe(plan({ observaciones: obs }), "tercerPuesto");
  assert.equal(celda(h, `L${filaDe(h, "Pablo Ríos")}`), "Prefiere lunes");
  assert.equal(celda(h, `L${filaDe(h, "Lucía Prado")}`), "");
  const huerfana = filaDe(h, "(no aparece en este curso)");
  assert.ok(huerfana > 0);
  assert.equal(celda(h, `L${huerfana}`), "Nota huérfana");
  assert.equal(celda(h, `M${huerfana}`), "id-viejo");
});

test("CONTAJE_LECTURA_OBS lee las columnas L:M desde la primera fila de datos de Tercer Puesto", () => {
  assert.deepEqual(CONTAJE_LECTURA_OBS, { fila: 5, columna: 12, columnas: 2 });
});

// ── forma del plan ──

test("plan: toda escritura es rectangular, con formato del mismo tamaño, y los textos llevan apóstrofo", () => {
  const p = plan();
  for (const hoja of p.hojas) {
    for (const op of hoja.ops.filter((o) => o.op === "escribir")) {
      const ancho = op.valores[0].length;
      for (const f of op.valores) assert.equal(f.length, ancho, `${hoja.nombre} ${op.a1}`);
      for (const m of [op.fondos, op.colores, op.negritas].filter(Boolean)) {
        assert.equal(m.length, op.valores.length);
        for (const f of m) assert.equal(f.length, ancho);
      }
      for (const f of op.valores) for (const v of f) {
        assert.ok(typeof v === "number" || v === "" || (typeof v === "string" && v.startsWith("'")), `${hoja.nombre} ${op.a1}: ${JSON.stringify(v)}`);
      }
    }
  }
});

test("plan: la marca «Actualizado por la app» es la ÚLTIMA escritura de cada hoja", () => {
  for (const hoja of plan().hojas) {
    const ultima = hoja.ops[hoja.ops.length - 1];
    assert.equal(ultima.op, "escribir");
    assert.match(ultima.valores[0][0], /^'Actualizado por la app: 2026-10-08/);
  }
});

test("plan: ningún texto da veredicto de equidad (ni «≤ 1», ni OK/REVISAR)", () => {
  const textos = [];
  const recoger = (ops) => { for (const op of ops) if (op.valores) for (const f of op.valores) for (const v of f) if (typeof v === "string") textos.push(v); };
  for (const h of plan().hojas) recoger(h.ops);
  const prep = contajePreparation();
  for (const o of prep.originales) recoger(o.ops);
  for (const f of prep.fijas) recoger(f.ops);
  for (const t of textos) assert.doesNotMatch(t, /≤\s*1|REVISAR|\bOK\b|macro/i, t);
});

// ── huellas ──

test("contajeFingerprintMismatch: cuadra con apóstrofo y saltos de línea; ignora los null", () => {
  const huella = [{ fila: 6, columna: 1, columnas: 3, esperado: ["Año", null, "G Total"] }];
  assert.equal(contajeFingerprintMismatch(huella, [[["'Año", "lo que sea", "G\nTotal"]]]), null);
});

test("contajeFingerprintMismatch: dice qué celda no cuadra", () => {
  const huella = [{ fila: 6, columna: 1, columnas: 2, esperado: ["Año", "Residente"] }];
  assert.match(contajeFingerprintMismatch(huella, [[["Año", "Nombre"]]]), /B6.*Nombre.*Residente/);
  assert.match(contajeFingerprintMismatch(huella, [[]]), /A6/);
});

test("preparación: aplicar las operaciones de cada plantilla deja la huella que se comprueba antes de volcar", () => {
  const prep = contajePreparation();
  const porOriginal = new Map(prep.originales.map((o) => [o.original, o]));
  for (const h of contajeSheets(2026)) {
    const o = porOriginal.get(h.original);
    assert.ok(o, h.original);
    assert.equal(o.plantilla, h.plantilla);
    const hoja = aplicar(hojaVacia(), o.ops);
    const lecturas = h.huella.map((c) => [Array.from({ length: c.columnas }, (_, j) => hoja.celdas.get(`${c.fila},${c.columna + j}`) ?? "")]);
    assert.equal(contajeFingerprintMismatch(h.huella, lecturas), null, h.original);
    assert.deepEqual(o.huellaPlantilla, h.huella);
  }
});

test("preparación: el original se reconoce por su huella antigua (sin GP)", () => {
  const cuad = contajePreparation().originales.find((o) => o.original === "Cuadrante Mensual");
  assert.equal(contajeFingerprintMismatch(cuad.huellaOriginal, [[["Año", "Residente", "G\nTotal", "GF\nTotal", "3P\nTotal"]]]), null);
});

test("preparación: oculta la columna del id en Tercer Puesto, borra __DATA__ y reescribe Instrucciones e Imaginaria", () => {
  const prep = contajePreparation();
  const tp = aplicar(hojaVacia(), prep.originales.find((o) => o.original === "Tercer Puesto").ops);
  assert.ok(tp.ocultas.has(13));
  assert.deepEqual(prep.borrar, ["__DATA__"]);
  const instr = prep.fijas.find((f) => f.hoja === "Instrucciones");
  const imag = prep.fijas.find((f) => f.hoja === "Imaginaria");
  const hi = aplicar(hojaVacia(), instr.ops);
  const textos = [...hi.celdas.values()].filter((v) => typeof v === "string").join(" | ");
  assert.match(textos, /Volcar al contaje/);
  assert.match(textos, /GP/);
  assert.doesNotMatch(textos, /section/);
  const hm = aplicar(hojaVacia(), imag.ops);
  assert.match(celda(hm, "A2"), /app/);
  assert.equal(celda(hm, "C6"), "");
});

test("preparación: ninguna combinada cruza el borde de las columnas fijadas (Sheets rechaza fijar o combinar así)", () => {
  for (const o of contajePreparation().originales) {
    const fijar = o.ops.filter((x) => x.op === "congelar");
    for (const c of fijar) {
      for (const u of o.ops.filter((x) => x.op === "unir")) {
        const parte = c.columnas > 0 && u.columna <= c.columnas && u.columna + u.columnas - 1 > c.columnas;
        assert.ok(!parte, `${o.original}: ${u.a1} cruza las ${c.columnas} columnas fijadas`);
      }
    }
  }
  // «LEYENDA →» (A4:D4 en el Excel) se deshace antes de fijar dos columnas.
  const cuad = contajePreparation().originales.find((o) => o.original === "Cuadrante Mensual").ops;
  const k = cuad.findIndex((x) => x.op === "desunir" && x.a1 === "A4:D4");
  assert.ok(k >= 0 && k < cuad.findIndex((x) => x.op === "congelar"));
});

test("Instrucciones no promete que despublicar deje el contaje quieto: el siguiente volcado del curso quita ese mes", () => {
  const instr = contajePreparation().fijas.find((f) => f.hoja === "Instrucciones");
  const textos = [...aplicar(hojaVacia(), instr.ops).celdas.values()].filter((v) => typeof v === "string").join(" | ");
  assert.doesNotMatch(textos, /no cambia esta hoja hasta que se vuelve a publicar/);
  assert.match(textos, /siguiente volcado/);
});

// ── protección y columna del id en cada volcado ──
// La preparación del autor no tiene pasos manuales (V-65): proteger «con advertencia» las pestañas
// que reescribe la app es parte del plan, no un paso del runbook. Sin ella, quien siga la costumbre
// de rellenar la rejilla a mano lo perdería en silencio en el siguiente volcado.

test("plan: cada pestaña del curso se protege «con advertencia», y en Tercer Puesto «Obs.» queda libre", () => {
  for (const h of plan().hojas) {
    const prot = h.ops.filter((o) => o.op === "proteger");
    assert.equal(prot.length, 1, h.nombre);
    assert.match(prot[0].descripcion, /app/);
    if (h.clave === "tercerPuesto") assert.deepEqual(prot[0].libres, ["L5:L"]);
    else assert.deepEqual(prot[0].libres, []);
  }
});

test("plan: Tercer Puesto vuelve a ocultar la columna del id en cada volcado (no se fía de que la copia la herede)", () => {
  const h = hojaDe(plan(), "tercerPuesto");
  assert.ok(h.ocultas.has(13));
});

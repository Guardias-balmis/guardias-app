// contaje-memoria.mjs · SOLO PARA DESARROLLO Y TESTS. No se despliega a Apps Script.
//
// Doble en memoria del puerto `deps.contaje` (el Excel del servicio convertido a Hoja de Google,
// decisión V-65). Mismo contrato que `contaje_()` de `server/Code.gs`:
//   abrir() → null | motivo · hojas() → nombres · leer(hoja, {fila, columna, columnas, filas?})
//   aplicar(hoja, ops) · duplicar(origen, destino) · renombrar(a, b) · ocultar(hoja) · borrar(hoja)
// Lo usan los tests del router y `dev-server.mjs`, para que el flujo entero (preparación del
// fichero, plantillas por curso, huellas, volcado) se pueda ver sin una cuenta de Google.
//
// Emula de Sheets lo que importa para no engañarse: se come el apóstrofo inicial de un texto al
// escribir; `leer` devuelve TEXTO, lo que se ve en la celda (el adaptador lee con
// `getDisplayValues`: con `getValues` un «15/7» tecleado en «Obs.» llegaría como Date y volvería
// escrito como «Wed Jul 15 2026…»); una lectura «hasta el final» (sin `filas`) llega hasta la
// última fila con contenido, como `getLastRow()`; y combinar o fijar columnas lanza, como en Sheets,
// si una combinada queda partida por el borde de las columnas fijadas. Lo que NO emula (límites de
// la rejilla, formatos de número, combinadas que se solapan) solo se ve contra el fichero real: ver
// server/README-deploy.md.

/** "A4:D4" → {fila, columna, filas, columnas}. */
function rangoA1(a1) {
  const [ini, fin = ini] = a1.split(":");
  const [f1, c1] = a1ARC(ini);
  const [f2, c2] = a1ARC(fin);
  return { fila: f1, columna: c1, filas: f2 - f1 + 1, columnas: c2 - c1 + 1 };
}
// ¿El borde que deja `n` filas/columnas fijadas parte el rango? (0 fijadas no parte nada.)
const parte = (inicio, largo, n) => n > 0 && inicio <= n && inicio + largo - 1 > n;
const partida = (u, congelado) => Boolean(congelado) && (parte(u.columna, u.columnas, congelado.columnas) || parte(u.fila, u.filas, congelado.filas));
const solapa = (a, b) => a.fila <= b.fila + b.filas - 1 && b.fila <= a.fila + a.filas - 1 && a.columna <= b.columna + b.columnas - 1 && b.columna <= a.columna + a.columnas - 1;

function a1ARC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`referencia A1 inválida: ${ref}`);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), c];
}
const clave = (f, c) => `${f},${c}`;
function colLetra(n) { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

function hojaNueva() {
  return { celdas: new Map(), oculta: false, unidas: [], columnasOcultas: new Set(), anchos: {}, congelado: null, proteccion: null };
}
function copiaHoja(h) {
  return {
    celdas: new Map([...h.celdas].map(([k, v]) => [k, { ...v }])), oculta: h.oculta, unidas: h.unidas.slice(),
    columnasOcultas: new Set(h.columnasOcultas), anchos: { ...h.anchos }, congelado: h.congelado,
    proteccion: h.proteccion,
  };
}
function ultimaFila(h) {
  let max = 0;
  for (const [k, v] of h.celdas) if (v.v !== "" && v.v !== undefined) max = Math.max(max, Number(k.split(",")[0]));
  return max;
}

/**
 * @param {Record<string, Record<string, string|number>>} inicial  { hoja: { "A1": valor, … } } — en orden.
 *        Dos claves especiales por hoja, como las trae el Excel convertido: `_unidas` (["A4:D4", …])
 *        y `_congelado` ({filas, columnas}).
 * @param {{motivoAbrir?: string|null}} opciones  `motivoAbrir`: simula un fichero que no se puede abrir
 */
export function makeContajeMemoria(inicial = {}, { motivoAbrir = null } = {}) {
  const hojas = new Map();
  for (const [nombre, celdas] of Object.entries(inicial)) {
    const h = hojaNueva();
    for (const [ref, v] of Object.entries(celdas)) {
      if (ref === "_unidas") { h.unidas = v.map(rangoA1); continue; }
      if (ref === "_congelado") { h.congelado = { ...v }; continue; }
      const [f, c] = a1ARC(ref);
      h.celdas.set(clave(f, c), { v });
    }
    hojas.set(nombre, h);
  }
  const llamadas = [];
  const hoja = (n) => { const h = hojas.get(n); if (!h) throw new Error(`no existe la hoja «${n}» en el fichero de contaje`); return h; };

  function aplicarOp(h, op) {
    switch (op.op) {
      case "escribir":
        op.valores.forEach((fila, i) => fila.forEach((v, j) => {
          const k = clave(op.fila + i, op.columna + j);
          const prev = h.celdas.get(k) || {};
          const celda = { ...prev, v: typeof v === "string" ? v.replace(/^'/, "") : v };
          if (op.fondos) celda.bg = op.fondos[i][j];
          if (op.colores) celda.fg = op.colores[i][j];
          if (op.negritas) celda.b = op.negritas[i][j];
          h.celdas.set(k, celda);
        }));
        return;
      case "limpiar": {
        const hasta = op.filas ? op.fila + op.filas - 1 : Infinity;
        for (const k of [...h.celdas.keys()]) {
          const [f, c] = k.split(",").map(Number);
          if (f >= op.fila && f <= hasta && c >= op.columna && c < op.columna + op.columnas) h.celdas.delete(k);
        }
        return;
      }
      case "unir": {
        const u = { fila: op.fila, columna: op.columna, filas: op.filas, columnas: op.columnas };
        if (partida(u, h.congelado)) throw new Error(`You can't merge frozen and non-frozen rows or columns (${op.a1})`);
        h.unidas = h.unidas.filter((x) => !solapa(x, u)).concat([u]);
        return;
      }
      case "desunir": {
        const r = { fila: op.fila, columna: op.columna, filas: op.filas, columnas: op.columnas };
        h.unidas = h.unidas.filter((x) => !solapa(x, r));
        return;
      }
      case "anchos": for (let c = op.columna; c < op.columna + op.columnas; c++) h.anchos[c] = op.px; return;
      case "ocultarColumnas": for (let c = op.columna; c < op.columna + op.columnas; c++) h.columnasOcultas.add(c); return;
      case "congelar": {
        const c = { filas: op.filas, columnas: op.columnas };
        const mal = h.unidas.find((u) => partida(u, c));
        if (mal) throw new Error("Sorry, it is not possible to freeze columns that contain only part of a merged cell.");
        h.congelado = c;
        return;
      }
      // Como el adaptador: si la hoja ya tiene una protección, no se añade otra.
      case "proteger": if (!h.proteccion) h.proteccion = { descripcion: op.descripcion, libres: op.libres.slice() }; return;
      default: throw new Error(`operación desconocida: ${op.op}`);
    }
  }

  return {
    llamadas,
    abrir() { llamadas.push("abrir"); return motivoAbrir; },
    hojas() { llamadas.push("hojas"); return [...hojas.keys()]; },
    leer(n, { fila, columna, columnas, filas }) {
      llamadas.push("leer");
      const h = hoja(n);
      const total = filas || Math.max(0, ultimaFila(h) - fila + 1);
      return Array.from({ length: total }, (_, i) => Array.from({ length: columnas }, (_, j) => {
        const c = h.celdas.get(clave(fila + i, columna + j));
        return c && c.v !== undefined ? String(c.v) : "";
      }));
    },
    aplicar(n, ops) { llamadas.push("aplicar"); const h = hoja(n); for (const op of ops) aplicarOp(h, op); },
    duplicar(origen, destino) {
      llamadas.push("duplicar");
      if (hojas.has(destino)) throw new Error(`ya existe una hoja llamada «${destino}»`);
      const h = copiaHoja(hoja(origen));
      h.oculta = false;
      hojas.set(destino, h);
    },
    renombrar(a, b) {
      llamadas.push("renombrar");
      const h = hoja(a);
      // Conserva la posición, como `setName`.
      const orden = [...hojas.entries()].map(([k, v]) => (k === a ? [b, h] : [k, v]));
      hojas.clear();
      for (const [k, v] of orden) hojas.set(k, v);
    },
    ocultar(n) { llamadas.push("ocultar"); hoja(n).oculta = true; },
    borrar(n) { llamadas.push("borrar"); hojas.delete(n); },

    // ── solo para inspeccionar desde tests y el dev-server ──
    /** Valor de una celda por A1 ("" si está vacía). */
    celda(n, ref) { const [f, c] = a1ARC(ref); const x = hoja(n).celdas.get(clave(f, c)); return x && x.v !== undefined ? x.v : ""; },
    /** Fondo de una celda por A1. */
    fondo(n, ref) { const [f, c] = a1ARC(ref); const x = hoja(n).celdas.get(clave(f, c)); return x ? x.bg : undefined; },
    estaOculta(n) { return hoja(n).oculta; },
    columnaOculta(n, c) { return hoja(n).columnasOcultas.has(c); },
    /** Combinadas de la hoja, en A1 y ordenadas. */
    unidas(n) { return hoja(n).unidas.map((u) => `${colLetra(u.columna)}${u.fila}:${colLetra(u.columna + u.columnas - 1)}${u.fila + u.filas - 1}`).sort(); },
    /** `{filas, columnas}` fijadas, o null. */
    congelado(n) { return hoja(n).congelado; },
    /** `{descripcion, libres}` de la protección «con advertencia» de la hoja, o null. */
    proteccion(n) { return hoja(n).proteccion; },
    /** Instantánea serializable de todo el fichero: nombre, si está oculta y sus valores. */
    instantanea() {
      return [...hojas.entries()].map(([nombre, h]) => {
        const filas = ultimaFila(h);
        let cols = 0;
        for (const k of h.celdas.keys()) cols = Math.max(cols, Number(k.split(",")[1]));
        const valores = Array.from({ length: filas }, (_, i) => Array.from({ length: cols }, (_, j) => {
          const c = h.celdas.get(clave(i + 1, j + 1));
          return c && c.v !== undefined ? c.v : "";
        }));
        return { nombre, oculta: h.oculta, valores };
      });
    },
  };
}

/**
 * Un Excel del servicio de mentira, con la MISMA estructura que el original (hojas, cabeceras,
 * notas con «≤ 1», botones de macro, `__DATA__`) y nombres inventados. Sirve para probar la
 * preparación única del fichero sin copiar al repo nada del Excel real, que lleva nombres de
 * residentes.
 */
export function excelOriginalDePrueba() {
  const dias = {};
  for (let d = 1; d <= 31; d++) {
    let n = 7 + d, s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    dias[`${s}6`] = d;
  }
  return {
    __DATA__: { A1: "MES", B1: "AÑO", C1: "SERIALIZED_DATA", A2: "Junio", B2: "2026" },
    "Cuadrante Mensual": {
      A1: "CUADRANTE DE GUARDIAS  ·  RADIODIAGNÓSTICO  ·  Hospital Dr. Balmis",
      A2: "Mes:", B2: "Junio", C2: "Año:", D2: "2026",
      F2: "◀ Mes anterior", G2: "Mes siguiente ▶", I2: "💾 Guardar mes", K2: "🔄 Recalcular totales",
      A4: "LEYENDA →", E4: "G", F4: "Guardia", G4: "GF", H4: "Guardia Festiva", I4: "3P", J4: "3.º Puesto",
      A6: "Año", B6: "Residente", C6: "G\nTotal", D6: "GF\nTotal", E6: "3P\nTotal", F6: "Fines\nSemana", G6: "Dobl.\nV-D", ...dias,
      B7: "← día semana",
      A8: "R4", B8: "Ejemplo Uno", C8: "=COUNTIF(H8:AL8,\"G\")", F8: "=0",
      B9: "Ejemplo Dos", C9: "=COUNTIF(H9:AL9,\"G\")",
      // Como el Excel real: título y «LEYENDA →» combinados, paneles fijados en E7.
      _unidas: ["A1:AJ1", "A4:D4"], _congelado: { filas: 6, columnas: 4 },
    },
    "Resumen Anual": {
      A1: "RESUMEN ANUAL · RADIODIAGNÓSTICO · Hospital Dr. Balmis · 2025-2026",
      A2: "Actualizado automáticamente desde el Cuadrante Mensual al pulsar 'Guardar mes'  ·  Diferencia máx. permitida: 1",
      A4: "Año", B4: "Residente", C4: "G\nTotal", D4: "GF\nTotal", E4: "3P\nTotal", F4: "Fines\nSemana", G4: "Festivos\n(GF días)",
      H4: "Dobletes\nV-D", I4: "Cedidas", J4: "Compradas", K4: "Dif.máx.\nvs.compañero", L4: "✔ Equidad",
      A5: "R4", B5: "Ejemplo Uno", C5: 0, L5: "—",
      _unidas: ["A1:N1", "A2:N2"], _congelado: { filas: 4, columnas: 2 },
    },
    "Contaje Trimestral": {
      A1: "CONTAJE TRIMESTRAL · RADIODIAGNÓSTICO · Hospital Dr. Balmis",
      A3: "Año", B3: "Residente", C3: "T1 (Jun-Ago)", H3: "T2 (Sep-Nov)", M3: "T3 (Dic-Feb)", R3: "T4 (Mar-May)", W3: "TOTAL ANUAL", AB3: "Dif.máx.\n(≤1?)",
      C4: "G", D4: "GF", E4: "3P", F4: "FS", G4: "Dobl",
      A5: "R4", B5: "Ejemplo Uno", C5: 0, W5: "=C5+H5+M5+R5",
      B6: "Ejemplo Dos", B7: "Ejemplo Tres",
      _unidas: ["A1:X1", "C3:G3", "H3:L3", "M3:Q3", "R3:V3", "W3:AA3", "AB3:AB4"], _congelado: { filas: 4, columnas: 2 },
    },
    "Tercer Puesto": {
      A1: "REGISTRO DE TERCER PUESTO (VOLUNTARIO) · Radiodiagnóstico · Dr. Balmis",
      A2: "Lista rotatoria: cubrir L-M-X-J-V-S-D antes de repetir el mismo día.  Diferencia máx. entre voluntarios: 1",
      A4: "Año", B4: "Residente", C4: "Voluntario", D4: "Total 3P", E4: "3P-L", F4: "3P-M", G4: "3P-X", H4: "3P-J", I4: "3P-V", J4: "3P-S", K4: "3P-D", L4: "Obs.",
      A5: "R4", B5: "Ejemplo Uno", C5: "No", D5: "=SUM(E5:K5)",
    },
    Imaginaria: {
      A1: "LISTA DE IMAGINARIA · Radiodiagnóstico · Dr. Balmis",
      A2: "Las guardias de imaginaria NO descuentan del contaje de equidad.",
      A4: "IMAGINARIA — RESIDENTES MAYORES (R3 / R4)", A5: "Pos.", C5: "Residente", A6: 1, C6: "Ejemplo Uno",
    },
    Instrucciones: {
      A1: "INSTRUCCIONES DE USO · Excel de Guardias · Dr. Balmis",
      A3: "FLUJO DE TRABAJO MENSUAL", B3: "section", C4: "Rellena las celdas de cada día con los códigos…",
      A17: "Equidad", B17: "Diferencia máx. ≤ 1", A25: "MACROS VBA", B25: "section",
    },
  };
}

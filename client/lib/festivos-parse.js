// Parseo del pegado en lote de festivos (decisión V-17a: «un año de festivos se pega de golpe»).
//
// Vive en client/lib y no en la pantalla porque es lo único de esa pantalla que se puede probar
// con node:test —un `.jsx` no— y porque es justo donde un fallo pasa desapercibido: una línea mal
// leída no da error, mete una fecha equivocada en la tabla que INV-12 usa para decidir si una GF
// es correcta. Por eso el resultado separa lo válido de lo que no, con el número de línea: la
// pantalla enseña las dos cosas ANTES de escribir nada, y `crearFestivos` rechaza el lote entero
// si algo se cuela igualmente.
//
// El calendario oficial se copia de sitios distintos cada año, así que el formato es tolerante:
// una fecha ISO y un nombre, separados por `;`, por un tabulador o simplemente por espacios.

import { parseISO } from "../../v2/domain/calendar.js";

const AMBITOS = ["NACIONAL", "AUTONOMICO", "LOCAL"];

/**
 * @param {string} texto  una línea por festivo. Se ignoran las vacías y las que empiezan por `#`.
 *   Formatos aceptados:
 *     2026-12-25
 *     2026-12-25 Navidad
 *     2026-12-25;Navidad;NACIONAL
 *     2026-12-25<TAB>Navidad<TAB>LOCAL
 * @param {string[]} yaCargadas  fechas que ya están en la tabla: repetirlas se marca como error
 *   en vez de crear una fila duplicada (la tabla es append-only y no se limpia nunca).
 * @returns {{festivos: {fecha,nombre,ambito}[], errores: {linea:number, texto:string, motivo:string}[]}}
 */
export function parseFestivos(texto, yaCargadas = []) {
  const festivos = [];
  const errores = [];
  const vistas = new Set(yaCargadas);

  const lineas = String(texto || "").split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const bruto = lineas[i].trim();
    if (!bruto || bruto.startsWith("#")) continue;
    const nLinea = i + 1;

    // Campos explícitos primero (`;` o tabulador); si no los hay, el primer bloque de texto es la
    // fecha y todo lo demás el nombre — que es como queda al copiar de una tabla del BOE.
    let campos = bruto.split(/[;\t]/).map((c) => c.trim());
    if (campos.length === 1) {
      const m = /^(\S+)\s+(.*)$/.exec(bruto);
      campos = m ? [m[1], m[2].trim()] : [bruto];
    }
    const [fecha, nombre = "", ambitoBruto = ""] = campos;

    try {
      parseISO(fecha);
    } catch {
      errores.push({ linea: nLinea, texto: bruto, motivo: `"${fecha}" no es una fecha AAAA-MM-DD` });
      continue;
    }
    if (vistas.has(fecha)) {
      errores.push({ linea: nLinea, texto: bruto, motivo: "esa fecha ya está cargada" });
      continue;
    }
    const ambito = ambitoBruto.toUpperCase();
    if (ambito && !AMBITOS.includes(ambito)) {
      errores.push({ linea: nLinea, texto: bruto, motivo: `ámbito "${ambitoBruto}" desconocido (${AMBITOS.join(", ")})` });
      continue;
    }

    vistas.add(fecha);
    festivos.push({ fecha, nombre, ambito });
  }
  return { festivos, errores };
}

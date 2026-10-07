// Qué año toca revisar y cuándo avisar (V-63). Puro, para poder probarlo con node:test.
//
// El decreto de calendario laboral de la Comunitat se publica en julio del año ANTERIOR, así que en
// enero ya se conoce el del año entero, y la reunión de guardias de comienzo de año es el momento de
// comprobar los festivos automáticos (traslados de domingo a lunes, locales de Alicante). Para que
// el aviso llegue ANTES de montar enero —cuyo cuadrante se arma en noviembre y diciembre— aparece
// desde el 1 de diciembre del año anterior y no se apaga hasta que alguien lo confirma.

/** Año cuyo calendario toca revisar: el del año en curso, y desde diciembre el siguiente. */
export function anioARevisar(hoyISO) {
  const anio = Number(String(hoyISO).slice(0, 4));
  const mes = Number(String(hoyISO).slice(5, 7));
  return mes === 12 ? anio + 1 : anio;
}

/** ¿Se recuerda en Inicio? Solo mientras ese año no conste como revisado. */
export function recordarRevision(estado) {
  return Boolean(estado && estado.ok === true && estado.revisado === false);
}

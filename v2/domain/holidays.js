// Festivos de la Comunitat Valenciana calculados por año (decisión V-61). PURO: solo fechas.
//
// Hasta V-61 los festivos eran únicamente datos de entrada (V-17a, S-4): alguien pegaba cada año
// el calendario. Con el sistema pensado para durar diez años sin administrador, eso significaba
// cargar uno a uno cada enero. Ahora la app parte de la BASE de la Comunitat —las fiestas que se
// repiten todos los años— y la tabla `festivos` queda para lo que la base no puede saber: los dos
// locales de Alicante (cambian de fecha cada año), los traslados que decide el Consell y
// cualquier otro. Una fila activa de la tabla manda sobre la base de esa fecha; una anulada la
// quita (ver `festivosEfectivos` en el router).
//
// Qué es la base: lo que comparten los decretos de calendario laboral de la Comunitat (comprobado
// con el de 2025 y el de 2026, Decreto 100/2025, DOGV 10145): Año Nuevo, Epifanía, San José,
// Viernes Santo, Lunes de Pascua, Fiesta del Trabajo, San Juan, Asunción, Día de la Comunitat,
// Fiesta Nacional, Todos los Santos, Constitución, Inmaculada y Navidad. Los de fecha fija que
// caen en DOMINGO se omiten: el decreto de 2026 no incluye ni el 1 de noviembre ni el 6 de
// diciembre (ambos domingo) y sí el 15 de agosto (sábado) — son 12 días. Cuando el Consell
// traslada uno al lunes, ese lunes hay que añadirlo a mano: no se adivina, lo decide cada
// decreto, y por eso la pantalla de festivos dice que se revise el calendario cada año.
//
// Lo que NO está aquí a propósito: Jueves Santo (no es festivo en la Comunitat), los locales de
// cada municipio y cualquier traslado. Un festivo que falte lo avisa INV-12 como mucho; uno que
// sobre se anula en la pantalla con la ✕.

import { addDays, toISO, weekday } from "./calendar.js";

/**
 * Domingo de Pascua (calendario gregoriano; algoritmo de Meeus/Jones/Butcher).
 * @param {number} year
 * @returns {string} fecha ISO
 */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toISO(year, month, day);
}

// [mes, día, nombre, ámbito]: los de fecha fija. Los dos que dependen de la Pascua van aparte.
const FIJOS = [
  [1, 1, "Año Nuevo", "NACIONAL"],
  [1, 6, "Epifanía del Señor", "NACIONAL"],
  [3, 19, "San José", "AUTONOMICO"],
  [5, 1, "Fiesta del Trabajo", "NACIONAL"],
  [6, 24, "San Juan", "AUTONOMICO"],
  [8, 15, "Asunción de la Virgen", "NACIONAL"],
  [10, 9, "Día de la Comunitat Valenciana", "AUTONOMICO"],
  [10, 12, "Fiesta Nacional de España", "NACIONAL"],
  [11, 1, "Todos los Santos", "NACIONAL"],
  [12, 6, "Día de la Constitución", "NACIONAL"],
  [12, 8, "Inmaculada Concepción", "NACIONAL"],
  [12, 25, "Navidad", "NACIONAL"],
];

/**
 * Base de festivos de la Comunitat Valenciana de un año, en orden de fecha.
 * @param {number} year
 * @returns {{fecha:string, nombre:string, ambito:string}[]}
 */
export function valencianHolidays(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error(`año fuera de rango: ${year}`);
  const pascua = easterSunday(year);
  const lista = [
    ...FIJOS.map(([mes, dia, nombre, ambito]) => ({ fecha: toISO(year, mes, dia), nombre, ambito })),
    { fecha: addDays(pascua, -2), nombre: "Viernes Santo", ambito: "NACIONAL" },
    { fecha: addDays(pascua, 1), nombre: "Lunes de Pascua", ambito: "AUTONOMICO" },
  ];
  return lista
    .filter((h) => weekday(h.fecha) !== "D")
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
}

// La tarjeta «Generar cuadrante» de Inicio, lo que no es pintar (2026-10-10): el recuerdo de una
// generación lanzada, el cronómetro y qué se puede AFIRMAR cuando la respuesta no llega.
//
// Vive en client/lib (módulo .js real, testeable con node:test) y no dentro de Home.jsx porque un
// .jsx no se puede probar en Node (loader.js lo transpila en el navegador) y aquí hay decisiones
// que no pueden salir mal en silencio: decir «no se guardó» de una escritura que sí se guardó
// hace que alguien la lance otra vez, con otra propuesta del modelo, encima de la primera.
//
// El problema (V-64, medido el 2026-10-08): `generarCuadranteIA` tarda de uno a cinco minutos, y
// Apps Script mata la ejecución a los 6. Mientras tanto la tarjeta no cambiaba de texto; si el
// teléfono perdía la conexión, o la pestaña se recargaba, el botón volvía a estar activo con el
// servidor aún escribiendo (se llegaron a ver 62 guardias escritas tras recargar), y una respuesta
// perdida se presentaba como «no se sabe si se guardó». Aquí:
//  - se apunta en `localStorage` que se lanzó una generación de ese mes, y el botón de ESE mes no
//    se vuelve a ofrecer hasta que pase lo que puede durar una ejecución (`VENTANA_MS`);
//  - se hace una foto de las guardias del mes antes de lanzarla, para poder decir después, si la
//    respuesta no llega, si el cuadrante CAMBIÓ — que es lo único concluyente que se puede saber
//    desde el navegador;
//  - y se prohíbe decir «no se guardó» antes de que la ejecución haya muerto sí o sí.
//
// Nada de esto es una regla del dominio ni del servidor: es qué se enseña. El servidor sigue siendo
// quien decide, y una generación duplicada la sigue juzgando el validador como cualquier otra.

import { toISO, daysInMonth } from "../../v2/domain/calendar.js";

/** Apps Script mata la ejecución a los 6 minutos (V-64): ni antes se ofrece otra, ni se dice «no se guardó». */
export const VENTANA_MS = 6 * 60 * 1000;
/** Margen para «no se guardó»: el servidor empieza unos segundos DESPUÉS de que el cliente lance la petición. */
export const MARGEN_MS = 30 * 1000;
/** Cuánto se mantiene el botón bloqueado: la ventana y el margen, que es cuando por fin se puede decir «no se guardó». */
export const BLOQUEO_MS = VENTANA_MS + MARGEN_MS;
/** Cuánto se recuerda una generación lanzada: lo justo para poder comprobarla al volver; después se purga sola. */
const RETENCION_MS = 24 * 60 * 60 * 1000;
export const CLAVE_ALMACEN = "guardias_generacion";

const CODIGOS_GUARDIA = new Set(["G", "GF", "GP", "3P"]);

const dosCifras = (n) => String(n).padStart(2, "0");

/** «10:42», con la hora del teléfono (es lo que ve quien la lanzó). */
export function horaDe(ms) {
  const d = new Date(ms);
  return `${dosCifras(d.getHours())}:${dosCifras(d.getMinutes())}`;
}

/** «2:05» a partir de milisegundos transcurridos; nunca negativo. */
export function cronometro(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${dosCifras(s % 60)}`;
}

// ── La foto del mes ────────────────────────────────────────────────────────────────────────

/** FNV-1a de 32 bits en hexadecimal: una huella corta y estable de un texto, no una medida de seguridad. */
function huella(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Primer y último día del mes, en ISO. */
export function rangoDelMes(anio, mes) {
  return { desde: toISO(anio, mes, 1), hasta: toISO(anio, mes, daysInMonth(anio, mes)) };
}

/**
 * Las guardias (G, GF, GP, 3P) del mes de unas asignaciones, resumidas en `{n, firma}`. La firma es
 * una huella de las filas ordenadas, no un recuento: «reemplazar» puede dejar el mes con las mismas
 * guardias de número y distintas de contenido, y entonces contar no distinguiría una generación que
 * se guardó de una que no. Las celdas V/R/B no entran: la generación no las toca.
 */
export function instantanea(asignaciones, anio, mes) {
  const { desde, hasta } = rangoDelMes(anio, mes);
  const filas = (Array.isArray(asignaciones) ? asignaciones : [])
    .filter((a) => a && CODIGOS_GUARDIA.has(a.codigo) && a.fecha >= desde && a.fecha <= hasta)
    .map((a) => `${a.fecha}|${a.residenteId}|${a.codigo}`)
    .sort();
  return { n: filas.length, firma: huella(filas.join("\n")) };
}

/** Lee la foto del mes con `api`. Nunca lanza; si no se pudo leer devuelve `null` (y entonces no habrá «sí se guardó»). */
export async function fotoDelMes(api, anio, mes) {
  try {
    const { desde, hasta } = rangoDelMes(anio, mes);
    const r = await api.listAsignacionesRango(desde, hasta);
    return r && r.ok === true && Array.isArray(r.asignaciones) ? instantanea(r.asignaciones, anio, mes) : null;
  } catch {
    return null;
  }
}

// ── El recuerdo en localStorage ────────────────────────────────────────────────────────────
// `almacen` es el `localStorage` (o un doble en los tests; `null` si el navegador lo niega). Todo
// va en try/catch y degrada a «no hay recuerdo»: el modo privado, la cuota llena o el
// almacenamiento bloqueado no pueden impedir generar, solo quitan la ayuda.

const claveMes = (anio, mes) => `${anio}-${dosCifras(mes)}`;

function leerTodo(almacen) {
  try {
    const crudo = almacen && almacen.getItem(CLAVE_ALMACEN);
    const todo = crudo ? JSON.parse(crudo) : {};
    return todo && typeof todo === "object" && !Array.isArray(todo) ? todo : {};
  } catch {
    return {};
  }
}

function escribirTodo(almacen, todo) {
  try {
    if (!almacen) return false;
    if (Object.keys(todo).length === 0) almacen.removeItem(CLAVE_ALMACEN);
    else almacen.setItem(CLAVE_ALMACEN, JSON.stringify(todo));
    return true;
  } catch {
    return false;
  }
}

const esFoto = (f) => Boolean(f) && Number.isInteger(f.n) && typeof f.firma === "string";
const esLanzamiento = (l) => Boolean(l) && typeof l === "object" && Number.isFinite(l.t);

/**
 * Apunta que se acaba de lanzar una generación de ese mes. `antes` es la foto previa (o null).
 * Devuelve false si no se pudo guardar; quien llama sigue igual, sin el recuerdo.
 */
export function registrarLanzamiento(almacen, { anio, mes, ahora, antes = null, fase = "obligatorias", modo = "completar" }) {
  const todo = leerTodo(almacen);
  for (const k of Object.keys(todo)) if (!esLanzamiento(todo[k]) || ahora - todo[k].t > RETENCION_MS) delete todo[k];
  todo[claveMes(anio, mes)] = { t: ahora, antes: esFoto(antes) ? antes : null, fase, modo };
  return escribirTodo(almacen, todo);
}

/** Lo apuntado de ese mes, vigente o no (se necesita para comprobar después de la ventana), o null. */
export function lanzamientoDe(almacen, anio, mes) {
  const l = leerTodo(almacen)[claveMes(anio, mes)];
  if (!esLanzamiento(l)) return null;
  return { t: l.t, antes: esFoto(l.antes) ? l.antes : null, fase: l.fase, modo: l.modo };
}

/**
 * La generación de ese mes que aún puede estar ejecutándose, o null: la apuntada hace menos de
 * `BLOQUEO_MS` (la ventana más el margen: hasta entonces `veredictoSinRespuesta` no dice «no se
 * guardó», y ofrecer el botón antes dejaría relanzar con la ejecución anterior aún viva). Una hora del futuro (el reloj del teléfono se atrasó) no cuenta: bloquearía el botón
 * sin más fin que el de volver a poner la hora bien.
 */
export function lanzamientoVigente(almacen, anio, mes, ahora) {
  const l = lanzamientoDe(almacen, anio, mes);
  if (!l) return null;
  const pasado = ahora - l.t;
  return pasado >= 0 && pasado < BLOQUEO_MS ? l : null;
}

/** Olvida lo apuntado de ese mes: el servidor ya contestó, la ejecución terminó y no queda nada que esperar. */
export function olvidarLanzamiento(almacen, anio, mes) {
  const todo = leerTodo(almacen);
  if (!(claveMes(anio, mes) in todo)) return true;
  delete todo[claveMes(anio, mes)];
  return escribirTodo(almacen, todo);
}

// ── Qué se puede afirmar cuando no llega la respuesta ───────────────────────────────────────

/**
 * El veredicto sobre una generación cuya respuesta no llegó, a partir de lo que se ve AHORA en el
 * servidor (`estado` del mes y su foto actual) y de lo apuntado al lanzarla. Solo afirma lo
 * concluyente:
 *  - «guardado»: la foto del mes cambió desde que se lanzó. Es la única prueba de escritura que hay
 *    desde aquí (si otra persona editó a la vez el mes, el aviso también es cierto: ha cambiado).
 *  - «publicado»: el mes está publicado (dato del estado, cierto pase lo que pase con la generación).
 *  - «sin-cambios»: la foto es la misma y ya pasó la ventana más un margen — la ejecución está
 *    muerta, no puede escribir nada más. SOLO entonces se dice que no se guardó.
 *  - «en-curso»: la foto es la misma pero aún puede estar ejecutándose: «vuelve a mirar», nunca «no se guardó».
 *  - «indeterminado»: no hay foto previa o no se pudo leer el mes, y la ventana ya pasó: no se afirma nada.
 *
 * @param {object} p
 *   - lanzamiento: lo de `lanzamientoDe` (o null si no consta)
 *   - ahora: ms
 *   - estado: "BORRADOR"|"VALIDADO"|"PUBLICADO"|null (null si la lectura falló)
 *   - actual: foto de ahora, o null si la lectura falló
 *   - etiquetaMes: «octubre de 2026», para el texto
 * @returns {{conclusion: string, texto: string, vuelveAMirarA: string|null}}
 */
export function veredictoSinRespuesta({ lanzamiento, ahora, estado, actual, etiquetaMes }) {
  const l = lanzamiento && esLanzamiento(lanzamiento) ? lanzamiento : null;
  const antes = l && esFoto(l.antes) ? l.antes : null;
  const cambio = antes && esFoto(actual) ? antes.firma !== actual.firma : null;
  const publicado = estado === "PUBLICADO";
  const transcurrido = l ? ahora - l.t : null;
  const vuelveAMirarA = l ? horaDe(l.t + VENTANA_MS + MARGEN_MS) : null;
  const resumen = (n) => (esFoto(n) ? ` (${n.n} guardias)` : "");

  if (cambio === true) {
    return {
      conclusion: "guardado",
      texto: `Sí se guardó: el cuadrante de ${etiquetaMes} ha cambiado desde que se lanzó la generación${resumen(actual)}. `
        + `Lo que se perdió por el camino fue solo la respuesta${publicado ? ", y el mes ya está publicado" : ""}. Revísalo en el cuadrante.`,
      vuelveAMirarA,
    };
  }
  if (publicado) {
    return {
      conclusion: "publicado",
      texto: `El cuadrante de ${etiquetaMes} ya está publicado, y la generación no escribe en un mes publicado. `
        + "No hace falta volver a generarlo.",
      vuelveAMirarA,
    };
  }
  const terminada = transcurrido !== null && transcurrido >= VENTANA_MS + MARGEN_MS;
  if (cambio === false && terminada) {
    return {
      conclusion: "sin-cambios",
      texto: `Han pasado más de 6 minutos (Google corta la ejecución a los 6) y el cuadrante de ${etiquetaMes} sigue igual que antes de generar: `
        + "no se guardó nada. Puedes volver a generarlo.",
      vuelveAMirarA,
    };
  }
  if (terminada) {
    return {
      conclusion: "indeterminado",
      texto: `No se ha podido comprobar si la generación se guardó${antes ? "" : " (no hay foto previa del mes)"}. `
        + `Míralo en el cuadrante de ${etiquetaMes} antes de volver a generar.`,
      vuelveAMirarA,
    };
  }
  return {
    conclusion: "en-curso",
    texto: "No ha llegado la respuesta, pero la generación puede seguir en curso en el servidor"
      + (vuelveAMirarA ? ` (termina como mucho hacia las ${vuelveAMirarA})` : "")
      + `. Vuelve a mirar pasado un rato: si el cuadrante de ${etiquetaMes} cambia, se guardó.`,
    vuelveAMirarA,
  };
}

/**
 * Relee el mes y emite el veredicto de `veredictoSinRespuesta`. Las dos lecturas van a la vez (una
 * sola petición al /exec, S-9). Nunca lanza: una lectura que falla deja `estado`/`actual` en null y
 * el veredicto se queda en lo que sí se puede decir.
 */
export async function comprobarTrasFallo({ api, anio, mes, lanzamiento, ahora, etiquetaMes }) {
  let estado = null;
  let actual = null;
  try {
    const { desde, hasta } = rangoDelMes(anio, mes);
    const [rEstado, rAsig] = await Promise.all([api.estadoCuadrante(anio, mes), api.listAsignacionesRango(desde, hasta)]);
    if (rEstado && rEstado.ok === true && typeof rEstado.estado === "string") estado = rEstado.estado;
    if (rAsig && rAsig.ok === true && Array.isArray(rAsig.asignaciones)) actual = instantanea(rAsig.asignaciones, anio, mes);
  } catch {
    /* sin lectura: el veredicto se limita a lo que no necesita ninguna */
  }
  // La hora se toma DESPUÉS de las lecturas: tardan segundos, y el veredicto habla del momento en que se miró.
  return veredictoSinRespuesta({ lanzamiento, ahora: ahora === undefined ? Date.now() : ahora, estado, actual, etiquetaMes });
}

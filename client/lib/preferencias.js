// Lo que Preferencias (client/screens/Prefs.jsx) decide sin pintar nada: qué hay guardado del mes
// en pantalla, si ya ha llegado del servidor, y si lo que hay en pantalla difiere de ello.
//
// Vive aquí y no en el .jsx porque cada una de estas decisiones ya ha perdido datos de verdad:
//
//  - **Guardar antes de que llegue lo guardado PISA lo guardado.** Mientras `misPreferencias` no ha
//    respondido, la pantalla enseña los valores por defecto; un Guardar en ese hueco (tras ◀/▶, o
//    nada más abrir la pantalla) escribía 4 guardias, sin fechas, sin notas y «no» al tercer puesto
//    ENCIMA de lo que la persona tenía guardado en ese mes. De ahí la fase de carga: solo con la
//    carga del MES EN PANTALLA terminada se puede editar y guardar, y si falla no se puede guardar
//    (seguiría pisándolo) pero sí reintentar.
//  - **Lo escrito durante la carga se perdía al llegar la respuesta**, que lo sustituía sin avisar.
//    Con la misma fase la pantalla no deja escribir hasta tener lo guardado.
//  - **Lo no guardado se perdía sin avisar** al cambiar de mes, de pestaña, ir atrás o recargar. Para
//    preguntar antes hace falta saber si hay algo que perder, comparando con lo último cargado o
//    guardado, y con el mismo criterio con el que el servidor lo guarda (`router.js:validPrefs`):
//    ni el orden de las fechas ni un espacio al final de las notas son un cambio, porque el
//    servidor ordena las unas y recorta las otras — preguntar por ellos sería un falso aviso.

/** Lo que enseña la pantalla de un mes sin nada guardado. Siempre un objeto nuevo: se edita. */
export function prefsPorDefecto() {
  return {
    maxGuardias: 4, // las 4 obligatorias; 5 o 6 = «quiero hacer más» (P-17: el generador las reparte en la fase 2)
    fechasEvitar: [],
    notas: "",
    tercerPuesto: false, // «¿Deseas hacer tercer puesto este mes?» (P-16/V-55): por mes, y por defecto no
  };
}

/** Las fechas de `fechasEvitar` que pertenecen al mes en pantalla (las demás no se ven ni se mandan). */
export function fechasDelMes(lista, anio, mes) {
  const prefijo = `${anio}-${String(mes).padStart(2, "0")}-`;
  return (Array.isArray(lista) ? lista : []).filter((f) => typeof f === "string" && f.startsWith(prefijo));
}

/**
 * Lo que devuelve `misPreferencias` (`prefs`, o `null` si ese mes no hay nada) en la forma de la
 * pantalla. Solo las fechas DEL MES: una fila legada con una fecha de otro mes (escrita por un
 * servidor anterior a la validación) no se ve en la rejilla, no se puede quitar, y el servidor
 * nuevo rechazaría cada Guardar por ella — sin salida desde la app. Un campo vacío en la hoja llega
 * sin valor y cae al de por defecto: con `notas` indefinidas el cuadro de texto dejaba de estar
 * controlado, y con `maxGuardias` indefinido el contador sumaba hasta NaN.
 */
export function prefsDelServidor(prefs, anio, mes) {
  const base = prefsPorDefecto();
  const p = prefs && typeof prefs === "object" ? prefs : {};
  return {
    ...base,
    ...p, // lo que la pantalla no edita viaja tal cual; el servidor solo guarda su lista blanca
    maxGuardias: Number.isInteger(p.maxGuardias) ? p.maxGuardias : base.maxGuardias,
    fechasEvitar: fechasDelMes(p.fechasEvitar, anio, mes),
    notas: typeof p.notas === "string" ? p.notas : base.notas,
    tercerPuesto: p.tercerPuesto === true,
  };
}

/** Lo que se manda a `guardarPreferencias` (y lo que pasa a ser «lo guardado» si el servidor dice ok). */
export function prefsParaGuardar(prefs, anio, mes) {
  return { ...prefs, fechasEvitar: fechasDelMes(prefs.fechasEvitar, anio, mes) };
}

// ── La carga del mes ──────────────────────────────────────────────────────────────────────────
// `{anio, mes, fase, guardadas, error}`. `fase`: "cargando" | "lista" | "error". `guardadas` son las
// preferencias del mes tal como están en el servidor (las cargadas, o las últimas guardadas con
// éxito), y solo existen en fase "lista".

/** La carga recién empezada de un mes: aún no se sabe qué hay guardado. */
export function cargaEmpezada(anio, mes) {
  return { anio, mes, fase: "cargando", guardadas: null, error: null };
}

/**
 * La carga terminada con la respuesta de `misPreferencias`. Un `ok:true` SIN el campo `prefs` (que
 * el servidor siempre manda, aunque sea `null`) no dice qué hay guardado: es un fallo, no «nada
 * guardado» — tratarlo como vacío volvería a dejar guardar los valores por defecto encima.
 */
export function cargaTerminada(anio, mes, respuesta) {
  if (respuesta && respuesta.ok === true && respuesta.prefs !== undefined) {
    return { anio, mes, fase: "lista", guardadas: prefsDelServidor(respuesta.prefs, anio, mes), error: null };
  }
  const error = respuesta && respuesta.ok === false ? respuesta.error : "la respuesta no trae tus preferencias";
  return { anio, mes, fase: "error", guardadas: null, error: String(error || "sin respuesta") };
}

/**
 * La fase de la carga PARA EL MES EN PANTALLA. Una carga de otro mes cuenta como "cargando": entre
 * que cambia el mes y el efecto que pide el nuevo hay un render con la cabecera nueva y la carga del
 * mes anterior, y en él la pantalla enseña aún lo del mes anterior — guardar ahí lo escribiría en el
 * mes nuevo.
 */
export function faseDe(carga, anio, mes) {
  if (!carga || carga.anio !== anio || carga.mes !== mes) return "cargando";
  return carga.fase;
}

/** ¿Se puede editar y guardar? Solo con lo guardado del mes en pantalla ya en la mano. */
export function sePuedeEditar(carga, anio, mes) {
  return faseDe(carga, anio, mes) === "lista";
}

/**
 * Tras un `guardarPreferencias` con ok: lo enviado pasa a ser lo guardado. Si entretanto la carga es
 * ya de otro mes (o se está recargando), no se toca: lo enviado era del mes anterior.
 */
export function guardadoConfirmado(carga, anio, mes, enviadas) {
  if (faseDe(carga, anio, mes) !== "lista") return carga;
  return { ...carga, guardadas: enviadas };
}

/** Las preferencias en la forma en que el servidor las guarda, para compararlas (ver cabecera). */
function huella(p) {
  const prefs = p || {};
  const fechas = [...new Set(Array.isArray(prefs.fechasEvitar) ? prefs.fechasEvitar : [])].sort();
  return JSON.stringify([
    Number(prefs.maxGuardias),
    fechas,
    String(prefs.notas == null ? "" : prefs.notas).trim(),
    prefs.tercerPuesto === true,
  ]);
}

/** ¿Guardar `a` y guardar `b` dejarían lo mismo en el servidor? */
export function mismasPrefs(a, b) {
  return huella(a) === huella(b);
}

/**
 * ¿Hay en pantalla algo que se perdería al salir? Solo con la carga del mes lista: mientras carga o
 * tras un fallo no se puede editar, así que lo que haya en pantalla son los valores por defecto y no
 * hay nada que perder.
 */
export function hayCambiosSinGuardar(carga, anio, mes, enPantalla) {
  if (!sePuedeEditar(carga, anio, mes)) return false;
  return !mismasPrefs(carga.guardadas, enPantalla);
}

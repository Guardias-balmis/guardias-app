// Validación del tercer puesto (INV-8, spec.md §5). El 3P es siempre voluntario y se
// registra aparte. Cuatro reglas: (a) solo voluntarios; (b) rotación de días por
// residente (7 días L-D distintos antes de repetir, acumula entre meses, reinicia al
// completar el ciclo); (c) equidad ≤1 entre voluntarios al cierre del año de residencia;
// (d) prioridad a los días con R1 de "mochila". El 3P no computa en la equidad de
// guardias obligatorias (eso lo garantiza tally excluyendo 3P; aquí no se re-verifica).
//
// Las CUATRO son `aviso` (decisión V-18, que extiende V-14): ninguna impide validar. Las dos
// que aún eran `error` —8a, 3P a quien no consta voluntario, y 8b, repetir día de semana— lo
// dejaron de ser por el mismo motivo estructural que el resto: su causa no siempre vive en el
// cuadrante del mes. Un 3P de alguien que se apuntó después, o un ciclo que arrastra de meses
// que ya nadie va a reabrir, no se arregla moviendo una celda; y bloquear por ellas dejaría al
// servicio sin cuadrante justo en la regla más blanda que tiene la normativa («será siempre
// voluntario»). Entran en `EQUITY_INVARIANTS` de cuadrante.js, así que validar con avisos de
// INV-8 sigue exigiendo la confirmación explícita de la UI.

import { weekday, compareISO, addDays, addMonths, addYears, datesOfMonth } from "./calendar.js";
import { levelOn, periodsOfResident } from "./residents.js";

const aviso = (detalle, extra = {}) => ({ invariante: "INV-8", severidad: "aviso", detalle, ...extra });

/**
 * Meses de permanencia que asume quien se apunta al 3P (decisión V-18). El 3P es voluntario y
 * cada uno empieza el mes que quiere, pero la rotación L-D solo tiene sentido si se sostiene:
 * apuntarse y salirse a las tres semanas deja el ciclo a medias y la equidad de 8c sin con
 * quién compararse. Vive aquí, y no en el servidor ni en la pantalla, para que el texto que
 * acepta el residente y la regla que aplica el backend no puedan divergir.
 */
export const THIRD_POST_PERMANENCIA_MESES = 4;

/** Último día que cubre el compromiso de permanencia de quien se apuntó el `desde`. */
export function thirdPostCommitmentEnd(desde) {
  return addDays(addMonths(desde, THIRD_POST_PERMANENCIA_MESES), -1);
}

/** ¿Puede ya retirarse del 3P quien se apuntó el `desde`? (decisión V-18) */
export function canWithdrawThirdPost(desde, hoy) {
  return compareISO(hoy, thirdPostCommitmentEnd(desde)) > 0;
}

const inMonth = (fecha, mes, anio) => Number(fecha.slice(0, 4)) === anio && Number(fecha.slice(5, 7)) === mes;
const inRange = (f, a, b) => compareISO(f, a) >= 0 && compareISO(f, b) <= 0;

/**
 * @param {object} ctx { mes, anio, residentes, asignaciones, voluntarios3P, historial3P, periodosVoluntario3P? }
 *   - asignaciones: del mes (incluye 3P y guardias G/GF/GP para detectar mochila)
 *   - voluntarios3P: los voluntarios ACTIVOS ahora, como `string[]` de ids o como
 *     `{residenteId, desde}[]`. Con `desde` (lo que manda la tabla `voluntarios3P`) el ciclo L-D
 *     de INV-8b **se recorta a partir de esa fecha**, que es lo que exige V-18(b): cada residente
 *     empieza su ciclo el día que se apunta. Sin él —los tests que solo comprueban otras reglas—
 *     no se recorta nada. El recorte tiene que vivir AQUÍ y no en el invocador: el histórico que
 *     se lee es común a 8b y a 8c (que sí necesita el año de residencia entero, más antiguo), así
 *     que recortarlo al leerlo rompería 8c, y no recortarlo mete en el ciclo de alguien los 3P que
 *     hizo antes de apuntarse. Misma tolerancia de dos formas que `calendar.js:isHoliday`.
 *   - historial3P: { id: [fechas ISO de 3P previas, cronológicas] }
 *   - periodosVoluntario3P?: `{residenteId, desde, hasta?}[]` — TODOS los periodos de
 *     voluntariado, activos e históricos (decisión V-28, corrige INV-8a). Sin este campo, 8a cae
 *     al criterio antiguo «¿lo es AHORA?» (`voluntarios3P`); con él, juzga «¿lo era ESE día?»,
 *     que es lo correcto para un mes que no es el actual — ver el comentario en la propia regla.
 * @returns {{invariante:'INV-8', severidad:string, fecha?:string, residenteId?:string, detalle:string}[]}
 */
export function validateThirdPost(ctx) {
  const { mes, anio, residentes, asignaciones = [], voluntarios3P = [], historial3P = {}, periodosVoluntario3P = null } = ctx;
  const byId = new Map(residentes.map((r) => [r.id, r]));
  const voluntarios = new Set(voluntarios3P.map((v) => (typeof v === "string" ? v : v && v.residenteId)));
  const altaDe = new Map(voluntarios3P.filter((v) => v && typeof v !== "string" && v.desde).map((v) => [v.residenteId, v.desde]));
  const violations = [];

  const thisMonth3P = asignaciones.filter((a) => a.codigo === "3P").sort((a, b) => compareISO(a.fecha, b.fecha));

  // ── INV-8a: 3P solo a voluntarios ──
  // «¿Era voluntario ESE día?», no «¿lo es AHORA?» (decisión V-28). Sin `periodosVoluntario3P`
  // —los tests que no lo pasan, y cualquier invocador viejo— se conserva el criterio anterior
  // (`voluntarios`, la lista de HOY) para no romper nada existente; el corregido solo se activa
  // cuando el invocador provee la historia completa de periodos, activos y retirados.
  const eraVoluntarioEl = (residenteId, fecha) => {
    if (periodosVoluntario3P === null) return voluntarios.has(residenteId);
    return periodosVoluntario3P.some((p) => p.residenteId === residenteId
      && compareISO(fecha, p.desde) >= 0
      && (!p.hasta || compareISO(fecha, p.hasta) <= 0));
  };
  for (const a of thisMonth3P) {
    if (!eraVoluntarioEl(a.residenteId, a.fecha)) {
      violations.push(aviso(`3P asignado a ${a.residenteId}, que no consta en la lista de voluntarios`, { fecha: a.fecha, residenteId: a.residenteId }));
    }
  }

  // ── INV-8b: rotación de días por residente ──
  const idsCon3P = new Set([...Object.keys(historial3P), ...thisMonth3P.map((a) => a.residenteId)]);
  for (const id of idsCon3P) {
    const historial = (historial3P[id] || []).slice().sort(compareISO);
    const propiasMes = thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha);
    // El ciclo arranca en el alta del residente (V-18b): lo que hiciera antes de apuntarse —o en
    // una etapa anterior, si se retiró y volvió— no cuenta. Sin recortar, esos 3P añaden
    // repeticiones falsas y, peor, pueden completar los 7 días y reiniciar el ciclo, tapando una
    // repetición real. El histórico llega sin recortar a propósito: 8c lo necesita entero.
    const alta = altaDe.get(id);
    const combinadas = historial.concat(propiasMes).filter((f) => !alta || compareISO(f, alta) >= 0);
    let cycle = new Set();
    for (const fecha of combinadas) {
      const wd = weekday(fecha);
      if (cycle.has(wd)) {
        if (inMonth(fecha, mes, anio)) {
          violations.push(aviso(`${id} repite ${wd} en 3P el ${fecha} sin completar el ciclo de 7 días`, { fecha, residenteId: id }));
        }
        // no se reinicia el ciclo por una repetición; se sigue evaluando
      } else {
        cycle.add(wd);
        if (cycle.size === 7) cycle = new Set(); // ciclo completo → se reinicia
      }
    }
  }

  // ── INV-8d: prioridad mochila ──
  const days = datesOfMonth(anio, mes);
  const mochilaDays = new Set();
  for (const a of asignaciones) {
    if (!["G", "GF", "GP"].includes(a.codigo)) continue;
    const r = byId.get(a.residenteId);
    if (r && levelOn(periodsOfResident(r), a.fecha) === "R1") mochilaDays.add(a.fecha);
  }
  const days3P = new Set(thisMonth3P.map((a) => a.fecha));
  const uncoveredMochila = [...mochilaDays].filter((d) => !days3P.has(d)).sort(compareISO);
  const misplaced = thisMonth3P.filter((a) => !mochilaDays.has(a.fecha)); // 3P en día sin R1
  if (uncoveredMochila.length && misplaced.length) {
    const dia = uncoveredMochila[0];
    const culpable = misplaced[0];
    // AVISO: el 3P es voluntario; la mala priorización se señala pero no impide VALIDAR.
    violations.push(aviso(`Existe 3P el ${culpable.fecha} (día sin R1) mientras el día de mochila ${dia} queda sin 3P: los 3P deben cubrir primero los días con R1`, { fecha: dia, residenteId: culpable.residenteId }));
  }

  // ── INV-8c: equidad al cierre del año de residencia ──
  // Agrupa voluntarios que cierran su año de residencia ESTE mes, por cohorte.
  const cerrandoPorCohorte = new Map();
  for (const id of voluntarios) {
    const r = byId.get(id);
    if (!r) continue;
    const win = closingWindowThisMonth(r, mes, anio);
    if (!win) continue;
    const acumulado = countThirdPostInWindow(id, historial3P, thisMonth3P, win);
    const cohorte = Number(r.fechaInicio.slice(0, 4));
    if (!cerrandoPorCohorte.has(cohorte)) cerrandoPorCohorte.set(cohorte, []);
    cerrandoPorCohorte.get(cohorte).push({ id, acumulado });
  }
  for (const [, grupo] of cerrandoPorCohorte) {
    if (grupo.length < 2) continue;
    const cuentas = grupo.map((x) => x.acumulado);
    const max = Math.max(...cuentas), min = Math.min(...cuentas);
    if (max - min > 1) {
      const maxId = grupo.find((x) => x.acumulado === max).id;
      // Equidad → aviso, nunca error (decisión V-14): es el mismo criterio que INV-3.
      violations.push(aviso(`Diferencia de 3P acumulados > 1 al cierre del año de residencia: ${grupo.map((x) => `${x.id}: ${x.acumulado}`).join(", ")}`, { residenteId: maxId }));
    }
  }

  return violations;
}

/**
 * Primer día de histórico de 3P que hace falta para evaluar INV-8 en este mes, o `null` si no
 * hace falta ninguno (nadie apuntado y nadie cerrando: 8a y 8d se resuelven solo con el mes).
 * Mismo papel que `rotationHistoryStart` (C-2) y `yearCloseHistoryStart`: el rango lo decide el
 * dominio, no el invocador.
 *
 * Son dos necesidades distintas y se toma la más antigua de las dos:
 *  - **8b (ciclo L-D)**: arranca el día en que cada residente SE APUNTÓ, no en un borde de
 *    calendario. Es literal de cómo funciona el 3P (decisión V-18): cada uno empieza el mes que
 *    quiere y por el día de semana que quiera, y el ciclo corre desde ahí. Por eso el `desde`
 *    del voluntariado no es un adorno del registro: es lo que acota esta lectura.
 *  - **8c (equidad al cierre)**: la ventana del año de residencia de quien lo cierre este mes,
 *    igual que INV-3.
 *
 * @param {{residenteId:string, desde:string}[]} voluntarios3P  los ACTIVOS
 * @param {{id:string, fechaInicio:string, fechaFin?:string}[]} residentes
 */
export function thirdPostHistoryStart(voluntarios3P = [], residentes = [], mes, anio) {
  const byId = new Map(residentes.map((r) => [r.id, r]));
  let min = null;
  const consider = (fecha) => { if (fecha && (min === null || compareISO(fecha, min) < 0)) min = fecha; };

  for (const v of voluntarios3P) {
    consider(v.desde);
    const r = byId.get(v.residenteId);
    const win = r ? closingWindowThisMonth(r, mes, anio) : null;
    if (win) consider(win.start);
  }
  return min;
}

/** Si el residente cierra un año de residencia dentro de [mes/anio], devuelve la ventana [inicio, cierre]. */
function closingWindowThisMonth(r, mes, anio) {
  for (let k = 1; k <= 4; k++) {
    const cierre = addDays(addYears(r.fechaInicio, k), -1);
    if (inMonth(cierre, mes, anio)) return { start: addYears(r.fechaInicio, k - 1), end: cierre };
  }
  return null;
}

function countThirdPostInWindow(id, historial3P, thisMonth3P, win) {
  const todas = (historial3P[id] || []).concat(thisMonth3P.filter((a) => a.residenteId === id).map((a) => a.fecha));
  return todas.filter((f) => inRange(f, win.start, win.end)).length;
}

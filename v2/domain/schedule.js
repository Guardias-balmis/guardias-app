// Generador determinista de cuadrante mensual (spec.md §5, decisión V-34). PURO: sin red, sin
// Sheets, sin React y sin dependencias — recibe el MISMO `ctx` que arma `buildMonthContext` y
// devuelve una propuesta de asignaciones. No la escribe en ningún sitio: quien la aplique pasa
// por `comprobar()`/`aplicar()` como si la hubiera pegado a mano, así que sigue vigente todo el
// guardarraíl de V-31 (reemplazo del mes, rechazo de fechas ajenas e ids inventados) y sigue
// mandando el validador — «la IA propone, el validador dispone» vale igual para esto, que no es
// más que otro proponente.
//
// LAS TRES REGLAS DE V-32, QUE SON LO QUE DECIDE EL DISEÑO. No son preferencias de estilo: se
// midieron el 2026-08-08 contra el juez real y cada una tiene un contraejemplo medido.
//   1. Se persigue el ACUMULADO DEL AÑO DE RESIDENCIA, nunca el mes. Equilibrar dentro del mes
//      da 0/6 al cierre anual: un mes perfectamente repartido encima de un acumulado torcido lo
//      deja igual de torcido. Por eso la métrica de cada residente arranca en SU aniversario y
//      no el día 1.
//   2. Se compara `total/f` y no `total`, con `f` = fracción de días disponibles (las bajas
//      descuentan). Igualar en crudo falla 0/6 en cuanto hay una baja, porque igualar en crudo a
//      quien vuelve de tres meses de baja es EXACTAMENTE lo que INV-3 penaliza: el juez lo lee
//      como 68,19 frente a 51. Dividiendo sube a 4/6.
//   3. Hace falta un operador que REASIGNE, no solo que intercambie: un intercambio conserva el
//      número de guardias de cada uno, así que un buscador de solo-swap no puede mover nunca el
//      eje `total`. Aquí `MOVER` es la mitad de los pasos por eso.
//
// DÍAS CONSECUTIVOS (INV-15): nadie hace dos guardias seguidas. Es restricción dura y se poda
// por construcción, igual que INV-5 e INV-11 — las otras dos que producen `error`. La adyacencia
// se mira también contra el mes ANTERIOR (el histórico): la última guardia de septiembre veta el
// 1 de octubre, o la regla se cumpliría solo por dentro de cada mes y se rompería justo en el
// borde, que es donde nadie mira.
//
// Si ningún elegible puede coger el día sin encadenar, el puesto se queda SIN CUBRIR y se dice
// (`sinCubrir`, con `motivo: "descanso"`). No se rellena: proponerlo sería proponer algo ilegal
// —y algo que el validador va a marcar como error de todas formas—, y un día vacío al menos dice
// la verdad, que es que ese día no tiene solución legal con esta plantilla y hay que resolverlo
// fuera de la aplicación. El generador nunca propone lo que el validador rechaza.
//
// El juez de la equidad sigue siendo `equity.js` en el cierre; esto solo es quien propone. La
// función de coste de aquí IMITA a `validateResidencyYearClose` (mismos seis ejes, misma
// normalización, misma agrupación por cohorte) pero no lo llama: el validador juzga un cierre
// —solo habla en el mes del aniversario— y el generador necesita orientarse en CUALQUIER mes.
// Si algún día divergen, manda el validador y hay que corregir esto.

import { datesOfMonth, addDays, isHoliday, bridgesOfMonth, bridgesBetween, compareISO, trimesterWindow } from "./calendar.js";
import { periodsOfResident, levelOn, groupOf, periodOn } from "./residents.js";
import { tally } from "./tally.js";
import { absences, BLOQUEA_ASIGNACION, DESCUENTA_DISPONIBILIDAD } from "./absences.js";
import { availabilityFraction, DIMS, PROPORCIONAL } from "./equity.js";

// Los seis ejes y su normalización vienen de `equity.js`, no de una copia aquí: el generador
// tiene que perseguir EXACTAMENTE lo que el cierre le va a medir. La copia que había se quedó
// desfasada en cuanto `puentesLibres` pasó a normalizarse (V-27) y el generador estuvo
// optimizando un objetivo distinto del juez sin que ningún test fallara.
const EPS = 1e-9;
const VERANO = new Set([6, 7, 8]);

/**
 * PRNG determinista (LCG). `Math.random` está prohibido aquí: dos ejecuciones con el mismo `ctx`
 * y la misma semilla tienen que dar el MISMO cuadrante, o revisar una propuesta no significaría
 * nada y no se podría reproducir un reparto discutido.
 */
function rng(semilla) {
  let s = semilla >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * Código que le toca al día: GF si es festivo, GP si es la VÍSPERA de uno, G en el resto. Es la
 * regla que comprueba INV-12 leída al derecho — el generador no puede escribir un código que el
 * validador vaya a marcar como incoherente. Sin festivos cargados todo sale G, que es lo correcto
 * (S-4: los festivos son dato de entrada, jamás se deducen).
 */
function codigoDe(fecha, festivos) {
  if (isHoliday(fecha, festivos)) return "GF";
  if (isHoliday(addDays(fecha, 1), festivos)) return "GP";
  return "G";
}

const cohorteDe = (r) => Number(r.fechaInicio.slice(0, 4));

/**
 * Genera una propuesta de cuadrante para el mes de `ctx`.
 *
 * @param {object} ctx El mismo objeto que devuelve `buildMonthContext`. Se usan `mes`, `anio`,
 *   `residentes`, `asignaciones` (el HISTÓRICO; lo que caiga dentro del mes se descarta, ver
 *   abajo), `bloqueos` y `festivos`. `eventos` no se usa: INV-10 es aviso y su reparto es un
 *   sorteo documentado (V-20), no algo que deba inventar un generador.
 * @param {object} opciones
 *   - semilla: entero, cambia la propuesta sin cambiar su calidad esperada (permite pedir «otra»)
 *   - pasos: tope de iteraciones de la búsqueda local
 * @returns {{asignaciones: {fecha:string, residenteId:string, codigo:string}[], diagnostico: object}}
 */
export function generateMonth(ctx, opciones = {}) {
  const { mes, anio, residentes = [], asignaciones: historicoBruto = [], bloqueos = [], festivos = [] } = ctx;
  const { semilla = 1, pasos = 20000 } = opciones;

  const dias = datesOfMonth(anio, mes);
  const monthStart = dias[0];
  const monthEnd = dias[dias.length - 1];

  // El histórico se recorta a lo ANTERIOR al mes. `buildMonthContext` concatena histórico y mes,
  // y la pantalla además pide el histórico con 1-2 días de lookahead dentro del mes (contrato
  // C-1): si esas filas se colaran, contarían a la vez que la propuesta que estamos construyendo
  // para esos mismos días y el generador perseguiría un acumulado inflado. Se filtra AQUÍ y no se
  // confía en que el invocador lo haya hecho, que es el error que ya se pagó una vez en
  // `Generator.jsx`.
  const historico = historicoBruto.filter((a) => compareISO(a.fecha, monthStart) < 0);
  const historicoDe = new Map();
  for (const a of historico) {
    if (!historicoDe.has(a.residenteId)) historicoDe.set(a.residenteId, []);
    historicoDe.get(a.residenteId).push(a);
  }

  const puentesDelMes = bridgesOfMonth(anio, mes, festivos);

  // ── Quién puede coger guardia, y con qué ventana se le mide ────────────────────────────────
  // Se ordena por id: el resultado tiene que ser el mismo en cualquier motor de JS, y un empate
  // resuelto por orden de llegada del array haría que dos cargas distintas del mismo mes dieran
  // cuadrantes distintos.
  const activos = [];
  for (const r of [...residentes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const periodos = periodsOfResident(r);
    const nivelPorDia = new Map();
    let ancla = null;
    for (const f of dias) {
      const nivel = levelOn(periodos, f);
      nivelPorDia.set(f, nivel);
      if (ancla === null && groupOf(nivel) !== null) ancla = f;
    }
    if (ancla === null) continue; // ni un solo día asignable este mes (FINALIZADO o sin empezar)

    // La ventana es SU año de residencia en curso, anclado al primer día del mes en que está
    // activo — el mismo criterio de `projection.js` (V-23): con `monthStart` a secas, quien
    // empieza a mitad de mes no tendría ventana y se quedaría fuera de la equidad de su cohorte.
    const win = periodOn(periodos, ancla);
    if (!win) continue;

    const bajas = absences(bloqueos, { residenteId: r.id, motivos: DESCUENTA_DISPONIBILIDAD });
    activos.push({
      id: r.id,
      cohorte: cohorteDe(r),
      nivelPorDia,
      win,
      // `f` se mide sobre la ventana ENTERA del año, no sobre lo transcurrido: es lo que va a
      // dividir el juez en el cierre, así que perseguir otra cosa sería perseguir otro objetivo.
      // Una baja futura ya baja `f` hoy, y eso es correcto: marca el ritmo al que ese residente
      // debe acumular para acabar cuadrado.
      f: availabilityFraction(win, bajas),
      // Las mismas filas que descuentan disponibilidad en el juez. NO se reusa `vetados`, que
      // hoy da la misma lista pero responde a otra pregunta (BLOQUEA_ASIGNACION, INV-5): los
      // conjuntos de `absences.js` están separados a propósito y confundirlos es justo lo que
      // V-19 prohíbe.
      bajasDescuento: bajas,
      // Fin de la ventana de medida: su aniversario si cae dentro del mes, si no el fin de mes.
      medidaHasta: compareISO(win.end, monthEnd) < 0 ? win.end : monthEnd,
      historico: historicoDe.get(r.id) || [],
      // Días en que NO puede coger guardia: BAJA es el único motivo DURO (INV-5, V-8).
      vetados: new Set(diasCubiertosPor(absences(bloqueos, { residenteId: r.id, motivos: BLOQUEA_ASIGNACION }), dias)),
      // Guardias YA hechas antes del mes. Solo importa la víspera del día 1, pero se guardan
      // todas: un Set es más barato de leer que de recortar, y así la regla de adyacencia no
      // depende de que el invocador haya pedido el histórico con el borde justo.
      previas: new Set((historicoDe.get(r.id) || []).filter((x) => GUARDIA.has(x.codigo)).map((x) => x.fecha)),
      fechas: new Set(), // lo que le vaya asignando la búsqueda
    });
  }
  const porId = new Map(activos.map((a) => [a.id, a]));

  // ── Elegibilidad por día y puesto ──────────────────────────────────────────────────────────
  // Los dos pools son DISJUNTOS por construcción (un residente es Mayor o Pequeño ese día, nunca
  // las dos cosas), así que nadie puede acabar cubriendo los dos puestos del mismo día.
  const esVerano = VERANO.has(mes);
  const poolDe = (puesto, fecha) => activos.filter((a) => {
    if (a.vetados.has(fecha)) return false;                       // INV-5
    const nivel = a.nivelPorDia.get(fecha);
    if (groupOf(nivel) !== (puesto === "M" ? "MAYOR" : "PEQUENO")) return false;
    if (puesto === "P" && esVerano && nivel === "R1") return false; // INV-11
    return true;
  });

  /**
   * ¿Puede `a` coger `fecha` sin quedar con dos guardias seguidas? Mira el día anterior y el
   * siguiente, tanto en lo propuesto este mes como en el histórico (el borde con el mes anterior).
   * Se usa también DESPUÉS de mutar, para validar un movimiento: por eso pregunta por los vecinos
   * y nunca por `fecha` misma.
   */
  const tieneVecino = (a, fecha) => {
    const antes = addDays(fecha, -1), despues = addDays(fecha, 1);
    return a.fechas.has(antes) || a.previas.has(antes) || a.fechas.has(despues) || a.previas.has(despues);
  };

  // ── Métrica de un residente: acumulado del año + lo que lleve propuesto este mes ────────────
  // Se computa de una vez sobre [aniversario .. fin de la medida] en vez de sumar «acumulado +
  // mes» por separado, y eso NO es una simplificación: el doblete de borde (contrato C-1) empareja
  // el viernes del último día del mes anterior con el domingo de este, así que partir la ventana
  // lo perdería justo en el borde que S-5 existe para no perder.
  // El código de cada día del mes es fijo (depende solo del calendario), y `puentesPrevios` —los
  // puentes del año ya transcurrido que el residente no cubrió— depende solo del histórico, que
  // la búsqueda nunca toca. Las dos cosas se calculan UNA vez: dentro de `metrica` costaban un
  // `bridgesBetween` sobre medio año de calendario en cada uno de los ~40.000 pasos, y eran el
  // 95% del tiempo de generación (6,6 s → 0,2 s en el escenario peor medido).
  const codigoPorDia = new Map(dias.map((f) => [f, codigoDe(f, festivos)]));
  const puentesDelMesHasta = new Map();
  for (const a of activos) {
    a.puentesPrevios = bridgesBetween(a.win.start, addDays(monthStart, -1), festivos)
      .filter((p) => compareISO(p, a.win.start) >= 0 && !a.previas.has(p)).length;
    // Los puentes del mes que caen dentro de SU ventana de medida (recortada si cierra este mes).
    puentesDelMesHasta.set(a.id, puentesDelMes.filter((p) => compareISO(p, a.medidaHasta) <= 0));
  }

  // ── El trimestre en curso (INV-3 trimestral, V-13 — objetivo añadido en V-37) ───────────────
  // El cierre anual y el trimestral miden ventanas DISTINTAS, y perseguir solo la anual no trae
  // la otra: medido, el óptimo anual falla el trimestral en los seis escenarios del banco (17-33
  // avisos) porque nada le impide amontonar un trimestre y vaciar otro mientras el año cuadra.
  // Y no son incompatibles — pidiendo los dos salen los dos, 3/3 —, así que aquí se piden.
  //
  // La ventana que se persigue es el trimestre HASTA EL FIN DE ESTE MES, no el trimestre entero:
  // los meses que aún no existen no se pueden repartir, y equilibrar lo que va corriendo es lo
  // que deja el trimestre cuadrado el día que cierra. `trimesterWindow` la da el dominio, igual
  // que `quarterCloseWindow` se la da al router: aquí no se adivina ningún borde de trimestre.
  const trimestre = trimesterWindow(monthStart);
  const trimHasta = { start: trimestre.start, end: monthEnd };
  let diasTrim = 0;
  for (let d = trimHasta.start; compareISO(d, trimHasta.end) <= 0; d = addDays(d, 1)) diasTrim++;
  for (const a of activos) {
    // Lo que ya llevaba del trimestre antes de este mes es constante: la búsqueda no lo toca.
    a.trimPrevio = tally(a.historico, { start: trimHasta.start, end: addDays(monthStart, -1) }).total;
    // Disponibilidad DENTRO del trimestre en curso, que es distinta de la del año: quien está de
    // baja justo estos tres meses tiene `f` anual alta y `fTrim` baja, y es la segunda la que el
    // cierre trimestral le va a dividir.
    let disponibles = 0;
    for (let d = trimHasta.start; compareISO(d, trimHasta.end) <= 0; d = addDays(d, 1)) {
      if (compareISO(d, a.win.start) < 0 || compareISO(d, a.win.end) > 0) continue;
      if (a.bajasDescuento.some((b) => compareISO(d, b.desde) >= 0 && compareISO(d, b.hasta) <= 0)) continue;
      disponibles++;
    }
    a.fTrim = disponibles / diasTrim;
  }

  const metrica = (a) => {
    const t = tally([...a.historico, ...[...a.fechas].map((f) => ({ fecha: f, codigo: codigoPorDia.get(f) }))],
      { start: a.win.start, end: a.medidaHasta });
    // `puentesLibres` cuenta los puentes de su ventana que NO cubre: los del año ya transcurrido
    // (constantes) más los de este mes que la propuesta le deja libres.
    const delMes = puentesDelMesHasta.get(a.id).filter((p) => !a.fechas.has(p)).length;
    return {
      total: t.total, findes: t.finde, festivos: t.festivos,
      prefestivos: t.prefestivos, dobletes: t.dobletes,
      puentesLibres: a.puentesPrevios + delMes,
      // Guardias del trimestre en curso. Todo lo que propone la búsqueda cae dentro del mes, y el
      // mes cae entero dentro del trimestre, así que basta sumar el tamaño del Set: no hace falta
      // un segundo `tally` en cada uno de los ~40.000 pasos.
      trimestre: a.trimPrevio + a.fechas.size,
    };
  };

  // ── Coste: lo mismo que mide INV-3, por cohorte ────────────────────────────────────────────
  // Devuelve DOS números a propósito (igual que el banco de V-32). `duro` es lo que se pasa de
  // ±1 y llega a 0 exacto, que es lo que permite parar en cuanto hay solución; `guia` es la
  // dispersión total, que orienta cuando el duro ya está a 0 en un eje pero no en otro — pero
  // nunca llega a cero, así que mezclarlos dejaría el bucle sin condición de parada.
  const cohortes = new Map();
  for (const a of activos) {
    if (!cohortes.has(a.cohorte)) cohortes.set(a.cohorte, []);
    cohortes.get(a.cohorte).push(a);
  }
  // Una cohorte de uno no se compara con nadie, igual que en el validador.
  const comparables = [...cohortes.entries()].filter(([, g]) => g.length >= 2).map(([c]) => c);

  const costeCohorte = (cohorte, M) => {
    const grupo = cohortes.get(cohorte);
    let duro = 0, guia = 0;
    for (const eje of DIMS) {
      let mx = -Infinity, mn = Infinity, fMx = 1, fMn = 1;
      for (const a of grupo) {
        const v = PROPORCIONAL.has(eje) ? M[a.id][eje] / a.f : M[a.id][eje];
        if (v > mx) { mx = v; fMx = a.f; }
        if (v < mn) { mn = v; fMn = a.f; }
      }
      // La tolerancia es la del juez, `1/min(f)` del par (V-37): el ±1 es una guardia de verdad y
      // al dividir por la disponibilidad una guardia vale `1/f`. Con un 1 fijo aquí, el generador
      // se exigiría más de lo que el cierre le va a medir en cuanto alguien tenga `f` < 1 — que es
      // la misma clase de desajuste que ya costó que persiguiera otro `puentesLibres` que el juez.
      duro += Math.max(0, mx - mn - (PROPORCIONAL.has(eje) ? 1 / Math.min(fMx, fMn) : 1));
      guia += mx - mn;
    }
    // El cierre TRIMESTRAL: un solo eje (`total`), normalizado por la disponibilidad DEL TRIMESTRE
    // y no por la del año, y fuera quien no llegue a media disponibilidad (V-13).
    {
      let mx = -Infinity, mn = Infinity, fMx = 1, fMn = 1, n = 0;
      for (const a of grupo) {
        if (a.fTrim < 0.5) continue;
        const v = M[a.id].trimestre / a.fTrim;
        if (v > mx) { mx = v; fMx = a.fTrim; }
        if (v < mn) { mn = v; fMn = a.fTrim; }
        n++;
      }
      if (n >= 2) {
        duro += Math.max(0, mx - mn - 1 / Math.min(fMx, fMn));
        guia += mx - mn;
      }
    }
    return { duro, guia };
  };
  const peor = (x, y) => x.duro > y.duro + EPS || (Math.abs(x.duro - y.duro) <= EPS && x.guia > y.guia + EPS);

  // ── Siembra: el que menos lleva, primero ───────────────────────────────────────────────────
  // Greedy por `total/f` (regla 2 de V-32 desde el primer reparto, no solo en la búsqueda). Sin
  // esta siembra la búsqueda local parte de un reparto aleatorio y necesita un orden de magnitud
  // más de pasos para llegar al mismo sitio.
  const slots = [];
  const sinCubrir = [];
  for (const fecha of dias) {
    for (const puesto of ["M", "P"]) {
      const base = poolDe(puesto, fecha);
      if (!base.length) {
        sinCubrir.push({ fecha, puesto: puesto === "M" ? "Mayor" : "Pequeño", motivo: "sin elegibles" });
        continue;
      }
      // INV-15 poda el pool igual que INV-5 o INV-11, y si lo vacía el puesto se queda SIN
      // CUBRIR: proponer la guardia consecutiva sería proponer algo ilegal, y el generador no
      // propone nada que el validador vaya a marcar como error. Un día sin nadie dice la verdad
      // —«este día no tiene solución legal con esta plantilla»— y se arregla fuera de la app;
      // rellenarlo lo disfrazaría de cuadrante correcto.
      const pool = base.filter((a) => !tieneVecino(a, fecha));
      if (!pool.length) {
        sinCubrir.push({ fecha, puesto: puesto === "M" ? "Mayor" : "Pequeño", motivo: "descanso" });
        continue;
      }
      const elegido = pool.reduce((mejor, cand) => {
        const vc = metrica(cand).total / cand.f;
        const vm = metrica(mejor).total / mejor.f;
        // Empate → el id menor: sin desempate explícito el resultado dependería del orden del array.
        return vc < vm - EPS || (Math.abs(vc - vm) <= EPS && cand.id < mejor.id) ? cand : mejor;
      });
      elegido.fechas.add(fecha);
      slots.push({ fecha, puesto, id: elegido.id });
    }
  }

  // ── Búsqueda local ─────────────────────────────────────────────────────────────────────────
  const rnd = rng(semilla);
  const M = {};
  for (const a of activos) M[a.id] = metrica(a);
  const C = {};
  for (const c of comparables) C[c] = costeCohorte(c, M);
  const duroTotal = () => comparables.reduce((s, c) => s + C[c].duro, 0);

  // Parada por estancamiento. El tope de `pasos` solo se llega a gastar cuando el reparto NO se
  // puede cuadrar —alguien llega con tanta ventaja acumulada que un mes no basta para
  // compensarla—, y ahí seguir iterando no mejora nada: medido sobre 30 meses reales, la búsqueda
  // converge por debajo de 2.000 pasos o no converge nunca. Sin esto, el caso imposible costaba
  // 20.000 pasos para devolver exactamente el mismo cuadrante.
  const ESTANCAMIENTO = 2000;
  let aceptados = 0;
  let desdeLaUltimaMejora = 0;
  let mejorCoste = Infinity;
  for (let k = 0; k < pasos && slots.length && duroTotal() > EPS; k++) {
    if (desdeLaUltimaMejora >= ESTANCAMIENTO) break;
    desdeLaUltimaMejora++;
    const a = slots[(rnd() * slots.length) | 0];
    // MOVER la mitad de los pasos es imprescindible (regla 3 de V-32): un intercambio conserva el
    // número de guardias de cada uno, así que sin mover el eje `total` es inalcanzable.
    const mover = rnd() < 0.5;
    const actual = porId.get(a.id);

    let otro, b = null;
    if (mover) {
      // La adyacencia se filtra ANTES de mutar: quien ya tiene el día de al lado no es candidato.
      const cand = poolDe(a.puesto, a.fecha).filter((x) => x.id !== a.id && !tieneVecino(x, a.fecha));
      if (!cand.length) continue;
      otro = cand[(rnd() * cand.length) | 0];
    } else {
      b = slots[(rnd() * slots.length) | 0];
      if (b.puesto !== a.puesto || b.id === a.id) continue;
      otro = porId.get(b.id);
      // El intercambio tiene que dejar a los dos en un día en que siguieran siendo elegibles.
      if (!poolDe(a.puesto, b.fecha).some((x) => x.id === a.id)) continue;
      if (!poolDe(b.puesto, a.fecha).some((x) => x.id === b.id)) continue;
    }

    // Aplica, mide, y deshace si empeora.
    actual.fechas.delete(a.fecha); otro.fechas.add(a.fecha);
    if (!mover) { otro.fechas.delete(b.fecha); actual.fechas.add(b.fecha); }

    // El intercambio se comprueba DESPUÉS de mutar: cada uno suelta un día y coge otro, así que
    // la adyacencia solo se puede juzgar sobre el estado resultante. Si el movimiento crearía dos
    // guardias seguidas se deshace, pase lo que pase con el coste: es restricción, no preferencia.
    if (!mover && (tieneVecino(otro, a.fecha) || tieneVecino(actual, b.fecha))) {
      actual.fechas.add(a.fecha); otro.fechas.delete(a.fecha);
      otro.fechas.add(b.fecha); actual.fechas.delete(b.fecha);
      continue;
    }

    const previoA = M[actual.id], previoB = M[otro.id];
    M[actual.id] = metrica(actual); M[otro.id] = metrica(otro);
    const tocadas = [...new Set([actual.cohorte, otro.cohorte])].filter((c) => comparables.includes(c));
    const antes = tocadas.reduce((x, c) => ({ duro: x.duro + C[c].duro, guia: x.guia + C[c].guia }), { duro: 0, guia: 0 });
    const nuevos = tocadas.map((c) => costeCohorte(c, M));
    const desp = nuevos.reduce((x, y) => ({ duro: x.duro + y.duro, guia: x.guia + y.guia }), { duro: 0, guia: 0 });

    if (peor(desp, antes)) {
      actual.fechas.add(a.fecha); otro.fechas.delete(a.fecha);
      if (!mover) { otro.fechas.add(b.fecha); actual.fechas.delete(b.fecha); }
      M[actual.id] = previoA; M[otro.id] = previoB;
    } else {
      tocadas.forEach((c, i) => (C[c] = nuevos[i]));
      if (mover) a.id = otro.id;
      else { const t = a.id; a.id = b.id; b.id = t; }
      aceptados++;
      // Solo una mejora ESTRICTA reinicia el contador: aceptar movimientos de coste igual es lo
      // que deja a la búsqueda recorrer mesetas, pero si solo hay meseta ya no está avanzando.
      const coste = comparables.reduce((s, c) => s + C[c].duro + C[c].guia, 0);
      if (coste < mejorCoste - EPS) { mejorCoste = coste; desdeLaUltimaMejora = 0; }
    }
  }

  // ── Salida ─────────────────────────────────────────────────────────────────────────────────
  // Ordenada por fecha y puesto: una propuesta que cambia de orden entre ejecuciones es
  // imposible de comparar a ojo con la anterior.
  const asignaciones = slots
    .slice()
    .sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.puesto < y.puesto ? -1 : 1))
    .map((s) => ({ fecha: s.fecha, residenteId: s.id, codigo: codigoDe(s.fecha, festivos) }));

  return {
    asignaciones,
    diagnostico: {
      // Días que el generador NO ha podido cubrir por falta de gente elegible. No es un fallo del
      // buscador y no se puede «mejorar» con más pasos: ese día no había nadie. Se dice para que
      // quien mire la propuesta sepa que el INV-1 que va a saltar viene de la plantilla.
      sinCubrir,
      cohortesComparadas: comparables.length,
      pasosAceptados: aceptados,
      // `duro` a 0 significa «los seis ejes dentro de ±1 en todas las cohortes comparables», que
      // es exactamente lo que pide INV-3. No es una promesa sobre el cierre: el cierre mide el año
      // entero y aquí solo se ha decidido un mes.
      coste: comparables.reduce((s, c) => s + C[c].duro, 0),
      residentes: activos.map((a) => ({
        id: a.id, cohorte: a.cohorte, guardiasDelMes: a.fechas.size,
        disponibilidad: Math.round(a.f * 100) / 100, acumulado: M[a.id],
      })),
    },
  };
}

const GUARDIA = new Set(["G", "GF", "GP"]);

/** Los días del mes cubiertos por alguno de esos bloqueos. */
function diasCubiertosPor(bloqueos, dias) {
  const out = [];
  for (const f of dias) {
    if (bloqueos.some((b) => compareISO(f, b.desde) >= 0 && compareISO(f, b.hasta) <= 0)) out.push(f);
  }
  return out;
}

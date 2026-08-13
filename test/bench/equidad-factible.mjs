// Banco de medición de la factibilidad de INV-3 (decisión V-32). NO es un test y NO entra en
// `npm test` a propósito: es una búsqueda aleatorizada que tarda entre segundos y minutos, y la
// suite del repo corre en un segundo. Lo determinista de esta medición está fijado aparte, en
// `test/equidad-factible.test.js`.
//
//   node test/bench/equidad-factible.mjs
//
// QUÉ PREGUNTA CONTESTA. El «±1 en seis ejes» de INV-3, ¿es alcanzable? Si no lo fuera, dejaría
// de ser una restricción que perseguir y pasaría a ser un objetivo aproximado, y el diseño de
// cualquier generador —de IA o determinista— cambiaría entero. Medido el 2026-08-08 por tres
// implementaciones independientes: SÍ es alcanzable, con holgura, en todos los escenarios
// realistas (base, bajas largas, dos bajas simultáneas, cohortes de 2). Lo que NO es alcanzable
// es el 4-6 mensual de INV-2, y eso es aritmética (ver el test hermano).
//
// REGLA DE ORO DE ESTE FICHERO: el juez es SIEMPRE el dominio real (`validateResidencyYearClose`),
// nunca una reimplementación. Aquí solo se buscan asignaciones; quién decide si valen es el código
// que está en producción. Un banco que se juzga a sí mismo no mide nada.
//
// INV-15 (decisión V-35, posterior a la primera versión de este banco): nadie hace guardia dos
// días consecutivos, y es `error`. Se aplica aquí como PODA dura — nunca se crea una asignación
// que encadene —, no como coste. Sin esto el banco medía un problema más fácil que el real: su
// propia salida producía ~90 errores duros por semilla, todos INV-15.
//
// MEDIDO CON INV-15 PUESTO (2026-08-11): el ±1 sigue alcanzándose 6/6 en los seis escenarios y
// con CERO errores duros, y el banco además va MÁS RÁPIDO que sin la restricción (0,85 s frente
// a 1,4 s en el caso base), porque podar el espacio de búsqueda compensa de sobra lo que estrecha.
// INV-15 solo obliga a dejar puestos vacíos cuando el pool elegible de un puesto baja a UNA
// persona —solo puede hacer días alternos—, y esos huecos son aviso de INV-1, no error.
//
// EL CIERRE TRIMESTRAL (decisión V-37, 2026-08-13). Hasta esta fecha NINGUNA medición había
// invocado `validateQuarterClose` —ni este banco ni los tests del generador—, pese a llevar desde
// V-13 cableado en `marcarValidado` y en `closes.js`. Medido ya, lo que sale es que perseguir el
// año NO trae el trimestre: el óptimo anual, que saca 3/3 en el cierre anual, falla el trimestral
// en los seis escenarios y en todas las semillas (17-33 avisos), porque nada le impide amontonar
// un trimestre y vaciar otro mientras el año cuadra.
//
// Pero NO son incompatibles: pidiéndole al coste los dos a la vez (`conTrimestre: true`) salen los
// DOS, 3/3 en los seis escenarios y con cero errores duros. O sea que lo que le falta al generador
// es objetivo, no espacio — que son arreglos muy distintos. Se paga en tiempo de búsqueda: entre
// 2× y 3× en casi todos, y 14× en el peor (la baja de 6 meses, de 2,2 s a 30 s).
//
// TRES COSAS QUE SE APRENDIERON MIDIENDO, y que quien escriba el solver necesita saber:
//   1. Un buscador que solo INTERCAMBIA asignaciones no puede arreglar nunca el eje `total`: un
//      intercambio conserva el número de guardias de cada uno. Hace falta un operador que reasigne.
//   2. Equilibrar DENTRO de cada mes no llega al cierre anual (0/6). Hay que perseguir el acumulado.
//   3. Con una baja, igualar totales EN CRUDO falla (0/6); hay que dividir por disponibilidad (4/6).
//      Es lo que INV-3 compara, y es el error que un generador incremental comete por defecto.

import { pathToFileURL } from "node:url";
import { addDays, compareISO, datesOfMonth, bridgesBetween } from "../../v2/domain/calendar.js";
import { tally } from "../../v2/domain/tally.js";
import { buildYearCloseContext, validateResidencyYearClose, validateQuarterClose, quarterCloseWindow, DIMS, PROPORCIONAL, residentIsFreeOnBridge } from "../../v2/domain/equity.js";
import { buildMonthContext, validateMonth } from "../../v2/domain/validate.js";

// Calendario laboral real de Alicante (nacional + Comunitat Valenciana + local), contrastado
// contra el Decreto 100/2025 (DOGV) y el Decreto 42/2026. Dos trampas verificadas que casi todos
// los calendarios genéricos cometen: el Jueves Santo NO es festivo en la Comunitat Valenciana, y
// en 2026 ni Todos los Santos ni la Constitución se trasladaron (caen en domingo y se perdieron).
const FESTIVOS = [
  { fecha: "2026-06-23", nombre: "Hogueras de San Juan", ambito: "LOCAL" },
  { fecha: "2026-06-24", nombre: "San Juan", ambito: "AUTONOMICO" },
  { fecha: "2026-08-15", nombre: "Asunción de la Virgen", ambito: "NACIONAL" },
  { fecha: "2026-10-09", nombre: "Día de la Comunitat Valenciana", ambito: "AUTONOMICO" },
  { fecha: "2026-10-12", nombre: "Fiesta Nacional de España", ambito: "NACIONAL" },
  { fecha: "2026-12-08", nombre: "Inmaculada Concepción", ambito: "NACIONAL" },
  { fecha: "2026-12-25", nombre: "Natividad del Señor", ambito: "NACIONAL" },
  { fecha: "2027-01-01", nombre: "Año Nuevo", ambito: "NACIONAL" },
  { fecha: "2027-01-06", nombre: "Epifanía del Señor", ambito: "NACIONAL" },
  { fecha: "2027-03-19", nombre: "San José", ambito: "AUTONOMICO" },
  { fecha: "2027-03-26", nombre: "Viernes Santo", ambito: "NACIONAL" },
  { fecha: "2027-03-29", nombre: "Lunes de Pascua", ambito: "AUTONOMICO" },
  { fecha: "2027-04-08", nombre: "Romería de Santa Faz", ambito: "LOCAL" },
  { fecha: "2027-05-01", nombre: "Fiesta del Trabajo", ambito: "NACIONAL" },
];

// Ventana = un año de residencia real, de aniversario a aniversario (el del servicio cae en mayo).
const VENTANA = { start: "2026-05-27", end: "2027-05-26" };
const CIERRE = { mes: 5, anio: 2027 };
const FEST = new Set(FESTIVOS.map((f) => f.fecha));
const EMPTY = new Set();
const esVerano = (iso) => [6, 7, 8].includes(Number(iso.slice(5, 7)));
const codigoDe = (iso) => (FEST.has(iso) ? "GF" : FEST.has(addDays(iso, 1)) ? "GP" : "G");

/** Plantilla real del servicio (hoja «Residentes» del .xlsm): 3 R4 · 4 R3 · 4 R2 · 4 R1. */
function plantilla({ nR4 = 3, nR3 = 4, nR2 = 4, nR1 = 4 } = {}) {
  const mk = (p, n, a) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, fechaInicio: `${a}-05-27`, fechaFin: `${a + 4}-05-26` }));
  return [...mk("r4_", nR4, 2023), ...mk("r3_", nR3, 2024), ...mk("r2_", nR2, 2025), ...mk("r1_", nR1, 2026)];
}
function dias() { const o = []; for (let d = VENTANA.start; compareISO(d, VENTANA.end) <= 0; d = addDays(d, 1)) o.push(d); return o; }
const rng = (semilla) => { let s = semilla >>> 0; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); };

function contexto(roster, bajas) {
  const res = plantilla(roster), D = dias();
  const grupos = { c2023: [], c2024: [], c2025: [], c2026: [] };
  for (const r of res) grupos[`c${r.fechaInicio.slice(0, 4)}`].push(r.id);
  const cohorteDe = {}; for (const [g, ids] of Object.entries(grupos)) for (const id of ids) cohorteDe[id] = g;
  const mayores = new Set([...grupos.c2023, ...grupos.c2024]);
  const puentes = bridgesBetween(VENTANA.start, VENTANA.end, FESTIVOS);
  const fDe = {};
  for (const r of res) {
    let fuera = 0;
    for (const b of bajas.filter((b) => b.residenteId === r.id)) for (const d of D) if (d >= b.desde && d <= b.hasta) fuera++;
    fDe[r.id] = (D.length - fuera) / D.length || 1;
  }
  const bloq = (id, f) => bajas.some((b) => b.residenteId === id && f >= b.desde && f <= b.hasta);
  // INV-5 (baja) e INV-11 (ningún R1 en verano) son restricciones de poda, no coste: se respetan
  // por construcción y por eso el resultado nunca produce un `error` del validador.
  const elegible = (id, f) => !bloq(id, f) && !(cohorteDe[id] === "c2026" && esVerano(f));
  const poolDe = (puesto, f) => (puesto === "M" ? [...mayores] : (esVerano(f) ? grupos.c2025 : [...grupos.c2025, ...grupos.c2026])).filter((id) => elegible(id, f));
  // Índice fecha → quién la cubre ya. Sin él, cada paso del bucle interno recorría los 730 slots
  // para preguntar «¿está este residente ya ese día?» y el banco tardaba 66s por escenario.
  const nuevoOcupa = () => new Map();
  const libre = (ocupa, f, id) => !(ocupa.get(f) || EMPTY).has(id);
  const ocupar = (ocupa, f, id) => { if (!ocupa.has(f)) ocupa.set(f, new Set()); ocupa.get(f).add(id); };
  const soltar = (ocupa, f, id) => { const s = ocupa.get(f); if (s) s.delete(id); };
  // INV-15: ¿puede `id` coger `f` sin encadenar? `excluir` es la fecha que está soltando en el
  // mismo movimiento (en un intercambio importa: si las dos fechas son vecinas, soltar una
  // legaliza la otra).
  const sinEncadenar = (asig, id, f, excluir = null) => {
    const suyas = asig.get(id);
    for (const vecina of [addDays(f, -1), addDays(f, 1)]) if (vecina !== excluir && suyas.has(vecina)) return false;
    return true;
  };
  // `puentesLibres` NO es "no trabajó ese día": desde V-27 un puente dentro de una ausencia
  // tampoco cuenta como libre (no lo tuvo porque no estaba, no porque el reparto se lo diera).
  // La regla la pone `equity.js`; calcularla aquí a mano fue la SEGUNDA divergencia con el juez
  // que apareció hoy, y la que hacía que el buscador se parase creyendo haber terminado.
  // Se precalcula por residente: con el reparto VACÍO, `residentIsFreeOnBridge` responde justo la
  // parte que no depende del reparto (¿cae en su ventana? ¿está de ausencia ese día?). Lo que
  // queda es «¿lo trabajó?», que es un `has` sobre el Set. Así la regla la sigue poniendo el
  // dominio pero no se recorre un array en cada paso de la búsqueda.
  const puentesElegibles = {};
  for (const r of res) puentesElegibles[r.id] = puentes.filter((p) => residentIsFreeOnBridge(r.id, [], p, VENTANA, bajas));
  // Disponibilidad de cada residente DENTRO de cada trimestre, que es la que usa el cierre
  // trimestral (divide por los días del trimestre completo, no por los que estuvo). Se precalcula
  // porque no depende del reparto.
  const TRIMS = trimestresDeLaVentana().dentro;
  const diasDe = (a, b) => { let n = 0; for (let d = a; compareISO(d, b) <= 0; d = addDays(d, 1)) n++; return n; };
  const fTrim = {};
  for (const r of res) {
    fTrim[r.id] = TRIMS.map((w) => {
      let fuera = 0;
      for (const b of bajas.filter((b) => b.residenteId === r.id)) {
        for (let d = w.start; compareISO(d, w.end) <= 0; d = addDays(d, 1)) if (d >= b.desde && d <= b.hasta) fuera++;
      }
      return (diasDe(w.start, w.end) - fuera) / diasDe(w.start, w.end);
    });
  }
  const met = (id, fechas) => {
    const t = tally([...fechas].map((f) => ({ fecha: f, codigo: codigoDe(f) })), { start: VENTANA.start, end: VENTANA.end });
    let libres = 0;
    for (const p of puentesElegibles[id]) if (!fechas.has(p)) libres++;
    // Contar fechas equivale al `total` del cierre trimestral porque aquí todo código es G/GF/GP
    // y ninguna asignación lleva `origen` (las cedidas/compradas no suman a `total`, tally.js:15).
    const trim = TRIMS.map((w) => { let n = 0; for (const f of fechas) if (f >= w.start && f <= w.end) n++; return n; });
    return { total: t.total, findes: t.finde, festivos: t.festivos, prefestivos: t.prefestivos, dobletes: t.dobletes, puentesLibres: libres, trim };
  };
  // Qué eje se normaliza lo dice `equity.js`, no este fichero: tener aquí la copia es lo que dejó
  // al banco midiendo un objetivo distinto del juez cuando `puentesLibres` pasó a normalizarse.
  // Devuelve DOS números y no uno a propósito. `duro` es lo que se pasa de ±1: es el objetivo real
  // y llega a 0 exacto, que es lo que permite parar en cuanto hay solución. `guia` es la dispersión
  // total, que orienta la búsqueda cuando el duro ya está a 0 en un eje pero no en otro — pero
  // nunca llega a cero, así que mezclarlo con el duro dejaba el bucle sin condición de parada y
  // hacía que el banco tardase 60 veces más de lo necesario.
  const costeCohorte = (g, M, normalizar = true, conTrimestre = false) => {
    const ids = grupos[g]; if (ids.length < 2) return { duro: 0, guia: 0 };
    let duro = 0, guia = 0;
    for (const eje of DIMS) {
      let mx = -Infinity, mn = Infinity;
      for (const id of ids) { const v = normalizar && PROPORCIONAL.has(eje) ? M[id][eje] / fDe[id] : M[id][eje]; if (v > mx) mx = v; if (v < mn) mn = v; }
      duro += Math.max(0, mx - mn - 1); guia += mx - mn;
    }
    // El cierre TRIMESTRAL, cuando se le pide perseguirlo además del anual. Imita a
    // `validateQuarterClose`: un solo eje (`total`), normalizado por la disponibilidad DEL
    // TRIMESTRE, tolerancia 1/min(f) del par comparado (V-37) y fuera quien no llegue a media
    // disponibilidad (V-13). Sigue siendo una imitación para poder orientar la búsqueda —el juez
    // del informe es el validador de verdad—, pero la tolerancia se copia de él a propósito: con
    // la vieja (un 1 fijo) el buscador perseguiría un objetivo que el juez ya no mide.
    if (conTrimestre) {
      for (let q = 0; q < TRIMS.length; q++) {
        let hi = null, lo = null;
        for (const id of ids) {
          if (fTrim[id][q] < 0.5) continue;
          const v = M[id].trim[q] / fTrim[id][q];
          if (!hi || v > hi.v) hi = { v, f: fTrim[id][q] };
          if (!lo || v < lo.v) lo = { v, f: fTrim[id][q] };
        }
        if (!hi) continue; // nadie de la cohorte llega a media disponibilidad en este trimestre
        duro += Math.max(0, hi.v - lo.v - 1 / Math.min(hi.f, lo.f)); guia += hi.v - lo.v;
      }
    }
    return { duro, guia };
  };
  const peor = (x, y) => x.duro > y.duro + 1e-9 || (Math.abs(x.duro - y.duro) <= 1e-9 && x.guia > y.guia + 1e-9);
  return { res, D, grupos, cohorteDe, mayores, puentes, fDe, poolDe, met, costeCohorte, peor, nuevoOcupa, libre, ocupar, soltar, sinEncadenar };
}

/** Busca un año entero de una vez. Devuelve el mejor cuadrante encontrado. */
function buscarAnual({ semilla = 1, intentos = 8, pasos = 40000, roster = {}, bajas = [], conTrimestre = false } = {}) {
  const rnd = rng(semilla);
  const X = contexto(roster, bajas);
  let mejor = null;

  for (let it = 0; it < intentos; it++) {
    const asig = new Map(X.res.map((r) => [r.id, new Set()]));
    const ocupa = X.nuevoOcupa();
    const slots = [];
    for (const f of X.D) for (const puesto of ["M", "P"]) {
      const pool = X.poolDe(puesto, f).filter((id) => X.libre(ocupa, f, id) && X.sinEncadenar(asig, id, f));
      // Sin candidato legal el puesto se queda VACÍO, igual que hace schedule.js (V-35c): antes
      // que encadenar, no cubrir. Un día con el otro puesto cubierto es aviso de INV-1, no error.
      if (!pool.length) { slots.push({ fecha: f, puesto, id: null }); continue; }
      const id = pool[(rnd() * pool.length) | 0];
      asig.get(id).add(f); X.ocupar(ocupa, f, id); slots.push({ fecha: f, puesto, id });
    }
    const M = {}; for (const r of X.res) M[r.id] = X.met(r.id, asig.get(r.id));
    const C = {}; for (const g of Object.keys(X.grupos)) C[g] = X.costeCohorte(g, M, true, conTrimestre);
    const suma = () => Object.values(C).reduce((a, b) => a + b.duro, 0);
    let duro = suma();

    for (let k = 0; k < pasos && duro > 1e-9; k++) {
      const a = slots[(rnd() * slots.length) | 0];
      if (a.id === null) continue; // puesto vacío por INV-15: no hay nada que mover
      // MOVER la mitad de los pasos es imprescindible: un intercambio conserva el número de
      // guardias de cada uno, así que por sí solo no puede arreglar nunca el eje `total`.
      const mover = rnd() < 0.5;
      const b = mover ? null : slots[(rnd() * slots.length) | 0];
      let destino;
      if (mover) {
        const cand = X.poolDe(a.puesto, a.fecha).filter((id) => id !== a.id && X.libre(ocupa, a.fecha, id) && X.sinEncadenar(asig, id, a.fecha));
        if (!cand.length) continue;
        destino = cand[(rnd() * cand.length) | 0];
      } else {
        if (b.id === null || b.puesto !== a.puesto || b.id === a.id) continue;
        if (!X.poolDe(a.puesto, b.fecha).includes(a.id) || !X.poolDe(b.puesto, a.fecha).includes(b.id)) continue;
        // Cada uno suelta su fecha al coger la del otro: por eso se excluye al comprobar.
        if (!X.sinEncadenar(asig, a.id, b.fecha, a.fecha) || !X.sinEncadenar(asig, b.id, a.fecha, b.fecha)) continue;
      }
      const A = asig.get(a.id), B = asig.get(mover ? destino : b.id);
      const oA = M[a.id], oB = M[mover ? destino : b.id];
      A.delete(a.fecha); B.add(a.fecha);
      if (!mover) { B.delete(b.fecha); A.add(b.fecha); }
      M[a.id] = X.met(a.id, A); M[mover ? destino : b.id] = X.met(mover ? destino : b.id, B);
      const gs = [...new Set([X.cohorteDe[a.id], X.cohorteDe[mover ? destino : b.id]])];
      const antes = gs.reduce((x, g) => ({ duro: x.duro + C[g].duro, guia: x.guia + C[g].guia }), { duro: 0, guia: 0 });
      const nuevos = gs.map((g) => X.costeCohorte(g, M, true, conTrimestre));
      const desp = nuevos.reduce((x, y) => ({ duro: x.duro + y.duro, guia: x.guia + y.guia }), { duro: 0, guia: 0 });
      if (!X.peor(desp, antes)) {
        gs.forEach((g, n) => (C[g] = nuevos[n])); duro = suma();
        if (mover) { X.soltar(ocupa, a.fecha, a.id); X.ocupar(ocupa, a.fecha, destino); a.id = destino; }
        else {
          X.soltar(ocupa, a.fecha, a.id); X.soltar(ocupa, b.fecha, b.id);
          X.ocupar(ocupa, a.fecha, b.id); X.ocupar(ocupa, b.fecha, a.id);
          const t = a.id; a.id = b.id; b.id = t;
        }
      } else {
        A.add(a.fecha); B.delete(a.fecha);
        if (!mover) { B.add(b.fecha); A.delete(b.fecha); }
        M[a.id] = oA; M[mover ? destino : b.id] = oB;
      }
    }
    if (!mejor || duro < mejor.total) mejor = { total: duro, asignaciones: aplanar(asig), it: it + 1 };
    if (duro <= 1e-9) break;
  }
  return { ...mejor, res: X.res };
}

const aplanar = (asig) => { const o = []; for (const [id, fs] of asig) for (const f of fs) o.push({ fecha: f, residenteId: id, codigo: codigoDe(f) }); return o; };

/**
 * El OTRO juez de INV-3, el del cierre TRIMESTRAL (P-8 / decisión V-13), que hasta ahora no
 * había invocado ninguna medición: ni este banco ni los tests del generador. Y no es el mismo
 * problema en pequeño — mide un solo eje (`total`) pero sobre una ventana que NO es la que
 * persigue el generador, así que aprobar el cierre anual no implica aprobar los cuatro
 * trimestres que lleva dentro.
 *
 * Qué trimestre cierra en cada mes lo dice `quarterCloseWindow`, igual que en el router y en
 * `closes.js`: la ventana no se adivina aquí. De los cuatro, este banco solo puede juzgar TRES,
 * y el que se cae no es un descuido de esta ventana concreta sino algo estructural: T4 va de
 * marzo a mayo y el año de residencia acaba el 26 de mayo, así que **T4 cruza siempre el
 * aniversario**, sea cual sea el año. Juzgarlo aquí compararía los ~87 días que el banco genera
 * contra los 92 del trimestre y todos saldrían bajos por igual, que es medir el corte y no el
 * reparto. Se dice cuál queda fuera en vez de callarlo.
 */
/**
 * Los trimestres que caben ENTEROS en la ventana, y el que no. Se calcula una vez y lo usan tanto
 * el juez de abajo como la función de coste: si el buscador persiguiera unos trimestres y el juez
 * midiera otros, volveríamos al fallo del día —dos copias de la misma regla que se separan— con
 * la agravante de que aquí ni siquiera fallaría un test.
 */
function trimestresDeLaVentana() {
  const dentro = [], fuera = [];
  for (const f of dias()) {
    if (!f.endsWith("-01")) continue;
    const [anio, mes] = [Number(f.slice(0, 4)), Number(f.slice(5, 7))];
    const win = quarterCloseWindow(mes, anio);
    if (!win) continue;
    if (compareISO(win.start, VENTANA.start) < 0 || compareISO(win.end, VENTANA.end) > 0) fuera.push(win.trimestre);
    else dentro.push({ ...win, mes, anio });
  }
  return { dentro, fuera };
}

function juzgarTrimestres(asignaciones, res, bloqueos = []) {
  const { dentro, fuera } = trimestresDeLaVentana();
  const violaciones = [];
  for (const win of dentro) {
    violaciones.push(...validateQuarterClose({
      mes: win.mes, anio: win.anio, residentes: res, bloqueos,
      asignaciones: asignaciones.filter((a) => compareISO(a.fecha, win.start) >= 0 && compareISO(a.fecha, win.end) <= 0),
    }));
  }
  return { dentro: dentro.map((w) => w.trimestre), fuera, violaciones };
}

/** El juez: el dominio real, nunca una copia. */
function juzgar(asignaciones, res, bloqueos = []) {
  const ms = `${CIERRE.anio}-${String(CIERRE.mes).padStart(2, "0")}-01`;
  return validateResidencyYearClose(buildYearCloseContext({
    ...CIERRE, residentes: res, bloqueos, festivos: FESTIVOS,
    historicas: asignaciones.filter((a) => a.fecha < ms), asignacionesDelMes: asignaciones.filter((a) => a.fecha >= ms),
  }));
}

/** Comprueba que el cuadrante es LEGAL: sin esto, medir la equidad no significaría nada. */
function erroresDuros(asignaciones, res, bloqueos = []) {
  const porMes = new Map();
  for (const a of asignaciones) { const k = a.fecha.slice(0, 7); if (!porMes.has(k)) porMes.set(k, []); porMes.get(k).push(a); }
  let n = 0;
  for (const [k, delMes] of porMes) {
    if (k === "2026-05" || k === "2027-05") continue; // meses cortados por el aniversario
    const [anio, mes] = k.split("-").map(Number);
    // `historicas` es imprescindible desde INV-15: sin el mes anterior, el par que cruza el
    // borde (día 31 + día 1) es invisible y el banco se daría por bueno sin haberlo mirado.
    const ms = `${k}-01`;
    n += validateMonth(buildMonthContext({ mes, anio, residentes: res, historicas: asignaciones.filter((a) => a.fecha < ms), asignacionesDelMes: delMes, bloqueos, festivos: FESTIVOS }))
      .filter((v) => v.severidad === "error").length;
  }
  return n;
}

/**
 * Generación INCREMENTAL: mes a mes, con los meses anteriores CONGELADOS (ya publicados, no se
 * pueden retocar). Es como funciona la app de verdad, así que es la variante que decide el diseño.
 */
function incremental({ semilla = 1, pasosMes = 25000, bajas = [], normalizar = true, ambito = "acumulado" } = {}) {
  const rnd = rng(semilla);
  const X = contexto({}, bajas);
  const meses = new Map();
  for (const f of X.D) { const k = f.slice(0, 7); if (!meses.has(k)) meses.set(k, []); meses.get(k).push(f); }

  const asig = new Map(X.res.map((r) => [r.id, new Set()]));
  const ocupa = X.nuevoOcupa();
  const M = {}; for (const r of X.res) M[r.id] = X.met(r.id, asig.get(r.id));

  for (const [, ds] of meses) {
    const slots = [];
    for (const f of ds) for (const puesto of ["M", "P"]) {
      const pool = X.poolDe(puesto, f).filter((id) => X.libre(ocupa, f, id));
      const id = pool.reduce((a, b) => (M[b].total < M[a].total ? b : a));
      asig.get(id).add(f); X.ocupar(ocupa, f, id); M[id] = X.met(id, asig.get(id)); slots.push({ fecha: f, puesto, id });
    }
    // `ambito: "mes"` mide la variante ingenua: equilibrar DENTRO del mes, sin memoria anual.
    const marco = ambito === "mes" ? new Map(X.res.map((r) => [r.id, new Set([...asig.get(r.id)].filter((f) => f.startsWith(ds[0].slice(0, 7))))])) : asig;
    const metrica = (id) => X.met(id, ambito === "mes" ? marco.get(id) : asig.get(id));
    const C = {}; for (const g of Object.keys(X.grupos)) { const Mx = {}; for (const id of X.grupos[g]) Mx[id] = metrica(id); C[g] = X.costeCohorte(g, Mx, normalizar); }
    const duroTotal = () => Object.values(C).reduce((a, b) => a + b.duro, 0);

    for (let k = 0; k < pasosMes && duroTotal() > 1e-9; k++) {
      const a = slots[(rnd() * slots.length) | 0];
      const cand = X.poolDe(a.puesto, a.fecha).filter((id) => id !== a.id && X.libre(ocupa, a.fecha, id));
      if (!cand.length) continue;
      const nuevoId = cand[(rnd() * cand.length) | 0];
      const A = asig.get(a.id), B = asig.get(nuevoId);
      A.delete(a.fecha); B.add(a.fecha);
      if (ambito === "mes") { marco.get(a.id).delete(a.fecha); marco.get(nuevoId).add(a.fecha); }
      const gs = [...new Set([X.cohorteDe[a.id], X.cohorteDe[nuevoId]])];
      const antes = gs.reduce((x, g) => ({ duro: x.duro + C[g].duro, guia: x.guia + C[g].guia }), { duro: 0, guia: 0 });
      const nuevos = gs.map((g) => { const Mx = {}; for (const id of X.grupos[g]) Mx[id] = metrica(id); return X.costeCohorte(g, Mx, normalizar); });
      const desp = nuevos.reduce((x, y) => ({ duro: x.duro + y.duro, guia: x.guia + y.guia }), { duro: 0, guia: 0 });
      if (!X.peor(desp, antes)) { gs.forEach((g, n) => (C[g] = nuevos[n])); X.soltar(ocupa, a.fecha, a.id); X.ocupar(ocupa, a.fecha, nuevoId); a.id = nuevoId; }
      else {
        A.add(a.fecha); B.delete(a.fecha);
        if (ambito === "mes") { marco.get(a.id).add(a.fecha); marco.get(nuevoId).delete(a.fecha); }
      }
    }
    for (const r of X.res) M[r.id] = X.met(r.id, asig.get(r.id));
  }
  return { asignaciones: aplanar(asig), res: X.res };
}

// Las piezas de búsqueda se exportan para poder sondearlas desde fuera sin copiarlas. El informe
// de abajo solo corre cuando el fichero se EJECUTA (`node test/bench/...`), no cuando se importa:
// sin esta guarda, importar el banco para mirar un detalle dispara los ~4 minutos del informe.
export { buscarAnual, incremental, juzgar, juzgarTrimestres, erroresDuros, plantilla, VENTANA };
// `process.argv[1]` no existe si a alguien le da por importar esto desde `node -e`, y sin la
// comprobación `pathToFileURL` revienta antes de exportar nada.
const ejecutado = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

// ── Informe ─────────────────────────────────────────────────────────────────────────────────────
if (ejecutado) {
const SEMILLAS = Number(process.env.SEMILLAS || 6);
const fmt = (n) => String(n).padEnd(44);

console.log(`Ventana ${VENTANA.start} → ${VENTANA.end} · ${dias().length} días · ${dias().length * 2} puestos`);
console.log(`Puentes derivados del calendario real: ${bridgesBetween(VENTANA.start, VENTANA.end, FESTIVOS).join(", ")}\n`);

console.log("=== ¿Es alcanzable el ±1 en los seis ejes? (juez: validateResidencyYearClose) ===");
const BAJA_3M = [{ residenteId: "r3_1", motivo: "BAJA", desde: "2026-09-01", hasta: "2026-11-30", activo: true }];
const BAJA_6M = [{ residenteId: "r3_1", motivo: "BAJA", desde: "2026-09-01", hasta: "2027-02-28", activo: true }];
const ESCENARIOS = [
  ["base · plantilla real del servicio", {}],
  ["baja de 3 meses en un R3", { bajas: BAJA_3M }],
  ["baja de 6 meses en un R3", { bajas: BAJA_6M }],
  ["dos bajas simultáneas (R3 y R2)", { bajas: [...BAJA_3M, { residenteId: "r2_1", motivo: "BAJA", desde: "2026-10-01", hasta: "2026-12-31", activo: true }] }],
  ["cohorte R4 de solo 2 miembros", { roster: { nR4: 2 } }],
  ["plantilla mínima 2/2/2/2", { roster: { nR4: 2, nR3: 2, nR2: 2, nR1: 2 } }],
];
for (const [nombre, o] of ESCENARIOS) {
  let ok = 0, ms = 0, duros = 0, trimOk = 0, trimViol = 0;
  for (let s = 1; s <= SEMILLAS; s++) {
    const t0 = Date.now();
    const r = buscarAnual({ semilla: s * 9176, intentos: 8, pasos: 40000, ...o });
    ms += Date.now() - t0;
    duros += erroresDuros(r.asignaciones, r.res, o.bajas || []);
    if (juzgar(r.asignaciones, r.res, o.bajas || []).length === 0) ok++;
    // El MISMO cuadrante, juzgado por el otro cierre. Se mide sobre el mismo reparto y no sobre
    // uno nuevo a propósito: la pregunta es si aprobar el año trae aprobado el trimestre.
    const t = juzgarTrimestres(r.asignaciones, r.res, o.bajas || []);
    trimViol += t.violaciones.length;
    if (t.violaciones.length === 0) trimOk++;
  }
  console.log(`  ${fmt(nombre)} ${ok}/${SEMILLAS} anual · ${trimOk}/${SEMILLAS} trimestral (${trimViol} avisos) · ${(ms / SEMILLAS / 1000).toFixed(2)}s · ${duros} errores duros`);
}
{
  const t = juzgarTrimestres([], plantilla(), []);
  console.log(`  → trimestres juzgados: ${t.dentro.join(", ")} · fuera de la ventana: ${t.fuera.join(", ")} (cruza el aniversario)`);
}

// La pregunta que abre la sección anterior: si perseguir el año NO trae el trimestre, ¿es que son
// incompatibles, o es solo que no se estaba pidiendo? Misma búsqueda, mismo juez, mismo esfuerzo:
// lo único que cambia es que el coste incluye además el trimestre. Si aquí salen los dos a la vez,
// el problema del generador es de objetivo y no de factibilidad, que son arreglos muy distintos.
console.log("\n=== ¿Son alcanzables el cierre ANUAL y el TRIMESTRAL a la vez? ===");
for (const [nombre, o] of ESCENARIOS) {
  let ambos = 0, soloAnual = 0, ms = 0, duros = 0;
  for (let s = 1; s <= SEMILLAS; s++) {
    const t0 = Date.now();
    const r = buscarAnual({ semilla: s * 9176, intentos: 8, pasos: 40000, conTrimestre: true, ...o });
    ms += Date.now() - t0;
    duros += erroresDuros(r.asignaciones, r.res, o.bajas || []);
    const anualOk = juzgar(r.asignaciones, r.res, o.bajas || []).length === 0;
    const trimOk = juzgarTrimestres(r.asignaciones, r.res, o.bajas || []).violaciones.length === 0;
    if (anualOk && trimOk) ambos++;
    if (anualOk) soloAnual++;
  }
  console.log(`  ${fmt(nombre)} ${ambos}/${SEMILLAS} los DOS · ${soloAnual}/${SEMILLAS} el anual · ${(ms / SEMILLAS / 1000).toFixed(2)}s · ${duros} errores duros`);
}

console.log("\n=== Control negativo: ¿se cumple por casualidad? ===");
{
  let viol = 0;
  for (let s = 1; s <= SEMILLAS; s++) {
    const r = buscarAnual({ semilla: s * 313, intentos: 1, pasos: 0 }); // reparto legal pero aleatorio
    viol += juzgar(r.asignaciones, r.res).length;
  }
  console.log(`  ${fmt("reparto legal SIN optimizar")} ${(viol / SEMILLAS).toFixed(1)} violaciones de media`);
}

console.log("\n=== Generación mes a mes, con los meses anteriores INMUTABLES ===");
for (const [nombre, o] of [
  ["equilibrando dentro de cada mes", { ambito: "mes" }],
  ["contra el acumulado, sin bajas", {}],
  ["contra el acumulado, con baja, en CRUDO", { bajas: BAJA_3M, normalizar: false }],
  ["contra el acumulado, con baja, normalizado", { bajas: BAJA_3M, normalizar: true }],
]) {
  let ok = 0, trimOk = 0, trimViol = 0;
  for (let s = 1; s <= SEMILLAS; s++) {
    const r = incremental({ semilla: s * 4517, ...o });
    if (juzgar(r.asignaciones, r.res, o.bajas || []).length === 0) ok++;
    const t = juzgarTrimestres(r.asignaciones, r.res, o.bajas || []);
    trimViol += t.violaciones.length;
    if (t.violaciones.length === 0) trimOk++;
  }
  console.log(`  ${fmt(nombre)} ${ok}/${SEMILLAS} anual · ${trimOk}/${SEMILLAS} trimestral (${trimViol} avisos)`);
}

console.log("\n=== INV-2 en verano (aritmética, sin buscador) ===");
{
  const verano = [6, 7, 8].reduce((n, m) => n + datesOfMonth(2026, m).length, 0);
  for (const n of [4, 5, 6]) {
    const techo = n * 6 * 3;
    console.log(`  ${fmt(`con ${n} R2: techo ${techo} puestos, hacen falta ${verano}`)} ${techo >= verano ? "cabe" : `faltan ${verano - techo} días`}`);
  }
}
} // fin de `if (ejecutado)`

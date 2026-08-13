// GeneratorScreen — sustituye a la antigua pantalla de IA. "Prompt portátil": sin llamada a
// ninguna API de terceros ni secreto en el cliente (spec: decisión del proyecto). Monta un
// prompt de texto para pegar en el asistente que el usuario prefiera y valida LOCALMENTE
// (validateMonth, sin red) la respuesta que devuelva — "la IA propone, el validador dispone"
// (spec.md §5), mismo esquema visual de violaciones que CalendarScreen.
import { COLOR, S, ANOS } from "./client/lib/design-tokens.js";
import { periodsOfResident, levelOn, groupOf, periodOn } from "./v2/domain/residents.js";
import { addDays, toISO, daysInMonth, bridgesOfMonth, academicYearOf } from "./v2/domain/calendar.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "./v2/domain/validate.js";
import { accumulatedTally } from "./v2/domain/accumulate.js";
import { canEdit } from "./v2/domain/cuadrante.js";
import { violationText } from "./client/lib/violations.js";
import { monthReplacementPlan } from "./client/lib/apply-month.js";
// Los dos ámbitos que `validateMonth` NO cubre y que hasta ahora esta pantalla se saltaba: los
// cierres de equidad de INV-3 (trimestral y de año de residencia) y el ciclo L-D del tercer
// puesto (INV-8). Ambos necesitan histórico de fuera del mes, así que traen red — es lo que
// vuelve `comprobar()` asíncrono. Son los mismos módulos que usa Calendar.jsx: el veredicto de
// las dos pantallas tiene que salir del mismo sitio.
import { closeViolations } from "./client/lib/closes.js";
import { thirdPostViolations, shapeThirdPostHistory } from "./client/lib/thirdpost.js";
// El rango de histórico que necesita INV-8b lo decide el dominio (contrato C-4), igual que
// `rotationHistoryStart` decide el de INV-7: el `desde` de un voluntario puede ser anterior al
// año de residencia en curso, y entonces el histórico que ya se pedía no lo alcanzaba.
import { thirdPostHistoryStart } from "./v2/domain/thirdpost.js";
// El generador determinista (V-34). Escribe en el MISMO textarea que se pega a mano: así el
// camino de salida —comprobar(), el rechazo de fechas/ids y el reemplazo de mes de V-31— es
// exactamente el mismo, y no hay una segunda vía de escritura que pueda saltarse esos controles.
import { generateMonth } from "./v2/domain/schedule.js";

const { useState, useMemo, useEffect, useRef } = React;
const { Card, SectionTitle, Btn, Aviso, Info } = window.UI;

const GRUPO_LABEL = { MAYOR: "Mayor", PEQUENO: "Pequeño" };
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// `periodsOfResident` y no `defaultTrainingPeriods`: es la derivación única del dominio (V-24) y
// la ÚNICA que respeta los periodos editados de la nota [a]. Con `defaultTrainingPeriods` directo,
// esta pantalla mostraría un nivel distinto del que juzga el validador.
function nivelEnFecha(residente, iso) {
  return levelOn(periodsOfResident(residente), iso);
}

function agruparPorNivel(residentes, iso) {
  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  for (const r of residentes) {
    const nivel = nivelEnFecha(r, iso);
    if (porNivel[nivel]) porNivel[nivel].push({ id: r.id, nombre: r.nombre, nivel });
  }
  return porNivel;
}

const MOTIVO_LABEL = { BAJA: "BAJA", VACACIONES: "VACACIONES", ROTACION: "ROTACIÓN" };

/** Texto de la sección de bloqueos activos del mes — BAJA es obligatorio, el resto es evitable (V-8). */
function construirBloqueosTexto(bloqueos) {
  if (!bloqueos || bloqueos.length === 0) return "BLOQUEOS ACTIVOS ESTE MES (por residenteId): ninguno.";
  const lineas = bloqueos.map((b) => {
    const etiqueta = MOTIVO_LABEL[b.motivo] + (b.motivo === "ROTACION" && b.provincia ? ` (${b.provincia})` : "");
    return b.motivo === "BAJA"
      ? `  - id="${b.residenteId}" — ${etiqueta} del ${b.desde} al ${b.hasta}: OBLIGATORIO no asignarle guardia ningún día de ese rango.`
      : `  - id="${b.residenteId}" — ${etiqueta} del ${b.desde} al ${b.hasta}: evita asignarle guardia si puedes; si no hay alternativa razonable, sí se le puede asignar.`;
  }).join("\n");
  return `BLOQUEOS ACTIVOS ESTE MES (por residenteId):\n${lineas}`;
}

/** Texto del contaje acumulado de un residente en SU año de residencia en curso, o null si aún no tiene. */
function resumenAcumulado(acc) {
  if (!acc) return null;
  return `total=${acc.total}, findes=${acc.finde}, festivos=${acc.festivos}, prefestivos=${acc.prefestivos}, dobletes=${acc.dobletes}`;
}

/**
 * Festivos y puentes del mes, para el prompt. Los festivos son datos de entrada (S-4): el v1 le
 * pedía al modelo "identifícalos tú" y eso es exactamente lo que no puede volver a pasar — un
 * festivo alucinado se convierte en una GF mal puesta que INV-12 tendría que cazar después.
 * Si no hay festivos cargados se DICE, en vez de callar y dejar que el modelo improvise.
 */
function construirFestivosTexto(festivos, puentes) {
  if (!festivos || festivos.length === 0) {
    return "FESTIVOS DEL MES: no hay ninguno cargado en la aplicación. NO inventes festivos: marca\ntodas las guardias como G y avisa de que falta el calendario.";
  }
  const lista = festivos
    .map((f) => `  - ${f.fecha}${f.nombre ? ` — ${f.nombre}` : ""}${f.ambito ? ` (${f.ambito.toLowerCase()})` : ""}`)
    .join("\n");
  const puentesTexto = puentes && puentes.length
    ? `\n\nPUENTES (día laborable entre dos no laborables; conviene repartirlos con equidad):\n${puentes.map((d) => `  - ${d}`).join("\n")}`
    : "";
  return `FESTIVOS DEL MES (los únicos que existen; la víspera de cada uno es prefestivo → GP):\n${lista}${puentesTexto}`;
}

/**
 * Voluntarios del tercer puesto, para el prompt. El 3P es autoservicio puro («será siempre
 * voluntario», V-18): la norma 8 le pedía al modelo repartir el 3P «con equidad entre
 * voluntarios» sin decirle NUNCA quiénes son, así que o no lo ponía o lo repartía entre
 * cualquiera. El `desde` viaja porque es el que arranca el ciclo L-D de INV-8b (contrato C-4),
 * no un borde de calendario.
 */
function construirVoluntarios3PTexto(voluntarios) {
  if (!voluntarios || voluntarios.length === 0) {
    return "VOLUNTARIOS DEL 3.º PUESTO: ninguno. NO asignes ningún código 3P este mes.";
  }
  const lista = voluntarios.map((v) => `  - id="${v.residenteId}" — voluntario desde ${v.desde}`).join("\n");
  return `VOLUNTARIOS DEL 3.º PUESTO (los ÚNICOS que pueden llevar código 3P):\n${lista}`;
}

/**
 * Eventos del servicio del curso (INV-10). Igual que los festivos: son un dato de entrada, y sin
 * ellos la norma 10 terminaba con «si no conoces esas fechas, ignora esta norma» — es decir, se
 * apagaba sola. `voluntarios` es el resultado del sorteo cuando ya se hizo.
 */
function construirEventosTexto(eventos) {
  if (!eventos || eventos.length === 0) {
    return "EVENTOS DEL SERVICIO (Navidad, cena de despedida): ninguno cargado. NO inventes fechas de\nevento ni apliques la norma 10.";
  }
  const lista = eventos.map((e) => {
    const quienes = e.voluntarios && e.voluntarios.length
      ? ` — sorteados: ${e.voluntarios.map((id) => `id="${id}"`).join(", ")}`
      : " — sin sorteo todavía";
    return `  - ${String(e.tipo).toUpperCase()} el ${e.fecha}${quienes}`;
  }).join("\n");
  return `EVENTOS DEL SERVICIO DE ESTE CURSO:\n${lista}`;
}

/**
 * Preferencias personales del equipo. Son BLANDAS por definición (V-6/V-8): `fechasEvitar` no la
 * enforcea ningún invariante y `maxGuardias` no puede saltarse el 4-6 de INV-2. Se marcan como
 * tales en el texto para que el modelo no las trate como bloqueos — la ausencia de verdad es una
 * fila de `bloqueos`, que ya va en su propia sección.
 */
function construirPreferenciasTexto(preferencias) {
  const utiles = (preferencias || []).filter(
    (p) => (p.fechasEvitar && p.fechasEvitar.length) || p.maxGuardias || p.preferDobles || p.notas
  );
  if (utiles.length === 0) return "PREFERENCIAS PERSONALES DEL MES: ninguna registrada.";
  const lista = utiles.map((p) => {
    const partes = [];
    if (p.fechasEvitar && p.fechasEvitar.length) partes.push(`preferiría evitar ${p.fechasEvitar.join(", ")}`);
    if (p.maxGuardias) partes.push(`querría no pasar de ${p.maxGuardias} guardias`);
    if (p.preferDobles) partes.push(`doblete preferido: ${String(p.preferDobles).toLowerCase().replace(/_/g, "-")}`);
    if (p.notas) partes.push(`nota: "${p.notas}"`);
    return `  - id="${p.residenteId}" — ${partes.join("; ")}`;
  }).join("\n");
  return `PREFERENCIAS PERSONALES DEL MES (BLANDAS: son deseos, no obligaciones — respétalas solo si\nno te obligan a incumplir ninguna norma de abajo):\n${lista}`;
}

function construirPrompt({ mes, anio, nombreMes, porNivel, acumulados, bloqueosDelMes, festivosDelMes, puentesDelMes, voluntarios3P, eventos, preferencias }) {
  const bloques = ANOS.map((nivel) => {
    const lista = porNivel[nivel];
    if (!lista.length) return null;
    const grupo = GRUPO_LABEL[groupOf(nivel)];
    const filas = lista.map((r) => {
      const resumen = resumenAcumulado(acumulados.get(r.id));
      const llevo = resumen ? `llevo hasta ahora: ${resumen}` : "sin guardias registradas todavía este año de residencia";
      return `  - id="${r.id}" — ${r.nombre} (${llevo})`;
    }).join("\n");
    return `${nivel} (${grupo}):\n${filas}`;
  }).filter(Boolean).join("\n\n");

  return `Eres el generador del cuadrante de guardias de Radiodiagnóstico (Hospital Dr. Balmis).

RESIDENTES ACTIVOS EN ${nombreMes.toUpperCase()} — usa el "id" EXACTO como residenteId, nunca el
nombre. Junto a cada uno se indica el contaje acumulado de SU año de residencia en curso
(desde su último aniversario, hasta fin del mes anterior): úsalo para repartir con equidad
(±1) entre compañeros del mismo nivel, compensando a quien ya lleve más o menos guardias:

${bloques || "(sin residentes activos este mes)"}

${construirBloqueosTexto(bloqueosDelMes)}

${construirFestivosTexto(festivosDelMes, puentesDelMes)}

${construirVoluntarios3PTexto(voluntarios3P)}

${construirEventosTexto(eventos)}

${construirPreferenciasTexto(preferencias)}

NORMAS OPERATIVAS (resumen; ante la duda, prioriza la equidad):
1. Cada día lleva exactamente 1 guardia (G/GF/GP) de un residente Mayor (R3/R4) y 1 de un
   residente Pequeño (R1/R2). Excepción: 2 residentes R2 el mismo día solo se admite desde
   el 1 de diciembre y de forma justificada.
2. Cada residente hace entre 4 y 6 guardias computables (G+GF+GP) al mes; un Pequeño puede
   bajar excepcionalmente a 3 si la oferta de días no da para más.
3. Reparte con equidad (±1) dentro de cada año de residencia: total de guardias, findes,
   festivos, prefestivos y dobletes — usa el contaje acumulado de arriba como punto de
   partida, no repartas el mes como si todos empezaran de cero.
4. El 3.º puesto (código 3P) y las guardias cedidas/compradas no cuentan para el mínimo ni
   el máximo de guardias del punto 2.
5. Respeta la sección BLOQUEOS ACTIVOS de arriba: BAJA es obligatorio no asignar; VACACIONES
   y ROTACIÓN evita asignar si puedes, pero puedes hacerlo si no hay alternativa razonable.
6. Como máximo 2 residentes de la misma promoción (año de incorporación) pueden estar
   ausentes a la vez en rotación externa.
7. Si un residente rota en Alicante o provincia colindante (ver BLOQUEOS ACTIVOS), cúbrele
   guardia de viernes y de sábado durante esa rotación.
8. El 3.º puesto (3P) SOLO puede recaer en los VOLUNTARIOS listados arriba, nunca en otro
   residente. Recorre lunes→domingo antes de repetir día, con equidad entre ellos.
9. 2 residentes R2 el mismo día solo se admite desde el 1 de diciembre y justificado, o en
   un día de evento del servicio (Navidad, despedida).
10. Los eventos del servicio listados arriba se cubren con 2 R2 por sorteo documentado; si ya
    figuran los sorteados, respétalos. Usa EXCLUSIVAMENTE esas fechas: no deduzcas por tu
    cuenta cuándo cae la Navidad o la despedida del servicio.
11. Junio, julio y agosto: ningún R1 hace guardia — ese puesto de Pequeño lo cubren los R2,
    repartido con equidad entre ellos.
12. Usa el código GP para el prefestivo (la VÍSPERA de un festivo), GF para el propio festivo y
    G para el resto. Usa EXCLUSIVAMENTE las fechas festivas de la lista de arriba: no deduzcas
    festivos por tu cuenta ni por el calendario que creas recordar.

FORMATO DE RESPUESTA (obligatorio, sin excepciones):
Responde ÚNICAMENTE con un JSON con esta forma exacta, sin texto ni bloques markdown
alrededor:
{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G|GF|GP|3P"}]}

Genera el cuadrante completo de ${nombreMes} (mes=${mes}, año=${anio}) respetando estas normas.`;
}

/** Muestra acotada para los mensajes de rechazo: no vuelca 60 fechas o 60 ids en la pantalla. */
function muestraDe(valores) {
  const unicos = [...new Set(valores)].sort();
  return { n: unicos.length, texto: unicos.slice(0, 5).join(", ") + (unicos.length > 5 ? ` y ${unicos.length - 5} más` : "") };
}

function ViolationBox({ v, color, bg, residentes }) {
  return (
    <div style={{ fontSize: 12, color, background: bg, borderRadius: 6, padding: "4px 8px" }}>
      [{v.invariante}] {violationText(v, residentes)}
    </div>
  );
}

function GeneratorScreen() {
  const app = window.useApp();
  const { mes, anio, residentes, api, showToast, setTab, setLoading } = app;

  const monthStart = useMemo(() => toISO(anio, mes, 1), [anio, mes]);
  const nombreMes = useMemo(() => nombreMesDe(anio, mes), [anio, mes]);
  // Agrupa por nivel a fecha `monthStart` (día 1), el MISMO ancla que usa accumulatedTally
  // internamente (vía periodOn) para resolver el periodo formativo en curso — si aquí se
  // usara otra fecha (p.ej. el día 15), un residente cuyo aniversario cae a mitad de mes
  // aparecería bajo su nivel nuevo con el contaje acumulado de su año saliente (~1 año en
  // vez de unos meses), descuadrando la equidad que el prompt le pide a la IA.
  const porNivel = useMemo(() => agruparPorNivel(residentes, monthStart), [residentes, monthStart]);

  // Bloqueos del equipo y guardias históricas del entorno del mes (Fase 6.1): el prompt
  // portátil necesita datos reales, no "lo que sepa la IA por contexto" — y el validador
  // (comprobar(), abajo) necesita las mismas dos cosas para INV-5/6/7 (bloqueos) e INV-7
  // cross-mes (contrato C-2: la rotación puede empezar en un mes anterior al generado).
  // `historicas` incluye deliberadamente 1-2 días DENTRO del mes generado (lookahead de
  // doblete, contrato C-1) — comprobar() recorta ese solape antes de usarlo (ver abajo)
  // para no duplicar esos días frente a la respuesta pegada por el usuario.
  const [bloqueos, setBloqueos] = useState([]);
  const [historicas, setHistoricas] = useState([]);
  const [cargandoContexto, setCargandoContexto] = useState(true);
  const [contextError, setContextError] = useState(null);
  const [retryTick, setRetryTick] = useState(0);
  // Estado del cuadrante (Fase 6.2): un mes PUBLICADO no admite aplicar el generador — el
  // servidor ya lo rechaza en guardarAsignaciones, esto solo lo refleja en la UI.
  const [estadoCuadrante, setEstadoCuadrante] = useState("BORRADOR");
  const [festivos, setFestivos] = useState([]);
  // Las tres piezas que le faltaban al prompt. Ninguna es load-bearing para aplicar (a diferencia
  // de bloqueos/estado/existentes): si fallan, el prompt lo DICE en su sección y la pantalla sigue
  // siendo usable, igual que ya se hacía con los festivos. `eventos` además entra en la validación
  // (INV-10), que hasta ahora corría siempre con la lista vacía.
  const [voluntarios3P, setVoluntarios3P] = useState([]);
  const [eventos, setEventos] = useState([]);
  const [preferencias, setPreferencias] = useState([]);
  // Lo que el mes YA tiene. No entra en la validación (eso duplicaría lo pegado), pero sin ello
  // no se puede aplicar bien: `guardarAsignaciones` es append-only y mandar solo las filas nuevas
  // AÑADE — ver client/lib/apply-month.js.
  const [existentes, setExistentes] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCargandoContexto(true);
      setContextError(null);
      setLoading(true);

      const monthEnd = toISO(anio, mes, daysInMonth(anio, mes));
      const [rBloqueos, rEstado, rFestivos, rExistentes, r3P, rEventos, rPrefs] = await Promise.all([
        api.listBloqueos(anio, mes),
        api.estadoCuadrante(anio, mes),
        // Con margen: el vecino del día 1 y el del último día deciden si son puente (§3.4).
        api.listFestivosRango(addDays(monthStart, -1), addDays(monthEnd, 1)),
        api.listAsignaciones(anio, mes),
        api.estadoVoluntariado3P(),
        api.listEventos(),
        api.listPreferencias(anio, mes),
      ]);
      if (cancelled) return;
      // Un fallo de estadoCuadrante o del cuadrante actual pasa por el MISMO contextError que un
      // fallo de bloqueos: si no se sabe el estado real no se puede asegurar que el mes no esté
      // PUBLICADO, y si no se sabe qué hay escrito ya, aplicar añadiría encima en vez de
      // reemplazar — que es justo el fallo que apply-month.js existe para cerrar.
      const fallo = !rBloqueos.ok ? "No se pudieron cargar los bloqueos: " + rBloqueos.error
        : !rEstado.ok ? "No se pudo comprobar el estado del cuadrante: " + rEstado.error
        : !rExistentes.ok ? "No se pudo leer el cuadrante actual del mes: " + rExistentes.error
        : null;
      if (fallo) {
        setLoading(false);
        setContextError(fallo);
        setCargandoContexto(false);
        // Se resetean (no se dejan los del mes anterior): con contextError activo el
        // prompt/comprobar() no deben mostrar datos reales de OTRO mes como si fueran de este.
        setBloqueos([]);
        setHistoricas([]);
        setFestivos([]);
        setExistentes([]);
        setVoluntarios3P([]);
        setEventos([]);
        setPreferencias([]);
        return;
      }
      setExistentes(rExistentes.asignaciones);
      setEstadoCuadrante(rEstado.estado);
      // Un fallo al cargar festivos NO tumba la pantalla (INV-12 es aviso, V-14), pero tampoco
      // se calla: sin ellos el prompt le dice al modelo que no invente ninguno. Mismo criterio
      // para voluntarios 3P, eventos y preferencias: cada sección del prompt dice explícitamente
      // que no hay datos, que es muy distinto de omitir la sección y dejar al modelo improvisar.
      const degradados = [
        !rFestivos.ok && "los festivos",
        !r3P.ok && "los voluntarios del 3.º puesto",
        !rEventos.ok && "los eventos del servicio",
        !rPrefs.ok && "las preferencias del equipo",
      ].filter(Boolean);
      if (degradados.length > 0) {
        showToast(`No se pudieron cargar ${degradados.join(", ")} — el prompt irá sin esos datos`, "err");
      }
      setFestivos(rFestivos.ok ? rFestivos.festivos : []);
      setVoluntarios3P(r3P.ok ? r3P.voluntarios : []);
      setEventos(rEventos.ok ? rEventos.eventos : []);
      setPreferencias(rPrefs.ok ? rPrefs.preferencias : []);

      // Rango del histórico: cubre (a) desde el inicio del año de residencia en curso más
      // antiguo entre los residentes activos (para accumulatedTally, contrato C-1) y (b)
      // desde la fecha REAL de cualquier bloqueo ROTACION cercana que termine este mes (para
      // INV-7 cross-mes, contrato C-2 — mismo criterio que Calendar.jsx vía rotationHistoryStart,
      // compartido en v2/domain/validate.js). El límite superior entra 1-2 días dentro del mes
      // generado solo para el lookahead de doblete de (a).
      const desdesAcumulado = residentes
        .map((r) => {
          const periodo = periodOn(periodsOfResident(r), monthStart);
          return periodo ? periodo.start : null;
        })
        .filter(Boolean);
      const desdeRotacion = rotationHistoryStart(rBloqueos.bloqueos, monthStart);
      const desde3P = thirdPostHistoryStart(r3P.ok ? (r3P.voluntarios || []) : [], residentes, mes, anio);
      const candidatos = [...desdesAcumulado, desdeRotacion, desde3P].filter(Boolean);

      const rHist = candidatos.length === 0
        ? { ok: true, asignaciones: [] }
        : await api.listAsignacionesRango(candidatos.reduce((min, d) => (d < min ? d : min)), addDays(monthStart, 1));
      setLoading(false);
      if (cancelled) return;
      if (!rHist.ok) {
        setContextError("No se pudo cargar el histórico de guardias: " + rHist.error);
        setCargandoContexto(false);
        // Se vacía TODO el contexto, igual que en la rama de arriba: con contextError activo el
        // prompt no debe seguir enseñando media carga como si estuviera completa. Antes se
        // dejaban los festivos puestos y el prompt salía a medias sin decirlo.
        setBloqueos([]);
        setHistoricas([]);
        setExistentes([]);
        setFestivos([]);
        setVoluntarios3P([]);
        setEventos([]);
        setPreferencias([]);
        return;
      }
      setBloqueos(rBloqueos.bloqueos);
      setHistoricas(rHist.asignaciones);
      setCargandoContexto(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes, residentes, retryTick]);

  const acumulados = useMemo(
    () => accumulatedTally(residentes, historicas, addDays(monthStart, -1)),
    [residentes, historicas, monthStart]
  );
  // Los puentes se DERIVAN de los festivos (§3.4), nunca se piden ni se escriben a mano.
  const puentes = useMemo(() => bridgesOfMonth(anio, mes, festivos), [anio, mes, festivos]);
  const festivosDelMes = useMemo(
    () => festivos.filter((f) => f.fecha.startsWith(monthStart.slice(0, 7))),
    [festivos, monthStart]
  );
  // Cuántas guardias tiene ya el mes. Es exactamente "cuántas se perderían si la propuesta no
  // reemplazara ninguna", así que sale del mismo sitio que el plan real en vez de repetir aquí
  // qué códigos le pertenecen al generador.
  const guardiasEnElMes = useMemo(
    () => monthReplacementPlan({ mes, anio, residentes, existentes, propuesta: [] }).borradas.length,
    [mes, anio, residentes, existentes]
  );
  // Solo los eventos del curso del mes que se está generando: la Navidad de diciembre empareja
  // con la despedida del mayo SIGUIENTE (año académico jun→may), que es el mismo criterio que
  // aplica shapeEventos dentro de buildMonthContext — el prompt y el validador tienen que estar
  // mirando exactamente los mismos eventos.
  const eventosDelCurso = useMemo(() => {
    const curso = academicYearOf(monthStart);
    return eventos.filter((e) => e && e.activo !== false && academicYearOf(e.fecha) === curso);
  }, [eventos, monthStart]);
  const promptText = useMemo(
    () => construirPrompt({
      mes, anio, nombreMes, porNivel, acumulados, bloqueosDelMes: bloqueos, festivosDelMes,
      puentesDelMes: puentes, voluntarios3P, eventos: eventosDelCurso, preferencias,
    }),
    [mes, anio, nombreMes, porNivel, acumulados, bloqueos, festivosDelMes, puentes, voluntarios3P, eventosDelCurso, preferencias]
  );

  const [respuesta, setRespuesta] = useState("");
  const [parseError, setParseError] = useState(null);
  const [violaciones, setViolaciones] = useState(null); // null = aún no comprobado
  const [parsedAsignaciones, setParsedAsignaciones] = useState(null);
  const [plan, setPlan] = useState(null); // lo que se escribiría al aplicar (apply-month.js)
  const [applying, setApplying] = useState(false);
  const [comprobando, setComprobando] = useState(false);
  // Qué ámbitos NO se han podido comprobar (cierres de INV-3, tercer puesto). No es lo mismo que
  // "sin violaciones": es "no se sabe", y se pregunta antes de aplicar en vez de darlo por bueno.
  const [checksIncompletos, setChecksIncompletos] = useState([]);
  const [confirmarAplicar, setConfirmarAplicar] = useState(false);

  // `comprobar()` pasó a tener red (cierres de INV-3 e INV-8), así que ahora hay una ventana entre
  // que arranca y que termina. `runRef` numera cada pasada y `respuestaVigenteRef` guarda el texto
  // que hay REALMENTE en el textarea: si al volver de la red no coinciden, el veredicto habla de
  // algo que ya no está en pantalla y se tira. Sin esto, editar la respuesta mientras se comprueba
  // dejaba el veredicto viejo —y su `plan.cambios`— asociado al texto nuevo.
  //
  // La ref del texto se escribe EN RENDER y no en un efecto: un efecto corre después, y en esa
  // ventana la comprobación en vuelo todavía se daría por vigente. Escribirla en render es
  // idempotente y no depende del orden de los efectos.
  const runRef = useRef(0);
  const respuestaVigenteRef = useRef("");
  respuestaVigenteRef.current = respuesta;

  const onRespuestaChange = (v) => {
    setRespuesta(v);
    setParseError(null);
    setViolaciones(null);
    setParsedAsignaciones(null);
    setPlan(null);
    setChecksIncompletos([]);
    setConfirmarAplicar(false);
    // El diagnóstico describe la propuesta que generó ESTE texto: en cuanto el texto cambia deja
    // de hablar de lo que hay en pantalla.
    setDiagnostico(null);
  };

  // Nombre de pila por id, solo para el resumen del reparto: el diagnóstico del dominio habla
  // de ids (no conoce nombres) y una lista de UUIDs no la lee nadie.
  const nombreDe = useMemo(() => {
    const m = new Map(residentes.map((r) => [r.id, (r.nombre || r.id).split(" ")[0]]));
    return (id) => m.get(id) || id;
  }, [residentes]);

  // Semilla de la propuesta: subirla da OTRO cuadrante igual de válido. Es lo que convierte
  // «no me convence» en algo accionable sin tener que editar la rejilla a mano.
  const [semilla, setSemilla] = useState(1);
  const [diagnostico, setDiagnostico] = useState(null);
  // Cuántos 3P se le piden al generador. CERO por defecto (decisión V-38): el 3.º puesto es
  // voluntario y la tabla `voluntarios3P` dice quién se apunta, no cuántos quiere hacer, así que
  // la cantidad la pone una persona. Con 0 el generador se comporta como antes de V-38 y, además,
  // no toca los 3P que ya hubiera puestos a mano (apply-month.js).
  const [tercerPuesto, setTercerPuesto] = useState(0);
  // Los 3P ANTERIORES al mes, para el ciclo L-D de INV-8b. Salen del histórico que ya está
  // cargado —cuyo rango incluye el `desde` de los voluntarios— y se recortan con la misma
  // función que usa la validación, no con una copia.
  const historial3P = useMemo(() => shapeThirdPostHistory(historicas, monthStart), [historicas, monthStart]);

  const generar = (nuevaSemilla) => {
    const s = nuevaSemilla === undefined ? semilla : nuevaSemilla;
    setSemilla(s);
    // El MISMO ctx que arma comprobar(), con el mes vacío: lo que se genera es justo el mes.
    const ctx = buildMonthContext({
      mes, anio, residentes,
      historicas: historicas.filter((a) => a.fecha < monthStart),
      asignacionesDelMes: [],
      bloqueos, festivos, eventos,
    });
    try {
      const { asignaciones, diagnostico: d } = generateMonth(ctx, { semilla: s, tercerPuesto, voluntarios3P, historial3P });
      // Por onRespuestaChange y no por setRespuesta: tiene que invalidar el veredicto anterior
      // igual que si el usuario hubiera pegado texto nuevo. Va ANTES de fijar el diagnóstico,
      // porque es quien lo limpia: al revés, se borraría el diagnóstico recién calculado.
      onRespuestaChange(JSON.stringify({ asignaciones }, null, 1));
      setDiagnostico(d);
    } catch (e) {
      setDiagnostico(null);
      showToast("No se pudo generar la propuesta: " + e.message, "err");
    }
  };

  const copiarPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      showToast("Prompt copiado — pégalo en claude.ai");
    } catch (e) {
      showToast("No se pudo copiar el prompt: " + e.message, "err");
    }
  };

  const comprobar = async () => {
    const run = runRef.current + 1;
    runRef.current = run;
    const textoComprobado = respuesta;

    // Un único punto de rechazo: cada motivo tiene que dejar la pantalla en el mismo estado (sin
    // veredicto y sin plan de escritura), y ya eran tres copias de lo mismo antes de sumar la
    // comprobación de las fechas de abajo.
    const rechaza = (msg) => {
      setParseError(msg);
      setViolaciones(null);
      setParsedAsignaciones(null);
      setPlan(null);
      setChecksIncompletos([]);
      setConfirmarAplicar(false);
    };
    const texto = respuesta.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(texto);
    } catch (e) {
      return rechaza("La respuesta no es JSON válido: " + e.message);
    }
    const asignacionesRespuesta = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.asignaciones)) ? parsed.asignaciones : null;
    if (!asignacionesRespuesta) {
      return rechaza('El JSON debe tener la forma {"asignaciones": [...]}');
    }

    // El plan de escritura se calcula ANTES de validar: si la respuesta trae fechas que no son de
    // este mes, el veredicto de abajo no hablaría de ellas —`validateMonth` solo mira los días
    // del mes— y aplicar las escribiría igual, en otro mes y cambiándole el estado de paso. Se
    // rechaza entera: lo que ha devuelto el asistente no es el mes que se le pidió.
    const nuevoPlan = monthReplacementPlan({ mes, anio, residentes, existentes, propuesta: asignacionesRespuesta });
    if (nuevoPlan.fueraDelMes.length > 0) {
      const { texto } = muestraDe(nuevoPlan.fueraDelMes.map((a) => a.fecha));
      return rechaza(`La respuesta trae ${nuevoPlan.fueraDelMes.length} asignación(es) con fechas que no son de ${nombreMes}: ${texto}. Pide al asistente que las corrija y vuelve a pegarla.`);
    }
    // Un id inventado solo produce `aviso` en INV-1 (V-21), así que se aplicaba: filas que nadie
    // puede ver ni corregir desde la rejilla, en una tabla que no se borra nunca. Y ahora que
    // aplicar REEMPLAZA el mes, además borraría el cuadrante bueno a cambio de nada visible.
    if (nuevoPlan.desconocidos.length > 0) {
      const { n, texto } = muestraDe(nuevoPlan.desconocidos.map((a) => a.residenteId));
      return rechaza(`La respuesta usa ${n} identificador(es) que no son de ningún residente: ${texto}. Pide al asistente que use los "id" exactos del prompt y vuelve a pegarla.`);
    }
    // El histórico (meses anteriores, ya cargado para el contaje acumulado) más la respuesta
    // del asistente: INV-7 (contrato C-2) necesita ver la rotación completa, no solo el mes
    // generado, y sin bloqueos aquí INV-5/6/7 nunca se comprobaban. `historicas` trae 1-2 días
    // DENTRO de este mes (lookahead de doblete, C-1) — se recortan aquí para no duplicarlos
    // frente a `asignacionesRespuesta`, que ya cubre el mes completo.
    const ctx = buildMonthContext({
      mes, anio, residentes,
      historicas: historicas.filter((a) => a.fecha < monthStart),
      asignacionesDelMes: asignacionesRespuesta,
      bloqueos,
      festivos,
      // Sin esto INV-10 corría siempre con la lista vacía: el validador del Generador no podía
      // emitir un solo aviso de evento por mucho que la tabla estuviera rellena.
      eventos,
    });
    let violacionesMes;
    try {
      violacionesMes = validateMonth(ctx);
    } catch (e) {
      return rechaza("La respuesta no se pudo validar: " + e.message);
    }

    // Los dos ámbitos de fuera del mes. `validateMonth` no los cubre a propósito (es de ámbito
    // mes) y esta pantalla llevaba desde P-8 sin llamarlos: quien aplicaba una propuesta de la IA
    // no veía ni la equidad de cierre de INV-3 ni los 3P mal repartidos. Van en paralelo y cada
    // uno resuelve su propio histórico (quarterCloseWindow / thirdPostHistoryStart): los rangos
    // no se adivinan aquí, que es el error que costó la regresión del contrato C-2.
    setComprobando(true);
    const [rCierres, r3P] = await Promise.all([
      closeViolations({ api, mes, anio, residentes, asignacionesDelMes: asignacionesRespuesta }),
      thirdPostViolations({ api, mes, anio, residentes, asignacionesDelMes: asignacionesRespuesta }),
    ]);
    // El flag se suelta salvo que otra comprobación haya arrancado detrás: en ese caso es suya, y
    // apagarlo aquí dejaría el botón diciendo que no hay nada en curso cuando sí lo hay.
    const soyLaUltima = runRef.current === run;
    if (soyLaUltima) setComprobando(false);
    // El usuario pudo reescribir la respuesta mientras esto viajaba: el veredicto ya no habla de
    // lo que hay en pantalla, así que se tira entero en vez de pintarlo.
    if (!soyLaUltima || respuestaVigenteRef.current !== textoComprobado) return;

    // Un fallo de red NO se traduce en "sin violaciones": se nombra lo que quedó sin mirar y se
    // pide confirmación antes de aplicar (V-14 — avisar y preguntar, nunca bloquear en seco).
    const incompletos = [
      !rCierres.ok && { que: "la equidad de cierre (INV-3)", error: rCierres.error },
      !r3P.ok && { que: "el tercer puesto (INV-8)", error: r3P.error },
    ].filter(Boolean);

    setParseError(null);
    setViolaciones([
      ...violacionesMes,
      ...(rCierres.ok ? rCierres.violaciones : []),
      ...(r3P.ok ? r3P.violaciones : []),
    ]);
    setParsedAsignaciones(asignacionesRespuesta);
    setPlan(nuevoPlan);
    setChecksIncompletos(incompletos);
    setConfirmarAplicar(false);
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");
  const cuadrantePublicado = !canEdit(estadoCuadrante);
  // `parsedAsignaciones.length > 0` y no `plan.cambios.length`: un `{"asignaciones": []}` genera un
  // plan que solo borra, y "aplicar" no puede ser la forma de vaciar el mes de un botonazo.
  const puedeAplicar = violaciones !== null && errores.length === 0 && parsedAsignaciones && parsedAsignaciones.length > 0 && !cuadrantePublicado && !comprobando;
  const guardiasQueSePierden = plan ? plan.borradas.length : 0;
  // Lo que no se ha podido comprobar se pregunta, no se bloquea ni se pasa por alto (V-14): el
  // primer clic solo enseña qué quedó sin mirar, el segundo aplica de verdad.
  const faltaConfirmar = checksIncompletos.length > 0 && !confirmarAplicar;

  const aplicar = async () => {
    setApplying(true);
    setLoading(true);
    // `plan.cambios`, no la propuesta a secas: incluye el borrado de las guardias previas que la
    // propuesta no reemplaza. Mandar solo la propuesta AÑADE sobre lo que hubiera (la tabla es
    // append-only con clave fecha|residenteId) y dejaba días con tres personas justo después de
    // un "sin violaciones" — ver client/lib/apply-month.js.
    const r = await api.guardarAsignaciones(plan.cambios);
    setLoading(false);
    setApplying(false);
    if (r.ok) {
      showToast("Cuadrante aplicado ✓");
      setTab("calendar");
    } else {
      showToast("Error aplicando el cuadrante: " + r.error, "err");
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
      <SectionTitle>🤖 Generador de cuadrante</SectionTitle>

      <Info>
        El generador reparte el mes aquí mismo, sin red y sin llamar a ninguna IA, persiguiendo
        el reparto acumulado de cada año de residencia. Si prefieres pedírselo a un asistente,
        abajo tienes el prompt con los mismos datos. Salga de donde salga, la propuesta pasa
        por la misma validación antes de poder aplicarse.
      </Info>

      {contextError && (
        <Aviso color={COLOR.red} bg={COLOR.redLight}>
          {contextError} — el prompt y la validación pueden faltar bloqueos o contaje
          acumulado hasta que reintentes.
          <div style={{ marginTop: 8 }}>
            <Btn onClick={() => setRetryTick((t) => t + 1)}>🔄 Reintentar</Btn>
          </div>
        </Aviso>
      )}

      {!contextError && guardiasEnElMes > 0 && (
        <Aviso>
          {nombreMes} ya tiene {guardiasEnElMes} guardia{guardiasEnElMes === 1 ? "" : "s"} asignada
          {guardiasEnElMes === 1 ? "" : "s"}. Aplicar una propuesta <b>reemplaza</b> el mes: quedará
          exactamente lo que valides aquí abajo. Las marcas V/R/B de la rejilla se conservan.
        </Aviso>
      )}

      <Card title={`1. Generar el cuadrante de ${nombreMes}`}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
          Reparte el mes equilibrando el acumulado del año de residencia de cada uno, sin
          asignar a nadie dos días seguidos ni sobre una baja. La propuesta cae en el cuadro de
          abajo, donde puedes revisarla o retocarla antes de comprobarla.
        </div>
        {/* El 3.º puesto es VOLUNTARIO: la app no decide cuántos se hacen (V-38). Por eso el número
            lo pone una persona y arranca en 0, que es el comportamiento de siempre. Sin voluntarios
            apuntados no se ofrece: pedirlos no haría nada y el diagnóstico tendría que explicarlo. */}
        {voluntarios3P.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
            Terceros puestos (3P) a repartir:
            <input
              type="number" min={0} max={31} value={tercerPuesto}
              onChange={(e) => setTercerPuesto(Math.max(0, Math.min(31, Number(e.target.value) || 0)))}
              style={{ width: 64, padding: "4px 6px", border: `1px solid ${COLOR.gray}`, borderRadius: 6, fontSize: 12 }}
            />
            <span>entre los {voluntarios3P.length} voluntario{voluntarios3P.length === 1 ? "" : "s"} apuntados. Se colocan primero en los días con R1.</span>
          </label>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => generar(1)} disabled={cargandoContexto || !!contextError} color={COLOR.blue}>
            {cargandoContexto ? "Cargando contexto…" : "⚙️ Generar propuesta"}
          </Btn>
          {diagnostico && (
            <Btn onClick={() => generar(semilla + 1)} disabled={cargandoContexto || !!contextError}>
              🎲 Otra distinta
            </Btn>
          )}
        </div>

        {diagnostico && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, color: COLOR.grayDark }}>
              Reparto {semilla > 1 ? `nº ${semilla}` : ""} — guardias por residente:{" "}
              {diagnostico.residentes.filter((r) => r.guardiasDelMes > 0)
                .map((r) => `${nombreDe(r.id)} ${r.guardiasDelMes}`).join(" · ")}
            </div>
            {/* `coste` a 0 = los seis ejes de INV-3 dentro de ±1 en las cohortes comparables. No es
                una promesa sobre el cierre anual: aquí solo se ha decidido un mes. */}
            {diagnostico.coste === 0 ? (
              <div style={{ fontSize: 12, color: COLOR.green, fontWeight: 700 }}>
                ⚖️ Equidad acumulada dentro de ±1 en los seis ejes
              </div>
            ) : (
              <Aviso>
                No se ha podido dejar los seis ejes de equidad dentro de ±1 con solo este mes
                (le falta {Math.round(diagnostico.coste * 100) / 100}). Suele significar que
                alguien llega con demasiada ventaja acumulada y hará falta más de un mes para
                compensarla — no es un error, es lo mejor alcanzable ahora.
              </Aviso>
            )}
            {diagnostico.tercerPuesto && diagnostico.tercerPuesto.pedidas > 0 && (
              diagnostico.tercerPuesto.colocadas === diagnostico.tercerPuesto.pedidas ? (
                <div style={{ fontSize: 12, color: COLOR.grayDark }}>
                  3P repartidos: {diagnostico.tercerPuesto.porResidente.map((x) => `${nombreDe(x.id)} ${x.n}`).join(" · ")}
                  {diagnostico.tercerPuesto.diasMochila > 0 ? ` — en días con R1 (${diagnostico.tercerPuesto.diasMochila} disponibles)` : ""}
                </div>
              ) : (
                <Aviso>
                  Se pidieron {diagnostico.tercerPuesto.pedidas} terceros puestos y solo caben{" "}
                  {diagnostico.tercerPuesto.colocadas}
                  {diagnostico.tercerPuesto.motivo === "sin-voluntarios" ? ": no hay nadie apuntado al 3P"
                    : diagnostico.tercerPuesto.motivo === "sin-voluntarios-activos" ? ": los apuntados no hacen guardias este mes"
                    : diagnostico.tercerPuesto.motivo === "mochila-sin-cubrir" ? ": quedan días con R1 que ningún voluntario puede cubrir, y salirse de ellos incumpliría la prioridad de INV-8d"
                    : ": el ciclo de 7 días de INV-8b y el descanso de INV-15 no dejan hueco a más"}.
                  El resto hay que colocarlos a mano, o apuntar a más gente al 3P.
                </Aviso>
              )
            )}
            {/* Los dos motivos de `sinCubrir` se dicen por separado porque tienen arreglos
                distintos, y V-35 los distingue justo para poder decirlo: «sin elegibles» es que
                ese día no había nadie a quien asignar, y «descanso» es que quien quedaba venía de
                guardia la víspera. Antes había aquí un segundo bloque para `adyacenciaForzada`,
                que V-35 eliminó del diagnóstico al dejar de ceder — y como el `.length` seguía
                leyéndose, generar una propuesta tumbaba la pantalla ENTERA. */}
            {diagnostico.sinCubrir.length > 0 && (
              <Aviso color={COLOR.red} bg={COLOR.redLight}>
                {diagnostico.sinCubrir.length} puesto(s) sin cubrir
                ({[...new Set(diagnostico.sinCubrir.map((s) => s.puesto))].join(" y ")}):{" "}
                {diagnostico.sinCubrir.filter((s) => s.motivo === "sin elegibles").length > 0 && (
                  <>{diagnostico.sinCubrir.filter((s) => s.motivo === "sin elegibles").length} sin
                  ningún residente elegible ese día</>
                )}
                {diagnostico.sinCubrir.some((s) => s.motivo === "sin elegibles")
                  && diagnostico.sinCubrir.some((s) => s.motivo === "descanso") ? ", y " : ""}
                {diagnostico.sinCubrir.filter((s) => s.motivo === "descanso").length > 0 && (
                  <>{diagnostico.sinCubrir.filter((s) => s.motivo === "descanso").length} porque a
                  quien quedaba le tocaba descansar tras la guardia de la víspera (INV-15)</>
                )}
                . Días: {diagnostico.sinCubrir.slice(0, 5).map((s) => s.fecha).join(", ")}
                {diagnostico.sinCubrir.length > 5 ? "…" : ""}. Un día con los dos puestos vacíos es
                error de INV-1 e impide validar el mes; hay que resolverlo fuera de la herramienta.
              </Aviso>
            )}
          </div>
        )}
      </Card>

      <Card title={`2. …o pídeselo a un asistente (prompt de ${nombreMes})`}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 8 }}>
          Copia el prompt, pégalo en claude.ai u otro asistente y trae aquí abajo el JSON que
          te devuelva. Lleva los mismos datos que usa el generador de arriba.
        </div>
        <textarea readOnly value={promptText} rows={10} style={{
          ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT,
          fontSize: 11.5, lineHeight: 1.5, resize: "vertical", background: COLOR.gray, color: COLOR.bodyText,
        }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={copiarPrompt} disabled={cargandoContexto || !!contextError}>
            {cargandoContexto ? "Cargando contexto…" : "📋 Copiar prompt"}
          </Btn>
        </div>
      </Card>

      <Card title="3. Propuesta">
        <textarea value={respuesta} onChange={(e) => onRespuestaChange(e.target.value)} rows={10}
          placeholder='{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G"}]}'
          style={{ ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT, fontSize: 12, resize: "vertical" }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={comprobar} disabled={!respuesta.trim() || cargandoContexto || comprobando || !!contextError} aria-busy={cargandoContexto || comprobando}>
            {cargandoContexto ? "Cargando contexto…" : comprobando ? "Comprobando…" : "Comprobar y aplicar"}
          </Btn>
        </div>
      </Card>

      {parseError && <Aviso color={COLOR.red} bg={COLOR.redLight}>{parseError}</Aviso>}

      {violaciones !== null && !parseError && (
        <Card title="4. Resultado de la validación">
          {violaciones.length === 0 ? (
            <div style={{ color: COLOR.green, fontWeight: 700, fontSize: 14 }}>✅ Sin violaciones</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {errores.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.red, marginBottom: 6 }}>⛔ Errores ({errores.length}) — bloquean la aplicación</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {errores.map((v, i) => <ViolationBox key={i} v={v} residentes={residentes} color={COLOR.red} bg={COLOR.redLight} />)}
                  </div>
                </div>
              )}
              {avisos.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, marginBottom: 6 }}>⚠️ Avisos ({avisos.length}) — informativos</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {avisos.map((v, i) => <ViolationBox key={i} v={v} residentes={residentes} color={COLOR.orange} bg={COLOR.orangeLight} />)}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {errores.length > 0 ? (
              <Aviso>
                Hay errores bloqueantes: no se puede aplicar este cuadrante tal cual.
                Corrígelo a mano en la pantalla Cuadrante, o pide al asistente que corrija
                estos puntos concretos y vuelve a pegar aquí la respuesta.
              </Aviso>
            ) : cuadrantePublicado ? (
              <Aviso>
                El cuadrante de {nombreMes} ya está PUBLICADO: no admite ediciones. Si hace
                falta corregirlo, el Responsable puede despublicarlo desde la pantalla Cuadrante.
              </Aviso>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {guardiasQueSePierden > 0 && (
                  <Aviso>
                    Aplicar eliminará {guardiasQueSePierden} guardia{guardiasQueSePierden === 1 ? "" : "s"} del
                    cuadrante actual de {nombreMes} que esta propuesta no incluye. El mes quedará exactamente
                    como lo validado arriba.
                  </Aviso>
                )}
                {/* Nombra lo que de verdad falló, como en Calendar.jsx: atribuir a los cierres un
                    fallo del tercer puesto manda a buscar el problema al sitio equivocado. */}
                {checksIncompletos.length > 0 && (
                  <Aviso color={COLOR.orange} bg={COLOR.orangeLight}>
                    <b>⚖️ No se ha podido comprobar {checksIncompletos.map((c) => c.que).join(" ni ")}.</b>
                    <div style={{ marginTop: 4 }}>
                      {/* Deduplicado: los dos fallan casi siempre por lo mismo (la red, la sesión), y
                          repetir el mismo texto dos veces se lee como si fueran dos problemas. */}
                      {[...new Set(checksIncompletos.map((c) => c.error))].join(" · ")}. El resto de la propuesta sí se ha
                      validado; eso queda sin mirar. Puedes aplicarla igualmente y revisarlo después en la
                      pantalla Cuadrante, que vuelve a comprobarlo.
                    </div>
                  </Aviso>
                )}
                <Btn
                  onClick={faltaConfirmar ? () => setConfirmarAplicar(true) : aplicar}
                  disabled={applying || !puedeAplicar}
                  color={faltaConfirmar ? COLOR.orange : COLOR.greenMid}
                >
                  {applying ? "Aplicando…"
                    : faltaConfirmar ? "Aplicar de todas formas"
                    : guardiasQueSePierden > 0 ? `♻️ Reemplazar el cuadrante de ${nombreMes}`
                    : "✅ Aplicar al cuadrante"}
                </Btn>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Generator = GeneratorScreen;

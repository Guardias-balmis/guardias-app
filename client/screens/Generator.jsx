// GeneratorScreen — sustituye a la antigua pantalla de IA. "Prompt portátil": sin llamada a
// ninguna API de terceros ni secreto en el cliente (spec: decisión del proyecto). Monta un
// prompt de texto para pegar en el asistente que el usuario prefiera y valida LOCALMENTE
// (validateMonth, sin red) la respuesta que devuelva — "la IA propone, el validador dispone"
// (spec.md §5), mismo esquema visual de violaciones que CalendarScreen.
import { COLOR, S, ANOS } from "./client/lib/design-tokens.js";
import { periodsOfResident, levelOn, groupOf, periodOn } from "./v2/domain/residents.js";
import { addDays, toISO, daysInMonth, bridgesOfMonth } from "./v2/domain/calendar.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "./v2/domain/validate.js";
import { accumulatedTally } from "./v2/domain/accumulate.js";
import { canEdit } from "./v2/domain/cuadrante.js";
import { violationText } from "./client/lib/violations.js";
import { monthReplacementPlan } from "./client/lib/apply-month.js";

const { useState, useMemo, useEffect } = React;
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

function construirPrompt({ mes, anio, nombreMes, porNivel, acumulados, bloqueosDelMes, festivosDelMes, puentesDelMes }) {
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
8. El 3.º puesto recorre lunes→domingo antes de repetir día, con equidad entre voluntarios.
9. 2 residentes R2 el mismo día solo se admite desde el 1 de diciembre y justificado, o en
   un día de evento del servicio (Navidad, despedida).
10. Los eventos del servicio (Navidad, cena de despedida) se cubren con 2 R2 por sorteo
    documentado; si no conoces esas fechas, ignora esta norma.
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
      const [rBloqueos, rEstado, rFestivos, rExistentes] = await Promise.all([
        api.listBloqueos(anio, mes),
        api.estadoCuadrante(anio, mes),
        // Con margen: el vecino del día 1 y el del último día deciden si son puente (§3.4).
        api.listFestivosRango(addDays(monthStart, -1), addDays(monthEnd, 1)),
        api.listAsignaciones(anio, mes),
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
        return;
      }
      setExistentes(rExistentes.asignaciones);
      setEstadoCuadrante(rEstado.estado);
      // Un fallo al cargar festivos NO tumba la pantalla (INV-12 es aviso, V-14), pero tampoco
      // se calla: sin ellos el prompt le dice al modelo que no invente ninguno.
      if (!rFestivos.ok) showToast("No se pudieron cargar los festivos: " + rFestivos.error, "err");
      setFestivos(rFestivos.ok ? rFestivos.festivos : []);

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
      const candidatos = desdeRotacion ? [...desdesAcumulado, desdeRotacion] : desdesAcumulado;

      const rHist = candidatos.length === 0
        ? { ok: true, asignaciones: [] }
        : await api.listAsignacionesRango(candidatos.reduce((min, d) => (d < min ? d : min)), addDays(monthStart, 1));
      setLoading(false);
      if (cancelled) return;
      if (!rHist.ok) {
        setContextError("No se pudo cargar el histórico de guardias: " + rHist.error);
        setCargandoContexto(false);
        setBloqueos([]);
        setHistoricas([]);
        setExistentes([]);
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
  const promptText = useMemo(
    () => construirPrompt({ mes, anio, nombreMes, porNivel, acumulados, bloqueosDelMes: bloqueos, festivosDelMes, puentesDelMes: puentes }),
    [mes, anio, nombreMes, porNivel, acumulados, bloqueos, festivosDelMes, puentes]
  );

  const [respuesta, setRespuesta] = useState("");
  const [parseError, setParseError] = useState(null);
  const [violaciones, setViolaciones] = useState(null); // null = aún no comprobado
  const [parsedAsignaciones, setParsedAsignaciones] = useState(null);
  const [plan, setPlan] = useState(null); // lo que se escribiría al aplicar (apply-month.js)
  const [applying, setApplying] = useState(false);

  const onRespuestaChange = (v) => {
    setRespuesta(v);
    setParseError(null);
    setViolaciones(null);
    setParsedAsignaciones(null);
    setPlan(null);
  };

  const copiarPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      showToast("Prompt copiado — pégalo en claude.ai");
    } catch (e) {
      showToast("No se pudo copiar el prompt: " + e.message, "err");
    }
  };

  const comprobar = () => {
    // Un único punto de rechazo: cada motivo tiene que dejar la pantalla en el mismo estado (sin
    // veredicto y sin plan de escritura), y ya eran tres copias de lo mismo antes de sumar la
    // comprobación de las fechas de abajo.
    const rechaza = (msg) => {
      setParseError(msg);
      setViolaciones(null);
      setParsedAsignaciones(null);
      setPlan(null);
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
    });
    try {
      setParseError(null);
      setViolaciones(validateMonth(ctx));
      setParsedAsignaciones(asignacionesRespuesta);
      setPlan(nuevoPlan);
    } catch (e) {
      return rechaza("La respuesta no se pudo validar: " + e.message);
    }
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");
  const cuadrantePublicado = !canEdit(estadoCuadrante);
  // `parsedAsignaciones.length > 0` y no `plan.cambios.length`: un `{"asignaciones": []}` genera un
  // plan que solo borra, y "aplicar" no puede ser la forma de vaciar el mes de un botonazo.
  const puedeAplicar = violaciones !== null && errores.length === 0 && parsedAsignaciones && parsedAsignaciones.length > 0 && !cuadrantePublicado;
  const guardiasQueSePierden = plan ? plan.borradas.length : 0;

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
        Esta pantalla no llama a ninguna IA: genera un prompt de texto para que lo pegues tú
        en el asistente que prefieras (claude.ai u otro) y valida aquí mismo, sin red, la
        respuesta que te devuelva.
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

      <Card title={`1. Prompt para ${nombreMes}`}>
        <textarea readOnly value={promptText} rows={12} style={{
          ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT,
          fontSize: 11.5, lineHeight: 1.5, resize: "vertical", background: COLOR.gray, color: COLOR.bodyText,
        }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={copiarPrompt} disabled={cargandoContexto || !!contextError}>
            {cargandoContexto ? "Cargando contexto…" : "📋 Copiar prompt"}
          </Btn>
        </div>
      </Card>

      <Info>
        1. Copia el prompt. 2. Pégalo en claude.ai (u otro asistente). 3. Pega aquí la
        respuesta JSON que te devuelva.
      </Info>

      <Card title="2. Respuesta del asistente">
        <textarea value={respuesta} onChange={(e) => onRespuestaChange(e.target.value)} rows={10}
          placeholder='{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G"}]}'
          style={{ ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT, fontSize: 12, resize: "vertical" }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={comprobar} disabled={!respuesta.trim() || cargandoContexto || !!contextError} aria-busy={cargandoContexto}>
            {cargandoContexto ? "Cargando contexto…" : "Comprobar y aplicar"}
          </Btn>
        </div>
      </Card>

      {parseError && <Aviso color={COLOR.red} bg={COLOR.redLight}>{parseError}</Aviso>}

      {violaciones !== null && !parseError && (
        <Card title="3. Resultado de la validación">
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
                <Btn onClick={aplicar} disabled={applying || !puedeAplicar} color={COLOR.greenMid}>
                  {applying ? "Aplicando…"
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

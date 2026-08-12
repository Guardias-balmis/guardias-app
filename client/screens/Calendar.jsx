// CalendarScreen — cuadrante mensual editable (app.mes/app.anio, COMPARTIDO con
// PrefsScreen: no se crea un selector de mes propio aquí). Guarda por residenteId,
// nunca por nombre (bug del v1); datesOfMonth/weekday para todo el cálculo de fechas
// (nunca `new Date(anio, mes, ...)` a mano, para no reintroducir el desfase de mes).
import { COLOR, S, ANOS, ANO_COLORS, ANO_TEXT, CODE_COLORS, CODE_LABELS, CODES_CYCLE, ESTADO_CUADRANTE, pillBtn } from "./client/lib/design-tokens.js";
import { levelOn, isActiveOn, periodsOfResident } from "./v2/domain/residents.js";
import { datesOfMonth, weekday, isWeekend, addDays, compareISO } from "./v2/domain/calendar.js";
import { tally } from "./v2/domain/tally.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "./v2/domain/validate.js";
import { canEdit, canValidate, canPublish, canUnpublish, stateAfterEdit, equityWarnings } from "./v2/domain/cuadrante.js";
import { closeViolations } from "./client/lib/closes.js";
import { thirdPostViolations } from "./client/lib/thirdpost.js";
import { puedeMoverCiclo as reglaCiclo } from "./client/lib/permisos.js";
import { violationText } from "./client/lib/violations.js";

const { useState, useEffect, useRef } = React;
const { Card, Btn, Aviso } = window.UI;

// Códigos que pueden llevar `origen` CEDIDA/COMPRADA (INV-4): los tres puestos de guardia y el
// 3P, no V/R/B (esas no son guardias, no las lee `tally`). Mantener presionado ~500ms abre el
// selector; un click normal sigue ciclando el código, instantáneo, sin demora (decisión: un
// doble-click habría obligado a retrasar CADA click simple de la grilla más usada de la app).
const ORIGEN_ELEGIBLE = new Set(["G", "GF", "GP", "3P"]);
const PRESS_MS = 500;

/**
 * Filas de la rejilla, ancladas al MES que se dibuja y no a hoy (decisión V-23), con la misma
 * regla que la pestaña publicada (`projection.js:activeResidents`): sale quien esté activo algún
 * día del mes, etiquetado por su nivel en su PRIMER día activo dentro de él.
 *
 * Los dos anclajes que NO valen, por si alguien los reintroduce:
 *  - `todayISO()` (lo que había aquí): un FINALIZADO desaparecía de TODOS los meses, incluidos
 *    los pasados en los que sí hizo guardias, y un mes que cruza un aniversario se agrupaba por
 *    el nivel de hoy mientras `validateMonth` lo juzga día a día — rejilla y validador
 *    discrepando sobre el mismo dato.
 *  - `dias[0]`: escondería al R1 que entra a mitad de mayo, que el día 1 todavía es PENDIENTE.
 *
 * `noAsignables` son los que no pueden hacer guardias ningún día del mes pero tienen algo escrito
 * en la rejilla. Se enseñan aparte y solo para borrar (V-23): sin esa fila, la única celda que
 * INV-1 señala (el aviso de V-21) sería precisamente la que no se puede ver ni tocar.
 */
function filasDelMes(residentes, dias, asignaciones) {
  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  const noAsignables = [];
  for (const r of residentes) {
    const periodos = periodsOfResident(r);
    const primerDiaActivo = dias.find((d) => isActiveOn(periodos, d));
    if (primerDiaActivo) {
      const nivel = levelOn(periodos, primerDiaActivo);
      if (porNivel[nivel]) porNivel[nivel].push(r);
      continue;
    }
    // Solo si hay algo que quitar: la fila no es un recordatorio permanente de que esta persona
    // existió, es el aviso de que queda una celda por limpiar. Se calcula sobre el estado vivo,
    // así que al vaciar la última la fila se va sola (el cambio pendiente sigue en el contador
    // de Guardar, que es lo que lo manda al servidor).
    if (dias.some((d) => (asignaciones[r.id] || {})[d])) {
      noAsignables.push({ residente: r, motivo: motivoNoAsignable(periodos, dias[0]) });
    }
  }
  return { porNivel, noAsignables };
}

/** Por qué no es asignable, con su fecha frontera — mismo diagnóstico que el aviso de INV-1 (V-21). */
function motivoNoAsignable(periodos, primerDia) {
  const fin = periodos[periodos.length - 1].end;
  return compareISO(primerDia, fin) > 0
    ? { etiqueta: "FIN", texto: `su residencia terminó el ${fin}` }
    : { etiqueta: "PEN", texto: `su residencia empieza el ${periodos[0].start}` };
}

/**
 * Una fila de la rejilla. La comparten los niveles y los no asignables (V-23): lo único que
 * cambia es la etiqueta, el color y qué hace la celda al pulsarla — en la de un no asignable,
 * `onCelda` solo borra.
 */
function FilaRejilla({
  nombre, etiqueta, bg, color, titulo, total, dias, porFecha, pulsable, onCelda,
  origenPorFecha, origenEditFecha, onPressStart, onPressEnd, onSeleccionaOrigen,
}) {
  return (
    <tr>
      <td style={{ ...S.td, textAlign: "center", fontWeight: 700, background: bg, color }} title={titulo}>{etiqueta}</td>
      <td style={{ ...S.td, whiteSpace: "nowrap", fontWeight: 600, color: COLOR.blueDark }} title={titulo}>{nombre.split(" ")[0]}</td>
      <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: COLOR.blue }}>{total}</td>
      {dias.map((fecha) => {
        const codigo = porFecha[fecha] || "";
        const origen = (origenPorFecha && origenPorFecha[fecha]) || "";
        const editando = origenEditFecha === fecha;
        const prensable = onPressStart && ORIGEN_ELEGIBLE.has(codigo);
        return (
          <td key={fecha} onClick={() => onCelda(fecha, codigo)}
            onMouseDown={prensable ? () => onPressStart(fecha, codigo) : undefined}
            onMouseUp={prensable ? onPressEnd : undefined}
            onMouseLeave={prensable ? onPressEnd : undefined}
            onTouchStart={prensable ? () => onPressStart(fecha, codigo) : undefined}
            onTouchEnd={prensable ? onPressEnd : undefined}
            onTouchCancel={prensable ? onPressEnd : undefined}
            style={{
              ...S.td, textAlign: "center", cursor: pulsable(codigo) ? "pointer" : "default", userSelect: "none",
              background: CODE_COLORS[codigo] || "transparent",
              fontWeight: codigo ? 700 : 400, color: COLOR.cellText, position: "relative",
            }}>
            {editando ? (
              <select autoFocus value={origen} onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSeleccionaOrigen(fecha, e.target.value)}
                onBlur={() => onSeleccionaOrigen(null)}
                style={{ fontSize: 10, width: 44, padding: 0 }}>
                <option value="">normal</option>
                <option value="CEDIDA">cedida</option>
                <option value="COMPRADA">comprada</option>
              </select>
            ) : (
              `${codigo || "·"}${origen ? "*" : ""}`
            )}
          </td>
        );
      })}
    </tr>
  );
}

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function CalendarScreen() {
  const app = window.useApp();
  const { anio, mes, setAnio, setMes, residentes, showToast, isResponsable, grupo } = app;

  const [asignaciones, setAsignaciones] = useState({}); // {[residenteId]: {[fecha]: codigo}}
  const [origenes, setOrigenes] = useState({});         // {[residenteId]: {[fecha]: "CEDIDA"|"COMPRADA"}} (INV-4)
  const [pendientes, setPendientes] = useState({});     // {[residenteId+"|"+fecha]: {fecha,residenteId,codigo,origen}}
  // Celda con el selector de origen abierto (mantener presionado), como `"residenteId|fecha"`.
  const [origenEditando, setOrigenEditando] = useState(null);
  const pressTimerRef = useRef(null);
  // Un mousedown/touchstart que llega a disparar el timer marca el click que le sigue como
  // "parte de una pulsación larga", para que ese click no cicle el código además de haber
  // abierto el selector — sin esto, soltar tras mantener presionado also dispara `onClick`.
  const longPressFiredRef = useRef(false);
  const [guardando, setGuardando] = useState(false);
  const [validando, setValidando] = useState(false);
  const [violaciones, setViolaciones] = useState(null); // null = aún no validado
  // Avisos de equidad pendientes de confirmar (decisión V-14): la equidad nunca bloquea, pero
  // pasar a VALIDADO incumpliéndola es una decisión que alguien toma a la vista de los avisos,
  // no un efecto colateral de pulsar Validar. null = no hay nada que confirmar.
  const [equidadPorConfirmar, setEquidadPorConfirmar] = useState(null);
  // Si los cierres no se pudieron COMPROBAR (red caída, backend sin la acción de rango todavía
  // desplegada) tampoco se bloquea: V-14 coherente — si la equidad no impide validar cuando se
  // puede calcular, menos aún cuando no. Se dice en pantalla y se pide la misma confirmación,
  // porque lo que no se sabe no se puede dar por bueno en silencio.
  // Dos comprobaciones distintas con su propio fallo: los cierres de equidad (INV-3) y el
  // tercer puesto (INV-8). Un solo estado compartido hacía que una pisara a la otra y que el
  // cartel atribuyera el fallo a la que no era.
  const [cierresError, setCierresError] = useState(null);
  const [tercerPuestoError, setTercerPuestoError] = useState(null);
  const [estado, setEstado] = useState("BORRADOR");
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  // Si estadoCuadrante falla (red, sesión) NO se asume BORRADOR: un mes realmente PUBLICADO
  // parecería editable por error. Mientras estadoError esté activo se bloquea la edición igual
  // que si estuviera PUBLICADO, y se muestra un aviso con reintento (mismo patrón que Generator.jsx).
  const [estadoError, setEstadoError] = useState(false);
  // Sin Responsable designado para el periodo, el ciclo lo puede mover cualquier Mayor
  // (decisión V-16, mismo criterio que el servidor en requireCicloPermiso): la app no se queda
  // bloqueada porque nadie haya lanzado el sorteo. Lo dice `estadoCuadrante`, no el token.
  const [sinResponsable, setSinResponsable] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const busy = guardando || validando || cambiandoEstado;
  // Mismo criterio que el servidor: el Responsable, o —si el mandato está sin decidir— cualquier
  // Mayor. Aquí solo decide qué botones se ven; quien manda es requireCicloPermiso en el router.
  const soyMayor = grupo === "MAYOR";
  const puedeMoverCiclo = reglaCiclo({ isResponsable, grupo, sinResponsable });
  const bloqueadoPorPublicado = !canEdit(estado) || estadoError;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      const [r, rEstado] = await Promise.all([app.api.listAsignaciones(anio, mes), app.api.estadoCuadrante(anio, mes)]);
      if (cancelled) return;
      if (r.ok) {
        const idx = {};
        const idxOrigen = {};
        for (const a of r.asignaciones) {
          if (!idx[a.residenteId]) idx[a.residenteId] = {};
          idx[a.residenteId][a.fecha] = a.codigo;
          if (a.origen) {
            if (!idxOrigen[a.residenteId]) idxOrigen[a.residenteId] = {};
            idxOrigen[a.residenteId][a.fecha] = a.origen;
          }
        }
        setAsignaciones(idx);
        setOrigenes(idxOrigen);
      } else {
        showToast("Error cargando cuadrante: " + r.error, "err");
      }
      setEstadoError(!rEstado.ok);
      if (rEstado.ok) { setEstado(rEstado.estado); setSinResponsable(rEstado.sinResponsable === true); } // en error se conserva el último estado conocido; estadoError ya bloquea la edición
      else showToast("Error comprobando el estado del cuadrante: " + rEstado.error, "err");
      setPendientes({});
      setViolaciones(null);
      setEquidadPorConfirmar(null);
      setCierresError(null);
      app.setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes, retryTick]);

  const prevMonth = () => {
    if (mes === 1) { setMes(12); setAnio(anio - 1); } else setMes(mes - 1);
  };
  const nextMonth = () => {
    if (mes === 12) { setMes(1); setAnio(anio + 1); } else setMes(mes + 1);
  };

  const dias = datesOfMonth(anio, mes);
  const monthWindow = { start: dias[0], end: dias[dias.length - 1] };

  const { porNivel, noAsignables } = filasDelMes(residentes, dias, asignaciones);

  const asignacionesDe = (residenteId) => {
    const porFecha = asignaciones[residenteId] || {};
    return Object.entries(porFecha).map(([fecha, codigo]) => ({ fecha, codigo }));
  };

  // Escribir una celda invalida siempre el resultado de validación que se esté enseñando: es de
  // antes del cambio, y dejarlo puesto haría creer que el mes sigue validado contra lo que hay.
  // `origen` por defecto "" (no cedida/comprada): cambiar el CÓDIGO de una celda es una guardia
  // nueva, y una guardia nueva no hereda la marca de la que hubiera antes.
  const aplica = (residenteId, fecha, codigo, origen = "") => {
    setAsignaciones((prev) => ({ ...prev, [residenteId]: { ...(prev[residenteId] || {}), [fecha]: codigo } }));
    setOrigenes((prev) => ({ ...prev, [residenteId]: { ...(prev[residenteId] || {}), [fecha]: origen } }));
    setPendientes((prev) => ({ ...prev, [`${residenteId}|${fecha}`]: { fecha, residenteId, codigo, origen } }));
    setViolaciones(null);
    setEquidadPorConfirmar(null);
    setCierresError(null);
    setTercerPuestoError(null);
  };

  const cicla = (residenteId, fecha) => {
    // Una pulsación larga que llegó a abrir el selector de origen ya hizo su trabajo: el click
    // que el navegador dispara al soltar no debe ciclar el código además.
    if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
    // Bloqueado mientras validando: validar() encadena dos peticiones de red y resuelve
    // contra el `asignaciones` capturado por closure al empezar — una edición a mitad de
    // esa ventana quedaría silenciosamente ignorada por el resultado que llegue después. Por
    // el mismo motivo, bloqueado mientras guardando: si se edita a mitad de un guardado en
    // vuelo, el `setPendientes({})` al terminar ese guardado borraría la edición nueva sin
    // haberla enviado nunca (pérdida de datos invisible — la celda seguiría mostrando el
    // valor nuevo, pero el servidor nunca lo recibió).
    // Bloqueado también si el mes está PUBLICADO (decisión V-9b): el servidor ya lo rechaza
    // en guardarAsignaciones, esto solo evita que la celda parezca editable en la UI.
    if (busy || bloqueadoPorPublicado) return;
    const actual = (asignaciones[residenteId] || {})[fecha] || "";
    aplica(residenteId, fecha, CODES_CYCLE[(CODES_CYCLE.indexOf(actual) + 1) % CODES_CYCLE.length]);
  };

  // Celda de la fila de un no asignable (V-23): SOLO borra, nunca asigna. Es el único gesto con
  // sentido sobre quien ese mes no puede hacer guardias, y es lo que vuelve accionable el aviso
  // de INV-1 (V-21) — que nombra al residente pero no puede quitar la celda por ti.
  const quita = (residenteId, fecha, codigo) => {
    if (busy || bloqueadoPorPublicado || !codigo) return;
    aplica(residenteId, fecha, "");
  };

  // Origen CEDIDA/COMPRADA (INV-4): mantener presionado ~500ms sobre una celda con guardia abre
  // un selector inline; soltar antes lo cancela. No usa doble-click a propósito — hubiera exigido
  // retrasar CADA click simple de la grilla para poder distinguirlo de la primera mitad de un
  // doble-click, y esta es la interacción más repetida de toda la app.
  const iniciaPress = (residenteId, fecha, codigo) => {
    if (busy || bloqueadoPorPublicado || !ORIGEN_ELEGIBLE.has(codigo)) return;
    clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setOrigenEditando(`${residenteId}|${fecha}`);
    }, PRESS_MS);
  };
  const terminaPress = () => clearTimeout(pressTimerRef.current);

  // `fecha === null` es solo "cerrar sin cambiar" (blur del <select> al perder foco sin elegir).
  const seleccionaOrigen = (fecha, origen) => {
    if (fecha === null) { setOrigenEditando(null); return; }
    const [residenteId] = origenEditando.split("|");
    const codigoActual = (asignaciones[residenteId] || {})[fecha] || "";
    aplica(residenteId, fecha, codigoActual, origen);
    setOrigenEditando(null);
  };

  const cambios = Object.values(pendientes);

  const guardar = async () => {
    if (cambios.length === 0) { showToast("No hay cambios que guardar"); return; }
    setGuardando(true);
    const r = await app.api.guardarAsignaciones(cambios);
    setGuardando(false);
    if (r.ok) {
      setPendientes({});
      // Editar un mes VALIDADO lo revierte a BORRADOR en el servidor (Fase 6.2) — se refleja
      // aquí sin otra petición, con la misma regla de dominio que aplicó el servidor.
      setEstado(stateAfterEdit(estado));
      showToast("Cuadrante guardado ✓");
    } else {
      showToast("Error guardando: " + r.error, "err");
    }
  };

  const validar = async (forzar = false) => {
    setValidando(true);
    setEquidadPorConfirmar(null);
    setCierresError(null);
    // INV-5/6/7 dependen de los bloqueos de TODO el equipo (vacaciones/rotación/baja), no
    // solo de quien pulsa Validar — listBloqueos (a diferencia de misBloqueos) los trae
    // todos. Desde la decisión V-8, solo BAJA bloquea la asignación (INV-5); VACACIONES y
    // ROTACION siguen alimentando INV-6/7 sin bloquear.
    const rBloqueos = await app.api.listBloqueos(anio, mes);
    if (!rBloqueos.ok) { setValidando(false); setViolaciones(null); showToast("Error cargando bloqueos para validar: " + rBloqueos.error, "err"); return; }
    const bloqueos = rBloqueos.bloqueos;

    // Contrato C-2 (spec.md §5): INV-7 evalúa la rotación cercana solo en el mes en que
    // TERMINA, pero necesita las guardias del residente de TODO el periodo — que puede
    // empezar en un mes anterior al validado. listAsignaciones (arriba, en el useEffect)
    // solo trae el mes en curso, así que faltaba el histórico si la rotación cruzaba mes.
    const monthStart = monthWindow.start;
    const desdeRotacion = rotationHistoryStart(bloqueos, monthStart);
    let historicas = [];
    if (desdeRotacion) {
      const rHist = await app.api.listAsignacionesRango(desdeRotacion, addDays(monthStart, -1));
      if (!rHist.ok) { setValidando(false); setViolaciones(null); showToast("Error cargando histórico de rotación: " + rHist.error, "err"); return; }
      historicas = rHist.asignaciones;
    }

    // Festivos para INV-12 (y para los puentes): con un día de margen a cada lado, porque los
    // vecinos del día 1 y del último día del mes deciden si son puente y caen fuera del mes.
    // Un fallo de red NO se degrada a "no hay festivos" en silencio: se dice, y se sigue —
    // INV-12 es aviso, así que no poder comprobarlo no puede impedir validar (V-14).
    const rFestivos = await app.api.listFestivosRango(addDays(monthWindow.start, -1), addDays(monthWindow.end, 1));
    if (!rFestivos.ok) showToast("No se pudieron cargar los festivos: " + rFestivos.error + " — INV-12 no se ha comprobado", "err");
    const festivos = rFestivos.ok ? rFestivos.festivos : [];

    // Excepciones (INV-9, V-29): sin ellas, un 2×R2 con justificación documentada avisaría aquí
    // igual que uno sin justificar — el servidor sí las ve en marcarValidado, así que el aviso
    // desaparecería al validar de verdad. Es aviso, nunca bloquea (V-14), así que un fallo de red
    // no impide seguir: solo deja este chequeo local sin la excepción.
    const rExcepciones = await app.api.listExcepciones();
    const excepciones = rExcepciones.ok ? rExcepciones.excepciones : [];

    const asignacionesDelMes = residentes.flatMap((r) => asignacionesDe(r.id).map((a) => ({ residenteId: r.id, fecha: a.fecha, codigo: a.codigo })));
    const ctx = buildMonthContext({ mes, anio, residentes, historicas, asignacionesDelMes, bloqueos, festivos, excepciones });

    // Cierres de equidad de INV-3 (P-8, decisión V-13): el trimestral en ago/nov/feb/may y el
    // anual en el mes del aniversario de alguien. Es la MISMA comprobación que hará el
    // servidor en marcarValidado; si falla la carga no se sigue, porque un cierre no
    // comprobado en silencio es peor que dar por bueno lo que no se ha mirado (V-14: ninguno de
    // los dos cierres bloquea, pero la confirmación explícita sí depende de haberlos calculado).
    // El tercer puesto (INV-8) va en paralelo: es otra comprobación con su propio rango, y
    // desde V-18 ninguna de sus cuatro reglas bloquea — pero las cuatro son avisos de equidad,
    // así que cuentan para la confirmación explícita igual que los cierres.
    const [rCierres, r3P] = await Promise.all([
      closeViolations({ api: app.api, mes, anio, residentes, asignacionesDelMes }),
      thirdPostViolations({ api: app.api, mes, anio, residentes, asignacionesDelMes }),
    ]);
    if (!rCierres.ok) {
      setCierresError(rCierres.error);
      showToast("No se pudieron comprobar los cierres de equidad: " + rCierres.error, "err");
    }
    if (!r3P.ok) {
      setTercerPuestoError(r3P.error);
      showToast("No se pudo comprobar el tercer puesto (INV-8): " + r3P.error, "err");
    }

    const v = [...validateMonth(ctx), ...(rCierres.ok ? rCierres.violaciones : []), ...(r3P.ok ? r3P.violaciones : [])];
    setViolaciones(v);

    // Decisión de Fase 6.2 (V-9/V-10): BORRADOR->VALIDADO es automático en cuanto el
    // Responsable en mandato valida sin errores — sin botón aparte. El servidor revalida
    // por su cuenta (nunca confía en `v`) y es quien de verdad decide si persiste el estado.
    // `cambios.length === 0` es imprescindible: si hay ediciones sin guardar, lo que ve el
    // cliente (con la edición) puede diferir de lo que el servidor validaría (sin ella) —
    // publicar en ese hueco fijaría datos que nunca reflejaron lo que la pantalla mostraba.
    // Decisión V-14: un desequilibrio de equidad no impide validar, pero se pregunta. La
    // primera pasada solo muestra los avisos y ofrece "Validar de todas formas"; la segunda
    // (forzar=true) es la que valida de verdad. El servidor no necesita saber nada de esto:
    // los avisos nunca le han bloqueado nada, la confirmación es de quien firma el cuadrante.
    const avisosEquidad = equityWarnings(v);
    // `!r3P.ok` cuenta igual que `!rCierres.ok`: lo que no se ha podido comprobar tampoco se da
    // por bueno en silencio, y quien firma el cuadrante tiene que enterarse de que INV-8 quedó
    // sin mirar antes de que el mes pase a VALIDADO.
    if (canValidate(v) && puedeMoverCiclo && estado !== "PUBLICADO" && cambios.length === 0 && (avisosEquidad.length > 0 || !rCierres.ok || !r3P.ok) && !forzar) {
      if (avisosEquidad.length > 0) setEquidadPorConfirmar(avisosEquidad.length);
      setValidando(false);
      return;
    }

    if (canValidate(v) && puedeMoverCiclo && estado !== "PUBLICADO" && cambios.length === 0) {
      const rVal = await app.api.marcarValidado(anio, mes);
      if (rVal.ok) { setEstado(rVal.estado); showToast("Cuadrante VALIDADO ✓"); }
      // Si el servidor lo rechaza (discrepancia con lo que ve el cliente) no se pisa la vista
      // de violaciones, que ya se mostró arriba con el resultado local — pero SÍ se dice: sin
      // el aviso, el cuadrante se quedaba en BORRADOR sin que nadie supiera por qué.
      else showToast("El servidor no validó el cuadrante: " + rVal.error, "err");
    }
    setValidando(false);
  };

  const publicar = async () => {
    setCambiandoEstado(true);
    const r = await app.api.publicarCuadrante(anio, mes);
    setCambiandoEstado(false);
    if (r.ok) { setEstado(r.estado); showToast("Cuadrante PUBLICADO ✓"); }
    else showToast("Error publicando: " + r.error, "err");
  };

  const despublicar = async () => {
    setCambiandoEstado(true);
    const r = await app.api.despublicarCuadrante(anio, mes);
    setCambiandoEstado(false);
    if (r.ok) { setEstado(r.estado); showToast("Cuadrante despublicado — vuelve a VALIDADO"); }
    else showToast("Error despublicando: " + r.error, "err");
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button style={S.navBtn} onClick={prevMonth} disabled={busy}>◀</button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>{nombreMesDe(anio, mes)}</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: ESTADO_CUADRANTE[estado].color, background: ESTADO_CUADRANTE[estado].bg, borderRadius: 8, padding: "2px 10px" }}>
              {ESTADO_CUADRANTE[estado].label}
            </span>
          </div>
          <button style={S.navBtn} onClick={nextMonth} disabled={busy}>▶</button>
        </div>
      </Card>

      {estadoError && (
        <Aviso color={COLOR.red} bg={COLOR.redLight}>
          No se pudo comprobar el estado del cuadrante — no se puede editar hasta reintentar
          (podría estar PUBLICADO sin que esta pantalla lo sepa todavía).
          <div style={{ marginTop: 8 }}>
            <Btn onClick={() => setRetryTick((t) => t + 1)}>🔄 Reintentar</Btn>
          </div>
        </Aviso>
      )}

      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button style={pillBtn(COLOR.blue)} onClick={guardar} disabled={busy || bloqueadoPorPublicado}>
            {guardando ? "Guardando…" : `💾 Guardar${cambios.length ? ` (${cambios.length})` : ""}`}
          </button>
          <button style={pillBtn(COLOR.greenMid)} onClick={() => validar()} disabled={busy}>{validando ? "Validando…" : "✅ Validar"}</button>
          {puedeMoverCiclo && canPublish(estado) && (
            <button style={pillBtn(COLOR.blueDark)} onClick={publicar} disabled={busy}>
              {cambiandoEstado ? "Publicando…" : "📢 Publicar"}
            </button>
          )}
          {puedeMoverCiclo && canUnpublish(estado) && (
            <button style={pillBtn(COLOR.orange)} onClick={despublicar} disabled={busy}>
              {cambiandoEstado ? "Despublicando…" : "↩️ Despublicar"}
            </button>
          )}
        </div>
        {sinResponsable && soyMayor && (
          <div style={{ fontSize: 12, color: COLOR.orange, background: COLOR.orangeLight, borderRadius: 6, padding: "6px 10px", marginBottom: 10 }}>
            ⚖️ No hay Responsable del contaje designado para este periodo. Hasta que se decida, cualquier R3 o R4 puede validar y publicar — decídelo en ⚙️ → Responsable.
          </div>
        )}
        {!estadoError && bloqueadoPorPublicado && (
          <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
            Este cuadrante está publicado: no se puede editar{puedeMoverCiclo ? " — usa Despublicar para corregirlo." : "."}
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", minWidth: 220 + dias.length * 32, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>Nivel</th>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>Nombre</th>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>G</th>
                {dias.map((fecha) => {
                  const wknd = isWeekend(fecha);
                  return (
                    <th key={fecha} style={{ ...S.th, background: wknd ? COLOR.greenLight : COLOR.gray, color: wknd ? COLOR.green : COLOR.cellText }}>
                      <div>{Number(fecha.slice(8, 10))}</div>
                      <div style={{ fontSize: 10, fontWeight: 400 }}>{weekday(fecha)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ANOS.map((nivel) => porNivel[nivel].map((r) => (
                <FilaRejilla
                  key={r.id}
                  nombre={r.nombre} etiqueta={nivel} bg={ANO_COLORS[nivel]} color={ANO_TEXT[nivel]}
                  total={tally(asignacionesDe(r.id), monthWindow).total}
                  dias={dias} porFecha={asignaciones[r.id] || {}}
                  pulsable={() => !bloqueadoPorPublicado}
                  onCelda={(fecha) => cicla(r.id, fecha)}
                  origenPorFecha={origenes[r.id] || {}}
                  origenEditFecha={origenEditando && origenEditando.startsWith(`${r.id}|`) ? origenEditando.slice(r.id.length + 1) : null}
                  onPressStart={(fecha, codigo) => iniciaPress(r.id, fecha, codigo)}
                  onPressEnd={terminaPress}
                  onSeleccionaOrigen={seleccionaOrigen}
                />
              )))}
              {/* Decisión V-23: al final, después de R1, porque no es un nivel más — es trabajo
                  pendiente de limpiar. */}
              {noAsignables.map(({ residente: r, motivo }) => (
                <FilaRejilla
                  key={r.id}
                  nombre={r.nombre} etiqueta={motivo.etiqueta} bg={COLOR.orange} color="#fff"
                  titulo={`${r.nombre}: ${motivo.texto}. No es asignable en este mes; sus celdas solo se pueden borrar.`}
                  total={tally(asignacionesDe(r.id), monthWindow).total}
                  dias={dias} porFecha={asignaciones[r.id] || {}}
                  pulsable={(codigo) => !bloqueadoPorPublicado && codigo !== ""}
                  onCelda={(fecha, codigo) => quita(r.id, fecha, codigo)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {noAsignables.length > 0 && (
          <div style={{ fontSize: 12, color: COLOR.orange, background: COLOR.orangeLight, borderRadius: 6, padding: "6px 10px", marginTop: 10 }}>
            ⚠️ {noAsignables.map(({ residente: r, motivo }) => `${r.nombre.split(" ")[0]} (${motivo.texto})`).join("; ")}.
            {" "}No {noAsignables.length === 1 ? "puede hacer" : "pueden hacer"} guardias ningún día de este mes, pero
            {" "}{noAsignables.length === 1 ? "tiene" : "tienen"} algo escrito en la rejilla: {noAsignables.length === 1 ? "esa fila" : "esas filas"} solo
            {" "}<strong>borra</strong>, no asigna. Al vaciarla{noAsignables.length === 1 ? "" : "s"} desaparece{noAsignables.length === 1 ? "" : "n"}.
          </div>
        )}
      </Card>

      {violaciones !== null && (
        <Card title="Resultado de validación">
          {/* Decisión V-14: la equidad nunca bloquea, pero validar incumpliéndola se confirma
              a la vista de los avisos (que están justo debajo), no antes de poder leerlos. */}
          {(equidadPorConfirmar !== null || cierresError || tercerPuestoError) && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: COLOR.orangeLight, border: `1.5px solid ${COLOR.orange}` }}>
              {/* El cartel nombra lo que de verdad falló: atribuir a los cierres de equidad un
                  fallo del tercer puesto manda a buscar el problema al sitio equivocado. */}
              <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.orange, marginBottom: 6 }}>
                {cierresError || tercerPuestoError
                  ? `⚖️ No se ha podido comprobar ${[cierresError && "la equidad del cierre", tercerPuestoError && "el tercer puesto (INV-8)"].filter(Boolean).join(" ni ")}`
                  : `⚖️ El cuadrante incumple los criterios de equidad (${equidadPorConfirmar} ${equidadPorConfirmar === 1 ? "aviso" : "avisos"})`}
              </div>
              <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 8 }}>
                {cierresError || tercerPuestoError
                  ? `No se pudo cargar el histórico que hace falta (${cierresError || tercerPuestoError}). El resto del cuadrante sí se ha validado; eso queda sin comprobar.`
                  : "No impide validar: la normativa prevé compensar la diferencia en los meses siguientes. Revisa los avisos de abajo y decide."}
              </div>
              {/* Solo mientras quede algo que confirmar: si el mes ya está VALIDADO, el aviso
                  sigue siendo cierto (y visible) pero el botón ya no tiene nada que hacer. */}
              {estado === "BORRADOR" && (
                <button style={pillBtn(COLOR.greenMid)} onClick={() => validar(true)} disabled={busy}>
                  {validando ? "Validando…" : "✅ Validar de todas formas"}
                </button>
              )}
            </div>
          )}
          {violaciones.length === 0 ? (
            <div style={{ color: COLOR.green, fontWeight: 700, fontSize: 14 }}>✅ Sin violaciones</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {errores.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.red, marginBottom: 6 }}>⛔ Errores ({errores.length}) — bloquean la publicación</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {errores.map((v, i) => (
                      <div key={i} style={{ fontSize: 12, color: COLOR.red, background: COLOR.redLight, borderRadius: 6, padding: "4px 8px" }}>
                        [{v.invariante}] {violationText(v, residentes)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {avisos.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, marginBottom: 6 }}>⚠️ Avisos ({avisos.length}) — informativos</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {avisos.map((v, i) => (
                      <div key={i} style={{ fontSize: 12, color: COLOR.orange, background: COLOR.orangeLight, borderRadius: 6, padding: "4px 8px" }}>
                        [{v.invariante}] {violationText(v, residentes)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="Leyenda">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {Object.keys(CODE_LABELS).map((code) => (
            <div key={code} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: CODE_COLORS[code], border: `1px solid ${COLOR.grayMid}`, display: "inline-block" }} />
              <span style={{ fontSize: 12, color: COLOR.grayDark }}>{code} · {CODE_LABELS[code]}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Calendar = CalendarScreen;

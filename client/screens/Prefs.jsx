// PrefsScreen — preferencias del residente para el mes en curso (app.mes/app.anio,
// COMPARTIDO con CalendarScreen). Fase 4: sustituye día-de-semana genérico por fechas
// concretas del mes. Fase 5.x / decisión V-8: dentro de Bloqueo, solo BAJA sigue bloqueando
// la asignación (INV-5) — vacaciones y rotación pasaron a ser informativas para el
// generador, igual que fechasEvitar, aunque sus fechas SIGUEN alimentando INV-2/6/7 y la
// equidad. Se quitó la sección de "fechas preferidas" (BLANDO positivo) a petición del
// autor. Acentos de color: rojo=BAJA (sigue bloqueando), naranja=vacaciones/rotación/evitar
// (informativo, no bloquea).
import { COLOR, S } from "./client/lib/design-tokens.js";
import { datesOfMonth, weekday, compareISO, toISO, addMonths } from "./v2/domain/calendar.js";
import { rangoValido } from "./client/lib/fechas.js";
import { puedeMoverCiclo, esAccesoDesarrollador } from "./client/lib/permisos.js";
import { violationText } from "./client/lib/violations.js";
import {
  prefsPorDefecto, prefsParaGuardar, cargaEmpezada, cargaTerminada, faseDe, sePuedeEditar,
  guardadoConfirmado, hayCambiosSinGuardar,
} from "./client/lib/preferencias.js";
import { avisarAlSalir } from "./client/lib/aviso-salida.js";

const { useState, useEffect, useRef } = React;
const { Card, SectionTitle, Btn, Aviso } = window.UI;
const MOTIVO_LABEL = { VACACIONES: "Vacaciones", ROTACION: "Rotación externa", CONGRESO: "Congreso", BAJA: "Baja" };
// Etiquetas de los riesgos de P-13 (spec.md §8/§8.1, blockPreview.js) — el `tipo` que devuelve
// el dominio es un identificador estable, no texto pensado para pantalla.
const RIESGO_LABEL = {
  IMPOSIBILIDAD: "Riesgo de cobertura", SOBRECARGA: "Riesgo de sobrecarga",
  CONCENTRACION_NIVEL: "Varios del mismo año ausentes", DIVISION_NAVIDAD_ANIO_NUEVO: "Navidad y Año Nuevo a la vez",
};

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fechaEs(iso) {
  const d = new Date(iso + "T00:00:00Z");
  // Una fecha ilegible se enseña tal cual (con el texto que hay en la hoja), nunca «Invalid Date».
  if (Number.isNaN(d.getTime())) return `«${iso}»`;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });
}

function Counter({ value, onChange, min, max, accent = COLOR.blue, bg = COLOR.bluePale, disabled = false }) {
  const btnStyle = { ...S.counterBtn, borderColor: accent, color: accent, background: bg };
  const sinBajar = disabled || value <= min;
  const sinSubir = disabled || value >= max;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: disabled ? 0.5 : 1 }}>
      <button style={{ ...btnStyle, opacity: sinBajar ? 0.4 : 1 }} disabled={sinBajar}
        onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.blueDark, minWidth: 26, textAlign: "center" }}>{disabled ? "…" : value}</div>
      <button style={{ ...btnStyle, opacity: sinSubir ? 0.4 : 1 }} disabled={sinSubir}
        onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}

/** Rejilla de fechas del mes para marcar BLANDO (preferido/evitar) — sustituye a los toggles de día-de-semana del v1. */
function DateGrid({ anio, mes, selected, onToggle, color, bloqueadas, disabled = false }) {
  const dias = datesOfMonth(anio, mes);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, opacity: disabled ? 0.5 : 1 }}>
      {dias.map((fecha) => {
        const active = selected.includes(fecha);
        const bloqueada = bloqueadas.has(fecha);
        return (
          <button key={fecha} disabled={bloqueada || disabled} title={bloqueada ? "Ya tienes un bloqueo ese día" : fecha}
            onClick={() => onToggle(fecha)} style={{
              ...S.dayToggleBtn, padding: "6px 2px", display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
              background: bloqueada ? COLOR.grayMid : active ? color : "#fff",
              color: bloqueada ? COLOR.grayDark : active ? "#fff" : COLOR.grayDark,
              border: active || bloqueada ? "none" : `1.5px solid ${COLOR.grayMid}`,
              opacity: bloqueada ? 0.6 : 1, cursor: bloqueada || disabled ? "default" : "pointer",
            }}>
            <span style={{ fontWeight: 700 }}>{Number(fecha.slice(8, 10))}</span>
            <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.8 }}>{weekday(fecha)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Formulario de alta de un Bloqueo (vacaciones/rotación/baja) — spec.md V-6/V-8, INV-2/5/6/7. */
function NuevoBloqueo({ anio, mes, onCreated, showToast, api, paraOtros, residentes, miId }) {
  const primerDia = datesOfMonth(anio, mes)[0];
  const [motivo, setMotivo] = useState("VACACIONES");
  const [desde, setDesde] = useState(primerDia);
  const [hasta, setHasta] = useState(primerDia);
  const [provincia, setProvincia] = useState("");
  const [residenteId, setResidenteId] = useState("");
  const [saving, setSaving] = useState(false);

  // `rangoValido` y no `compareISO` a pelo: mientras se teclea el año, el input emite "0002-09-04" y
  // `parseISO` lanzaría EN EL RENDER, desmontando la app entera (ver client/lib/fechas.js).
  const valido = rangoValido(desde, hasta);
  const ajena = paraOtros && residenteId && residenteId !== miId;

  const crear = async () => {
    if (!valido) { showToast("El rango de fechas no es válido", "err"); return; }
    setSaving(true);
    const extra = motivo === "ROTACION" && provincia ? { provincia } : {};
    if (ajena) extra.residenteId = residenteId;
    const r = await api.crearBloqueo(desde, hasta, motivo, extra);
    setSaving(false);
    if (r.ok) { showToast(ajena ? "Ausencia registrada ✓" : "Bloqueo añadido ✓"); onCreated(r.riesgos, r.marcasSinEscribir); }
    else showToast("Error añadiendo el bloqueo: " + r.error, "err");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
      {/* Registrar la ausencia de OTRO: es la única vía por la que una baja no declarada entra
          en la tabla que leen los invariantes. Pintar «B» en la rejilla no sirve — es un código
          de asignación, y INV-5 seguiría dejando asignarle guardias. Solo se ofrece a quien
          tiene el permiso del ciclo; el servidor lo vuelve a comprobar de todos modos. */}
      {paraOtros && (
        <div>
          <label style={S.label}>¿De quién es esta ausencia?</label>
          <select value={residenteId} onChange={(e) => setResidenteId(e.target.value)}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }}>
            <option value="">Mía</option>
            {residentes.filter((r) => r.id !== miId).map((r) => (
              <option key={r.id} value={r.id}>{r.nombre}</option>
            ))}
          </select>
          {ajena && (
            <div style={{ fontSize: 12, color: COLOR.orange, marginTop: 6, lineHeight: 1.4 }}>
              La estás registrando por otra persona. Quedará como suya y, si es una baja, impedirá
              que se le asignen guardias esos días.
            </div>
          )}
        </div>
      )}
      <div>
        <label style={S.label}>Motivo</label>
        <select value={motivo} onChange={(e) => setMotivo(e.target.value)}
          style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }}>
          {Object.entries(MOTIVO_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={S.label}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={S.label}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
        </div>
      </div>
      {motivo === "ROTACION" && (
        <div>
          <label style={S.label}>Provincia del centro (si es Alicante o colindante, aplica INV-7)</label>
          <input value={provincia} onChange={(e) => setProvincia(e.target.value)} placeholder="p. ej. Alicante, Valencia…"
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
        </div>
      )}
      <Btn onClick={crear} disabled={saving || !valido} color={COLOR.blueDark}>
        {saving ? "Añadiendo…" : "Añadir"}
      </Btn>
    </div>
  );
}

function PrefsScreen() {
  const app = window.useApp();
  const { myResidente, anio, mes, setTab, showToast, api } = app;

  const [prefs, setPrefs] = useState(prefsPorDefecto);
  const [bloqueos, setBloqueos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showNuevoBloqueo, setShowNuevoBloqueo] = useState(false);
  // Mismo criterio que Calendar.jsx, y de la misma fuente: `sinResponsable` lo dice el servidor
  // en estadoCuadrante (releído del store), nunca el `rol` del token, que se firmó en el login.
  const [sinResponsable, setSinResponsable] = useState(false);
  const [ajenas, setAjenas] = useState([]);
  // Avisos de P-13 (spec.md §8/§8.1) del último Bloqueo registrado: `crearBloqueo` los calcula
  // siempre que no bloquean (si bloquearan, la llamada habría fallado con ok:false y nunca
  // habríamos llegado a onCreated), pero antes nadie los mostraba — se calculaban y se tiraban.
  const [riesgosUltimoBloqueo, setRiesgosUltimoBloqueo] = useState([]);
  // Días que `crearBloqueo` NO pudo marcar solo en la rejilla (V-50): ya tenían un código puesto
  // o el mes está publicado. Se avisa para que quien registró la ausencia sepa que esos días hay
  // que revisarlos a mano — la marca automática nunca pisa una asignación real ni un mes cerrado.
  const [diasSinMarcar, setDiasSinMarcar] = useState([]);
  // `cancelando` deshabilita los botones de «Cancelar» mientras la petición está en vuelo: un doble
  // toque (fácil en el móvil con la latencia de Apps Script) mandaba `cancelarBloqueo` dos veces y,
  // con las dos recargas que dispara cada respuesta, seis idas y vueltas donde bastan tres.
  // Declarado AQUÍ, con los demás hooks y ANTES del `return` temprano de «Cargando tu residente…»:
  // declararlo después (2026-09-04, un día en producción) hacía que el render que llegaba con la
  // lista de residentes tuviera un hook más que el anterior — error #310 de React y la app en
  // blanco para quien recargaba y entraba en Preferencias antes de que respondiera Apps Script.
  const [cancelando, setCancelando] = useState(null);
  // Qué hay guardado del mes en pantalla y si ya ha llegado (client/lib/preferencias.js). Hasta que
  // llega, lo que se ve son los valores por defecto: no se puede escribir (la respuesta lo
  // sustituiría) ni guardar (pisaría lo guardado). Si `misPreferencias` falla, Guardar se cambia por
  // Reintentar, que vuelve a pedirlo (`recarga`). También antes del `return` temprano (error #310).
  const [carga, setCarga] = useState(() => cargaEmpezada(anio, mes));
  const [recarga, setRecarga] = useState(0);
  const fase = faseDe(carga, anio, mes);
  const editable = sePuedeEditar(carga, anio, mes);
  const sinGuardar = hayCambiosSinGuardar(carga, anio, mes, prefs);
  const nombreMes = nombreMesDe(anio, mes).toLowerCase();
  // Lo no guardado se perdía sin avisar al salir de la pantalla. App.jsx pregunta antes de cambiar
  // de pestaña, ir atrás o cerrar sesión si este ref dice el mes (contrato con App: null = nada que
  // perder); recargar o cerrar la pestaña no pasa por App, y eso lo pregunta el navegador.
  useEffect(() => {
    const ref = app.prefsSinGuardarRef;
    if (!ref) return undefined;
    ref.current = sinGuardar ? nombreMes : null;
    return () => { ref.current = null; };
  }, [sinGuardar, nombreMes]);
  useEffect(() => avisarAlSalir(window, sinGuardar), [sinGuardar]);
  const puedoRegistrarAjenas = puedeMoverCiclo({ isResponsable: app.isResponsable, grupo: app.grupo, sinResponsable, accesoDesarrollador: esAccesoDesarrollador(myResidente?.email) });

  // El mes que está en pantalla, para tirar las respuestas de un mes anterior que lleguen tarde:
  // con dos flechas seguidas, los bloqueos de agosto podían pintarse sobre septiembre.
  const mesEnPantallaRef = useRef(`${anio}-${mes}`);
  mesEnPantallaRef.current = `${anio}-${mes}`;
  const cargarBloqueos = async () => {
    const pedido = `${anio}-${mes}`;
    const r = await api.misBloqueos(anio, mes);
    if (r.ok && mesEnPantallaRef.current === pedido) setBloqueos(r.bloqueos);
  };
  // Las ajenas solo las ve quien puede registrarlas: si no, esta pantalla pasaría de ser "mis
  // preferencias" a un tablón de las ausencias de todo el equipo. Y sin esta lista, quien
  // registra la baja de otro no vería nunca el resultado ni podría corregir una equivocación.
  const cargarAjenas = async () => {
    if (!puedoRegistrarAjenas) { setAjenas([]); return; }
    const pedido = `${anio}-${mes}`;
    const r = await api.listBloqueos(anio, mes);
    if (r.ok && mesEnPantallaRef.current === pedido) setAjenas(r.bloqueos.filter((b) => b.residenteId !== myResidente?.id));
  };

  useEffect(() => {
    if (!myResidente) return;
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      // Al cambiar de mes se parte de cero ANTES de que responda el servidor: si no, un Guardar
      // rápido mandaba las `fechasEvitar` del mes anterior con el mes nuevo. Las ausencias también:
      // si no, las del mes anterior se seguían viendo (y contando para el mínimo) bajo la cabecera
      // del nuevo hasta que respondía el servidor.
      setCarga(cargaEmpezada(anio, mes));
      setPrefs(prefsPorDefecto());
      setBloqueos([]);
      const [rPrefs, , rEstado] = await Promise.all([api.misPreferencias(anio, mes), cargarBloqueos(), api.estadoCuadrante(anio, mes)]);
      if (cancelled) return;
      // Un fallo aquí solo esconde el selector de ausencia ajena: no se asume el permiso.
      setSinResponsable(rEstado.ok ? rEstado.sinResponsable === true : false);
      const terminada = cargaTerminada(anio, mes, rPrefs);
      setCarga(terminada);
      if (terminada.fase === "lista") setPrefs(terminada.guardadas);
      else showToast("Error cargando preferencias: " + terminada.error, "err");
      app.setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes, myResidente?.id, recarga]);

  // Aparte del efecto de carga: el permiso se conoce DESPUÉS de que responda estadoCuadrante. Las
  // del mes anterior se vacían AQUÍ y no en el efecto de carga: si las vaciara aquel sin que este se
  // repitiera (quien entra antes de que llegue su residente), la lista se quedaba vacía. Y depende
  // de `myResidente?.id` porque sin él el filtro de «ajenas» no sabe cuáles son las propias.
  useEffect(() => { setAjenas([]); cargarAjenas(); }, [anio, mes, puedoRegistrarAjenas, myResidente?.id]);

  if (!myResidente) {
    return (
      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
        <Aviso>Cargando tu residente… si esto no desaparece, recarga la página.</Aviso>
      </div>
    );
  }

  // Navegar de mes sin salir de la pantalla (a pedido del autor, 2026-09-03): antes solo se
  // podía cambiar de mes desde el cuadrante, así que cargar preferencias del mes en curso y de
  // los siguientes obligaba a ir y volver de pantalla en cada uno. `anio`/`mes` son estado
  // global de la app (compartido con Calendar.jsx) — cambiarlos aquí también mueve el cuadrante.
  // Con cambios sin guardar se pregunta antes, y no se cambia mientras se guarda: la respuesta de
  // ese guardado es del mes que se deja.
  const cambiarMes = (delta) => {
    if (saving) return;
    if (sinGuardar && !window.confirm(`Tienes cambios sin guardar en tus preferencias de ${nombreMes}. ¿Cambiar de mes y perderlos?`)) return;
    const iso = addMonths(toISO(anio, mes, 1), delta);
    app.setAnio(Number(iso.slice(0, 4)));
    app.setMes(Number(iso.slice(5, 7)));
  };

  // Los controles ya están deshabilitados mientras no se puede editar; esto es la segunda llave.
  const set = (field) => (value) => { if (editable) setPrefs((p) => ({ ...p, [field]: value })); };
  const toggleFecha = (field, fecha) => {
    if (!editable) return;
    setPrefs((p) => ({
      ...p,
      [field]: p[field].includes(fecha) ? p[field].filter((d) => d !== fecha) : [...p[field], fecha],
    }));
  };

  // El mínimo de 4 (normativa.pdf p.1) trae su propia excepción explícita — "salvo excepciones
  // (por ejemplo febrero o vacaciones)" — así que con cualquier bloqueo este mes (vacaciones,
  // rotación o baja) no tiene sentido forzar igual el piso de 4 guardias en la preferencia:
  // esta persona sabe mejor que nadie que va a estar menos disponible.
  const tieneAusenciaEsteMes = bloqueos.length > 0;

  // Fechas ya cubiertas por CUALQUIER bloqueo (vacaciones/rotación/baja): no tiene sentido
  // marcarlas también como "a evitar" — ya son una ausencia conocida y registrada.
  // Un bloqueo con la fecha ilegible (tecleada en la hoja; `misBloqueos` lo devuelve a propósito
  // para que se pueda cancelar, V-22) no entra aquí: `compareISO` lanzaría y la pantalla entera
  // se quedaría en blanco — justo la única desde la que se puede cancelar esa fila.
  const fechasBloqueadas = new Set();
  const fechaLegible = (iso) => { try { compareISO(iso, iso); return true; } catch { return false; } };
  for (const b of bloqueos) {
    if (!fechaLegible(b.desde) || !fechaLegible(b.hasta)) continue;
    for (const f of datesOfMonth(anio, mes)) {
      if (compareISO(b.desde, f) <= 0 && compareISO(f, b.hasta) <= 0) fechasBloqueadas.add(f);
    }
  }

  const guardar = async () => {
    if (!editable || saving) return;
    setSaving(true);
    setSaved(false);
    const enviadas = prefsParaGuardar(prefs, anio, mes);
    const r = await api.guardarPreferencias(anio, mes, enviadas);
    setSaving(false);
    if (r.ok) {
      setCarga((c) => guardadoConfirmado(c, anio, mes, enviadas));
      showToast("Preferencias guardadas ✓");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      showToast("Error guardando preferencias: " + r.error, "err");
    }
  };

  const cancelarBloqueo = async (id) => {
    if (cancelando !== null) return;
    setCancelando(id);
    const r = await api.cancelarBloqueo(id);
    setCancelando(null);
    if (r.ok) { showToast("Bloqueo cancelado"); cargarBloqueos(); cargarAjenas(); }
    else showToast("Error cancelando: " + r.error, "err");
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, margin: "0 auto" }}>
      <SectionTitle>⚙️ Preferencias del mes</SectionTitle>

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <button onClick={() => cambiarMes(-1)} disabled={saving} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue, opacity: saving ? 0.5 : 1 }}>◀</button>
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>
            {nombreMesDe(anio, mes)}
          </div>
          <button onClick={() => cambiarMes(1)} disabled={saving} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue, opacity: saving ? 0.5 : 1 }}>▶</button>
        </div>
        <div style={{ marginTop: 10, textAlign: "center" }}>
          <button onClick={() => setTab("calendar")} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>
            Ver cuadrante →
          </button>
        </div>
      </Card>
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: -8 }}>
        Todo lo de esta pantalla es <b>por mes</b>: usa las flechas de arriba para ir cargando tus
        preferencias del mes en curso y de los siguientes, una por una — recordá guardar antes de
        cambiar de mes.
      </div>
      {fase === "cargando" && (
        <Aviso color={COLOR.blueDark} bg={COLOR.bluePale}>Cargando tus preferencias de {nombreMes}…</Aviso>
      )}
      {fase === "error" && (
        <Aviso color={COLOR.red} bg={COLOR.redLight}>
          No se han podido cargar tus preferencias de {nombreMes} ({carga.error}). Hasta que carguen no
          se pueden cambiar: guardar ahora pisaría lo que ya tengas guardado.
          <div style={{ marginTop: 8 }}>
            <Btn onClick={() => setRecarga((n) => n + 1)} color={COLOR.red}>Reintentar</Btn>
          </div>
        </Aviso>
      )}

      {/* Decisión V-47: lo que ya está comprometido no es una preferencia, es una guardia, y va a
          la rejilla — desde aquí solo se señala el camino, para que nadie lo escriba en «Notas»
          esperando que el generador lo lea. */}
      <Card title="📌 Guardias que ya tengo acordadas" accent={COLOR.blueDark}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          Si ya tienes guardias comprometidas para este mes (cambios acordados, días fijados con
          el servicio), ponlas directamente en <b>tu fila del cuadrante</b> y guarda. El generador
          con IA las respeta tal cual y reparte solo el resto.
        </div>
        <Btn onClick={() => setTab("calendar")} color={COLOR.bluePale} textColor={COLOR.blueDark}>Ponerlas en el cuadrante →</Btn>
      </Card>

      <Card title="🎯 Guardias que quiero hacer este mes" accent={COLOR.turquoise}>
        <Counter value={prefs.maxGuardias} min={tieneAusenciaEsteMes ? 0 : 4} max={6} onChange={set("maxGuardias")} accent={COLOR.turquoise} bg={COLOR.turquoiseLight} disabled={!editable} />
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 8 }}>
          {tieneAusenciaEsteMes
            ? "(normativa: 4–6, salvo excepciones — con una ausencia registrada este mes podés pedir menos)"
            : "(4 son las obligatorias; pon 5 o 6 si quieres hacer alguna más y el generador te la dará donde falte gente)"}
        </div>
      </Card>

      <Card title="🗓️ Vacaciones, rotación, congresos y baja" accent={COLOR.orange}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          Vacaciones, rotación y congresos son informativos: el generador evita asignarte guardia esos
          días, pero puede hacerlo si no queda alternativa — el validador no lo bloquea. La
          baja médica o el embarazo son distintos: <b>nunca</b> se te asignará guardia esos
          días, lo hace cumplir el validador.
        </div>
        {fase === "cargando" ? (
          <div style={{ fontSize: 13, color: COLOR.grayDark, fontStyle: "italic", marginBottom: 10 }}>Cargando las fechas de este mes…</div>
        ) : bloqueos.length === 0 ? (
          <div style={{ fontSize: 13, color: COLOR.grayDark, fontStyle: "italic", marginBottom: 10 }}>Sin fechas registradas este mes.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {bloqueos.map((b) => {
              // NOTA: COLOR.redLight === COLOR.orangeLight (mismo hex en design-tokens.js) —
              // usar solo el fondo no distinguiría nada. La distinción real es el fondo NEUTRO
              // (naranja: solo borde) vs TEÑIDO (baja: fondo completo), no el matiz del color.
              const esBaja = b.motivo === "BAJA";
              const color = esBaja ? COLOR.red : COLOR.orange;
              return (
                <div key={b.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: esBaja ? COLOR.redLight : COLOR.gray,
                  borderLeft: `4px solid ${color}`, borderRadius: 8, padding: "8px 10px",
                }}>
                  <div style={{ fontSize: 13, color }}>
                    <b>{MOTIVO_LABEL[b.motivo] || b.motivo}</b> · {fechaEs(b.desde)} – {fechaEs(b.hasta)}
                    {b.provincia ? ` · ${b.provincia}` : ""}
                    {!esBaja && <span style={{ fontWeight: 600 }}> · no bloquea</span>}
                  </div>
                  <button onClick={() => cancelarBloqueo(b.id)} disabled={cancelando !== null} style={{ ...S.smallBtn, background: "#fff", color, opacity: cancelando !== null ? 0.6 : 1 }}>Cancelar</button>
                </div>
              );
            })}
          </div>
        )}
        {puedoRegistrarAjenas && ajenas.length > 0 && (
          <div style={{ marginTop: 4, marginBottom: 10, paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.grayDark, marginBottom: 6 }}>
              REGISTRADAS POR TI O POR EL RESPONSABLE
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ajenas.map((b) => {
                const quien = app.residentes.find((r) => r.id === b.residenteId);
                const esBaja = b.motivo === "BAJA";
                const color = esBaja ? COLOR.red : COLOR.orange;
                return (
                  <div key={b.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: esBaja ? COLOR.redLight : COLOR.gray,
                    borderLeft: `4px solid ${color}`, borderRadius: 8, padding: "8px 10px",
                  }}>
                    <div style={{ fontSize: 13, color }}>
                      <b>{quien ? quien.nombre : b.residenteId}</b> · {MOTIVO_LABEL[b.motivo] || b.motivo} ·{" "}
                      {fechaEs(b.desde)} – {fechaEs(b.hasta)}
                    </div>
                    <button onClick={() => cancelarBloqueo(b.id)} disabled={cancelando !== null} style={{ ...S.smallBtn, background: "#fff", color, opacity: cancelando !== null ? 0.6 : 1 }}>Cancelar</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {diasSinMarcar.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Aviso>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <span>
                  No se pudo poner la marca en la rejilla para {diasSinMarcar.length} día{diasSinMarcar.length === 1 ? "" : "s"} ({diasSinMarcar.map(fechaEs).join(", ")}):
                  ya tenían un código puesto o el mes está publicado. Revisalos a mano si hace falta.
                </span>
                <button onClick={() => setDiasSinMarcar([])}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}
                  aria-label="Cerrar aviso">×</button>
              </div>
            </Aviso>
          </div>
        )}
        {riesgosUltimoBloqueo.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Aviso>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <b>Simulación preventiva de cobertura:</b>
                <button onClick={() => setRiesgosUltimoBloqueo([])}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}
                  aria-label="Cerrar aviso">×</button>
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {riesgosUltimoBloqueo.map((r, i) => (
                  <li key={i} style={{ marginBottom: 4 }}><b>{RIESGO_LABEL[r.tipo] || r.tipo}:</b> {violationText(r, app.residentes)}</li>
                ))}
              </ul>
            </Aviso>
          </div>
        )}
        {showNuevoBloqueo ? (
          <NuevoBloqueo anio={anio} mes={mes} api={api} showToast={showToast}
            paraOtros={puedoRegistrarAjenas} residentes={app.residentes} miId={myResidente.id}
            onCreated={(riesgos, sinMarcar) => {
              setShowNuevoBloqueo(false); cargarBloqueos(); cargarAjenas();
              setRiesgosUltimoBloqueo(riesgos || []);
              setDiasSinMarcar(sinMarcar || []);
            }} />
        ) : (
          <Btn onClick={() => { setShowNuevoBloqueo(true); setRiesgosUltimoBloqueo([]); }} color={COLOR.orangeLight} textColor={COLOR.orange}>+ Añadir</Btn>
        )}
      </Card>

      <Card title="🩺 Tercer puesto este mes" accent={COLOR.purple}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          El tercer puesto es un <b>apoyo de tarde</b>: vas y te marchas a las 20 h, no haces la guardia
          de 24 h, y <b>no cuenta como guardia</b>. Es siempre voluntario y se pregunta cada mes.
          Se reparte entre quienes dicen que sí, lo más parejo posible, y no se repite el mismo día de
          la semana hasta haber hecho los siete.
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.blueDark, marginBottom: 8 }}>¿Deseas hacer tercer puesto este mes?</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={() => set("tercerPuesto")(true)} disabled={!editable} color={prefs.tercerPuesto ? COLOR.purple : COLOR.gray} textColor={prefs.tercerPuesto ? "#fff" : COLOR.grayDark}>Sí</Btn>
          <Btn onClick={() => set("tercerPuesto")(false)} disabled={!editable} color={!prefs.tercerPuesto ? COLOR.blueDark : COLOR.gray} textColor={!prefs.tercerPuesto ? "#fff" : COLOR.grayDark}>No</Btn>
        </div>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 8, lineHeight: 1.5 }}>
          Recuerda guardar. Si luego te toca uno y no puedes, puedes quitártelo tú mismo del cuadrante.
        </div>
      </Card>

      <Card title="🚫 Fechas a evitar" accent={COLOR.amber}>
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
          Toca las fechas en las que preferirías no tener guardia (se minimiza, no se prohíbe).
        </div>
        <DateGrid anio={anio} mes={mes} selected={prefs.fechasEvitar} bloqueadas={fechasBloqueadas} disabled={!editable}
          onToggle={(f) => toggleFecha("fechasEvitar", f)} color={COLOR.amber} />
      </Card>

      <Card title="Notas">
        <textarea value={prefs.notas} onChange={(e) => set("notas")(e.target.value)} disabled={!editable}
          placeholder={editable ? "Cualquier otra circunstancia a tener en cuenta…" : ""} rows={4}
          style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
      </Card>

      {sinGuardar && !saving && (
        <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, textAlign: "center", marginBottom: -6 }}>
          Tienes cambios sin guardar en {nombreMes}
        </div>
      )}
      {fase === "error" ? (
        <Btn onClick={() => setRecarga((n) => n + 1)} color={COLOR.red}>No se pudieron cargar tus preferencias · Reintentar</Btn>
      ) : (
        <Btn onClick={guardar} disabled={saving || !editable}>
          {!editable ? "Cargando preferencias del mes…" : saving ? "Guardando…" : saved ? "✓ Guardado" : "💾 Guardar preferencias"}
        </Btn>
      )}
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Prefs = PrefsScreen;

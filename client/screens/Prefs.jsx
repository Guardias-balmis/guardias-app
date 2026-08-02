// PrefsScreen — preferencias del residente para el mes en curso (app.mes/app.anio,
// COMPARTIDO con CalendarScreen). Fase 4: sustituye día-de-semana genérico por fechas
// concretas del mes. Fase 5.x / decisión V-8: dentro de Bloqueo, solo BAJA sigue bloqueando
// la asignación (INV-5) — vacaciones y rotación pasaron a ser informativas para el
// generador, igual que fechasEvitar, aunque sus fechas SIGUEN alimentando INV-2/6/7 y la
// equidad. Se quitó la sección de "fechas preferidas" (BLANDO positivo) a petición del
// autor. Acentos de color: rojo=BAJA (sigue bloqueando), naranja=vacaciones/rotación/evitar
// (informativo, no bloquea).
import { COLOR, SHADOW, S } from "./client/lib/design-tokens.js";
import { datesOfMonth, weekday, compareISO, addDays } from "./v2/domain/calendar.js";

const { useState, useEffect } = React;
const { Card, SectionTitle, Btn, Aviso } = window.UI;

const DEFAULT_PREFS = {
  maxGuardias: 5,
  preferDobles: false,
  fechasEvitar: [],
  notas: "",
};
const MOTIVO_LABEL = { VACACIONES: "Vacaciones", ROTACION: "Rotación externa", BAJA: "Baja" };

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fechaEs(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });
}

function Toggle({ on, onChange, label }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      display: "flex", alignItems: "center", gap: 10, background: "transparent",
      border: "none", cursor: "pointer", padding: 0, textAlign: "left", width: "100%",
    }}>
      <span style={{
        width: 44, height: 24, borderRadius: 12, flexShrink: 0,
        background: on ? COLOR.blue : COLOR.grayMid, position: "relative", transition: "background .15s",
      }}>
        <span style={{
          position: "absolute", top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: 9,
          background: "#fff", boxShadow: SHADOW.toggleKnob, transition: "left .15s",
        }} />
      </span>
      <span style={{ fontSize: 13, color: COLOR.bodyText, lineHeight: 1.4 }}>{label}</span>
    </button>
  );
}

function Counter({ value, onChange, min, max }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <button style={{ ...S.counterBtn, opacity: value <= min ? 0.4 : 1 }} disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.blueDark, minWidth: 26, textAlign: "center" }}>{value}</div>
      <button style={{ ...S.counterBtn, opacity: value >= max ? 0.4 : 1 }} disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}

/** Rejilla de fechas del mes para marcar BLANDO (preferido/evitar) — sustituye a los toggles de día-de-semana del v1. */
function DateGrid({ anio, mes, selected, onToggle, color, bloqueadas }) {
  const dias = datesOfMonth(anio, mes);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
      {dias.map((fecha) => {
        const active = selected.includes(fecha);
        const bloqueada = bloqueadas.has(fecha);
        return (
          <button key={fecha} disabled={bloqueada} title={bloqueada ? "Ya tienes un bloqueo ese día" : fecha}
            onClick={() => onToggle(fecha)} style={{
              ...S.dayToggleBtn, padding: "6px 2px", display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
              background: bloqueada ? COLOR.grayMid : active ? color : "#fff",
              color: bloqueada ? COLOR.grayDark : active ? "#fff" : COLOR.grayDark,
              border: active || bloqueada ? "none" : `1.5px solid ${COLOR.grayMid}`,
              opacity: bloqueada ? 0.6 : 1, cursor: bloqueada ? "default" : "pointer",
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
function NuevoBloqueo({ anio, mes, onCreated, showToast, api }) {
  const primerDia = datesOfMonth(anio, mes)[0];
  const [motivo, setMotivo] = useState("VACACIONES");
  const [desde, setDesde] = useState(primerDia);
  const [hasta, setHasta] = useState(primerDia);
  const [provincia, setProvincia] = useState("");
  const [saving, setSaving] = useState(false);

  const valido = desde && hasta && compareISO(desde, hasta) <= 0;

  const crear = async () => {
    if (!valido) { showToast("El rango de fechas no es válido", "err"); return; }
    setSaving(true);
    const extra = motivo === "ROTACION" && provincia ? { provincia } : {};
    const r = await api.crearBloqueo(desde, hasta, motivo, extra);
    setSaving(false);
    if (r.ok) { showToast("Bloqueo añadido ✓"); onCreated(); }
    else showToast("Error añadiendo el bloqueo: " + r.error, "err");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
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

/**
 * Voluntariado del tercer puesto (INV-8, decisión V-18). Autoservicio: nadie apunta a nadie,
 * porque el 3P «será siempre voluntario». Lo único que hay que aceptar explícitamente es el
 * compromiso de permanencia — y se acepta aquí, no en un aviso que se cierra sin leer, porque
 * es lo que después impide retirarse.
 */
function Voluntariado3P({ api, showToast }) {
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState(null);
  const [acepto, setAcepto] = useState(false);
  const [busy, setBusy] = useState(false);

  const cargar = async () => {
    const r = await api.estadoVoluntariado3P();
    if (r.ok) { setEstado(r); setError(null); } else setError(r.error);
  };
  useEffect(() => { cargar(); }, []);

  const accion = async (fn, ok) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) { showToast(ok); setAcepto(false); cargar(); }
    else showToast(r.error, "err");
  };

  // Con reintento: sin él, un fallo de red al abrir la pantalla dejaba la tarjeta muerta y sin
  // ninguna forma de apuntarse hasta recargar la página entera.
  if (error) {
    return (
      <Card title="🩺 Tercer puesto">
        <Aviso>No se pudo cargar: {error}</Aviso>
        <div style={{ marginTop: 10 }}>
          <Btn onClick={() => { setError(null); cargar(); }} color={COLOR.gray} textColor={COLOR.blueDark}>Reintentar</Btn>
        </div>
      </Card>
    );
  }
  if (!estado) return <Card title="🩺 Tercer puesto"><div style={{ fontSize: 13, color: COLOR.grayDark }}>Cargando…</div></Card>;

  const meses = estado.permanenciaMeses;
  return (
    <Card title="🩺 Tercer puesto">
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        El tercer puesto es <b>siempre voluntario</b>: te apuntas tú, cuando quieras, y puedes
        empezar por el día de la semana que prefieras. A partir de ahí no se repite día hasta
        completar el ciclo de los siete.
      </div>

      {estado.mio ? (
        <>
          <div style={{
            background: COLOR.bluePale, borderLeft: `4px solid ${COLOR.blue}`,
            borderRadius: 8, padding: "8px 10px", fontSize: 13, color: COLOR.blueDark, marginBottom: 10,
          }}>
            Apuntado desde el <b>{fechaEs(estado.mio.desde)}</b>.{" "}
            {estado.mio.puedoRetirarme
              ? "Ya has cumplido el compromiso de permanencia."
              : <>Tu compromiso llega hasta el <b>{fechaEs(estado.mio.compromisoHasta)}</b>.</>}
          </div>
          <Btn onClick={() => accion(() => api.retirarVoluntariado3P(), "Te has retirado del tercer puesto")}
            disabled={busy || !estado.mio.puedoRetirarme} color={COLOR.gray} textColor={COLOR.red}>
            Retirarme del tercer puesto
          </Btn>
          {!estado.mio.puedoRetirarme && (
            <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 6 }}>
              Podrás retirarte a partir del {fechaEs(addDays(estado.mio.compromisoHasta, 1))}.
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{
            background: COLOR.gray, borderLeft: `4px solid ${COLOR.orange}`,
            borderRadius: 8, padding: "8px 10px", fontSize: 13, color: COLOR.bodyText, marginBottom: 10, lineHeight: 1.5,
          }}>
            Al apuntarte asumes un <b>compromiso de permanencia de {meses} meses</b>. La rotación
            solo funciona si se sostiene en el tiempo: entrar y salir a las pocas semanas deja el
            ciclo a medias y descuadra el reparto con el resto de voluntarios.
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={acepto} onChange={(e) => setAcepto(e.target.checked)} style={{ marginTop: 2 }} />
            <span style={{ fontSize: 13, color: COLOR.bodyText, lineHeight: 1.4 }}>
              Entiendo que me comprometo a mantenerme {meses} meses.
            </span>
          </label>
          <Btn onClick={() => accion(() => api.ofrecerse3P(true), "Te has apuntado al tercer puesto ✓")} disabled={busy || !acepto}>
            Apuntarme al tercer puesto
          </Btn>
        </>
      )}

      <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 10 }}>
        {estado.voluntarios.length === 0
          ? "Ahora mismo no hay nadie apuntado."
          : `Apuntados ahora mismo: ${estado.voluntarios.length}.`}
      </div>
    </Card>
  );
}

function PrefsScreen() {
  const app = window.useApp();
  const { myResidente, anio, mes, setTab, showToast, api } = app;

  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [bloqueos, setBloqueos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showNuevoBloqueo, setShowNuevoBloqueo] = useState(false);

  const cargarBloqueos = async () => {
    const r = await api.misBloqueos(anio, mes);
    if (r.ok) setBloqueos(r.bloqueos);
  };

  useEffect(() => {
    if (!myResidente) return;
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      const [rPrefs] = await Promise.all([api.misPreferencias(anio, mes), cargarBloqueos()]);
      if (cancelled) return;
      if (rPrefs.ok) setPrefs(rPrefs.prefs ? { ...DEFAULT_PREFS, ...rPrefs.prefs } : { ...DEFAULT_PREFS });
      else showToast("Error cargando preferencias: " + rPrefs.error, "err");
      app.setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes, myResidente?.id]);

  if (!myResidente) {
    return (
      <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
        <Aviso>Cargando tu residente… si esto no desaparece, recarga la página.</Aviso>
      </div>
    );
  }

  const set = (field) => (value) => setPrefs((p) => ({ ...p, [field]: value }));
  const toggleFecha = (field, fecha) => setPrefs((p) => ({
    ...p,
    [field]: p[field].includes(fecha) ? p[field].filter((d) => d !== fecha) : [...p[field], fecha],
  }));

  // Fechas ya cubiertas por CUALQUIER bloqueo (vacaciones/rotación/baja): no tiene sentido
  // marcarlas también como "a evitar" — ya son una ausencia conocida y registrada.
  const fechasBloqueadas = new Set();
  for (const b of bloqueos) {
    for (const f of datesOfMonth(anio, mes)) {
      if (compareISO(b.desde, f) <= 0 && compareISO(f, b.hasta) <= 0) fechasBloqueadas.add(f);
    }
  }

  const guardar = async () => {
    setSaving(true);
    setSaved(false);
    const r = await api.guardarPreferencias(anio, mes, prefs);
    setSaving(false);
    if (r.ok) {
      showToast("Preferencias guardadas ✓");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      showToast("Error guardando preferencias: " + r.error, "err");
    }
  };

  const cancelarBloqueo = async (id) => {
    const r = await api.cancelarBloqueo(id);
    if (r.ok) { showToast("Bloqueo cancelado"); cargarBloqueos(); }
    else showToast("Error cancelando: " + r.error, "err");
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
      <SectionTitle>⚙️ Preferencias del mes</SectionTitle>

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>
            {nombreMesDe(anio, mes)}
          </div>
          <button onClick={() => setTab("calendar")} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>
            Ver cuadrante →
          </button>
        </div>
      </Card>

      <Card title="Guardias máximas">
        <Counter value={prefs.maxGuardias} min={4} max={6} onChange={set("maxGuardias")} />
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 8 }}>(normativa: 4–6)</div>
        <div style={{ marginTop: 14 }}>
          <Toggle on={prefs.preferDobles} onChange={set("preferDobles")}
            label="Prefiero viernes-domingo frente a sábados aislados" />
        </div>
      </Card>

      <Card title="🗓️ Vacaciones, rotación y baja">
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          Vacaciones y rotación son informativas: el generador evita asignarte guardia esos
          días, pero puede hacerlo si no queda alternativa — el validador no lo bloquea. La
          baja médica o el embarazo son distintos: <b>nunca</b> se te asignará guardia esos
          días, lo hace cumplir el validador.
        </div>
        {bloqueos.length === 0 ? (
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
                  <button onClick={() => cancelarBloqueo(b.id)} style={{ ...S.smallBtn, background: "#fff", color }}>Cancelar</button>
                </div>
              );
            })}
          </div>
        )}
        {showNuevoBloqueo ? (
          <NuevoBloqueo anio={anio} mes={mes} api={api} showToast={showToast}
            onCreated={() => { setShowNuevoBloqueo(false); cargarBloqueos(); }} />
        ) : (
          <Btn onClick={() => setShowNuevoBloqueo(true)} color={COLOR.gray} textColor={COLOR.blueDark}>+ Añadir</Btn>
        )}
      </Card>

      <Voluntariado3P api={api} showToast={showToast} />

      <Card title="Fechas a evitar">
        <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
          Toca las fechas en las que preferirías no tener guardia (se minimiza, no se prohíbe).
        </div>
        <DateGrid anio={anio} mes={mes} selected={prefs.fechasEvitar} bloqueadas={fechasBloqueadas}
          onToggle={(f) => toggleFecha("fechasEvitar", f)} color={COLOR.orange} />
      </Card>

      <Card title="Notas">
        <textarea value={prefs.notas} onChange={(e) => set("notas")(e.target.value)}
          placeholder="Cualquier otra circunstancia a tener en cuenta…" rows={4}
          style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
      </Card>

      <Btn onClick={guardar} disabled={saving}>
        {saving ? "Guardando…" : saved ? "✓ Guardado" : "💾 Guardar preferencias"}
      </Btn>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Prefs = PrefsScreen;

// PrefsScreen — preferencias del residente para el mes en curso (app.mes/app.anio,
// COMPARTIDO con CalendarScreen: no se crea un selector de mes propio aquí).
import { COLOR, SHADOW, S, DIAS_SEMANA, DIAS_NOMBRE } from "./client/lib/design-tokens.js";
import { daysInMonth } from "./v2/domain/calendar.js";

const { useState, useEffect } = React;
const { Card, SectionTitle, Btn, Aviso, Info } = window.UI;

const DEFAULT_PREFS = {
  maxGuardias: 5,
  preferDobles: false,
  diasPreferidos: [],
  diasEvitar: [],
  rotDe: null,
  rotHasta: null,
  vacDe: null,
  vacHasta: null,
  notas: "",
};

function nombreMesDe(anio, mes) {
  return new Date(Date.UTC(anio, mes - 1, 1))
    .toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
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

function DayToggleRow({ selected, onToggle, color }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {DIAS_SEMANA.map((d) => {
        const active = selected.includes(d);
        return (
          <button key={d} title={DIAS_NOMBRE[d]} onClick={() => onToggle(d)} style={{
            ...S.dayToggleBtn,
            background: active ? color : COLOR.gray,
            color: active ? "#fff" : COLOR.grayDark,
            border: active ? "none" : `1.5px solid ${COLOR.grayMid}`,
          }}>{d}</button>
        );
      })}
    </div>
  );
}

function DiaRangoInputs({ deLabel, hastaLabel, de, hasta, onDe, onHasta, maxDia }) {
  const parse = (v) => (v === "" ? null : Math.min(maxDia, Math.max(1, Number(v))));
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div style={{ flex: 1 }}>
        <label style={S.label}>{deLabel}</label>
        <input type="number" min={1} max={maxDia} value={de ?? ""} placeholder="—"
          onChange={(e) => onDe(parse(e.target.value))}
          style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
      </div>
      <div style={{ flex: 1 }}>
        <label style={S.label}>{hastaLabel}</label>
        <input type="number" min={1} max={maxDia} value={hasta ?? ""} placeholder="—"
          onChange={(e) => onHasta(parse(e.target.value))}
          style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
      </div>
    </div>
  );
}

function PrefsScreen() {
  const app = window.useApp();
  const { myResidente, anio, mes, setTab, showToast } = app;

  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!myResidente) return;
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      const r = await app.api.misPreferencias(anio, mes);
      if (cancelled) return;
      if (r.ok) setPrefs(r.prefs ? { ...DEFAULT_PREFS, ...r.prefs } : { ...DEFAULT_PREFS });
      else showToast("Error cargando preferencias: " + r.error, "err");
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

  const maxDia = daysInMonth(anio, mes);
  const set = (field) => (value) => setPrefs((p) => ({ ...p, [field]: value }));
  const toggleDia = (field, dia) => setPrefs((p) => ({
    ...p,
    [field]: p[field].includes(dia) ? p[field].filter((d) => d !== dia) : [...p[field], dia],
  }));

  const guardar = async () => {
    setSaving(true);
    setSaved(false);
    const r = await app.api.guardarPreferencias(anio, mes, prefs);
    setSaving(false);
    if (r.ok) {
      showToast("Preferencias guardadas ✓");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      showToast("Error guardando preferencias: " + r.error, "err");
    }
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

      <Card title="Días preferidos">
        <DayToggleRow selected={prefs.diasPreferidos} onToggle={(d) => toggleDia("diasPreferidos", d)} color={COLOR.blue} />
      </Card>

      <Card title="Días a evitar">
        <DayToggleRow selected={prefs.diasEvitar} onToggle={(d) => toggleDia("diasEvitar", d)} color={COLOR.orange} />
      </Card>

      <Card title="Rotación externa">
        <DiaRangoInputs deLabel="Desde (día)" hastaLabel="Hasta (día)" maxDia={maxDia}
          de={prefs.rotDe} hasta={prefs.rotHasta} onDe={set("rotDe")} onHasta={set("rotHasta")} />
      </Card>

      <Card title="Vacaciones">
        <DiaRangoInputs deLabel="Desde (día)" hastaLabel="Hasta (día)" maxDia={maxDia}
          de={prefs.vacDe} hasta={prefs.vacHasta} onDe={set("vacDe")} onHasta={set("vacHasta")} />
      </Card>

      <Card title="Notas">
        <textarea value={prefs.notas} onChange={(e) => set("notas")(e.target.value)}
          placeholder="Cualquier otra circunstancia a tener en cuenta…" rows={4}
          style={{ ...S.input, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
      </Card>

      <Info>Estas preferencias se guardan solo para {myResidente.nombre} y solo para {nombreMesDe(anio, mes)}. El generador las tendrá en cuenta pero no garantizan el resultado exacto.</Info>

      <Btn onClick={guardar} disabled={saving}>
        {saving ? "Guardando…" : saved ? "✓ Guardado" : "💾 Guardar preferencias"}
      </Btn>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Prefs = PrefsScreen;

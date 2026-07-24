// LoginScreen — Sign in with Google real (GIS + ID token verificado), sin implicit flow,
// sin modo demo, sin backdoor de rol (bugs del v1 — ver docs/auditoria). Un residente sin
// vincular ve aquí mismo el formulario de alta autoservicio (DoD-1).
import { COLOR } from "./client/lib/design-tokens.js";
import { setupGoogleSignIn, submitAlta } from "./client/lib/auth.js";
import { GOOGLE_CLIENT_ID } from "./client/config.js";
import { addDays, addYears, compareISO } from "./v2/domain/calendar.js";
import { todayISO } from "./client/lib/dates.js";

const { useState, useEffect, useRef } = React;
const { Card, Btn, Aviso } = window.UI;

function LoginScreen() {
  const app = window.useApp();
  const buttonRef = useRef(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // {pendingToken} tras login fallido por email no vinculado

  useEffect(() => {
    if (!window.google || !buttonRef.current) return;
    setupGoogleSignIn({
      api: app.api, clientId: GOOGLE_CLIENT_ID, gis: window.google.accounts.id, buttonEl: buttonRef.current,
      onSuccess: (r) => app.onLoggedIn(r),
      onNeedsAlta: (info) => setPending(info),
      onError: (e) => setError(e),
    });
  }, []);

  if (pending) return <AltaForm pendingToken={pending.pendingToken} onCancel={() => setPending(null)} onSuccess={app.onLoggedIn} />;

  return (
    <div style={{ minHeight: "80vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 56, marginBottom: 8 }}>🏥</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: COLOR.blueDark }}>Guardias</div>
          <div style={{ fontSize: 14, color: COLOR.grayDark, marginTop: 4 }}>Hospital Dr. Balmis · Radiodiagnóstico</div>
        </div>
        <Card>
          <div ref={buttonRef} style={{ display: "flex", justifyContent: "center", minHeight: 44 }} />
          {error && <div style={{ marginTop: 12 }}><Aviso color={COLOR.red} bg={COLOR.redLight}>{error}</Aviso></div>}
        </Card>
        <div style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: COLOR.grayDark, lineHeight: 1.6 }}>
          Acceso exclusivo para residentes de Radiodiagnóstico<br />del Hospital Dr. Balmis
        </div>
      </div>
    </div>
  );
}

/** Alta autoservicio (DoD-1): nombre, fecha de inicio, fecha de fin (sugerida a inicio+4a). */
function AltaForm({ pendingToken, onCancel, onSuccess }) {
  const app = window.useApp();
  const [nombre, setNombre] = useState("");
  const [fechaInicio, setFechaInicio] = useState(todayISO());
  const [fechaFin, setFechaFin] = useState(addDays(addYears(todayISO(), 4), -1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const fechasValidas = fechaInicio && fechaFin && compareISO(fechaInicio, fechaFin) <= 0;

  const onFechaInicioChange = (v) => {
    setFechaInicio(v);
    // Sugerencia automática (editable): 4 años de residencia menos un día — spec.md §3.1
    try { setFechaFin(addDays(addYears(v, 4), -1)); } catch { /* fecha aún incompleta */ }
  };

  const submit = async () => {
    if (!nombre.trim() || !fechasValidas) { setError("Rellena el nombre y unas fechas válidas"); return; }
    setSaving(true);
    setError(null);
    await submitAlta({
      api: app.api, identidad: { pendingToken }, datos: { nombre: nombre.trim(), fechaInicio, fechaFin },
      onSuccess, onError: (e) => setError(e),
    });
    setSaving(false);
  };

  return (
    <div style={{ padding: 16, maxWidth: 420, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <window.UI.SectionTitle>👋 Bienvenido — date de alta</window.UI.SectionTitle>
      <Card>
        <div style={{ fontSize: 13, color: COLOR.grayDark, marginBottom: 12, lineHeight: 1.5 }}>
          Tu cuenta de Google está verificada pero no hay ningún residente vinculado a este
          email todavía. Rellena tus datos para darte de alta — tu nivel (R1–R4) se calculará
          solo a partir de las fechas, nadie tiene que asignártelo.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase" }}>Nombre completo *</label>
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre Apellido Apellido"
              style={{ width: "100%", marginTop: 4, padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${COLOR.grayMid}`, fontSize: 14 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase" }}>Fecha de incorporación *</label>
            <input type="date" value={fechaInicio} onChange={(e) => onFechaInicioChange(e.target.value)}
              style={{ width: "100%", marginTop: 4, padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${COLOR.grayMid}`, fontSize: 14 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase" }}>Fecha de fin de residencia</label>
            <input type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)}
              style={{ width: "100%", marginTop: 4, padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${COLOR.grayMid}`, fontSize: 14 }} />
            <div style={{ fontSize: 11, color: COLOR.grayDark, marginTop: 4 }}>Sugerida a 4 años; ajústala si tu residencia se alarga (baja, embarazo).</div>
          </div>
        </div>
        {error && <div style={{ marginTop: 12 }}><Aviso color={COLOR.red} bg={COLOR.redLight}>{error}</Aviso></div>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Btn onClick={onCancel} color={COLOR.grayMid} textColor={COLOR.grayDark}>Cancelar</Btn>
          <Btn onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Darme de alta"}</Btn>
        </div>
      </Card>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Login = LoginScreen;

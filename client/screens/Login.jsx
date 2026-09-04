// LoginScreen — Sign in with Google real (GIS + ID token verificado), sin implicit flow,
// sin modo demo, sin backdoor de rol (bugs del v1 — ver docs/auditoria). Un residente sin
// vincular ve aquí mismo el formulario de alta autoservicio (DoD-1).
//
// Lo que esta pantalla cuida del arranque (2026-09-04, pedido del autor: «más velocidad al
// meter el correo con Google»):
//  - El script de Google (GIS) va `async defer` y puede llegar DESPUÉS de que esto monte. Antes
//    el efecto miraba `window.google` una sola vez y, si no estaba, se rendía para siempre: el
//    botón no aparecía nunca y no había nada que pulsar salvo recargar. Ahora se espera a que
//    llegue (`waitForGis`) y, si no llega en 15 s, se dice.
//  - El nonce ya viene pedido por client/loader.js (`prefetchNonce`): `setupGoogleSignIn` lo
//    consume en vez de pedir otro, así que el botón se pinta en cuanto GIS está.
//  - El nonce caduca a los 5 min en el servidor: se refresca cada 4 con el temporizador y, como
//    en un móvil la pestaña en segundo plano no ejecuta temporizadores, también al volver a ella.
//  - Volver del formulario de alta («Cancelar») rehace el login entero: el nonce anterior se
//    consumió al verificar el email, y el botón se desmontó con el formulario.
import { COLOR } from "./client/lib/design-tokens.js";
import { setupGoogleSignIn, submitAlta, waitForGis } from "./client/lib/auth.js";
import { GOOGLE_CLIENT_ID } from "./client/config.js";
import { addDays, addYears } from "./v2/domain/calendar.js";
import { rangoValido } from "./client/lib/fechas.js";
import { todayISO } from "./client/lib/dates.js";

const { useState, useEffect, useRef } = React;
const { Card, Btn, Aviso } = window.UI;

// 4 min: por debajo de los 5 de vida del nonce en el servidor (Code.gs issueNonce_), con margen
// para la latencia de Apps Script y para un temporizador que el navegador retrase.
const NONCE_REFRESCO_MS = 4 * 60 * 1000;

function LoginScreen() {
  const app = window.useApp();
  const buttonRef = useRef(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // {pendingToken} tras login fallido por email no vinculado
  const [esperandoGoogle, setEsperandoGoogle] = useState(true);
  // Sin botón de Google (no cargó el script, o no hubo nonce porque Apps Script arrancaba en frío o
  // la red falló un instante): antes la pantalla se quedaba muerta con el error y sin salida. Ahora
  // se ofrece reintentar, que vuelve a correr el efecto de abajo.
  const [sinAcceso, setSinAcceso] = useState(false);
  const [reintento, setReintento] = useState(0);

  useEffect(() => {
    if (pending) return undefined; // el formulario de alta está en pantalla: no hay botón que pintar
    let cancelado = false;
    let asa = null;
    let ultimaInit = 0;
    let temporizador = null;

    const refrescar = async () => {
      if (cancelado || !asa) return;
      ultimaInit = Date.now();
      await asa.refrescar();
    };
    // Al volver a la pestaña tras un rato (móvil bloqueado, otra app): el temporizador no ha
    // corrido y el nonce puede estar muerto. Se refresca solo si ya tocaba.
    const alVolver = () => {
      if (document.visibilityState === "visible" && Date.now() - ultimaInit >= NONCE_REFRESCO_MS) refrescar();
    };

    (async () => {
      setEsperandoGoogle(true);
      setError(null);
      setSinAcceso(false);
      const gis = await waitForGis({ getGis: () => window.google && window.google.accounts && window.google.accounts.id });
      if (cancelado) return;
      setEsperandoGoogle(false);
      if (!gis || !buttonRef.current) {
        setError("No se pudo cargar el acceso con Google. Comprueba la conexión y vuelve a intentarlo.");
        setSinAcceso(true);
        return;
      }
      asa = await setupGoogleSignIn({
        api: app.api, clientId: GOOGLE_CLIENT_ID, gis, buttonEl: buttonRef.current,
        onSuccess: (r) => app.onLoggedIn(r),
        onNeedsAlta: (info) => setPending(info),
        onError: (e) => setError(e),
      });
      ultimaInit = Date.now();
      if (cancelado) return;
      if (!asa) {
        setError((e) => "No se pudo preparar el acceso con Google" + (e ? `: ${e}` : "") + ".");
        setSinAcceso(true);
        return;
      }
      temporizador = setInterval(refrescar, NONCE_REFRESCO_MS);
      document.addEventListener("visibilitychange", alVolver);
    })();

    return () => {
      cancelado = true;
      if (temporizador) clearInterval(temporizador);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [pending, reintento]);

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
          {esperandoGoogle && !error && (
            <div style={{ textAlign: "center", fontSize: 12, color: COLOR.grayDark, marginTop: 8 }}>Cargando el acceso con Google…</div>
          )}
          {error && <div style={{ marginTop: 12 }}><Aviso color={COLOR.red} bg={COLOR.redLight}>{error}</Aviso></div>}
          {sinAcceso && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
              <Btn onClick={() => setReintento((n) => n + 1)} color={COLOR.blue} textColor="#fff">Reintentar</Btn>
            </div>
          )}
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

  // `rangoValido` y no `compareISO` a pelo: mientras se teclea el año, el input emite "0002-09-04"
  // y `parseISO` lanzaría EN EL RENDER, desmontando la app entera (ver client/lib/fechas.js).
  const fechasValidas = rangoValido(fechaInicio, fechaFin);

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

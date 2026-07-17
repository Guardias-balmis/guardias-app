// Raíz de la SPA (spec: docs/adr/001-arquitectura.md, Fase 3). Sin AdminScreen (rol
// derivado, nunca un flag editable), sin token en localStorage (auth.js usa
// sessionStorage), sin selector de mes/año en texto (mes/anio son números 1-12, no
// "Junio"/"2026" — mata la clase de bug de desfase del v1).
import { COLOR, S } from "./client/lib/design-tokens.js";
import { makeApi } from "./client/lib/api.js";
import { getSession, clearSession } from "./client/lib/auth.js";
import { todayISO } from "./client/lib/dates.js";
import { EXEC_URL } from "./client/config.js";
import { defaultTrainingPeriods, levelOn, groupOf } from "./v2/domain/residents.js";
import { addDays, addYears } from "./v2/domain/calendar.js";

const { useState, useEffect, useCallback, createContext, useContext } = React;

const AppCtx = createContext(null);
function useApp() { return useContext(AppCtx); }
window.useApp = useApp; // las pantallas .jsx no pueden `import` este módulo (decisión C-1); se exponen así

function App() {
  const [auth, setAuth] = useState(() => getSession());
  const [residentes, setResidentes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("home");
  const [toast, setToast] = useState(null);
  const today = new Date();
  const [mes, setMes] = useState(today.getMonth() + 1); // 1-12
  const [anio, setAnio] = useState(today.getFullYear());

  const api = React.useMemo(() => makeApi(EXEC_URL, { getSession: () => (getSession() || {}).session }), []);

  const showToast = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setAuth(null);
    setResidentes([]);
    setTab("home"); // si no, el siguiente login hereda la pestaña de la sesión anterior
  }, []);

  const loadResidentes = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    const r = await api.listResidentes();
    if (r.ok) setResidentes(r.residentes);
    else showToast("Error cargando residentes: " + r.error, "err");
    setLoading(false);
  }, [auth, api, showToast]);

  useEffect(() => { loadResidentes(); }, [auth?.session]);

  const myResidente = residentes.find((r) => r.id === auth?.residente?.id) || null;
  const nivel = myResidente ? levelOn(defaultTrainingPeriods(myResidente.fechaInicio, myResidente.fechaFin || addDays(addYears(myResidente.fechaInicio, 4), -1)), todayISO()) : null;
  const grupo = groupOf(nivel);
  const isResponsable = auth?.residente?.rol === "responsable";

  const ctx = {
    api, auth, onLoggedIn: (r) => setAuth(r), logout,
    residentes, loadResidentes, myResidente, nivel, grupo, isResponsable,
    loading, setLoading, showToast,
    tab, setTab, mes, setMes, anio, setAnio,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: COLOR.gray }}>
        <Header />
        <div style={{ flex: 1, padding: "0 0 80px" }}>
          {!auth ? React.createElement(window.Screens.Login) :
            tab === "home" ? React.createElement(window.Screens.Home) :
            tab === "prefs" ? React.createElement(window.Screens.Prefs) :
            tab === "calendar" ? React.createElement(window.Screens.Calendar) :
            tab === "generator" ? React.createElement(window.Screens.Generator) :
            tab === "settings" ? React.createElement(window.Screens.Settings) :
            tab === "responsable" ? React.createElement(window.Screens.Responsable) : null}
        </div>
        {auth && <BottomNav />}
        {toast && <window.UI.Toast msg={toast.msg} type={toast.type} />}
      </div>
    </AppCtx.Provider>
  );
}

function Header() {
  const { auth, logout, setTab, isResponsable } = useApp();
  return (
    <div style={{ background: COLOR.blueDark, color: "#fff", padding: "14px 16px 10px", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.3 }}>🏥 Guardias · Dr. Balmis</div>
          {auth && (
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>
              {auth.residente.nombre}{isResponsable ? " · 📋 Responsable" : ""}
            </div>
          )}
        </div>
        {auth && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => setTab("settings")} style={S.iconBtn}>⚙️</button>
            <button onClick={logout} style={S.iconBtn} title="Cerrar sesión">↩️</button>
          </div>
        )}
      </div>
    </div>
  );
}

function BottomNav() {
  const { tab, setTab } = useApp();
  const items = [
    { id: "home", icon: "🏠", label: "Inicio" },
    { id: "prefs", icon: "⚙️", label: "Preferencias" },
    { id: "calendar", icon: "📅", label: "Cuadrante" },
    { id: "generator", icon: "🤖", label: "Generador" },
  ];
  return (
    <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: `1px solid ${COLOR.grayMid}`, display: "flex", zIndex: 100, boxShadow: "0 -2px 12px rgba(0,0,0,0.08)" }}>
      {items.map((it) => (
        <button key={it.id} onClick={() => setTab(it.id)} style={{
          flex: 1, padding: "10px 4px 8px", border: "none", background: "transparent",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
          color: tab === it.id ? COLOR.blue : COLOR.grayDark,
          fontSize: 11, fontWeight: tab === it.id ? 700 : 400,
          borderTop: tab === it.id ? `2px solid ${COLOR.blue}` : "2px solid transparent",
        }}>
          <span style={{ fontSize: 20 }}>{it.icon}</span>
          {it.label}
        </button>
      ))}
    </nav>
  );
}

window.Screens = window.Screens || {};
window.Screens.App = App;

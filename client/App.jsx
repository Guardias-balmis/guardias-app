// Raíz de la SPA (spec: docs/adr/001-arquitectura.md, Fase 3). Sin AdminScreen (rol
// derivado, nunca un flag editable), sin token en localStorage (auth.js usa
// sessionStorage), sin selector de mes/año en texto (mes/anio son números 1-12, no
// "Junio"/"2026" — mata la clase de bug de desfase del v1).
import { COLOR, S } from "./client/lib/design-tokens.js";
import { makeApi } from "./client/lib/api.js";
import { getSession, clearSession } from "./client/lib/auth.js";
import { todayISO } from "./client/lib/dates.js";
import { EXEC_URL } from "./client/config.js";
import { levelOn, groupOf, periodsOfResident } from "./v2/domain/residents.js";
import { partirResidentesLegibles } from "./client/lib/residentes.js";

const { useState, useEffect, useCallback, createContext, useContext } = React;

const AppCtx = createContext(null);
function useApp() { return useContext(AppCtx); }
window.useApp = useApp; // las pantallas .jsx no pueden `import` este módulo (decisión C-1); se exponen así

function App() {
  const [auth, setAuth] = useState(() => getSession());
  const [residentes, setResidentes] = useState([]);
  // Los que tienen una fecha ilegible en la hoja (client/lib/residentes.js): apartados de
  // `residentes` para que ninguna pantalla reviente al derivar su nivel, y nombrados en un aviso.
  const [residentesIlegibles, setResidentesIlegibles] = useState([]);
  const [residentesError, setResidentesError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTabRaw] = useState("home");
  // Celdas sin guardar del cuadrante (lo escribe Calendar.jsx): cambiar de pestaña o cerrar
  // sesión desmonta esa pantalla y las perdería en silencio, así que se pregunta antes.
  const cambiosSinGuardarRef = React.useRef(0);
  const confirmaPerderCambios = () => cambiosSinGuardarRef.current === 0
    || window.confirm(`Tienes ${cambiosSinGuardarRef.current} cambios sin guardar en el cuadrante. ¿Salir y perderlos?`);
  // La pestaña YA activa no se «abandona»: sin esta guarda, pulsar «Cuadrante» estando en el
  // cuadrante preguntaba «¿Salir y perderlos?» sin salir, y al aceptar ponía el contador a 0 con la
  // pantalla aún montada —así que el siguiente cambio de pestaña ya no preguntaba y las celdas se
  // perdían en silencio. El contador lo pone a 0 el propio Calendar.jsx al desmontarse, que es el
  // único momento en que de verdad se pierden.
  const tabRef = React.useRef("home");
  useEffect(() => { tabRef.current = tab; }, [tab]);
  const setTab = useCallback((t) => {
    if (t === tabRef.current) return;
    if (!confirmaPerderCambios()) return;
    setTabRaw(t);
  }, []);
  const [toast, setToast] = useState(null);
  const today = new Date();
  const [mes, setMes] = useState(today.getMonth() + 1); // 1-12
  const [anio, setAnio] = useState(today.getFullYear());
  // La lista de residentes que `login`/`altaResidente` ya devuelven (el servidor la acababa de
  // leer para resolver el email): con ella no hace falta la petición de `listResidentes` nada más
  // entrar, que era una ida y vuelta entera a Apps Script entre el clic en Google y ver Inicio.
  const residentesDeLoginRef = React.useRef(null);
  // Evita que varias peticiones en vuelo rechazadas por la misma sesión caducada disparen
  // varios avisos: la primera cierra la sesión, las demás llegan ya sin sesión que cerrar.
  const sesionCaducadaRef = React.useRef(false);

  const showToast = useCallback((msg, type = "ok") => {
    // Tras cerrar la sesión por caducidad, las pantallas que aún tenían peticiones en vuelo
    // llegan con su propio «Error cargando…: sesión expirada» y pisarían el aviso que explica
    // qué ha pasado. Se silencian hasta el siguiente login (`onLoggedIn` levanta la veda).
    if (sesionCaducadaRef.current && type === "err" && !getSession()) return;
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Quién tiene el mandato HOY según el servidor (`estadoCuadrante.responsableId`, releído del
  // store). `undefined` hasta que alguna pantalla lo reciba: entonces manda el `rol` del token, que
  // se firmó en el login y puede ser anterior al sorteo —el ganador se quedaba sin botones hasta
  // volver a entrar, aunque el servidor ya le aceptara todo (V-16)—; un servidor anterior a este
  // campo no lo manda y se sigue con el token, como antes.
  const [responsableIdServidor, setResponsableIdServidor] = useState(undefined);
  const actualizaResponsable = useCallback((id) => { if (id !== undefined) setResponsableIdServidor(id); }, []);

  const cerrarSesion = useCallback(() => {
    clearSession();
    setAuth(null);
    setResponsableIdServidor(undefined);
    setResidentes([]);
    setResidentesIlegibles([]);
    setResidentesError(null);
    cambiosSinGuardarRef.current = 0;
    setTabRaw("home"); // si no, el siguiente login hereda la pestaña de la sesión anterior
  }, []);
  // El botón de cerrar sesión pregunta si hay celdas sin guardar; la caducidad (abajo) no puede
  // preguntar nada: la sesión ya no sirve y los cambios no se podrían guardar de todas formas.
  const logout = useCallback(() => { if (confirmaPerderCambios()) cerrarSesion(); }, [cerrarSesion]);

  // Sesión rechazada por el servidor (caducada a las 12 h, o firmada con un secreto rotado):
  // antes la app se quedaba en pie enseñando «sesión expirada» en cada pantalla, sin ofrecer
  // volver a entrar. Ahora se cierra y se vuelve al login con el motivo, una sola vez.
  const onSessionInvalid = useCallback(() => {
    if (sesionCaducadaRef.current || !getSession()) return;
    cerrarSesion();
    sesionCaducadaRef.current = true;
    // Directo, sin `showToast`: es el único aviso que tiene que verse después de cerrar la sesión.
    setToast({ msg: "Tu sesión ha caducado: vuelve a entrar con Google", type: "err" });
    setTimeout(() => setToast(null), 5000);
  }, [cerrarSesion]);

  const api = React.useMemo(() => makeApi(EXEC_URL, {
    getSession: () => (getSession() || {}).session,
    onSessionInvalid: (e) => onSessionInvalid(e),
  }), [onSessionInvalid]);

  // Única entrada de la lista de residentes al estado de la app (login, alta o listResidentes):
  // aparta a los de fechas ilegibles y lo dice una vez, con nombres, para que alguien lo arregle
  // en Ajustes → Residentes en vez de descubrirlo por una pantalla en blanco.
  const recibeResidentes = useCallback((lista) => {
    const { legibles, ilegibles } = partirResidentesLegibles(lista, todayISO());
    setResidentes(legibles);
    setResidentesIlegibles(ilegibles);
    setResidentesError(null);
  }, []);

  const onLoggedIn = useCallback((r) => {
    sesionCaducadaRef.current = false;
    setResponsableIdServidor(undefined);
    if (Array.isArray(r.residentes)) {
      residentesDeLoginRef.current = r.residentes;
      recibeResidentes(r.residentes);
    }
    setAuth({ session: r.session, residente: r.residente });
  }, [recibeResidentes]);

  const loadResidentes = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    const r = await api.listResidentes();
    if (r.ok) recibeResidentes(r.residentes);
    else {
      // Se guarda el error además del aviso: sin la lista la app no sabe ni quién eres (nivel,
      // grupo, permisos), y un toast de tres segundos no es una salida — Inicio ofrece reintentar.
      setResidentesError(r.error);
      showToast("Error cargando residentes: " + r.error, "err");
    }
    setLoading(false);
  }, [auth, api, showToast, recibeResidentes]);

  useEffect(() => {
    // Recién entrado con la lista ya en mano (ver `onLoggedIn`): no se repite la petición. Un
    // backend anterior a este cambio no la manda, y entonces se pide como siempre.
    if (residentesDeLoginRef.current) { residentesDeLoginRef.current = null; return; }
    loadResidentes();
  }, [auth?.session]);

  const myResidente = residentes.find((r) => r.id === auth?.residente?.id) || null;
  const nivel = myResidente ? levelOn(periodsOfResident(myResidente), todayISO()) : null;
  const grupo = groupOf(nivel);
  const isResponsable = responsableIdServidor !== undefined
    ? responsableIdServidor !== null && responsableIdServidor === auth?.residente?.id
    : auth?.residente?.rol === "responsable";

  const ctx = {
    api, auth, onLoggedIn, logout,
    residentes, residentesIlegibles, residentesError, loadResidentes, myResidente, nivel, grupo, isResponsable, actualizaResponsable,
    loading, setLoading, showToast, cambiosSinGuardarRef,
    tab, setTab, mes, setMes, anio, setAnio,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: COLOR.gray }}>
        <Header />
        <div key={!auth ? "login" : tab} className="gapp-rise" style={{ flex: 1, padding: "0 0 80px" }}>
          {!auth ? React.createElement(window.Screens.Login) :
            tab === "home" ? React.createElement(window.Screens.Home) :
            tab === "prefs" ? React.createElement(window.Screens.Prefs) :
            tab === "calendar" ? React.createElement(window.Screens.Calendar) :
            tab === "settings" ? React.createElement(window.Screens.Settings) :
            tab === "responsable" ? React.createElement(window.Screens.Responsable) :
            tab === "datos-servicio" ? React.createElement(window.Screens.DatosServicio) :
            tab === "residentes" ? React.createElement(window.Screens.Residentes) : null}
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
  ];
  // Índice del tab activo entre los de la barra (puede ser -1 si `tab` es una pantalla
  // sin ítem propio aquí, ej. "settings" desde el engranaje del Header): el indicador
  // se oculta en vez de saltar a una posición que no corresponde a ningún botón.
  const activeIdx = items.findIndex((it) => it.id === tab);
  return (
    <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: `1px solid ${COLOR.grayMid}`, display: "flex", zIndex: 100, boxShadow: "0 -2px 12px rgba(0,0,0,0.08)" }}>
      <div className="gapp-navind" style={{
        position: "absolute", top: -1, height: 2, width: `${100 / items.length}%`,
        left: activeIdx >= 0 ? `${(activeIdx * 100) / items.length}%` : "0%",
        background: COLOR.blue, opacity: activeIdx >= 0 ? 1 : 0,
      }} />
      {items.map((it) => (
        <button key={it.id} onClick={() => setTab(it.id)} style={{
          flex: 1, padding: "10px 4px 8px", border: "none", background: "transparent",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
          color: tab === it.id ? COLOR.blue : COLOR.grayDark,
          fontSize: 11, fontWeight: tab === it.id ? 700 : 400,
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

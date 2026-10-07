// Raíz de la SPA (spec: docs/adr/001-arquitectura.md, Fase 3). Sin AdminScreen (rol
// derivado, nunca un flag editable), sin selector de mes/año en texto (mes/anio son números
// 1-12, no "Junio"/"2026" — mata la clase de bug de desfase del v1). La sesión vive en
// `localStorage` desde la decisión S-8 (ver client/lib/auth.js), y el botón «atrás» del móvil
// navega entre pantallas con Inicio como raíz (client/lib/navegacion.js) en vez de sacar de la app.
import { COLOR, S } from "./client/lib/design-tokens.js";
import { makeApi } from "./client/lib/api.js";
import { getSession, clearSession, CLAVE_SESION } from "./client/lib/auth.js";
import { crearNavegacion, pantallaGuardada } from "./client/lib/navegacion.js";
import { todayISO } from "./client/lib/dates.js";
import { EXEC_URL } from "./client/config.js";
import { levelOn, groupOf, periodsOfResident } from "./v2/domain/residents.js";
import { partirResidentesLegibles } from "./client/lib/residentes.js";

const { useState, useEffect, useCallback, createContext, useContext } = React;

// Las pantallas que la app sabe pintar (el `tab` de abajo). Una entrada del historial que diga otra
// —de una versión anterior— no se restaura al recargar.
const NAVEGACION = { raiz: "home", pantallas: ["home", "prefs", "calendar", "settings", "responsable", "datos-servicio", "residentes"] };

const AppCtx = createContext(null);
function useApp() { return useContext(AppCtx); }
window.useApp = useApp; // las pantallas .jsx no pueden `import` este módulo (decisión C-1); se exponen así

function App() {
  const [auth, setAuth] = useState(() => getSession());
  // «¿Está la app pintando una sesión?» lo responde este estado, no el almacén: desde S-8
  // `getSession()` descarta un token caducado, así que con la app abierta más de 12 h devolvía null
  // mientras la pantalla seguía siendo de alguien. Las guardas que miraban el almacén fallaban justo
  // entonces: `onSessionInvalid` no volvía al login (cada pantalla se quedaba con su error) y «atrás»
  // dejaba de funcionar (2026-10-07). Se lee en un ref porque lo usan callbacks creados una vez.
  const authRef = React.useRef(auth);
  authRef.current = auth;
  const [residentes, setResidentes] = useState([]);
  // Los que tienen una fecha ilegible en la hoja (client/lib/residentes.js): apartados de
  // `residentes` para que ninguna pantalla reviente al derivar su nivel, y nombrados en un aviso.
  const [residentesIlegibles, setResidentesIlegibles] = useState([]);
  const [residentesError, setResidentesError] = useState(null);
  const [loading, setLoading] = useState(false);
  // Tras una recarga, la pantalla en la que estaba (la guarda el historial: client/lib/navegacion.js);
  // solo con sesión —sin ella se enseña el login, y la entrada se desapila al montar—.
  const [tab, setTabRaw] = useState(() => (auth && pantallaGuardada(window.history, NAVEGACION)) || "home");
  // Celdas sin guardar del cuadrante (lo escribe Calendar.jsx) y preferencias sin guardar (el
  // nombre del mes, p. ej. "octubre de 2026", o null; lo escribe Prefs.jsx): cambiar de pestaña,
  // ir atrás o cerrar sesión desmonta esa pantalla y los perdería en silencio, así que se pregunta.
  const cambiosSinGuardarRef = React.useRef(0);
  const prefsSinGuardarRef = React.useRef(null);
  const confirmaPerderCambios = () => {
    if (cambiosSinGuardarRef.current !== 0
      && !window.confirm(`Tienes ${cambiosSinGuardarRef.current} cambios sin guardar en el cuadrante. ¿Salir y perderlos?`)) return false;
    if (prefsSinGuardarRef.current
      && !window.confirm(`Tienes cambios sin guardar en tus preferencias de ${prefsSinGuardarRef.current}. ¿Salir y perderlos?`)) return false;
    return true;
  };
  // La pestaña YA activa no se «abandona»: sin esta guarda, pulsar «Cuadrante» estando en el
  // cuadrante preguntaba «¿Salir y perderlos?» sin salir, y al aceptar ponía el contador a 0 con la
  // pantalla aún montada —así que el siguiente cambio de pestaña ya no preguntaba y las celdas se
  // perdían en silencio. El contador lo pone a 0 el propio Calendar.jsx al desmontarse, que es el
  // único momento en que de verdad se pierden. Se actualiza también a mano al cambiar de pantalla:
  // el `popstate` de un «atrás» puede llegar antes de que el efecto haya corrido.
  const tabRef = React.useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  // Historial del navegador (client/lib/navegacion.js): Inicio es la raíz y cada cambio de pantalla
  // que hace el usuario deja una entrada —o desapila, si va a Inicio o a la pantalla anterior—, así
  // que el botón «atrás» del móvil vuelve a la anterior y, desde Inicio, sale de la app. Ir atrás
  // con cambios sin guardar pregunta lo mismo que cambiar de pestaña; si el usuario se queda,
  // navegacion.js devuelve el historial a la entrada de la pantalla en la que está.
  const navRef = React.useRef(null);
  useEffect(() => {
    const nav = crearNavegacion({
      historial: window.history, ventana: window, ...NAVEGACION,
      // La sesión con la que ha arrancado la app, que es con la que se ha elegido `tab` arriba.
      restaurar: auth !== null,
      alVolver: (t) => {
        // Sin sesión se está en el login: el historial no puede llevar a pantallas de nadie.
        if (!authRef.current) return false;
        if (t === tabRef.current) return true;
        if (!confirmaPerderCambios()) return false;
        tabRef.current = t;
        setTabRaw(t);
        return true;
      },
    });
    navRef.current = nav;
    return () => nav.desmontar();
  }, []);
  // Todo cambio de pantalla que haga el usuario pasa por aquí (nunca por `setTabRaw`), o «atrás» se
  // saltaría esa pantalla.
  const setTab = useCallback((t) => {
    if (t === tabRef.current) return;
    if (!confirmaPerderCambios()) return;
    tabRef.current = t;
    if (navRef.current) navRef.current.ir(t);
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
    prefsSinGuardarRef.current = null;
    tabRef.current = "home";
    setTabRaw("home"); // si no, el siguiente login hereda la pestaña de la sesión anterior
    // Y el historial, igual: se desapila hasta Inicio. Si solo se reescribía la entrada actual, los
    // primeros «atrás» en el login consumían las pantallas de la sesión anterior sin que se viera
    // nada, y quien entrara después caía en una de ellas.
    if (navRef.current) navRef.current.aLaRaiz();
  }, []);
  // El botón de cerrar sesión pregunta si hay cambios sin guardar; la caducidad (abajo) no puede
  // preguntar nada: la sesión ya no sirve y los cambios no se podrían guardar de todas formas.
  const logout = useCallback(() => { if (confirmaPerderCambios()) cerrarSesion(); }, [cerrarSesion]);

  // Sesión rechazada por el servidor (caducada a las 12 h, o firmada con un secreto rotado):
  // antes la app se quedaba en pie enseñando «sesión expirada» en cada pantalla, sin ofrecer
  // volver a entrar. Ahora se cierra y se vuelve al login con el motivo, una sola vez.
  const onSessionInvalid = useCallback(() => {
    if (sesionCaducadaRef.current || !authRef.current) return;
    cerrarSesion();
    sesionCaducadaRef.current = true;
    // Directo, sin `showToast`: es el único aviso que tiene que verse después de cerrar la sesión.
    setToast({ msg: "Tu sesión ha caducado: vuelve a entrar con Google", type: "err" });
    setTimeout(() => setToast(null), 5000);
  }, [cerrarSesion]);

  // Con la sesión en `localStorage` (S-8) todas las pestañas abiertas comparten la misma: cerrar
  // sesión en una tiene que cerrarla en las demás, que si no seguirían pintando la app sin token y
  // fallando en cada petición; y entrar en una deja entrar a las que estaban en el login.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== null && e.key !== CLAVE_SESION) return;
      const s = getSession();
      if (!s) cerrarSesion();
      // Mismo token: nada que hacer. Otro token (entró otra persona en otra pestaña): esta pasa a
      // ser suya, porque las peticiones ya salen con él y la pantalla no puede enseñar a la anterior.
      else setAuth((actual) => (actual && actual.session === s.session ? actual : { session: s.session, residente: s.residente }));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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

  // Perfil de invitado (V-53): solo lectura. El servidor es quien lo impone (`authed`); esto solo
  // decide qué se enseña — sin pestañas de edición ni de ajustes, que de todos modos fallarían.
  const esInvitado = auth?.residente?.rol === "invitado";
  const tabVisible = esInvitado && tab !== "home" && tab !== "calendar" ? "home" : tab;
  const myResidente = residentes.find((r) => r.id === auth?.residente?.id) || null;
  const nivel = myResidente ? levelOn(periodsOfResident(myResidente), todayISO()) : null;
  const grupo = groupOf(nivel);
  const isResponsable = responsableIdServidor !== undefined
    ? responsableIdServidor !== null && responsableIdServidor === auth?.residente?.id
    : auth?.residente?.rol === "responsable";

  const ctx = {
    api, auth, onLoggedIn, logout,
    residentes, residentesIlegibles, residentesError, loadResidentes, myResidente, nivel, grupo, isResponsable, actualizaResponsable, esInvitado,
    loading, setLoading, showToast, cambiosSinGuardarRef, prefsSinGuardarRef,
    tab, setTab, mes, setMes, anio, setAnio,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: COLOR.gray }}>
        <Header />
        <div key={!auth ? "login" : tabVisible} className="gapp-rise" style={{ flex: 1, padding: "0 0 80px" }}>
          {!auth ? React.createElement(window.Screens.Login) :
            tabVisible === "home" ? React.createElement(window.Screens.Home) :
            tabVisible === "prefs" ? React.createElement(window.Screens.Prefs) :
            tabVisible === "calendar" ? React.createElement(window.Screens.Calendar) :
            tabVisible === "settings" ? React.createElement(window.Screens.Settings) :
            tabVisible === "responsable" ? React.createElement(window.Screens.Responsable) :
            tabVisible === "datos-servicio" ? React.createElement(window.Screens.DatosServicio) :
            tabVisible === "residentes" ? React.createElement(window.Screens.Residentes) : null}
        </div>
        {auth && <BottomNav />}
        {toast && <window.UI.Toast msg={toast.msg} type={toast.type} />}
      </div>
    </AppCtx.Provider>
  );
}

function Header() {
  const { auth, logout, setTab, isResponsable, esInvitado } = useApp();
  return (
    <div style={{ background: COLOR.blueDark, color: "#fff", padding: "14px 16px 10px", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.3 }}>🏥 Guardias · Dr. Balmis</div>
          {auth && (
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>
              {auth.residente.nombre}{isResponsable ? " · 📋 Responsable" : ""}{auth.residente.rol === "invitado" ? " · solo lectura" : ""}
            </div>
          )}
        </div>
        {auth && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!esInvitado && <button onClick={() => setTab("settings")} style={S.iconBtn}>⚙️</button>}
            <button onClick={logout} style={S.iconBtn} title="Cerrar sesión">↩️</button>
          </div>
        )}
      </div>
    </div>
  );
}

function BottomNav() {
  const { tab, setTab, esInvitado } = useApp();
  const items = [
    { id: "home", icon: "🏠", label: "Inicio" },
    ...(esInvitado ? [] : [{ id: "prefs", icon: "⚙️", label: "Preferencias" }]),
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

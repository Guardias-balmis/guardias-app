// HomeScreen — dashboard. El nivel R1-R4 de cada residente se DERIVA aquí de sus fechas
// (nunca se lee un campo "ano" almacenado — ese campo no existe ya, spec.md S-2).
import { COLOR, ANOS, ANO_COLORS, ANO_TEXT } from "./client/lib/design-tokens.js";
import { periodsOfResident, levelOn } from "./v2/domain/residents.js";
import { todayISO } from "./client/lib/dates.js";
import { S } from "./client/lib/design-tokens.js";
import { puedeMoverCiclo } from "./client/lib/permisos.js";

const { useState, useEffect } = React;
const { Card, QuickCard, Btn } = window.UI;

// `periodsOfResident` y no `defaultTrainingPeriods`: es la derivación única del dominio (V-24) y
// la ÚNICA que respeta los periodos editados de la nota [a]. Con `defaultTrainingPeriods` directo,
// esta pantalla mostraría un nivel distinto del que juzga el validador.
function nivelDe(residente) {
  return levelOn(periodsOfResident(residente), todayISO());
}


/**
 * Imaginaria (INV-13, decisión V-20). Vive en Inicio porque es lo que hace falta a las ocho de
 * la mañana con una baja de última hora: a quién llamar, por orden. La cola se DERIVA en el
 * dominio del historial de coberturas — aquí no hay ninguna regla, solo se enseña.
 *
 * Leerla está abierto a cualquiera (cualquiera puede recibir la llamada); registrar quién cubrió
 * usa el permiso del ciclo, y el botón solo se ofrece a quien lo tiene. El servidor lo vuelve a
 * comprobar de todos modos.
 */
function Imaginaria({ api, residentes, showToast, puedoRegistrar }) {
  const [grupo, setGrupo] = useState("PEQUENO");
  const [fecha, setFecha] = useState(todayISO());
  const [cola, setCola] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const cargar = async () => {
    setBusy(true);
    const r = await api.colaImaginaria(grupo, fecha);
    setBusy(false);
    if (r.ok) { setCola(r.cola); setError(null); } else { setCola(null); setError(r.error); }
  };
  useEffect(() => { setCola(null); setError(null); }, [grupo, fecha]);

  const nombre = (id) => (residentes.find((r) => r.id === id) || {}).nombre || id;
  const registrar = async (residenteId) => {
    setBusy(true);
    const r = await api.registrarImaginaria(grupo, fecha, residenteId);
    setBusy(false);
    if (r.ok) { showToast(`${nombre(residenteId)} cubrió la imaginaria ✓`); cargar(); }
    else showToast(r.error, "err");
  };

  return (
    <Card title="🚨 Imaginaria">
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        Si una incidencia deja una guardia sin cubrir, se busca a alguien de la lista del grupo al
        que pertenece. El orden lo lleva la app: primero quien lleve más tiempo sin cubrir una.
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={S.label}>Grupo</label>
          <select value={grupo} onChange={(e) => setGrupo(e.target.value)}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }}>
            <option value="PEQUENO">Pequeños (R2)</option>
            <option value="MAYOR">Mayores (R3-R4)</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={S.label}>Día de la incidencia</label>
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
        </div>
      </div>
      <Btn onClick={cargar} disabled={busy} color={COLOR.gray} textColor={COLOR.blueDark}>
        {busy ? "Consultando…" : "¿A quién le toca?"}
      </Btn>

      {error && <div style={{ fontSize: 13, color: COLOR.red, marginTop: 10 }}>{error}</div>}
      {cola && cola.length === 0 && (
        <div style={{ fontSize: 13, color: COLOR.grayDark, marginTop: 10, fontStyle: "italic" }}>
          No hay nadie en la lista de ese grupo para esa fecha.
        </div>
      )}
      {cola && cola.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          {cola.map((x, i) => (
            <div key={x.residenteId} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              background: x.apartadoPor ? COLOR.gray : COLOR.bluePale,
              borderLeft: `4px solid ${x.apartadoPor ? COLOR.grayMid : COLOR.blue}`,
              borderRadius: 8, padding: "8px 10px", opacity: x.apartadoPor ? 0.7 : 1,
            }}>
              <div style={{ fontSize: 13, color: x.apartadoPor ? COLOR.grayDark : COLOR.blueDark }}>
                <b>{x.apartadoPor ? "—" : `${i + 1}.`} {nombre(x.residenteId)}</b>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  {x.apartadoPor
                    ? `No se le llama: ${x.apartadoPor}`
                    : x.ultimaCobertura ? `Última imaginaria: ${x.ultimaCobertura}` : "Nunca ha cubierto"}
                </div>
              </div>
              {puedoRegistrar && !x.apartadoPor && (
                <button onClick={() => registrar(x.residenteId)} disabled={busy}
                  style={{ ...S.smallBtn, background: "#fff", color: COLOR.blue, flexShrink: 0 }}>Cubrió</button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HomeScreen() {
  const app = window.useApp();
  const { auth, residentes, myResidente, nivel, setTab } = app;

  // Invitación al voluntariado del PRÓXIMO mandato de Responsable (decisión V-16). Se pide aparte
  // y sin bloquear la pantalla: si falla, Inicio se muestra igual sin la tarjeta. Solo aparece
  // para quien puede actuar de verdad —elegible, mandato sin decidir y no ofrecido aún—, así que
  // se apaga sola en cuanto se ofrece o se decide: un aviso que no se puede atender es ruido.
  const [proximoMandato, setProximoMandato] = useState(null);
  const [sinResponsable, setSinResponsable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hoy = new Date();
      const [r, rEstado] = await Promise.all([
        app.api.estadoResponsable(hoy.getUTCFullYear()),
        app.api.estadoCuadrante(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1),
      ]);
      if (cancelled) return;
      if (r.ok) setProximoMandato(r.siguiente || null);
      // Un fallo aquí solo esconde el botón de registrar la imaginaria: no se asume el permiso.
      setSinResponsable(rEstado.ok ? rEstado.sinResponsable === true : false);
    })();
    return () => { cancelled = true; };
  }, [myResidente?.id]);
  const puedoRegistrarImaginaria = puedeMoverCiclo({ isResponsable: app.isResponsable, grupo: app.grupo, sinResponsable });
  const puedoOfrecerme = proximoMandato && !proximoMandato.mandato
    && proximoMandato.elegibles.includes(myResidente?.id) && !proximoMandato.meHeOfrecido;
  const hoy = new Date();
  const nombreMes = hoy.toLocaleDateString("es-ES", { month: "long", year: "numeric" });

  // Agrupa por nivel derivado (no por un campo almacenado).
  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  for (const r of residentes) {
    const n = nivelDe(r);
    if (porNivel[n]) porNivel[n].push(r);
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, margin: "0 auto" }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 48, height: 48, borderRadius: 24, background: COLOR.blue, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 20, fontWeight: 700 }}>
            {auth.residente.nombre?.[0]}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: COLOR.blueDark }}>
              Hola, {auth.residente.nombre?.split(" ")[0]} 👋
            </div>
            {myResidente && nivel && (
              <div style={{ fontSize: 13, color: COLOR.grayDark, marginTop: 2 }}>
                <span style={{ background: ANO_COLORS[nivel], color: ANO_TEXT[nivel], padding: "2px 8px", borderRadius: 6, fontWeight: 700, fontSize: 12 }}>
                  {nivel}
                </span>
                {" · "}{myResidente.nombre}
              </div>
            )}
          </div>
        </div>
      </Card>

      {puedoOfrecerme && (
        <Card title={`🙋 Responsable del contaje ${proximoMandato.anio}`}>
          <div style={{ fontSize: 13, color: COLOR.grayDark, marginBottom: 10 }}>
            El mandato de {proximoMandato.anio} (enero a enero) todavía no tiene a nadie y tú eres
            elegible. Si nadie se ofrece, se decide por sorteo entre todos los R3.
          </div>
          <button onClick={() => setTab("responsable")} style={{ background: COLOR.blue, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Ofrecerme voluntario →
          </button>
        </Card>
      )}

      <Card title="📅 Mes en curso">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>{nombreMes}</div>
          <button onClick={() => setTab("calendar")} style={{ background: COLOR.blue, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Ver cuadrante</button>
        </div>
        <div style={{ fontSize: 13, color: COLOR.grayDark }}>Residentes activos: {residentes.length}</div>
      </Card>

      <Card title="⚙️ Mis preferencias del mes">
        <div style={{ fontSize: 13, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          Registra tus días no disponibles, vacaciones y preferencias.
        </div>
        <button onClick={() => setTab("prefs")} style={{ background: COLOR.blue, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Editar preferencias →
        </button>
      </Card>

      <Card title="👥 Equipo">
        {ANOS.map((n) => (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ background: ANO_COLORS[n], color: ANO_TEXT[n], padding: "2px 8px", borderRadius: 6, fontWeight: 700, fontSize: 12, minWidth: 32, textAlign: "center" }}>{n}</span>
            <span style={{ fontSize: 13, color: COLOR.blueDark }}>
              {porNivel[n].map((r) => r.nombre.split(" ")[0]).join(", ") || "—"}
            </span>
          </div>
        ))}
      </Card>

      <Imaginaria api={app.api} residentes={residentes} showToast={app.showToast} puedoRegistrar={puedoRegistrarImaginaria} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <QuickCard icon="🤖" label="Generar cuadrante" onClick={() => setTab("generator")} color={COLOR.blue} />
        <QuickCard icon="📊" label="Ver cuadrante completo" onClick={() => setTab("calendar")} color={COLOR.greenMid} />
      </div>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Home = HomeScreen;

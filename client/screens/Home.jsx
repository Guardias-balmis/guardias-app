// HomeScreen — dashboard. El nivel R1-R4 de cada residente se DERIVA aquí de sus fechas
// (nunca se lee un campo "ano" almacenado — ese campo no existe ya, spec.md S-2).
import { COLOR, ANOS, ANO_COLORS, ANO_TEXT } from "../lib/design-tokens.js";
import { defaultTrainingPeriods, levelOn } from "../../v2/domain/residents.js";
import { addDays, addYears } from "../../v2/domain/calendar.js";
import { todayISO } from "../lib/dates.js";

const { Card, QuickCard } = window.UI;

function nivelDe(residente) {
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return levelOn(defaultTrainingPeriods(residente.fechaInicio, fin), todayISO());
}

function HomeScreen() {
  const app = window.useApp();
  const { auth, residentes, myResidente, nivel, setTab } = app;
  const hoy = new Date();
  const nombreMes = hoy.toLocaleDateString("es-ES", { month: "long", year: "numeric" });

  // Agrupa por nivel derivado (no por un campo almacenado).
  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  for (const r of residentes) {
    const n = nivelDe(r);
    if (porNivel[n]) porNivel[n].push(r);
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <QuickCard icon="🤖" label="Generar cuadrante" onClick={() => setTab("generator")} color={COLOR.blue} />
        <QuickCard icon="📊" label="Ver cuadrante completo" onClick={() => setTab("calendar")} color={COLOR.greenMid} />
      </div>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Home = HomeScreen;

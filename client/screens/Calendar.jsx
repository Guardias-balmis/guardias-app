// CalendarScreen — cuadrante mensual editable (app.mes/app.anio, COMPARTIDO con
// PrefsScreen: no se crea un selector de mes propio aquí). Guarda por residenteId,
// nunca por nombre (bug del v1); datesOfMonth/weekday para todo el cálculo de fechas
// (nunca `new Date(anio, mes, ...)` a mano, para no reintroducir el desfase de mes).
import { COLOR, S, ANOS, ANO_COLORS, ANO_TEXT, CODE_COLORS, CODE_LABELS, CODES_CYCLE, pillBtn } from "../lib/design-tokens.js";
import { defaultTrainingPeriods, levelOn } from "../../v2/domain/residents.js";
import { datesOfMonth, weekday, isWeekend, addDays, addYears } from "../../v2/domain/calendar.js";
import { tally } from "../../v2/domain/tally.js";
import { validateMonth } from "../../v2/domain/validate.js";
import { todayISO } from "../lib/dates.js";

const { useState, useEffect } = React;
const { Card } = window.UI;

function nivelDe(residente) {
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return levelOn(defaultTrainingPeriods(residente.fechaInicio, fin), todayISO());
}

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function CalendarScreen() {
  const app = window.useApp();
  const { anio, mes, setAnio, setMes, residentes, showToast } = app;

  const [asignaciones, setAsignaciones] = useState({}); // {[residenteId]: {[fecha]: codigo}}
  const [pendientes, setPendientes] = useState({});     // {[residenteId+"|"+fecha]: {fecha,residenteId,codigo}}
  const [guardando, setGuardando] = useState(false);
  const [violaciones, setViolaciones] = useState(null); // null = aún no validado

  useEffect(() => {
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      const r = await app.api.listAsignaciones(anio, mes);
      if (cancelled) return;
      if (r.ok) {
        const idx = {};
        for (const a of r.asignaciones) {
          if (!idx[a.residenteId]) idx[a.residenteId] = {};
          idx[a.residenteId][a.fecha] = a.codigo;
        }
        setAsignaciones(idx);
      } else {
        showToast("Error cargando cuadrante: " + r.error, "err");
      }
      setPendientes({});
      setViolaciones(null);
      app.setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes]);

  const prevMonth = () => {
    if (mes === 1) { setMes(12); setAnio(anio - 1); } else setMes(mes - 1);
  };
  const nextMonth = () => {
    if (mes === 12) { setMes(1); setAnio(anio + 1); } else setMes(mes + 1);
  };

  const dias = datesOfMonth(anio, mes);
  const monthWindow = { start: dias[0], end: dias[dias.length - 1] };

  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  for (const r of residentes) {
    const n = nivelDe(r);
    if (porNivel[n]) porNivel[n].push(r);
  }

  const asignacionesDe = (residenteId) => {
    const porFecha = asignaciones[residenteId] || {};
    return Object.entries(porFecha).map(([fecha, codigo]) => ({ fecha, codigo }));
  };

  const cicla = (residenteId, fecha) => {
    const actual = (asignaciones[residenteId] || {})[fecha] || "";
    const siguiente = CODES_CYCLE[(CODES_CYCLE.indexOf(actual) + 1) % CODES_CYCLE.length];
    setAsignaciones((prev) => ({ ...prev, [residenteId]: { ...(prev[residenteId] || {}), [fecha]: siguiente } }));
    setPendientes((prev) => ({ ...prev, [`${residenteId}|${fecha}`]: { fecha, residenteId, codigo: siguiente } }));
    setViolaciones(null);
  };

  const cambios = Object.values(pendientes);

  const guardar = async () => {
    if (cambios.length === 0) { showToast("No hay cambios que guardar"); return; }
    setGuardando(true);
    const r = await app.api.guardarAsignaciones(cambios);
    setGuardando(false);
    if (r.ok) {
      setPendientes({});
      showToast("Cuadrante guardado ✓");
    } else {
      showToast("Error guardando: " + r.error, "err");
    }
  };

  const validar = () => {
    const ctx = {
      mes, anio,
      residentes: residentes.map((r) => ({ id: r.id, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin })),
      asignaciones: residentes.flatMap((r) => asignacionesDe(r.id).map((a) => ({ residenteId: r.id, fecha: a.fecha, codigo: a.codigo }))),
    };
    setViolaciones(validateMonth(ctx));
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button style={S.navBtn} onClick={prevMonth}>◀</button>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>{nombreMesDe(anio, mes)}</div>
          <button style={S.navBtn} onClick={nextMonth}>▶</button>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button style={pillBtn(COLOR.blue)} onClick={guardar} disabled={guardando}>
            {guardando ? "Guardando…" : `💾 Guardar${cambios.length ? ` (${cambios.length})` : ""}`}
          </button>
          <button style={pillBtn(COLOR.greenMid)} onClick={validar}>✅ Validar</button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", minWidth: 220 + dias.length * 32, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>Nivel</th>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>Nombre</th>
                <th style={{ ...S.th, background: COLOR.gray, color: COLOR.blueDark }}>G</th>
                {dias.map((fecha) => {
                  const wknd = isWeekend(fecha);
                  return (
                    <th key={fecha} style={{ ...S.th, background: wknd ? COLOR.greenLight : COLOR.gray, color: wknd ? COLOR.green : COLOR.cellText }}>
                      <div>{Number(fecha.slice(8, 10))}</div>
                      <div style={{ fontSize: 10, fontWeight: 400 }}>{weekday(fecha)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ANOS.map((nivel) => porNivel[nivel].map((r) => {
                const porFecha = asignaciones[r.id] || {};
                const total = tally(asignacionesDe(r.id), monthWindow).total;
                return (
                  <tr key={r.id}>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 700, background: ANO_COLORS[nivel], color: ANO_TEXT[nivel] }}>{nivel}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", fontWeight: 600, color: COLOR.blueDark }}>{r.nombre.split(" ")[0]}</td>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: COLOR.blue }}>{total}</td>
                    {dias.map((fecha) => {
                      const codigo = porFecha[fecha] || "";
                      return (
                        <td key={fecha} onClick={() => cicla(r.id, fecha)} style={{
                          ...S.td, textAlign: "center", cursor: "pointer", userSelect: "none",
                          background: CODE_COLORS[codigo] || "transparent",
                          fontWeight: codigo ? 700 : 400, color: COLOR.cellText,
                        }}>{codigo || "·"}</td>
                      );
                    })}
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      </Card>

      {violaciones !== null && (
        <Card title="Resultado de validación">
          {violaciones.length === 0 ? (
            <div style={{ color: COLOR.green, fontWeight: 700, fontSize: 14 }}>✅ Sin violaciones</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {errores.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.red, marginBottom: 6 }}>⛔ Errores ({errores.length}) — bloquean la publicación</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {errores.map((v, i) => (
                      <div key={i} style={{ fontSize: 12, color: COLOR.red, background: COLOR.redLight, borderRadius: 6, padding: "4px 8px" }}>
                        [{v.invariante}] {v.detalle}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {avisos.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, marginBottom: 6 }}>⚠️ Avisos ({avisos.length}) — informativos</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {avisos.map((v, i) => (
                      <div key={i} style={{ fontSize: 12, color: COLOR.orange, background: COLOR.orangeLight, borderRadius: 6, padding: "4px 8px" }}>
                        [{v.invariante}] {v.detalle}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="Leyenda">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {Object.keys(CODE_LABELS).map((code) => (
            <div key={code} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: CODE_COLORS[code], border: `1px solid ${COLOR.grayMid}`, display: "inline-block" }} />
              <span style={{ fontSize: 12, color: COLOR.grayDark }}>{code} · {CODE_LABELS[code]}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Calendar = CalendarScreen;

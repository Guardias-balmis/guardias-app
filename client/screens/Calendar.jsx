// CalendarScreen — cuadrante mensual editable (app.mes/app.anio, COMPARTIDO con
// PrefsScreen: no se crea un selector de mes propio aquí). Guarda por residenteId,
// nunca por nombre (bug del v1); datesOfMonth/weekday para todo el cálculo de fechas
// (nunca `new Date(anio, mes, ...)` a mano, para no reintroducir el desfase de mes).
import { COLOR, S, ANOS, ANO_COLORS, ANO_TEXT, CODE_COLORS, CODE_LABELS, CODES_CYCLE, ESTADO_CUADRANTE, pillBtn } from "./client/lib/design-tokens.js";
import { defaultTrainingPeriods, levelOn } from "./v2/domain/residents.js";
import { datesOfMonth, weekday, isWeekend, addDays, addYears } from "./v2/domain/calendar.js";
import { tally } from "./v2/domain/tally.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "./v2/domain/validate.js";
import { canEdit, canValidate, canPublish, canUnpublish, stateAfterEdit } from "./v2/domain/cuadrante.js";
import { todayISO } from "./client/lib/dates.js";
import { closeViolations } from "./client/lib/closes.js";
import { violationText } from "./client/lib/violations.js";

const { useState, useEffect } = React;
const { Card, Btn, Aviso } = window.UI;

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
  const { anio, mes, setAnio, setMes, residentes, showToast, isResponsable } = app;

  const [asignaciones, setAsignaciones] = useState({}); // {[residenteId]: {[fecha]: codigo}}
  const [pendientes, setPendientes] = useState({});     // {[residenteId+"|"+fecha]: {fecha,residenteId,codigo}}
  const [guardando, setGuardando] = useState(false);
  const [validando, setValidando] = useState(false);
  const [violaciones, setViolaciones] = useState(null); // null = aún no validado
  const [estado, setEstado] = useState("BORRADOR");
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  // Si estadoCuadrante falla (red, sesión) NO se asume BORRADOR: un mes realmente PUBLICADO
  // parecería editable por error. Mientras estadoError esté activo se bloquea la edición igual
  // que si estuviera PUBLICADO, y se muestra un aviso con reintento (mismo patrón que Generator.jsx).
  const [estadoError, setEstadoError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const busy = guardando || validando || cambiandoEstado;
  const bloqueadoPorPublicado = !canEdit(estado) || estadoError;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      app.setLoading(true);
      const [r, rEstado] = await Promise.all([app.api.listAsignaciones(anio, mes), app.api.estadoCuadrante(anio, mes)]);
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
      setEstadoError(!rEstado.ok);
      if (rEstado.ok) setEstado(rEstado.estado); // en error se conserva el último estado conocido; estadoError ya bloquea la edición
      else showToast("Error comprobando el estado del cuadrante: " + rEstado.error, "err");
      setPendientes({});
      setViolaciones(null);
      app.setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [anio, mes, retryTick]);

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
    // Bloqueado mientras validando: validar() encadena dos peticiones de red y resuelve
    // contra el `asignaciones` capturado por closure al empezar — una edición a mitad de
    // esa ventana quedaría silenciosamente ignorada por el resultado que llegue después. Por
    // el mismo motivo, bloqueado mientras guardando: si se edita a mitad de un guardado en
    // vuelo, el `setPendientes({})` al terminar ese guardado borraría la edición nueva sin
    // haberla enviado nunca (pérdida de datos invisible — la celda seguiría mostrando el
    // valor nuevo, pero el servidor nunca lo recibió).
    // Bloqueado también si el mes está PUBLICADO (decisión V-9b): el servidor ya lo rechaza
    // en guardarAsignaciones, esto solo evita que la celda parezca editable en la UI.
    if (busy || bloqueadoPorPublicado) return;
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
      // Editar un mes VALIDADO lo revierte a BORRADOR en el servidor (Fase 6.2) — se refleja
      // aquí sin otra petición, con la misma regla de dominio que aplicó el servidor.
      setEstado(stateAfterEdit(estado));
      showToast("Cuadrante guardado ✓");
    } else {
      showToast("Error guardando: " + r.error, "err");
    }
  };

  const validar = async () => {
    setValidando(true);
    // INV-5/6/7 dependen de los bloqueos de TODO el equipo (vacaciones/rotación/baja), no
    // solo de quien pulsa Validar — listBloqueos (a diferencia de misBloqueos) los trae
    // todos. Desde la decisión V-8, solo BAJA bloquea la asignación (INV-5); VACACIONES y
    // ROTACION siguen alimentando INV-6/7 sin bloquear.
    const rBloqueos = await app.api.listBloqueos(anio, mes);
    if (!rBloqueos.ok) { setValidando(false); setViolaciones(null); showToast("Error cargando bloqueos para validar: " + rBloqueos.error, "err"); return; }
    const bloqueos = rBloqueos.bloqueos;

    // Contrato C-2 (spec.md §5): INV-7 evalúa la rotación cercana solo en el mes en que
    // TERMINA, pero necesita las guardias del residente de TODO el periodo — que puede
    // empezar en un mes anterior al validado. listAsignaciones (arriba, en el useEffect)
    // solo trae el mes en curso, así que faltaba el histórico si la rotación cruzaba mes.
    const monthStart = monthWindow.start;
    const desdeRotacion = rotationHistoryStart(bloqueos, monthStart);
    let historicas = [];
    if (desdeRotacion) {
      const rHist = await app.api.listAsignacionesRango(desdeRotacion, addDays(monthStart, -1));
      if (!rHist.ok) { setValidando(false); setViolaciones(null); showToast("Error cargando histórico de rotación: " + rHist.error, "err"); return; }
      historicas = rHist.asignaciones;
    }

    const asignacionesDelMes = residentes.flatMap((r) => asignacionesDe(r.id).map((a) => ({ residenteId: r.id, fecha: a.fecha, codigo: a.codigo })));
    const ctx = buildMonthContext({ mes, anio, residentes, historicas, asignacionesDelMes, bloqueos });

    // Cierres de equidad de INV-3 (P-8, decisión V-13): el trimestral en ago/nov/feb/may y el
    // anual en el mes del aniversario de alguien. Es la MISMA comprobación que hará el
    // servidor en marcarValidado; si falla la carga no se sigue, porque un cierre no
    // comprobado en silencio es peor que no validar (el anual es error y bloquea).
    const rCierres = await closeViolations({ api: app.api, mes, anio, residentes, asignacionesDelMes });
    if (!rCierres.ok) { setValidando(false); setViolaciones(null); showToast("Error comprobando los cierres de equidad: " + rCierres.error, "err"); return; }

    const v = [...validateMonth(ctx), ...rCierres.violaciones];
    setViolaciones(v);

    // Decisión de Fase 6.2 (V-9/V-10): BORRADOR->VALIDADO es automático en cuanto el
    // Responsable en mandato valida sin errores — sin botón aparte. El servidor revalida
    // por su cuenta (nunca confía en `v`) y es quien de verdad decide si persiste el estado.
    // `cambios.length === 0` es imprescindible: si hay ediciones sin guardar, lo que ve el
    // cliente (con la edición) puede diferir de lo que el servidor validaría (sin ella) —
    // publicar en ese hueco fijaría datos que nunca reflejaron lo que la pantalla mostraba.
    if (canValidate(v) && isResponsable && estado !== "PUBLICADO" && cambios.length === 0) {
      const rVal = await app.api.marcarValidado(anio, mes);
      if (rVal.ok) { setEstado(rVal.estado); showToast("Cuadrante VALIDADO ✓"); }
      // Si el servidor lo rechaza (discrepancia con lo que ve el cliente) no se pisa la vista
      // de violaciones, que ya se mostró arriba con el resultado local — pero SÍ se dice: sin
      // el aviso, el cuadrante se quedaba en BORRADOR sin que nadie supiera por qué.
      else showToast("El servidor no validó el cuadrante: " + rVal.error, "err");
    }
    setValidando(false);
  };

  const publicar = async () => {
    setCambiandoEstado(true);
    const r = await app.api.publicarCuadrante(anio, mes);
    setCambiandoEstado(false);
    if (r.ok) { setEstado(r.estado); showToast("Cuadrante PUBLICADO ✓"); }
    else showToast("Error publicando: " + r.error, "err");
  };

  const despublicar = async () => {
    setCambiandoEstado(true);
    const r = await app.api.despublicarCuadrante(anio, mes);
    setCambiandoEstado(false);
    if (r.ok) { setEstado(r.estado); showToast("Cuadrante despublicado — vuelve a VALIDADO"); }
    else showToast("Error despublicando: " + r.error, "err");
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button style={S.navBtn} onClick={prevMonth} disabled={busy}>◀</button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>{nombreMesDe(anio, mes)}</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: ESTADO_CUADRANTE[estado].color, background: ESTADO_CUADRANTE[estado].bg, borderRadius: 8, padding: "2px 10px" }}>
              {ESTADO_CUADRANTE[estado].label}
            </span>
          </div>
          <button style={S.navBtn} onClick={nextMonth} disabled={busy}>▶</button>
        </div>
      </Card>

      {estadoError && (
        <Aviso color={COLOR.red} bg={COLOR.redLight}>
          No se pudo comprobar el estado del cuadrante — no se puede editar hasta reintentar
          (podría estar PUBLICADO sin que esta pantalla lo sepa todavía).
          <div style={{ marginTop: 8 }}>
            <Btn onClick={() => setRetryTick((t) => t + 1)}>🔄 Reintentar</Btn>
          </div>
        </Aviso>
      )}

      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button style={pillBtn(COLOR.blue)} onClick={guardar} disabled={busy || bloqueadoPorPublicado}>
            {guardando ? "Guardando…" : `💾 Guardar${cambios.length ? ` (${cambios.length})` : ""}`}
          </button>
          <button style={pillBtn(COLOR.greenMid)} onClick={validar} disabled={busy}>{validando ? "Validando…" : "✅ Validar"}</button>
          {isResponsable && canPublish(estado) && (
            <button style={pillBtn(COLOR.blueDark)} onClick={publicar} disabled={busy}>
              {cambiandoEstado ? "Publicando…" : "📢 Publicar"}
            </button>
          )}
          {isResponsable && canUnpublish(estado) && (
            <button style={pillBtn(COLOR.orange)} onClick={despublicar} disabled={busy}>
              {cambiandoEstado ? "Despublicando…" : "↩️ Despublicar"}
            </button>
          )}
        </div>
        {!estadoError && bloqueadoPorPublicado && (
          <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
            Este cuadrante está publicado: no se puede editar{isResponsable ? " — usa Despublicar para corregirlo." : "."}
          </div>
        )}

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
                          ...S.td, textAlign: "center", cursor: bloqueadoPorPublicado ? "default" : "pointer", userSelect: "none",
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
                        [{v.invariante}] {violationText(v, residentes)}
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
                        [{v.invariante}] {violationText(v, residentes)}
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

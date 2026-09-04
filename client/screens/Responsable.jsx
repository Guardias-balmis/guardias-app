// ResponsableScreen — Fase 5, INV-14 (spec.md). Mandato enero→enero de un R3 (pasa a R4
// durante el mandato): voluntario > sorteo. Decisión Fase 5: si se ofrecen ≥2 voluntarios,
// se sortea solo entre ellos; sin voluntarios, se sortea entre todo el grupo de R3. El
// sorteo es determinista (semilla+candidatos guardados) — se muestran en pantalla para que
// cualquiera pueda recomputar el resultado (auditable).
import { COLOR, S } from "./client/lib/design-tokens.js";

const { useState, useEffect, useRef } = React;
const { Card, SectionTitle, Btn, Info, Aviso } = window.UI;

function nombreDe(residentes, id) {
  const r = residentes.find((x) => x.id === id);
  return r ? r.nombre : id;
}

function ResponsableScreen() {
  const app = window.useApp();
  const { api, myResidente, residentes, showToast, setTab } = app;
  const [anio, setAnio] = useState(new Date().getUTCFullYear());
  const [estado, setEstado] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [busy, setBusy] = useState(false);

  // La respuesta de un año que llega TARDE no pinta bajo la cabecera de otro: con dos pulsaciones de
  // › seguidas y latencia dispar de Apps Script, los elegibles y el botón de ofrecerse eran los de
  // 2027 bajo el rótulo «Mandato 2028», y «Sortear» habría sorteado el 2028 viendo candidatos del 2027.
  const anioEnPantallaRef = useRef(anio);
  anioEnPantallaRef.current = anio;
  const cargar = async () => {
    const pedido = anio;
    const [rEstado, rHist] = await Promise.all([api.estadoResponsable(pedido), api.listResponsables()]);
    if (pedido !== anioEnPantallaRef.current) return;
    if (rEstado.ok) setEstado(rEstado);
    else showToast("Error cargando el estado del responsable: " + rEstado.error, "err");
    if (rHist.ok) setHistorial(rHist.mandatos);
  };

  useEffect(() => { setEstado(null); cargar(); }, [anio]);

  const accion = async (fn, mensajeOk) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      showToast(mensajeOk);
      cargar();
      // Si el sorteo (o el voluntariado único) acaba de decidir el mandato VIGENTE, el permiso del
      // ciclo en pantalla se actualiza ya: el `rol` del token es del login y el ganador seguía sin
      // botones hasta volver a entrar, aunque el servidor ya le aceptara todo (V-16).
      const hoy = new Date();
      const rEstado = await api.estadoCuadrante(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1);
      if (rEstado.ok && app.actualizaResponsable) app.actualizaResponsable(rEstado.responsableId);
    }
    else showToast("Error: " + r.error, "err");
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, margin: "0 auto" }}>
      <SectionTitle>📋 Responsable del contaje</SectionTitle>

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setAnio((a) => a - 1)} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>‹</button>
          <div style={{ fontSize: 15, fontWeight: 700, color: COLOR.blueDark, textAlign: "center" }}>
            Mandato {anio} → {anio + 1}<br />
            <span style={{ fontSize: 11, fontWeight: 400, color: COLOR.grayDark }}>(1 enero {anio} – 1 enero {anio + 1})</span>
          </div>
          <button onClick={() => setAnio((a) => a + 1)} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>›</button>
        </div>
      </Card>

      {!estado ? (
        <Aviso>Cargando…</Aviso>
      ) : estado.mandato ? (
        <Card title="Responsable decidido">
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.blueDark }}>
            {nombreDe(residentes, estado.mandato.residenteId)}
          </div>
          <div style={{ fontSize: 13, color: COLOR.grayDark, marginTop: 4 }}>
            Método: {estado.mandato.metodo === "SORTEO" ? "Sorteo" : "Voluntario"}
          </div>
          {estado.mandato.metodo === "SORTEO" && (
            <div style={{ marginTop: 10, fontSize: 12, color: COLOR.grayDark, lineHeight: 1.7 }}>
              <div><b>Candidatos del sorteo:</b> {estado.mandato.candidatos.map((id) => nombreDe(residentes, id)).join(", ")}</div>
              <div><b>Semilla:</b> <code style={{ background: COLOR.gray, padding: "1px 5px", borderRadius: 4 }}>{estado.mandato.semilla}</code></div>
              <div><b>Fecha del sorteo:</b> {estado.mandato.fechaSorteo}</div>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <Info>
              {estado.mandato.metodo === "SORTEO"
                ? "Auditable: con estos candidatos y esta semilla, cualquiera puede recomputar el mismo resultado."
                : "Se asignó directo por ser el único voluntario elegible — no hizo falta sorteo."}
            </Info>
          </div>
        </Card>
      ) : (
        <Card title="Elegibles (nivel R3 a 1 de enero)">
          {estado.elegibles.length === 0 ? (
            <div style={{ fontSize: 13, color: COLOR.grayDark, fontStyle: "italic" }}>Ningún residente será R3 ese 1 de enero.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {estado.elegibles.map((id) => (
                <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: COLOR.bodyText }}>
                  <span>{nombreDe(residentes, id)}</span>
                  {estado.voluntarios.includes(id) && <span style={{ color: COLOR.blue, fontWeight: 700 }}>🙋 voluntario</span>}
                </div>
              ))}
            </div>
          )}

          {estado.elegibles.includes(myResidente?.id) && (
            estado.meHeOfrecido ? (
              <Btn onClick={() => accion(() => api.retirarVoluntariadoResponsable(anio), "Voluntariado retirado")} disabled={busy} color={COLOR.gray} textColor={COLOR.red}>
                Retirar mi voluntariado
              </Btn>
            ) : (
              <Btn onClick={() => accion(() => api.ofrecerseResponsable(anio), "Te has ofrecido voluntario ✓")} disabled={busy}>
                🙋 Ofrecerme voluntario
              </Btn>
            )
          )}

          {estado.elegibles.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Btn onClick={() => accion(() => api.ejecutarSorteoResponsable(anio), "Responsable decidido ✓")} disabled={busy} color={COLOR.blueDark}>
                {estado.voluntarios.length >= 2 ? "🎲 Sortear entre los voluntarios"
                  : estado.voluntarios.length === 1 ? "Asignar al voluntario (sin sorteo)"
                  : "🎲 Sortear entre todos los R3"}
              </Btn>
            </div>
          )}
        </Card>
      )}

      {/* `estado?.` y no `estado.`: este bloque es hermano del ternario de arriba, no está dentro,
          así que en el PRIMER render (`estado === null`, antes de que cargue `estadoResponsable`)
          se evaluaba igual y lanzaba. Y una excepción en render desmonta el árbol entero: la
          pantalla se quedaba en blanco para siempre, no un instante. Entró con V-16, que es lo que
          añadió el bloque del próximo mandato. */}
      {estado?.siguiente && !estado.siguiente.mandato && (
        <Card title={`🙋 Próximo mandato (${estado.siguiente.anio} → ${estado.siguiente.anio + 1})`}>
          <div style={{ fontSize: 13, color: COLOR.grayDark, marginBottom: 10 }}>
            Todavía sin decidir. Se decide ANTES de que empiece (1 de enero de {estado.siguiente.anio}), así que el
            voluntariado está abierto desde ya.
            {estado.siguiente.voluntarios.length > 0 && (
              <> Se han ofrecido: <b>{estado.siguiente.voluntarios.map((id) => nombreDe(residentes, id)).join(", ")}</b>.</>
            )}
          </div>
          {estado.siguiente.elegibles.includes(myResidente?.id) ? (
            estado.siguiente.meHeOfrecido ? (
              <Btn onClick={() => accion(() => api.retirarVoluntariadoResponsable(estado.siguiente.anio), "Voluntariado retirado")} disabled={busy} color={COLOR.gray} textColor={COLOR.red}>
                Retirar mi voluntariado de {estado.siguiente.anio}
              </Btn>
            ) : (
              <Btn onClick={() => accion(() => api.ofrecerseResponsable(estado.siguiente.anio), `Te has ofrecido voluntario para ${estado.siguiente.anio} ✓`)} disabled={busy}>
                🙋 Ofrecerme voluntario para {estado.siguiente.anio}
              </Btn>
            )
          ) : (
            <div style={{ fontSize: 12, color: COLOR.grayDark, fontStyle: "italic" }}>
              Tú no eres elegible para ese periodo (hay que tener nivel R3 el 1 de enero de {estado.siguiente.anio}).
              Elegibles: {estado.siguiente.elegibles.length ? estado.siguiente.elegibles.map((id) => nombreDe(residentes, id)).join(", ") : "ninguno todavía"}.
            </div>
          )}
        </Card>
      )}

      <Info>
        Normativa: el contaje recae en un R3 de enero a enero (pasa a R4 durante el mandato).
        Se decide por voluntario; si se ofrecen dos o más, se sortea solo entre ellos (Fase 5); si
        nadie se ofrece, se sortea entre todos los R3 elegibles. El sorteo es determinista:
        guardando semilla y candidatos, el resultado es recomputable por cualquiera.
      </Info>

      {historial.length > 0 && (
        <Card title="Historial de responsables">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {historial.map((m) => (
              <div key={m.periodoInicio} style={{ fontSize: 13, display: "flex", justifyContent: "space-between", color: COLOR.bodyText }}>
                <span>{m.periodoInicio.slice(0, 4)}</span>
                <span>{nombreDe(residentes, m.residenteId)} ({m.metodo === "SORTEO" ? "sorteo" : "voluntario"})</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Btn onClick={() => setTab("settings")} color={COLOR.grayMid} textColor={COLOR.blueDark}>← Volver a Ajustes</Btn>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Responsable = ResponsableScreen;

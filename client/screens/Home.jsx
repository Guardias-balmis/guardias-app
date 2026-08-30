// HomeScreen — dashboard. El nivel R1-R4 de cada residente se DERIVA aquí de sus fechas
// (nunca se lee un campo "ano" almacenado — ese campo no existe ya, spec.md S-2).
import { COLOR, ANOS, ANO_COLORS, ANO_TEXT } from "./client/lib/design-tokens.js";
import { periodsOfResident, levelOn } from "./v2/domain/residents.js";
import { todayISO } from "./client/lib/dates.js";
import { S } from "./client/lib/design-tokens.js";
import { puedeMoverCiclo, puedeGenerarCuadrante } from "./client/lib/permisos.js";
import { violationText } from "./client/lib/violations.js";

const { useState, useEffect } = React;
const { Card, QuickCard, Btn } = window.UI;

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const nombreDeMes = (anio, mes) => `${MESES[mes]} de ${anio}`;

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

/**
 * Generador de cuadrante con IA (decisión V-43). Vive en Inicio y NO en una pantalla propia: es
 * una acción, no una sección — se pulsa tres o cuatro veces al año, cuando toca montar el mes.
 *
 * Aquí no hay ni una regla de negocio. El servidor le pide el cuadrante al modelo, lo juzga con el
 * validador de siempre y solo escribe si pasa; esta tarjeta enseña el resultado. Lo único que
 * decide es a QUIÉN se le ofrece el botón (`puedeGenerarCuadrante`), y el servidor lo vuelve a
 * comprobar de todas formas.
 *
 * Los dos pasos (pulsar → confirmar) no son ceremonia: generar REEMPLAZA el cuadrante del mes, así
 * que un click de más sobre un mes ya montado a mano se lleva por delante el trabajo de una tarde.
 */
function GeneradorIA({ api, residentes, mes, anio, setMes, setAnio, puedo, verCuadrante }) {
  const [confirmando, setConfirmando] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [resultado, setResultado] = useState(null);

  // Cambiar de mes descarta lo que se estuviera enseñando: un resultado de agosto bajo el rótulo
  // de septiembre es peor que no enseñar nada.
  useEffect(() => { setResultado(null); setConfirmando(false); }, [mes, anio]);

  if (!puedo) return null;

  const mover = (delta) => {
    const m = mes + delta;
    if (m < 1) { setMes(12); setAnio(anio - 1); }
    else if (m > 12) { setMes(1); setAnio(anio + 1); }
    else setMes(m);
  };

  const generar = async () => {
    setConfirmando(false);
    setGenerando(true);
    setResultado(null);
    const r = await api.generarCuadranteIA(anio, mes);
    setGenerando(false);
    setResultado(r);
  };

  const avisos = (resultado && resultado.violaciones) || [];

  return (
    <Card title="🤖 Generar cuadrante de guardias">
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        Le pide el cuadrante completo del mes a la IA con las preferencias y ausencias de todo el
        equipo, y lo comprueba contra las reglas antes de guardarlo. Si no consigue uno que las
        cumpla, no guarda nada.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <button onClick={() => mover(-1)} disabled={generando} style={{ ...S.smallBtn, background: COLOR.gray, color: COLOR.blueDark }}>◀</button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 700, color: COLOR.blueDark, textTransform: "capitalize" }}>
          {nombreDeMes(anio, mes)}
        </div>
        <button onClick={() => mover(1)} disabled={generando} style={{ ...S.smallBtn, background: COLOR.gray, color: COLOR.blueDark }}>▶</button>
      </div>

      {!confirmando && (
        <Btn onClick={() => setConfirmando(true)} disabled={generando} color={COLOR.blue} textColor="#fff">
          {generando ? "Generando… (puede tardar un minuto)" : "Generar cuadrante de guardias"}
        </Btn>
      )}

      {confirmando && (
        <div style={{ background: COLOR.gray, borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 13, color: COLOR.blueDark, marginBottom: 8, lineHeight: 1.5 }}>
            Se va a <b>reemplazar</b> el cuadrante de {nombreDeMes(anio, mes)}: las guardias que ya
            tenga se sustituyen por las nuevas. Las vacaciones, rotaciones y bajas marcadas en la
            rejilla se conservan.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={generar} style={{ ...S.smallBtn, background: COLOR.blue, color: "#fff" }}>Sí, generar</button>
            <button onClick={() => setConfirmando(false)} style={{ ...S.smallBtn, background: "#fff", color: COLOR.blueDark }}>Cancelar</button>
          </div>
        </div>
      )}

      {resultado && resultado.ok && (
        <div style={{ marginTop: 10, background: COLOR.greenLight, borderLeft: `4px solid ${COLOR.greenMid}`, borderRadius: 8, padding: "8px 10px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.blueDark }}>
            ✅ Cuadrante de {nombreDeMes(anio, mes)} generado y guardado
          </div>
          <div style={{ fontSize: 11, color: COLOR.grayDark, marginTop: 2 }}>
            {resultado.intentos === 1 ? "A la primera" : `Tras ${resultado.intentos} intentos`}
            {resultado.borradas > 0 ? ` · se reemplazaron ${resultado.borradas} guardias que ya había` : ""}
            {resultado.modelo ? ` · modelo: ${resultado.modelo}` : ""}
          </div>
          <button onClick={verCuadrante} style={{ ...S.smallBtn, background: "#fff", color: COLOR.blue, marginTop: 8 }}>
            Ver el cuadrante →
          </button>
        </div>
      )}

      {resultado && !resultado.ok && (
        <div style={{ marginTop: 10, background: "#fff", borderLeft: `4px solid ${COLOR.red}`, borderRadius: 8, padding: "8px 10px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.red }}>
            {resultado.revisionManual ? "⚠️ Hay que montar este mes a mano" : "No se pudo generar"}
          </div>
          <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 4, lineHeight: 1.5 }}>{resultado.error}</div>
          {resultado.revisionManual && (
            <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 4, lineHeight: 1.5 }}>
              No se ha guardado nada: el cuadrante que había sigue como estaba. Puedes montarlo en
              la pantalla de Cuadrante, o volver a intentarlo.
            </div>
          )}
        </div>
      )}

      {resultado && avisos.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLOR.grayDark }}>
            {resultado.ok ? "Avisos (no impiden guardar, pero conviene mirarlos):" : "Lo que no ha conseguido cumplir:"}
          </div>
          {avisos.slice(0, 8).map((v, i) => (
            <div key={i} style={{ fontSize: 11, color: COLOR.grayDark, background: COLOR.gray, borderRadius: 6, padding: "4px 8px" }}>
              [{v.invariante}] {violationText(v, residentes)}
            </div>
          ))}
          {avisos.length > 8 && (
            <div style={{ fontSize: 11, color: COLOR.grayDark, fontStyle: "italic" }}>y {avisos.length - 8} más</div>
          )}
        </div>
      )}
    </Card>
  );
}

function HomeScreen() {
  const app = window.useApp();
  const { auth, residentes, myResidente, nivel, setTab, mes, anio, setMes, setAnio } = app;

  // Invitación al voluntariado del PRÓXIMO mandato de Responsable (decisión V-16). Se pide aparte
  // y sin bloquear la pantalla: si falla, Inicio se muestra igual sin la tarjeta. Solo aparece
  // para quien puede actuar de verdad —elegible, mandato sin decidir y no ofrecido aún—, así que
  // se apaga sola en cuanto se ofrece o se decide: un aviso que no se puede atender es ruido.
  const [proximoMandato, setProximoMandato] = useState(null);
  const [sinResponsable, setSinResponsable] = useState(false);
  // El estado del mes SELECCIONADO (no el de hoy): lo necesita el generador para no ofrecer el
  // botón sobre un mes PUBLICADO. `null` mientras carga o si la consulta falló — y `null` no
  // ofrece el botón, porque no saber si está publicado no es lo mismo que saber que no lo está.
  const [estadoMes, setEstadoMes] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setEstadoMes(null);
      const hoy = new Date();
      const [r, rEstado] = await Promise.all([
        app.api.estadoResponsable(hoy.getUTCFullYear()),
        app.api.estadoCuadrante(anio, mes),
      ]);
      if (cancelled) return;
      if (r.ok) setProximoMandato(r.siguiente || null);
      // Un fallo aquí solo esconde los botones que dependen del permiso: no se asume ninguno.
      setSinResponsable(rEstado.ok ? rEstado.sinResponsable === true : false);
      setEstadoMes(rEstado.ok ? rEstado.estado : null);
    })();
    return () => { cancelled = true; };
  }, [myResidente?.id, mes, anio]);
  const puedoRegistrarImaginaria = puedeMoverCiclo({ isResponsable: app.isResponsable, grupo: app.grupo, sinResponsable });
  const puedoGenerar = puedeGenerarCuadrante({ isResponsable: app.isResponsable, grupo: app.grupo, sinResponsable, estado: estadoMes });
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

      <GeneradorIA api={app.api} residentes={residentes} mes={mes} anio={anio} setMes={setMes}
        setAnio={setAnio} puedo={puedoGenerar} verCuadrante={() => setTab("calendar")} />

      <Imaginaria api={app.api} residentes={residentes} showToast={app.showToast} puedoRegistrar={puedoRegistrarImaginaria} />

      <QuickCard icon="📊" label="Ver cuadrante completo" onClick={() => setTab("calendar")} color={COLOR.greenMid} />
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Home = HomeScreen;

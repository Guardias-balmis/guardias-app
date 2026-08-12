// DatosServicioScreen — las tablas de datos de entrada del servicio: FESTIVOS (INV-12 y los
// puentes de INV-3, decisión V-17), EVENTOS del servicio (INV-10, decisión V-20) y EXCEPCIONES
// (INV-9, decisión V-29).
//
// Existe porque las tres estaban en vigor y sin forma de rellenarse desde la app: los invariantes
// se comprobaban contra tablas vacías, que es como no comprobar nada. Los festivos NUNCA se
// derivan ni se le piden a la IA (S-4: el cliente v1 le decía al modelo «identifícalos tú»), así
// que la única vía posible es que alguien los escriba — y esta pantalla es esa vía.
//
// Escribir exige el permiso del ciclo (V-16): son datos compartidos de todo el servicio, igual
// que cargar un año de festivos o sortear un evento. Leer está abierto. El servidor lo vuelve a
// comprobar en cada acción; aquí solo se decide qué se enseña.
import { COLOR, S } from "./client/lib/design-tokens.js";
import { parseFestivos } from "./client/lib/festivos-parse.js";
import { puedeMoverCiclo } from "./client/lib/permisos.js";
import { periodsOfResident, levelOn } from "./v2/domain/residents.js";
import { bridgesOfMonth } from "./v2/domain/calendar.js";
import { todayISO } from "./client/lib/dates.js";

const { useState, useEffect, useMemo } = React;
const { Card, SectionTitle, Btn, Aviso, Info } = window.UI;

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fechaLarga = (iso) => `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1]}`;
const TIPO_LABEL = { NAVIDAD: "Comida de Navidad", DESPEDIDA: "Despedida de R4" };

// `periodsOfResident` y no `defaultTrainingPeriods`: es la derivación única del dominio (V-24) y
// la ÚNICA que respeta los periodos editados de la nota [a]. Con `defaultTrainingPeriods` directo,
// esta pantalla mostraría un nivel distinto del que juzga el validador.
function nivelEn(residente, fecha) {
  return levelOn(periodsOfResident(residente), fecha);
}

/** Festivos de un año: lo cargado, y el pegado en lote con vista previa antes de escribir. */
function Festivos({ api, anio, showToast, puedoEscribir }) {
  const [festivos, setFestivos] = useState(null);
  const [error, setError] = useState(null);
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);

  const cargar = async () => {
    const r = await api.listFestivosRango(`${anio}-01-01`, `${anio}-12-31`);
    if (r.ok) { setFestivos(r.festivos.slice().sort((a, b) => (a.fecha < b.fecha ? -1 : 1))); setError(null); }
    else { setFestivos(null); setError(r.error); }
  };
  useEffect(() => { cargar(); }, [anio]);

  // Vista previa EN VIVO de lo que se va a escribir, y de lo que no. Se enseña antes de tocar la
  // tabla: `crearFestivos` rechaza el lote entero si algo falla, y sin esto no se sabría cuál.
  const yaCargadas = useMemo(() => (festivos || []).map((f) => f.fecha), [festivos]);
  const previa = useMemo(() => parseFestivos(texto, yaCargadas), [texto, yaCargadas]);

  // Los puentes se DERIVAN de los festivos (V-17b), nunca se escriben: enseñarlos aquí es la
  // forma de ver si el año está bien cargado — un año sin ningún puente suele ser un año a medias.
  const puentes = useMemo(() => {
    if (!festivos) return [];
    const out = [];
    for (let m = 1; m <= 12; m++) out.push(...bridgesOfMonth(anio, m, festivos));
    return out;
  }, [festivos, anio]);

  const cargarLote = async () => {
    setBusy(true);
    const r = await api.crearFestivos(previa.festivos);
    setBusy(false);
    if (r.ok) { showToast(`${previa.festivos.length} festivos cargados ✓`); setTexto(""); cargar(); }
    else showToast("No se pudieron cargar: " + r.error, "err");
  };

  const anular = async (id, fecha) => {
    setBusy(true);
    const r = await api.anularFestivo(id);
    setBusy(false);
    if (r.ok) { showToast(`${fecha} ya no consta como festivo`); cargar(); }
    else showToast("No se pudo anular: " + r.error, "err");
  };

  if (error) {
    return <Card title={`🎄 Festivos ${anio}`}><Aviso>No se pudieron cargar: {error}</Aviso><div style={{ marginTop: 10 }}><Btn onClick={cargar} color={COLOR.gray} textColor={COLOR.blueDark}>Reintentar</Btn></div></Card>;
  }

  return (
    <Card title={`🎄 Festivos ${anio}`}>
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        Son <b>datos de entrada</b>: la app nunca los calcula ni se los pregunta a la IA. Sin ellos,
        el validador no puede comprobar que una GF caiga en festivo (INV-12) ni repartir los puentes.
        Incluye también los <b>locales de Alicante</b>: cambian de fecha cada año y sin ellos se
        avisaría en falso sobre guardias correctas.
      </div>

      {festivos === null ? (
        <div style={{ fontSize: 13, color: COLOR.grayDark }}>Cargando…</div>
      ) : festivos.length === 0 ? (
        <Aviso>No hay ningún festivo cargado de {anio}. Mientras siga así, INV-12 no puede comprobar nada de este año.</Aviso>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {festivos.map((f) => (
              <div key={f.id} style={{
                display: "flex", alignItems: "center", gap: 6, background: COLOR.bluePale,
                borderRadius: 8, padding: "5px 8px", fontSize: 12, color: COLOR.blueDark,
              }}>
                <b>{fechaLarga(f.fecha)}</b>
                {f.nombre ? <span style={{ opacity: 0.85 }}>{f.nombre}</span> : null}
                {puedoEscribir && (
                  <button onClick={() => anular(f.id, f.fecha)} disabled={busy} title="Anular"
                    style={{ border: "none", background: "transparent", color: COLOR.red, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10 }}>
            {festivos.length} festivos · puentes derivados: {puentes.length ? puentes.map(fechaLarga).join(", ") : "ninguno"}
          </div>
        </>
      )}

      {puedoEscribir && (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
          <label style={S.label}>Pegar festivos (uno por línea)</label>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5}
            placeholder={`2026-12-25 Navidad\n2026-10-09;Día de la Comunitat;AUTONOMICO\n2026-06-24 San Juan`}
            style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box", resize: "vertical", fontFamily: "monospace", fontSize: 12 }} />
          <div style={{ fontSize: 11, color: COLOR.grayDark, marginTop: 4 }}>
            Fecha AAAA-MM-DD y, opcionalmente, nombre y ámbito (NACIONAL / AUTONOMICO / LOCAL),
            separados por espacios, `;` o tabulador. Las líneas que empiecen por `#` se ignoran.
          </div>

          {previa.errores.length > 0 && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: COLOR.orangeLight, border: `1.5px solid ${COLOR.orange}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, marginBottom: 4 }}>
                {previa.errores.length} línea(s) que no se cargarán
              </div>
              {previa.errores.map((e) => (
                <div key={e.linea} style={{ fontSize: 11, color: COLOR.grayDark }}>
                  Línea {e.linea}: {e.motivo}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <Btn onClick={cargarLote} disabled={busy || previa.festivos.length === 0}>
              {busy ? "Cargando…" : `Cargar ${previa.festivos.length} festivo${previa.festivos.length === 1 ? "" : "s"}`}
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Eventos del servicio: alta, sorteo reproducible de los 2 R2 y anulación. */
function Eventos({ api, residentes, showToast, puedoEscribir }) {
  const [eventos, setEventos] = useState(null);
  const [error, setError] = useState(null);
  const [tipo, setTipo] = useState("NAVIDAD");
  const [fecha, setFecha] = useState(todayISO());
  const [voluntarios, setVoluntarios] = useState([]);
  const [busy, setBusy] = useState(false);

  const cargar = async () => {
    const r = await api.listEventos();
    if (r.ok) { setEventos(r.eventos.slice().sort((a, b) => (a.fecha > b.fecha ? -1 : 1))); setError(null); }
    else { setEventos(null); setError(r.error); }
  };
  useEffect(() => { cargar(); }, []);

  const nombre = (id) => (residentes.find((r) => r.id === id) || {}).nombre || id;
  // Solo los R2 pueden cubrir el evento (normativa p.3): ofrecer a los demás como voluntarios
  // sería ofrecer algo que el sorteo va a descartar.
  const r2 = residentes.filter((r) => nivelEn(r, fecha) === "R2");
  useEffect(() => { setVoluntarios((v) => v.filter((id) => r2.some((r) => r.id === id))); }, [fecha]);

  const accion = async (fn, ok) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) { showToast(ok(r)); cargar(); }
    else showToast(r.error, "err");
  };

  if (error) {
    return <Card title="🎉 Eventos del servicio"><Aviso>No se pudieron cargar: {error}</Aviso><div style={{ marginTop: 10 }}><Btn onClick={cargar} color={COLOR.gray} textColor={COLOR.blueDark}>Reintentar</Btn></div></Card>;
  }

  return (
    <Card title="🎉 Eventos del servicio">
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        La comida de Navidad y la despedida de R4. Se cubren con <b>dos R2 a sorteo</b>, y quien
        cubra Navidad queda libre en la despedida (INV-10). El sorteo lo hace la app y queda
        registrado con su semilla, así que se puede recomprobar.
      </div>

      {eventos === null ? (
        <div style={{ fontSize: 13, color: COLOR.grayDark }}>Cargando…</div>
      ) : eventos.length === 0 ? (
        <Aviso>No hay ningún evento registrado. Sin fecha, INV-10 no puede comprobar nada.</Aviso>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {eventos.map((e) => (
            <div key={e.id} style={{
              background: COLOR.bluePale, borderLeft: `4px solid ${COLOR.blue}`,
              borderRadius: 8, padding: "8px 10px",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 13, color: COLOR.blueDark }}>
                  <b>{TIPO_LABEL[e.tipo] || e.tipo}</b> · {fechaLarga(e.fecha)} de {e.fecha.slice(0, 4)}
                </div>
                {puedoEscribir && (
                  <button onClick={() => accion(() => api.anularEvento(e.id), () => "Evento anulado")} disabled={busy}
                    style={{ ...S.smallBtn, background: "#fff", color: COLOR.red, flexShrink: 0 }}>Anular</button>
                )}
              </div>
              <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 4 }}>
                {e.sorteoId
                  ? <>Sorteado ✓ — cubren <b>{(e.designados || []).map(nombre).join(" y ")}</b></>
                  : "Sin sortear"}
                {(e.voluntarios || []).length > 0 && <> · voluntarios: {e.voluntarios.map(nombre).join(", ")}</>}
              </div>
              {puedoEscribir && !e.sorteoId && (
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => accion(() => api.sortearEvento(e.id), (r) => `Sorteo hecho: ${r.designados.map(nombre).join(" y ")}`)}
                    disabled={busy} style={{ ...S.smallBtn, background: COLOR.blue, color: "#fff" }}>🎲 Sortear los 2 R2</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {puedoEscribir && (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Evento</label>
              <select value={tipo} onChange={(e) => setTipo(e.target.value)}
                style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }}>
                {Object.entries(TIPO_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Fecha</label>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)}
                style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={S.label}>Voluntarios (opcional)</label>
            <div style={{ fontSize: 11, color: COLOR.grayDark, margin: "4px 0 6px" }}>
              Si se ofrecen dos o más, el sorteo se hace <b>solo entre ellos</b>. Si no, entra
              cualquier R2 de esa fecha.
            </div>
            {r2.length === 0 ? (
              <div style={{ fontSize: 12, color: COLOR.orange }}>No hay ningún R2 en esa fecha: el sorteo no podrá hacerse.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {r2.map((r) => {
                  const on = voluntarios.includes(r.id);
                  return (
                    <button key={r.id} onClick={() => setVoluntarios((v) => (on ? v.filter((x) => x !== r.id) : [...v, r.id]))}
                      style={{
                        ...S.smallBtn, background: on ? COLOR.blue : "#fff", color: on ? "#fff" : COLOR.grayDark,
                        border: on ? "none" : `1.5px solid ${COLOR.grayMid}`,
                      }}>{r.nombre}</button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            <Btn onClick={() => accion(() => api.crearEvento(tipo, fecha, voluntarios), () => "Evento registrado ✓")} disabled={busy}>
              Registrar evento
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Excepciones (INV-9, V-29): degradan un 2×R2 documentado dentro de un rango de fechas. */
function Excepciones({ api, showToast, puedoEscribir }) {
  const [excepciones, setExcepciones] = useState(null);
  const [error, setError] = useState(null);
  const [desde, setDesde] = useState(todayISO());
  const [hasta, setHasta] = useState(todayISO());
  const [justificacion, setJustificacion] = useState("");
  const [busy, setBusy] = useState(false);

  const cargar = async () => {
    const r = await api.listExcepciones();
    if (r.ok) { setExcepciones(r.excepciones.slice().sort((a, b) => (a.desde < b.desde ? 1 : -1))); setError(null); }
    else { setExcepciones(null); setError(r.error); }
  };
  useEffect(() => { cargar(); }, []);

  const crear = async () => {
    setBusy(true);
    const r = await api.crearExcepcion("2xR2", desde, hasta, justificacion);
    setBusy(false);
    if (r.ok) { showToast("Excepción registrada ✓"); setJustificacion(""); cargar(); }
    else showToast("No se pudo registrar: " + r.error, "err");
  };

  const anular = async (id) => {
    setBusy(true);
    const r = await api.anularExcepcion(id);
    setBusy(false);
    if (r.ok) { showToast("Excepción anulada"); cargar(); }
    else showToast("No se pudo anular: " + r.error, "err");
  };

  if (error) {
    return <Card title="📋 Excepciones"><Aviso>No se pudieron cargar: {error}</Aviso><div style={{ marginTop: 10 }}><Btn onClick={cargar} color={COLOR.gray} textColor={COLOR.blueDark}>Reintentar</Btn></div></Card>;
  }

  return (
    <Card title="📋 Excepciones">
      <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
        Documenta un <b>2×R2 el mismo día</b> (INV-9) por rotación de mayores o necesidad
        organizativa objetiva. Solo aplica desde diciembre del año académico — la normativa no
        cubre antes. Sin excepción documentada, INV-9 avisa igual, nunca bloquea.
      </div>

      {excepciones === null ? (
        <div style={{ fontSize: 13, color: COLOR.grayDark }}>Cargando…</div>
      ) : excepciones.length === 0 ? (
        <Aviso>No hay ninguna excepción registrada.</Aviso>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {excepciones.map((e) => (
            <div key={e.id} style={{
              background: COLOR.bluePale, borderLeft: `4px solid ${COLOR.blue}`,
              borderRadius: 8, padding: "8px 10px",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 13, color: COLOR.blueDark }}>
                  <b>2×R2</b> · {fechaLarga(e.desde)}–{fechaLarga(e.hasta)}
                </div>
                {puedoEscribir && (
                  <button onClick={() => anular(e.id)} disabled={busy}
                    style={{ ...S.smallBtn, background: "#fff", color: COLOR.red, flexShrink: 0 }}>Anular</button>
                )}
              </div>
              <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 4 }}>{e.justificacion}</div>
            </div>
          ))}
        </div>
      )}

      {puedoEscribir && (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${COLOR.grayMid}` }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Desde</label>
              <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
                style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Hasta</label>
              <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
                style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={S.label}>Justificación</label>
            <textarea value={justificacion} onChange={(e) => setJustificacion(e.target.value)} rows={2}
              placeholder="p. ej. mayores en rotación, no hay otra combinación posible"
              style={{ ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box", resize: "vertical" }} />
          </div>
          <div style={{ marginTop: 10 }}>
            <Btn onClick={crear} disabled={busy || desde > hasta || !justificacion.trim()}>
              Registrar excepción
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

function DatosServicioScreen() {
  const app = window.useApp();
  const { api, residentes, showToast, setTab } = app;
  const [anio, setAnio] = useState(Number(todayISO().slice(0, 4)));
  // Mismo criterio y misma fuente que Calendar.jsx y Prefs.jsx: `sinResponsable` lo dice el
  // servidor en estadoCuadrante, nunca el `rol` del token, que se firmó en el login.
  const [sinResponsable, setSinResponsable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hoy = new Date();
      const r = await api.estadoCuadrante(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1);
      if (!cancelled) setSinResponsable(r.ok ? r.sinResponsable === true : false);
    })();
    return () => { cancelled = true; };
  }, []);
  const puedoEscribir = puedeMoverCiclo({ isResponsable: app.isResponsable, grupo: app.grupo, sinResponsable });

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
      <SectionTitle>🗓️ Datos del servicio</SectionTitle>

      {!puedoEscribir && (
        <Info>
          Puedes consultarlos, pero para cargarlos o corregirlos hace falta ser el Responsable del
          contaje o —si el mandato está sin decidir— un R3 o R4.
        </Info>
      )}

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setAnio(anio - 1)} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>◀</button>
          <div style={{ fontSize: 17, fontWeight: 700, color: COLOR.blueDark }}>{anio}</div>
          <button onClick={() => setAnio(anio + 1)} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>▶</button>
        </div>
      </Card>

      <Festivos api={api} anio={anio} showToast={showToast} puedoEscribir={puedoEscribir} />
      <Eventos api={api} residentes={residentes} showToast={showToast} puedoEscribir={puedoEscribir} />
      <Excepciones api={api} showToast={showToast} puedoEscribir={puedoEscribir} />

      <Btn onClick={() => setTab("settings")} color={COLOR.gray} textColor={COLOR.blueDark}>← Volver</Btn>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.DatosServicio = DatosServicioScreen;

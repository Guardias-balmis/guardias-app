// ResidentesScreen — las fechas de cada residente y sus PERIODOS FORMATIVOS (nota [a] de la
// normativa: «los periodos generados son editables después»), decisión V-24.
//
// Existe por la misma razón que DatosServicio.jsx: el backend estaba entero y sin ninguna vía para
// usarlo, así que la tabla `periodos` nacía vacía y se quedaba vacía — exactamente lo que les pasó
// a `festivos` y `eventos` hasta que se les hizo pantalla. Y sin esta pantalla el `aviso` de V-21
// («guardia asignada a quien no es residente asignable en esa fecha») no tenía salida real: la
// causa vive en las fechas del residente y nadie podía corregirlas desde la app.
//
// Para qué sirve de verdad: una baja larga RETRASA la promoción (S-3), y el nivel se deriva de las
// fechas. Sin poder alargar el R1 de alguien, la app lo asciende a R2 en su aniversario nominal y
// deja de verlo como R1 — con lo que INV-11 (uno de los tres que BLOQUEAN) deja de protegerlo en
// junio-agosto. El retraso NO se deriva de la tabla `bloqueos` a propósito: lo decide tutoría, una
// baja de dos semanas no retrasa nada, y adivinarlo cambiaría el nivel de alguien sin que nadie lo
// haya decidido.
//
// Escribir exige el permiso del ciclo (V-16), igual que cargar festivos: son datos de todo el
// servicio, no propios. Leer está abierto, y a quien no puede escribir se le DICE en vez de
// esconderle la pantalla. El servidor lo vuelve a comprobar en cada acción.
import { COLOR, S } from "./client/lib/design-tokens.js";
import { puedeMoverCiclo } from "./client/lib/permisos.js";
import { periodsOfResident, levelOn, validateTrainingPeriods } from "./v2/domain/residents.js";
import { todayISO } from "./client/lib/dates.js";

const { useState, useEffect, useMemo } = React;
const { Card, SectionTitle, Btn, Aviso, Info } = window.UI;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fechaEs = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : "—");
const NIVEL_COLOR = { R1: COLOR.bluePale, R2: COLOR.bluePale, R3: COLOR.blueDark, R4: COLOR.blueDark };

const campo = { ...S.input, width: "100%", marginTop: 4, boxSizing: "border-box" };
const etiqueta = { ...S.label };

/** Los 4 periodos en la forma de la TABLA, que es la que espera `api.guardarPeriodos`. */
function periodosDeTabla(residente) {
  return periodsOfResident(residente).map((p) => ({ anio: p.year, fechaInicio: p.start, fechaFin: p.end }));
}

/** Ficha de un residente: sus fechas, su nivel de hoy y el editor de periodos. */
function Ficha({ api, residente, puedoEscribir, showToast, onCambio }) {
  const [abierto, setAbierto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inicio, setInicio] = useState(residente.fechaInicio || "");
  const [fin, setFin] = useState(residente.fechaFin || "");
  const [periodos, setPeriodos] = useState(() => periodosDeTabla(residente));

  // Al recargar la lista tras guardar, la ficha tiene que reflejar lo que hay ahora en la tabla y
  // no lo que se teclease antes: si no, un guardado con éxito seguiría mostrando el valor viejo.
  useEffect(() => {
    setInicio(residente.fechaInicio || "");
    setFin(residente.fechaFin || "");
    setPeriodos(periodosDeTabla(residente));
  }, [residente]);

  const nivelHoy = levelOn(periodsOfResident(residente), todayISO());
  // «Editados» = DISTINTOS de lo que saldría de las fechas, no «hay filas en la tabla». No es lo
  // mismo: `restaurarPeriodos` no puede borrar filas —la tabla es append-only y no tiene columna
  // `activo`, y añadírsela es lo que V-19(d) descartó porque `rowsToRecords` mapea por posición—,
  // así que escribe los derivados. Con la comprobación por existencia, restaurar dejaba la etiqueta
  // diciendo «periodos editados» sobre unos periodos que son exactamente los automáticos.
  const derivados = useMemo(
    () => periodsOfResident({ fechaInicio: residente.fechaInicio, fechaFin: residente.fechaFin }),
    [residente.fechaInicio, residente.fechaFin]
  );
  const editados = residente.periodos !== undefined
    && JSON.stringify(residente.periodos) !== JSON.stringify(derivados);

  // Validación EN VIVO con la misma función que el servidor (`validateTrainingPeriods`): así el
  // botón no se pulsa para recibir un error que ya se podía ver. No sustituye al del servidor —
  // ahí se vuelve a comprobar, aquí solo se adelanta el mensaje.
  const enDominio = useMemo(
    () => periodos.map((p) => ({ year: Number(p.anio), start: p.fechaInicio, end: p.fechaFin })),
    [periodos]
  );
  const errores = useMemo(() => {
    if (enDominio.some((p) => !p.start || !p.end)) return ["Faltan fechas por rellenar"];
    return validateTrainingPeriods(enDominio);
  }, [enDominio]);

  const cambiaPeriodo = (i, campoNombre, valor) =>
    setPeriodos(periodos.map((p, j) => (i === j ? { ...p, [campoNombre]: valor } : p)));

  const accion = async (fn, exito) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) { showToast(exito); onCambio(); }
    else showToast(r.error, "err");
  };

  const fechasTocadas = inicio !== (residente.fechaInicio || "") || fin !== (residente.fechaFin || "");

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          background: NIVEL_COLOR[nivelHoy] || COLOR.gray, color: NIVEL_COLOR[nivelHoy] === COLOR.blueDark ? "#fff" : COLOR.blueDark,
          fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 6, minWidth: 34, textAlign: "center",
        }}>{nivelHoy === "PENDIENTE" ? "—" : nivelHoy === "FINALIZADO" ? "fin" : nivelHoy}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: COLOR.blueDark }}>{residente.nombre}</div>
          <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 1 }}>
            {fechaEs(residente.fechaInicio)} → {fechaEs(residente.fechaFin)}
            {editados && <span style={{ color: COLOR.orange, fontWeight: 600 }}> · periodos editados</span>}
          </div>
        </div>
        <button onClick={() => setAbierto(!abierto)} style={{ ...S.smallBtn, background: COLOR.bluePale, color: COLOR.blue }}>
          {abierto ? "Cerrar" : "Editar"}
        </button>
      </div>

      {abierto && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${COLOR.grayMid}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.grayDark, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              Fechas de residencia
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={etiqueta}>Incorporación</label>
                <input type="date" value={inicio} disabled={!puedoEscribir} onChange={(e) => setInicio(e.target.value)} style={campo} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={etiqueta}>Fin</label>
                <input type="date" value={fin} disabled={!puedoEscribir} onChange={(e) => setFin(e.target.value)} style={campo} />
              </div>
            </div>
            {puedoEscribir && (
              <div style={{ marginTop: 8 }}>
                <Btn disabled={busy || !fechasTocadas}
                  onClick={() => accion(() => api.editarResidente(residente.id, { fechaInicio: inicio, fechaFin: fin }), "Fechas corregidas ✓")}>
                  Guardar fechas
                </Btn>
              </div>
            )}
            <div style={{ fontSize: 12, color: COLOR.grayDark, marginTop: 8, lineHeight: 1.5 }}>
              Corregir la fecha de fin es lo que arregla el aviso «guardia asignada a quien no es
              residente asignable en esa fecha». El correo no se toca desde aquí: es la llave del acceso.
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.grayDark, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              Periodos formativos
            </div>
            <div style={{ fontSize: 12, color: COLOR.grayDark, marginBottom: 8, lineHeight: 1.5 }}>
              Por defecto se derivan de las fechas de arriba. Solo hay que tocarlos si una baja larga
              ha <b>retrasado</b> una promoción: se alarga el año que corresponda y los siguientes se
              corren. Se permite dejar un hueco entre dos periodos.
            </div>
            {periodos.map((p, i) => (
              <div key={p.anio} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.blueDark, width: 26, paddingBottom: 10 }}>R{p.anio}</div>
                <div style={{ flex: 1 }}>
                  <input type="date" value={p.fechaInicio || ""} disabled={!puedoEscribir}
                    onChange={(e) => cambiaPeriodo(i, "fechaInicio", e.target.value)} style={campo} />
                </div>
                <div style={{ flex: 1 }}>
                  <input type="date" value={p.fechaFin || ""} disabled={!puedoEscribir}
                    onChange={(e) => cambiaPeriodo(i, "fechaFin", e.target.value)} style={campo} />
                </div>
              </div>
            ))}

            {errores.length > 0 && (
              <Aviso color={COLOR.red} bg={COLOR.redLight}>
                {errores.map((e, i) => <div key={i}>{e}</div>)}
              </Aviso>
            )}

            {puedoEscribir && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Btn disabled={busy || errores.length > 0}
                  onClick={() => accion(() => api.guardarPeriodos(residente.id, periodos), "Periodos guardados ✓")}>
                  Guardar periodos
                </Btn>
                {/* Sin esto una edición mala sería irreversible: la tabla es append-only y el
                    servidor solo monta los periodos si están las cuatro filas. */}
                <Btn disabled={busy || !editados} color={COLOR.gray} textColor={COLOR.blueDark}
                  onClick={() => accion(() => api.restaurarPeriodos(residente.id), "Periodos vueltos a los derivados de las fechas ✓")}>
                  Volver a los automáticos
                </Btn>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function ResidentesScreen() {
  const app = window.useApp();
  const { api, showToast, setTab, loadResidentes } = app;
  const [residentes, setResidentes] = useState(null);
  const [error, setError] = useState(null);

  // Lista propia y no la del contexto de App: esta pantalla la reescribe, y necesita releerla
  // después de cada guardado para que la ficha muestre lo que hay en la tabla de verdad.
  //
  // Pero refresca TAMBIÉN la del contexto (`loadResidentes`), y eso no es opcional: de ahí sacan
  // los residentes la rejilla del cuadrante, el generador y el inicio, y las tres derivan el nivel
  // con `periodsOfResident`. Sin este refresco, editar unos periodos aquí y pasar al Cuadrante sin
  // recargar la página enseñaba el nivel VIEJO — comprobado en vivo: Iván salía R2 donde ya era R1.
  const cargar = async () => {
    const r = await api.listResidentes();
    if (r.ok) { setResidentes(r.residentes); setError(null); }
    else { setResidentes(null); setError(r.error); }
    await loadResidentes();
  };
  useEffect(() => { cargar(); }, []);

  // Mismo criterio y misma fuente que Calendar.jsx, Prefs.jsx y DatosServicio.jsx: `sinResponsable`
  // lo dice el servidor, nunca el `rol` del token — que se firmó en el login y puede ser anterior
  // al sorteo (V-16).
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

  // Por nivel de hoy y luego por nombre: es el orden en que la gente piensa el equipo. Los que ya
  // han terminado van al final, pero NO se esconden: su historial sigue contando y su fecha de fin
  // es justo la que puede hacer falta corregir.
  const ordenados = useMemo(() => {
    const rango = { R4: 0, R3: 1, R2: 2, R1: 3, PENDIENTE: 4, FINALIZADO: 5 };
    return (residentes || []).slice().sort((a, b) => {
      const na = levelOn(periodsOfResident(a), todayISO());
      const nb = levelOn(periodsOfResident(b), todayISO());
      return (rango[na] ?? 9) - (rango[nb] ?? 9) || (a.nombre || "").localeCompare(b.nombre || "");
    });
  }, [residentes]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, margin: "0 auto" }}>
      <SectionTitle>🎓 Residentes y periodos</SectionTitle>

      {!puedoEscribir && (
        <Info>
          Puedes consultarlos, pero para corregir fechas o periodos hace falta ser el Responsable del
          contaje o —si el mandato está sin decidir— un R3 o R4.
        </Info>
      )}

      <Info>
        El nivel R1–R4 no se guarda en ninguna parte: se calcula de estas fechas. Nadie «sube de
        año» a mano, y nadie se borra — quien termina deja de salir en las listas por cálculo, con
        su historial intacto.
      </Info>

      {error && <Aviso color={COLOR.red} bg={COLOR.redLight}>No se pudo cargar el equipo: {error}</Aviso>}
      {!residentes && !error && <Card><div style={{ fontSize: 13, color: COLOR.grayDark }}>Cargando…</div></Card>}

      {ordenados.map((r) => (
        <Ficha key={r.id} api={api} residente={r} puedoEscribir={puedoEscribir} showToast={showToast} onCambio={cargar} />
      ))}

      <Btn onClick={() => setTab("settings")} color={COLOR.gray} textColor={COLOR.blueDark}>← Volver</Btn>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Residentes = ResidentesScreen;

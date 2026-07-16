// GeneratorScreen — sustituye a la antigua pantalla de IA. "Prompt portátil": sin llamada a
// ninguna API de terceros ni secreto en el cliente (spec: decisión del proyecto). Monta un
// prompt de texto para pegar en el asistente que el usuario prefiera y valida LOCALMENTE
// (validateMonth, sin red) la respuesta que devuelva — "la IA propone, el validador dispone"
// (spec.md §5), mismo esquema visual de violaciones que CalendarScreen.
import { COLOR, S, ANOS } from "./client/lib/design-tokens.js";
import { defaultTrainingPeriods, levelOn, groupOf } from "./v2/domain/residents.js";
import { addDays, addYears, toISO } from "./v2/domain/calendar.js";
import { validateMonth } from "./v2/domain/validate.js";

const { useState, useMemo } = React;
const { Card, SectionTitle, Btn, Aviso, Info } = window.UI;

const GRUPO_LABEL = { MAYOR: "Mayor", PEQUENO: "Pequeño" };
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function nombreMesDe(anio, mes) {
  const s = new Date(Date.UTC(anio, mes - 1, 1)).toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function nivelEnFecha(residente, iso) {
  const fin = residente.fechaFin || addDays(addYears(residente.fechaInicio, 4), -1);
  return levelOn(defaultTrainingPeriods(residente.fechaInicio, fin), iso);
}

function agruparPorNivel(residentes, iso) {
  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  for (const r of residentes) {
    const nivel = nivelEnFecha(r, iso);
    if (porNivel[nivel]) porNivel[nivel].push({ id: r.id, nombre: r.nombre, nivel });
  }
  return porNivel;
}

function construirPrompt({ mes, anio, nombreMes, porNivel }) {
  const bloques = ANOS.map((nivel) => {
    const lista = porNivel[nivel];
    if (!lista.length) return null;
    const grupo = GRUPO_LABEL[groupOf(nivel)];
    const filas = lista.map((r) => `  - id="${r.id}" — ${r.nombre}`).join("\n");
    return `${nivel} (${grupo}):\n${filas}`;
  }).filter(Boolean).join("\n\n");

  return `Eres el generador del cuadrante de guardias de Radiodiagnóstico (Hospital Dr. Balmis).

RESIDENTES ACTIVOS EN ${nombreMes.toUpperCase()} — usa el "id" EXACTO como residenteId, nunca el nombre:

${bloques || "(sin residentes activos este mes)"}

NORMAS OPERATIVAS (resumen; ante la duda, prioriza la equidad):
1. Cada día lleva exactamente 1 guardia (G/GF/GP) de un residente Mayor (R3/R4) y 1 de un
   residente Pequeño (R1/R2). Excepción: 2 residentes R2 el mismo día solo se admite desde
   el 1 de diciembre y de forma justificada.
2. Cada residente hace entre 4 y 6 guardias computables (G+GF+GP) al mes; un Pequeño puede
   bajar excepcionalmente a 3 si la oferta de días no da para más.
3. Reparte con equidad (±1) dentro de cada año de residencia: total de guardias, findes,
   festivos, prefestivos y dobletes.
4. El 3.º puesto (código 3P) y las guardias cedidas/compradas no cuentan para el mínimo ni
   el máximo de guardias del punto 2.
5. No asignes guardia a un residente en un periodo de vacaciones, rotación externa o baja
   que conozcas por el contexto de esta conversación.
6. Como máximo 2 residentes de la misma promoción (año de incorporación) pueden estar
   ausentes a la vez en rotación externa.
7. Si un residente rota en Alicante o provincia colindante, cúbrele guardia de viernes y de
   sábado durante esa rotación.
8. El 3.º puesto recorre lunes→domingo antes de repetir día, con equidad entre voluntarios.
9. 2 residentes R2 el mismo día solo se admite desde el 1 de diciembre y justificado, o en
   un día de evento del servicio (Navidad, despedida).
10. Los eventos del servicio (Navidad, cena de despedida) se cubren con 2 R2 por sorteo
    documentado; si no conoces esas fechas, ignora esta norma.
11. Junio, julio y agosto: ningún R1 hace guardia — ese puesto de Pequeño lo cubren los R2,
    repartido con equidad entre ellos.
12. Usa el código GP para el prefestivo, GF para el propio festivo y G para el resto de
    guardias ordinarias.

FORMATO DE RESPUESTA (obligatorio, sin excepciones):
Responde ÚNICAMENTE con un JSON con esta forma exacta, sin texto ni bloques markdown
alrededor:
{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G|GF|GP|3P"}]}

Genera el cuadrante completo de ${nombreMes} (mes=${mes}, año=${anio}) respetando estas normas.`;
}

function ViolationBox({ v, color, bg }) {
  return (
    <div style={{ fontSize: 12, color, background: bg, borderRadius: 6, padding: "4px 8px" }}>
      [{v.invariante}] {v.detalle}
    </div>
  );
}

function GeneratorScreen() {
  const app = window.useApp();
  const { mes, anio, residentes, api, showToast, setTab, setLoading } = app;

  const iso15 = useMemo(() => toISO(anio, mes, 15), [anio, mes]);
  const nombreMes = useMemo(() => nombreMesDe(anio, mes), [anio, mes]);
  const porNivel = useMemo(() => agruparPorNivel(residentes, iso15), [residentes, iso15]);
  const promptText = useMemo(() => construirPrompt({ mes, anio, nombreMes, porNivel }), [mes, anio, nombreMes, porNivel]);

  const [respuesta, setRespuesta] = useState("");
  const [parseError, setParseError] = useState(null);
  const [violaciones, setViolaciones] = useState(null); // null = aún no comprobado
  const [parsedAsignaciones, setParsedAsignaciones] = useState(null);
  const [applying, setApplying] = useState(false);

  const onRespuestaChange = (v) => {
    setRespuesta(v);
    setParseError(null);
    setViolaciones(null);
    setParsedAsignaciones(null);
  };

  const copiarPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      showToast("Prompt copiado — pégalo en claude.ai");
    } catch (e) {
      showToast("No se pudo copiar el prompt: " + e.message, "err");
    }
  };

  const comprobar = () => {
    const texto = respuesta.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(texto);
    } catch (e) {
      setParseError("La respuesta no es JSON válido: " + e.message);
      setViolaciones(null);
      setParsedAsignaciones(null);
      return;
    }
    const asignacionesRespuesta = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.asignaciones)) ? parsed.asignaciones : null;
    if (!asignacionesRespuesta) {
      setParseError('El JSON debe tener la forma {"asignaciones": [...]}');
      setViolaciones(null);
      setParsedAsignaciones(null);
      return;
    }
    const ctx = {
      mes, anio,
      residentes: residentes.map((r) => ({ id: r.id, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin })),
      asignaciones: asignacionesRespuesta,
    };
    try {
      setParseError(null);
      setViolaciones(validateMonth(ctx));
      setParsedAsignaciones(asignacionesRespuesta);
    } catch (e) {
      setParseError("La respuesta no se pudo validar: " + e.message);
      setViolaciones(null);
      setParsedAsignaciones(null);
    }
  };

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad === "aviso");
  const puedeAplicar = violaciones !== null && errores.length === 0 && parsedAsignaciones && parsedAsignaciones.length > 0;

  const aplicar = async () => {
    setApplying(true);
    setLoading(true);
    const cambios = parsedAsignaciones.map((a) => ({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo }));
    const r = await api.guardarAsignaciones(cambios);
    setLoading(false);
    setApplying(false);
    if (r.ok) {
      showToast("Cuadrante aplicado ✓");
      setTab("calendar");
    } else {
      showToast("Error aplicando el cuadrante: " + r.error, "err");
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
      <SectionTitle>🤖 Generador de cuadrante</SectionTitle>

      <Info>
        Esta pantalla no llama a ninguna IA: genera un prompt de texto para que lo pegues tú
        en el asistente que prefieras (claude.ai u otro) y valida aquí mismo, sin red, la
        respuesta que te devuelva.
      </Info>

      <Card title={`1. Prompt para ${nombreMes}`}>
        <textarea readOnly value={promptText} rows={12} style={{
          ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT,
          fontSize: 11.5, lineHeight: 1.5, resize: "vertical", background: COLOR.gray, color: COLOR.bodyText,
        }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={copiarPrompt}>📋 Copiar prompt</Btn>
        </div>
      </Card>

      <Info>
        1. Copia el prompt. 2. Pégalo en claude.ai (u otro asistente). 3. Pega aquí la
        respuesta JSON que te devuelva.
      </Info>

      <Card title="2. Respuesta del asistente">
        <textarea value={respuesta} onChange={(e) => onRespuestaChange(e.target.value)} rows={10}
          placeholder='{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G"}]}'
          style={{ ...S.input, width: "100%", boxSizing: "border-box", fontFamily: MONO_FONT, fontSize: 12, resize: "vertical" }} />
        <div style={{ marginTop: 10 }}>
          <Btn onClick={comprobar} disabled={!respuesta.trim()}>Comprobar y aplicar</Btn>
        </div>
      </Card>

      {parseError && <Aviso color={COLOR.red} bg={COLOR.redLight}>{parseError}</Aviso>}

      {violaciones !== null && !parseError && (
        <Card title="3. Resultado de la validación">
          {violaciones.length === 0 ? (
            <div style={{ color: COLOR.green, fontWeight: 700, fontSize: 14 }}>✅ Sin violaciones</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {errores.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.red, marginBottom: 6 }}>⛔ Errores ({errores.length}) — bloquean la aplicación</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {errores.map((v, i) => <ViolationBox key={i} v={v} color={COLOR.red} bg={COLOR.redLight} />)}
                  </div>
                </div>
              )}
              {avisos.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.orange, marginBottom: 6 }}>⚠️ Avisos ({avisos.length}) — informativos</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {avisos.map((v, i) => <ViolationBox key={i} v={v} color={COLOR.orange} bg={COLOR.orangeLight} />)}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {errores.length > 0 ? (
              <Aviso>
                Hay errores bloqueantes: no se puede aplicar este cuadrante tal cual.
                Corrígelo a mano en la pantalla Cuadrante, o pide al asistente que corrija
                estos puntos concretos y vuelve a pegar aquí la respuesta.
              </Aviso>
            ) : (
              <Btn onClick={aplicar} disabled={applying || !puedeAplicar} color={COLOR.greenMid}>
                {applying ? "Aplicando…" : "✅ Aplicar al cuadrante"}
              </Btn>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Generator = GeneratorScreen;

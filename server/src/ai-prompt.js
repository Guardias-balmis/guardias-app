// Prompt de generación del cuadrante y parseo de la respuesta del modelo (decisión V-45). PURO:
// solo texto y JSON — ni red, ni Sheets, ni dominio. Todo lo derivado (nivel de cada residente,
// contaje acumulado, puentes del mes) llega ya calculado desde el router, que es quien tiene
// `deps.domain`: así este módulo se puede probar entero sin montar un contexto de dominio, y el
// bundler de Apps Script no necesita que `server/src` importe de `v2/domain` (no sabe hacerlo).
//
// EL PROMPT NO ES NUEVO. Es el que vivía en `client/screens/Generator.jsx` desde la Fase 6.1,
// portado tal cual: sus doce normas, sus secciones de datos reales (bloqueos, festivos, puentes,
// voluntarios del 3P, eventos, preferencias) y su insistencia en no alucinar festivos (S-4) son
// trabajo ya medido contra modelos reales, no algo que convenga reescribir de cero. Lo único que
// se le añade es la norma 13: INV-15 (descanso tras guardia) entró en V-35, después de que ese
// prompt se escribiera, y es una de las cuatro reglas que producen `error` — pedirle al modelo un
// cuadrante sin decirle la regla que lo va a tumbar es garantizar los tres reintentos.
//
// El parseo es la frontera de verdad: lo que devuelve un modelo no lo controla nadie. Por eso
// `parseGenerationResponse` no lanza jamás, tolera lo que se le ha visto hacer a un modelo
// (vallas markdown, un párrafo de cortesía alrededor) y rechaza nombrando el motivo — el motivo
// vuelve al modelo en el reintento, así que un rechazo mudo cuesta un intento de los tres.

// Códigos que el generador PUEDE proponer. V/R/B quedan fuera a propósito: son marcadores de la
// rejilla que ningún invariante lee, nadie se los ha pedido al modelo, y `apply.js` solo borra lo
// que se propone — proponerlos sería empezar a pisar datos sobre los que no tiene ninguna opinión.
const CODIGOS_PROPONIBLES = ["G", "GF", "GP", "3P"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** La forma exacta del JSON que se le pide. Se escribe UNA vez y viaja al prompt y a los tests. */
export const RESPONSE_SHAPE = '{"asignaciones": [{"fecha":"YYYY-MM-DD","residenteId":"...","codigo":"G|GF|GP|3P"}]}';

const MESES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const GRUPO_LABEL = { R4: "Mayor", R3: "Mayor", R2: "Pequeño", R1: "Pequeño" };
const MOTIVO_LABEL = { BAJA: "BAJA", VACACIONES: "VACACIONES", ROTACION: "ROTACIÓN" };
const NIVELES = ["R4", "R3", "R2", "R1"];

/**
 * Nombre del mes en español. A mano y no con `toLocaleDateString`: el soporte de `Intl` en el
 * runtime V8 de Apps Script no es el del navegador, y el nombre de un mes no merece depender de
 * eso en una aplicación cuyo requisito rector es durar diez años sin nadie que la arregle.
 */
export function nombreMes(anio, mes) {
  return `${MESES[mes] || mes} de ${anio}`;
}

/** Contaje acumulado de un residente en SU año de residencia en curso, o null si aún no tiene. */
function resumenAcumulado(acc) {
  if (!acc) return null;
  return `total=${acc.total}, findes=${acc.finde}, festivos=${acc.festivos}, prefestivos=${acc.prefestivos}, dobletes=${acc.dobletes}`;
}

/** Bloqueos activos del mes. BAJA es obligatorio; vacaciones y rotación son evitables (V-8). */
function seccionBloqueos(bloqueos) {
  if (!bloqueos || bloqueos.length === 0) return "BLOQUEOS ACTIVOS ESTE MES (por residenteId): ninguno.";
  const lineas = bloqueos.map((b) => {
    const etiqueta = (MOTIVO_LABEL[b.motivo] || b.motivo) + (b.motivo === "ROTACION" && b.provincia ? ` (${b.provincia})` : "");
    return b.motivo === "BAJA"
      ? `  - id="${b.residenteId}" — ${etiqueta} del ${b.desde} al ${b.hasta}: OBLIGATORIO no asignarle guardia ningún día de ese rango.`
      : `  - id="${b.residenteId}" — ${etiqueta} del ${b.desde} al ${b.hasta}: evita asignarle guardia si puedes; si no hay alternativa razonable, sí se le puede asignar.`;
  }).join("\n");
  return `BLOQUEOS ACTIVOS ESTE MES (por residenteId):\n${lineas}`;
}

/**
 * Festivos y puentes del mes. Los festivos son DATO DE ENTRADA (S-4): el cliente v1 le pedía al
 * modelo "identifícalos tú", y un festivo alucinado se convierte en una GF mal puesta que INV-12
 * tiene que cazar después. Si no hay ninguno cargado se dice, en vez de dejarle improvisar.
 */
function seccionFestivos(festivos, puentes) {
  if (!festivos || festivos.length === 0) {
    return "FESTIVOS DEL MES: no hay ninguno cargado en la aplicación. NO inventes festivos: marca\ntodas las guardias como G.";
  }
  const lista = festivos
    .map((f) => `  - ${f.fecha}${f.nombre ? ` — ${f.nombre}` : ""}${f.ambito ? ` (${String(f.ambito).toLowerCase()})` : ""}`)
    .join("\n");
  const textoPuentes = puentes && puentes.length
    ? `\n\nPUENTES (día laborable entre dos no laborables; conviene repartirlos con equidad):\n${puentes.map((d) => `  - ${d}`).join("\n")}`
    : "";
  return `FESTIVOS DEL MES (los únicos que existen; la víspera de cada uno es prefestivo → GP):\n${lista}${textoPuentes}`;
}

/**
 * Voluntarios del tercer puesto. El 3P es autoservicio puro («será siempre voluntario», V-18): sin
 * esta sección, la norma del 3P le pedía repartirlo «con equidad entre voluntarios» sin decirle
 * nunca quiénes son. El `desde` viaja porque arranca el ciclo L-D de INV-8b (contrato C-4).
 */
function seccionVoluntarios3P(voluntarios) {
  if (!voluntarios || voluntarios.length === 0) {
    return "VOLUNTARIOS DEL 3.º PUESTO: ninguno. NO asignes ningún código 3P este mes.";
  }
  const lista = voluntarios.map((v) => `  - id="${v.residenteId}" — voluntario desde ${v.desde}`).join("\n");
  return `VOLUNTARIOS DEL 3.º PUESTO (los ÚNICOS que pueden llevar código 3P):\n${lista}`;
}

/** Eventos del servicio del curso (INV-10). Dato de entrada, como los festivos: no se deducen. */
function seccionEventos(eventos) {
  if (!eventos || eventos.length === 0) {
    return "EVENTOS DEL SERVICIO (Navidad, cena de despedida): ninguno cargado. NO inventes fechas de\nevento ni apliques la norma 10.";
  }
  const lista = eventos.map((e) => {
    const quienes = e.voluntarios && e.voluntarios.length
      ? ` — sorteados: ${e.voluntarios.map((id) => `id="${id}"`).join(", ")}`
      : " — sin sorteo todavía";
    return `  - ${String(e.tipo).toUpperCase()} el ${e.fecha}${quienes}`;
  }).join("\n");
  return `EVENTOS DEL SERVICIO DE ESTE CURSO:\n${lista}`;
}

/**
 * Preferencias personales. Son BLANDAS por definición (V-6/V-8): `fechasEvitar` no la comprueba
 * ningún invariante y `maxGuardias` no puede saltarse el 4-6 de INV-2. Se marca en el texto para
 * que el modelo no las confunda con bloqueos — la ausencia de verdad va en su propia sección.
 */
// `maxGuardias` cuenta si es un número, INCLUIDO el 0: la pantalla lo permite con una ausencia
// registrada ese mes (mínimo 0 en vez de 4), y con un `||` de verdad/falso el 0 —que es justo la
// preferencia más fuerte que se puede expresar— desaparecía del prompt.
const tieneMax = (p) => typeof p.maxGuardias === "number" && Number.isFinite(p.maxGuardias);

function seccionPreferencias(preferencias) {
  const utiles = (preferencias || []).filter(
    (p) => (Array.isArray(p.fechasEvitar) && p.fechasEvitar.length) || tieneMax(p) || p.preferDobles || p.notas
  );
  if (utiles.length === 0) return "PREFERENCIAS PERSONALES DEL MES: ninguna registrada.";
  const lista = utiles.map((p) => {
    const partes = [];
    if (Array.isArray(p.fechasEvitar) && p.fechasEvitar.length) partes.push(`preferiría evitar ${p.fechasEvitar.join(", ")}`);
    if (tieneMax(p)) partes.push(p.maxGuardias === 0 ? "pide NO hacer ninguna guardia este mes (tiene una ausencia registrada)" : `querría no pasar de ${p.maxGuardias} guardias`);
    if (p.preferDobles) partes.push(`doblete preferido: ${String(p.preferDobles).toLowerCase().replace(/_/g, "-")}`);
    if (p.notas) partes.push(`nota: "${p.notas}"`);
    return `  - id="${p.residenteId}" — ${partes.join("; ")}`;
  }).join("\n");
  return `PREFERENCIAS PERSONALES DEL MES (BLANDAS: son deseos, no obligaciones — respétalas solo si\nno te obligan a incumplir ninguna norma de abajo):\n${lista}`;
}

/**
 * Guardias que YA están en la rejilla y hay que respetar (decisión V-47, modo «completar»). Son las
 * que cada residente apuntó de antemano porque ya las tenía comprometidas, o las que puso a mano
 * quien monta el cuadrante: el modelo tiene que construir el mes ALREDEDOR de ellas, no encima.
 * Se le pide que las repita tal cual en su respuesta para que su propuesta sea el mes entero y no
 * un parche, y el router descarta las repetidas al escribir. En modo «reemplazar» la lista llega
 * vacía y se dice, para que no las busque.
 */
function seccionFijadas(fijadas) {
  if (!fijadas || fijadas.length === 0) return "GUARDIAS YA FIJADAS EN LA REJILLA: ninguna. El mes empieza vacío.";
  const lista = fijadas
    .slice()
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
    .map((a) => `  - ${a.fecha} — id="${a.residenteId}" — ${a.codigo}`)
    .join("\n");
  return `GUARDIAS YA FIJADAS EN LA REJILLA (OBLIGATORIO respetarlas: inclúyelas TAL CUAL en tu respuesta
—misma fecha, mismo residenteId y mismo código—, no las muevas de día ni de persona, y no pongas
a otro residente del mismo grupo (Mayor/Pequeño) ese mismo día; cuentan para el 4-6 mensual y
para el descanso del día siguiente de quien las tiene):
${lista}`;
}

/** Bloque de residentes por nivel derivado, con su contaje acumulado. Un nivel vacío no sale. */
function seccionResidentes(porNivel, acumulados) {
  const bloques = NIVELES.map((nivel) => {
    const lista = (porNivel && porNivel[nivel]) || [];
    if (!lista.length) return null;
    const filas = lista.map((r) => {
      const resumen = resumenAcumulado(acumulados && acumulados[r.id]);
      const llevo = resumen ? `llevo hasta ahora: ${resumen}` : "sin guardias registradas todavía este año de residencia";
      return `  - id="${r.id}" — ${r.nombre} (${llevo})`;
    }).join("\n");
    return `${nivel} (${GRUPO_LABEL[nivel]}):\n${filas}`;
  }).filter(Boolean);
  return bloques.join("\n\n") || "(sin residentes activos este mes)";
}

/**
 * Prompt de generación. `datos` viene del router, ya derivado:
 *   { mes, anio, porNivel:{R4:[{id,nombre}],…}, acumulados:{id:{total,finde,…}}, bloqueos,
 *     festivos, puentes:[iso], voluntarios3P, eventos, preferencias,
 *     fijadas:[{fecha,residenteId,codigo}] }   ← las guardias ya puestas en la rejilla (V-47)
 */
export function buildGenerationPrompt(datos) {
  const { mes, anio } = datos;
  const titulo = nombreMes(anio, mes);
  return `Eres el generador del cuadrante de guardias de Radiodiagnóstico (Hospital Dr. Balmis).

RESIDENTES ACTIVOS EN ${titulo.toUpperCase()} — usa el "id" EXACTO como residenteId, nunca el
nombre. Junto a cada uno se indica el contaje acumulado de SU año de residencia en curso
(desde su último aniversario, hasta fin del mes anterior): úsalo para repartir con equidad
(±1) entre compañeros del mismo nivel, compensando a quien ya lleve más o menos guardias:

${seccionResidentes(datos.porNivel, datos.acumulados)}

${seccionFijadas(datos.fijadas)}

${seccionBloqueos(datos.bloqueos)}

${seccionFestivos(datos.festivos, datos.puentes)}

${seccionVoluntarios3P(datos.voluntarios3P)}

${seccionEventos(datos.eventos)}

${seccionPreferencias(datos.preferencias)}

NORMAS OPERATIVAS (resumen; ante la duda, prioriza la equidad):
1. Cada día lleva exactamente 1 guardia (G/GF/GP) de un residente Mayor (R3/R4) y 1 de un
   residente Pequeño (R1/R2). Excepción: 2 residentes R2 el mismo día solo se admite desde
   el 1 de diciembre y de forma justificada.
2. Cada residente hace entre 4 y 6 guardias computables (G+GF+GP) al mes; un Pequeño puede
   bajar excepcionalmente a 3 si la oferta de días no da para más.
3. Reparte con equidad (±1) dentro de cada año de residencia: total de guardias, findes,
   festivos, prefestivos y dobletes — usa el contaje acumulado de arriba como punto de
   partida, no repartas el mes como si todos empezaran de cero.
4. El 3.º puesto (código 3P) y las guardias cedidas/compradas no cuentan para el mínimo ni
   el máximo de guardias del punto 2.
5. Respeta la sección BLOQUEOS ACTIVOS de arriba: BAJA es obligatorio no asignar; VACACIONES
   y ROTACIÓN evita asignar si puedes, pero puedes hacerlo si no hay alternativa razonable.
6. Como máximo 2 residentes de la misma promoción (año de incorporación) pueden estar
   ausentes a la vez en rotación externa.
7. Si un residente rota en Alicante o provincia colindante (ver BLOQUEOS ACTIVOS), cúbrele
   guardia de viernes o de sábado durante esa rotación (basta con una de las dos, no hacen
   falta ambas — decisión P-6).
8. El 3.º puesto (3P) SOLO puede recaer en los VOLUNTARIOS listados arriba, nunca en otro
   residente. Recorre lunes→domingo antes de repetir día, con equidad entre ellos.
9. 2 residentes R2 el mismo día solo se admite desde el 1 de diciembre y justificado, o en
   un día de evento del servicio (Navidad, despedida).
10. Los eventos del servicio listados arriba se cubren con 2 R2 por sorteo documentado; si ya
    figuran los sorteados, respétalos. Usa EXCLUSIVAMENTE esas fechas: no deduzcas por tu
    cuenta cuándo cae la Navidad o la despedida del servicio.
11. Junio, julio y agosto: ningún R1 hace guardia — ese puesto de Pequeño lo cubren los R2,
    repartido con equidad entre ellos.
12. Usa el código GP para el prefestivo (la VÍSPERA de un festivo), GF para el propio festivo y
    G para el resto. Usa EXCLUSIVAMENTE las fechas festivas de la lista de arriba: no deduzcas
    festivos por tu cuenta ni por el calendario que creas recordar.
13. DESCANSO OBLIGATORIO: ningún residente puede hacer guardia dos días consecutivos, ni
    siquiera si una de las dos es un 3.º puesto. Cuenta también el borde con el mes anterior:
    si alguien tuvo guardia el último día del mes pasado, no puede tenerla el día 1.
14. Las GUARDIAS YA FIJADAS de la lista de arriba son inamovibles: repítelas tal cual en tu
    respuesta y reparte el resto del mes contando con ellas (para el 4-6 de cada uno, para la
    equidad y para el descanso del día siguiente).

FORMATO DE RESPUESTA (obligatorio, sin excepciones):
Responde ÚNICAMENTE con un JSON con esta forma exacta, sin texto ni bloques markdown
alrededor:
${RESPONSE_SHAPE}

Genera el cuadrante completo de ${titulo} (mes=${mes}, año=${anio}) respetando estas normas.`;
}

/**
 * Prompt de reintento. Le vuelve a dar el encargo entero (`prompt`), su propia propuesta anterior
 * y el motivo del rechazo, que es o bien un problema de FORMATO (`problema`) o bien la lista
 * concreta de violaciones del validador (`violaciones`).
 *
 * Se separan los `error` de los `aviso` a propósito: un modelo al que se le presentan quince
 * incumplimientos indistintos gasta el intento reescribiendo el mes entero para arreglar un aviso
 * de equidad que no bloquea nada, y vuelve con un `error` nuevo. Lo que impide guardar se dice
 * como obligatorio; lo demás, como mejora.
 */
export function buildRetryPrompt({ prompt, propuesta, violaciones, problema }) {
  const partes = [prompt, "", "─────────────────────────────────────────", ""];
  partes.push("Tu respuesta anterior NO se ha podido aceptar. Corrígela y vuelve a responder con el");
  partes.push("JSON completo del mes entero (no un parche, no solo los días que cambian).");
  partes.push("");

  if (problema) {
    partes.push(`PROBLEMA DE FORMATO: ${problema}`);
    partes.push("");
    partes.push(`Responde ÚNICAMENTE con el JSON de esta forma, sin nada alrededor:\n${RESPONSE_SHAPE}`);
    return partes.join("\n");
  }

  if (propuesta && propuesta.length) {
    partes.push("TU PROPUESTA ANTERIOR (la que hay que corregir):");
    partes.push(JSON.stringify({ asignaciones: propuesta }));
    partes.push("");
  }

  const errores = (violaciones || []).filter((v) => v.severidad === "error");
  const avisos = (violaciones || []).filter((v) => v.severidad !== "error");

  if (errores.length) {
    partes.push("OBLIGATORIO CORREGIR (el cuadrante no se puede guardar mientras siga incumpliendo esto):");
    for (const v of errores) partes.push(`  - [${v.invariante}] ${v.detalle}`);
    partes.push("");
  }
  if (avisos.length) {
    partes.push("MEJORA si puedes, sin romper nada de lo anterior (esto no impide guardar):");
    for (const v of avisos) partes.push(`  - [${v.invariante}] ${v.detalle}`);
    partes.push("");
  }
  partes.push(`Responde ÚNICAMENTE con el JSON de esta forma, sin nada alrededor:\n${RESPONSE_SHAPE}`);
  return partes.join("\n");
}

/**
 * Extrae el objeto JSON de una respuesta de modelo. Tolera la valla markdown y el párrafo de
 * cortesía porque los dos se han visto de verdad; no tolera nada más — adivinar más allá de eso
 * sería empezar a inventarle sentido a una respuesta que no lo tiene.
 */
function extraerJSON(texto) {
  const sinVallas = String(texto).replace(/```(?:json)?/gi, "");
  const abre = sinVallas.indexOf("{");
  const cierra = sinVallas.lastIndexOf("}");
  if (abre === -1 || cierra <= abre) return null;
  try {
    return JSON.parse(sinVallas.slice(abre, cierra + 1));
  } catch {
    return null;
  }
}

/**
 * Parsea y comprueba la FORMA de la respuesta (no las reglas de negocio: de eso se encarga el
 * validador, que es el único juez). Nunca lanza: devuelve `{ok:false, error}` con un motivo
 * legible, porque ese motivo se le devuelve al modelo en el reintento.
 *
 * @returns {{ok:true, asignaciones:{fecha:string,residenteId:string,codigo:string}[]}
 *          |{ok:false, error:string}}
 */
export function parseGenerationResponse(texto) {
  if (typeof texto !== "string" || texto.trim() === "") {
    return { ok: false, error: "la respuesta del modelo llegó vacía" };
  }
  const obj = extraerJSON(texto);
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "la respuesta no contiene ningún JSON que se pueda leer" };
  }
  if (!Array.isArray(obj.asignaciones)) {
    return { ok: false, error: 'el JSON no trae una lista "asignaciones"' };
  }
  if (obj.asignaciones.length === 0) {
    return { ok: false, error: "la lista `asignaciones` viene vacía: un mes sin ninguna guardia no es una propuesta" };
  }

  const asignaciones = [];
  for (const a of obj.asignaciones) {
    if (!a || typeof a !== "object") return { ok: false, error: "hay un elemento de `asignaciones` que no es un objeto" };
    if (typeof a.fecha !== "string" || !ISO_RE.test(a.fecha)) {
      return { ok: false, error: `fecha inválida: ${JSON.stringify(a.fecha)} (el formato es "YYYY-MM-DD")` };
    }
    if (typeof a.residenteId !== "string" || a.residenteId === "") {
      return { ok: false, error: `falta el residenteId en la asignación del ${a.fecha}` };
    }
    if (CODIGOS_PROPONIBLES.indexOf(a.codigo) === -1) {
      return { ok: false, error: `código inválido: ${JSON.stringify(a.codigo)} (los únicos válidos son ${CODIGOS_PROPONIBLES.join(", ")})` };
    }
    // Se copian SOLO los tres campos del schema: `puesto` se deriva del nivel y `origen` marca una
    // guardia cedida (INV-4), que el modelo no tiene por qué decidir ni sabe si existió.
    asignaciones.push({ fecha: a.fecha, residenteId: a.residenteId, codigo: a.codigo });
  }
  return { ok: true, asignaciones };
}

// Esquema de las pestañas de datos normalizadas (ADR-002 D-3). PURO: solo define las tablas
// y el mapeo fila↔registro por tipos. La fuente de verdad es append-only con clave UUID
// (spec §2 / ADR-001 §3): nunca se reescribe una fila cruda, solo se añaden.
//
// Los valores viajan a/desde el Sheet como celdas; cada columna declara su tipo para
// recuperar números/booleanos/JSON sin ambigüedad (un `anio` debe volver como number, no "3").

const col = (key, type = "string") => ({ key, type });

export const TABLES = {
  residentes: { name: "residentes", columns: [col("id"), col("nombre"), col("email"), col("fechaInicio", "date"), col("fechaFin", "date")] },
  periodos: { name: "periodos", columns: [col("id"), col("residenteId"), col("anio", "number"), col("fechaInicio", "date"), col("fechaFin", "date")] },
  bloqueos: { name: "bloqueos", columns: [col("id"), col("residenteId"), col("desde", "date"), col("hasta", "date"), col("motivo"), col("provincia"), col("guardiasEnCentroExterno", "bool"), col("activo", "bool")] },
  asignaciones: { name: "asignaciones", columns: [col("id"), col("fecha", "date"), col("residenteId"), col("codigo"), col("puesto"), col("origen")] },
  // Festivos: DATO DE ENTRADA, nunca derivado ni delegado a la IA (S-4; el cliente v1 le pedía
  // al modelo "identifícalos tú"). `anio` NO se almacena, se deriva de `fecha` (§1). `activo`
  // permite corregir una fecha mal cargada reinsertando la fila con activo=false, igual que
  // `bloqueos` — la tabla no se reescribe nunca. `ambito` (NACIONAL/AUTONOMICO/LOCAL) es
  // informativo: los locales de Alicante son festivos reales y cambian de fecha cada año, así
  // que sin ellos INV-12 avisaría en falso sobre GF correctas.
  festivos: { name: "festivos", columns: [col("id"), col("fecha", "date"), col("nombre"), col("ambito"), col("activo", "bool")] },
  // Eventos del servicio (INV-10, decisión V-20): comida de Navidad y despedida de R4. Son
  // DATOS DE ENTRADA como los festivos —la fecha la pone el servicio cada año, no se deriva de
  // nada— y por eso la tabla se parece a `festivos`: append-only, `activo` para corregir por
  // reinserción. `designados` se ALMACENA (no se deriva de quién tuviera guardia ese día):
  // validar la despedida de mayo necesita saber quién cubrió la Navidad del diciembre anterior,
  // y guardarlo evita que junio tenga que leer las asignaciones de diciembre. La contrapartida,
  // aceptada: si alguien cambia la guardia del día de Navidad después, esta lista no se entera.
  // `sorteoId` apunta a la tabla `sorteos` (la misma de INV-14): es lo que hace comprobable el
  // «a sorteo» de la normativa en vez de un booleano que nadie puede verificar.
  eventos: { name: "eventos", columns: [col("id"), col("tipo"), col("fecha", "date"), col("voluntarios", "json"), col("designados", "json"), col("sorteoId"), col("activo", "bool")] },
  // Imaginaria (INV-13, decisión V-20). NO se almacena la cola: se registra cada cobertura real
  // y la cola se DERIVA de ese historial (§1, «derivar > almacenar»), igual que el nivel R1-R4.
  // Una guardia de incidencia cedida o comprada no genera fila, y por eso no mueve a nadie en la
  // cola — literal de la normativa p.4.
  imaginaria: { name: "imaginaria", columns: [col("id"), col("grupo"), col("fechaIncidencia", "date"), col("residenteId"), col("registradaEn", "date"), col("activo", "bool")] },
  responsables: { name: "responsables", columns: [col("id"), col("periodoInicio", "date"), col("periodoFin", "date"), col("residenteId"), col("metodo"), col("voluntarios", "json"), col("semilla"), col("candidatos", "json"), col("fechaSorteo", "date")] },
  voluntariosResponsable: { name: "voluntariosResponsable", columns: [col("id"), col("residenteId"), col("periodoInicio", "date"), col("activo", "bool")] },
  // Voluntarios del TERCER PUESTO (INV-8a, decisión V-18). Se parece a voluntariosResponsable
  // —append-only, `activo` para retirarse reinsertando— pero NO lleva `periodoInicio`: el 3P no
  // se elige por periodos comunes, cada residente se apunta el día que quiere y su ciclo L-D
  // (INV-8b) arranca ahí. Por eso `desde` es la fecha de alta real y no un borde de calendario:
  // es lo que `thirdPostHistoryStart` usa para saber desde cuándo leer el historial, y lo que
  // fija el compromiso de permanencia de 4 meses (`thirdPostCommitmentEnd`). Se guarda además
  // `compromisoAceptado` porque el compromiso se acepta explícitamente al apuntarse: sin dejar
  // constancia, negarle a alguien la retirada sería una regla que nadie aceptó.
  // `hasta` solo lo escribe la retirada, y hoy no lo lee ningún invariante: existe porque sin él
  // la fila de baja es indistinguible de la de alta y la fecha en que alguien dejó el 3P se
  // perdería para siempre en una tabla cuyo sentido es que el historial no se borra nunca. Lo
  // necesitará quien arregle la laguna anotada en §7: INV-8a juzga un mes pasado con la lista de
  // HOY, así que a quien se retiró en diciembre le avisa en falso por los 3P que hizo en julio.
  voluntarios3P: { name: "voluntarios3P", columns: [col("id"), col("residenteId"), col("desde", "date"), col("hasta", "date"), col("compromisoAceptado", "bool"), col("activo", "bool")] },
  sorteos: { name: "sorteos", columns: [col("id"), col("fecha", "date"), col("motivo"), col("semilla"), col("candidatos", "json"), col("resultado", "json")] },
  // Fase 4: diasPreferidos/diasEvitar (día de semana genérico) y rotDe/rotHasta/vacDe/vacHasta
  // (número de día suelto) del v1 se sustituyen por fechas concretas (BLANDO) y por la tabla
  // `bloqueos` — spec.md §5 Fase 4: "distingue DURO vs BLANDO, son cosas distintas". Desde V-8
  // (Fase 5.x) la severidad dentro de `bloqueos` ya no es uniforme: solo motivo BAJA bloquea
  // la asignación (INV-5); VACACIONES/ROTACION son informativas.
  // preferDobles pasó de bool a enum de texto ("" | VIERNES_DOMINGO | JUEVES_SABADO) el
  // 2026-08-08, a petición del autor — ver client/screens/Prefs.jsx:DOBLETE_LABEL. Las filas
  // viejas con TRUE/FALSE se leen tal cual (string plana) y no calzan con ningún valor del
  // nuevo enum: no rompen nada, simplemente no coinciden hasta que el residente vuelva a guardar.
  preferencias: { name: "preferencias", columns: [col("id"), col("residenteId"), col("anio", "number"), col("mes", "number"), col("maxGuardias", "number"), col("preferDobles"), col("fechasEvitar", "json"), col("notas")] },
  // Fase 6.2: ciclo BORRADOR|VALIDADO|PUBLICADO por mes+año (spec.md §2 Cuadrante). Cada fila
  // es UNA transición de estado (append-only, `readLatest` por mes|anio se queda con la
  // última); `actorId`/`fecha` identifican quién la disparó y cuándo, sin distinguir un campo
  // por tipo de transición (generadoPor/validadoPor/...) — el historial completo de quién hizo
  // qué ya queda en las filas append-only anteriores si algún día hace falta auditarlo.
  cuadrantes: { name: "cuadrantes", columns: [col("id"), col("mes", "number"), col("anio", "number"), col("estado"), col("actorId"), col("fecha", "date")] },
  // Bitácora de las generaciones con IA (decisión V-43). NO guarda el cuadrante —eso son filas de
  // `asignaciones`— sino QUÉ pasó cada vez que alguien pulsó el botón: el modelo que respondió,
  // cuántas vueltas del ciclo hicieron falta y con qué quedó. Es lo único que convierte «lo propuso
  // una IA» en algo comprobable meses después, cuando `asignaciones` ya no distingue quién escribió
  // cada fila, y es también la «marca para revisión manual»: un `resultado=REVISION_MANUAL` dice
  // que ese mes hubo que montarlo a mano porque el modelo no supo. Append-only y sin `activo`: aquí
  // no hay nada que cancelar, solo cosas que pasaron.
  generaciones: { name: "generaciones", columns: [col("id"), col("mes", "number"), col("anio", "number"), col("fecha", "date"), col("actorId"), col("modelo"), col("intentos", "number"), col("resultado"), col("violaciones", "json")] },
  // Excepcion (spec.md §2, decisión V-29): degrada una violación DURA→AVISO donde la normativa lo
  // permite. Hoy el único consumidor es `validate.js:twoR2Justified` (INV-9, tipo "2xR2"): un
  // 2×R2 dentro de [desde,hasta] deja de avisar si hay una excepción documentada que lo cubra.
  // Append-only como `festivos`/`eventos`: `activo` corrige por reinserción, nunca se borra una
  // fila. `tipo` es el identificador que lee el dominio (no `INV-n`: un mismo invariante podría
  // en el futuro tener más de un tipo de excepción), y añadir uno nuevo exige cablearlo en
  // `validateMonth`/`buildMonthContext` para que tenga efecto — la tabla por sí sola no hace nada.
  excepciones: { name: "excepciones", columns: [col("id"), col("tipo"), col("desde", "date"), col("hasta", "date"), col("justificacion"), col("registradaPor"), col("fecha", "date"), col("activo", "bool")] },
};

/** Cabecera (nombres de columna) de una tabla. */
export function headerOf(table) {
  return table.columns.map((c) => c.key);
}

/** Registro → fila de celdas, en el orden de las columnas. */
export function recordToRow(table, record) {
  return table.columns.map((c) => serialize(record[c.key], c.type));
}

/** [cabecera, ...filas] → registros. Ignora la cabecera y mapea por posición de columna. */
export function rowsToRecords(table, values) {
  if (!values || values.length <= 1) return [];
  return values.slice(1).map((row) => {
    const rec = {};
    table.columns.forEach((c, i) => {
      const v = deserialize(row[i], c.type);
      if (v !== undefined) rec[c.key] = v;
    });
    return rec;
  });
}

function serialize(value, type) {
  if (value === undefined || value === null) return "";
  switch (type) {
    case "number": return String(value);
    case "bool": return value ? "TRUE" : "FALSE";
    case "json": return JSON.stringify(value);
    // Bug real (Fase 2.6/7.1, primer uso en vivo): Sheets detecta un string "YYYY-MM-DD" y
    // convierte la celda a tipo Fecha interno; el apóstrofe fuerza texto plano (invisible
    // tras guardar, por UI o por API) para que la celda se quede como el string que mandamos.
    case "date": return `'${value}`;
    default: return String(value);
  }
}

function deserialize(cell, type) {
  if (cell === undefined || cell === null || cell === "") return undefined;
  switch (type) {
    case "number": return Number(cell);
    case "bool": return cell === true || cell === "TRUE" || cell === "true";
    case "json": try { return JSON.parse(cell); } catch { return undefined; }
    // Contraparte de "date" en serialize: si el apóstrofe no llegó a evitar la conversión
    // (celda ya corrompida de antes de este fix, o algún borde de Sheets que lo ignore),
    // `cell` llega como un Date real — se recupera "YYYY-MM-DD" con getters LOCALES (no
    // UTC: Apps Script corre con el huso horario del proyecto, el mismo que ancló la
    // medianoche de esa celda — distinto del "siempre UTC" del dominio, pensado para el
    // navegador). Si no, es el string con apóstrofe (el `ss` falso de los tests no simula
    // el despojo de Sheets, así que llega literal).
    case "date": return cell instanceof Date ? isoFromLocalDate(cell) : String(cell).replace(/^'/, "");
    default: return String(cell);
  }
}

function isoFromLocalDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

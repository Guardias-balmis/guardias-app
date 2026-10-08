// Router del Web App (ADR-002 D-2/D-4, paso 2.4). PURO: recibe el cuerpo crudo (el JSON que
// el cliente manda como text/plain, D-1) y unas dependencias inyectadas; devuelve un objeto
// plano que el wrapper `doPost` de Apps Script serializa. Ningún camino lanza: toda entrada
// es hostil (endpoint ANYONE_ANONYMOUS) → siempre se devuelve JSON, nunca el HTML de error.
//
// Identidad: el ID token se verifica UNA vez en `login`; a partir de ahí, cada acción lleva
// el token de sesión HMAC (validado en local, sin red). El rol se DERIVA de la tabla de
// responsables (nunca es un flag que el cliente pueda falsear).

import { issueSession, verifySession } from "./session.js";
import { verifyTokeninfo } from "./verify-token.js";
import { buildGenerationPrompt } from "./ai-prompt.js";
import { generateSchedule } from "./ai-generator.js";

const ASIG_KEY = (r) => `${r.fecha}|${r.residenteId}`;
const PREF_KEY = (r) => `${r.residenteId}|${r.anio}|${r.mes}`;
const CUAD_KEY = (r) => `${r.mes}|${r.anio}`;
// Los periodos se corrigen REINSERTANDO las 4 filas (append-only), así que el estado actual es la
// última fila por residente+año — nunca se reescribe ni se borra ninguna.
const PERIODO_KEY = (r) => `${r.residenteId}|${r.anio}`;
const EVENTO_TIPOS = new Set(["NAVIDAD", "DESPEDIDA"]); // los dos eventos del servicio (INV-10)
// Tipos de Excepcion que el dominio realmente consume (V-29). Lista blanca deliberada: crear una
// excepción de un tipo que `validateMonth` no lee sería una fila muerta que nadie avisa que no
// sirve para nada.
const EXCEPCION_TIPOS = new Set(["2xR2"]);
const BLOQ_MOTIVOS = new Set(["VACACIONES", "ROTACION", "BAJA", "CONGRESO"]); // enum de motivos válidos (severidad mixta desde V-8: solo BAJA bloquea la asignación)
// Códigos de asignación (spec.md §2 + `CODES_CYCLE` del cliente). El "" es el BORRADO explícito:
// `readLatest("asignaciones", …, { emptyField: "codigo" })` lo usa para quitar una asignación sin
// borrar la fila, así que la lista blanca tiene que admitirlo. Existe porque sin ella entraba
// cualquier cadena y las erratas son MUDAS: una "g" minúscula no la reconoce ni `GUARDIA` (INV-1
// da el día por descubierto) ni `tally` (no cuenta para nada), y nadie avisa.
const ASIG_CODIGOS = new Set(["G", "GF", "GP", "3P", "V", "R", "B", "C", ""]);
// Modos de `generarCuadranteIA` (decisión V-47). COMPLETAR es el defecto: respeta las guardias que
// ya hay en la rejilla y rellena el resto. REEMPLAZAR es el comportamiento original de V-45:
// sustituye el mes entero. Lista blanca porque un modo mal escrito no puede degradar en silencio
// a «reemplazar» —que borra— cuando quien pulsó quería conservar.
const MODOS_GENERACION = new Set(["completar", "reemplazar"]);
// Fases del generador (P-17/V-59). «obligatorias»: las 4 de cada uno, sobre un Borrador (lo de
// V-45/V-47). «extras»: quintas/sextas voluntarias y tercer puestos, que SOLO añaden, sobre un mes
// Borrador o ya VALIDADO. Lista blanca por lo mismo que los modos: una fase mal escrita no puede
// degradar en silencio a la que sustituye guardias.
const FASES_GENERACION = new Set(["obligatorias", "extras"]);
// Los niveles a los que se puede asignar guardia (los que el prompt lista), los códigos que ocupan
// puesto en la rejilla y los marcadores apuntados a mano: mismos conjuntos que `residents.js:LEVELS`,
// `validate.js:OCUPA_PUESTO` y `apply.js:MARCADORES_REJILLA`.
const NIVELES_ASIGNABLES = new Set(["R1", "R2", "R3", "R4"]);
const CODIGOS_GUARDIA = new Set(["G", "GF", "GP", "3P"]);
const MARCADORES_REJILLA = new Set(["V", "R", "B", "C"]);
// Tope de violaciones que se persisten por fila de `generaciones`: una celda de Sheets admite
// 50.000 caracteres y una respuesta hostil (500 ids inventados) daba ~96 KB de JSON.
const BITACORA_MAX_VIOLACIONES = 50;
// …y en caracteres: 50 violaciones con un `detalle` de 1.000 caracteres cada una (ids de 1.000
// caracteres inventados por el modelo) seguirían pasando de 50.000. Margen sobre el límite de Sheets.
const BITACORA_MAX_CHARS = 40000;
const BITACORA_MAX_DETALLE = 300;
// `origen` marca la guardia cedida o comprada, que INV-4 excluye de los seis ejes de INV-3.
// `tally.js:15` lo evalúa por TRUTHINESS, así que una errata cualquiera —no solo un valor de otro
// enum— saca la guardia del cómputo y de los totales de la pestaña publicada, en silencio.
const ASIG_ORIGENES = new Set(["CEDIDA", "COMPRADA"]);
// `puesto` (spec.md §2 Asignacion): hoy ningún cliente lo manda y ningún invariante lo lee —el
// puesto se deriva del nivel—, pero la columna existe y el endpoint es público.
const ASIG_PUESTOS = new Set(["MAYOR", "PEQUENO", "TERCERO"]);

/**
 * @param {string} rawBody  cuerpo crudo de la petición (JSON en text/plain)
 * @param {object} deps  { now, today, clientId, sessionSecret, sessionTtl, crypto,
 *                         store, domain, issueNonce, consumeNonce, fetchTokeninfo }
 */
/**
 * Respuesta de `doGet` (Code.gs). El cliente lo pide TODO por POST —también el nonce, con
 * `getNonce`—, así que a `doGet` solo llega un POST que Google ha convertido en GET por el camino
 * (un 301/302 cambia el método y tira el cuerpo, según el estándar Fetch) o alguien que abre la URL
 * `/exec` en el navegador. Hasta el 2026-10-07 respondía `{ok:true, nonce}`: una lectura recibía
 * `ok:true` sin su lista —el `.length` de undefined que tumbó «Solicitudes de acceso» en
 * producción— y una escritura se daba por hecha sin haberse ejecutado. Un GET no puede ser nunca
 * la respuesta a lo que pidió la app, así que es un error explícito.
 */
export function handleGet() {
  return { ok: false, error: "la petición llegó sin datos (GET): la app solo usa POST; vuelve a intentarlo" };
}

export function handleRequest(rawBody, deps) {
  try {
    let req;
    try {
      req = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: "cuerpo no es JSON válido" };
    }
    if (!req || typeof req !== "object") return { ok: false, error: "petición inválida" };

    switch (req.action) {
      case "getNonce":
        return { ok: true, nonce: deps.issueNonce() };

      case "login":
        return handleLogin(req, deps);

      // Desde V-54 el alta ya no es autoservicio: se SOLICITA y la aprueba un administrador. Esta
      // acción se queda para que un cliente viejo reciba un motivo y no un «acción desconocida».
      case "altaResidente":
        return { ok: false, error: "el alta de un residente requiere la aprobación de un administrador: actualiza la página" };

      case "solicitarAlta":
        return handleSolicitarAlta(req, deps);

      // Solicitudes de acceso (V-53 invitado, V-54 alta de residente): solo con la aprobación de un
      // administrador dentro de los 5 minutos siguientes a la solicitud.
      case "solicitarInvitado":
        return handleSolicitarInvitado(req, deps);

      case "estadoSolicitudInvitado":
        return handleEstadoSolicitudInvitado(req, deps);

      case "listSolicitudesInvitado":
        return authed(req, deps, (session) => {
          const denegado = requireValidarPermiso(deps, session, "gestionar las solicitudes de acceso");
          if (denegado) return denegado;
          return { ok: true, solicitudes: solicitudesPendientes(deps) };
        });

      case "resolverSolicitudInvitado":
        return authed(req, deps, (session) => {
          const denegado = requireValidarPermiso(deps, session, "gestionar las solicitudes de acceso");
          if (denegado) return denegado;
          return handleResolverSolicitud(req, deps, session);
        });

      case "whoami":
        return authed(req, deps, (session) => ({ ok: true, sub: session.sub, rol: session.rol }));

      // Varias LECTURAS en una sola petición (S-9). Cada petición al `/exec` paga unos 3 s de
      // arranque + redirección de Google aunque la ejecución dure 300 ms, así que Inicio y el
      // cuadrante, que lanzan 3-5 lecturas a la vez, tardaban lo de la más lenta de una cola. Cada
      // llamada interior pasa por `handleRequest` entera —con su `authed`, su perfil de invitado y
      // sus permisos— y comparten la memoria de lecturas de esta petición.
      case "lote":
        return handleLote(req, deps);

      case "validar":
        return authed(req, deps, () => {
          // Mismo tratamiento que en `marcarValidado` (V-22): aquí los bloqueos los manda el
          // cliente, que los saca de `listBloqueos` — y esa acción devuelve también las filas con
          // fecha ilegible, para que se puedan cancelar. Esta acción no llama a los cierres de
          // equidad, así que no hay riesgo de excepción; lo que se evita es que INV-5 dé un
          // veredicto a suerte sobre una fecha que no se puede leer, y lo que se gana es que
          // `Calendar.jsx` —que valida por aquí— diga qué fila hay que arreglar en vez de callarse.
          const cuadrante = req.cuadrante && typeof req.cuadrante === "object" ? req.cuadrante : {};
          const { usables, corruptas } = partitionBloqueos(deps, Array.isArray(cuadrante.bloqueos) ? cuadrante.bloqueos : []);
          const violaciones = [
            ...bloqueoCorruptoViolations(corruptas),
            ...deps.domain.validateMonth({ ...cuadrante, bloqueos: usables }),
          ];
          return { ok: true, violaciones, bloqueantes: violaciones.filter((v) => v.severidad === "error").length };
        });

      case "listResidentes":
        return authed(req, deps, (session) => ({ ok: true, residentes: paraSesion(allResidentes(deps), session, deps) }));

      // Corregir las fechas de un residente. Hasta ahora `fechaInicio`/`fechaFin` solo se escribían
      // en el alta (`handleAlta`) y no había forma de tocarlas después, lo que dejaba sin salida
      // dentro de la app el caso que V-21 tuvo que degradar a `aviso`: una `fechaFin` mal teclada
      // hacía que INV-1 avisara de una asignación «a quien no es residente asignable» sin que nadie
      // pudiera arreglar la causa. Append-only: se reinserta la fila con el MISMO id (readLatest
      // resuelve), nunca se reescribe.
      case "editarResidente":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "corregir las fechas de un residente");
          if (denegado) return denegado;
          const actual = allResidentes(deps).find((r) => r.id === req.residenteId);
          if (!actual) return { ok: false, error: "el residente no existe" };

          const fechaInicio = req.fechaInicio || actual.fechaInicio;
          const fechaFin = req.fechaFin || actual.fechaFin;
          const malRango = validRango({ desde: fechaInicio, hasta: fechaFin }, deps);
          if (malRango.ok === false) return malRango;

          // El email y el nombre NO se tocan aquí: el email es la llave del login y cambiarlo por
          // este camino dejaría a alguien fuera de la app sin que se note hasta que intente entrar.
          deps.store.appendRecord("residentes", { ...actual, fechaInicio, fechaFin });
          return { ok: true, residenteId: req.residenteId, fechaInicio, fechaFin };
        });

      // Periodos formativos editados (nota [a] de la normativa: «los periodos generados son
      // editables después»). Es el dato que permite expresar que una baja larga RETRASA la
      // promoción — y por eso lo escribe quien reparte y no el propio residente: el retraso lo
      // decide tutoría, no se deriva de la tabla `bloqueos` (una baja de dos semanas no retrasa
      // nada, y adivinarlo cambiaría el nivel de alguien sin que nadie lo haya decidido).
      case "guardarPeriodos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "editar los periodos formativos de un residente");
          if (denegado) return denegado;
          if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
            return { ok: false, error: "el residente no existe" };
          }
          if (!Array.isArray(req.periodos)) return { ok: false, error: "periodos debe ser una lista de 4" };

          // Forma de la tabla → forma del dominio, para poder validar con el dominio. La traducción
          // inversa la hace `allResidentes`; que las dos vivan en este fichero es a propósito.
          const enDominio = req.periodos.map((p) => ({ year: Number(p.anio), start: p.fechaInicio, end: p.fechaFin }));
          for (const p of enDominio) {
            const malRango = validRango({ desde: p.start, hasta: p.end }, deps);
            if (malRango.ok === false) return { ok: false, error: `periodo R${p.year}: ${malRango.error}` };
          }
          // `validateTrainingPeriods` existe justo para esto y no la llamaba NADIE (exactamente 4,
          // años 1..4 en orden, sin solapes; los huecos SÍ se permiten, que es S-3: una baja
          // retrasa la promoción, no des-promociona).
          const errores = deps.domain.validateTrainingPeriods(enDominio);
          if (errores.length) return { ok: false, error: errores.join("; ") };

          // Las 4 filas de golpe (`appendRecords`, un solo lock) y con el id derivado de
          // residente+año: reinsertar el mismo par SUSTITUYE por `readLatest`, sin borrar nada.
          deps.store.appendRecords("periodos", enDominio.map((p) => ({
            id: `${req.residenteId}|${p.year}`, residenteId: req.residenteId,
            anio: p.year, fechaInicio: p.start, fechaFin: p.end,
          })));
          return { ok: true, residenteId: req.residenteId, periodos: enDominio };
        });

      // Volver a los periodos derivados de las fechas: reinserta las 4 filas con el rango que
      // `defaultTrainingPeriods` calcularía. Sin esto, unos periodos mal editados serían
      // irreversibles (la tabla es append-only y `allResidentes` exige las 4), y eso es un bloqueo
      // sin salida dentro de la herramienta — lo mismo que V-16 tuvo que arreglar de urgencia.
      case "restaurarPeriodos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "restaurar los periodos formativos de un residente");
          if (denegado) return denegado;
          const actual = allResidentes(deps).find((r) => r.id === req.residenteId);
          if (!actual) return { ok: false, error: "el residente no existe" };
          const derivados = deps.domain.periodsOfResident({ fechaInicio: actual.fechaInicio, fechaFin: actual.fechaFin });
          deps.store.appendRecords("periodos", derivados.map((p) => ({
            id: `${req.residenteId}|${p.year}`, residenteId: req.residenteId,
            anio: p.year, fechaInicio: p.start, fechaFin: p.end,
          })));
          return { ok: true, residenteId: req.residenteId, periodos: derivados };
        });

      case "listAsignaciones":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          const prefix = monthPrefix(req.anio, req.mes);
          const all = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          return { ok: true, asignaciones: asignacionesParaSesion(all.filter((a) => a.fecha.startsWith(prefix)), session) };
        });

      // A diferencia de listAsignaciones (filtra por mes/año), esta filtra por rango de
      // fechas ISO [desde,hasta] pudiendo cruzar meses o años — la usa el cliente para el
      // contrato C-2 (INV-7 necesita las asignaciones de TODO el periodo de rotación,
      // aunque empiece en un mes anterior) y para el contaje acumulado del generador (§4).
      case "listAsignacionesRango":
        return authed(req, deps, (session) => {
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;
          const all = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          return { ok: true, asignaciones: asignacionesParaSesion(all.filter((a) => a.fecha >= req.desde && a.fecha <= req.hasta), session) };
        });

      // Consciente del ciclo de estados (Fase 6.2): PUBLICADO bloquea cualquier edición del mes
      // (decisión V-9b); editar un mes VALIDADO lo invalida y lo revierte a BORRADOR (decisión
      // de Fase 6.2 — "vuelve a BORRADOR automáticamente", sin fricción para quien edita).
      case "guardarAsignaciones":
        return authed(req, deps, (session) => {
          if (!Array.isArray(req.cambios) || req.cambios.length === 0) return { ok: false, error: "cambios vacío" };
          if (req.cambios.some((c) => !c || typeof c !== "object")) return { ok: false, error: "cambio inválido: cada cambio es un objeto {fecha, residenteId, codigo}" };
          let fechas;
          try {
            fechas = req.cambios.map((c) => deps.domain.parseISO(c.fecha));
          } catch (e) {
            return { ok: false, error: "cambio con fecha inválida: " + e.message };
          }
          // Listas blancas de `codigo` y `origen`: la tabla es append-only y el Sheet se edita a
          // mano, así que lo que entre mal se queda para siempre y encima no se nota (ver el
          // comentario de ASIG_CODIGOS/ASIG_ORIGENES).
          const malCodigo = req.cambios.find((c) => !ASIG_CODIGOS.has(c.codigo || ""));
          if (malCodigo) return { ok: false, error: `código de asignación inválido: ${JSON.stringify(malCodigo.codigo)} (válidos: ${[...ASIG_CODIGOS].filter(Boolean).join(", ")})` };
          const malOrigen = req.cambios.find((c) => c.origen !== undefined && c.origen !== "" && !ASIG_ORIGENES.has(c.origen));
          if (malOrigen) return { ok: false, error: `origen inválido: ${JSON.stringify(malOrigen.origen)} (válidos: ${[...ASIG_ORIGENES].join(", ")})` };
          // El residente tiene que existir (2026-09-04): una fila con un id que no es de nadie no la
          // ve ninguna pantalla ni la puede borrar nadie, y se queda para siempre en una tabla
          // append-only —el mismo motivo por el que el generador rechaza los ids inventados (V-31).
          const conocidos = new Set(allResidentes(deps).map((r) => r.id));
          const malResidente = req.cambios.find((c) => typeof c.residenteId !== "string" || !conocidos.has(c.residenteId));
          if (malResidente) return { ok: false, error: `residenteId desconocido: ${JSON.stringify(malResidente.residenteId)}` };
          const malPuesto = req.cambios.find((c) => c.puesto !== undefined && c.puesto !== "" && !ASIG_PUESTOS.has(c.puesto));
          if (malPuesto) return { ok: false, error: `puesto inválido: ${JSON.stringify(malPuesto.puesto)} (válidos: ${[...ASIG_PUESTOS].join(", ")})` };
          // El estado se lee y se escribe DENTRO del mismo lock que `marcarValidado`/`publicarCuadrante`
          // (2026-09-04): leído fuera, una celda que esperaba al lock mientras otro validaba el mes
          // veía BORRADOR, no escribía transición y se colaba en un mes ya VALIDADO — con lo que un
          // mes validado podía tener guardias que nadie validó. Leído dentro ve VALIDADO y lo devuelve
          // a BORRADOR, que es lo que `stateAfterEdit` siempre quiso decir.
          return atomico(deps, () => {
            const meses = [...new Map(fechas.map((f) => [`${f.year}-${f.month}`, f])).values()]
              .map((f) => ({ mes: f.month, anio: f.year, estado: currentCuadranteEstado(deps, f.month, f.year) }));
            const publicado = meses.find((m) => !deps.domain.canEdit(m.estado));
            if (publicado) return { ok: false, error: `el cuadrante de ${publicado.mes}/${publicado.anio} está PUBLICADO y no admite ediciones` };

            // Lo OPCIONAL no invalida un mes VALIDADO (P-16, P-17/V-58): añadir o quitar un TERCER PUESTO. Es un
            // apoyo voluntario —el que se añade el último a la guardia y se va a las 20 h—, casi nunca de
            // las cuatro obligatorias, y la reunión que validó las obligatorias no tiene por qué repetirse
            // cada vez que alguien se apunta uno o se lo quita. Se mira el estado ACTUAL de cada celda,
            // dentro del lock: solo cuenta como «quitar» el cambio que deja vacía una celda que ahora es un
            // 3P, y como «añadir» el que escribe un 3P en una celda VACÍA — convertir en 3P una guardia
            // de la base la cambia, y eso sí invalida.
            const actuales = new Map(deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" }).map((x) => [ASIG_KEY(x), x]));
            const vacia = (c) => (c.codigo || "") === "";
            const quitaTercerPuesto = (c) => vacia(c) && actuales.get(ASIG_KEY(c))?.codigo === "3P";
            const anadeTercerPuesto = (c) => c.codigo === "3P" && !actuales.has(ASIG_KEY(c));
            const soloOpcional = req.cambios.every((c) => quitaTercerPuesto(c) || anadeTercerPuesto(c));

            // Añadir un 3P a un mes VALIDADO no se hace a ciegas: tiene que pasar por lo que el mes ya tenía
            // que cumplir (el descanso de INV-15, una baja de INV-5…). Se juzga el mes RESULTANTE y se rechaza
            // solo por errores NUEVOS: uno que el mes ya traía no es culpa de este cambio.
            if (soloOpcional && req.cambios.some(anadeTercerPuesto)) {
              for (const m of meses.filter((x) => x.estado === "VALIDADO")) {
                const snap = monthSnapshot(deps);
                const prefix = monthPrefix(m.anio, m.mes);
                const resultante = new Map(snap.asignaciones.filter((a) => a.fecha.startsWith(prefix)).map((a) => [ASIG_KEY(a), a]));
                for (const c of req.cambios.filter((x) => x.fecha.startsWith(prefix))) resultante.set(ASIG_KEY(c), { ...c, codigo: c.codigo || "" });
                const errores = (propuesta) => deps.domain.validateMonth(buildCuadranteCtx(deps, m.mes, m.anio, snap, propuesta)).filter((v) => v.severidad === "error");
                const firma = (v) => `${v.invariante}|${v.fecha || ""}|${v.residenteId || ""}|${v.detalle}`;
                const antes = new Set(errores(null).map(firma));
                const nuevos = errores([...resultante.values()].filter((a) => a.codigo)).filter((v) => !antes.has(firma(v)));
                if (nuevos.length > 0) {
                  return { ok: false, error: `el tercer puesto incumple una regla obligatoria (${nuevos[0].invariante}): ${nuevos[0].detalle}`, violaciones: nuevos };
                }
              }
            }

            // Una sola escritura para todo el lote (appendRecords): un mes del generador son
            // ~60-90 cambios y fila a fila era un lock y una relectura íntegra de la tabla por cada
            // uno. Además así el lote es atómico y no puede quedar medio aplicado.
            deps.store.appendRecords("asignaciones", req.cambios.map((c) => (
              { fecha: c.fecha, residenteId: c.residenteId, codigo: c.codigo || "", puesto: c.puesto, origen: c.origen }
            )));
            const estados = [];
            for (const m of meses) {
              const siguiente = soloOpcional ? m.estado : deps.domain.stateAfterEdit(m.estado);
              if (siguiente !== m.estado) writeCuadranteEstado(deps, session, m.mes, m.anio, siguiente);
              estados.push({ mes: m.mes, anio: m.anio, estado: siguiente });
            }
            // El estado resultante viaja en la respuesta: así la pantalla no tiene que replicar qué cambios
            // invalidan un mes validado (y no puede discrepar cuando esa regla crece).
            return { ok: true, guardados: req.cambios.length, estados };
          });
        });

      case "misPreferencias":
        return authed(req, deps, (session) => {
          // Con `anio`/`mes` como texto la comparación estricta de abajo devolvía `null` en silencio.
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          const all = deps.store.readLatest("preferencias", PREF_KEY);
          const mine = all.find((p) => p.residenteId === session.sub && p.anio === req.anio && p.mes === req.mes);
          return { ok: true, prefs: mine || null };
        });

      // Alcance EQUIPO, a diferencia de misPreferencias. Existe porque hasta ahora la tabla
      // `preferencias` era de solo escritura: los residentes llevaban meses rellenando el
      // formulario de Prefs.jsx y nadie —ni el dominio, ni el validador, ni el generador— leía
      // jamás `fechasEvitar`, `maxGuardias` ni `notas`. Quien monta el cuadrante
      // necesita verlas para poder tenerlas en cuenta.
      //
      // Abierta a cualquier sesión, como listBloqueos: las preferencias son BLANDAS (nunca
      // bloquean una asignación, CLAUDE.md/V-6) y las ausencias ajenas, que sí mandan sobre los
      // invariantes, ya son visibles para todos. Restringirla al permiso del ciclo (V-16) habría
      // dejado al generador sin ellas justo cuando no hay Responsable, que es el caso que V-16
      // existe para desbloquear.
      case "listPreferencias":
        return authed(req, deps, () => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          const all = deps.store.readLatest("preferencias", PREF_KEY);
          return { ok: true, preferencias: all.filter((p) => p.anio === req.anio && p.mes === req.mes) };
        });

      // Lista blanca de columnas, no spread del cliente: con `...req.prefs` al final, un residente
      // podía escribir preferencias EN NOMBRE de otro (su `residenteId` pisaba el de la sesión) y
      // colar un `id` propio, que el store honra. Invertir el orden del spread no bastaría: el `id`
      // seguiría pasando, y de hecho la pantalla ya reenvía el suyo y duplica ids en producción.
      case "guardarPreferencias":
        return authed(req, deps, (session) => {
          if (!req.prefs || typeof req.prefs !== "object") return { ok: false, error: "prefs inválido" };
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          const prefs = validPrefs(req.prefs, req.anio, req.mes, deps);
          if (prefs.ok === false) return prefs;
          deps.store.appendRecord("preferencias", { residenteId: session.sub, anio: req.anio, mes: req.mes, ...prefs });
          return { ok: true };
        });

      // `residenteId` es OPCIONAL y solo lo admite quien tiene el permiso del ciclo (V-16): sin
      // él, la ausencia es siempre la de quien la pide (session.sub, como hasta ahora).
      //
      // La ausencia ajena existe porque la tabla `bloqueos` es la que mandan los invariantes y
      // hasta ahora nadie podía escribir en ella por otro: ante una baja que el residente no ha
      // declarado —y que precisamente por estar de baja puede no poder declarar—, el único gesto
      // posible era pintar una «B» en la rejilla, que es un código de asignación y no lo lee
      // NINGÚN invariante. Es decir: INV-5 seguía dejando asignarle guardias.
      case "crearBloqueo":
        return authed(req, deps, (session) => {
          if (!BLOQ_MOTIVOS.has(req.motivo)) return { ok: false, error: "motivo inválido" };
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;

          let residenteId = session.sub;
          if (req.residenteId && req.residenteId !== session.sub) {
            const denegado = requireCicloPermiso(deps, session, "registrar la ausencia de otro residente");
            if (denegado) return denegado;
            if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
              return { ok: false, error: "el residente no existe" };
            }
            residenteId = req.residenteId;
          }

          // Simulación y escritura bajo el mismo lock (2026-09-04): dos vacaciones pedidas a la vez por
          // los dos únicos Pequeños pasaban ambas la simulación (cada una sin ver la otra) y quedaban
          // las dos escritas aunque juntas dejaran días imposibles — justo lo que P-13 existe para parar.
          return atomico(deps, () => {
            // P-13 (spec.md §8/§8.1, decisión 2026-08-07): simulación preventiva de cobertura.
            // Solo VACACIONES/ROTACION pasan por aquí — BAJA es impredecible, no se "previene".
            let riesgos = [];
            if (req.motivo === "VACACIONES" || req.motivo === "ROTACION" || req.motivo === "CONGRESO") {
              const preview = deps.domain.previewBloqueoRisk(
                { residenteId, desde: rango.desde, hasta: rango.hasta, motivo: req.motivo },
                { residentes: allResidentes(deps), bloqueosActivos: allBloqueos(deps), today: deps.today },
              );
              if (preview.bloquea) {
                return {
                  ok: false,
                  error: "el bloqueo dejaría algún día sin nadie disponible de ese grupo dentro de los próximos 3 meses",
                  riesgos: preview.riesgos,
                };
              }
              riesgos = preview.riesgos;
            }

            const id = deps.store.appendRecord("bloqueos", {
              residenteId, desde: rango.desde, hasta: rango.hasta, motivo: req.motivo,
              provincia: req.provincia, guardiasEnCentroExterno: req.guardiasEnCentroExterno, activo: true,
            });
            // V-50: la marca V/R/B se escribe sola en la rejilla para que el equipo la vea sin que
            // nadie tenga que ir día a día a mano — ver el comentario de `writeBloqueoMarcas`. Va
            // DENTRO del mismo atómico que el alta del bloqueo: si se calculara fuera, dos altas
            // simultáneas podrían volver a ver la rejilla que dejó la otra a medio escribir.
            const { escritos, sinMarcar } = writeBloqueoMarcas(deps, session, residenteId, req.motivo, rango.desde, rango.hasta);
            return { ok: true, id, residenteId, riesgos, marcasEscritas: escritos, marcasSinEscribir: sinMarcar };
          });
        });

      case "misBloqueos":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          return { ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes).filter((b) => b.residenteId === session.sub) };
        });

      // A diferencia de misBloqueos (alcance propio, para Preferencias), esta acción
      // devuelve los bloqueos de TODO el equipo: el validador de CalendarScreen (INV-5/6/7)
      // necesita conocer los bloqueos de todos los residentes, no solo de quien valida.
      case "listBloqueos":
        return authed(req, deps, () => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          return { ok: true, bloqueos: activeBloqueosInMonth(deps, req.anio, req.mes) };
        });

      // Mismo papel que listAsignacionesRango, para bloqueos: los cierres de equidad de
      // INV-3 descuentan las BAJAS de TODO el trimestre (o del año de residencia), no solo
      // las que solapan el mes que se está validando.
      case "listBloqueosRango":
        return authed(req, deps, () => {
          const rango = validRango(req, deps);
          if (rango.ok === false) return rango;
          // Solo las legibles (2026-09-04): esta acción alimenta los cierres de equidad, que hacen
          // aritmética de fechas y lanzaban con una fila ilegible; la fila sigue visible —para poder
          // cancelarla— en `listBloqueos`/`misBloqueos`, que es donde se enseña (V-22).
          const { usables } = partitionBloqueos(deps, allBloqueos(deps));
          return { ok: true, bloqueos: bloqueosInRange(deps, usables, rango.desde, rango.hasta) };
        });

      // FESTIVOS (S-4: datos de entrada, nunca derivados). Lectura por RANGO y abierta a cualquier
      // sesión: la necesitan el validador (INV-12), los puentes y el prompt del generador. El
      // rango se pide con margen porque los vecinos del día 1 y del último día del mes deciden si
      // son puente.
      case "listFestivosRango":
        return authed(req, deps, () => {
          const rango = validRango(req, deps);
          if (rango.error) return rango;
          return { ok: true, festivos: festivosInRange(deps, rango.desde, rango.hasta) };
        });

      // Carga en LOTE (una escritura, un lock): un año de festivos se pega de golpe. Decisión del
      // autor (2026-09-01): a diferencia del resto de lo que gatea el permiso del ciclo (V-16),
      // festivos y eventos son hechos externos objetivos (BOE/DOGV/ayuntamiento; fechas de
      // eventos ya fijadas por el servicio) sin ninguna decisión de negocio de por medio -- exigir
      // ser Mayor no protege nada real, un R3 se equivoca transcribiendo igual que un R1, y es
      // append-only/corregible. Abierto a cualquier sesión autenticada. `sortearEvento` (más abajo)
      // se abre también: designa personas, pero el sorteo en sí es reproducible y auditable
      // (semilla + candidatos guardados), así que quien lo ejecuta no puede manipular el resultado.
      case "crearFestivos":
        return authed(req, deps, () => {
          if (!Array.isArray(req.festivos) || req.festivos.length === 0) return { ok: false, error: "festivos vacío" };
          let filas;
          try {
            filas = req.festivos.map((f) => {
              if (!f || typeof f !== "object") throw new Error("cada festivo es un objeto {fecha, nombre, ambito}");
              deps.domain.parseISO(f.fecha);
              return { fecha: f.fecha, nombre: f.nombre || "", ambito: f.ambito || "", activo: true };
            });
          } catch (e) {
            return { ok: false, error: "festivo con fecha inválida: " + e.message };
          }
          const ids = deps.store.appendRecords("festivos", filas);
          return { ok: true, ids, cargados: ids.length };
        });

      // Revisión anual de los festivos (V-63). Leer está abierto a toda sesión (la pantalla de festivos
      // lo enseña a todos); CONFIRMAR exige el permiso del ciclo, porque apaga el recordatorio de
      // Inicio para todo el equipo y debe hacerlo quien dirige la reunión, no cualquiera de pasada.
      case "estadoRevisionFestivos":
        return authed(req, deps, () => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          return { ok: true, anio: req.anio, ...revisionFestivos(deps, req.anio) };
        });

      case "confirmarRevisionFestivos":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "confirmar la revisión de los festivos");
          if (denegado) return denegado;
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          return atomico(deps, () => {
            // Una sola fila por año: repetirlo no apila otra (y conserva quién y cuándo lo hizo primero).
            if (!revisionFestivos(deps, req.anio).revisado) {
              deps.store.appendRecord("revisionesFestivos", { anio: req.anio, actorId: session.sub, fecha: deps.today });
            }
            return { ok: true, anio: req.anio, ...revisionFestivos(deps, req.anio) };
          });
        });

      // Anular una fecha mal cargada: reinserción con activo=false, jamás borrado (append-only).
      case "anularFestivo":
        return authed(req, deps, () => {
          // Un festivo AUTOMÁTICO no tiene fila: anularlo es escribir la fila anulada de su fecha, que
          // es lo que `festivosEfectivos` entiende como «este año esta no es fiesta».
          if (typeof req.id === "string" && req.id.startsWith("auto:")) {
            const fecha = req.id.slice(5);
            const auto = festivosEfectivos(deps, Number(fecha.slice(0, 4)) || 0, Number(fecha.slice(0, 4)) || 0).find((f) => f.id === req.id);
            if (!auto) return { ok: true }; // ya anulado, o no es un festivo automático de ese año
            deps.store.appendRecord("festivos", { fecha: auto.fecha, nombre: auto.nombre, ambito: auto.ambito, activo: false });
            return { ok: true };
          }
          const actual = allFestivos(deps).find((f) => f.id === req.id);
          if (!actual) return { ok: false, error: "festivo no encontrado" };
          // Ya anulado: no se apila otra fila igual (append-only, y un doble clic las duplicaba).
          if (actual.activo !== true) return { ok: true };
          deps.store.appendRecord("festivos", { ...actual, activo: false });
          return { ok: true };
        });

      // Simétrica de `crearBloqueo`: quien puede registrar la ausencia de otro tiene que poder
      // corregirla. Sin esto, una baja registrada por error en el residente equivocado sería
      // irreversible —la tabla es append-only y el afectado no la creó, así que tampoco podía
      // cancelarla él—, y quedaría bloqueándole las asignaciones para siempre (INV-5).
      case "cancelarBloqueo":
        return authed(req, deps, (session) => {
          const actuales = deps.store.readLatest("bloqueos", (r) => r.id);
          const bloqueo = actuales.find((b) => b.id === req.id);
          if (!bloqueo) return { ok: false, error: "bloqueo no encontrado" };
          if (bloqueo.residenteId !== session.sub) {
            const denegado = requireCicloPermiso(deps, session, "cancelar la ausencia de otro residente");
            if (denegado) return denegado;
          }
          if (bloqueo.activo !== true) return { ok: true }; // ya cancelado: nada que escribir
          deps.store.appendRecord("bloqueos", { ...bloqueo, activo: false });
          return { ok: true };
        });

      // Devuelve el periodo pedido Y el SIGUIENTE en la misma respuesta: el mandato se decide
      // antes de que empiece, así que quien puede ofrecerse necesita ver el año que viene sin
      // tener que adivinar que existe un selector de año (decisión V-16).
      case "estadoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const residentes = allResidentes(deps);
          return {
            ok: true,
            ...periodoResponsable(deps, req.anio, session, residentes),
            siguiente: periodoResponsable(deps, req.anio + 1, session, residentes),
          };
        });

      case "ofrecerseResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = allResidentes(deps);
          const elegibles = deps.domain.eligibleCandidates(residentes, periodoInicio);
          if (!elegibles.includes(session.sub)) return { ok: false, error: "no tienes nivel R3 en ese periodo" };
          if (activeVolunteers(deps, periodoInicio).includes(session.sub)) return { ok: true }; // ya ofrecido: nada que escribir
          deps.store.appendRecord("voluntariosResponsable", { residenteId: session.sub, periodoInicio, activo: true });
          return { ok: true };
        });

      case "retirarVoluntariadoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const { periodoInicio } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          if (!activeVolunteers(deps, periodoInicio).includes(session.sub)) return { ok: true }; // no estaba ofrecido: nada que retirar
          deps.store.appendRecord("voluntariosResponsable", { residenteId: session.sub, periodoInicio, activo: false });
          return { ok: true };
        });

      // El sorteo escribe una fila de mandato append-only e IRREVERSIBLE para todo un año: no
      // puede quedar al alcance de cualquier sesión (un R1 podía quemar el mandato antes de que
      // nadie se ofreciera). Mismo permiso que las transiciones del cuadrante (V-16): el
      // Responsable en mandato o, si no hay ninguno —que es justo cuando hay que sortear—,
      // cualquier Mayor.
      case "ejecutarSorteoResponsable":
        return authed(req, deps, (session) => {
          if (!isYear(req.anio)) return { ok: false, error: "anio inválido" };
          const denegado = requireCicloPermiso(deps, session, "lanzar el sorteo del Responsable");
          if (denegado) return denegado;
          // Como pronto, el del año que viene: el mandato «se decide antes de que empiece» (INV-14),
          // no años antes. Un mandato es append-only e irrevocable, y con el año libre alguien podía
          // dejar decididos 2029, 2030… con la plantilla de hoy, que para entonces no será la misma.
          const anioHoy = Number(String(deps.today).slice(0, 4));
          if (req.anio > anioHoy + 1) return { ok: false, error: `el mandato de ${req.anio} se decide como pronto en ${req.anio - 1}` };
          // Comprobar-y-escribir bajo el lock: dos pulsaciones simultáneas escribían dos mandatos.
          return atomico(deps, () => {
          const { periodoInicio, periodoFin } = mandatoPeriod(req.anio);
          if (currentMandate(deps, periodoInicio)) return { ok: false, error: "el responsable de ese periodo ya está decidido" };
          const residentes = allResidentes(deps);
          const elegibles = deps.domain.eligibleCandidates(residentes, periodoInicio);
          if (elegibles.length === 0) return { ok: false, error: "no hay ningún R3 elegible para ese periodo" };
          const voluntarios = activeVolunteers(deps, periodoInicio);
          const decision = deps.domain.resolveMethod(elegibles, voluntarios);

          const record = decision.metodo === "VOLUNTARIO"
            ? { periodoInicio, periodoFin, residenteId: decision.residenteId, metodo: "VOLUNTARIO", voluntarios }
            : (() => {
              const semilla = deps.newSeed();
              const residenteId = deps.domain.drawResponsible(decision.candidatos, semilla);
              return { periodoInicio, periodoFin, residenteId, metodo: "SORTEO", voluntarios, candidatos: decision.candidatos, semilla, fechaSorteo: deps.today };
            })();

          const violaciones = deps.domain.validateResponsible(record, { residentes });
          if (violaciones.length > 0) return { ok: false, error: "fallo interno: " + violaciones.map((v) => v.detalle).join("; ") };

          const id = deps.store.appendRecord("responsables", record);
          return { ok: true, mandato: { id, ...record } };
          });
        });

      // TERCER PUESTO (INV-8, P-16/V-55). Cada mes la app pregunta «¿Deseas hacer tercer puesto este
      // mes?» y la respuesta es el campo `tercerPuesto` de las preferencias de ese mes
      // (`guardarPreferencias`): ya no hay alta, baja ni compromiso de permanencia, y nadie apunta a
      // nadie —«será siempre voluntario» (normativa p.2)—. Esta acción solo LEE: devuelve lo que
      // INV-8 necesita para el mes pedido (por defecto, el actual), derivado en el dominio
      // (`thirdPostVolunteersFromPrefs`) para que cliente y servidor juzguen exactamente lo mismo.
      // Abierta a cualquier sesión: el validador necesita la lista y la pantalla saber quién se ofreció.
      case "estadoVoluntariado3P":
        return authed(req, deps, (session) => {
          const hoy = deps.domain.parseISO(deps.today);
          const mes = req.mes === undefined ? hoy.month : req.mes;
          const anio = req.anio === undefined ? hoy.year : req.anio;
          if (!isYear(anio) || !isMonth(mes)) return { ok: false, error: "mes/anio inválido" };
          const tp = thirdPostForMonth(deps, mes, anio, allResidentes(deps));
          return { ok: true, mes, anio, ...tp, yo: tp.delMes.includes(session.sub) };
        });

      // Las dos acciones del modelo anterior (apuntarse con compromiso de 4 meses y retirarse) se
      // quedan solo para dar un motivo a un cliente viejo, como `altaResidente` en V-54.
      case "ofrecerse3P":
      case "retirarVoluntariado3P":
        return { ok: false, error: "el tercer puesto ya se decide cada mes en Preferencias («¿Deseas hacer tercer puesto este mes?»): actualiza la página" };

      // EVENTOS DEL SERVICIO (INV-10, decisión V-20). Dato de entrada como los festivos: la
      // fecha la pone el servicio cada año. Abierto a cualquier sesión desde 2026-09-01 (mismo
      // criterio que festivos, ver el comentario de `crearFestivos`): crear/anular es transcribir
      // una fecha ya fijada, y el sorteo (`sortearEvento`) es reproducible y auditable por sí
      // mismo, así que abrir quién puede ejecutarlo no abre quién puede manipular el resultado.
      case "listEventos":
        return authed(req, deps, () => ({ ok: true, eventos: activeEventos(deps) }));

      case "crearEvento":
        return authed(req, deps, () => {
          if (!EVENTO_TIPOS.has(req.tipo)) return { ok: false, error: "tipo de evento inválido (NAVIDAD o DESPEDIDA)" };
          try { deps.domain.parseISO(req.fecha); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          // Uno por tipo y curso (2026-09-04): con dos Navidades activas, `buildMonthContext` se
          // quedaba con la última en silencio y la primera perdía el trato de INV-9/INV-10. Para
          // corregir una fecha hay que anular la anterior y crear la nueva, no apilar.
          const curso = deps.domain.academicYearOf(req.fecha);
          // Sin duplicados ni basura: dos veces el mismo id dejaba el evento sin poder sortearse
          // («candidatos vacío» al apartar al primero de una lista de dos iguales).
          const voluntarios = [...new Set((Array.isArray(req.voluntarios) ? req.voluntarios : []).filter((v) => typeof v === "string" && v))];
          // La unicidad se comprueba y se escribe bajo el mismo lock: si no, dos Navidades creadas a la
          // vez pasaban las dos la comprobación.
          return atomico(deps, () => {
            const repetido = activeEventos(deps).find((e) => e.tipo === req.tipo && deps.domain.academicYearOf(e.fecha) === curso);
            if (repetido) return { ok: false, error: `ya hay un evento ${req.tipo} activo en ese curso (el ${repetido.fecha}): anúlalo antes de crear otro` };
            const id = deps.store.appendRecord("eventos", { tipo: req.tipo, fecha: req.fecha, voluntarios, designados: [], activo: true });
            return { ok: true, id };
          });
        });

      case "anularEvento":
        return authed(req, deps, () => {
          const actual = deps.store.readLatest("eventos", (r) => r.id).find((e) => e.id === req.id);
          if (!actual) return { ok: false, error: "evento no encontrado" };
          if (actual.activo !== true) return { ok: true }; // ya anulado
          deps.store.appendRecord("eventos", { ...actual, activo: false });
          return { ok: true };
        });

      // EXCEPCIONES (INV-9, decisión V-29): degradan un 2×R2 dentro de un rango de fechas, con
      // justificación documentada. Mismo tratamiento que festivos/eventos: dato compartido del
      // servicio, lectura abierta (la necesita el validador), escritura con el permiso del ciclo.
      case "listExcepciones":
        return authed(req, deps, () => ({ ok: true, excepciones: activeExcepciones(deps) }));

      case "crearExcepcion":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "registrar una excepción");
          if (denegado) return denegado;
          if (!EXCEPCION_TIPOS.has(req.tipo)) return { ok: false, error: "tipo de excepción inválido (2xR2)" };
          if (!req.justificacion || !String(req.justificacion).trim()) return { ok: false, error: "la excepción necesita una justificación" };
          try { deps.domain.parseISO(req.desde); deps.domain.parseISO(req.hasta); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          if (req.desde > req.hasta) return { ok: false, error: "«desde» no puede ser posterior a «hasta»" };
          const id = deps.store.appendRecord("excepciones", {
            tipo: req.tipo, desde: req.desde, hasta: req.hasta, justificacion: String(req.justificacion).trim(),
            registradaPor: session.sub, fecha: deps.today, activo: true,
          });
          return { ok: true, id };
        });

      case "anularExcepcion":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular una excepción");
          if (denegado) return denegado;
          const actual = activeExcepciones(deps).find((e) => e.id === req.id);
          if (!actual) return { ok: false, error: "excepción no encontrada" };
          deps.store.appendRecord("excepciones", { ...actual, activo: false });
          return { ok: true };
        });

      // El «a sorteo» de la normativa, hecho de verdad y reproducible: misma mecánica que el
      // sorteo del Responsable (INV-14, decisión V-7a) — semilla generada por la app, sorteo
      // puro sobre (candidatos, semilla), y la fila queda en `sorteos` para recomputarlo. Un
      // booleano «hubo sorteo» no prueba nada; esto sí.
      case "sortearEvento":
        // Comprobar («ya está sorteado») y escribir bajo el mismo lock: dos sorteos simultáneos del
        // mismo evento pasaban ambos la guarda y quedaban dos filas de `sorteos` contradictorias, con
        // uno de los dos viendo unos designados que no eran los que se escribieron.
        return authed(req, deps, () => atomico(deps, () => {
          const evento = activeEventos(deps).find((e) => e.id === req.id);
          if (!evento) return { ok: false, error: "evento no encontrado" };
          if (evento.sorteoId) return { ok: false, error: "ese evento ya está sorteado" };

          const residentes = allResidentes(deps);
          const r2 = residentes
            .filter((r) => deps.domain.levelOn(deps.domain.periodsOfResident(r), evento.fecha) === "R2")
            .map((r) => r.id);
          // Si se ofrecen 2 o más voluntarios se sortea SOLO entre ellos, mismo criterio que
          // V-7(b) para el Responsable: la normativa cubre el sorteo, no el «gana el primero».
          const ofrecidos = (evento.voluntarios || []).filter((id) => r2.includes(id));
          const candidatos = ofrecidos.length >= 2 ? ofrecidos : r2;
          if (candidatos.length < 2) return { ok: false, error: `hacen falta al menos 2 R2 para sortear el evento (hay ${candidatos.length})` };

          const semilla = deps.newSeed();
          const primero = deps.domain.drawResponsible(candidatos, semilla);
          const segundo = deps.domain.drawResponsible(candidatos.filter((id) => id !== primero), semilla);
          const designados = [primero, segundo];

          const sorteoId = deps.store.appendRecord("sorteos", {
            fecha: deps.today, motivo: `EVENTO_${evento.tipo}_${evento.fecha}`, semilla, candidatos, resultado: designados,
          });
          deps.store.appendRecord("eventos", { ...evento, designados, sorteoId });
          return { ok: true, designados, sorteoId, semilla };
        }));

      // IMAGINARIA (INV-13, decisión V-20). Es una HERRAMIENTA, no un validador: dice a quién
      // llamar. La cola se DERIVA del historial de coberturas, nunca se almacena.
      case "colaImaginaria":
        return authed(req, deps, () => {
          if (req.grupo !== "MAYOR" && req.grupo !== "PEQUENO") return { ok: false, error: "grupo inválido (MAYOR o PEQUENO)" };
          try { deps.domain.parseISO(req.fecha); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          // Las asignaciones de la víspera y del día siguiente deciden a quién se aparta, así
          // que el rango es fecha±1, no el mes: la incidencia puede caer en un día 1 o en un 31.
          const todas = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" });
          const desde = deps.domain.addDays(req.fecha, -1);
          const hasta = deps.domain.addDays(req.fecha, 1);
          // Las ausencias del día (2026-09-04): sin ellas la cola proponía llamar a quien estaba de
          // baja. Solo las legibles: una fila con fecha ilegible no puede decir si cubre ese día.
          const { usables } = partitionBloqueos(deps, allBloqueos(deps));
          const coberturas = activeImaginaria(deps);
          return {
            ok: true,
            cola: deps.domain.imaginariaQueue({
              residentes: allResidentes(deps),
              coberturas,
              asignaciones: todas.filter((a) => a.fecha >= desde && a.fecha <= hasta),
              bloqueos: bloqueosInRange(deps, usables, req.fecha, req.fecha),
              grupo: req.grupo, fechaIncidencia: req.fecha,
            }),
            // Las coberturas YA registradas de ESA incidencia, con su `id`. La cola es DERIVADA y
            // no lleva ninguno —solo la FECHA de la última cobertura de cada uno, que es lo que la
            // ordena—, así que sin esto el cliente no tenía forma de nombrar la fila que quiere
            // anular: `anularImaginaria` existía aquí y en `api.js` sin un solo invocador, y una
            // cobertura apuntada al residente equivocado a las ocho de la mañana solo se podía
            // corregir entrando al Sheet a mano.
            coberturas: coberturas
              .filter((c) => c.grupo === req.grupo && c.fechaIncidencia === req.fecha)
              .map((c) => ({ id: c.id, residenteId: c.residenteId, registradaEn: c.registradaEn })),
          };
        });

      case "registrarImaginaria":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "registrar una cobertura de imaginaria");
          if (denegado) return denegado;
          if (req.grupo !== "MAYOR" && req.grupo !== "PEQUENO") return { ok: false, error: "grupo inválido (MAYOR o PEQUENO)" };
          try { deps.domain.parseISO(req.fechaIncidencia); } catch (e) { return { ok: false, error: "fecha inválida: " + e.message }; }
          if (!allResidentes(deps).some((r) => r.id === req.residenteId)) {
            return { ok: false, error: "el residente no existe" };
          }
          // NO se exige que sea el primero de la cola: la incidencia se resuelve por teléfono y
          // puede haber mil motivos legítimos para saltarse el orden (nadie cogía, se cambió).
          // Lo que importa es que la cobertura quede registrada, que es lo que mueve la cola.
          const id = deps.store.appendRecord("imaginaria", {
            grupo: req.grupo, fechaIncidencia: req.fechaIncidencia, residenteId: req.residenteId,
            registradaEn: deps.today, activo: true,
          });
          return { ok: true, id };
        });

      case "anularImaginaria":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "anular una cobertura de imaginaria");
          if (denegado) return denegado;
          const actual = deps.store.readLatest("imaginaria", (r) => r.id).find((c) => c.id === req.id);
          if (!actual) return { ok: false, error: "cobertura no encontrada" };
          if (actual.activo !== true) return { ok: true }; // ya anulada
          deps.store.appendRecord("imaginaria", { ...actual, activo: false });
          return { ok: true };
        });

      case "listResponsables":
        return authed(req, deps, () => ({
          ok: true,
          mandatos: deps.store.readLatest("responsables", (r) => r.periodoInicio).sort((a, b) => (a.periodoInicio < b.periodoInicio ? -1 : 1)),
        }));

      case "estadoCuadrante":
        return authed(req, deps, () => {
          if (!isYear(req.anio) || !isMonth(req.mes)) return { ok: false, error: "mes/anio inválido" };
          // `sinResponsable` viaja aquí y no en una acción aparte porque el cliente ya llama a
          // estadoCuadrante al abrir el mes: es lo que le permite avisar de que nadie tiene el
          // mandato y habilitar el ciclo a un Mayor (decisión V-16) sin una petición de más.
          // `modosGeneracion` (V-47): el cliente solo ofrece «completar» si el servidor desplegado lo
          // entiende. Sin esto, un cliente nuevo contra un Apps Script aún sin redesplegar mandaría
          // `modo: "completar"`, el servidor viejo lo ignoraría y REEMPLAZARÍA el mes — borrando justo
          // las guardias que la pantalla prometía respetar. El cliente se publica en Pages con el
          // merge; el servidor, cuando alguien lo redespliega a mano: no se puede dar por hecho el orden.
          // `responsableId`: quién tiene HOY el mandato, releído del store. El `rol` del token se firmó
          // en el login y el ganador del sorteo de esta tarde seguiría viéndose sin permiso hasta volver
          // a entrar, aunque el servidor (que relee el mandato, V-16) ya le aceptase todo.
          const mandato = mandatoVigente(deps);
          return {
            ok: true, estado: currentCuadranteEstado(deps, req.mes, req.anio), sinResponsable: mandato === null,
            responsableId: mandato ? mandato.residenteId : null, modosGeneracion: [...MODOS_GENERACION],
            // Como `modosGeneracion`: un servidor sin esto ignoraría `fase: "extras"` y generaría de otra forma.
            fasesGeneracion: [...FASES_GENERACION],
            // Si hay Excel del contaje (V-65), para enseñar «Volcar al contaje» solo cuando sirve.
            // No abre el fichero: es solo si la propiedad existe.
            contajeConfigurado: Boolean(deps.contaje),
          };
        });

      // BORRADOR->VALIDADO (Fase 6.2, decisión V-9/V-10): solo el Responsable en mandato, y
      // revalidado AQUÍ con los datos del store (nunca se confía en un `violaciones` que
      // mandara el cliente) — mismo principio que el rol derivado ("nunca un flag que el
      // cliente pueda falsear").
      // Generación del cuadrante con IA (decisión V-45). El modelo PROPONE y el validador de
      // siempre DISPONE: nada se escribe hasta que no queda ni una violación `error`, y si tras
      // los 3 intentos sigue habiéndolas no se escribe nada en absoluto (solo la bitácora).
      case "generarCuadranteIA":
        return authed(req, deps, (session) => handleGenerarIA(req, deps, session));

      case "marcarValidado":
        return authed(req, deps, (session) => {
          const denegado = requireValidarPermiso(deps, session);
          if (denegado) return denegado;
          // Bajo el lock de escritura (2026-09-04): entre leer el mes, validarlo y escribir VALIDADO
          // otro residente podía guardar una celda, y el mes quedaba VALIDADO con una guardia que
          // nadie validó (y `guardarAsignaciones`, que leyó BORRADOR, no lo revertía).
          return atomico(deps, () => {
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (estadoActual === "PUBLICADO") return { ok: false, error: "el cuadrante ya está publicado" };

          // Una sola lectura del store para las tres comprobaciones (mes, cierres de equidad,
          // tercer puesto).
          const snap = monthSnapshot(deps);
          const violaciones = [
            ...bloqueoCorruptoViolations(snap.bloqueosCorruptos),
            ...deps.domain.validateMonth(buildCuadranteCtx(deps, req.mes, req.anio, snap)),
            ...closeViolations(deps, req.mes, req.anio, snap),
            ...deps.domain.validateThirdPost(buildThirdPostCtx(deps, req.mes, req.anio, snap)),
          ];
          if (!deps.domain.canValidate(violaciones)) {
            return { ok: false, error: "el cuadrante tiene errores, no se puede validar", violaciones };
          }
          writeCuadranteEstado(deps, session, req.mes, req.anio, "VALIDADO");
          return { ok: true, estado: "VALIDADO", violaciones };
          });
        });

      // Fase 7.1 (decisión V-11a): publicar proyecta de verdad al Sheet legible en el MISMO paso
      // — "publicar" pasa a significar publicar de verdad. Desde la Fase 7.2 son TRES hojas
      // (mensual + Resumen del curso + Contaje Trimestral del curso), así que la ventana en la que
      // el Sheet puede quedar a medias es de tres `rebuildSheet` y no de dos. Sigue sin ser una
      // transacción a propósito: cada uno es idempotente (shadow-swap) y volver a pulsar Publicar
      // lo sana, que es lo único que puede hacer alguien sin administrador. La proyección ocurre
      // ANTES de escribir el estado: ver projectCuadranteToSheets.
      case "publicarCuadrante":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "publicar el cuadrante");
          if (denegado) return denegado;
          const publicado = atomico(deps, () => {
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (!deps.domain.canPublish(estadoActual)) return { ok: false, error: "el cuadrante debe estar VALIDADO antes de publicarse" };
          const proyeccion = projectCuadranteToSheets(deps, req.mes, req.anio);
          writeCuadranteEstado(deps, session, req.mes, req.anio, "PUBLICADO");
          return { ok: true, estado: "PUBLICADO", proyeccion };
          });
          if (!publicado.ok) return publicado;
          // El contaje oficial en el Excel del servicio (decisión V-65), en un SEGUNDO atómico que
          // empieza cuando el de arriba ya ha soltado el lock: anidado, el volcado alargaría el lock
          // de la publicación con las llamadas a otro fichero. Y nunca la bloquea ni la revierte:
          // `volcarContajeExcel` no lanza, y un fallo viaja en `contajeExcel` para que la pantalla
          // lo diga y se pueda reintentar con «Volcar al contaje».
          return { ...publicado, contajeExcel: volcarContajeExcel(deps, req.mes, req.anio) };
        });

      // Volcar el contaje al Excel del servicio sin publicar (V-65): repara un volcado que falló y
      // recoge lo que cambia sin pasar por publicar (fechas o periodos de un residente, respuestas
      // de tercer puesto). Mismo permiso que publicar (V-16). Escritura: no va en ningún lote.
      case "volcarContaje":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "volcar el contaje al Excel del servicio");
          if (denegado) return denegado;
          if (validCuadranteMesAnio(req, deps) === null) return { ok: false, error: "mes/anio inválido" };
          const r = volcarContajeExcel(deps, req.mes, req.anio);
          if (r.omitido) return { ok: false, omitido: true, error: r.omitido, ...(r.configurado === false ? { configurado: false } : {}) };
          return r;
        });

      case "despublicarCuadrante":
        return authed(req, deps, (session) => {
          const denegado = requireCicloPermiso(deps, session, "despublicar el cuadrante");
          if (denegado) return denegado;
          const estadoActual = validCuadranteMesAnio(req, deps);
          if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
          if (!deps.domain.canUnpublish(estadoActual)) return { ok: false, error: "el cuadrante no está publicado" };
          writeCuadranteEstado(deps, session, req.mes, req.anio, "VALIDADO");
          return { ok: true, estado: "VALIDADO" };
        });

      default:
        return { ok: false, error: `acción desconocida: ${req.action}` };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Verifica el ID token de una petición (login/altaResidente) y devuelve el email, o el error. */
function verifyIdentity(req, deps) {
  const claims = deps.fetchTokeninfo(req.idToken);
  return verifyTokeninfo(claims, { clientId: deps.clientId, now: deps.now, consumeNonce: deps.consumeNonce });
}

function sessionFor(residente, deps) {
  const rol = resolveRol(deps.store, residente.id, deps.today);
  const session = issueSession({ sub: residente.id, rol }, { now: deps.now, ttlSeconds: deps.sessionTtl, secret: deps.sessionSecret, crypto: deps.crypto });
  return { ok: true, session, residente: { id: residente.id, nombre: residente.nombre, rol } };
}

const PENDING_TTL = 300; // 5 min: solo para completar el alta tras un login fallido por email desconocido.

function handleLogin(req, deps) {
  const v = verifyIdentity(req, deps);
  if (!v.ok) return { ok: false, error: v.reason };

  const residentes = allResidentes(deps);
  // `trim()` además de minúsculas: el Sheet se edita a mano y un espacio de más al final del email
  // dejaba a esa persona sin poder entrar — y peor, el alta autoservicio le creaba un DUPLICADO.
  const residente = residentes.find((r) => emailNormalizado(r.email) === v.email);
  if (!residente) {
    // El email SÍ quedó verificado con Google (aud/iss/email_verified/exp ya comprobados);
    // se emite un token de corta vida para que el cliente pueda completar el alta sin
    // repetir el login de Google (y sin el problema de reusar un nonce ya consumido).
    const pendingToken = issueSession({ pending: true, email: v.email }, { now: deps.now, ttlSeconds: PENDING_TTL, secret: deps.sessionSecret, crypto: deps.crypto });
    return { ok: false, error: "email no vinculado a ningún residente", pendingToken };
  }

  // La lista viaja con la sesión (2026-09-04): ya está leída para resolver el email, y el cliente
  // la pedía otra vez con `listResidentes` nada más entrar — una ida y vuelta entera a Apps
  // Script entre el clic en Google y ver algo en Inicio. Es la misma lista que da `listResidentes`.
  return { ...sessionFor(residente, deps), residentes };
}

/**
 * Datos de un alta, validados. Mismas reglas que tenía el alta autoservicio (DoD-1): el nivel R1-R4
 * no se pide, se deriva de `fechaInicio`/`fechaFin` (S-2), y las fechas pasan por el `validRango` de
 * `editarResidente` (V-22) porque una que no sea ISO no falla aquí sino después y en todas partes
 * (`periodsOfResident` lanza al derivar el nivel de TODOS los residentes). El nombre se vuelca a las
 * pestañas publicadas, donde una celda que empiece por «=» sería una fórmula.
 */
function datosDeAlta(req, deps) {
  if (!req.nombre || !String(req.nombre).trim() || !req.fechaInicio || !req.fechaFin) return { ok: false, error: "nombre, fechaInicio y fechaFin son obligatorios" };
  const malRango = validRango({ desde: req.fechaInicio, hasta: req.fechaFin }, deps);
  if (malRango.ok === false) return { ok: false, error: "fechas de residencia inválidas: " + malRango.error };
  const nombre = String(req.nombre).trim();
  if (nombre.startsWith("=")) return { ok: false, error: "el nombre no puede empezar por «=»" };
  return { ok: true, nombre, fechaInicio: req.fechaInicio, fechaFin: req.fechaFin };
}

/**
 * Pide el alta de una cuenta de residente (V-54). La identidad llega como un `idToken`+`nonce` frescos
 * o como el `pendingToken` de un login que falló solo por «email no vinculado» (sin repetir Google).
 * NO crea nada: deja una solicitud ALTA que un administrador tiene que aprobar en 5 minutos; el
 * residente se crea al aprobarla (`handleResolverSolicitud`).
 */
function handleSolicitarAlta(req, deps) {
  let email;
  if (req.pendingToken) {
    const s = verifySession(req.pendingToken, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
    if (!s.valid || !s.payload.pending) return { ok: false, error: "pendingToken inválido o caducado" };
    email = s.payload.email;
  } else {
    const v = verifyIdentity(req, deps);
    if (!v.ok) return { ok: false, error: v.reason };
    email = v.email;
  }
  const datos = datosDeAlta(req, deps);
  if (datos.ok === false) return datos;
  return atomico(deps, () => {
    if (allResidentes(deps).some((r) => emailNormalizado(r.email) === email)) return { ok: false, error: "ese email ya está vinculado a un residente" };
    return crearSolicitud(deps, email, "ALTA", { nombre: datos.nombre, fechaInicio: datos.fechaInicio, fechaFin: datos.fechaFin });
  });
}

/**
 * Comprobar-y-escribir bajo el lock (ver `sheets-store.js:transaction`). Tolera un store sin
 * `transaction` (un doble antiguo en tests): entonces se ejecuta sin lock, como hasta ahora.
 */
function atomico(deps, fn) {
  return typeof deps.store.transaction === "function" ? deps.store.transaction(fn) : fn();
}

/** Email tal y como se compara con el verificado por Google (verify-token.js ya lo pone en minúsculas). */
function emailNormalizado(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Nivel R1–R4 con el que un residente cuenta en el mes que empieza en `monthStart`: el del día 1,
 * o el del último día si el día 1 aún no está (incorporación a mitad de mes). `null` si en ninguno
 * de los dos tiene nivel asignable (PENDIENTE todo el mes, o FINALIZADO antes de empezar).
 */
function nivelEnElMes(deps, residente, monthStart) {
  const periodos = deps.domain.periodsOfResident(residente);
  const dia1 = deps.domain.levelOn(periodos, monthStart);
  if (NIVELES_ASIGNABLES.has(dia1)) return dia1;
  const [anio, mes] = monthStart.split("-").map(Number);
  const siguiente = mes === 12 ? `${anio + 1}-01-01` : `${monthPrefix(anio, mes + 1)}-01`;
  const ultimo = deps.domain.levelOn(periodos, deps.domain.addDays(siguiente, -1));
  return NIVELES_ASIGNABLES.has(ultimo) ? ultimo : null;
}

/** Prefijo "YYYY-MM" de una fecha ISO, para filtrar asignaciones de un mes concreto. */
function monthPrefix(anio, mes) {
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/**
 * Rango [desde,hasta] validado como ISO de verdad, no por orden lexicográfico. Devuelve
 * `{desde,hasta}` si está bien, o el propio `{ok:false,error}` que debe devolver la acción.
 *
 * Es el ÚNICO sitio donde se valida un rango de fechas de entrada: lo comparten `crearBloqueo`,
 * `listBloqueosRango`, `listAsignacionesRango` y `listFestivosRango`/`listEventosRango`. Las tres
 * primeras tenían su propio `!desde || !hasta || desde > hasta` en línea, que es una comparación
 * LEXICOGRÁFICA de lo que mandara el cliente y colaba cualquier cosa cuyo primer carácter ordenase
 * por debajo: `"30/02/2027"`, `"2027-13-45"`, `"9999"` y hasta un objeto entraron en la sonda del
 * 2026-08-02. En una tabla append-only sobre un Sheet editable a mano eso no es un detalle: una
 * fila BAJA con `desde` no-ISO se descarta sola del rango de `absences` —que compara cadenas a
 * propósito, V-19— y **desactiva INV-5 en silencio**. Medido: con `desde` válida, validar el mes
 * emitía 31 violaciones de INV-5 sobre la baja; con `desde="30/02/2026"`, cero.
 */
function validRango(req, deps) {
  if (!req.desde || !req.hasta) return { ok: false, error: "rango de fechas inválido" };
  try {
    deps.domain.parseISO(req.desde);
    deps.domain.parseISO(req.hasta);
  } catch (e) {
    return { ok: false, error: "rango con fecha inválida: " + e.message };
  }
  if (req.desde > req.hasta) return { ok: false, error: "rango de fechas inválido" };
  return { desde: req.desde, hasta: req.hasta };
}

const NOTAS_MAX = 500;

/**
 * Preferencias de un mes, validadas campo a campo (2026-09-04). Antes entraba cualquier cosa y,
 * como la tabla es append-only y el prompt del generador la lee literal (`ai-prompt.js:
 * seccionPreferencias`), un `maxGuardias: "abc"` acababa como «querría no pasar de abc guardias»
 * delante del modelo, y una fecha de otro mes en `fechasEvitar` se le pedía evitar en un mes en el
 * que no existe. Los campos ausentes se normalizan a su valor neutro (la pantalla manda siempre
 * los tres, pero el endpoint es público). Devuelve el registro listo o el `{ok:false,error}`.
 *
 * Ya NO valida `preferDobles` (retirado en V-51): la normativa exige viernes-domingo
 * específicamente y esa distribución la gobierna el eje `dobletes` de INV-3, nunca una preferencia
 * personal — ver el comentario de la columna en `sheets-schema.js`.
 */
function validPrefs(prefs, anio, mes, deps) {
  const out = {};
  const mg = prefs.maxGuardias;
  if (mg === undefined || mg === null || mg === "") out.maxGuardias = undefined;
  else if (typeof mg !== "number" || !Number.isInteger(mg) || mg < 0 || mg > 6) return { ok: false, error: "maxGuardias debe ser un número entero entre 0 y 6" };
  else out.maxGuardias = mg;

  const fe = prefs.fechasEvitar === undefined || prefs.fechasEvitar === null ? [] : prefs.fechasEvitar;
  if (!Array.isArray(fe)) return { ok: false, error: "fechasEvitar debe ser una lista de fechas" };
  const prefix = monthPrefix(anio, mes);
  for (const f of fe) {
    try { deps.domain.parseISO(f); } catch (e) { return { ok: false, error: "fechasEvitar con fecha inválida: " + e.message }; }
    if (!String(f).startsWith(prefix)) return { ok: false, error: `fechasEvitar: ${f} no es un día de ${mes}/${anio}` };
  }
  out.fechasEvitar = [...new Set(fe)].sort();

  // «¿Deseas hacer tercer puesto este mes?» (P-16/V-55): un booleano por mes; ausente = no.
  if (prefs.tercerPuesto !== undefined && prefs.tercerPuesto !== null && typeof prefs.tercerPuesto !== "boolean") return { ok: false, error: "tercerPuesto debe ser verdadero o falso" };
  out.tercerPuesto = prefs.tercerPuesto === true;

  const notas = prefs.notas === undefined || prefs.notas === null ? "" : prefs.notas;
  if (typeof notas !== "string") return { ok: false, error: "notas debe ser texto" };
  if (notas.length > NOTAS_MAX) return { ok: false, error: `notas demasiado largas (máximo ${NOTAS_MAX} caracteres)` };
  out.notas = notas.trim();
  return out;
}

/** Estado actual de la tabla de festivos (última reinserción gana). */
function allFestivos(deps) {
  return deps.store.readLatest("festivos", (r) => r.id);
}

/**
 * Los festivos que VALEN, de los años `desdeAnio`..`hastaAnio` (decisión V-61): la base de la
 * Comunitat Valenciana calculada (`holidays.js`) más lo que haya en la tabla.
 *   - Una fila ACTIVA de la tabla manda sobre la base de esa fecha (y la sustituye, con su nombre).
 *   - Una fila ANULADA quita la base de esa fecha: es como se descarta un festivo automático que
 *     el decreto del año no incluye. Una fecha anulada que vuelve a cargarse a mano queda activa.
 *   - Las filas de la tabla de cualquier año se devuelven siempre, también fuera de la ventana.
 * Los automáticos llevan `id: "auto:<fecha>"` y `origen: "AUTO"`; `anularFestivo` sabe anularlos.
 * Si el `domain.gs` desplegado es anterior a V-61 y no trae `valencianHolidays`, se devuelve solo
 * la tabla, como antes: pegar `server-lib.gs` sin `domain.gs` no puede tumbar el cuadrante.
 */
function festivosEfectivos(deps, desdeAnio, hastaAnio) {
  const filas = allFestivos(deps);
  const activos = filas.filter((f) => f.activo === true);
  if (typeof deps.domain.valencianHolidays !== "function") return activos;
  const fechasActivas = new Set(activos.map((f) => f.fecha));
  const anuladas = new Set(filas.filter((f) => f.activo !== true).map((f) => f.fecha));
  const auto = [];
  for (let anio = desdeAnio; anio <= hastaAnio; anio++) {
    for (const h of deps.domain.valencianHolidays(anio)) {
      if (fechasActivas.has(h.fecha) || anuladas.has(h.fecha)) continue;
      auto.push({ id: `auto:${h.fecha}`, fecha: h.fecha, nombre: h.nombre, ambito: h.ambito, activo: true, origen: "AUTO" });
    }
  }
  return [...activos, ...auto];
}

/** ¿Se ha revisado ya el calendario de festivos de ese año, y quién y cuándo? (V-63) */
function revisionFestivos(deps, anio) {
  const fila = deps.store.readRecords("revisionesFestivos").find((r) => r.anio === anio);
  if (!fila) return { revisado: false, por: "", fecha: "" };
  const quien = allResidentes(deps).find((r) => r.id === fila.actorId);
  return { revisado: true, por: quien ? quien.nombre : "", fecha: fila.fecha };
}

/** Años que cubre la lectura SIN rango (el snapshot de validar/generar): tres a cada lado de hoy. */
function ventanaFestivos(deps) {
  const hoy = Number(String(deps.today || "").slice(0, 4)) || new Date().getUTCFullYear();
  return [hoy - 3, hoy + 3];
}

/** Festivos vigentes dentro de [desde,hasta] (tabla + base automática). */
function festivosInRange(deps, desde, hasta) {
  return festivosEfectivos(deps, Number(desde.slice(0, 4)), Number(hasta.slice(0, 4)))
    .filter((f) => f.fecha >= desde && f.fecha <= hasta);
}

/** Eventos del servicio vigentes (última reinserción gana; el sorteo reinserta la fila). */
function activeEventos(deps) {
  return deps.store.readLatest("eventos", (r) => r.id).filter((e) => e.activo === true);
}

/** Excepciones vigentes (INV-9, V-29): última reinserción gana; anular reinserta con activo=false. */
function activeExcepciones(deps) {
  return deps.store.readLatest("excepciones", (r) => r.id).filter((e) => e.activo === true);
}

/** Coberturas de imaginaria vigentes: son las que mueven la cola derivada. */
function activeImaginaria(deps) {
  return deps.store.readLatest("imaginaria", (r) => r.id).filter((c) => c.activo === true);
}

/**
 * Los residentes, con sus periodos formativos EDITADOS ya montados en `residente.periodos`.
 *
 * Lector único a propósito, y es el punto entero de la fase 2 de V-24: `periodsOfResident` solo
 * respeta los periodos editados si el residente los TRAE, así que hidratar en unas acciones y no en
 * otras sería peor que no hidratar — daría un nivel distinto según por qué endpoint entres. Había
 * trece `readRecords("residentes")` sueltos en este fichero.
 *
 * La tabla guarda `{id, residenteId, anio, fechaInicio, fechaFin}` y el dominio consume
 * `{year, start, end}`: la traducción de forma vive aquí y solo aquí. Nadie la había escrito, y era
 * el fallo silencioso más probable de este punto — unos `periodos` con las claves equivocadas no
 * lanzan, simplemente hacen que `levelOn` lea `undefined` y devuelva basura.
 *
 * Un residente sin las 4 filas NO recibe la clave, así que `periodsOfResident` sigue derivando de
 * las fechas: es el caso normal y el que tiene todo el mundo hoy. Las incompletas se ignoran
 * ENTERAS en vez de montar unos periodos a medias que nadie podría diagnosticar; quien las escribe
 * (`guardarPeriodos`) ya no deja que eso ocurra, pero el Sheet se edita a mano.
 */
function allResidentes(deps) {
  const porResidente = new Map();
  for (const f of deps.store.readLatest("periodos", PERIODO_KEY)) {
    if (!porResidente.has(f.residenteId)) porResidente.set(f.residenteId, []);
    porResidente.get(f.residenteId).push({ year: Number(f.anio), start: f.fechaInicio, end: f.fechaFin });
  }
  // `readLatest` y no `readRecords`: `residentes` es append-only como todo lo demás, y hasta que
  // existió `editarResidente` nadie reinsertaba una fila, así que leer todas y coger la primera
  // daba igual. Con la corrección de fechas ya no: `readRecords` devolvería la fila VIEJA y la
  // edición no tendría ningún efecto visible. Lo destapó el test, no la lectura del código.
  return deps.store.readLatest("residentes", (r) => r.id).map((r) => {
    const suyos = (porResidente.get(r.id) || []).sort((a, b) => a.year - b.year);
    if (suyos.length !== 4) return r;
    return { ...r, periodos: suyos };
  });
}

/** Estado actual de la tabla de bloqueos (última reinserción gana, como cancelarBloqueo). */
function allBloqueos(deps) {
  return deps.store.readLatest("bloqueos", (r) => r.id);
}

/**
 * Parte las ausencias ACTIVAS en las que se pueden usar y las que tienen una fecha que no es ISO.
 *
 * `crearBloqueo` ya no deja entrar una fecha mala, pero el Sheet es datastore y entregable a la
 * vez —se edita a mano— y las tablas son append-only, así que una fila corrupta puede estar ya
 * escrita y no se va a borrar nunca. Sin partirla, el problema NO es que el validador reviente
 * (`validateMonth` solo compara cadenas y nunca lanza por esto): es que **el veredicto de INV-5
 * sale a suerte**, según por dónde ordene la basura. Medido el 2026-08-02 con una guardia
 * asignada encima de la baja:
 *  - `hasta="no-es-fecha"` o `hasta="30/02/2028"` → INV-5 emite, pero por casualidad: la cadena
 *    basura ordena por encima del día, así que el rango "contiene" la fecha de puro accidente;
 *  - `desde="30/02/2027"` → INV-5 emite CERO. `absences` descarta la fila del rango —compara
 *    cadenas a propósito, V-19— y la baja médica deja de proteger EN SILENCIO.
 * Y los cierres de equidad de INV-3, que sí hacen aritmética de fechas, hacían que
 * `marcarValidado` respondiera «Fecha ISO inválida: "…"» sin decir de qué tabla, de quién ni cuál.
 *
 * La política (decisión V-22): apartarla del contexto —para que ningún invariante la juzgue con
 * una fecha inventada— y emitir un `error` que la nombre. Es `error` y no `aviso` porque no es una regla nueva que
 * bloquea: es INV-5 diciendo que no puede comprobarse, ya bloqueaba antes con un mensaje ciego, y
 * SÍ tiene salida dentro de la herramienta —cancelar la fila y recrearla, y desde V-19 eso vale
 * también para la ausencia de otro—. Por eso las lecturas de UI la siguen mostrando (ver
 * `activeBloqueosInMonth`): apartarla también de ahí la volvería incancelable.
 */
function partitionBloqueos(deps, bloqueos) {
  const usables = [];
  const corruptas = [];
  for (const b of deps.domain.absences(bloqueos)) { // solo activas: una cancelada ya no molesta
    try {
      deps.domain.parseISO(b.desde);
      deps.domain.parseISO(b.hasta);
      usables.push(b);
    } catch (e) {
      corruptas.push({ bloqueo: b, motivo: e.message });
    }
  }
  return { usables, corruptas };
}

/** Un `error` por ausencia con fecha ilegible, nombrando la fila para que se pueda cancelar. */
function bloqueoCorruptoViolations(corruptas) {
  return corruptas.map(({ bloqueo, motivo }) => ({
    invariante: "INV-5",
    severidad: "error",
    residenteId: bloqueo.residenteId,
    detalle: `Ausencia ${bloqueo.motivo || "(sin motivo)"} con fecha ilegible (${bloqueo.desde} → ${bloqueo.hasta}): ${motivo}. `
      + `Mientras siga así no se puede comprobar si hay guardias asignadas sobre ella; cancélala (id ${bloqueo.id}) y vuelve a crearla.`,
  }));
}

/**
 * Bloqueos activos que solapan [desde,hasta]. El filtro no vive aquí: lo hace el lector único
 * del dominio (`absences`), que es también quien descarta las filas canceladas. Antes el
 * `activo === true` de esta función era la ÚNICA defensa contra que un bloqueo cancelado
 * volviera a bloquear asignaciones, y bastaba con que un invocador nuevo no pasara por aquí.
 */
function bloqueosInRange(deps, bloqueos, desde, hasta) {
  return deps.domain.absences(bloqueos, { desde, hasta });
}

/**
 * Bloqueos activos (de cualquier residente) que solapan el mes dado, MÁS las filas con fecha
 * ilegible. Las corruptas se añaden en todos los meses a propósito: con la fecha ilegible no se
 * puede saber en cuál caen, y esconderlas las volvería incancelables desde la UI, que es la única
 * salida que tiene quien se las encuentre (ver `partitionBloqueos`).
 */
function activeBloqueosInMonth(deps, anio, mes) {
  const prefix = monthPrefix(anio, mes);
  const { usables, corruptas } = partitionBloqueos(deps, allBloqueos(deps));
  // Tope superior lexicográfico holgado: "-31" existe en ISO aunque el mes tenga 28/30 días.
  return [...bloqueosInRange(deps, usables, `${prefix}-01`, `${prefix}-31`), ...corruptas.map((c) => c.bloqueo)];
}

// El código de la rejilla que corresponde a cada motivo de Bloqueo (V-50): son exactamente los
// tres códigos "de marca" que ya existían en ASIG_CODIGOS antes de esta decisión.
const ASIG_CODIGO_DE_BLOQUEO = { VACACIONES: "V", ROTACION: "R", BAJA: "B", CONGRESO: "C" };

/**
 * Escribe sola la marca V/R/B en `asignaciones`, un día por cada uno del bloqueo recién creado
 * (decisión del autor, 2026-09-03, V-50): antes había que ir día a día a mano en la rejilla del
 * cuadrante para que el equipo VIERA una ausencia que la tabla `bloqueos` (la que de verdad leen
 * los invariantes, V-19) ya tenía registrada desde el alta — la rejilla y la tabla real podían
 * contarse historias distintas.
 *
 * Dos guardarraíles, no una copia ciega de `guardarAsignaciones`:
 *  - Solo rellena celdas VACÍAS. Un día con un código ya puesto —una guardia real, por ejemplo—
 *    no se pisa nunca: silenciar una asignación de verdad para poner una marca informativa sería
 *    justo el tipo de pérdida de datos que este proyecto evita en todas partes (asignaciones es
 *    append-only y nunca se borra). Esos días quedan en `sinMarcar` para que quien registró el
 *    bloqueo sepa que tiene que revisarlos.
 *  - Un mes PUBLICADO no se toca (mismo criterio que `guardarAsignaciones`, V-9b): sus días
 *    también van a `sinMarcar`. Solo se revierte VALIDADO→BORRADOR (`stateAfterEdit`) en los
 *    meses donde de verdad se escribió algo, no en los que quedaron intactos.
 */
function writeBloqueoMarcas(deps, session, residenteId, motivo, desde, hasta) {
  const codigo = ASIG_CODIGO_DE_BLOQUEO[motivo];
  if (!codigo) return { escritos: 0, sinMarcar: [] };

  const fechas = [];
  for (let f = desde; f <= hasta; f = deps.domain.addDays(f, 1)) fechas.push(f);

  const codigoActual = new Map(
    deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" })
      .filter((a) => a.residenteId === residenteId)
      .map((a) => [a.fecha, a.codigo]),
  );

  const porMes = new Map();
  for (const f of fechas) {
    const clave = f.slice(0, 7);
    if (!porMes.has(clave)) porMes.set(clave, { mes: Number(f.slice(5, 7)), anio: Number(f.slice(0, 4)), fechas: [] });
    porMes.get(clave).fechas.push(f);
  }

  const sinMarcar = [];
  const cambios = [];
  for (const { mes, anio, fechas: fechasMes } of porMes.values()) {
    if (!deps.domain.canEdit(currentCuadranteEstado(deps, mes, anio))) { sinMarcar.push(...fechasMes); continue; }
    for (const f of fechasMes) {
      if ((codigoActual.get(f) || "") !== "") { sinMarcar.push(f); continue; }
      cambios.push({ fecha: f, residenteId, codigo });
    }
  }
  if (cambios.length === 0) return { escritos: 0, sinMarcar };

  deps.store.appendRecords("asignaciones", cambios);
  const mesesEscritos = new Set(cambios.map((c) => c.fecha.slice(0, 7)));
  for (const { mes, anio } of porMes.values()) {
    if (!mesesEscritos.has(monthPrefix(anio, mes))) continue;
    const estado = currentCuadranteEstado(deps, mes, anio);
    const siguiente = deps.domain.stateAfterEdit(estado);
    if (siguiente !== estado) writeCuadranteEstado(deps, session, mes, anio, siguiente);
  }
  return { escritos: cambios.length, sinMarcar };
}

/**
 * Las tres tablas que necesitan las comprobaciones de un mes, leídas UNA vez. Existe porque
 * validar un mes ahora comprueba el mes (INV-1..14) y además los cierres de equidad de INV-3
 * (trimestral y anual): sin esto, la misma acción releería residentes/asignaciones/bloqueos
 * dos veces, y en Apps Script cada lectura es una llamada real a Sheets.
 */
function monthSnapshot(deps) {
  // Las ausencias con fecha ilegible se apartan aquí y viajan en `bloqueosCorruptos`: si entraran
  // en el contexto, INV-5 las juzgaría por comparación de cadenas (veredicto a suerte) y los
  // cierres de equidad tumbarían la petición con un «Fecha ISO inválida» que no dice de qué fila
  // habla (decisión V-22, ver `partitionBloqueos`).
  const { usables, corruptas } = partitionBloqueos(deps, allBloqueos(deps));
  return {
    residentes: allResidentes(deps),
    asignaciones: deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" }),
    bloqueos: usables,
    bloqueosCorruptos: corruptas,
    festivos: festivosEfectivos(deps, ...ventanaFestivos(deps)),
    eventos: activeEventos(deps),
    excepciones: activeExcepciones(deps),
  };
}

/**
 * Contexto de `validateThirdPost` (INV-8) para un mes, reconstruido desde el store igual que
 * `buildCuadranteCtx`. Hasta la decisión V-18 este invariante estaba implementado y probado
 * desde la Fase 3 pero **no lo invocaba nadie** —mismo caso que el cierre anual de INV-3 antes
 * de P-8—, y le faltaba además la tabla de voluntarios: con la lista vacía, INV-8a marcaba
 * TODO 3P como no-voluntario, que es la razón por la que no se podía cablear antes.
 *
 * El rango del historial lo decide el dominio (`thirdPostHistoryStart`) y no este fichero: el
 * ciclo L-D de INV-8b arranca el día en que cada residente se apuntó, que puede ser de hace
 * año y medio, y adivinarlo aquí es el error que ya costó la regresión del contrato C-2.
 */
function buildThirdPostCtx(deps, mes, anio, snap, propuesta = null) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const tp = thirdPostForMonth(deps, mes, anio, snap.residentes);
  const voluntarios = tp.voluntarios;
  const desde = deps.domain.thirdPostHistoryStart(voluntarios, snap.residentes, mes, anio);

  // historial3P: solo los 3P ANTERIORES al mes, por residente y en orden. Los del propio mes
  // van por `asignaciones`, y meterlos también aquí los contaría dos veces en el ciclo.
  const historial3P = {};
  if (desde) {
    for (const a of snap.asignaciones) {
      if (a.codigo !== "3P" || a.fecha < desde || a.fecha >= monthStart) continue;
      (historial3P[a.residenteId] = historial3P[a.residenteId] || []).push(a.fecha);
    }
    for (const id of Object.keys(historial3P)) historial3P[id].sort();
  }

  return {
    mes, anio, residentes: snap.residentes,
    asignaciones: propuesta || snap.asignaciones.filter((a) => a.fecha.startsWith(prefix)),
    voluntarios3P: voluntarios, // con `desde` = inicio de su año de residencia: el ciclo de 8b se cuenta dentro del año (V-55)
    historial3P,
    // INV-8a juzga "¿era voluntario ESE día?" con la historia completa (V-28), no con la lista de
    // HOY que usan 8b/8c (`voluntarios`, sin tocar a propósito: el ciclo y el cierre de equidad sí
    // son sobre el compromiso vigente).
    periodosVoluntario3P: tp.periodos,
  };
}

/**
 * Violaciones de los cierres de equidad de INV-3 que caen en el mes validado, cada uno con la
 * severidad que le da spec.md §5: el TRIMESTRAL (agosto/noviembre/febrero/mayo; solo el eje
 * `total`, severidad aviso — P-8, decisión V-13) y el ANUAL (solo si algún residente cierra su
 * año de residencia ese mes; los seis ejes, severidad aviso como todo lo de equidad desde
 * V-14). Devuelve [] cuando el mes no
 * cierra ninguno de los dos, que es lo normal en 8 de cada 12 meses.
 *
 * Los rangos que hay que leer los decide el dominio (`quarterCloseWindow`,
 * `yearCloseHistoryStart`), no este fichero: el cierre anual arranca en el aniversario del
 * residente, que puede caer 11 meses atrás, y adivinarlo aquí es el error que ya costó una
 * regresión con el contrato C-2.
 */
function closeViolations(deps, mes, anio, snap) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const monthEnd = `${prefix}-31`;
  const violaciones = [];

  const trimestre = deps.domain.quarterCloseWindow(mes, anio);
  if (trimestre) {
    violaciones.push(...deps.domain.validateQuarterClose({
      mes, anio, residentes: snap.residentes,
      asignaciones: snap.asignaciones.filter((a) => a.fecha >= trimestre.start && a.fecha <= trimestre.end),
      bloqueos: bloqueosInRange(deps, snap.bloqueos, trimestre.start, trimestre.end),
    }));
  }

  const desdeAnual = deps.domain.yearCloseHistoryStart(snap.residentes, mes, anio);
  if (desdeAnual) {
    // El eje `puentesLibres` mira el año de residencia entero (fase 3 de V-17), que cruza dos
    // años naturales: el rango de festivos lo da el dominio, no se recorta aquí.
    const rangoFestivos = deps.domain.yearCloseFestivosRange(snap.residentes, mes, anio);
    // Los dos primeros días del mes siguiente van con el mes como lookahead del doblete
    // (contrato C-1): a quien cierra ahora se le mide el mes con `asignaciones`, y un viernes
    // 30/31 dentro de su ventana empareja su domingo ya en el mes siguiente — sin esas filas ese
    // doblete existía para quien cerró antes (medido con el histórico entero) y no para él.
    const prefixSiguiente = mes === 12 ? monthPrefix(anio + 1, 1) : monthPrefix(anio, mes + 1);
    const lookahead = new Set([`${prefixSiguiente}-01`, `${prefixSiguiente}-02`]);
    violaciones.push(...deps.domain.validateResidencyYearClose(deps.domain.buildYearCloseContext({
      mes, anio, residentes: snap.residentes,
      historicas: snap.asignaciones.filter((a) => a.fecha >= desdeAnual && a.fecha < monthStart),
      asignacionesDelMes: snap.asignaciones.filter((a) => a.fecha.startsWith(prefix) || lookahead.has(a.fecha)),
      bloqueos: bloqueosInRange(deps, snap.bloqueos, desdeAnual, monthEnd),
      festivos: (snap.festivos || []).filter((f) => f.fecha >= rangoFestivos.desde && f.fecha <= rangoFestivos.hasta),
    })));
  }

  return violaciones;
}

function isYear(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 2000 && v < 2100;
}

function isMonth(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12;
}

/** Estado vigente (última fila gana, `readLatest` por mes|anio); sin fila = BORRADOR implícito. */
function currentCuadranteEstado(deps, mes, anio) {
  const fila = deps.store.readLatest("cuadrantes", CUAD_KEY).find((r) => r.mes === mes && r.anio === anio);
  return fila ? fila.estado : "BORRADOR";
}

/** mes/anio de `req` válidos → estado vigente; inválidos → null (Fase 6.2, 3 acciones de estado). */
function validCuadranteMesAnio(req, deps) {
  if (!isYear(req.anio) || !isMonth(req.mes)) return null;
  return currentCuadranteEstado(deps, req.mes, req.anio);
}

/** Añade la fila de transición de estado del cuadrante (Fase 6.2) — misma forma en las 4 acciones que la escriben. */
function writeCuadranteEstado(deps, session, mes, anio, estado) {
  deps.store.appendRecord("cuadrantes", { mes, anio, estado, actorId: session.sub, fecha: deps.today });
}

/** El mandato de Responsable que cubre `today`, o null si no hay ninguno vigente (INV-14). */
function mandatoVigente(deps) {
  return deps.store.readLatest("responsables", (r) => r.periodoInicio)
    .find((m) => m.periodoInicio <= deps.today && deps.today < m.periodoFin) || null;
}

/**
 * Permiso para mover el ciclo del cuadrante (validar/publicar/despublicar/excepciones/sorteo/
 * imaginaria/editar fechas y periodos formativos/registrar o cancelar la ausencia de otro
 * residente — todo lo que llama a esta función).
 *
 * Regla base (decisión V-9c): lo hace el Responsable en mandato. Añadido de la decisión V-16:
 * si NO hay mandato vigente el ciclo no se queda bloqueado — cualquier residente Mayor (R3/R4
 * a día de hoy, derivado de fechas como todo lo demás) puede moverlo, y el cliente avisa de que
 * no hay Responsable designado. El motivo es el de siempre: la app tiene que funcionar sin
 * administrador, y en algún enero de los próximos diez años nadie lanzará el sorteo. Un cuadrante
 * que no se puede publicar porque falta una fila en una tabla es peor que uno publicado por el
 * R4 que estaba delante.
 *
 * Ojo con `session.rol`: se calcula en el login y viaja firmado dentro del token, así que puede
 * ser de hace horas. La existencia del mandato se relee AQUÍ del store en cada llamada — si el
 * sorteo se resolvió a mitad de la sesión de alguien, el permiso deja de ser el de su token.
 *
 * Decisión V-49 (2026-09-03, ampliando V-46): antes de mirar mandato o grupo se comprueba
 * `esAccesoDesarrollador`, que destraba TODO este permiso —ya no solo `generarCuadranteIA`— para
 * el autor de la app mientras corrige errores de esta primera puesta en producción, y caduca solo
 * en la fecha fijada ahí sin que nadie tenga que acordarse de retirar el código.
 */
function requireCicloPermiso(deps, session, accion) {
  if (esAccesoDesarrollador(deps, session)) return null;
  const mandato = mandatoVigente(deps);
  if (mandato) {
    return mandato.residenteId === session.sub ? null : { ok: false, error: `solo el Responsable puede ${accion}` };
  }
  // Hidratado: `groupOnDate` deriva MAYOR/PEQUENO de los periodos, así que el permiso del ciclo
  // (V-16) depende de los editados. Leerlo crudo aquí sería justo la incoherencia por acción que
  // la fase 2 de V-24 viene a quitar — alguien sería Mayor para validar y Pequeño para el resto.
  const residente = allResidentes(deps).find((r) => r.id === session.sub);
  const grupo = residente ? deps.domain.groupOnDate(residente, deps.today) : null;
  if (grupo !== "MAYOR") {
    return { ok: false, error: `no hay Responsable designado para este periodo: hasta que se decida, solo un R3 o R4 puede ${accion}` };
  }
  return null;
}

/**
 * Contexto de `validateMonth` para un mes, reconstruido ENTERAMENTE desde el store — nunca se
 * confía en un `cuadrante` que mandara el cliente para decidir una transición de estado (mismo
 * principio que el rol derivado: "nunca un flag que el cliente pueda falsear"). Incluye el
 * histórico de rotación cross-mes (contrato C-2, spec.md §5), igual que Calendar.jsx/Generator.jsx
 * — mismo ensamblado que ambos, vía `deps.domain.buildMonthContext`.
 */
/**
 * Los datos ya DERIVADOS que necesita el prompt (V-45). Vive aquí y no en `ai-prompt.js` porque
 * derivar es cosa del dominio (`deps.domain`) y aquel módulo es texto puro: así el prompt se
 * puede probar sin montar medio dominio, y este ensamblado se prueba con el resto del router.
 *
 * El nivel se resuelve a día 1 del mes, el MISMO ancla que usa `accumulatedTally` por dentro
 * (vía `periodOn`): con otra fecha, un residente cuyo aniversario cae a mitad de mes aparecería
 * bajo su nivel nuevo con el contaje del año saliente, y el prompt le pediría al modelo equidad
 * sobre una cifra que no es la suya.
 */
function promptData(deps, mes, anio, snap) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;

  const porNivel = { R4: [], R3: [], R2: [], R1: [] };
  const finDeMes = `${prefix}-31`; // comparación de cadenas: cualquier día del mes es <= a esto
  for (const r of snap.residentes) {
    // Nivel el día 1 o, si ese día aún no está (se incorpora a mitad de mes), el del último día:
    // el mismo criterio que `asignablesDe`, para que el prompt liste exactamente a quienes el plan
    // reconoce. Sin esto, la fijada de un R1 recién incorporado era de un «desconocido».
    const nivel = nivelEnElMes(deps, r, monthStart);
    if (nivel === null) continue;
    // Presencia parcial en el mes: quien termina (fechaFin) o empieza (fechaInicio) a mitad. El
    // modelo no ve fechas de residencia, así que se le dice en la propia lista; el router rechaza
    // como FORMATO cualquier guardia fuera de esos días (`noAsignablesEseDia`).
    const entrada = { id: r.id, nombre: r.nombre };
    if (typeof r.fechaFin === "string" && r.fechaFin >= monthStart && r.fechaFin <= finDeMes) entrada.hasta = r.fechaFin;
    if (typeof r.fechaInicio === "string" && r.fechaInicio > monthStart && r.fechaInicio <= finDeMes) entrada.desde = r.fechaInicio;
    porNivel[nivel].push(entrada);
  }

  // `snap.asignaciones` es la tabla ENTERA: no hace falta acotar el rango como hacía el cliente
  // (que iba por red), y así el lookahead de doblete del contrato C-1 lo resuelve `tally` sola
  // con los días que ya tiene delante, sin que nadie tenga que acordarse de pedir dos días más.
  const acumuladosMap = deps.domain.accumulatedTally(snap.residentes, snap.asignaciones, deps.domain.addDays(monthStart, -1));
  const acumulados = {};
  acumuladosMap.forEach((v, k) => { acumulados[k] = v; });

  const curso = deps.domain.academicYearOf(monthStart);
  // Los dos días pegados al mes: la norma 13 del prompt (descanso, INV-15 en `error`) no se puede
  // cumplir sin saber quién tuvo la guardia del último día del mes anterior, y el validador SÍ la
  // mira (`buildCuadranteCtx` mete ese borde en el histórico) — así que sin esto el primer intento
  // caía casi siempre que alguien tenía el 31.
  const diaAntes = deps.domain.addDays(monthStart, -1);
  const siguiente = mes === 12 ? { mes: 1, anio: anio + 1 } : { mes: mes + 1, anio };
  const diaDespues = `${monthPrefix(siguiente.anio, siguiente.mes)}-01`;
  return {
    mes, anio, porNivel, acumulados,
    bordes: snap.asignaciones.filter((a) => CODIGOS_GUARDIA.has(a.codigo) && (a.fecha === diaAntes || a.fecha === diaDespues)),
    // Las celdas V/R/B del mes: la tarjeta promete conservarlas, y una guardia propuesta con la
    // misma clave las pisaría (el router la rechaza como FORMATO; esto es para que no la proponga).
    marcadores: snap.asignaciones.filter((a) => a.fecha.startsWith(prefix) && MARCADORES_REJILLA.has(a.codigo)),
    bloqueos: bloqueosInRange(deps, snap.bloqueos, monthStart, `${prefix}-31`),
    festivos: (snap.festivos || []).filter((f) => f.fecha.startsWith(prefix)),
    // Los puentes se DERIVAN de los festivos (§3.4), nunca se piden ni se escriben a mano.
    puentes: deps.domain.bridgesOfMonth(anio, mes, snap.festivos || []),
    // Solo quien dijo «sí» ESTE mes puede recibir un 3P (P-16/V-55).
    voluntarios3P: thirdPostForMonth(deps, mes, anio, snap.residentes).delMes.map((id) => ({ residenteId: id })),
    // Del CURSO, no del mes: la Navidad de diciembre empareja con la despedida del mayo
    // siguiente, que es el mismo criterio que aplica `buildMonthContext` (INV-10).
    eventos: (snap.eventos || []).filter((e) => deps.domain.academicYearOf(e.fecha) === curso),
    preferencias: deps.store.readLatest("preferencias", PREF_KEY).filter((p) => p.anio === anio && p.mes === mes),
  };
}

// Acceso de desarrollador para TODO el permiso del ciclo (decisión V-49, 2026-09-03, a pedido
// explícito del autor de la app — amplía V-46, que cubría solo `generarCuadranteIA`; no debe
// confundirse con V-47 (modos completar/reemplazar del generador) ni con V-48 (cierre anual de
// INV-3 entre compañeros de cohorte), las dos de otro autor. Vive DENTRO de `requireCicloPermiso`,
// así que validar/publicar/despublicar/excepciones/sorteo/imaginaria y las ediciones de
// fechas/periodos formativos/ausencias de otro
// residente quedan destrabadas igual: el autor va a corregir errores de esta primera puesta en
// producción durante los próximos meses y necesita poder resolver cualquier incidencia sin
// depender de tener el mandato de Responsable ni ser Mayor — forzarle el nivel o el grupo
// falsearía un dato que se deriva de fechas reales y alimenta INV-11 y compañía, así que sigue
// resolviéndose por identidad (email), no por rol ni nivel (mismo argumento que V-46).
// `FECHA_LIMITE_ACCESO_DESARROLLADOR` lo caduca solo: pasada esa fecha esta función vuelve a
// devolver `false` sin que nadie tenga que acordarse de retirar el bloque a mano — una excepción
// que solo se revierte si alguien se acuerda no sobrevive los diez años que el proyecto exige de
// sí mismo.
// Desde V-52 son DOS administradores (el autor y Quique); ver `requireValidarPermiso`.
const EMAILS_ACCESO_DESARROLLADOR = ["agustinlagioiosa@gmail.com", "quiquemm14@gmail.com"];
const FECHA_LIMITE_ACCESO_DESARROLLADOR = "2027-03-31";
function esAccesoDesarrollador(deps, session) {
  if (deps.today > FECHA_LIMITE_ACCESO_DESARROLLADOR) return false;
  const residente = allResidentes(deps).find((r) => r.id === session.sub);
  // Normalizado como en `handleLogin`: con el email en crudo, una mayúscula o un espacio al final en
  // la celda dejaban entrar al administrador (el login normaliza) pero no aprobar ni validar.
  return Boolean(residente) && EMAILS_ACCESO_DESARROLLADOR.includes(emailNormalizado(residente.email));
}

/**
 * Permiso para marcar un mes como VALIDADO (decisión V-52, 2026-10-06, a pedido del autor
 * mientras la app se estabiliza en producción): mientras dure la ventana de acceso de
 * desarrollador SOLO los administradores validan; el Responsable y los Mayores siguen pudiendo
 * publicar/despublicar y el resto del ciclo (`requireCicloPermiso`). Pasada
 * `FECHA_LIMITE_ACCESO_DESARROLLADOR` la restricción cae sola y vuelve la regla de V-16: un
 * servicio que depende de que alguien con un email concreto siga ahí incumple el criterio de
 * sobrevivir sin administrador, y nadie tendría que acordarse de retirarla.
 */
function requireValidarPermiso(deps, session, accion = "validar el cuadrante") {
  if (deps.today > FECHA_LIMITE_ACCESO_DESARROLLADOR) return requireCicloPermiso(deps, session, accion);
  if (esAccesoDesarrollador(deps, session)) return null;
  return { ok: false, error: `por ahora solo los administradores pueden ${accion}` };
}

// 6 minutos de Apps Script menos 1 de reserva para el lock, la relectura y la escritura.
const LIMITE_GENERACION_MS = (6 - 1) * 60 * 1000;

/**
 * `generarCuadranteIA` (decisión V-45). El orden importa y es el del encargo: permiso → estado →
 * contexto → propuesta del modelo → VALIDACIÓN → escritura. La escritura es el último paso y solo
 * ocurre si el validador calla; si no calla en 3 intentos, no se escribe ni una fila y queda la
 * bitácora diciendo que ese mes hay que montarlo a mano.
 *
 * Dos modos (decisión V-47). `completar` (defecto): las guardias que ya hay en la rejilla —las
 * que cada residente apuntó de antemano porque ya las tenía comprometidas— son inamovibles: van
 * al prompt como «ya fijadas», el validador juzga el mes RESULTANTE (fijadas + propuesta), y al
 * escribir no se borra nada. `reemplazar`: lo de V-45, el mes entero se sustituye. Antes solo
 * existía el segundo, y el generador se llevaba por delante justo lo que había que respetar.
 */
function handleGenerarIA(req, deps, session) {
  const denegado = requireCicloPermiso(deps, session, "generar el cuadrante con IA");
  if (denegado) return denegado;

  const fase = req.fase === undefined ? "obligatorias" : req.fase;
  if (!FASES_GENERACION.has(fase)) return { ok: false, error: `fase de generación inválida: ${JSON.stringify(req.fase)} (válidas: obligatorias, extras)` };
  const extras = fase === "extras";
  // Las extras solo AÑADEN: «reemplazar» no tiene sentido y se rechaza en vez de ignorarse.
  if (extras && req.modo !== undefined && req.modo !== "completar") return { ok: false, error: "la fase de quintas y tercer puestos solo admite el modo completar: únicamente añade guardias" };
  const modo = extras || req.modo === undefined ? "completar" : req.modo;
  if (!MODOS_GENERACION.has(modo)) return { ok: false, error: `modo de generación inválido: ${JSON.stringify(req.modo)} (válidos: completar, reemplazar)` };

  const estadoActual = validCuadranteMesAnio(req, deps);
  if (estadoActual === null) return { ok: false, error: "mes/anio inválido" };
  if (estadoActual === "PUBLICADO") {
    return { ok: false, error: `el cuadrante de ${req.mes}/${req.anio} está PUBLICADO y no admite ediciones: despublícalo antes de regenerarlo` };
  }
  // Decisión V-46 (2026-09-02, a pedido del autor): antes se ofrecía también sobre VALIDADO. Una
  // vez que el equipo se reúne y lo valida entre todos, regenerarlo por encima sería descartar en
  // silencio un mes que ya se revisó y se dio por bueno — así que ahora solo se ofrece en Borrador.
  if (estadoActual === "VALIDADO" && !extras) {
    return { ok: false, error: `el cuadrante de ${req.mes}/${req.anio} ya está VALIDADO: el generador con IA solo se ofrece en Borrador, para no reescribir un mes que el equipo ya revisó y dio por bueno` };
  }
  if (!deps.llm || typeof deps.llm.generar !== "function") {
    return { ok: false, error: "la generación con IA no está configurada en este despliegue: falta la propiedad GEMINI_API_KEY en la configuración del script" };
  }

  const snap = monthSnapshot(deps);
  // Una ausencia con fecha ilegible se aparta ANTES de gastar un solo intento (V-22): sobre ella
  // INV-5 no puede dar un veredicto, así que ninguna propuesta podría declararse válida y los tres
  // intentos se irían en algo que solo se arregla a mano, en la tabla `bloqueos`.
  if (snap.bloqueosCorruptos.length > 0) {
    return {
      ok: false,
      error: "hay ausencias con la fecha ilegible: mientras sigan así no se puede comprobar INV-5, arréglalas antes de generar",
      violaciones: bloqueoCorruptoViolations(snap.bloqueosCorruptos),
    };
  }

  const prefix = monthPrefix(req.anio, req.mes);
  const monthStart = `${prefix}-01`;
  const existentes = snap.asignaciones.filter((a) => a.fecha.startsWith(prefix));
  const completar = modo === "completar";
  // Los MISMOS residentes que ve el prompt (nivel R1–R4 el día 1). Con la tabla entera, el id de
  // alguien FINALIZADO o aún no incorporado era «conocido» para el plan, no caía en FORMATO, e INV-1
  // solo lo marcaba como aviso (V-21, pensado para la rejilla manual): la guardia de quien ya se fue
  // se ESCRIBÍA. Para el generador es un defecto de la RESPUESTA: nadie fuera de su lista.
  // Asignable = con nivel R1–R4 el día 1 O el último día del mes: quien se incorpora a mitad (el R1
  // del 27 de mayo) es PENDIENTE el día 1 y aun así tiene guardias ese mes — con el criterio «día 1»
  // sus fijadas eran de un desconocido y un modelo obediente fallaba siempre. `noAsignablesEseDia`
  // sigue rechazando, día a día, los días concretos en que no está. Mismo criterio que `promptData`.
  const asignablesDe = (snapX) => snapX.residentes.filter((r) => nivelEnElMes(deps, r, monthStart) !== null);
  // `snapX` porque el plan se recalcula con el snapshot fresco en el segundo juicio (bajo el lock):
  // quien dejó de ser asignable mientras el modelo pensaba (periodos editados) cae en `desconocidos`.
  const planDe = (propuesta, snapX = snap) => (completar ? deps.domain.monthCompletionPlan : deps.domain.monthReplacementPlan)({
    mes: req.mes, anio: req.anio, residentes: asignablesDe(snapX), existentes, propuesta,
  });
  // Y día a día: el nivel se mira el día 1 para la LISTA, pero quien termina la residencia a mitad
  // de mes (o se incorpora después del día 1) no puede hacer guardia los días en que ya no está (o
  // aún no está). INV-1 solo lo avisa (V-21, pensado para la rejilla manual); para el generador es
  // un defecto de la respuesta y se rechaza — y el prompt le dice al modelo hasta/desde qué día cuenta.
  const noAsignablesEseDia = (propuesta, snapX) => {
    const porId = new Map(snapX.residentes.map((r) => [r.id, r]));
    return propuesta.filter((a) => {
      const r = porId.get(a.residenteId);
      if (!r || typeof a.fecha !== "string" || !a.fecha.startsWith(prefix)) return false; // ids desconocidos y fechas de otro mes ya tienen su rechazo
      return !NIVELES_ASIGNABLES.has(deps.domain.levelOn(deps.domain.periodsOfResident(r), a.fecha));
    });
  };
  // Las fijadas se calculan UNA vez con la propuesta vacía: no dependen de lo que el modelo diga.
  const fijadas = completar ? planDe([]).fijadas : [];
  // En «reemplazar» también sobrevive algo: los 3P ya puestos, que `monthReplacementPlan` solo borra
  // si la propuesta trae 3P (V-38). Si el modelo no sabe que están, pone a esa persona el día
  // anterior o el siguiente y el mes escrito incumple INV-15 (descanso, regla legal) sin que el juez
  // lo viera — porque juzgaba la propuesta sola, no lo que iba a quedar en la rejilla.
  const conservadas = completar ? [] : existentes.filter((a) => a.codigo === "3P");
  const prompt = buildGenerationPrompt({ ...promptData(deps, req.mes, req.anio, snap), fijadas: completar ? fijadas : conservadas, fase });
  const modelo = (deps.llm && deps.llm.modelo) || "(sin declarar)";

  // El juez: exactamente el mismo que usa `marcarValidado`, ni más estricto ni más laxo. Un
  // generador más exigente que el validador pediría un mes que ninguna persona podría montar a
  // mano tampoco, y la app se quedaría sin cuadrante por exceso de celo. Parametrizado por el
  // snapshot porque se vuelve a juzgar, con uno fresco, justo antes de escribir (ver abajo).
  const validarCon = (snapX) => (propuesta) => {
    const plan = planDe(propuesta, snapX);
    // El guardarraíl de V-31, expresado como violaciones para que viaje al reintento: una fecha de
    // otro mes o un id inventado no incumplen ningún invariante (`validateMonth` ni los mira, sus
    // índices solo tienen días del mes y `desconocidos` es aviso) y sin embargo se ESCRIBIRÍAN —
    // en otro mes, o como filas que nadie puede ver ni corregir desde la rejilla. En modo completar
    // entra también pisar una fijada con otro código: se pidió respetarla, y «respetar» no admite
    // que el modelo la reescriba a su gusto.
    const rechazos = [
      ...plan.fueraDelMes.map((a) => ({
        invariante: "FORMATO", severidad: "error",
        detalle: `la fecha ${a.fecha} no es un día de ${req.mes}/${req.anio}: el cuadrante tiene que cubrir ese mes y solo ese mes`,
      })),
      ...plan.desconocidos.map((a) => ({
        invariante: "FORMATO", severidad: "error", residenteId: a.residenteId,
        detalle: `el residenteId "${a.residenteId}" no está en la lista de residentes activos de este mes: usa exactamente los ids de la lista de arriba`,
      })),
      ...noAsignablesEseDia(propuesta, snapX).map((a) => ({
        invariante: "FORMATO", severidad: "error", residenteId: a.residenteId,
        detalle: `el residente "${a.residenteId}" no está en activo el ${a.fecha} (mira su «solo desde/hasta» en la lista): no le pongas guardia ese día`,
      })),
      ...(plan.conflictos || []).map((c) => ({
        invariante: "FORMATO", severidad: "error", residenteId: c.fijada.residenteId,
        detalle: `la guardia ya fijada de "${c.fijada.residenteId}" el ${c.fijada.fecha} es ${c.fijada.codigo} y tu respuesta la cambia a ${c.propuesta.codigo}: las guardias fijadas se mantienen tal cual`,
      })),
      // La tabla es una rejilla por clave y «la última fila gana»: con la misma persona y día dos
      // veces (G y 3P) el validador juzgaba una lista y el Sheet guardaba otra — el día perdía su
      // Mayor después de que el validador lo diera por bueno.
      ...(plan.duplicadas || []).map((d) => ({
        invariante: "FORMATO", severidad: "error", residenteId: d.residenteId,
        detalle: `el ${d.fecha} el residenteId "${d.residenteId}" aparece ${d.codigos.length} veces (${d.codigos.join(", ")}): una sola asignación por residente y día`,
      })),
      // Una celda V/R/B la conserva la rejilla solo si nadie escribe encima con su clave: la tarjeta
      // promete conservarlas en los dos modos, así que proponer guardia ahí es un defecto de la respuesta.
      ...(plan.pisados || []).map((x) => ({
        invariante: "FORMATO", severidad: "error", residenteId: x.marcador.residenteId,
        detalle: `la celda de "${x.marcador.residenteId}" el ${x.marcador.fecha} está marcada ${x.marcador.codigo} en la rejilla: no propongas guardia a esa persona ese día`,
      })),
    ];
    // Reglas propias de cada fase, como rechazos de FORMATO: son el reparto de P-17, no invariantes.
    const guardiasPorDia = new Map();
    for (const f of fijadas) if (CODIGOS_GUARDIA.has(f.codigo)) guardiasPorDia.set(f.fecha, (guardiasPorDia.get(f.fecha) || 0) + 1);
    if (!extras) {
      for (const a of plan.cambios.filter((x) => x.codigo === "3P")) {
        rechazos.push({ invariante: "FORMATO", severidad: "error", residenteId: a.residenteId, detalle: `el 3P del ${a.fecha} no va en esta fase: ahora solo G, GF y GP; los tercer puestos se añaden después` });
      }
    } else {
      // El 3P solo va con TODOS los días de dos personas (P-17): INV-8e lo avisa, aquí es una regla
      // del reparto y se rechaza para que el modelo no lo proponga.
      const nuevosTresP = plan.cambios.filter((x) => x.codigo === "3P");
      if (nuevosTresP.length > 0) {
        const personas = new Map(guardiasPorDia);
        for (const c of plan.cambios) if (c.codigo !== "3P") personas.set(c.fecha, (personas.get(c.fecha) || 0) + 1);
        let dia = monthStart, hueco = null;
        while (dia.startsWith(prefix) && !hueco) { if ((personas.get(dia) || 0) < 2) hueco = dia; dia = deps.domain.addDays(dia, 1); }
        if (hueco) {
          for (const a of nuevosTresP) {
            rechazos.push({ invariante: "FORMATO", severidad: "error", residenteId: a.residenteId, detalle: `el 3P del ${a.fecha} no va todavía: el ${hueco} sigue con menos de dos personas y el tercer puesto solo se añade cuando todos los días tienen dos` });
          }
        }
      }
      for (const a of plan.cambios) {
        if (a.codigo !== "3P" && (guardiasPorDia.get(a.fecha) || 0) >= 2) {
          rechazos.push({ invariante: "FORMATO", severidad: "error", residenteId: a.residenteId, detalle: `el ${a.fecha} ya tiene dos personas: una guardia extra solo va en un día con una sola persona` });
        }
        if (a.codigo !== "3P" && (guardiasPorDia.get(a.fecha) || 0) === 0) {
          rechazos.push({ invariante: "FORMATO", severidad: "error", residenteId: a.residenteId, detalle: `el ${a.fecha} no tiene a nadie: esta fase no cubre días vacíos, solo añade a días con una sola persona` });
        }
      }
    }
    if (rechazos.length > 0) return rechazos; // no vale la pena juzgar un mes que ni siquiera es este
    // Se juzga siempre el mes RESULTANTE, lo que va a quedar escrito: en completar, lo fijado más lo
    // que la propuesta añade (juzgar solo la propuesta daría por bueno un día en que el modelo,
    // ignorando una fijada, pone a otro Mayor — y ese día tendría dos al escribirse); en reemplazar,
    // la propuesta más las guardias que el plan NO va a borrar (los 3P que sobreviven por V-38:
    // `plan.marcadores` son exactamente las filas no borrables para ESTA propuesta).
    const aJuzgar = completar
      ? [...plan.fijadas, ...plan.cambios]
      : [...plan.marcadores.filter((a) => CODIGOS_GUARDIA.has(a.codigo)), ...propuesta];
    return [
      ...deps.domain.validateMonth(buildCuadranteCtx(deps, req.mes, req.anio, snapX, aJuzgar)),
      ...deps.domain.validateThirdPost(buildThirdPostCtx(deps, req.mes, req.anio, snapX, aJuzgar)),
    ];
  };
  const validar = validarCon(snap);

  // Si lo ya fijado incumple POR SÍ SOLO una regla dura (dos días seguidos apuntados a mano, una
  // guardia sobre la propia baja, un R1 en julio), ninguna propuesta puede arreglarlo —tocar una
  // fijada es FORMATO— y los tres intentos se irían, a un minuto y una llamada al modelo cada uno,
  // en culpar al modelo con un «hay que montar este mes a mano». Se corta antes de gastar ninguno y
  // se dice la causa real. Los INV-1 de los días sin cubrir se excluyen porque son justo lo que el
  // modelo va a rellenar. Desde P-14 la composición entre fijadas (dos del mismo grupo el mismo día) ya no
  // es `error`, así que esto queda como defensa: el único INV-1 duro es el día vacío.
  if (extras && fijadas.length === 0) {
    return { ok: false, error: "el mes no tiene ninguna guardia: genera primero las obligatorias y después añade las quintas y los tercer puestos" };
  }
  if (completar && fijadas.length > 0) {
    // INV-1 se descarta SOLO donde es un hueco (menos de dos fijadas ocupando puesto ese día): con dos
    // o más, el error es de composición entre fijadas (dos Mayores el mismo día) y el modelo tampoco
    // puede arreglarlo. Criterio estructural por `fecha`, nunca por el texto del mensaje (V-14).
    const fijadasPorDia = new Map();
    for (const f of fijadas) if (CODIGOS_GUARDIA.has(f.codigo)) fijadasPorDia.set(f.fecha, (fijadasPorDia.get(f.fecha) || 0) + 1);
    // Y una fijada de alguien que no está en activo ese día (FINALIZADO, aún no incorporado, periodos
    // editados después de apuntarla): el prompt exigiría repetirla y el plan la rechazaría como
    // desconocida — un modelo obediente fallaría siempre.
    const porId = new Map(snap.residentes.map((r) => [r.id, r]));
    const fijadasAjenas = fijadas.filter((f) => {
      const r = porId.get(f.residenteId);
      return !r || !NIVELES_ASIGNABLES.has(deps.domain.levelOn(deps.domain.periodsOfResident(r), f.fecha));
    }).map((f) => ({
      invariante: "FORMATO", severidad: "error", residenteId: f.residenteId, fecha: f.fecha,
      detalle: `la guardia ya fijada de "${f.residenteId}" el ${f.fecha} es de alguien que no está en activo ese día: quítala o corrige sus fechas antes de generar`,
    }));
    const previos = [
      ...fijadasAjenas,
      // En «extras» no se excluye ningún INV-1: un día vacío es un hueco que esta fase no rellena.
      ...validar([]).filter((v) => v.severidad === "error" && (extras || v.invariante !== "INV-1" || (fijadasPorDia.get(v.fecha) || 0) >= 2)),
    ];
    if (previos.length > 0) {
      escribirBitacora(deps, session, req, modelo, 0, "FIJADAS_INVALIDAS", previos, extras ? "extras" : modo);
      return {
        ok: false, resultado: "FIJADAS_INVALIDAS", modo, intentos: 0, revisionManual: false, violaciones: previos,
        error: extras
          ? "el mes todavía incumple reglas obligatorias (por ejemplo, algún día sin cubrir): completa primero las guardias obligatorias y corrígelo antes de añadir quintas y tercer puestos (no se ha llamado al modelo ni se ha escrito nada)"
          : "las guardias que ya están en la rejilla incumplen por sí solas reglas obligatorias: corrígelas en el cuadrante antes de generar (no se ha llamado al modelo ni se ha escrito nada)",
      };
    }
  }

  // El ciclo para antes de que Google mate la ejecución (6 min): muerta, no contesta JSON sino una
  // página sin CORS, y ni el responsable sabe qué pasó ni queda fila en la bitácora (2026-10-08).
  // Se cuenta desde que empezó la petición (`deps.now` se toma al construir `deps`), y se deja
  // sitio para lo que viene después: hasta 30 s esperando el lock, releer el mes y escribir.
  // Sin `relojMs` (un Code.gs anterior) no hay límite, como antes.
  const reloj = typeof deps.relojMs === "function" ? deps.relojMs : undefined;
  const r = generateSchedule({ prompt, llm: deps.llm.generar, validar, reloj, limiteMs: deps.now * 1000 + LIMITE_GENERACION_MS });

  if (!r.ok) {
    escribirBitacora(deps, session, req, modelo, r.intentos, r.resultado, r.violaciones, extras ? "extras" : modo);
    return {
      ok: false, error: r.error, resultado: r.resultado, modo,
      revisionManual: r.resultado === "REVISION_MANUAL",
      intentos: r.intentos, violaciones: r.violaciones,
    };
  }

  // Mismo camino de escritura que el «Aplicar» de siempre (V-31): un solo lote append-only con la
  // propuesta MÁS —solo en modo reemplazar— una fila de borrado por cada guardia previa que no se
  // pisa por clave. No hay una segunda vía de escritura, así que la IA no puede saltarse ningún
  // control que ya existía. En modo completar el lote puede quedar VACÍO (el mes ya estaba
  // completo y el modelo lo devolvió tal cual): `appendRecords` no escribe nada y se dice.
  //
  // Bajo el lock, y solo la escritura (2026-09-04): la generación tarda un minuto largo y no se
  // puede tener el lock todo ese tiempo (bloquearía cualquier guardado del equipo hasta agotar
  // los 30 s de espera). Lo que sí se hace es RELEER el mes dentro del lock: si alguien guardó
  // una celda o cambió el estado mientras el modelo pensaba, la propuesta se validó contra un mes
  // que ya no existe y no se escribe — se dice y se vuelve a intentar, que cuesta un minuto; una
  // guardia nueva pisada en silencio no tiene arreglo que nadie vaya a notar.
  const plan = planDe(r.asignaciones);
  const huella = (lista) => lista.map((a) => `${a.fecha}|${a.residenteId}|${a.codigo}|${a.origen || ""}`).sort().join("\n");
  // Y si el lock no llega (otro escritor lo tiene más de 30 s: `waitLock` LANZA), la propuesta se
  // pierde igual que en un conflicto y se dice como tal, con su fila en la bitácora — no como una
  // excepción muda que `handleRequest` convierte en «Lock timeout…» sin `resultado`.
  let escrito;
  try {
    escrito = atomico(deps, () => {
    const estadoAhora = currentCuadranteEstado(deps, req.mes, req.anio);
    const snapAhora = monthSnapshot(deps);
    const existentesAhora = snapAhora.asignaciones.filter((a) => a.fecha.startsWith(prefix));
    if (estadoAhora !== estadoActual || huella(existentesAhora) !== huella(existentes)) return null;
    // La huella solo cubre el mes: una BAJA registrada mientras el modelo pensaba (`crearBloqueo`
    // está abierto a cualquiera para sí mismo) no siempre la cambia —desde V-50 SÍ lo hace cuando
    // `writeBloqueoMarcas` encuentra la celda vacía y le pone una "B", pero si el día ya tenía un
    // código puesto la marca no se escribe y la huella queda igual—, y la propuesta se juzgó
    // contra unas ausencias que ya no son las de ahora — se habrían escrito guardias sobre una
    // baja médica (INV-5, la regla legal). Lo mismo con un residente nuevo o unos periodos
    // editados. Volver a juzgar cuesta milisegundos: solo se escribe si el mes resultante sigue
    // sin errores AHORA.
    if (snapAhora.bloqueosCorruptos.length > 0) return null;
    if (validarCon(snapAhora)(r.asignaciones).some((v) => v.severidad === "error")) return null;
    deps.store.appendRecords("asignaciones", plan.cambios);
        // Las extras no revierten un VALIDADO (V-58): solo añaden, y lo añadido ya se juzgó contra el mes resultante.
    const siguiente = plan.cambios.length > 0 && !extras ? deps.domain.stateAfterEdit(estadoActual) : estadoActual;
    if (siguiente !== estadoActual) writeCuadranteEstado(deps, session, req.mes, req.anio, siguiente);
    return { siguiente };
    });
  } catch (e) {
    escribirBitacora(deps, session, req, modelo, r.intentos, "CONFLICTO", r.violaciones, extras ? "extras" : modo);
    return {
      ok: false, resultado: "CONFLICTO", modo, intentos: r.intentos, violaciones: r.violaciones, revisionManual: false,
      error: `no se pudo escribir el cuadrante de ${req.mes}/${req.anio} porque otra operación tenía la hoja ocupada (${(e && e.message) || e}): no se ha escrito nada, vuelve a intentarlo`,
    };
  }
  if (!escrito) {
    escribirBitacora(deps, session, req, modelo, r.intentos, "CONFLICTO", r.violaciones, extras ? "extras" : modo);
    return {
      ok: false, resultado: "CONFLICTO", modo, intentos: r.intentos, violaciones: r.violaciones, revisionManual: false,
      error: `el cuadrante de ${req.mes}/${req.anio} cambió mientras se generaba (alguien guardó celdas, registró una ausencia o cambió su estado): no se ha escrito nada, vuelve a intentarlo`,
    };
  }
  escribirBitacora(deps, session, req, modelo, r.intentos, "APLICADO", r.violaciones, extras ? "extras" : modo);

  return {
    ok: true, estado: escrito.siguiente, modelo, intentos: r.intentos, modo, fase,
    guardados: plan.cambios.length, borradas: plan.borradas.length, respetadas: completar ? fijadas.length : plan.marcadores.filter((a) => CODIGOS_GUARDIA.has(a.codigo)).length,
    // Los avisos que quedan viajan de vuelta: no bloquean (V-14), pero quien acaba de guardar un
    // mes tiene derecho a ver que cojea en equidad antes de darlo por bueno.
    violaciones: r.violaciones,
  };
}

function escribirBitacora(deps, session, req, modelo, intentos, resultado, violaciones, modo) {
  // Acotada y sin lanzar (2026-09-04). Acotada: 500 ids inventados daban 500 violaciones y ~96 KB
  // de JSON, por encima de lo que admite una celda de Sheets, y `setValues` lanzaba. Sin lanzar: en
  // el caso APLICADO el mes YA está escrito, y un fallo de la bitácora convertido en `ok:false`
  // haría creer que no se guardó nada — y regenerar en «reemplazar» un mes recién generado. La
  // bitácora es memoria de lo que pasó, nunca puede decidir si pasó.
  const lista = Array.isArray(violaciones) ? violaciones : [];
  const acorta = (v) => ({
    ...v,
    detalle: String((v && v.detalle) || "").slice(0, BITACORA_MAX_DETALLE),
    ...(v && typeof v.residenteId === "string" ? { residenteId: v.residenteId.slice(0, 100) } : {}),
  });
  const recorte = lista.slice(0, BITACORA_MAX_VIOLACIONES).map(acorta);
  while (recorte.length > 0 && JSON.stringify(recorte).length > BITACORA_MAX_CHARS) recorte.pop();
  if (recorte.length < lista.length) recorte.push({ invariante: "BITACORA", severidad: "aviso", detalle: `y ${lista.length - recorte.length} más (recortado)` });
  try {
    deps.store.appendRecord("generaciones", {
      mes: req.mes, anio: req.anio, fecha: deps.today, actorId: session.sub,
      modelo, intentos, resultado, violaciones: recorte, modo: String(modo || "").toUpperCase(),
    });
  } catch (e) {
    // Se traga a propósito (ver arriba). Code.gs no expone un logger a través de `deps`.
  }
}

/**
 * @param {object[]} [propuesta] Asignaciones del mes a juzgar EN LUGAR de las guardadas. Lo usa
 *   `generarCuadranteIA` (V-45) para validar lo que propone el modelo antes de escribir nada:
 *   sin esto habría que guardar primero y validar después, que es exactamente lo contrario de
 *   «la IA propone, el validador dispone». Sin el parámetro, se juzga lo que hay en el Sheet.
 */
function buildCuadranteCtx(deps, mes, anio, snap = monthSnapshot(deps), propuesta = null) {
  const prefix = monthPrefix(anio, mes);
  const monthStart = `${prefix}-01`;
  const bloqueos = bloqueosInRange(deps, snap.bloqueos, monthStart, `${prefix}-31`);
  const asignacionesDelMes = propuesta || snap.asignaciones.filter((a) => a.fecha.startsWith(prefix));
  // El histórico lleva SIEMPRE los dos días de fuera del mes (2026-09-04): INV-15 juzga el par de
  // días consecutivos y cuenta con que «el histórico ya llega», pero aquí solo llegaba cuando había
  // una rotación cercana (C-2). En el caso normal, una guardia el día 1 pegada a otra el último día
  // del mes anterior pasaba `marcarValidado`, y el generador con IA la ESCRIBÍA aunque el prompt le
  // pidiera lo contrario. Calendar.jsx ya lo hacía por su cuenta (`bordes`); el servidor es el juez.
  // Con margen hacia atrás: el vecino del día 1 cae en el mes anterior y decide si es puente
  // (§3.4). Se cogen los festivos desde el 1 del mes anterior —de más, y son inertes: isHoliday
  // compara fechas exactas y bridgesOfMonth solo mira día±1— en vez de restar un día, para no
  // necesitar aritmética de fechas aquí. El filtro por mes SÍ importa: si la lista llegara
  // completa, un año sin cargar dejaría de disparar el aviso de "no hay festivos cargados".
  const mesAnterior = mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, "0")}`;
  const mesSiguiente = mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, "0")}`;
  const festivos = (snap.festivos || []).filter((f) => f.fecha >= `${mesAnterior}-01` && f.fecha <= `${mesSiguiente}-01`);
  // El mismo margen para las asignaciones: el mes anterior entero (sobra, y es inerte: cada
  // invariante mira solo los días del mes, salvo INV-15 que juzga el par con la víspera del día 1,
  // e INV-7, que ya pedía este histórico por C-2) y el día 1 del siguiente. Sin la rotación cercana
  // el histórico era `[]`, así que una guardia el día 1 pegada a la del último día del mes anterior
  // pasaba `marcarValidado` y el generador con IA la ESCRIBÍA aunque el prompt le pidiera lo
  // contrario. Calendar.jsx ya lo hacía por su cuenta (`bordes`); el servidor es el juez.
  const desdeRotacion = deps.domain.rotationHistoryStart(bloqueos, monthStart);
  const desdeHistorico = desdeRotacion && desdeRotacion < `${mesAnterior}-01` ? desdeRotacion : `${mesAnterior}-01`;
  const historicas = snap.asignaciones.filter((a) => (a.fecha >= desdeHistorico && a.fecha < monthStart) || a.fecha === `${mesSiguiente}-01`);
  // Los eventos van SIN filtrar por mes: `buildMonthContext` se queda con los del año académico,
  // que es lo que empareja la Navidad de diciembre con la despedida del mayo siguiente. Las
  // excepciones también van sin filtrar: `twoR2Justified` ya comprueba tipo y rango él mismo.
  return deps.domain.buildMonthContext({ mes, anio, residentes: snap.residentes, historicas, asignacionesDelMes, bloqueos, festivos, eventos: snap.eventos || [], excepciones: snap.excepciones || [] });
}

/**
 * Escribe la proyección legible del mes (pestaña mensual "YYYY-MM" + hoja "Resumen") en el
 * Sheet real — spec.md §7, decisión V-11a. Se llama ANTES de escribir el estado PUBLICADO
 * (publicarCuadrante): si `rebuildSheet` lanza (fallo real de la API de Sheets), la
 * excepción sube hasta el try/catch de `handleRequest` y el cuadrante queda intacto en
 * VALIDADO — nunca un PUBLICADO fantasma con el Sheet a medio escribir. `rebuildSheet` ya
 * es idempotente/autorreparable (sheets-store.js), así que basta con reintentar "Publicar".
 * `publishedMonths` incluye el mes que se está publicando AHORA aunque su fila de estado
 * todavía no exista en la tabla `cuadrantes` (se escribe después de esta función).
 *
 * Ventana de desincronización aceptada (revisión de 4 agentes, Fase 7.1): las dos llamadas a
 * `rebuildSheet` (mensual, luego Resumen) no son una transacción conjunta — si la mensual
 * tiene éxito pero Resumen falla, el Sheet queda con la pestaña "YYYY-MM" ya actualizada
 * mientras el cuadrante sigue en VALIDADO (nunca PUBLICADO: eso sí está garantizado). El
 * siguiente "Publicar" con éxito reescribe AMBAS pestañas desde cero y lo repara del todo;
 * no se ha construido nada más elaborado (dos fases, rollback) porque la ventana es estrecha
 * y de bajo impacto (~15 usuarios, latencia de Apps Script) frente a la complejidad de evitarla.
 */
function projectCuadranteToSheets(deps, mes, anio) {
  const residentes = allResidentes(deps);
  const prefix = monthPrefix(anio, mes);
  const asignacionesDelMes = deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" })
    .filter((a) => a.fecha.startsWith(prefix));

  const mensual = deps.domain.buildMonthSheetRows({ anio, mes, residentes, asignaciones: asignacionesDelMes });
  deps.store.rebuildSheet(mensual.sheetName, mensual.rows);

  const otrosPublicados = deps.store.readLatest("cuadrantes", CUAD_KEY).filter((r) => r.estado === "PUBLICADO");
  const publishedMonths = [...otrosPublicados.map((r) => ({ mes: r.mes, anio: r.anio })), { mes, anio }];

  // Las dos hojas agregadas son del CURSO académico del mes que se publica (decisión V-25), y lo
  // llevan en el nombre: publicar una corrección de un curso anterior republica LA HOJA DE ESE
  // CURSO, sin tocar la del actual. Con un nombre fijo se habrían pisado.
  const curso = deps.domain.academicYearOf(deps.domain.toISO(anio, mes, 1));
  const resumen = deps.domain.buildResumenRows({ residentes, publishedMonths, curso });
  deps.store.rebuildSheet(resumen.sheetName, resumen.rows);

  const contaje = deps.domain.buildContajeTrimestralRows({ residentes, publishedMonths, curso });
  deps.store.rebuildSheet(contaje.sheetName, contaje.rows);

  return { mensual: mensual.sheetName, resumen: resumen.sheetName, contaje: contaje.sheetName };
}

/**
 * Vuelca el contaje oficial al Excel del servicio (decisión V-65) para los cursos que toca el mes
 * `mes/anio` (`contajeCourses`: el suyo y el del mes anterior). NUNCA lanza: devuelve
 * `{ok:true, cursos}`, `{ok:false, error}` o `{omitido: motivo}`, porque lo llama
 * `publicarCuadrante` después de publicar y un fallo aquí no puede deshacer ni tapar la
 * publicación.
 *
 * El Excel es el puerto `deps.contaje` (Code.gs: `contaje_()`; dev-server y tests: el doble de
 * `server/contaje-memoria.mjs`), y es `null` cuando no hay propiedad CONTAJE_SPREADSHEET_ID: la
 * app funciona entonces exactamente como antes. QUÉ se escribe lo decide el dominio
 * (`contajeExcel.js`); aquí solo se lee el store, se comprueba y se manda aplicar.
 *
 * Va bajo el lock aunque no escriba en el store: dos publicaciones casi a la vez escribirían el
 * mismo fichero intercaladas, y con el lock la segunda espera y vuelca con lo que dejó la primera.
 * Las lecturas del store, además, son las de DENTRO del lock (el store vacía su memoria al cogerlo).
 */
function volcarContajeExcel(deps, mes, anio) {
  // `configurado: false` distingue «no hay fichero» —lo normal hasta que alguien ponga la propiedad,
  // y la pantalla no tiene nada que avisar— de «hay fichero y no se ha podido abrir», que sí avisa.
  if (!deps.contaje) return { omitido: "no está configurada la propiedad CONTAJE_SPREADSHEET_ID", configurado: false };
  // `ms`: cuánto ha durado (la mayor parte, con el script lock cogido, que las demás escrituras
  // esperan 30 s). Viaja en la respuesta para que el paso de comprobación del README tenga un
  // número y no una impresión. Sin `relojMs` (un Code.gs anterior) no se mide.
  const reloj = typeof deps.relojMs === "function" ? deps.relojMs : null;
  const inicio = reloj ? reloj() : 0;
  const conTiempo = (r) => (reloj ? { ...r, ms: reloj() - inicio } : r);
  try {
    const motivo = deps.contaje.abrir();
    if (motivo) return { omitido: motivo };
    return conTiempo(atomico(deps, () => escribirContaje(deps, mes, anio)));
  } catch (e) {
    // Solo la causa: la pantalla ya dice «no se pudo escribir el contaje en el Excel del servicio».
    return conTiempo({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

function escribirContaje(deps, mes, anio) {
  const D = deps.domain;
  const c = deps.contaje;
  const leerHuella = (hoja, huella) => huella.map((l) => c.leer(hoja, l));

  const fallo = prepararContaje(deps);
  if (fallo) return { ok: false, error: fallo };

  const base = {
    residentes: allResidentes(deps),
    asignaciones: deps.store.readLatest("asignaciones", ASIG_KEY, { emptyField: "codigo" }),
    publicados: deps.store.readLatest("cuadrantes", CUAD_KEY).filter((r) => r.estado === "PUBLICADO").map((r) => ({ mes: r.mes, anio: r.anio })),
    preferencias: deps.store.readLatest("preferencias", PREF_KEY),
    actualizado: deps.today,
  };

  // Primero se comprueba TODO (que existan las pestañas y que sus cabeceras sean las esperadas, en
  // todos los cursos) y solo después se escribe: una huella que no cuadra es una hoja que alguien
  // ha reorganizado a mano, y escribir por posición encima la estropearía en silencio.
  const planes = [];
  for (const curso of D.contajeCourses(mes, anio)) {
    if (D.buildContajePlan({ ...base, curso }) === null) continue; // ningún mes publicado en ese curso
    const hojas = D.contajeSheets(curso);
    const existentes = new Set(c.hojas());
    for (const h of hojas) if (!existentes.has(h.nombre)) c.duplicar(h.plantilla, h.nombre);
    for (const h of hojas) {
      const mal = D.contajeFingerprintMismatch(h.huella, leerHuella(h.nombre, h.huella));
      if (mal) return { ok: false, error: `la hoja «${h.nombre}» no tiene la forma esperada (${mal}): no se ha escrito nada en el contaje` };
    }
    const tercer = hojas.find((h) => h.clave === "tercerPuesto");
    planes.push(D.buildContajePlan({ ...base, curso, observaciones: c.leer(tercer.nombre, D.CONTAJE_LECTURA_OBS) }));
  }
  for (const plan of planes) for (const h of plan.hojas) c.aplicar(h.nombre, h.ops);
  return { ok: true, cursos: planes.map((p) => ({ curso: p.etiqueta, mesMostrado: p.mesMostrado, mesesPublicados: p.mesesPublicados.length })) };
}

/**
 * Preparación ÚNICA del fichero convertido (V-65), para que el autor no tenga que hacer nada a mano
 * salvo convertirlo y poner la propiedad: las hojas originales pasan a «Plantilla · …» (con GP y
 * sin los botones de una macro que nunca existió) y se ocultan, se borra `__DATA__` y se reescriben
 * Instrucciones e Imaginaria. Idempotente y reanudable: si una ejecución muere a medias, la
 * siguiente reconoce por su huella una hoja ya reconvertida y le vuelve a aplicar TODAS sus
 * operaciones antes de renombrarla. Solo renombrarla dejaría para siempre lo que no llegó a
 * aplicarse (las filas de ejemplo con nombres reales, las combinadas, la fijación) en una plantilla
 * de la que se copia cada curso. Repetirlas no cuesta nada: escribir, limpiar, desunir y unir el
 * mismo rango, anchos y fijación dan lo mismo dos veces.
 *
 * Devuelve null si el fichero queda listo, o el motivo por el que no se ha tocado. Se comprueba
 * TODO antes de cambiar nada: un fichero que no es el que conocemos no se modifica.
 */
function prepararContaje(deps) {
  const D = deps.domain;
  const c = deps.contaje;
  const prep = D.contajePreparation();
  const hojas = new Set(c.hojas());
  if (prep.originales.every((o) => hojas.has(o.plantilla)) && prep.borrar.every((n) => !hojas.has(n))) return null;

  const leer = (hoja, huella) => huella.map((l) => c.leer(hoja, l));
  const pendientes = [];
  for (const o of prep.originales) {
    if (hojas.has(o.plantilla)) continue;
    if (!hojas.has(o.original)) return `el fichero de contaje no tiene ni «${o.plantilla}» ni «${o.original}»: ¿es el Excel del servicio?`;
    if (D.contajeFingerprintMismatch(o.huellaOriginal, leer(o.original, o.huellaOriginal)) !== null) {
      const mal = D.contajeFingerprintMismatch(o.huellaPlantilla, leer(o.original, o.huellaPlantilla));
      if (mal) return `la hoja «${o.original}» no tiene la forma del Excel del servicio (${mal}): no se ha preparado el fichero`;
    }
    pendientes.push(o);
  }

  for (const f of prep.fijas) {
    // Una hoja fija que no reconocemos (renombrada, reutilizada) se deja como está.
    if (hojas.has(f.hoja) && D.contajeFingerprintMismatch(f.huella, leer(f.hoja, f.huella)) === null) c.aplicar(f.hoja, f.ops);
  }
  for (const n of prep.borrar) if (hojas.has(n)) c.borrar(n);
  for (const o of pendientes) {
    c.aplicar(o.original, o.ops);
    c.renombrar(o.original, o.plantilla);
    c.ocultar(o.plantilla);
  }
  return null;
}

/**
 * Estado del mandato de un periodo: quién es elegible (R3 en el 1 de enero, derivado), quién se
 * ha ofrecido, si ya está decidido. Extraído porque `estadoResponsable` lo devuelve para dos
 * periodos (el pedido y el siguiente) y reimplementarlo dos veces es cómo se desincronizan.
 */
function periodoResponsable(deps, anio, session, residentes) {
  const { periodoInicio, periodoFin } = mandatoPeriod(anio);
  const voluntarios = activeVolunteers(deps, periodoInicio);
  return {
    anio, periodoInicio, periodoFin,
    elegibles: deps.domain.eligibleCandidates(residentes, periodoInicio),
    voluntarios,
    meHeOfrecido: voluntarios.includes(session.sub),
    mandato: currentMandate(deps, periodoInicio),
  };
}

/**
 * Voluntarios del tercer puesto en un mes, derivados de las preferencias (P-16/V-55). Una sola
 * lectura de `preferencias` y una sola definición, en el dominio, de quién cuenta para qué: el
 * reparto del mes (`delMes`), INV-8b/8c (`voluntarios`, con `desde` = inicio del año de
 * residencia) e INV-8a (`periodos`, un «sí» = el mes entero).
 */
function thirdPostForMonth(deps, mes, anio, residentes) {
  return deps.domain.thirdPostVolunteersFromPrefs(deps.store.readLatest("preferencias", PREF_KEY), residentes, mes, anio);
}

/** Mandato enero→enero (INV-14) para el año dado: [YYYY-01-01, (YYYY+1)-01-01). */
function mandatoPeriod(anio) {
  return { periodoInicio: `${anio}-01-01`, periodoFin: `${anio + 1}-01-01` };
}

/** Voluntarios activos (última reinserción gana, como cancelarBloqueo) para un periodo. */
function activeVolunteers(deps, periodoInicio) {
  return deps.store.readLatest("voluntariosResponsable", (r) => `${r.residenteId}|${r.periodoInicio}`)
    .filter((v) => v.periodoInicio === periodoInicio && v.activo === true)
    .map((v) => v.residenteId);
}

/** El mandato ya decidido para un periodo, si existe (última reinserción gana). */
function currentMandate(deps, periodoInicio) {
  return deps.store.readLatest("responsables", (r) => r.periodoInicio).find((r) => r.periodoInicio === periodoInicio) || null;
}

/**
 * Valida la sesión y ejecuta `fn(payload)`, o devuelve el error de sesión.
 *
 * El `pendingToken` de `handleLogin` (emitido a un email que Google verificó pero que NO está
 * vinculado a ningún residente) va firmado con el MISMO secreto que una sesión, así que sin la
 * segunda comprobación valdría como sesión completa: y como el endpoint es ANYONE_ANONYMOUS y el
 * client_id es público, cualquiera con una cuenta de Google podía conseguir uno abriendo la web.
 * Se exige un `sub` (id de residente) en POSITIVO, no se descarta `pending` en negativo: así
 * cualquier clase futura de token sin sujeto queda fuera por defecto en vez de por enumeración.
 */
// Solo lecturas: un lote no puede escribir (una escritura que falla a medias entre varias no tiene
// un resultado que contar) ni anidar otro lote ni tocar el login. Lista explícita, como
// `REINTENTABLES` del cliente: lo que no está aquí se rechaza.
const LOTE_ACCIONES = new Set([
  "whoami", "listResidentes", "listAsignaciones", "listAsignacionesRango",
  "misPreferencias", "listPreferencias", "misBloqueos", "listBloqueos", "listBloqueosRango",
  "listFestivosRango", "listEventos", "listExcepciones", "colaImaginaria",
  "estadoResponsable", "listResponsables", "estadoCuadrante", "estadoVoluntariado3P",
  "listSolicitudesInvitado", "estadoRevisionFestivos",
]);
const LOTE_MAX = 12;

function handleLote(req, deps) {
  const llamadas = req.llamadas;
  if (!Array.isArray(llamadas) || llamadas.length === 0 || llamadas.length > LOTE_MAX) {
    return { ok: false, error: `un lote lleva de 1 a ${LOTE_MAX} llamadas` };
  }
  // La sesión se comprueba UNA vez por delante: sin ella, ninguna llamada interior valdría y
  // todas devolverían lo mismo; así el cliente recibe el rechazo de sesión de siempre.
  const s = verifySession(req.session, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid) return { ok: false, error: `sesión ${s.reason}` };
  const resultados = llamadas.map((ll) => {
    if (!ll || typeof ll !== "object" || !LOTE_ACCIONES.has(ll.action)) {
      return { ok: false, error: `acción no admitida en un lote: ${ll && typeof ll === "object" ? ll.action : ll}` };
    }
    return handleRequest(JSON.stringify({ ...ll, session: req.session }), deps);
  });
  return { ok: true, resultados };
}

function authed(req, deps, fn) {
  const s = verifySession(req.session, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid) return { ok: false, error: `sesión ${s.reason}` };
  if (typeof s.payload.sub !== "string" || !s.payload.sub) {
    return { ok: false, error: "el token no identifica a ningún residente (¿es un token de alta?)" };
  }
  // Perfil de invitado (V-53): por DEFECTO NEGADO. Lo que no está en `INVITADO_ACCIONES` se rechaza
  // aquí, en el único sitio por el que pasa toda acción con sesión, en vez de añadir una guarda a
  // cada `case` — una acción nueva (de escritura o de lectura sensible) queda cerrada al invitado
  // sin que nadie tenga que acordarse de él.
  if (s.payload.rol === ROL_INVITADO && !INVITADO_ACCIONES.has(req.action)) {
    return { ok: false, error: "el perfil de invitado es de solo lectura" };
  }
  return fn(s.payload);
}

// ── Perfil de invitado (V-53) ──────────────────────────────────────────────────────────────────
// Pensado para tutores u otras personas que quieren MIRAR el cuadrante sin darse de alta. Se
// pide con una cuenta de Google verificada (el `pendingToken` de un login con email no vinculado),
// un administrador la aprueba en menos de 5 min y la sesión lleva `rol: "invitado"` firmado: el cliente no puede
// ascenderse. No se crea ningún residente; solo queda la fila de la solicitud, y el email no viaja en el
// token. Ve el cuadrante, el equipo y el estado del ciclo; NO ve ausencias (bajas médicas incluidas),
// preferencias, imaginaria ni los emails de los residentes.
const ROL_INVITADO = "invitado";
const INVITADO_TTL = 2 * 60 * 60; // 2 h: una consulta, no una jornada
const INVITADO_ACCIONES = new Set([
  "whoami", "listResidentes", "listAsignaciones", "listAsignacionesRango", "listFestivosRango",
  "estadoCuadrante", "estadoResponsable", "listResponsables",
]);

/**
 * A un invitado se le quitan los emails de la lista de residentes y se le tapan los huecos entre
 * periodos formativos; al resto se le deja igual. Un hueco (S-3) es justo como tutoría registra que
 * una baja larga retrasa la promoción (`guardarPeriodos`), así que el `end` de un periodo y el
 * `start` del siguiente daban las fechas exactas de la ausencia. Tapado (cada `end` pasa a ser la
 * víspera del siguiente `start`), el nivel derivado no cambia ningún día: `levelOn`/`periodOn` solo
 * miran los `start` y el `end` del último periodo, y en un hueco ya conservaban el periodo anterior.
 */
function paraSesion(residentes, session, deps) {
  if (!session || session.rol !== ROL_INVITADO) return residentes;
  return residentes.map(({ email, ...resto }) => (resto.periodos ? { ...resto, periodos: periodosSinHuecos(resto.periodos, deps) } : resto));
}

function periodosSinHuecos(periodos, deps) {
  return periodos.map((p, i) => (i < periodos.length - 1 ? { ...p, end: deps.domain.addDays(periodos[i + 1].start, -1) } : p));
}

/**
 * A un invitado no le llegan las marcas de ausencia de la rejilla (V/R/B, `MARCADORES_REJILLA`). Desde
 * V-50, registrar una ausencia escribe su marca en `asignaciones`, así que con solo la lista blanca
 * de V-53 el invitado veía en el cuadrante quién está de baja médica, de vacaciones o rotando —
 * justo lo que V-53 promete que no ve—. Basta con quitarlas: `readLatest` ya devuelve solo la última
 * fila de cada celda, así que ninguna guardia anterior vuelve a asomar en su lugar.
 */
function asignacionesParaSesion(asignaciones, session) {
  if (!session || session.rol !== ROL_INVITADO) return asignaciones;
  return asignaciones.filter((a) => !MARCADORES_REJILLA.has(a.codigo));
}

const SOLICITUD_TTL = 300; // 5 min: lo que dura la solicitud para ser aprobada y canjeada

/** Último estado de cada solicitud (append-only: la última fila de cada `id` gana). */
function allSolicitudes(deps) {
  return deps.store.readLatest("solicitudesInvitado", (r) => r.id);
}

/** Las que siguen PENDIENTES y dentro de su ventana de 5 min: lo que un administrador puede decidir. */
function solicitudesPendientes(deps) {
  return allSolicitudes(deps)
    .filter((r) => r.estado === "PENDIENTE" && deps.now - r.solicitadoEn <= SOLICITUD_TTL)
    .map((r) => ({ id: r.id, email: r.email, tipo: r.tipo || "INVITADO", nombre: r.nombre, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin, solicitadoEn: r.solicitadoEn, expiraEn: r.solicitadoEn + SOLICITUD_TTL }));
}

/**
 * Pide entrar como invitado. La identidad ya está verificada con Google (el `pendingToken` solo lo
 * emite un login que pasó aud/iss/email_verified/exp), pero NO basta para ver datos del servicio:
 * un administrador tiene que aprobarla.
 */
function handleSolicitarInvitado(req, deps) {
  const s = verifySession(req.pendingToken, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!s.valid || !s.payload.pending) return { ok: false, error: "pendingToken inválido o caducado" };
  return atomico(deps, () => crearSolicitud(deps, s.payload.email, "INVITADO", {}));
}

/**
 * Alta de una solicitud (INVITADO o ALTA). Una pendiente del mismo email y tipo se reutiliza, para
 * que pulsar el botón varias veces no inunde de correos a quien puede aprobarla.
 */
function crearSolicitud(deps, email, tipo, datos) {
  let sol = allSolicitudes(deps).find((r) => r.email === email && (r.tipo || "INVITADO") === tipo && r.estado === "PENDIENTE" && deps.now - r.solicitadoEn <= SOLICITUD_TTL);
  // `avisados` solo viaja cuando se SABE (V-57): en una solicitud reutilizada el correo se mandó
  // —o falló— en otra petición y no queda constancia, así que no se afirma ni lo uno ni lo otro.
  let avisados;
  if (!sol) {
    const id = deps.store.appendRecord("solicitudesInvitado", { email, solicitadoEn: deps.now, estado: "PENDIENTE", tipo, ...datos });
    sol = { id, email, solicitadoEn: deps.now };
    avisados = avisarAprobadores(deps, email, tipo, datos);
  }
  // El token de la solicitud solo sirve para preguntar por ELLA y canjearla: no es una sesión.
  const solicitudToken = issueSession({ solicitud: sol.id, email }, {
    now: deps.now, ttlSeconds: Math.max(1, sol.solicitadoEn + SOLICITUD_TTL - deps.now), secret: deps.sessionSecret, crypto: deps.crypto,
  });
  return avisados === undefined
    ? { ok: true, solicitudToken, expiraEn: sol.solicitadoEn + SOLICITUD_TTL }
    : { ok: true, solicitudToken, expiraEn: sol.solicitadoEn + SOLICITUD_TTL, avisados };
}

/**
 * A quién se avisa de una solicitud (V-57): a quien hoy puede APROBARLA, residente a residente con
 * el mismo `requireValidarPermiso` que la deja aprobar, para que «a quién avisar» y «quién puede
 * decidir» no se separen nunca. Dentro de la ventana de V-52 eso da los administradores que tienen
 * fila de residente (sin ella no pueden ni entrar); pasada `FECHA_LIMITE_ACCESO_DESARROLLADOR`, el
 * Responsable en mandato o, sin mandato, los Mayores (V-16). Antes de V-57, pasada la fecha no se
 * avisaba a nadie y la pantalla del solicitante seguía diciendo que sí: con 5 minutos para
 * aprobar, un R1 nuevo solo entraba si el Responsable tenía Inicio abierto por casualidad.
 *
 * Un residente que no se puede evaluar (fechas ilegibles: `groupOnDate` lanza) ni puede aprobar
 * ni puede dejar sin aviso a los demás, así que se salta. Los emails van normalizados y con forma
 * de email: `sendMail` manda UN correo a todos, y una dirección imposible lo tumbaría entero.
 */
function destinatariosAviso(deps) {
  const emails = [];
  for (const r of allResidentes(deps)) {
    const email = emailNormalizado(r.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    try {
      if (!requireValidarPermiso(deps, { sub: r.id }, "gestionar las solicitudes de acceso")) emails.push(email);
    } catch (e) { /* fechas ilegibles: no puede aprobar */ }
  }
  return [...new Set(emails)];
}

/**
 * El correo es solo el AVISO: la aprobación se hace dentro de la app, donde quien aprueba ya
 * está autenticado. Un enlace de aprobación en un correo se puede reenviar o abrir sin querer, y
 * obligaría a una entrada GET que hoy el Web App no tiene. Si el envío falla, la solicitud sigue
 * visible en Inicio de quien puede aprobarla: un correo caído no puede dejar a nadie sin poder
 * aprobar. Devuelve a cuántas personas se avisó (0 si no se pudo), y con eso la pantalla del
 * solicitante solo dice que ha llegado un correo cuando de verdad se ha enviado (V-57).
 */
function avisarAprobadores(deps, email, tipo, datos) {
  if (typeof deps.sendMail !== "function") return 0;
  const que = tipo === "ALTA"
    ? `${email} ha pedido darse de alta como residente (${datos.nombre}, del ${datos.fechaInicio} al ${datos.fechaFin}).`
    : `${email} ha pedido entrar como invitado (solo lectura).`;
  // Todo dentro del try: calcular a quién avisar tampoco puede tumbar una solicitud ya escrita.
  try {
    const para = destinatariosAviso(deps);
    if (para.length === 0) return 0;
    deps.sendMail(
      para,
      tipo === "ALTA" ? "Guardias · solicitud de alta de residente" : "Guardias · solicitud de acceso como invitado",
      `${que}\n\n` +
      "Para aprobarla o rechazarla, entra en la app → Inicio → «Solicitudes de acceso».\n" +
      "La solicitud caduca a los 5 minutos; si no la apruebas, tendrá que volver a pedirla.",
    );
    return para.length;
  } catch (e) {
    return 0; // el aviso es una comodidad: la solicitud ya está en la tabla y en Inicio
  }
}

function handleResolverSolicitud(req, deps, session) {
  if (typeof req.id !== "string" || !req.id) return { ok: false, error: "id obligatorio" };
  if (typeof req.aprobar !== "boolean") return { ok: false, error: "aprobar debe ser true o false" };
  return atomico(deps, () => {
    const sol = allSolicitudes(deps).find((r) => r.id === req.id);
    if (!sol) return { ok: false, error: "la solicitud no existe" };
    if (sol.estado !== "PENDIENTE") return { ok: false, error: `la solicitud ya está ${sol.estado.toLowerCase()}` };
    if (deps.now - sol.solicitadoEn > SOLICITUD_TTL) return { ok: false, error: "la solicitud ha caducado (pasaron más de 5 minutos)" };
    // Aprobar un ALTA es lo que crea al residente (nunca antes), bajo el mismo lock que la decisión:
    // dos aprobaciones o un alta paralela del mismo email no pueden dejar dos residentes.
    if (req.aprobar && sol.tipo === "ALTA") {
      if (allResidentes(deps).some((r) => emailNormalizado(r.email) === sol.email)) return { ok: false, error: "ese email ya está vinculado a un residente" };
      deps.store.appendRecord("residentes", { nombre: sol.nombre, email: sol.email, fechaInicio: sol.fechaInicio, fechaFin: sol.fechaFin });
    }
    deps.store.appendRecord("solicitudesInvitado", { ...sol, estado: req.aprobar ? "APROBADA" : "RECHAZADA", decididoPor: session.sub, decididoEn: deps.now });
    return { ok: true, id: sol.id, estado: req.aprobar ? "APROBADA" : "RECHAZADA" };
  });
}

/**
 * El invitado pregunta por su solicitud. Si está APROBADA y dentro de los 5 minutos, se canjea por
 * una sesión de invitado (UNA vez: la fila pasa a USADA). No escribe ningún residente.
 */
function handleEstadoSolicitudInvitado(req, deps) {
  const t = verifySession(req.solicitudToken, { now: deps.now, secret: deps.sessionSecret, crypto: deps.crypto });
  if (!t.valid || typeof t.payload.solicitud !== "string") return { ok: true, estado: "CADUCADA" };
  return atomico(deps, () => {
    const sol = allSolicitudes(deps).find((r) => r.id === t.payload.solicitud);
    if (!sol) return { ok: true, estado: "CADUCADA" };
    if (sol.estado === "RECHAZADA" || sol.estado === "USADA") return { ok: true, estado: sol.estado === "USADA" ? "CADUCADA" : "RECHAZADA" };
    if (deps.now - sol.solicitadoEn > SOLICITUD_TTL) return { ok: true, estado: "CADUCADA" };
    if (sol.estado === "PENDIENTE") return { ok: true, estado: "PENDIENTE", expiraEn: sol.solicitadoEn + SOLICITUD_TTL };
    deps.store.appendRecord("solicitudesInvitado", { ...sol, estado: "USADA" });
    if (sol.tipo === "ALTA") {
      // El residente lo creó la aprobación: se entra como él, con la misma sesión que un login.
      const residente = allResidentes(deps).find((r) => emailNormalizado(r.email) === sol.email);
      if (!residente) return { ok: false, error: "el residente aprobado no existe" };
      return { ...sessionFor(residente, deps), estado: "APROBADA", residentes: allResidentes(deps) };
    }
    const session = issueSession({ sub: ROL_INVITADO, rol: ROL_INVITADO }, {
      now: deps.now, ttlSeconds: Math.min(deps.sessionTtl, INVITADO_TTL), secret: deps.sessionSecret, crypto: deps.crypto,
    });
    return {
      ok: true, estado: "APROBADA", session,
      residente: { id: ROL_INVITADO, nombre: "Invitado", rol: ROL_INVITADO },
      residentes: paraSesion(allResidentes(deps), { rol: ROL_INVITADO }, deps),
    };
  });
}

/**
 * Rol derivado: 'responsable' si hoy cae dentro de un mandato de la tabla responsables.
 * `readLatest` por periodoInicio (no `readRecords` crudo): si un mandato se reemplaza por
 * una corrección posterior (misma clave), la fila vieja no debe seguir concediendo el rol.
 */
function resolveRol(store, residenteId, today) {
  // Una sola definición de "el mandato que cubre hoy": la comparten el rol del token y el
  // permiso del ciclo (requireCicloPermiso), que si no podrían discrepar.
  const mandato = mandatoVigente({ store, today });
  return mandato && mandato.residenteId === residenteId ? "responsable" : "residente";
}

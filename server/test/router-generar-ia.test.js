// Tests de la acción `generarCuadranteIA` (decisión V-45): permiso del ciclo, estado del mes,
// validación de la propuesta ANTES de escribir, ciclo de reintentos y bitácora.
//
// Lo que estos tests defienden, por orden de gravedad si se rompiera:
//  1. Que un mes con violaciones `error` NO se escriba nunca (el encargo lo dice y es lo único
//     irreversible: `asignaciones` es append-only y no se borra).
//  2. Que el permiso lo decida el SERVIDOR. Esconder el botón en Inicio no es un permiso.
//  3. Que escriba por el mismo camino que «Aplicar», reemplazando el mes en vez de añadir encima
//     (el bug que `apply.js` existe para cerrar, ahora también por esta vía).
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { absences } from "../../v2/domain/absences.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { validateMonth, rotationHistoryStart, buildMonthContext } from "../../v2/domain/validate.js";
import { validateThirdPost, thirdPostHistoryStart } from "../../v2/domain/thirdpost.js";
import { groupOnDate, levelOn, periodsOfResident } from "../../v2/domain/residents.js";
import { parseISO, addDays, bridgesOfMonth, academicYearOf } from "../../v2/domain/calendar.js";
import { accumulatedTally } from "../../v2/domain/accumulate.js";
import { monthReplacementPlan, monthCompletionPlan } from "../../v2/domain/apply.js";
import { canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";

const CLIENT_ID = "cid.apps.googleusercontent.com";
const crypto = {
  hmac: (m, s) => nodeCrypto.createHmac("sha256", s).update(m, "utf8").digest("base64url"),
  b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
  b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
};
function fakeSS(rows = {}) {
  const sheets = new Map(Object.entries(rows).map(([k, v]) => [k, v.map((r) => r.slice())]));
  return {
    listSheets: () => [...sheets.keys()], exists: (n) => sheets.has(n),
    read: (n) => (sheets.get(n) || []).map((r) => r.slice()),
    overwrite: (n, r) => sheets.set(n, r.map((x) => x.slice())),
    append: (n, r) => { if (!sheets.has(n)) sheets.set(n, []); sheets.get(n).push(...r.map((x) => x.slice())); },
    createSheet: (n) => sheets.set(n, []), deleteSheet: (n) => sheets.delete(n),
    renameSheet: (a, b) => { sheets.set(b, sheets.get(a)); sheets.delete(a); },
  };
}

const RESP = { id: "resp-1", nombre: "Rita Mayor", email: "resp@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };
const OTRO = { id: "otro-1", nombre: "Olga Pequeña", email: "otro@gmail.com", fechaInicio: "2026-05-27", fechaFin: "2030-05-26" };
// Mismas fechas que OTRO (Pequeño a `deps.today`, 2027-06-16): el acceso de desarrollador (V-46)
// tiene que funcionar PESE a no ser Mayor, no por serlo.
const DEV = { id: "dev-1", nombre: "Agustín Dev", email: "agustinlagioiosa@gmail.com", fechaInicio: "2026-05-27", fechaFin: "2030-05-26" };
const conDev = { residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO, DEV].map((r) => recordToRow(TABLES.residentes, r))] };

const PROPUESTA = [
  { fecha: "2027-07-01", residenteId: "resp-1", codigo: "G" },
  { fecha: "2027-07-02", residenteId: "otro-1", codigo: "G" },
];
const RESPUESTA_OK = JSON.stringify({ asignaciones: PROPUESTA });

/** `llm` falso: devuelve las respuestas dadas en orden y guarda cada prompt recibido. */
function fakeLlm(respuestas, modelo = "gemma-4-31b-it") {
  const prompts = [];
  return {
    modelo,
    prompts,
    generar: (prompt) => {
      prompts.push(prompt);
      const r = respuestas[Math.min(prompts.length - 1, respuestas.length - 1)];
      return typeof r === "function" ? r() : r;
    },
  };
}
const ok = (texto) => ({ ok: true, texto });

function makeDeps({ llm, violaciones = () => [], extraSheets = {} } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "resp-1", metodo: "VOLUNTARIO" })],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P)],
    generaciones: [headerOf(TABLES.generaciones)],
    preferencias: [headerOf(TABLES.preferencias)],
    ...extraSheets,
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-06-16", // dentro del mandato de RESP
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    ss,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${nodeCrypto.randomUUID()}` }),
    llm,
    domain: {
      absences,
      // `validateMonth` va envuelto: montar a mano un mes que pase INV-1 día a día es un problema
      // combinatorio ajeno a lo que aquí se prueba (el validador ya tiene sus 63 tests propios).
      // Lo que sí se prueba de verdad es que el router LO LLAME y respete su veredicto.
      validateMonth: (ctx) => violaciones(ctx),
      validateThirdPost: () => [],
      buildMonthContext, rotationHistoryStart, thirdPostHistoryStart, parseISO, addDays,
      bridgesOfMonth, academicYearOf, accumulatedTally, monthReplacementPlan, monthCompletionPlan,
      levelOn, periodsOfResident, groupOnDate,
      canEdit, stateAfterEdit,
    },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "resp@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] }),
  };
}

const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}
const generar = (deps, session, extra = {}) => call({ action: "generarCuadranteIA", session, mes: 7, anio: 2027, ...extra }, deps);
const asignacionesDe = (deps) => call({ action: "listAsignaciones", session: loggedInAs(deps, "resp@gmail.com"), mes: 7, anio: 2027 }, deps).asignaciones;
const bitacora = (deps) => deps.store.readRecords("generaciones");

const ERROR_INV1 = [{ invariante: "INV-1", severidad: "error", detalle: "2027-07-04 sin ninguna asignación" }];
const AVISO_INV3 = [{ invariante: "INV-3", severidad: "aviso", detalle: "resp-1=6 vs otro-1=3 en total" }];

// ── permiso (requisito R2/R3 del encargo) ─────────────────────────────────────────────────────

test("rechaza a quien no tiene el permiso del ciclo, y no llama al modelo siquiera", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "otro@gmail.com"); // no es el Responsable del mandato vigente

  const r = generar(deps, session);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo el Responsable/);
  assert.equal(llm.prompts.length, 0, "ni un token de cuota gastado en alguien sin permiso");
  assert.equal(asignacionesDe(deps).length, 0);
});

test("sin mandato vigente lo puede lanzar cualquier Mayor (V-16), no se bloquea el ciclo", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  // Sin fila en `responsables`: es el año en que nadie se ofreció y el sorteo no se ha lanzado.
  const deps = makeDeps({ llm, extraSheets: { responsables: [headerOf(TABLES.responsables)] } });

  assert.equal(generar(deps, loggedInAs(deps, "resp@gmail.com")).ok, true, "un Mayor sí puede");
  assert.match(generar(deps, loggedInAs(deps, "otro@gmail.com")).error, /solo un R3 o R4/, "un Pequeño no");
});

test("V-46: el acceso de desarrollador (email exacto) genera en Borrador aunque sea Pequeño", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, extraSheets: conDev });

  const r = generar(deps, loggedInAs(deps, DEV.email));
  assert.equal(r.ok, true, "el acceso de desarrollador destraba el permiso del ciclo solo para esta acción");
});

test("V-46: el acceso de desarrollador NO destraba el resto del ciclo (marcarValidado sigue pidiendo Mayor/Responsable)", () => {
  const deps = makeDeps({ extraSheets: conDev });
  const session = loggedInAs(deps, DEV.email);

  const r = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /solo el Responsable|solo un R3 o R4/);
});

test("V-46: el acceso de desarrollador sigue exigiendo Borrador (un VALIDADO se rechaza igual que a cualquiera)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, extraSheets: conDev });
  const session = loggedInAs(deps, DEV.email);
  deps.store.appendRecord("cuadrantes", { mes: 7, anio: 2027, estado: "VALIDADO", actorId: "resp-1", fecha: "2027-06-01" });

  const r = generar(deps, session);
  assert.equal(r.ok, false);
  assert.match(r.error, /VALIDADO/);
});

test("una sesión inválida no llega ni a mirar el permiso", () => {
  const deps = makeDeps({ llm: fakeLlm([ok(RESPUESTA_OK)]) });
  const r = generar(deps, "token-falso");
  assert.equal(r.ok, false);
  assert.match(r.error, /sesión/);
});

// ── estado y configuración ────────────────────────────────────────────────────────────────────

test("un mes PUBLICADO no se regenera: se dice que hay que despublicarlo", () => {
  const deps = makeDeps({ llm: fakeLlm([ok(RESPUESTA_OK)]) });
  const session = loggedInAs(deps, "resp@gmail.com");
  deps.store.appendRecord("cuadrantes", { mes: 7, anio: 2027, estado: "PUBLICADO", actorId: "resp-1", fecha: "2027-06-01" });

  const r = generar(deps, session);
  assert.equal(r.ok, false);
  assert.match(r.error, /PUBLICADO/);
  assert.equal(asignacionesDe(deps).length, 0);
});

test("sin adaptador de IA configurado se dice QUÉ falta, no un error genérico", () => {
  const deps = makeDeps({ llm: undefined });
  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, false);
  assert.match(r.error, /GEMINI_API_KEY/);
});

test("mes o año inválidos se rechazan antes de gastar una llamada", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(generar(deps, session, { mes: 13 }).ok, false);
  assert.equal(generar(deps, session, { anio: "dosmil" }).ok, false);
  assert.equal(llm.prompts.length, 0);
});

// ── el camino feliz ───────────────────────────────────────────────────────────────────────────

test("propuesta válida: se guarda el mes, se registra en la bitácora y se dice el modelo usado", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");

  const r = generar(deps, session);
  assert.equal(r.ok, true);
  assert.equal(r.intentos, 1);
  assert.equal(r.modelo, "gemma-4-31b-it");
  assert.equal(r.guardados, 2);

  const guardadas = asignacionesDe(deps);
  assert.equal(guardadas.length, 2);
  assert.deepEqual(guardadas.map((a) => `${a.fecha}|${a.residenteId}|${a.codigo}`).sort(),
    ["2027-07-01|resp-1|G", "2027-07-02|otro-1|G"]);

  const log = bitacora(deps);
  assert.equal(log.length, 1);
  assert.equal(log[0].resultado, "APLICADO");
  assert.equal(log[0].mes, 7);
  assert.equal(log[0].anio, 2027);
  assert.equal(log[0].actorId, "resp-1");
  assert.equal(log[0].modelo, "gemma-4-31b-it");
});

test("el prompt lleva los datos REALES del mes: ids, bloqueos, festivos y preferencias", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({
    llm,
    extraSheets: {
      bloqueos: [headerOf(TABLES.bloqueos), recordToRow(TABLES.bloqueos, { id: "b1", residenteId: "otro-1", desde: "2027-07-10", hasta: "2027-07-20", motivo: "BAJA", activo: true })],
      festivos: [headerOf(TABLES.festivos), recordToRow(TABLES.festivos, { id: "f1", fecha: "2027-07-25", nombre: "Santiago", ambito: "NACIONAL", activo: true })],
      preferencias: [headerOf(TABLES.preferencias), recordToRow(TABLES.preferencias, { id: "p1", residenteId: "resp-1", anio: 2027, mes: 7, maxGuardias: 5, fechasEvitar: ["2027-07-08"], notas: "" })],
    },
  });
  generar(deps, loggedInAs(deps, "resp@gmail.com"));

  const p = llm.prompts[0];
  assert.match(p, /id="resp-1"/);
  assert.match(p, /id="otro-1"/);
  assert.match(p, /OBLIGATORIO no asignarle guardia/); // la BAJA de INV-5
  assert.match(p, /2027-07-25 — Santiago/);            // festivos como dato, jamás alucinados (S-4)
  assert.match(p, /preferiría evitar 2027-07-08/);      // R5: las preferencias se leen
  assert.match(p, /mes=7, año=2027/);
});

test("los AVISOS no impiden guardar y vuelven al cliente (V-14: la equidad nunca bloquea)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, violaciones: () => AVISO_INV3 });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, true);
  assert.equal(r.intentos, 1);
  assert.deepEqual(r.violaciones, AVISO_INV3);
  assert.equal(asignacionesDe(deps).length, 2);
  assert.equal(bitacora(deps)[0].resultado, "APLICADO");
});

test("en modo REEMPLAZAR, generar sobre un mes que ya tenía guardias lo sustituye, no añade encima", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  // Una guardia previa de otro día que la propuesta no pisa por clave: tiene que desaparecer, o
  // el mes acabaría con más gente de la que el validador juzgó (el bug que cierra `apply.js`).
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(asignacionesDe(deps).length, 1);

  const r = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r.ok, true);
  assert.equal(r.modo, "reemplazar");
  assert.equal(r.borradas, 1);
  const fechas = asignacionesDe(deps).map((a) => a.fecha).sort();
  assert.deepEqual(fechas, ["2027-07-01", "2027-07-02"], "la guardia previa del día 15 ya no está");
});

// ── modo COMPLETAR (decisión V-47): las guardias que ya había son inamovibles ─────────────────

test("V-47: por defecto se COMPLETA — la guardia que un residente puso de antemano sobrevive y no hay borrados", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "G", origen: "CEDIDA" }] }, deps);

  const r = generar(deps, session); // sin `modo`: el defecto
  assert.equal(r.ok, true);
  assert.equal(r.modo, "completar");
  assert.equal(r.borradas, 0);
  assert.equal(r.respetadas, 1);
  assert.equal(r.guardados, 2);
  const guardadas = asignacionesDe(deps);
  assert.deepEqual(guardadas.map((a) => a.fecha).sort(), ["2027-07-01", "2027-07-02", "2027-07-15"]);
  assert.equal(guardadas.find((a) => a.fecha === "2027-07-15").origen, "CEDIDA", "la fijada no se reescribe: conserva su origen");
  assert.equal(bitacora(deps)[0].modo, "COMPLETAR");
});

test("V-47: el prompt lista las guardias ya fijadas y el validador juzga el mes RESULTANTE (fijadas + propuesta)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  let visto = null;
  const deps = makeDeps({ llm, violaciones: (ctx) => { visto = ctx; return []; } });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "G" }] }, deps);

  generar(deps, session);
  assert.match(llm.prompts[0], /GUARDIAS YA FIJADAS EN LA REJILLA \(OBLIGATORIO/);
  assert.match(llm.prompts[0], /2027-07-15 — id="resp-1" — G/);
  const fechas = (visto.asignaciones || []).map((a) => a.fecha).sort();
  assert.deepEqual(fechas, ["2027-07-01", "2027-07-02", "2027-07-15"], "la fijada entra en lo que se valida");
});

test("V-47: si el modelo cambia el código de una fijada se le rechaza y se le explica en el reintento; la fijada queda intacta", () => {
  const pisada = JSON.stringify({ asignaciones: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "GF" }, ...PROPUESTA] });
  const llm = fakeLlm([ok(pisada), ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "G" }] }, deps);

  const r = generar(deps, session);
  assert.equal(r.ok, true, "el segundo intento corrige");
  assert.equal(r.intentos, 2);
  assert.match(llm.prompts[1], /la guardia ya fijada de "resp-1" el 2027-07-15 es G y tu respuesta la cambia a GF/);
  assert.equal(asignacionesDe(deps).find((a) => a.fecha === "2027-07-15").codigo, "G");
});

test("V-47: un mes ya completo que el modelo devuelve tal cual no escribe nada ni cambia de estado", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: PROPUESTA }, deps);
  const filasAntes = deps.store.readRecords("asignaciones").length;

  const r = generar(deps, session);
  assert.equal(r.ok, true);
  assert.equal(r.guardados, 0);
  assert.equal(r.respetadas, 2);
  assert.equal(deps.store.readRecords("asignaciones").length, filasAntes, "ni una fila nueva");
  assert.equal(bitacora(deps)[0].resultado, "APLICADO");
});

test("V-47: las marcas V/R/B tampoco se tocan en modo completar", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-20", residenteId: "otro-1", codigo: "V" }] }, deps);
  generar(deps, session);
  assert.equal(asignacionesDe(deps).filter((a) => a.codigo === "V").length, 1);
});

test("V-47: un modo que no existe se rechaza sin gastar un intento (no puede degradar en silencio a reemplazar)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"), { modo: "sobrescribir" });
  assert.equal(r.ok, false);
  assert.match(r.error, /modo de generación inválido/);
  assert.equal(llm.prompts.length, 0);
});

test("las marcas V/R/B del mes sobreviven: el generador solo borra lo que propone", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "otro-1", codigo: "V" }] }, deps);

  generar(deps, session);
  const marcas = asignacionesDe(deps).filter((a) => a.codigo === "V");
  assert.equal(marcas.length, 1, "una V no es una propuesta del generador: no le pertenece y no la borra");
});

test("un mes VALIDADO ya no se regenera (V-46): no se descarta en silencio lo que el equipo ya revisó", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  deps.store.appendRecord("cuadrantes", { mes: 7, anio: 2027, estado: "VALIDADO", actorId: "resp-1", fecha: "2027-06-01" });

  const r = generar(deps, session);
  assert.equal(r.ok, false);
  assert.match(r.error, /VALIDADO/);
  assert.match(r.error, /Borrador/);
  assert.equal(llm.prompts.length, 0, "ni un token de cuota gastado sobre un mes que no se va a regenerar");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO", "el mes no cambia de estado si no se generó nada");
});

// ── reintentos y fracaso (requisitos R9/R10) ──────────────────────────────────────────────────

test("con errores en la propuesta reintenta, y el reintento lleva las violaciones concretas", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK), ok(RESPUESTA_OK)]);
  let vez = 0;
  const deps = makeDeps({ llm, violaciones: () => (++vez === 1 ? ERROR_INV1 : []) });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, true);
  assert.equal(r.intentos, 2);
  assert.match(llm.prompts[1], /2027-07-04 sin ninguna asignación/);
  assert.match(llm.prompts[1], /OBLIGATORIO CORREGIR/);
});

test("tras 3 intentos fallidos NO se escribe NADA y queda marcado para revisión manual", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, violaciones: () => ERROR_INV1 });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, false);
  assert.equal(r.revisionManual, true);
  assert.equal(r.intentos, 3);
  assert.equal(llm.prompts.length, 3, "exactamente 3 intentos, ni uno más");
  assert.deepEqual(r.violaciones, ERROR_INV1);

  // Lo importante de todo el encargo: ni una fila del cuadrante inválido.
  assert.equal(asignacionesDe(deps).length, 0);
  const log = bitacora(deps);
  assert.equal(log.length, 1);
  assert.equal(log[0].resultado, "REVISION_MANUAL");
  assert.equal(log[0].intentos, 3);
  assert.equal(log[0].violaciones[0].invariante, "INV-1");
});

test("un fallo del modelo se registra como ERROR_MODELO con el motivo real de Google", () => {
  const llm = fakeLlm([{ ok: false, error: "HTTP 429: quota exceeded" }]);
  const deps = makeDeps({ llm });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, false);
  assert.equal(r.revisionManual, false);
  assert.match(r.error, /429/);
  assert.equal(bitacora(deps)[0].resultado, "ERROR_MODELO");
  assert.equal(asignacionesDe(deps).length, 0);
});

// ── guardarraíl de V-31 sobre lo que devuelve el modelo ───────────────────────────────────────

test("una fecha de OTRO mes se rechaza y se le explica al modelo, no se escribe", () => {
  const fuera = JSON.stringify({ asignaciones: [{ fecha: "2027-08-03", residenteId: "resp-1", codigo: "G" }] });
  const llm = fakeLlm([ok(fuera), ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, true, "el segundo intento corrige");
  assert.match(llm.prompts[1], /2027-08-03 no es un día de 7\/2027/);
  assert.deepEqual(asignacionesDe(deps).map((a) => a.fecha).sort(), ["2027-07-01", "2027-07-02"]);
});

test("un residenteId inventado se rechaza aunque INV-1 solo lo avise (V-21)", () => {
  const fantasma = JSON.stringify({ asignaciones: [{ fecha: "2027-07-01", residenteId: "no-existe", codigo: "G" }] });
  const llm = fakeLlm([ok(fantasma)]);
  const deps = makeDeps({ llm });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, false, "una fila que nadie puede ver ni corregir no se escribe nunca");
  assert.equal(asignacionesDe(deps).length, 0);
  assert.match(llm.prompts[1], /"no-existe" no está en la lista de residentes activos/);
});

test("una ausencia con fecha ilegible para la generación ANTES de gastar un intento (V-22)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({
    llm,
    extraSheets: {
      bloqueos: [headerOf(TABLES.bloqueos), recordToRow(TABLES.bloqueos, { id: "b1", residenteId: "otro-1", desde: "el lunes", hasta: "2027-07-20", motivo: "BAJA", activo: true })],
    },
  });

  const r = generar(deps, loggedInAs(deps, "resp@gmail.com"));
  assert.equal(r.ok, false);
  assert.match(r.error, /ilegible/);
  assert.equal(llm.prompts.length, 0, "reintentar 3 veces algo que solo se arregla a mano es gastar cuota en balde");
  assert.equal(asignacionesDe(deps).length, 0);
});

test("el validador juzga la PROPUESTA, no lo que hay guardado en el Sheet", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  let visto = null;
  const deps = makeDeps({ llm, violaciones: (ctx) => { visto = ctx; return []; } });
  generar(deps, loggedInAs(deps, "resp@gmail.com"));

  // El mes está vacío en el Sheet; si el ctx llegara con lo guardado, el validador estaría
  // aprobando un mes en blanco y declarando buena una propuesta que nadie ha mirado.
  assert.ok(visto, "validateMonth tiene que haberse llamado");
  const fechas = [...new Set((visto.asignaciones || []).map((a) => a.fecha))];
  assert.ok(fechas.includes("2027-07-01") && fechas.includes("2027-07-02"), "el ctx debe llevar la propuesta");
});

// ── segunda tanda de la revisión adversarial (2026-09-04): lo que el validador no veía ──

const fila = (fecha, residenteId, codigo, id = `a-${fecha}-${residenteId}`) => recordToRow(TABLES.asignaciones, { id, fecha, residenteId, codigo });

test("la misma persona y día dos veces (G y 3P) es FORMATO: el validador juzgaba una lista y el Sheet guardaba otra (última fila gana)", () => {
  const llm = fakeLlm([ok(JSON.stringify({ asignaciones: [...PROPUESTA, { fecha: "2027-07-01", residenteId: "resp-1", codigo: "3P" }] }))]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  for (const modo of ["completar", "reemplazar"]) {
    const r = generar(deps, session, { modo });
    assert.equal(r.ok, false, modo);
    assert.equal(r.resultado, "REVISION_MANUAL");
    assert.ok(r.violaciones.some((v) => v.invariante === "FORMATO" && /aparece 2 veces \(G, 3P\)/.test(v.detalle)), JSON.stringify(r.violaciones));
  }
  assert.equal(asignacionesDe(deps).length, 0, "no se escribe nada");
});

test("una propuesta sobre una celda V/R/B de la rejilla es FORMATO (la tarjeta promete conservarlas), y el prompt las lista para que no las proponga", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, extraSheets: { asignaciones: [headerOf(TABLES.asignaciones), fila("2027-07-02", "otro-1", "V")] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "FORMATO" && /marcada V/.test(v.detalle)), JSON.stringify(r.violaciones));
  assert.match(llm.prompts[0], /CELDAS YA MARCADAS EN LA REJILLA/);
  assert.match(llm.prompts[0], /2027-07-02 — id="otro-1" — V/);
  assert.deepEqual(asignacionesDe(deps).map((a) => a.codigo), ["V"], "la V sigue ahí y nada más se escribió");
});

test("un residente FINALIZADO que el prompt no lista es «desconocido» para el plan: FORMATO, no una guardia escrita con un aviso", () => {
  const FIN = { id: "fin-1", nombre: "Fin Acabado", email: "fin@gmail.com", fechaInicio: "2020-05-25", fechaFin: "2024-05-26" };
  const llm = fakeLlm([ok(JSON.stringify({ asignaciones: [...PROPUESTA, { fecha: "2027-07-03", residenteId: "fin-1", codigo: "G" }] }))]);
  const deps = makeDeps({ llm, extraSheets: { residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO, FIN].map((r) => recordToRow(TABLES.residentes, r))] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "FORMATO" && v.residenteId === "fin-1"), JSON.stringify(r.violaciones));
  assert.doesNotMatch(llm.prompts[0], /id="fin-1"/, "el prompt nunca lo listó");
  assert.equal(asignacionesDe(deps).length, 0);
});

test("el prompt lleva las guardias de los BORDES del mes (norma 13), que no son fijadas ni se escriben", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, extraSheets: { asignaciones: [headerOf(TABLES.asignaciones), fila("2027-06-30", "resp-1", "G"), fila("2027-08-01", "otro-1", "GF"), fila("2027-06-29", "otro-1", "G")] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session);
  assert.equal(r.ok, true);
  const p = llm.prompts[0];
  assert.match(p, /GUARDIAS EN LOS BORDES DEL MES \(NO son de este mes/);
  assert.match(p, /2027-06-30 — id="resp-1" — G/);
  assert.match(p, /2027-08-01 — id="otro-1" — GF/);
  assert.doesNotMatch(p, /2027-06-29/, "solo el día pegado, no todo el histórico");
  assert.match(p, /GUARDIAS YA FIJADAS EN LA REJILLA: ninguna/, "las de fuera del mes no son fijadas");
});

test("completar con fijadas que YA incumplen una regla dura: FIJADAS_INVALIDAS sin gastar ningún intento ni llamar al modelo", () => {
  const INV15 = [{ invariante: "INV-15", severidad: "error", detalle: "Guardias en días consecutivos: 2027-07-10 y 2027-07-11", residenteId: "resp-1" }];
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm, violaciones: () => INV15, extraSheets: { asignaciones: [headerOf(TABLES.asignaciones), fila("2027-07-10", "resp-1", "G"), fila("2027-07-11", "resp-1", "G")] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session, { modo: "completar" });
  assert.equal(r.ok, false);
  assert.equal(r.resultado, "FIJADAS_INVALIDAS");
  assert.equal(r.intentos, 0);
  assert.equal(llm.prompts.length, 0, "ni una llamada al modelo");
  assert.match(r.error, /ya están en la rejilla/);
  assert.deepEqual(r.violaciones, INV15);
  assert.equal(bitacora(deps).at(-1).resultado, "FIJADAS_INVALIDAS");
  assert.equal(asignacionesDe(deps).length, 2, "nada nuevo escrito");
  // En reemplazar no hay fijadas que respetar: se intenta con el modelo como siempre.
  const r2 = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r2.resultado, "REVISION_MANUAL");
  assert.equal(llm.prompts.length, 3);
});

test("una BAJA registrada mientras el modelo pensaba: la propuesta se vuelve a juzgar bajo el lock y, si ya no pasa, CONFLICTO sin escribir", () => {
  let juicios = 0;
  const INV5 = [{ invariante: "INV-5", severidad: "error", detalle: "Asignación G el 2027-07-02 sobre bloqueo BAJA", residenteId: "otro-1" }];
  let deps;
  let sessionOtro;
  // El `llm` falso registra la baja de Olga DURANTE la generación (como haría ella desde Preferencias
  // mientras el Responsable espera al modelo) y luego devuelve un mes que le pone guardia ese día.
  const llm = fakeLlm([() => {
    assert.equal(call({ action: "crearBloqueo", session: sessionOtro, motivo: "BAJA", desde: "2027-07-02", hasta: "2027-07-02" }, deps).ok, true);
    return ok(RESPUESTA_OK);
  }]);
  // Primer juicio (en el ciclo del generador): limpio. Segundo (bajo el lock, con el snapshot fresco): INV-5.
  deps = makeDeps({ llm, violaciones: () => (++juicios >= 2 ? INV5 : []) });
  const session = loggedInAs(deps, "resp@gmail.com");
  sessionOtro = loggedInAs(deps, "otro@gmail.com");
  const r = generar(deps, session);
  assert.equal(r.ok, false);
  assert.equal(r.resultado, "CONFLICTO");
  assert.match(r.error, /registró una ausencia/);
  assert.equal(juicios, 2, "se juzgó dos veces: al proponer y al escribir");
  assert.equal(asignacionesDe(deps).length, 0, "no se escribió ni una guardia sobre la baja");
  assert.equal(bitacora(deps).at(-1).resultado, "CONFLICTO");
});

test("la bitácora se acota a 50 violaciones (+1 de resumen) y su fallo nunca convierte un mes ya escrito en un error", () => {
  const muchas = Array.from({ length: 500 }, (_, i) => ({ invariante: "INV-1", severidad: "error", detalle: `día ${i}` }));
  const deps = makeDeps({ llm: fakeLlm([ok(RESPUESTA_OK)]), violaciones: () => muchas });
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(generar(deps, session).resultado, "REVISION_MANUAL");
  const fila = bitacora(deps).at(-1);
  assert.equal(fila.violaciones.length, 51);
  assert.match(fila.violaciones[50].detalle, /y 450 más \(recortado\)/);
  // Y en caracteres: 60 violaciones con detalles e ids de 1.000 caracteres tampoco pasan de la celda.
  const gordas = Array.from({ length: 60 }, (_, i) => ({ invariante: "FORMATO", severidad: "error", residenteId: "x".repeat(1000), detalle: `${i} ` + "y".repeat(1000) }));
  const deps3 = makeDeps({ llm: fakeLlm([ok(RESPUESTA_OK)]), violaciones: () => gordas });
  assert.equal(generar(deps3, loggedInAs(deps3, "resp@gmail.com")).resultado, "REVISION_MANUAL");
  const celda = JSON.stringify(bitacora(deps3).at(-1).violaciones);
  assert.ok(celda.length < 50000, `la celda mide ${celda.length}`);
  assert.match(celda, /más \(recortado\)/);

  const deps2 = makeDeps({ llm: fakeLlm([ok(RESPUESTA_OK)]) });
  const session2 = loggedInAs(deps2, "resp@gmail.com");
  const append = deps2.ss.append;
  deps2.ss.append = (n, rows) => { if (n === "generaciones") throw new Error("celda de más de 50000 caracteres"); return append(n, rows); };
  const r = generar(deps2, session2);
  assert.equal(r.ok, true, "el mes se escribió: la bitácora es memoria, no veredicto");
  assert.equal(asignacionesDe(deps2).length, 2);
});

test("reemplazar también juzga lo que SOBREVIVE: un 3P que la propuesta no borra (V-38) cuenta para INV-15 y va al prompt como fijado", () => {
  // El juez (stub) ve INV-15 solo si el contexto lleva el 3P del día 3 junto a la G del día 4.
  const violaciones = (ctx) => (JSON.stringify(ctx).includes('"2027-07-03"') && JSON.stringify(ctx).includes('"3P"')
    ? [{ invariante: "INV-15", severidad: "error", detalle: "Guardias en días consecutivos: 2027-07-03 y 2027-07-04", residenteId: "resp-1" }] : []);
  const propuesta = [...PROPUESTA, { fecha: "2027-07-04", residenteId: "resp-1", codigo: "G" }];
  const llm = fakeLlm([ok(JSON.stringify({ asignaciones: propuesta }))]);
  const deps = makeDeps({ llm, violaciones, extraSheets: { asignaciones: [headerOf(TABLES.asignaciones), fila("2027-07-03", "resp-1", "3P")] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r.ok, false, "antes se escribía un mes con INV-15 y la tarjeta decía «generado y guardado»");
  assert.equal(r.resultado, "REVISION_MANUAL");
  assert.ok(r.violaciones.some((v) => v.invariante === "INV-15"));
  assert.match(llm.prompts[0], /GUARDIAS YA FIJADAS EN LA REJILLA \(OBLIGATORIO/);
  assert.match(llm.prompts[0], /2027-07-03 — id="resp-1" — 3P/);
  assert.deepEqual(asignacionesDe(deps).map((a) => a.codigo), ["3P"], "nada escrito, el 3P sigue");
  // Y si la propuesta no choca con el 3P, se escribe y se cuenta como respetado.
  const llm2 = fakeLlm([ok(RESPUESTA_OK)]);
  const deps2 = makeDeps({ llm: llm2, violaciones, extraSheets: { asignaciones: [headerOf(TABLES.asignaciones), fila("2027-07-10", "resp-1", "3P")] } });
  const r2 = generar(deps2, loggedInAs(deps2, "resp@gmail.com"), { modo: "reemplazar" });
  assert.equal(r2.ok, true);
  assert.equal(r2.respetadas, 1);
  assert.equal(asignacionesDe(deps2).filter((a) => a.codigo === "3P").length, 1);
});

test("quien termina la residencia a mitad de mes: el prompt dice «solo hasta» y una guardia posterior es FORMATO, no un aviso escrito", () => {
  const CORTA = { ...OTRO, fechaFin: "2027-07-15" }; // R2 el día 1, FINALIZADO desde el 16
  const llm = fakeLlm([ok(JSON.stringify({ asignaciones: [...PROPUESTA, { fecha: "2027-07-20", residenteId: "otro-1", codigo: "G" }] }))]);
  const deps = makeDeps({ llm, extraSheets: { residentes: [headerOf(TABLES.residentes), ...[RESP, CORTA].map((r) => recordToRow(TABLES.residentes, r))] } });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, session, { modo: "reemplazar" });
  assert.equal(r.ok, false);
  assert.ok(r.violaciones.some((v) => v.invariante === "FORMATO" && /no está en activo el 2027-07-20/.test(v.detalle)), JSON.stringify(r.violaciones));
  assert.match(llm.prompts[0], /id="otro-1" — Olga Pequeña \(.*\) — solo hasta el 2027-07-15/);
  assert.equal(asignacionesDe(deps).length, 0);
});

test("si un residente deja de ser asignable mientras el modelo pensaba (periodos editados), el segundo juicio bajo el lock lo ve: CONFLICTO sin escribir", () => {
  let deps;
  let sessionResp;
  const llm = fakeLlm([() => {
    // Mientras «piensa», el Responsable corrige la fecha de fin de Olga a antes del mes.
    assert.equal(call({ action: "editarResidente", session: sessionResp, residenteId: "otro-1", fechaFin: "2027-06-30" }, deps).ok, true);
    return ok(RESPUESTA_OK); // …y el modelo devuelve un mes que le pone guardia el 2 de julio
  }]);
  deps = makeDeps({ llm });
  sessionResp = loggedInAs(deps, "resp@gmail.com");
  const r = generar(deps, sessionResp, { modo: "reemplazar" });
  assert.equal(r.ok, false);
  assert.equal(r.resultado, "CONFLICTO");
  assert.equal(asignacionesDe(deps).length, 0);
});

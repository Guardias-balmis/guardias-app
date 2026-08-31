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
import { monthReplacementPlan } from "../../v2/domain/apply.js";
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
      bridgesOfMonth, academicYearOf, accumulatedTally, monthReplacementPlan,
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

test("generar sobre un mes que ya tenía guardias lo REEMPLAZA, no añade encima", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  // Una guardia previa de otro día que la propuesta no pisa por clave: tiene que desaparecer, o
  // el mes acabaría con más gente de la que el validador juzgó (el bug que cierra `apply.js`).
  call({ action: "guardarAsignaciones", session, cambios: [{ fecha: "2027-07-15", residenteId: "resp-1", codigo: "G" }] }, deps);
  assert.equal(asignacionesDe(deps).length, 1);

  const r = generar(deps, session);
  assert.equal(r.ok, true);
  assert.equal(r.borradas, 1);
  const fechas = asignacionesDe(deps).map((a) => a.fecha).sort();
  assert.deepEqual(fechas, ["2027-07-01", "2027-07-02"], "la guardia previa del día 15 ya no está");
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

test("guardar deja el mes en BORRADOR aunque estuviera VALIDADO (editar revierte, V-10)", () => {
  const llm = fakeLlm([ok(RESPUESTA_OK)]);
  const deps = makeDeps({ llm });
  const session = loggedInAs(deps, "resp@gmail.com");
  deps.store.appendRecord("cuadrantes", { mes: 7, anio: 2027, estado: "VALIDADO", actorId: "resp-1", fecha: "2027-06-01" });

  const r = generar(deps, session);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "BORRADOR");
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "BORRADOR");
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
  assert.match(llm.prompts[1], /"no-existe" no es de ningún residente/);
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

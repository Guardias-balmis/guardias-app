// El contaje oficial en el Excel del servicio (decisión V-65): volcado tras publicar y acción
// `volcarContaje`. El Excel es un puerto inyectado (`deps.contaje`); aquí lo sustituye el doble en
// memoria de `server/contaje-memoria.mjs`, que parte de un Excel de mentira con la estructura del
// real y nombres inventados.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { makeContajeMemoria, excelOriginalDePrueba } from "../contaje-memoria.mjs";
import * as Calendar from "../../v2/domain/calendar.js";
import * as Apply from "../../v2/domain/apply.js";
import * as Residents from "../../v2/domain/residents.js";
import * as Tally from "../../v2/domain/tally.js";
import * as Absences from "../../v2/domain/absences.js";
import * as BlockPreview from "../../v2/domain/blockPreview.js";
import * as Imaginaria from "../../v2/domain/imaginaria.js";
import * as Accumulate from "../../v2/domain/accumulate.js";
import * as Thirdpost from "../../v2/domain/thirdpost.js";
import * as Equity from "../../v2/domain/equity.js";
import * as Validate from "../../v2/domain/validate.js";
import * as Responsible from "../../v2/domain/responsible.js";
import * as CuadranteEstados from "../../v2/domain/cuadrante.js";
import * as Projection from "../../v2/domain/projection.js";
import * as ContajeExcel from "../../v2/domain/contajeExcel.js";
import * as Holidays from "../../v2/domain/holidays.js";

// El dominio ENTERO, como `deps.domain = Domain` en Code.gs, salvo `validateMonth`: montar un mes
// que pase INV-1 (cada día cubierto) no es lo que se prueba aquí — el validador tiene sus tests.
const DOMAIN = { ...Calendar, ...Apply, ...Residents, ...Tally, ...Absences, ...BlockPreview, ...Imaginaria, ...Accumulate, ...Thirdpost, ...Equity, ...Validate, ...Responsible, ...CuadranteEstados, ...Projection, ...ContajeExcel, ...Holidays, validateMonth: () => [] };

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
const OTRO = { id: "otro-1", nombre: "Oscar Menor", email: "otro@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" };

function makeDeps({ contaje = makeContajeMemoria(excelOriginalDePrueba()), lockNoReentrante = false } = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[RESP, OTRO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables), recordToRow(TABLES.responsables, { id: "m1", periodoInicio: "2027-01-01", periodoFin: "2028-01-01", residenteId: "resp-1", metodo: "VOLUNTARIO" })],
    asignaciones: [headerOf(TABLES.asignaciones)], cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)], preferencias: [headerOf(TABLES.preferencias)],
  });
  const locks = { veces: 0, profundidad: 0, maxima: 0 };
  const withLock = (fn) => {
    // Como el `LockService` real: pedir el lock estando dentro se espera a sí mismo y lanza.
    if (lockNoReentrante && locks.profundidad > 0) throw new Error("Lock timeout: another process was holding the lock for too long");
    locks.veces++; locks.profundidad++; locks.maxima = Math.max(locks.maxima, locks.profundidad);
    try { return fn(); } finally { locks.profundidad--; }
  };
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16", clientId: CLIENT_ID, sessionSecret: "s", sessionTtl: 3600, crypto, locks,
    store: makeStore({ ss, withLock, newId: () => `id-${nodeCrypto.randomUUID()}` }),
    domain: DOMAIN,
    contaje,
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({}),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loggedInAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}
const g = (residenteId, fecha, codigo = "G") => ({ residenteId, fecha, codigo });
function asignar(deps, filas) { deps.store.appendRecords("asignaciones", filas); }
function publicar(deps, session, mes, anio) {
  assert.equal(call({ action: "marcarValidado", session, mes, anio }, deps).ok, true);
  return call({ action: "publicarCuadrante", session, mes, anio }, deps);
}
/** Fila de la columna B con ese nombre en una hoja del doble, o -1. */
function filaDe(contaje, hoja, nombre) {
  for (let f = 1; f < 200; f++) if (contaje.celda(hoja, `B${f}`) === nombre) return f;
  return -1;
}

test("sin CONTAJE_SPREADSHEET_ID la app publica como siempre y responde «omitido»", () => {
  const deps = makeDeps({ contaje: null });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "PUBLICADO");
  assert.match(r.contajeExcel.omitido, /CONTAJE_SPREADSHEET_ID/);
  assert.equal(r.contajeExcel.configurado, false, "sin propiedad la pantalla no tiene nada que avisar");
});

test("estadoCuadrante dice si hay Excel del contaje configurado (sin abrirlo): la pantalla enseña «Volcar al contaje» solo entonces", () => {
  const con = makeDeps();
  const sCon = loggedInAs(con, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session: sCon, mes: 7, anio: 2027 }, con).contajeConfigurado, true);
  assert.equal(con.contaje.llamadas.length, 0, "leer el estado no abre otro fichero");
  const sin = makeDeps({ contaje: null });
  const sSin = loggedInAs(sin, "resp@gmail.com");
  assert.equal(call({ action: "estadoCuadrante", session: sSin, mes: 7, anio: 2027 }, sin).contajeConfigurado, false);
});

test("si el fichero no se puede abrir (sin permiso), se publica igual y se responde «omitido» con el motivo", () => {
  const deps = makeDeps({ contaje: makeContajeMemoria(excelOriginalDePrueba(), { motivoAbrir: "sin acceso al fichero" }) });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.estado, "PUBLICADO");
  assert.deepEqual(r.contajeExcel, { omitido: "sin acceso al fichero" });
});

test("publicar prepara el fichero la primera vez y vuelca el curso: plantillas ocultas, sin __DATA__, pestañas del curso", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  asignar(deps, [g("resp-1", "2027-07-02"), g("resp-1", "2027-07-04")]); // viernes + domingo
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.ok, true);
  assert.equal(r.contajeExcel.ok, true, JSON.stringify(r.contajeExcel));
  assert.deepEqual(r.contajeExcel.cursos.map((c) => c.curso), ["2027-28"]);

  const c = deps.contaje;
  const hojas = c.hojas();
  assert.ok(!hojas.includes("__DATA__"));
  for (const o of ["Cuadrante Mensual", "Resumen Anual", "Contaje Trimestral", "Tercer Puesto"]) {
    assert.ok(hojas.includes(`Plantilla · ${o}`), o);
    assert.ok(c.estaOculta(`Plantilla · ${o}`), `${o} oculta`);
    assert.ok(!hojas.includes(o), `el original «${o}» ya no está con su nombre`);
    assert.ok(hojas.includes(`${o} 2027-28`));
    assert.equal(c.estaOculta(`${o} 2027-28`), false);
  }
  // Los nombres de ejemplo de la plantilla no pasan a la pestaña del curso.
  assert.equal(filaDe(c, "Plantilla · Resumen Anual", "Ejemplo Uno"), -1);
  const f = filaDe(c, "Resumen Anual 2027-28", "Rita Mayor");
  assert.ok(f > 0);
  assert.equal(c.celda("Resumen Anual 2027-28", `F${f}`), 2); // Total
  assert.equal(c.celda("Resumen Anual 2027-28", `I${f}`), 1); // Dobletes V-D
  assert.equal(c.celda("Cuadrante Mensual 2027-28", "B2"), "Julio");
  assert.match(String(c.celda("Cuadrante Mensual 2027-28", "F2")), /^Actualizado por la app: 2027-07-16/);
  assert.ok(c.columnaOculta("Tercer Puesto 2027-28", 13), "el id va en una columna oculta");
  // Protegidas «con advertencia» por la propia app (no es un paso manual del runbook); «Obs.» libre.
  for (const o of ["Cuadrante Mensual", "Resumen Anual", "Contaje Trimestral", "Tercer Puesto"]) assert.ok(c.proteccion(`${o} 2027-28`), o);
  assert.deepEqual(c.proteccion("Tercer Puesto 2027-28").libres, ["L5:L"]);
  // Instrucciones e Imaginaria, reescritas.
  assert.notEqual(c.celda("Instrucciones", "B3"), "section");
  assert.match(String(c.celda("Imaginaria", "A2")), /app/);
  assert.equal(c.celda("Imaginaria", "C6"), "");
});

test("un fallo al escribir el contaje NUNCA bloquea ni revierte la publicación", () => {
  const contaje = makeContajeMemoria(excelOriginalDePrueba());
  contaje.aplicar = () => { throw new Error("Service Spreadsheets failed"); };
  const deps = makeDeps({ contaje });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.ok, true);
  assert.equal(r.estado, "PUBLICADO");
  assert.equal(r.contajeExcel.ok, false);
  assert.match(r.contajeExcel.error, /Service Spreadsheets failed/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("el volcado va en un SEGUNDO atómico, después del de publicar y nunca anidado en él", () => {
  const deps = makeDeps({ lockNoReentrante: true });
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps).ok, true);
  deps.locks.veces = 0; deps.locks.maxima = 0;
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.estado, "PUBLICADO");
  assert.equal(r.contajeExcel.ok, true, JSON.stringify(r.contajeExcel));
  assert.equal(deps.locks.veces, 2, "uno para publicar y otro para el volcado");
  assert.equal(deps.locks.maxima, 1);
});

test("despublicar NO toca el Excel (V-11b): ni una llamada al puerto", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  publicar(deps, session, 7, 2027);
  const antes = deps.contaje.llamadas.length;
  assert.equal(call({ action: "despublicarCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "VALIDADO");
  assert.equal(deps.contaje.llamadas.length, antes);
});

test("volcar dos veces seguidas deja el fichero idéntico (se recalcula entero desde el store)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  asignar(deps, [g("resp-1", "2027-07-02"), g("otro-1", "2027-07-03")]);
  publicar(deps, session, 7, 2027);
  const antes = JSON.stringify(deps.contaje.instantanea());
  const r = call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.stringify(deps.contaje.instantanea()), antes);
});

test("volcarContaje exige el permiso del ciclo (V-16) y sesión", () => {
  const deps = makeDeps();
  const sOtro = loggedInAs(deps, "otro@gmail.com");
  const r = call({ action: "volcarContaje", session: sOtro, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /Responsable/);
  assert.equal(call({ action: "volcarContaje", mes: 7, anio: 2027 }, deps).ok, false);
  assert.equal(deps.contaje.llamadas.length, 0, "rechazado antes de abrir el fichero");
});

test("volcarContaje sin propiedad: ok:false con «omitido» para que la pantalla lo diga", () => {
  const deps = makeDeps({ contaje: null });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.omitido, true);
  assert.equal(r.configurado, false);
  assert.match(r.error, /CONTAJE_SPREADSHEET_ID/);
});

test("si la huella de cabeceras no cuadra, no se escribe nada y se avisa", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  publicar(deps, session, 7, 2027);
  // Alguien reordena las columnas de una pestaña a mano.
  deps.contaje.aplicar("Resumen Anual 2027-28", [{ op: "escribir", fila: 4, columna: 3, valores: [["Total"]] }]);
  asignar(deps, [g("resp-1", "2027-07-09")]);
  const antes = JSON.stringify(deps.contaje.instantanea());
  const r = call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /Resumen Anual 2027-28.*C4/);
  assert.equal(JSON.stringify(deps.contaje.instantanea()), antes, "ni la pestaña buena ni la mala se tocan");
});

test("solo cuentan meses PUBLICADOS, y el doblete de borde aparece al publicar el mes siguiente (C-1, V-65)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  asignar(deps, [g("resp-1", "2027-07-30"), g("resp-1", "2027-08-01"), g("resp-1", "2027-08-10")]); // viernes 30 + domingo 1
  publicar(deps, session, 7, 2027);
  assert.equal(call({ action: "marcarValidado", session, mes: 8, anio: 2027 }, deps).ok, true); // agosto VALIDADO, no publicado
  call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  const hoja = "Resumen Anual 2027-28";
  const f = () => filaDe(deps.contaje, hoja, "Rita Mayor");
  assert.equal(deps.contaje.celda(hoja, `F${f()}`), 1);
  assert.equal(deps.contaje.celda(hoja, `I${f()}`), 0);
  const r = call({ action: "publicarCuadrante", session, mes: 8, anio: 2027 }, deps);
  assert.equal(r.contajeExcel.ok, true);
  assert.equal(deps.contaje.celda(hoja, `F${f()}`), 3);
  assert.equal(deps.contaje.celda(hoja, `I${f()}`), 1);
  assert.equal(deps.contaje.celda("Cuadrante Mensual 2027-28", "B2"), "Agosto");
});

test("publicar junio vuelve a volcar también el curso anterior (el doblete del viernes 31 de mayo)", () => {
  // 2030-05-31 es viernes y 2030-06-02 domingo: el doblete es de mayo (curso 2029-30), pero solo
  // se ve con junio (curso 2030-31) publicado.
  const deps = makeDeps();
  deps.today = "2030-06-20";
  deps.store.appendRecord("residentes", { id: "nue-1", nombre: "Nuria Nueva", email: "nuria@gmail.com", fechaInicio: "2027-05-24", fechaFin: "2031-05-23" });
  deps.store.appendRecord("responsables", { periodoInicio: "2030-01-01", periodoFin: "2031-01-01", residenteId: "nue-1", metodo: "VOLUNTARIO" });
  const session = loggedInAs(deps, "nuria@gmail.com");
  asignar(deps, [g("nue-1", "2030-05-31"), g("nue-1", "2030-06-02")]);
  publicar(deps, session, 5, 2030);
  const hoja = "Resumen Anual 2029-30";
  assert.equal(deps.contaje.celda(hoja, `I${filaDe(deps.contaje, hoja, "Nuria Nueva")}`), 0);
  const r = publicar(deps, session, 6, 2030);
  assert.deepEqual(r.contajeExcel.cursos.map((c) => c.curso), ["2030-31", "2029-30"]);
  assert.equal(deps.contaje.celda(hoja, `I${filaDe(deps.contaje, hoja, "Nuria Nueva")}`), 1);
});

test("«Obs.» de Tercer Puesto sigue a su residente entre volcados (se recoloca por id)", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  publicar(deps, session, 7, 2027);
  const hoja = "Tercer Puesto 2027-28";
  const fRita = filaDe(deps.contaje, hoja, "Rita Mayor");
  deps.contaje.aplicar(hoja, [{ op: "escribir", fila: fRita, columna: 12, valores: [["'Solo fines de semana"]] }]);
  // Llega una residente nueva al mismo nivel que se ordena antes que Rita: las filas se mueven.
  deps.store.appendRecord("residentes", { id: "ana-1", nombre: "Ana Antes", email: "ana@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" });
  const r = call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const nueva = filaDe(deps.contaje, hoja, "Rita Mayor");
  assert.notEqual(nueva, fRita);
  assert.equal(deps.contaje.celda(hoja, `L${nueva}`), "Solo fines de semana");
  assert.equal(deps.contaje.celda(hoja, `L${filaDe(deps.contaje, hoja, "Ana Antes")}`), "");
});

test("un fichero que no es el del servicio no se prepara: se avisa y la publicación sigue", () => {
  const deps = makeDeps({ contaje: makeContajeMemoria({ Hoja1: { A1: "otra cosa" } }) });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.estado, "PUBLICADO");
  assert.equal(r.contajeExcel.ok, false);
  assert.match(r.contajeExcel.error, /no tiene ni «Plantilla · Cuadrante Mensual» ni «Cuadrante Mensual»/);
  assert.deepEqual(deps.contaje.hojas(), ["Hoja1"]);
});

test("un original con otras cabeceras no se toca (huella del original)", () => {
  const raro = excelOriginalDePrueba();
  raro["Resumen Anual"].C4 = "Guardias";
  const deps = makeDeps({ contaje: makeContajeMemoria(raro) });
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.contajeExcel.ok, false);
  assert.match(r.contajeExcel.error, /Resumen Anual/);
  // Se comprueba todo antes de tocar nada: ni __DATA__ se ha borrado ni nada se ha renombrado.
  assert.ok(deps.contaje.hojas().includes("__DATA__"));
  assert.ok(deps.contaje.hojas().includes("Cuadrante Mensual"));
});

test("si el lock del volcado no llega (otro proceso lo tiene), la publicación queda hecha y el fallo viaja en contajeExcel", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps).ok, true);
  // El primer `transaction` (publicar) va bien; el segundo (el volcado) se queda esperando y lanza,
  // como `waitLock(30000)` de LockService.
  const transaction = deps.store.transaction;
  let veces = 0;
  deps.store.transaction = (fn) => {
    if (++veces === 2) throw new Error("Lock timeout: another process was holding the lock for too long");
    return transaction(fn);
  };
  const r = call({ action: "publicarCuadrante", session, mes: 7, anio: 2027 }, deps);
  deps.store.transaction = transaction;
  assert.equal(r.ok, true);
  assert.equal(r.estado, "PUBLICADO");
  assert.equal(r.contajeExcel.ok, false);
  assert.match(r.contajeExcel.error, /Lock timeout/);
  assert.equal(call({ action: "estadoCuadrante", session, mes: 7, anio: 2027 }, deps).estado, "PUBLICADO");
});

test("la preparación que muere a medias se reanuda ENTERA: la plantilla no se queda con los nombres de ejemplo", () => {
  const contaje = makeContajeMemoria(excelOriginalDePrueba());
  const aplicar = contaje.aplicar;
  let falla = true;
  // Como un fallo de Sheets a mitad de la reconversión de «Contaje Trimestral»: las cabeceras nuevas
  // ya están escritas (su huella es la de la plantilla) pero la primera combinada lanza.
  contaje.aplicar = (n, ops) => {
    if (falla && n === "Contaje Trimestral") {
      falla = false;
      const k = ops.findIndex((o) => o.op === "unir");
      aplicar(n, ops.slice(0, k));
      throw new Error("Service Spreadsheets failed");
    }
    return aplicar(n, ops);
  };
  const deps = makeDeps({ contaje });
  const session = loggedInAs(deps, "resp@gmail.com");
  assert.equal(publicar(deps, session, 7, 2027).contajeExcel.ok, false);
  const r = call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const plantilla = "Plantilla · Contaje Trimestral";
  assert.ok(contaje.estaOculta(plantilla));
  for (const n of ["Ejemplo Uno", "Ejemplo Dos", "Ejemplo Tres"]) assert.equal(filaDe(contaje, plantilla, n), -1, n);
  assert.ok(contaje.unidas(plantilla).includes("C3:I3"), "las combinadas que no llegaron a aplicarse");
  assert.deepEqual(contaje.congelado(plantilla), { filas: 4, columnas: 2 });
});

test("la preparación deshace las combinadas del Excel que cruzan las columnas fijadas, y fija sin partir ninguna", () => {
  // El doble lanza como Sheets si se fija o se combina partiendo una combinada; el Excel de prueba
  // trae las del real (título A1:AJ1 y «LEYENDA →» A4:D4 con E7 fijado, A1:X1 en Contaje).
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.contajeExcel.ok, true, JSON.stringify(r.contajeExcel));
  const c = deps.contaje;
  assert.deepEqual(c.congelado("Plantilla · Cuadrante Mensual"), { filas: 7, columnas: 2 });
  assert.deepEqual(c.unidas("Plantilla · Cuadrante Mensual"), []);
  assert.deepEqual(c.congelado("Contaje Trimestral 2027-28"), { filas: 4, columnas: 2 });
  assert.ok(!c.unidas("Contaje Trimestral 2027-28").some((u) => u.startsWith("A1:")), "el título no se combina");
});

test("«Obs.» se relee como el texto que se ve: un número tecleado vuelve como ese mismo texto", () => {
  const deps = makeDeps();
  const session = loggedInAs(deps, "resp@gmail.com");
  publicar(deps, session, 7, 2027);
  const hoja = "Tercer Puesto 2027-28";
  const f = filaDe(deps.contaje, hoja, "Rita Mayor");
  deps.contaje.aplicar(hoja, [{ op: "escribir", fila: f, columna: 12, valores: [[15]] }]); // sin apóstrofo: Sheets lo guarda como número
  assert.equal(call({ action: "volcarContaje", session, mes: 7, anio: 2027 }, deps).ok, true);
  assert.equal(deps.contaje.celda(hoja, `L${f}`), "15");
});

test("la respuesta del volcado dice cuánto ha durado (ms), si hay reloj", () => {
  const deps = makeDeps();
  let t = 1000;
  deps.relojMs = () => (t += 250);
  const session = loggedInAs(deps, "resp@gmail.com");
  const r = publicar(deps, session, 7, 2027);
  assert.equal(r.contajeExcel.ok, true);
  assert.equal(typeof r.contajeExcel.ms, "number");
  assert.ok(r.contajeExcel.ms > 0);
});

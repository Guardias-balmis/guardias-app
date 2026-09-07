// Tests de `editarResidente`, `guardarPeriodos` y `restaurarPeriodos` (fases 2 y 3 de V-24, punto
// 10 de la auditoría del 2026-07-27).
//
// La tabla `periodos` estaba declarada en el esquema y el runbook obligaba a crearla, pero ningún
// camino del servidor la tocaba: `grep periodos` en el router solo devolvía un comentario, así que
// `residente.periodos` era SIEMPRE undefined y la nota [a] de la normativa («los periodos generados
// son editables después») era inalcanzable por las dos vías. Tampoco había forma de corregir
// `fechaFin` tras el alta, que es lo que dejaba sin salida el caso que V-21 degradó a `aviso`.
import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { handleRequest } from "../src/router.js";
import { headerOf, TABLES, recordToRow } from "../src/sheets-schema.js";
import { makeStore } from "../src/sheets-store.js";
import { absences } from "../../v2/domain/absences.js";
import { parseISO, academicYearOf, toISO } from "../../v2/domain/calendar.js";
import { groupOnDate, periodsOfResident, validateTrainingPeriods, levelOn } from "../../v2/domain/residents.js";
import { validateMonth, buildMonthContext, rotationHistoryStart } from "../../v2/domain/validate.js";
import { validateThirdPost, thirdPostHistoryStart } from "../../v2/domain/thirdpost.js";
import { validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange, validateQuarterClose, quarterCloseWindow } from "../../v2/domain/equity.js";
import { canValidate, canEdit, stateAfterEdit } from "../../v2/domain/cuadrante.js";

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
    _rows: (n) => sheets.get(n),
  };
}
// MAYOR es R4 en `today` (2027-07-16) y por tanto tiene el permiso del ciclo sin mandato (V-16).
// NUEVO es R1: sirve para el caso del R1 alargado y para comprobar que un Pequeño no puede editar.
const MAYOR = { id: "r-mayor", nombre: "Marta", email: "marta@gmail.com", fechaInicio: "2023-05-22", fechaFin: "2027-11-30" };
const NUEVO = { id: "r-nuevo", nombre: "Nico", email: "nico@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" };

let idCounter = 0;
function makeDeps(extraSheets = {}) {
  const ss = fakeSS({
    residentes: [headerOf(TABLES.residentes), ...[MAYOR, NUEVO].map((r) => recordToRow(TABLES.residentes, r))],
    responsables: [headerOf(TABLES.responsables)], // sin mandato: manda V-16
    periodos: [headerOf(TABLES.periodos)],
    asignaciones: [headerOf(TABLES.asignaciones)],
    cuadrantes: [headerOf(TABLES.cuadrantes)],
    festivos: [headerOf(TABLES.festivos)],
    voluntarios3P: [headerOf(TABLES.voluntarios3P)],
    bloqueos: [headerOf(TABLES.bloqueos)],
    ...extraSheets,
  });
  const nonces = new Set();
  return {
    now: 1_000_000, today: "2027-07-16", ss,
    clientId: CLIENT_ID, sessionSecret: "secreto-servicio", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => `id-${++idCounter}` }),
    domain: {
      absences, parseISO, academicYearOf, toISO,
      groupOnDate, periodsOfResident, validateTrainingPeriods, levelOn,
      validateMonth, buildMonthContext, rotationHistoryStart,
      validateThirdPost, thirdPostHistoryStart,
      validateResidencyYearClose, buildYearCloseContext, yearCloseHistoryStart, yearCloseFestivosRange,
      validateQuarterClose, quarterCloseWindow,
      canValidate, canEdit, stateAfterEdit,
    },
    issueNonce: () => { const n = "nonce-" + nonces.size; nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    fetchTokeninfo: () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email: "marta@gmail.com", email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce: [...nonces][0] }),
  };
}
const call = (body, deps) => handleRequest(JSON.stringify(body), deps);
function loginAs(deps, email) {
  const nonce = call({ action: "getNonce" }, deps).nonce;
  deps.fetchTokeninfo = () => ({ aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", sub: "g-1", exp: String(2_000_000), nonce });
  return call({ action: "login", idToken: "jwt", nonce }, deps).session;
}
const residenteDe = (deps, session, id) => call({ action: "listResidentes", session }, deps).residentes.find((r) => r.id === id);

// Un R1 alargado un año por baja larga: el caso real de la nota [a].
const R1_ALARGADO = [
  { anio: 1, fechaInicio: "2026-05-25", fechaFin: "2028-05-24" },
  { anio: 2, fechaInicio: "2028-05-25", fechaFin: "2029-05-24" },
  { anio: 3, fechaInicio: "2029-05-25", fechaFin: "2030-05-24" },
  { anio: 4, fechaInicio: "2030-05-25", fechaFin: "2031-05-24" },
];

// ── editarResidente ──
test("editarResidente corrige fechaFin y el cambio se ve en listResidentes (append-only, mismo id)", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  assert.equal(residenteDe(deps, session, "r-nuevo").fechaFin, "2030-05-24");

  const r = call({ action: "editarResidente", session, residenteId: "r-nuevo", fechaFin: "2031-05-24" }, deps);
  assert.equal(r.ok, true);
  assert.equal(residenteDe(deps, session, "r-nuevo").fechaFin, "2031-05-24");
  // La fila vieja sigue en la tabla: el historial no se borra nunca.
  // (`f[0]` lleva el apóstrofe con que se escribe todo texto; el fake no lo despoja como Sheets.)
  assert.equal(deps.ss._rows("residentes").filter((f) => String(f[0]).replace(/^'/, "") === "r-nuevo").length, 2);
});

test("editarResidente NO toca el email: es la llave del login", () => {
  // Cambiarlo por este camino dejaría a alguien fuera de la app sin que se note hasta que entre.
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  call({ action: "editarResidente", session, residenteId: "r-nuevo", email: "otro@gmail.com", nombre: "Otro", fechaFin: "2031-05-24" }, deps);
  const r = residenteDe(deps, session, "r-nuevo");
  assert.equal(r.email, "nico@gmail.com");
  assert.equal(r.nombre, "Nico");
});

test("editarResidente valida el rango de verdad y rechaza un residente inexistente", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  assert.equal(call({ action: "editarResidente", session, residenteId: "r-nuevo", fechaFin: "2020-01-01" }, deps).ok, false); // fin < inicio
  assert.equal(call({ action: "editarResidente", session, residenteId: "r-nuevo", fechaInicio: "25/05/2026" }, deps).ok, false); // no ISO (V-22)
  assert.equal(call({ action: "editarResidente", session, residenteId: "fantasma", fechaFin: "2031-05-24" }, deps).ok, false);
  assert.equal(residenteDe(deps, session, "r-nuevo").fechaFin, "2030-05-24", "ninguna de las tres debe haber escrito");
});

// ── guardarPeriodos ──
test("guardarPeriodos escribe las 4 filas y listResidentes las devuelve en la forma del DOMINIO", () => {
  // La traducción {anio,fechaInicio,fechaFin} → {year,start,end} es el fallo silencioso más
  // probable de este punto: con las claves mal, `levelOn` lee undefined y devuelve basura sin lanzar.
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  const r = call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: R1_ALARGADO }, deps);
  assert.equal(r.ok, true);

  const nico = residenteDe(deps, session, "r-nuevo");
  assert.deepEqual(nico.periodos, [
    { year: 1, start: "2026-05-25", end: "2028-05-24" },
    { year: 2, start: "2028-05-25", end: "2029-05-24" },
    { year: 3, start: "2029-05-25", end: "2030-05-24" },
    { year: 4, start: "2030-05-25", end: "2031-05-24" },
  ]);
  // Y el dominio los usa: en julio-2027 sigue siendo R1, no R2.
  assert.equal(levelOn(periodsOfResident(nico), "2027-07-15"), "R1");
});

test("guardarPeriodos pasa por validateTrainingPeriods, que hasta ahora no invocaba NADIE", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  const malos = {
    "solo 3 periodos": R1_ALARGADO.slice(0, 3),
    "años desordenados": [R1_ALARGADO[1], R1_ALARGADO[0], R1_ALARGADO[2], R1_ALARGADO[3]],
    "solape entre R1 y R2": [{ ...R1_ALARGADO[0], fechaFin: "2028-06-30" }, ...R1_ALARGADO.slice(1)],
    "periodo invertido": [{ ...R1_ALARGADO[0], fechaInicio: "2028-05-24", fechaFin: "2026-05-25" }, ...R1_ALARGADO.slice(1)],
  };
  for (const [caso, periodos] of Object.entries(malos)) {
    const r = call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos }, deps);
    assert.equal(r.ok, false, `«${caso}» debería rechazarse`);
  }
  assert.equal(residenteDe(deps, session, "r-nuevo").periodos, undefined, "ninguno debe haber escrito");
});

test("guardarPeriodos SÍ admite un hueco entre periodos: es S-3, una baja retrasa la promoción", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  const conHueco = [
    { anio: 1, fechaInicio: "2026-05-25", fechaFin: "2027-05-24" },
    { anio: 2, fechaInicio: "2027-11-01", fechaFin: "2028-10-31" }, // 5 meses de hueco por baja
    { anio: 3, fechaInicio: "2028-11-01", fechaFin: "2029-10-31" },
    { anio: 4, fechaInicio: "2029-11-01", fechaFin: "2030-10-31" },
  ];
  assert.equal(call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: conHueco }, deps).ok, true);
  // Dentro del hueco se conserva el nivel anterior (S-3: retrasa, no des-promociona).
  assert.equal(levelOn(periodsOfResident(residenteDe(deps, session, "r-nuevo")), "2027-08-01"), "R1");
});

test("guardarPeriodos rechaza una fecha no ISO antes de llegar al dominio (V-22)", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  const r = call({ action: "guardarPeriodos", session, residenteId: "r-nuevo",
    periodos: [{ ...R1_ALARGADO[0], fechaFin: "30/02/2028" }, ...R1_ALARGADO.slice(1)] }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /R1/);
});

test("reinsertar los periodos SUSTITUYE (last-wins por residente+año), no duplica ni borra", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: R1_ALARGADO }, deps);
  const corregido = [{ ...R1_ALARGADO[0], fechaFin: "2027-11-30" }, { ...R1_ALARGADO[1], fechaInicio: "2027-12-01" }, ...R1_ALARGADO.slice(2)];
  call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: corregido }, deps);

  const nico = residenteDe(deps, session, "r-nuevo");
  assert.equal(nico.periodos.length, 4, "cuatro, no ocho");
  assert.equal(nico.periodos[0].end, "2027-11-30");
  assert.equal(deps.ss._rows("periodos").length, 9, "8 filas + cabecera: nada se borra (append-only)");
});

test("periodos incompletos en la tabla se ignoran ENTEROS y se sigue derivando de las fechas", () => {
  // El Sheet se edita a mano: media edición no debe producir un nivel a medias que nadie pueda
  // diagnosticar. Se escriben 2 de las 4 filas directamente en el store, saltándose la acción.
  const deps = makeDeps({
    periodos: [headerOf(TABLES.periodos), ...R1_ALARGADO.slice(0, 2).map((p, i) =>
      recordToRow(TABLES.periodos, { id: `r-nuevo|${i + 1}`, residenteId: "r-nuevo", anio: p.anio, fechaInicio: p.fechaInicio, fechaFin: p.fechaFin }))],
  });
  const session = loginAs(deps, "marta@gmail.com");
  const nico = residenteDe(deps, session, "r-nuevo");
  assert.equal(nico.periodos, undefined);
  assert.equal(levelOn(periodsOfResident(nico), "2027-07-15"), "R2", "deriva de las fechas, como siempre");
});

// ── restaurarPeriodos ──
test("restaurarPeriodos deshace una edición: sin ella la tabla append-only sería irreversible", () => {
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: R1_ALARGADO }, deps);
  assert.equal(levelOn(periodsOfResident(residenteDe(deps, session, "r-nuevo")), "2027-07-15"), "R1");

  assert.equal(call({ action: "restaurarPeriodos", session, residenteId: "r-nuevo" }, deps).ok, true);
  const nico = residenteDe(deps, session, "r-nuevo");
  assert.equal(nico.periodos.length, 4);
  assert.equal(levelOn(periodsOfResident(nico), "2027-07-15"), "R2", "vuelve a lo que dicen sus fechas");
  assert.equal(nico.periodos[3].end, "2030-05-24", "el R4 termina en fechaFin");
});

// ── permiso ──
test("editar fechas o periodos exige el permiso del ciclo: un Pequeño no puede", () => {
  const deps = makeDeps();
  const suya = loginAs(deps, "nico@gmail.com"); // Nico es R1 en 2027-07-16
  for (const action of ["editarResidente", "guardarPeriodos", "restaurarPeriodos"]) {
    const r = call({ action, session: suya, residenteId: "r-nuevo", fechaFin: "2031-05-24", periodos: R1_ALARGADO }, deps);
    assert.equal(r.ok, false, `${action} debería denegarse a un Pequeño`);
    assert.match(r.error, /solo un R3 o R4|solo el Responsable/);
  }
  assert.equal(residenteDe(deps, loginAs(deps, "marta@gmail.com"), "r-nuevo").periodos, undefined);
});

// ── lo que cierra el punto: los periodos editados llegan al VALIDADOR ──
test("los periodos editados llegan a marcarValidado: INV-11 ve al R1 alargado en verano", () => {
  // Es la consecuencia grave que motivaba todo el punto 10. Sin la hidratación de `allResidentes`,
  // Nico se derivaría como R2 en julio-2027 y sería asignable en verano sin que INV-11 —uno de los
  // tres invariantes que BLOQUEAN— dijera nada.
  const deps = makeDeps();
  const session = loginAs(deps, "marta@gmail.com");
  call({ action: "guardarAsignaciones", session, cambios: [
    { fecha: "2027-07-15", residenteId: "r-mayor", codigo: "G" },
    { fecha: "2027-07-15", residenteId: "r-nuevo", codigo: "G" },
  ] }, deps);

  const sinEditar = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  assert.equal(sinEditar.violaciones.filter((v) => v.invariante === "INV-11").length, 0, "derivado de las fechas es R2: INV-11 no aplica");

  call({ action: "guardarPeriodos", session, residenteId: "r-nuevo", periodos: R1_ALARGADO }, deps);
  const conEditar = call({ action: "marcarValidado", session, mes: 7, anio: 2027 }, deps);
  const inv11 = conEditar.violaciones.filter((v) => v.invariante === "INV-11");
  assert.ok(inv11.length >= 1, `INV-11 debe ver al R1 alargado: ${JSON.stringify(conEditar.violaciones)}`);
  assert.equal(conEditar.ok, false, "INV-11 bloquea: el mes no se puede validar con un R1 en julio");
});

test("los periodos editados llegan también al permiso del ciclo (requireCicloPermiso)", () => {
  // `groupOnDate` deriva MAYOR/PEQUENO de los periodos: si el permiso se leyera crudo, alguien
  // sería Mayor para validar y Pequeño para todo lo demás.
  const deps = makeDeps();
  const marta = loginAs(deps, "marta@gmail.com");
  // Marta es R4 hoy. Con unos periodos que la dejan en R2 en `today`, pierde el permiso del ciclo.
  call({ action: "guardarPeriodos", session: marta, residenteId: "r-mayor", periodos: [
    { anio: 1, fechaInicio: "2025-05-22", fechaFin: "2026-05-21" },
    { anio: 2, fechaInicio: "2026-05-22", fechaFin: "2028-05-21" }, // R2 alargado: en 2027-07-16 es R2
    { anio: 3, fechaInicio: "2028-05-22", fechaFin: "2029-05-21" },
    { anio: 4, fechaInicio: "2029-05-22", fechaFin: "2030-05-21" },
  ] }, deps);

  const r = call({ action: "editarResidente", session: marta, residenteId: "r-nuevo", fechaFin: "2031-05-24" }, deps);
  assert.equal(r.ok, false, "ya no es Mayor según sus propios periodos");
  assert.match(r.error, /solo un R3 o R4/);
});

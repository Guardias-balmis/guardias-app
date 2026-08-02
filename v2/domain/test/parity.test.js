// Test de paridad ESM ↔ bundle (contrato D-4 del ADR-002, red de seguridad §4.6).
// Garantiza que el `domain.gs` que corre en Apps Script (ámbito global único, emulado con
// node:vm) produce EXACTAMENTE el mismo resultado que la fuente ESM que corre en el
// navegador y en node:test. Si el dominio evoluciona y nadie regenera el bundle, o si el
// bundler transforma mal, este test falla en rojo. Es lo que hace que "las dos ejecuciones
// del mismo código" sean de verdad el mismo código.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import nodeCrypto from "node:crypto";
import { buildBundle, buildServerBundle, transformModule } from "../../../build/build-gas.mjs";

// Fuente ESM
import { weekday, trimesterWindow, bridgesBetween } from "../calendar.js";
import { absences, isNearbyRotation, BLOQUEA_ASIGNACION, AUSENCIA_SIMULTANEA } from "../absences.js";
import { imaginariaQueue, nextForImaginaria } from "../imaginaria.js";
import { levelOn, groupOnDate } from "../residents.js";
import { tally } from "../tally.js";
import { validateMonth, buildMonthContext } from "../validate.js";
import {
  validateThirdPost, thirdPostHistoryStart, thirdPostCommitmentEnd,
  canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES,
} from "../thirdpost.js";
import {
  validateResidencyYearClose, validateQuarterClose, quarterCloseWindow,
  yearCloseHistoryStart, yearCloseFestivosRange, buildYearCloseContext,
} from "../equity.js";
import { canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit, equityWarnings } from "../cuadrante.js";
import { buildMonthSheetRows, buildResumenRows } from "../projection.js";
import { handleRequest as esmHandleRequest } from "../../../server/src/router.js";
import { issueSession } from "../../../server/src/session.js";

// ── Fixtures deterministas que ejercitan cada función pública ──
const PERIODS = [
  { year: 1, start: "2024-05-07", end: "2025-05-06" },
  { year: 2, start: "2025-05-07", end: "2026-05-06" },
  { year: 3, start: "2026-05-07", end: "2027-05-06" },
  { year: 4, start: "2027-05-07", end: "2028-05-06" },
];
const TALLY_ASGS = [
  { residenteId: "r", fecha: "2026-06-05", codigo: "G" },
  { residenteId: "r", fecha: "2026-06-07", codigo: "G" }, // doblete V-D
];
const MONTH_CTX = {
  mes: 7, anio: 2026,
  residentes: [
    { id: "ANA", fechaInicio: "2023-05-22", fechaFin: "2027-05-21" },
    { id: "IVAN", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }, // R1 en verano
  ],
  asignaciones: [
    { residenteId: "ANA", fecha: "2026-07-15", codigo: "G" },
    { residenteId: "IVAN", fecha: "2026-07-15", codigo: "G" },
  ],
};
const TP_CTX = {
  mes: 10, anio: 2026,
  residentes: [{ id: "r4-david", fechaInicio: "2023-05-25", fechaFin: "2027-05-24" }],
  voluntarios3P: [], historial3P: {},
  asignaciones: [{ residenteId: "r4-david", fecha: "2026-10-17", codigo: "3P" }],
};
const TP_VOLUNTARIOS = [{ residenteId: "r4-david", desde: "2026-08-01" }];
// Incluye una fila CANCELADA a propósito: que el bundle también la descarte es lo que garantiza
// que un bloqueo anulado no vuelva a bloquear asignaciones solo en Apps Script.
const IMG_COB = [{ residenteId: "ANA", grupo: "MAYOR", fechaIncidencia: "2026-06-10" }];
const ABS_BLOQUEOS = [
  { residenteId: "ANA", desde: "2026-07-01", hasta: "2026-07-31", motivo: "BAJA" },
  { residenteId: "IVAN", desde: "2026-07-10", hasta: "2026-07-20", motivo: "ROTACION", provincia: "Valencia" },
  { residenteId: "ANA", desde: "2026-07-05", hasta: "2026-07-09", motivo: "VACACIONES", activo: false },
];
const EQ_CTX = {
  mes: 5, anio: 2027,
  residentes: [
    { id: "r3a", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
    { id: "r3b", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
  ],
  acumulados: {
    r3a: { total: 57, findes: 0, festivos: 0, prefestivos: 0, puentesLibres: 0, dobletes: 0 },
    r3b: { total: 55, findes: 0, festivos: 0, prefestivos: 0, puentesLibres: 0, dobletes: 0 },
  },
  asignaciones: [],
};
// El 8-dic-2026 es martes y el 6-dic domingo → el lunes 7 es puente. Cae en el año natural
// ANTERIOR al del cierre de mayo-2027: ejercita el cruce de dos años del eje `puentesLibres`.
const EQ_FESTIVOS = ["2026-12-06", "2026-12-08", "2026-12-25", "2027-01-01"];
// Cierre de T2 (nov-2026) con diferencia 2 en totales → un aviso (P-8, decisión V-13).
const QC_CTX = {
  mes: 11, anio: 2026,
  residentes: EQ_CTX.residentes,
  asignaciones: [
    { residenteId: "r3a", fecha: "2026-09-02", codigo: "G" },
    { residenteId: "r3a", fecha: "2026-10-07", codigo: "G" },
    { residenteId: "r3a", fecha: "2026-11-04", codigo: "G" },
  ],
};

// Ejecuta toda la API pública sobre una implementación (ESM namespace o el Domain del bundle).
function runAll(api) {
  const ctx = api.buildMonthContext({
    mes: MONTH_CTX.mes, anio: MONTH_CTX.anio, residentes: MONTH_CTX.residentes,
    asignacionesDelMes: MONTH_CTX.asignaciones, bloqueos: [],
    eventos: [{ tipo: "NAVIDAD", fecha: "2026-12-18", designados: ["ANA"], voluntarios: [], sorteoId: "s1", activo: true }],
  });
  const violaciones = api.validateMonth(MONTH_CTX);
  return {
    weekday: api.weekday("2026-06-01"),
    level: api.levelOn(PERIODS, "2026-07-16"),
    grupoEnFecha: ["2026-07-16", "2028-01-01"].map((f) => api.groupOnDate({ fechaInicio: "2024-05-07", fechaFin: "2028-05-07" }, f)),
    tally: api.tally(TALLY_ASGS, { start: "2026-06-01", end: "2026-06-30" }),
    month: violaciones,
    thirdpost: api.validateThirdPost(TP_CTX),
    thirdPostHistoryStart: [
      api.thirdPostHistoryStart(TP_VOLUNTARIOS, TP_CTX.residentes, TP_CTX.mes, TP_CTX.anio),
      api.thirdPostHistoryStart([], TP_CTX.residentes, TP_CTX.mes, TP_CTX.anio),
    ],
    thirdPostCommitment: [api.thirdPostCommitmentEnd("2026-10-31"), api.canWithdrawThirdPost("2026-10-31", "2027-02-27"), api.THIRD_POST_PERMANENCIA_MESES],
    equity: api.validateResidencyYearClose(EQ_CTX),
    trimesterWindow: api.trimesterWindow("2027-01-15"),
    quarterCloseWindow: [api.quarterCloseWindow(11, 2026), api.quarterCloseWindow(10, 2026)],
    quarterClose: api.validateQuarterClose(QC_CTX),
    yearCloseStart: [api.yearCloseHistoryStart(EQ_CTX.residentes, 5, 2027), api.yearCloseHistoryStart(EQ_CTX.residentes, 10, 2026)],
    yearCloseCtx: api.buildYearCloseContext({ mes: 5, anio: 2027, residentes: EQ_CTX.residentes, historicas: QC_CTX.asignaciones, asignacionesDelMes: [], festivos: EQ_FESTIVOS }),
    yearCloseFestivosRange: [api.yearCloseFestivosRange(EQ_CTX.residentes, 5, 2027), api.yearCloseFestivosRange(EQ_CTX.residentes, 10, 2026)],
    bridgesBetween: api.bridgesBetween("2026-05-27", "2027-05-26", EQ_FESTIVOS),
    monthContext: ctx,
    absences: [
      api.absences(ABS_BLOQUEOS, { motivos: api.BLOQUEA_ASIGNACION, fecha: "2026-07-15" }),
      api.absences(ABS_BLOQUEOS, { motivos: api.AUSENCIA_SIMULTANEA, desde: "2026-07-01", hasta: "2026-07-31" }),
      api.absences(ABS_BLOQUEOS, { residenteId: "ANA" }),
    ],
    isNearbyRotation: ABS_BLOQUEOS.map(api.isNearbyRotation),
    imaginaria: [
      api.imaginariaQueue({ residentes: MONTH_CTX.residentes, coberturas: IMG_COB, asignaciones: MONTH_CTX.asignaciones, grupo: "MAYOR", fechaIncidencia: "2026-07-16" }),
      api.imaginariaQueue({ residentes: MONTH_CTX.residentes, coberturas: IMG_COB, asignaciones: [], grupo: "PEQUENO", fechaIncidencia: "2026-07-16" }),
    ],
    nextForImaginaria: api.nextForImaginaria({ residentes: MONTH_CTX.residentes, coberturas: IMG_COB, asignaciones: [], grupo: "MAYOR", fechaIncidencia: "2026-07-16" }),
    canValidate: [api.canValidate([]), api.canValidate(violaciones)],
    equityWarnings: api.equityWarnings([...violaciones, ...api.validateQuarterClose(QC_CTX)]),
    canPublish: ["BORRADOR", "VALIDADO", "PUBLICADO"].map(api.canPublish),
    canUnpublish: ["BORRADOR", "VALIDADO", "PUBLICADO"].map(api.canUnpublish),
    canEdit: ["BORRADOR", "VALIDADO", "PUBLICADO"].map(api.canEdit),
    stateAfterEdit: ["BORRADOR", "VALIDADO", "PUBLICADO"].map(api.stateAfterEdit),
    monthSheet: api.buildMonthSheetRows({ anio: MONTH_CTX.anio, mes: MONTH_CTX.mes, residentes: MONTH_CTX.residentes, asignaciones: MONTH_CTX.asignaciones }),
    resumen: api.buildResumenRows({ residentes: MONTH_CTX.residentes, publishedMonths: [{ mes: MONTH_CTX.mes, anio: MONTH_CTX.anio }] }),
  };
}

const esm = {
  weekday, levelOn, groupOnDate, tally, validateMonth, validateThirdPost, validateResidencyYearClose,
  thirdPostHistoryStart, thirdPostCommitmentEnd, canWithdrawThirdPost, THIRD_POST_PERMANENCIA_MESES,
  trimesterWindow, validateQuarterClose, quarterCloseWindow, yearCloseHistoryStart, yearCloseFestivosRange,
  buildYearCloseContext, bridgesBetween,
  buildMonthContext, canValidate, canPublish, canUnpublish, canEdit, stateAfterEdit, equityWarnings,
  buildMonthSheetRows, buildResumenRows,
  absences, isNearbyRotation, BLOQUEA_ASIGNACION, AUSENCIA_SIMULTANEA,
  imaginariaQueue, nextForImaginaria,
};

// Carga el bundle en un ámbito global único, como hace Apps Script al concatenar los .gs.
function loadBundle(code) {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return context.Domain;
}

test("el bundle expone la API pública esperada", () => {
  const Domain = loadBundle(buildBundle());
  for (const fn of ["validateMonth", "buildMonthContext", "tally", "validateResidencyYearClose", "buildYearCloseContext", "yearCloseHistoryStart", "validateQuarterClose", "quarterCloseWindow", "trimesterWindow", "validateThirdPost", "levelOn", "groupOf", "groupOnDate", "periodsOfResident", "weekday", "canValidate", "equityWarnings", "canPublish", "canUnpublish", "canEdit", "stateAfterEdit", "buildMonthSheetRows", "buildResumenRows"]) {
    assert.equal(typeof Domain[fn], "function", `Domain.${fn} debe ser función`);
  }
});

test("PARIDAD: el bundle produce resultados idénticos a la fuente ESM", () => {
  const Domain = loadBundle(buildBundle());
  // Comparación POR VALOR (JSON): los objetos del vm son de otro realm; deepStrictEqual fallaría por prototipos.
  assert.equal(JSON.stringify(runAll(Domain)), JSON.stringify(runAll(esm)));
});

test("la concatenación INGENUA (sin IIFE) revienta: justifica el bundler (D-4 §4.2)", () => {
  // Concatenar los módulos quitando solo import/export colisiona en el ámbito global.
  const dir = fileURLToPath(new URL("../", import.meta.url));
  const naive = ["calendar", "residents", "tally", "thirdpost", "equity", "validate"]
    .map((m) => fs.readFileSync(dir + m + ".js", "utf8"))
    .join("\n")
    .replace(/^\s*import[^\n]*$/gm, "")
    .replace(/^(\s*)export\s+/gm, "$1");
  assert.throws(() => vm.runInContext(naive, vm.createContext({})), /has already been declared/);
});

test("el bundler FALLA RUIDOSAMENTE ante sintaxis no soportada (nunca la ignora)", () => {
  assert.throws(() => transformModule("x", 'export default function () {}'), /build-gas/);
  assert.throws(() => transformModule("x", 'export { a } from "./b.js";'), /build-gas/);
  assert.throws(() => transformModule("x", 'import Foo from "./b.js";'), /build-gas/);
  assert.throws(() => transformModule("x", 'import { a as b } from "./c.js";'), /build-gas/);
  assert.throws(() => transformModule("x", 'const p = import("./d.js");\nexport const q = 1;'), /build-gas/);
  assert.throws(() => transformModule("x", 'const noExports = 1;'), /no exporta nada/);
  // el caso soportado sí funciona
  const ok = transformModule("mini", 'import { z } from "./calendar.js";\nexport const w = z;');
  assert.match(ok, /var Mini = \(function/);
  assert.match(ok, /const \{ z \} = Calendar;/);
  assert.match(ok, /return \{ w \};/);
});

test("PARIDAD servidor: Server.handleRequest del bundle == fuente ESM", () => {
  const ctx = vm.createContext({});
  vm.runInContext(buildServerBundle(), ctx);
  const Server = ctx.Server;
  assert.equal(typeof Server.handleRequest, "function");

  const crypto = {
    hmac: (m, s) => nodeCrypto.createHmac("sha256", s).update(m, "utf8").digest("base64url"),
    b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
    b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
  };
  const deps = { now: 1000, secret: "s", sessionSecret: "s", crypto, domain: { validateMonth } };
  const session = issueSession({ sub: "u", rol: "responsable" }, { now: 1000, ttlSeconds: 3600, secret: "s", crypto });
  const cuadrante = {
    mes: 7, anio: 2026,
    residentes: [{ id: "IVAN", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" }],
    asignaciones: [{ residenteId: "IVAN", fecha: "2026-07-15", codigo: "G" }],
  };
  const body = JSON.stringify({ action: "validar", session, cuadrante });
  assert.equal(JSON.stringify(Server.handleRequest(body, deps)), JSON.stringify(esmHandleRequest(body, deps)));
});

test("FRESCURA: los .gs comiteados están al día con la fuente", () => {
  const domainPath = fileURLToPath(new URL("../../../server/domain.gs", import.meta.url));
  const serverPath = fileURLToPath(new URL("../../../server/server-lib.gs", import.meta.url));
  assert.equal(fs.readFileSync(domainPath, "utf8"), buildBundle(), "server/domain.gs desactualizado — `npm run build`");
  assert.equal(fs.readFileSync(serverPath, "utf8"), buildServerBundle(), "server/server-lib.gs desactualizado — `npm run build`");
});

// Tests de server/src/ai-prompt.js — el prompt que se le manda al modelo y, sobre todo, el PARSEO
// de lo que devuelve (decisión V-45).
//
// El parseo lleva la mayoría de los tests a propósito: el prompt es texto y su peor fallo es que
// el modelo lo entienda regular; el parseo es la frontera por donde entra una respuesta que nadie
// controla, y ahí un fallo silencioso escribe filas basura en una tabla append-only que no se
// borra nunca. Todo lo hostil que se ha visto hacer a un modelo va aquí: vallas markdown, un
// "Aquí tienes el cuadrante:" delante, un código inventado, una fecha con formato humano.

import test from "node:test";
import assert from "node:assert/strict";
import { buildGenerationPrompt, buildRetryPrompt, parseGenerationResponse, RESPONSE_SHAPE } from "../src/ai-prompt.js";

const DATOS = {
  mes: 8,
  anio: 2026,
  porNivel: {
    R4: [{ id: "r4a", nombre: "Ana Cuatro" }],
    R3: [{ id: "r3a", nombre: "Bea Tres" }],
    R2: [{ id: "r2a", nombre: "Caro Dos" }],
    R1: [],
  },
  acumulados: { r4a: { total: 12, finde: 4, festivos: 1, prefestivos: 2, dobletes: 1 } },
  bloqueos: [],
  festivos: [],
  puentes: [],
  voluntarios3P: [],
  eventos: [],
  preferencias: [],
};

test("el prompt nombra a cada residente por su id EXACTO y agrupado por nivel", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.match(p, /id="r4a"/);
  assert.match(p, /id="r3a"/);
  assert.match(p, /id="r2a"/);
  // El nivel importa: INV-1 se compone por Mayor/Pequeño, y el modelo necesita saber quién es qué.
  assert.match(p, /R4 \(Mayor\)/);
  assert.match(p, /R2 \(Pequeño\)/);
  // Un nivel sin nadie no genera un bloque vacío que el modelo pueda leer como "hay R1".
  assert.doesNotMatch(p, /R1 \(Pequeño\)/);
});

test("el prompt lleva el contaje acumulado de quien lo tiene y lo dice de quien no", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.match(p, /total=12, findes=4, festivos=1, prefestivos=2, dobletes=1/);
  assert.match(p, /sin guardias registradas todavía este año de residencia/);
});

test("sin festivos cargados el prompt lo DICE en vez de callar (S-4: no se alucinan festivos)", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.match(p, /NO inventes festivos/);
});

test("sin voluntarios de 3P el prompt prohíbe explícitamente el código 3P", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.match(p, /NO asignes ningún código 3P/);
});

test("las secciones de datos reales aparecen cuando hay datos", () => {
  const p = buildGenerationPrompt({
    ...DATOS,
    bloqueos: [
      { residenteId: "r2a", motivo: "BAJA", desde: "2026-08-03", hasta: "2026-08-09" },
      { residenteId: "r3a", motivo: "ROTACION", provincia: "Valencia", desde: "2026-08-01", hasta: "2026-08-31" },
    ],
    festivos: [{ fecha: "2026-08-15", nombre: "Asunción", ambito: "NACIONAL" }],
    puentes: ["2026-08-14"],
    voluntarios3P: [{ residenteId: "r4a", desde: "2026-05-01" }],
    eventos: [{ tipo: "NAVIDAD", fecha: "2026-12-19", voluntarios: ["r2a"] }],
    preferencias: [{ residenteId: "r3a", fechasEvitar: ["2026-08-20"], maxGuardias: 5, notas: "boda" }],
  });
  assert.match(p, /OBLIGATORIO no asignarle guardia/); // BAJA es dura (INV-5)
  assert.match(p, /ROTACIÓN \(Valencia\)/);
  assert.match(p, /evita asignarle guardia si puedes/); // rotación/vacaciones son blandas (V-8)
  assert.match(p, /2026-08-15 — Asunción/);
  assert.match(p, /PUENTES/);
  assert.match(p, /2026-08-14/);
  assert.match(p, /VOLUNTARIOS DEL 3\.º PUESTO/);
  assert.match(p, /NAVIDAD el 2026-12-19/);
  assert.match(p, /preferiría evitar 2026-08-20/);
  assert.match(p, /BLANDAS/); // el modelo no puede tratarlas como bloqueos
});

test("el prompt incluye el descanso de INV-15, que es regla DURA desde V-35", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.match(p, /dos días consecutivos|dos días seguidos/i);
});

test("el prompt fija el formato de respuesta con el schema exacto y sin markdown", () => {
  const p = buildGenerationPrompt(DATOS);
  assert.ok(p.includes(RESPONSE_SHAPE), "el prompt debe llevar literalmente la forma del JSON esperado");
  assert.match(p, /sin texto ni bloques markdown/);
  assert.match(p, /mes=8, año=2026/);
});

test("el reintento le devuelve su propia propuesta Y las violaciones concretas", () => {
  const violaciones = [
    { invariante: "INV-1", severidad: "error", detalle: "2026-08-04 sin ninguna asignación" },
    { invariante: "INV-5", severidad: "error", detalle: "Asignación G el 2026-08-05 sobre bloqueo BAJA", residenteId: "r2a" },
    { invariante: "INV-2", severidad: "aviso", detalle: "r3a: 7 guardias > máximo 6" },
  ];
  const r = buildRetryPrompt({
    prompt: buildGenerationPrompt(DATOS),
    propuesta: [{ fecha: "2026-08-01", residenteId: "r3a", codigo: "G" }],
    violaciones,
  });
  // El encargo pide devolverle la lista CONCRETA, no un "vuelve a intentarlo".
  for (const v of violaciones) assert.ok(r.includes(v.detalle), `falta el detalle de ${v.invariante}`);
  assert.match(r, /INV-1/);
  // Su propuesta anterior tiene que viajar, o el modelo corrige a ciegas sobre algo que no ve.
  assert.match(r, /"fecha":"2026-08-01"/);
  // Y se distingue lo que BLOQUEA de lo que solo mejora: un aviso no puede leerse como un error.
  assert.match(r, /OBLIGATORIO CORREGIR/);
  assert.match(r, /si puedes/i);
});

test("el reintento por respuesta ilegible explica el problema de formato, sin violaciones", () => {
  const r = buildRetryPrompt({
    prompt: buildGenerationPrompt(DATOS),
    problema: "la respuesta no era JSON",
  });
  assert.match(r, /la respuesta no era JSON/);
  assert.ok(r.includes(RESPONSE_SHAPE));
});

// ── parseo ────────────────────────────────────────────────────────────────────────────────────

const UNA = '{"asignaciones":[{"fecha":"2026-08-01","residenteId":"r3a","codigo":"G"}]}';

test("parsea un JSON limpio", () => {
  const r = parseGenerationResponse(UNA);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ fecha: "2026-08-01", residenteId: "r3a", codigo: "G" }]);
});

test("parsea aunque venga envuelto en una valla markdown", () => {
  const r = parseGenerationResponse("```json\n" + UNA + "\n```");
  assert.equal(r.ok, true);
  assert.equal(r.asignaciones.length, 1);
});

test("parsea aunque el modelo se ponga a hablar antes y después", () => {
  const r = parseGenerationResponse("Claro, aquí tienes el cuadrante:\n" + UNA + "\n¿Quieres que lo ajuste?");
  assert.equal(r.ok, true);
  assert.equal(r.asignaciones[0].residenteId, "r3a");
});

test("rechaza (sin lanzar) una respuesta que no contiene JSON", () => {
  const r = parseGenerationResponse("No puedo ayudarte con eso.");
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
});

test("rechaza un JSON sin la clave `asignaciones`", () => {
  const r = parseGenerationResponse('{"cuadrante":[]}');
  assert.equal(r.ok, false);
  assert.match(r.error, /asignaciones/);
});

test("rechaza una propuesta vacía: un mes sin ninguna guardia no es una propuesta", () => {
  const r = parseGenerationResponse('{"asignaciones":[]}');
  assert.equal(r.ok, false);
});

test("rechaza un código que no existe, nombrándolo", () => {
  const r = parseGenerationResponse('{"asignaciones":[{"fecha":"2026-08-01","residenteId":"r3a","codigo":"GUARDIA"}]}');
  assert.equal(r.ok, false);
  assert.match(r.error, /GUARDIA/);
});

test("rechaza los códigos que el generador no debe proponer nunca (V/R/B son marcadores)", () => {
  const r = parseGenerationResponse('{"asignaciones":[{"fecha":"2026-08-01","residenteId":"r3a","codigo":"V"}]}');
  assert.equal(r.ok, false);
});

test("rechaza una fecha que no es ISO estricta", () => {
  const r = parseGenerationResponse('{"asignaciones":[{"fecha":"1 de agosto","residenteId":"r3a","codigo":"G"}]}');
  assert.equal(r.ok, false);
  assert.match(r.error, /fecha/i);
});

test("rechaza una fila sin residenteId", () => {
  const r = parseGenerationResponse('{"asignaciones":[{"fecha":"2026-08-01","codigo":"G"}]}');
  assert.equal(r.ok, false);
  assert.match(r.error, /residenteId/);
});

test("no lanza nunca, sea cual sea la entrada", () => {
  for (const entrada of [undefined, null, "", 42, {}, "{", '{"asignaciones":{}}']) {
    const r = parseGenerationResponse(entrada);
    assert.equal(r.ok, false, `debería rechazar ${JSON.stringify(entrada)}`);
    assert.equal(typeof r.error, "string");
  }
});

test("descarta los campos que el modelo se invente, y deja solo los tres del schema", () => {
  const r = parseGenerationResponse('{"asignaciones":[{"fecha":"2026-08-01","residenteId":"r3a","codigo":"G","puesto":"MAYOR","comentario":"me lo invento"}]}');
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.asignaciones[0]).sort(), ["codigo", "fecha", "residenteId"]);
});

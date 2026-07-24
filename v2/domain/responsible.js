// Responsable del contaje (INV-14, spec.md). Normativa (docs/normativa.pdf): "La
// responsabilidad del contaje y organización de guardias recae sobre un R3 de enero a
// enero de R4, en ese momento un R3 del año siguiente asumirá el contaje. Está designado
// por sorteo en ausencia de voluntarios."
//
// Decisiones Fase 5 (respuestas del autor):
//  - Si se ofrecen ≥2 voluntarios (la normativa no cubre ese caso), se sortea SOLO entre
//    ellos — no entre todo el grupo de R3.
//  - La semilla la genera la capa impura (servidor), no una fuente externa. El dominio
//    nunca tira dados por su cuenta (cero I/O, S-6): `drawResponsible` es puro y
//    determinista dado (candidatos, semilla), así que el resultado sigue siendo
//    recomputable/auditable a partir del registro guardado.

import { addDays, toISO } from "./calendar.js";
import { defaultTrainingPeriods, levelOn } from "./residents.js";

const err = (detalle, extra = {}) => ({ invariante: "INV-14", severidad: "error", detalle, ...extra });

// Mismo patrón que validate.js/periodsOf: usa periodos editados si el residente los trae
// (bajas, nota [a]), si no los genera por defecto a partir de fechaInicio/fechaFin.
function periodsOf(residente) {
  if (residente.periodos) return residente.periodos;
  const fin = residente.fechaFin || addDays(toISO(Number(residente.fechaInicio.slice(0, 4)) + 4, Number(residente.fechaInicio.slice(5, 7)), Number(residente.fechaInicio.slice(8, 10))), -1);
  return defaultTrainingPeriods(residente.fechaInicio, fin);
}

/**
 * Residentes con nivel R3 en `periodoInicio` (candidatos naturales al mandato), en orden
 * canónico por id — el sorteo debe ser determinista con independencia del orden de llegada
 * de `residentes`.
 * @param {object[]} residentes {id, fechaInicio, fechaFin, periodos?}
 * @param {string} periodoInicio fecha ISO (el 1 de enero del mandato)
 * @returns {string[]} ids ordenados
 */
export function eligibleCandidates(residentes, periodoInicio) {
  return residentes
    .filter((r) => levelOn(periodsOf(r), periodoInicio) === "R3")
    .map((r) => r.id)
    .sort();
}

/**
 * Decide método y pool de candidatos según la normativa + decisión Fase 5: sin voluntarios
 * → sorteo entre todos los elegibles; un solo voluntario → se le asigna directo, sin
 * sorteo; dos o más voluntarios → sorteo SOLO entre ellos.
 * @param {string[]} eligibles ids de residentes con nivel R3 en periodoInicio
 * @param {string[]} voluntarios ids que se ofrecieron (se filtran a los elegibles; defensivo)
 * @returns {{metodo:'VOLUNTARIO', residenteId:string}|{metodo:'SORTEO', candidatos:string[]}}
 */
export function resolveMethod(eligibles, voluntarios) {
  const pool = [...new Set(voluntarios)].filter((id) => eligibles.includes(id)).sort();
  if (pool.length === 0) return { metodo: "SORTEO", candidatos: [...eligibles].sort() };
  if (pool.length === 1) return { metodo: "VOLUNTARIO", residenteId: pool[0] };
  return { metodo: "SORTEO", candidatos: pool };
}

/**
 * Sorteo puro y determinista (FNV-1a de `semilla|candidatos-ordenados`, módulo el tamaño
 * del pool). Recomputable por cualquiera a partir del registro guardado (semilla +
 * candidatos) — cambiar cualquiera de los dos a posteriori cambia el resultado, lo que
 * hace la manipulación detectable (INV-14 la comprueba).
 * @param {string[]} candidatos
 * @param {string} semilla generada por la capa impura (servidor) al ejecutar el sorteo
 * @returns {string} residenteId elegido
 */
export function drawResponsible(candidatos, semilla) {
  if (!Array.isArray(candidatos) || candidatos.length === 0) throw new Error("drawResponsible: candidatos vacío");
  if (!semilla) throw new Error("drawResponsible: semilla obligatoria");
  const orden = [...candidatos].sort();
  const clave = `${semilla}|${orden.join(",")}`;
  let h = 0x811c9dc5; // FNV-1a de 32 bits — determinista, cero dependencias (S-6)
  for (let i = 0; i < clave.length; i++) {
    h ^= clave.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return orden[(h >>> 0) % orden.length];
}

/**
 * INV-14: el responsable debe tener nivel R3 en periodoInicio, el mandato debe ir de enero
 * a enero, y el método (VOLUNTARIO/SORTEO) debe corresponder a los `voluntarios`
 * registrados (decisión Fase 5). Si es SORTEO, el resultado debe ser reproducible a partir
 * de (candidatos, semilla) — sin ellos, o si no coinciden, no es auditable.
 * @param {object} responsable {periodoInicio, periodoFin, residenteId, metodo, voluntarios,
 *                              candidatos?, semilla?, fechaSorteo?}
 * @param {object} ctx {residentes}
 * @returns {{invariante:'INV-14', severidad:'error', detalle:string, residenteId?:string, fecha?:string}[]}
 */
export function validateResponsible(responsable, ctx) {
  const { residentes } = ctx;
  const violations = [];
  const titular = residentes.find((r) => r.id === responsable.residenteId);
  if (!titular) {
    violations.push(err(`El residente ${responsable.residenteId} no existe`, { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }));
    return violations;
  }

  if (levelOn(periodsOf(titular), responsable.periodoInicio) !== "R3") {
    violations.push(err(
      `${responsable.residenteId} no tiene nivel R3 en ${responsable.periodoInicio} (el mandato exige R3 al inicio del periodo)`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  const anio = Number(responsable.periodoInicio.slice(0, 4));
  const finEsperado = `${anio + 1}-01-01`;
  if (responsable.periodoInicio.slice(5) !== "01-01" || responsable.periodoFin !== finEsperado) {
    violations.push(err(
      `El mandato debe ir de enero a enero (esperado ${anio}-01-01 → ${finEsperado}; hay ${responsable.periodoInicio} → ${responsable.periodoFin})`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  const eligibles = eligibleCandidates(residentes, responsable.periodoInicio);
  const voluntarios = responsable.voluntarios || [];
  const esperado = resolveMethod(eligibles, voluntarios);

  if (esperado.metodo === "VOLUNTARIO") {
    if (responsable.metodo !== "VOLUNTARIO" || responsable.residenteId !== esperado.residenteId) {
      violations.push(err(
        `Había un único voluntario elegible (${esperado.residenteId}) para ${responsable.periodoInicio}; debía asignarse por VOLUNTARIO, no ${responsable.metodo}`,
        { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
      ));
    }
    return violations;
  }

  // esperado.metodo === "SORTEO"
  if (responsable.metodo !== "SORTEO") {
    const motivo = voluntarios.length === 0 ? "sin voluntarios" : `${voluntarios.length} voluntarios`;
    violations.push(err(
      `${motivo}: el mandato debía decidirse por SORTEO, no por ${responsable.metodo}`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
    return violations;
  }

  if (!responsable.semilla) {
    violations.push(err("Falta la semilla del sorteo: el resultado no es recomputable", { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }));
  }

  const candidatosGuardados = [...(responsable.candidatos || [])].sort();
  const candidatosEsperados = [...esperado.candidatos].sort();
  if (JSON.stringify(candidatosGuardados) !== JSON.stringify(candidatosEsperados)) {
    violations.push(err(
      `El pool de candidatos guardado (${candidatosGuardados.join(",") || "vacío"}) no coincide con el esperado (${candidatosEsperados.join(",")})`,
      { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
    ));
  }

  if (responsable.semilla && candidatosGuardados.length) {
    const recomputado = drawResponsible(responsable.candidatos, responsable.semilla);
    if (recomputado !== responsable.residenteId) {
      violations.push(err(
        `El sorteo no es reproducible: recomputar (semilla, candidatos) da ${recomputado}, el registro dice ${responsable.residenteId}`,
        { residenteId: responsable.residenteId, fecha: responsable.periodoInicio }
      ));
    }
  }

  return violations;
}

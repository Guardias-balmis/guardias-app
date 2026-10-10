import test from "node:test";
import assert from "node:assert/strict";
import {
  VENTANA_MS, MARGEN_MS, BLOQUEO_MS, CLAVE_ALMACEN, horaDe, cronometro, rangoDelMes, instantanea, fotoDelMes,
  registrarLanzamiento, lanzamientoDe, lanzamientoVigente, olvidarLanzamiento,
  veredictoSinRespuesta, comprobarTrasFallo,
} from "../generacion.js";

// Un `localStorage` de mentira. `falla: true` lanza en todo, como el modo privado o la cuota llena.
function almacenFalso({ falla = false } = {}) {
  const datos = new Map();
  const rechaza = () => { throw new Error("QuotaExceededError"); };
  return {
    datos,
    getItem: (k) => (falla ? rechaza() : datos.has(k) ? datos.get(k) : null),
    setItem: (k, v) => (falla ? rechaza() : void datos.set(k, String(v))),
    removeItem: (k) => (falla ? rechaza() : void datos.delete(k)),
  };
}

const T0 = new Date(2026, 9, 10, 10, 42, 7).getTime(); // 10 oct 2026, 10:42:07 hora local
const G = (fecha, residenteId, codigo = "G") => ({ fecha, residenteId, codigo });
const MES = [G("2026-10-01", "a"), G("2026-10-01", "b"), G("2026-10-02", "c", "3P"), G("2026-10-03", "a", "GP")];

test("horaDe y cronometro: formato que se enseña en la tarjeta", () => {
  assert.equal(horaDe(T0), "10:42");
  assert.equal(horaDe(new Date(2026, 9, 10, 7, 5).getTime()), "07:05");
  assert.equal(cronometro(0), "0:00");
  assert.equal(cronometro(65_900), "1:05");
  assert.equal(cronometro(5 * 60_000 + 59_000), "5:59");
  assert.equal(cronometro(-3000), "0:00", "un reloj atrasado no da un tiempo negativo");
});

test("rangoDelMes: primer y último día, también en febrero bisiesto", () => {
  assert.deepEqual(rangoDelMes(2026, 10), { desde: "2026-10-01", hasta: "2026-10-31" });
  assert.deepEqual(rangoDelMes(2028, 2), { desde: "2028-02-01", hasta: "2028-02-29" });
});

test("instantanea: solo guardias (G, GF, GP, 3P) del mes; V/R/B y otros meses no cuentan; el orden no importa", () => {
  const f = instantanea([...MES, G("2026-10-04", "a", "V"), G("2026-10-05", "b", "B"), G("2026-09-30", "a"), G("2026-11-01", "a"), G("2026-10-06", "a", "")], 2026, 10);
  assert.equal(f.n, 4);
  assert.deepEqual(instantanea([...MES].reverse(), 2026, 10), f, "la firma no depende del orden de llegada");
});

test("instantanea: la firma distingue contenidos con el mismo número de guardias (reemplazar)", () => {
  const a = instantanea([G("2026-10-01", "a"), G("2026-10-02", "b")], 2026, 10);
  const b = instantanea([G("2026-10-01", "a"), G("2026-10-02", "c")], 2026, 10);
  const c = instantanea([G("2026-10-01", "a"), G("2026-10-02", "b", "GF")], 2026, 10);
  assert.equal(a.n, b.n);
  assert.notEqual(a.firma, b.firma);
  assert.notEqual(a.firma, c.firma);
  assert.deepEqual(instantanea(null, 2026, 10), { n: 0, firma: instantanea([], 2026, 10).firma });
});

test("fotoDelMes: lee el mes entero con la API; si falla, null y sin lanzar", async () => {
  const pedidos = [];
  const api = { listAsignacionesRango: async (d, h) => { pedidos.push([d, h]); return { ok: true, asignaciones: MES }; } };
  assert.deepEqual(await fotoDelMes(api, 2026, 10), instantanea(MES, 2026, 10));
  assert.deepEqual(pedidos, [["2026-10-01", "2026-10-31"]]);
  assert.equal(await fotoDelMes({ listAsignacionesRango: async () => ({ ok: false, error: "x", transporte: true }) }, 2026, 10), null);
  assert.equal(await fotoDelMes({ listAsignacionesRango: async () => ({ ok: true }) }, 2026, 10), null);
  assert.equal(await fotoDelMes({ listAsignacionesRango: async () => { throw new Error("boom"); } }, 2026, 10), null);
});

test("registrar / leer: vigente solo durante la ventana de 6 minutos, y por mes", () => {
  const al = almacenFalso();
  const antes = instantanea(MES, 2026, 10);
  assert.equal(registrarLanzamiento(al, { anio: 2026, mes: 10, ahora: T0, antes, fase: "obligatorias", modo: "completar" }), true);
  assert.deepEqual(lanzamientoVigente(al, 2026, 10, T0), { t: T0, antes, fase: "obligatorias", modo: "completar" });
  assert.ok(lanzamientoVigente(al, 2026, 10, T0 + VENTANA_MS), "a los 6 minutos aún bloquea: todavía no se puede decir «no se guardó»");
  assert.ok(lanzamientoVigente(al, 2026, 10, T0 + BLOQUEO_MS - 1), "a un milisegundo del final sigue vigente");
  assert.equal(lanzamientoVigente(al, 2026, 10, T0 + BLOQUEO_MS), null, "pasada la ventana y el margen se vuelve a ofrecer");
  assert.equal(BLOQUEO_MS, VENTANA_MS + MARGEN_MS, "el bloqueo acaba cuando el veredicto ya puede decir «sin cambios»");
  assert.equal(lanzamientoVigente(al, 2026, 11, T0), null, "otro mes no está bloqueado");
  assert.ok(lanzamientoDe(al, 2026, 10), "pero el apunte se conserva para poder comprobarlo después");
  assert.equal(lanzamientoVigente(al, 2026, 10, T0 - 60_000), null, "una hora del futuro (reloj atrasado) no bloquea para siempre");
});

test("registrar: conserva los otros meses, purga lo de más de un día y descarta fotos mal formadas", () => {
  const al = almacenFalso();
  registrarLanzamiento(al, { anio: 2026, mes: 9, ahora: T0 - 2 * 24 * 3600_000 });
  registrarLanzamiento(al, { anio: 2026, mes: 11, ahora: T0 - 1000 });
  registrarLanzamiento(al, { anio: 2026, mes: 10, ahora: T0, antes: { n: "x" } });
  assert.equal(lanzamientoDe(al, 2026, 9), null, "el de hace dos días se purgó");
  assert.ok(lanzamientoDe(al, 2026, 11), "el de otro mes sigue");
  assert.equal(lanzamientoDe(al, 2026, 10).antes, null, "una foto que no es una foto se guarda como ausencia");
});

test("olvidar: quita solo ese mes y deja el almacén limpio cuando no queda nada", () => {
  const al = almacenFalso();
  registrarLanzamiento(al, { anio: 2026, mes: 10, ahora: T0 });
  registrarLanzamiento(al, { anio: 2026, mes: 11, ahora: T0 });
  olvidarLanzamiento(al, 2026, 10);
  assert.equal(lanzamientoDe(al, 2026, 10), null);
  assert.ok(lanzamientoDe(al, 2026, 11));
  olvidarLanzamiento(al, 2026, 11);
  assert.equal(al.datos.has(CLAVE_ALMACEN), false);
  assert.equal(olvidarLanzamiento(al, 2026, 12), true, "olvidar lo que no existe no es un error");
});

test("sin almacenamiento o con el almacén roto: nada lanza y simplemente no hay recuerdo", () => {
  for (const al of [null, undefined, almacenFalso({ falla: true })]) {
    assert.equal(registrarLanzamiento(al, { anio: 2026, mes: 10, ahora: T0 }), false);
    assert.equal(lanzamientoDe(al, 2026, 10), null);
    assert.equal(lanzamientoVigente(al, 2026, 10, T0), null);
    assert.doesNotThrow(() => olvidarLanzamiento(al, 2026, 10));
  }
  const corrupto = almacenFalso();
  corrupto.datos.set(CLAVE_ALMACEN, "{no es json");
  assert.equal(lanzamientoDe(corrupto, 2026, 10), null);
  assert.equal(registrarLanzamiento(corrupto, { anio: 2026, mes: 10, ahora: T0 }), true, "y se sobrescribe sin problema");
  corrupto.datos.set(CLAVE_ALMACEN, "[1,2]");
  assert.equal(lanzamientoDe(corrupto, 2026, 10), null);
  corrupto.datos.set(CLAVE_ALMACEN, JSON.stringify({ "2026-10": { t: "ayer" } }));
  assert.equal(lanzamientoDe(corrupto, 2026, 10), null, "una entrada sin hora válida no cuenta");
});

// ── El veredicto ───────────────────────────────────────────────────────────────────────────
const antes = instantanea(MES, 2026, 10);
const distinta = instantanea([...MES, G("2026-10-09", "d")], 2026, 10);
const V = (p) => veredictoSinRespuesta({ etiquetaMes: "octubre de 2026", lanzamiento: { t: T0, antes }, ...p });

test("veredicto: si el cuadrante cambió, «sí se guardó» — también a los 10 segundos, sin esperar la ventana", () => {
  const v = V({ ahora: T0 + 10_000, estado: "BORRADOR", actual: distinta });
  assert.equal(v.conclusion, "guardado");
  assert.match(v.texto, /^Sí se guardó/);
  assert.match(v.texto, /5 guardias/);
});

test("veredicto: cambió y además está publicado, lo dice sin contradecirse", () => {
  const v = V({ ahora: T0 + 90_000, estado: "PUBLICADO", actual: distinta });
  assert.equal(v.conclusion, "guardado");
  assert.match(v.texto, /ya está publicado/);
});

test("veredicto: publicado sin cambios, «ya está publicado»; no afirma nada sobre si se guardó", () => {
  const v = V({ ahora: T0 + 20_000, estado: "PUBLICADO", actual: antes });
  assert.equal(v.conclusion, "publicado");
  assert.match(v.texto, /ya está publicado/);
  assert.doesNotMatch(v.texto, /no se guardó/i);
});

test("veredicto: igual que antes y antes de que la ejecución pueda haber muerto, NUNCA «no se guardó»: sigue en curso", () => {
  for (const ms of [0, 1000, 60_000, 5 * 60_000, VENTANA_MS - 1, VENTANA_MS, VENTANA_MS + MARGEN_MS - 1]) {
    const v = V({ ahora: T0 + ms, estado: "BORRADOR", actual: antes });
    assert.equal(v.conclusion, "en-curso", `a ${ms} ms`);
    assert.doesNotMatch(v.texto, /no se guardó/i, `a ${ms} ms`);
    assert.match(v.texto, /puede seguir en curso/);
    assert.match(v.texto, /Vuelve a mirar/);
  }
});

test("veredicto: igual que antes DESPUÉS de la ventana más el margen, y solo entonces, «no se guardó nada»", () => {
  const v = V({ ahora: T0 + VENTANA_MS + MARGEN_MS, estado: "BORRADOR", actual: antes });
  assert.equal(v.conclusion, "sin-cambios");
  assert.match(v.texto, /no se guardó nada/);
  assert.match(v.texto, /volver a generarlo/);
});

test("veredicto: sin poder leer el mes, o sin foto previa, no afirma ni «sí» ni «no» pasada la ventana", () => {
  const tarde = T0 + 10 * 60_000;
  const sinLectura = V({ ahora: tarde, estado: null, actual: null });
  assert.equal(sinLectura.conclusion, "indeterminado");
  const sinFotoPrevia = V({ ahora: tarde, estado: "BORRADOR", actual: antes, lanzamiento: { t: T0, antes: null } });
  assert.equal(sinFotoPrevia.conclusion, "indeterminado");
  assert.match(sinFotoPrevia.texto, /no hay foto previa/);
  for (const v of [sinLectura, sinFotoPrevia]) assert.doesNotMatch(v.texto, /no se guardó nada|Sí se guardó/);
});

test("veredicto: sin poder leer el mes antes de la ventana, sigue siendo «en curso» (sin afirmar nada)", () => {
  const v = V({ ahora: T0 + 30_000, estado: null, actual: null });
  assert.equal(v.conclusion, "en-curso");
});

test("veredicto: sin apunte (almacenamiento negado) no puede afirmar «no se guardó» ni inventar la hora de vuelta", () => {
  const v = V({ ahora: T0 + 20 * 60_000, estado: "BORRADOR", actual: antes, lanzamiento: null });
  assert.equal(v.conclusion, "en-curso");
  assert.equal(v.vuelveAMirarA, null);
  assert.doesNotMatch(v.texto, /no se guardó/i);
});

test("veredicto: dice a qué hora volver a mirar (lanzada + 6 min + margen)", () => {
  const v = V({ ahora: T0 + 5000, estado: "BORRADOR", actual: antes });
  assert.equal(v.vuelveAMirarA, horaDe(T0 + VENTANA_MS + MARGEN_MS));
  assert.ok(v.texto.includes(v.vuelveAMirarA));
});

test("comprobarTrasFallo: pide estado y asignaciones del mes a la vez y emite el veredicto", async () => {
  const pedidos = [];
  const api = {
    estadoCuadrante: async (a, m) => { pedidos.push(["estado", a, m]); return { ok: true, estado: "BORRADOR" }; },
    listAsignacionesRango: async (d, h) => { pedidos.push(["rango", d, h]); return { ok: true, asignaciones: [...MES, G("2026-10-09", "d")] }; },
  };
  const v = await comprobarTrasFallo({ api, anio: 2026, mes: 10, lanzamiento: { t: T0, antes }, ahora: T0 + 40_000, etiquetaMes: "octubre de 2026" });
  assert.equal(v.conclusion, "guardado");
  assert.deepEqual(pedidos.sort(), [["estado", 2026, 10], ["rango", "2026-10-01", "2026-10-31"]]);
});

test("comprobarTrasFallo: si las lecturas fallan (la red sigue caída) no lanza y no afirma nada", async () => {
  const caida = async () => ({ ok: false, transporte: true, error: "sin conexión" });
  const v = await comprobarTrasFallo({ api: { estadoCuadrante: caida, listAsignacionesRango: caida }, anio: 2026, mes: 10, lanzamiento: { t: T0, antes }, ahora: T0 + 30_000, etiquetaMes: "octubre de 2026" });
  assert.equal(v.conclusion, "en-curso");
  const lanza = async () => { throw new Error("boom"); };
  const v2 = await comprobarTrasFallo({ api: { estadoCuadrante: lanza, listAsignacionesRango: lanza }, anio: 2026, mes: 10, lanzamiento: { t: T0, antes }, ahora: T0 + 20 * 60_000, etiquetaMes: "octubre de 2026" });
  assert.equal(v2.conclusion, "indeterminado");
});

test("comprobarTrasFallo: sin `ahora` usa la hora de después de leer", async () => {
  const antesDeLeer = Date.now();
  const api = {
    estadoCuadrante: async () => ({ ok: true, estado: "BORRADOR" }),
    listAsignacionesRango: async () => ({ ok: true, asignaciones: MES }),
  };
  // Lanzada hace 10 minutos y el mes sigue igual: con la hora real, ya pasó la ventana.
  const v = await comprobarTrasFallo({ api, anio: 2026, mes: 10, lanzamiento: { t: antesDeLeer - 10 * 60_000, antes }, etiquetaMes: "octubre de 2026" });
  assert.equal(v.conclusion, "sin-cambios");
});

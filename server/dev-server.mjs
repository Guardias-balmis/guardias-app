// dev-server.mjs · SOLO PARA DESARROLLO LOCAL. No se despliega a Apps Script, no lo
// referencia Code.gs, no forma parte del artefacto de producción.
//
// Sirve los ficheros estáticos del cliente y expone un endpoint que envuelve el MISMO
// `server/src/router.js` que corre en Apps Script (con un almacén en memoria en vez de
// Sheets), para poder probar la app completa en un navegador real sin una cuenta Google ni
// un despliegue. La ÚNICA pieza sustituida es la llamada de red a `tokeninfo`: reconoce
// credenciales `dev:<email>:<nonce>` y las trata como verificadas. Ni Login.jsx ni
// router.js saben que esto existe — se inyecta un `window.google` de mentira SOLO en la
// respuesta HTML que sirve este servidor, nunca en el fichero index.html del repo.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeCrypto from "node:crypto";

import { handleRequest } from "./src/router.js";
import { makeStore } from "./src/sheets-store.js";
import { headerOf, TABLES, recordToRow } from "./src/sheets-schema.js";
// El dominio ENTERO, igual que `deps.domain = Domain` en Code.gs: con listas de funciones a
// mano, el dev-server se quedaba corto respecto a producción y fallaba solo en local (le
// faltaban buildMonthSheetRows/buildResumenRows desde la Fase 7.1 y nadie lo notó).
import * as Calendar from "../v2/domain/calendar.js";
import * as Residents from "../v2/domain/residents.js";
import * as Tally from "../v2/domain/tally.js";
import * as Absences from "../v2/domain/absences.js";
import * as BlockPreview from "../v2/domain/blockPreview.js";
import * as Imaginaria from "../v2/domain/imaginaria.js";
import * as Accumulate from "../v2/domain/accumulate.js";
import * as Thirdpost from "../v2/domain/thirdpost.js";
import * as Equity from "../v2/domain/equity.js";
import * as Validate from "../v2/domain/validate.js";
import * as Responsible from "../v2/domain/responsible.js";
import * as CuadranteEstados from "../v2/domain/cuadrante.js";
import * as Projection from "../v2/domain/projection.js";
// OJO: esta lista se mantiene A MANO y `Code.gs` no —allí `deps.domain` es el `Domain` entero
// del bundle—, así que un módulo nuevo del dominio funciona en producción y revienta AQUÍ. Ya
// pasó con buildMonthSheetRows/buildResumenRows (Fase 7.2) y con `absences`. Si añades un
// módulo a build/build-gas.mjs:DOMAIN_MODULES, añádelo también aquí.
const DOMAIN = Object.assign({}, Calendar, Residents, Tally, Absences, BlockPreview, Imaginaria, Accumulate, Thirdpost, Equity, Validate, Responsible, CuadranteEstados, Projection);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.argv[2] || 8787);
const DEV_CLIENT_ID = "dev-client-id.local";

// ── almacén en memoria (mismo contrato `ss` que sheets-store.js espera) ──
function memorySS(seed = {}) {
  const sheets = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => r.slice())]));
  return {
    listSheets: () => [...sheets.keys()],
    exists: (n) => sheets.has(n),
    read: (n) => (sheets.get(n) || []).map((r) => r.slice()),
    overwrite: (n, rows) => sheets.set(n, rows.map((r) => r.slice())),
    append: (n, rows) => { if (!sheets.has(n)) sheets.set(n, []); sheets.get(n).push(...rows.map((r) => r.slice())); },
    createSheet: (n) => sheets.set(n, []),
    deleteSheet: (n) => sheets.delete(n),
    renameSheet: (a, b) => { sheets.set(b, sheets.get(a)); sheets.delete(a); },
  };
}

// Datos de partida: dos residentes reales del Excel de referencia (spec.md), para poder
// entrar ya con equipo visible; "nueva@gmail.com" queda deliberadamente SIN vincular para
// probar el flujo de alta autoservicio (DoD-1).
const SEED_RESIDENTES = [
  { id: "res-ana", nombre: "Ana Gómez", email: "ana@gmail.com", fechaInicio: "2023-05-22", fechaFin: "2027-05-21" },
  // Misma promoción que Ana a propósito: la equidad de INV-3 se compara por cohorte, así que
  // con un residente por año (como estaba la semilla) ningún cierre era observable en local.
  { id: "res-bea", nombre: "Bea Server", email: "bea@gmail.com", fechaInicio: "2023-05-22", fechaFin: "2027-05-21" },
  { id: "res-carlos", nombre: "Carlos Ruiz", email: "carlos@gmail.com", fechaInicio: "2024-05-27", fechaFin: "2028-05-26" },
  { id: "res-elena", nombre: "Elena Sansano", email: "elena@gmail.com", fechaInicio: "2025-05-26", fechaFin: "2029-05-25" },
  { id: "res-ivan", nombre: "Iván Cortés", email: "ivan@gmail.com", fechaInicio: "2026-05-25", fechaFin: "2030-05-24" },
];
// SIN mandato de Responsable a propósito: es el estado real de producción (nadie lo ha decidido)
// y desde la decisión V-16 es el caso interesante — el ciclo VALIDADO/PUBLICADO tiene que seguir
// siendo usable por un Mayor. El otro camino (con mandato) se prueba con el flujo real de la
// Fase 5: Ana era R3 el 1 de enero, así que puede ofrecerse y lanzar el sorteo desde la app.
const ss = memorySS({
  residentes: [headerOf(TABLES.residentes), ...SEED_RESIDENTES.map((r) => recordToRow(TABLES.residentes, r))],
  responsables: [headerOf(TABLES.responsables)],
  eventos: [headerOf(TABLES.eventos)],
  imaginaria: [headerOf(TABLES.imaginaria)],
  voluntariosResponsable: [headerOf(TABLES.voluntariosResponsable)],
  asignaciones: [headerOf(TABLES.asignaciones)],
  preferencias: [headerOf(TABLES.preferencias)],
  cuadrantes: [headerOf(TABLES.cuadrantes)],
});
const nonces = new Set();
const crypto = {
  hmac: (m, s) => nodeCrypto.createHmac("sha256", s).update(m, "utf8").digest("base64url"),
  b64urlEncode: (str) => Buffer.from(str, "utf8").toString("base64url"),
  b64urlDecode: (b) => Buffer.from(b, "base64url").toString("utf8"),
};

function deps() {
  const now = Math.floor(Date.now() / 1000);
  return {
    now, today: new Date().toISOString().slice(0, 10),
    clientId: DEV_CLIENT_ID, sessionSecret: "dev-secret-no-usar-en-produccion", sessionTtl: 3600, crypto,
    store: makeStore({ ss, withLock: (fn) => fn(), newId: () => nodeCrypto.randomUUID() }),
    domain: DOMAIN,
    newSeed: () => nodeCrypto.randomUUID(),
    issueNonce: () => { const n = nodeCrypto.randomUUID(); nonces.add(n); return n; },
    consumeNonce: (n) => nonces.delete(n),
    // ÚNICO punto sustituido: credenciales "dev:email:nonce" se aceptan como verificadas.
    fetchTokeninfo: (idToken) => {
      const m = /^dev:([^:]+):(.*)$/.exec(idToken || "");
      if (!m) throw new Error("dev-server: credencial no reconocida (usa el botón de login de prueba)");
      return { aud: DEV_CLIENT_ID, iss: "https://accounts.google.com", email: m[1], email_verified: "true", sub: "dev-" + m[1], exp: String(now + 3600), nonce: m[2] };
    },
  };
}

// Objeto `google.accounts.id` de mentira: renderButton pinta botones de login de prueba en
// vez del widget real; cada botón fabrica una credencial "dev:email:nonce" y llama al mismo
// `callback` que Login.jsx registró — el resto del flujo (auth.js, router.js) es el real.
const GOOGLE_STUB = `
<script>
window.google = { accounts: { id: {
  initialize(cfg) { window.__devGisCfg = cfg; },
  renderButton(el) {
    const cfg = window.__devGisCfg;
    // Varios residentes a propósito: el nivel se deriva de fechas, así que entrar como Ana (R4),
    // Carlos (R3) o Elena (R2) es la única forma de probar en local lo que ve cada grupo —
    // permisos del ciclo (V-16), elegibilidad del mandato (INV-14), avisos por nivel.
    const users = ["ana@gmail.com (R4)", "carlos@gmail.com (R3)", "elena@gmail.com (R2)", "nueva@gmail.com (SIN vincular — prueba el alta)"];
    el.innerHTML = "";
    users.forEach((label) => {
      const email = label.split(" ")[0];
      const b = document.createElement("button");
      b.textContent = "🧪 " + label;
      b.style.cssText = "display:block;width:100%;margin:4px 0;padding:10px;border:1.5px dashed #999;border-radius:8px;background:#fffbe6;cursor:pointer;font-size:13px";
      b.onclick = () => cfg.callback({ credential: "dev:" + email + ":" + cfg.nonce });
      el.appendChild(b);
    });
  },
} } };
</script>`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".jsx": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/exec") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const result = handleRequest(body, deps());
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  let filePath = req.url.split("?")[0];
  if (filePath === "/") filePath = "/index.html";
  const abs = path.join(ROOT, filePath);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end("prohibido"); return; }

  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end("no encontrado: " + filePath); return; }
    const ext = path.extname(abs);
    let out = data;
    if (filePath === "/index.html") {
      // Quita el script REAL de Google (si hay red, cargaría de verdad y pisaría el stub
      // por ser async) e inyecta el stub justo antes de los scripts del cliente. Ni
      // index.html ni ningún fichero del repo se tocan — esto solo pasa en la respuesta HTTP.
      out = Buffer.from(data.toString("utf8")
        .replace(/<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/, "")
        .replace("</head>", GOOGLE_STUB + "\n</head>"));
    } else if (filePath === "/client/config.js") {
      // Desde la Fase 2.6, client/config.js lleva las constantes del despliegue REAL (ya no
      // placeholders) — un .replace() de cadena exacta contra "PENDIENTE_DE_DESPLIEGUE" ya no
      // encontraría nada y devolvería el fichero SIN TOCAR, haciendo que este servidor de
      // desarrollo sirviera en silencio el EXEC_URL/CLIENT_ID reales: cualquier prueba local
      // acabaría escribiendo en el Sheet de producción sin que nadie lo notara. La regex
      // sustituye el valor ACTUAL sea cual sea (placeholder o real), aquí y SOLO en la
      // respuesta HTTP de este servidor — nunca en el fichero del repo.
      out = Buffer.from(data.toString("utf8")
        .replace(/EXEC_URL = "[^"]*"/, 'EXEC_URL = "http://127.0.0.1:' + PORT + '/exec"')
        .replace(/GOOGLE_CLIENT_ID = "[^"]*"/, 'GOOGLE_CLIENT_ID = "' + DEV_CLIENT_ID + '"'));
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(out);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-server] http://127.0.0.1:${PORT}  (solo desarrollo local, no se despliega)`);
});

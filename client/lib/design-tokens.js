// Sistema de diseño (spec: docs/adr/001-arquitectura.md "conserva el diseño visual actual").
// Extraído con fidelidad de docs/auditoria/cliente-sistema-diseno.json — mismos hex, mismas
// escalas. Módulo ES nativo (sin JSX): lo importan tanto pantallas Babel como código plano.

export const COLOR = {
  blueDark: "#1F4E79", blue: "#2E75B6", blueLight: "#5BA3D0", bluePale: "#EBF3FB",
  green: "#375623", greenLight: "#E2EFDA", greenMid: "#70AD47",
  orange: "#C55A11", orangeLight: "#FCE4D6",
  yellow: "#FFE699", yellowLight: "#FFFDE7",
  red: "#C00000", redLight: "#FCE4D6",
  gray: "#F5F7FA", grayMid: "#E0E7EF", grayDark: "#6B7280",
  bodyBg: "#F0F4F8", bodyText: "#1a1a2e",
  scrollThumb: "#C0CCD8", cellBorder: "#E0E7EF", cellText: "#333",
};

export const RADIUS = { md: "12px", sm: "8px" };
export const SHADOW = {
  card: "0 2px 12px rgba(31,78,121,0.10)",
  elevated: "0 8px 32px rgba(31,78,121,0.16)",
  header: "0 2px 8px rgba(0,0,0,0.2)",
  bottomNav: "0 -2px 12px rgba(0,0,0,0.08)",
  googleBtn: "0 2px 8px rgba(0,0,0,0.06)",
  subTabActive: "0 1px 4px rgba(0,0,0,0.1)",
  toggleKnob: "0 1px 4px rgba(0,0,0,0.2)",
};

// Escala por año de residencia — más oscuro = más veterano (spec §3.3 grupo/nivel).
export const ANO_COLORS = { R4: "#1F4E79", R3: "#2E75B6", R2: "#5BA3D0", R1: "#9DC3E6" };
export const ANO_TEXT = { R4: "#fff", R3: "#fff", R2: "#fff", R1: "#1F4E79" };
export const ANOS = ["R4", "R3", "R2", "R1"];

// Códigos de guardia (spec §1: GP faltaba en el v1 — bug conocido, corregido aquí).
export const CODE_COLORS = { G: "#C6EFCE", GF: "#FCE4D6", GP: "#FCE4D6", "3P": "#DEEAF1", V: "#FFE699", R: "#E2EFDA", B: "#D9D9D9" };
export const CODE_LABELS = { G: "Guardia", GF: "G. Festiva", GP: "G. Prefestivo", "3P": "3.º Puesto", V: "Vacaciones", R: "Rotación", B: "Baja" };
export const CODES_CYCLE = ["G", "GF", "GP", "3P", "V", "R", "B", ""];

// Ciclo de estados del cuadrante (Fase 6.2, spec.md §2 — mismos valores que v2/domain/cuadrante.js
// STATES). Un solo mapa por estado, no tres paralelos (color/fondo/etiqueta): así no pueden
// desincronizarse entre sí si se añade o retoca un estado.
export const ESTADO_CUADRANTE = {
  BORRADOR: { color: COLOR.grayDark, bg: COLOR.grayMid, label: "📝 Borrador" },
  VALIDADO: { color: COLOR.blue, bg: COLOR.bluePale, label: "✅ Validado" },
  PUBLICADO: { color: COLOR.greenMid, bg: COLOR.greenLight, label: "📢 Publicado" },
};

export const DIAS_SEMANA = ["L", "M", "X", "J", "V", "S", "D"];
export const DIAS_NOMBRE = { L: "Lunes", M: "Martes", X: "Miércoles", J: "Jueves", V: "Viernes", S: "Sábado", D: "Domingo" };

// Estilos compartidos (objetos plain para style={{...S.foo}} en JSX).
export const S = {
  input: { padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${COLOR.grayMid}`, fontSize: 14, outline: "none", background: "#fff", WebkitAppearance: "none" },
  label: { fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase", letterSpacing: 0.4 },
  smallBtn: { padding: "6px 10px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  dayToggleBtn: { padding: "7px 10px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .15s" },
  counterBtn: { width: 36, height: 36, borderRadius: 10, border: `1.5px solid ${COLOR.blue}`, background: COLOR.bluePale, color: COLOR.blue, fontSize: 20, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  navBtn: { background: COLOR.bluePale, border: "none", borderRadius: 8, padding: "8px 14px", color: COLOR.blue, fontSize: 16, fontWeight: 700, cursor: "pointer" },
  th: { padding: "4px 3px", border: `1px solid ${COLOR.scrollThumb}`, textAlign: "center", whiteSpace: "nowrap", position: "sticky", top: 0 },
  td: { padding: "3px 2px", border: `1px solid ${COLOR.cellBorder}` },
  iconBtn: { background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: "6px 10px", color: "#fff", fontSize: 18, cursor: "pointer" },
};

export const pillBtn = (color) => ({ background: color, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" });

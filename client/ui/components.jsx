// Componentes compartidos (fieles a docs/auditoria/cliente-sistema-diseno.json). Se cargan
// como <script type="text/babel" data-type="module"> y se publican en window.UI — los
// ficheros .jsx no pueden importarse entre sí (ver decisión C-1, plan.md), así que las
// pantallas consumen estos componentes vía el namespace global, nunca con `import`.
import { COLOR, RADIUS, SHADOW } from "./client/lib/design-tokens.js";

function Card({ title, children }) {
  return (
    <div style={{ background: "#fff", borderRadius: RADIUS.md, padding: 16, boxShadow: SHADOW.card }}>
      {title && (
        <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.blueDark, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 8, borderBottom: `1px solid ${COLOR.grayMid}` }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 800, color: COLOR.blueDark, paddingBottom: 4 }}>{children}</div>;
}

function Btn({ onClick, children, disabled, color = COLOR.blue, textColor = "#fff" }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? COLOR.grayMid : color,
      color: disabled ? COLOR.grayDark : textColor,
      border: "none", borderRadius: 10, padding: "13px 20px",
      fontSize: 15, fontWeight: 700, cursor: disabled ? "default" : "pointer",
      width: "100%", transition: "opacity .15s", opacity: disabled ? 0.7 : 1,
    }}>{children}</button>
  );
}

function Toast({ msg, type }) {
  return (
    <div style={{
      position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)",
      background: type === "err" ? COLOR.red : COLOR.blueDark,
      color: "#fff", padding: "11px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
      boxShadow: SHADOW.elevated, zIndex: 300, whiteSpace: "nowrap",
    }}>{msg}</div>
  );
}

function QuickCard({ icon, label, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      background: "#fff", border: "none", borderRadius: RADIUS.md, padding: 14,
      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8,
      boxShadow: SHADOW.card, cursor: "pointer", textAlign: "left", width: "100%",
      borderLeft: `4px solid ${color}`,
    }}>
      <span style={{ fontSize: 24 }}>{icon}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.blueDark, lineHeight: 1.3 }}>{label}</span>
    </button>
  );
}

/** Caja de aviso inline (naranja u otro color a juego con el borde). */
function Aviso({ children, color = COLOR.orange, bg = COLOR.orangeLight }) {
  return (
    <div style={{ background: bg, border: `1px solid ${color}`, borderRadius: 10, padding: 12, fontSize: 13, color }}>
      {children}
    </div>
  );
}

/** Caja informativa (azul pálido) — instrucciones, ayudas. */
function Info({ children }) {
  return (
    <div style={{ background: COLOR.bluePale, borderRadius: 8, padding: 10, fontSize: 12, color: COLOR.blueDark, lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

window.UI = window.UI || {};
Object.assign(window.UI, { Card, SectionTitle, Btn, Toast, QuickCard, Aviso, Info });

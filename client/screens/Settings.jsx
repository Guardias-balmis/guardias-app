// SettingsScreen — sin campos de credencial ni token (ADR-001 §3: cero secretos en el
// cliente). Solo lectura de cuenta/residencia + cierre de sesión.
import { COLOR, ANO_COLORS, ANO_TEXT } from "./client/lib/design-tokens.js";

const { Card, Btn, Info } = window.UI;

function fechaEs(iso) {
  return iso ? new Date(iso).toLocaleDateString("es-ES") : "—";
}

function SettingsScreen() {
  const app = window.useApp();
  const { auth, myResidente, nivel, isResponsable, logout, setTab } = app;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480, margin: "0 auto" }}>
      <Card title="Mi cuenta">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: COLOR.blueDark }}>{auth.residente.nombre}</div>
          {myResidente && (
            <>
              <div style={{ fontSize: 13, color: COLOR.grayDark }}>{myResidente.email}</div>
              {nivel && (
                <div>
                  <span style={{ background: ANO_COLORS[nivel], color: ANO_TEXT[nivel], padding: "2px 8px", borderRadius: 6, fontWeight: 700, fontSize: 12 }}>
                    {nivel}
                  </span>
                </div>
              )}
            </>
          )}
          {isResponsable && (
            <div style={{ fontSize: 13, color: COLOR.blueDark, fontWeight: 600 }}>
              📋 Responsable del contaje este mandato
            </div>
          )}
        </div>
      </Card>

      {myResidente && (
        <Card title="Datos de mi residencia">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase", letterSpacing: 0.4 }}>Fecha de incorporación</div>
              <div style={{ fontSize: 14, color: COLOR.bodyText, marginTop: 2 }}>{fechaEs(myResidente.fechaInicio)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLOR.grayDark, textTransform: "uppercase", letterSpacing: 0.4 }}>Fecha de fin de residencia</div>
              <div style={{ fontSize: 14, color: COLOR.bodyText, marginTop: 2 }}>{fechaEs(myResidente.fechaFin)}</div>
            </div>
          </div>
        </Card>
      )}

      <Card title="Responsable del contaje">
        <div style={{ fontSize: 13, color: COLOR.grayDark, marginBottom: 10, lineHeight: 1.5 }}>
          Mandato anual (enero→enero) de un R3: voluntariado, sorteo auditable e historial.
        </div>
        <Btn onClick={() => setTab("responsable")} color={COLOR.bluePale} textColor={COLOR.blueDark}>Ver / gestionar →</Btn>
      </Card>

      <Btn onClick={logout} color={COLOR.red}>Cerrar sesión</Btn>

      <Info>
        Esta aplicación no guarda contraseñas ni tokens en tu navegador. Tu sesión es
        temporal y se cierra sola al cerrar la pestaña.
      </Info>
    </div>
  );
}

window.Screens = window.Screens || {};
window.Screens.Settings = SettingsScreen;

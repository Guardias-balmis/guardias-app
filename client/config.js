// Configuración de despliegue. Constantes, no secretos (ADR-001 §3: cero secretos en el
// cliente) — se editan UNA vez al desplegar (server/README-deploy.md paso 5) y se comitean.
// Ya no existe SettingsScreen con campos de token: no hay nada que ocultar aquí.
export const EXEC_URL = "PENDIENTE_DE_DESPLIEGUE"; // URL /exec del Web App (ADR-002 DR-4)
export const GOOGLE_CLIENT_ID = "PENDIENTE_DE_DESPLIEGUE"; // OAuth Client ID (público por diseño)

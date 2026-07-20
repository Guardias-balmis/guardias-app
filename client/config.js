// Configuración de despliegue. Constantes, no secretos (ADR-001 §3: cero secretos en el
// cliente) — se editan UNA vez al desplegar (server/README-deploy.md paso 5) y se comitean.
// Ya no existe SettingsScreen con campos de token: no hay nada que ocultar aquí.
export const EXEC_URL = "https://script.google.com/macros/s/AKfycbwPRtbMTsQVv2sZxdduRgO0Eaw404w1IFvY7vRPSd_EwIsy_W8wD3UK9pYAbCtMI7aD/exec"; // URL /exec del Web App (ADR-002 DR-4)
export const GOOGLE_CLIENT_ID = "660647011250-is39su8slvmsa1ksi32obmntvaq0jugt.apps.googleusercontent.com"; // OAuth Client ID (público por diseño)

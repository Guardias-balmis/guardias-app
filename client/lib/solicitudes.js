// Estado de la tarjeta «Solicitudes de acceso» de Inicio (V-53/V-54), fuera del `.jsx` para poder
// probarlo en Node (un `.jsx` no se puede: loader.js lo transpila en el navegador).
//
// Existe por un fallo de producción (2026-10-07): la tarjeta hacía `if (r.ok) setLista(r.solicitudes)`
// y en el render `lista.length`. Con un `ok:true` sin la lista, el estado quedaba en `undefined` y la
// tarjeta se caía entera. `api.js` ya garantiza que `ok:true` trae el array; esto es la segunda
// red, para que ni una respuesta rara ni un estado corrupto puedan tumbar el render.
//
// Las fases son explícitas, pero la tarjeta solo se PINTA en dos: con solicitudes o con error.
// «cargando» y «vacio» no pintan nada a propósito: la tarjeta existe para decidir algo, y en el
// caso normal —ninguna pendiente— Inicio no le enseña nada a quien aprueba. El error sí se enseña:
// sin él, quien aprueba no sabría que no está viendo las solicitudes, y caducan a los 5 minutos.

export const ESTADO_INICIAL = Object.freeze({ fase: "cargando", lista: [], error: null });

/**
 * El siguiente estado tras una respuesta de `api.listSolicitudesInvitado()`. Nunca lanza.
 * Un fallo conserva la lista que ya se tenía: lo que se veía se puede seguir aprobando, y el
 * servidor vuelve a comprobar que sigue pendiente.
 */
export function recibirSolicitudes(previo, r) {
  const lista = Array.isArray(previo && previo.lista) ? previo.lista : [];
  if (r && r.ok === true && Array.isArray(r.solicitudes)) {
    return { fase: r.solicitudes.length ? "lista" : "vacio", lista: r.solicitudes, error: null };
  }
  const error = r && r.ok === true
    ? "respuesta incompleta del servidor: falta la lista de solicitudes"
    : (r && typeof r.error === "string" && r.error) || "sin respuesta del servidor";
  return { fase: "error", lista, error };
}

/** Lo que pinta la tarjeta: `mostrar` false → `null`. `lista` es siempre un array. */
export function vistaSolicitudes(estado) {
  const lista = Array.isArray(estado && estado.lista) ? estado.lista : [];
  const error = (estado && estado.fase === "error" && estado.error) || null;
  return { mostrar: Boolean(error) || lista.length > 0, lista, error };
}

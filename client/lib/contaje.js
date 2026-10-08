// Qué decirle a quien publica sobre el contaje del Excel del servicio (decisión V-65). Puro, para
// poder probarlo: `Calendar.jsx` solo pinta lo que devuelve.
//
// El servidor manda el resultado del volcado en dos formas: dentro de la respuesta de publicar
// (`contajeExcel`: `{ok:true, cursos}` | `{ok:false, error}` | `{omitido: motivo}`) y como respuesta
// propia de `volcarContaje` (`{ok:true, cursos}` | `{ok:false, error, omitido?: true}`). Las dos
// acaban aquí para que la pantalla diga lo mismo en los dos casos.

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/**
 * @param {object|undefined} r  el `contajeExcel` de publicar, o la respuesta de `volcarContaje`
 * @param {{trasPublicar?: boolean}} opciones
 * @returns {null | {tipo: "ok"|"error"|"omitido", texto: string}}  null: un servidor anterior a
 *          V-65 no manda nada, y entonces no hay nada que decir
 */
export function avisoContaje(r, { trasPublicar = false } = {}) {
  if (!r || typeof r !== "object") return null;
  // Sin fichero configurado, publicar es exactamente lo de siempre: no hay nada que contar.
  if (trasPublicar && r.configurado === false) return null;
  const motivo = typeof r.omitido === "string" ? r.omitido : (r.omitido === true ? r.error : null);
  if (motivo) return { tipo: "omitido", texto: `El contaje no se ha escrito en el Excel del servicio: ${motivo}.` };
  if (r.ok === true) {
    const cursos = Array.isArray(r.cursos) ? r.cursos : [];
    if (cursos.length === 0) return { tipo: "omitido", texto: "No hay ningún mes publicado en este curso: no se ha escrito nada en el Excel del contaje." };
    const partes = cursos.map((c) => {
      const m = c.mesMostrado;
      return m ? `${c.curso} (Cuadrante Mensual con ${MESES[m.mes - 1]} de ${m.anio})` : c.curso;
    });
    // El tiempo, si el servidor lo manda: el volcado va con el script lock cogido y el paso de
    // comprobación del despliegue necesita un número, no una impresión.
    const tiempo = typeof r.ms === "number" ? ` (${(r.ms / 1000).toFixed(1).replace(".", ",")} s)` : "";
    return { tipo: "ok", texto: `Contaje escrito en el Excel del servicio: ${partes.join(" y ")}${tiempo}.` };
  }
  const error = r.error || "error desconocido";
  return {
    tipo: "error",
    texto: trasPublicar
      ? `El cuadrante está publicado, pero no se pudo escribir el contaje en el Excel del servicio: ${error}. Pulsa «Volcar al contaje» para reintentarlo.`
      : `No se pudo escribir el contaje en el Excel del servicio: ${error}.`,
  };
}

/**
 * Qué decir al despublicar un mes, si hay Excel del contaje. Despublicar no escribe en el Excel
 * (V-11b), pero el contaje se recalcula con los meses PUBLICADOS de cada volcado: mientras este siga
 * despublicado, el siguiente volcado de su curso (publicar otro mes o «Volcar al contaje») lo quita
 * del contaje oficial. Se dice aquí, y además sustituye al aviso del volcado anterior, que remitía a
 * un botón que ya no se ve con el mes en VALIDADO.
 * @param {boolean} contajeConfigurado
 * @returns {null | {tipo: "omitido", texto: string}}
 */
export function avisoDespublicado(contajeConfigurado) {
  if (!contajeConfigurado) return null;
  return {
    tipo: "omitido",
    texto: "El Excel del contaje no se ha tocado, pero mientras este mes siga despublicado el siguiente volcado de su curso (publicar otro mes o «Volcar al contaje») lo quitará del contaje. Vuelve a contar al republicarlo.",
  };
}

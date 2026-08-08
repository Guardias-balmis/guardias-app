# Propuesta P-12: división de vacaciones entre Navidad y Año Nuevo

Conocimiento de práctica real del autor (2026-08-01), **no está en
`docs/normativa.pdf`** — las 4 páginas solo dicen quién *cubre la
guardia* de los eventos de servicio (comida de Navidad, despedida de
R4s — ya `INV-10`), nunca cómo se reparten las *vacaciones* alrededor
de esas fechas.

## La regla, tal como la describe el autor

En el periodo de Navidad/Año Nuevo, el servicio suele dividirse en dos
mitades para que nadie esté de vacaciones en las dos partes a la vez:
quien no está presente en Navidad, sí lo está en Año Nuevo, y viceversa
— así ninguna de las dos ventanas se queda corta de gente.

## Por qué es un hueco real

Distinto de `INV-10` (que ya resuelve quién cubre las dos comidas de
servicio concretas, por sorteo entre R2) y del eje `puentesLibres` de
`INV-3` (equidad de puentes libres a lo largo del año, ya declarado
pero bloqueado por la misma infraestructura de calendario que `INV-12`)
— esta regla es sobre **vacaciones**, no sobre quién cubre un evento ni
sobre equidad de puentes. No hay ninguna entidad ni invariante que hoy
compare las vacaciones de un residente en la ventana de Navidad contra
sus propias vacaciones en la ventana de Año Nuevo.

## Lo que esta propuesta deja explícitamente abierto

- **Fechas exactas de cada ventana** (¿desde/hasta qué día es "Navidad"
  y "Año Nuevo" a estos efectos?) — no las tengo con precisión, no las
  invento. Necesita confirmarse antes de escribir código.
- **Alcance:** ¿aplica a todos los residentes por igual, o solo dentro
  de cada grupo (Mayor/Pequeño) por separado, mismo criterio que el
  resto de invariantes de cobertura?
- **Severidad:** dado el criterio ya fijado en `V-14` (nada bloquea
  salvo lo imposible/ilegal) y que hoy no existe ningún mecanismo
  digital de aprobación de vacaciones, `aviso` parece el criterio
  consistente con el resto del sistema — pero no lo cierra este
  documento.

## Decisión (2026-08-08, directa del autor)

**Ventanas** (motivadas por los cinco días de guardia especial —
retribución doble, gestionada fuera de la app, P-9 rechazada— que
delimitan las fiestas: 24 y 25 de diciembre, 31 de diciembre, 1 y 6 de
enero):

- **Navidad:** 23–26 de diciembre (Nochebuena, Navidad, un día de
  margen a cada lado).
- **Año Nuevo:** 29 de diciembre – 6 de enero (Nochevieja, Año Nuevo, y
  se estira hasta Reyes porque también es día de guardia especial).

La lógica real, en palabras del autor: quien trabaja el 24 ya "pierde"
esos días con su familia, así que debería poder coger los días
cercanos al 31; quien trabaja el 31/1 debería poder coger los cercanos
al 24. Así cada residente se "sacrifica" una sola vez entre las tres
fiestas importantes (Navidad, Año Nuevo, Reyes), nunca las tres.

**Alcance:** por residente individual — compara las propias ausencias
de CADA residente contra sí mismo (¿tiene ausencia en las dos
ventanas a la vez?), no una comparación entre residentes ni separada
por grupo Mayor/Pequeño. La composición diaria de 1 Mayor + 1 Pequeño
(INV-1) no cambia.

**Qué cuenta como ausente:** VACACIONES + ROTACION (cualquier motivo
que impida hacer guardia por elección/planificación) — el mismo
conjunto que ya usa INV-6 (`AUSENCIA_SIMULTANEA`) y que reutiliza
P-13. BAJA queda fuera por impredecible, mismo motivo que en P-13.

**Severidad:** `aviso`, nunca bloquea — confirmado.

**Dónde vive:** converge con P-13 en vez de ser un mecanismo aparte.
Se añade como un cuarto riesgo dentro de `previewBloqueoRisk`
(`v2/domain/blockPreview.js`), evaluado al registrar una
VACACIONES/ROTACION que caiga en una de las dos ventanas: si ese
mismo residente ya tiene (o esta misma la crea) una ausencia en la
OTRA ventana también, avisa ahí mismo — misma pantalla, mismo momento
que los otros tres riesgos de P-13, sin construir nada nuevo.

**Implementada el 2026-08-08** (mismo día): tipo `DIVISION_NAVIDAD_ANIO_NUEVO`,
7 tests nuevos en `blockPreview.test.js`, 629/629 en verde. Verificado en el
navegador contra el dev-server.

Ver la fila `P-12` en `spec.md` §8.

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

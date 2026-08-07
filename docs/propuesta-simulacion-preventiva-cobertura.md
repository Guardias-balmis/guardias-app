# Propuesta P-13: simulación preventiva de cobertura al registrar un Bloqueo

Conocimiento de práctica real del autor (2026-08-01), **no está en
`docs/normativa.pdf`** — la normativa solo dice, en general, que la
organización de vacaciones "debe realizarse en consonancia con el resto
de grupo de guardias" (p.4), sin fijar ningún umbral concreto.

## El problema que describe el autor

Lo que importa de verdad no es una fecha concreta, es que siga habiendo
gente para cubrir cada puesto: que no falten Mayores al punto de forzar
días con 2 Pequeños (o al revés), y que a quienes queden no les toque
una sobrecarga de guardias por la ausencia de sus compañeros de grupo.

## Por qué es un hueco real

Todos los invariantes que ya existen (`INV-1` composición, `INV-2`
sobrecarga mensual, `INV-3` equidad, `INV-6` ausencias por rotación)
evalúan un **`Cuadrante` ya construido**. Ninguno evalúa el riesgo **al
momento de aprobar un `Bloqueo`** (vacaciones o rotación) — hoy el
problema solo se descubre cuando alguien intenta armar el cuadrante de
ese mes, que puede ser demasiado tarde para una vacación ya prometida.

## Propuesta: reutilizar los umbrales ya decididos, evaluados antes

No se propone ningún número nuevo — los mismos dos criterios que ya
existen, aplicados de forma preventiva sobre los residentes que
**quedarían disponibles** de un grupo (Mayor o Pequeño) en el periodo
que cubre el nuevo `Bloqueo`:

1. **Riesgo de imposibilidad (espejo de `INV-1`):** si algún día del
   periodo quedaría sin ningún residente disponible de ese grupo →
   señal de que, cuando se arme el cuadrante, ese día no tendrá
   composición válida. Mismo criterio de severidad que `INV-1` (lo
   único que sigue siendo `error` en todo el sistema, `V-14`), porque
   es literalmente el mismo caso, solo detectado antes.
2. **Riesgo de sobrecarga (espejo de `INV-2`):** si el número de días
   del periodo que ese grupo debe cubrir, dividido entre los residentes
   que quedarían disponibles, superaría el techo de `INV-2` (6
   guardias/mes) → mismo criterio que `INV-2`, `aviso`.

## Lo que esta propuesta deja explícitamente abierto

- **Dónde vive este cálculo** (¿al registrar el `Bloqueo`? ¿al
  intentarlo, con posibilidad de forzar igual, como hoy con casi todo?)
  — no lo decide este documento.
- **Si compara contra los `Bloqueo` ya existentes de otros residentes
  del mismo grupo**, o solo contra el nuevo — necesita esa comparación
  para tener sentido (la simulación no sirve mirando un `Bloqueo` a la
  vez, aislado de los demás).
- **Si el check 1 debería bloquear (`error`) o solo avisar**, dado que
  hoy no hay ningún flujo de aprobación de vacaciones formal en la app
  — bloquear algo sin una vía de excepción podría dejar a alguien sin
  poder pedir vacaciones. Se propone `error` por espejar `INV-1`
  directamente, pero es una decisión de quien lo implemente, no algo
  que este documento cierre.

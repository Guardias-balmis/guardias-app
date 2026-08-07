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

## Decisión (2026-08-07, directa del autor)

**Compara siempre contra los `Bloqueo` activos ya existentes del mismo
grupo** (la segunda pregunta abierta no era realmente una alternativa:
sin esa comparación la simulación no dice nada).

**Riesgo de imposibilidad (check 1) — bloquea, pero solo dentro de la
ventana de 3 meses.** Las vacaciones/rotaciones a veces se piden con
mucha más antelación que la sesión en la que se arma el cuadrante (a 3
meses vista). Bloquear (`error`) un pedido hecho con un año de
antelación dejaría a alguien sin poder registrar una vacación ya
hablada y aprobada con tutoría solo porque otros dos la pidieron antes
y las cosas todavía pueden cambiar. Así que: si el periodo del
`Bloqueo` cae **dentro de los 3 meses** que ya cubre la sesión de
armado del cuadrante, `error` — no deja guardar. Si cae **más allá**,
solo `aviso` — se deja guardar, se asume negociado fuera de la app. No
existe hoy ningún concepto de "ventana de 3 meses" en el dominio;
tendría que crearse en la implementación, no hay nada que reaprovechar.

**Riesgo de concentración por nivel (nuevo, no estaba en la propuesta
original) — siempre `aviso`, nunca bloquea.** Además del riesgo de
imposibilidad (grupo entero sin nadie disponible) y el de sobrecarga
(check 2, sin cambios), se añade un tercer eje: si más de 2 residentes
del **mismo nivel** (R1, R2, R3 o R4 — no grupo Mayor/Pequeño, no
cohorte) están ausentes (vacaciones/rotación) a la vez, aunque el grupo
en conjunto siga teniendo gente para cubrir. Es informativo, no
bloquea, porque sigue siendo factible cubrir con el resto del grupo.

**Cuidado al implementar — nivel, no cohorte.** Esta señal agrupa por
`nivel` (R1–R4, derivado de fecha, cambia en el aniversario de cada
residente), **no** por `cohorte` (año calendario de `fechaInicio`, la
que usa INV-6 para su propio "máx. 2 simultáneos" en rotación).
`CLAUDE.md` ya marca `cohorte` y `nivel` como "distintas — don't
conflate them"; reutilizar por error la agrupación de INV-6 aquí mediría
otra cosa sin que ningún test lo note, porque ambas reglas se *ven*
igual ("máx. 2 a la vez"). Queda pendiente para la implementación
decidir con qué nivel se cuenta a un residente cuyo `Bloqueo` cruza su
propio aniversario (cambia de nivel a mitad del periodo).

**Alcance: BAJA queda fuera de los tres cálculos.** Es impredecible —
no se puede "prevenir" con antelación como una vacación o rotación
planeada — y ya la cubren INV-5 (bloquea la asignación) e INV-6
(ausencias simultáneas). Solo VACACIONES y ROTACION alimentan P-13;
un residente de baja no resta disponibilidad ni cuenta para la
concentración por nivel en esta simulación.

**Implementada el 2026-08-07** (mismo día): `v2/domain/blockPreview.js`
(`previewBloqueoRisk`), cableada en `crearBloqueo` de
`server/src/router.js` — bloquea (`error`) solo dentro de la ventana de
3 meses, y devuelve `riesgos` informativos (`aviso`) en la respuesta
cuando no bloquea. 10 tests nuevos en `blockPreview.test.js`, 622/622
en verde.

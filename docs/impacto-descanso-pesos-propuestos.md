# Impacto sobre el descanso — propuesta de números concretos

`VACATION_IMPACT_MODEL.md` fija el principio ("una guardia pesa más
cuanto mayor sea el periodo de descanso que bloquea, y fragmentar pesa
más que recortar un extremo") pero deliberadamente sin fórmula ni cifra
— quedó para cuando hiciera falta usarlo de verdad. Ahora que existe el
paquete de generación (que ya lo menciona como "criterio adicional, no
obligatorio"), tiene sentido darle un número que el modelo pueda aplicar
de forma concreta en vez de una intuición cualitativa.

**Ninguna cifra de este documento está decidida** — mismo criterio que
`EQUITY_SYSTEM.md`. Es una propuesta razonada para aprobar, ajustar o
rechazar.

---

## 1. La fórmula propuesta

No sustituye a la tabla de pesos por `tipo_dia` de `EQUITY_SYSTEM.md`
(sección 2.2) — se **suma** a ella, porque mide algo distinto: esa tabla
pesa el día *de la guardia en sí*; esto pesa el periodo de descanso
*vecino* que esa guardia amenaza, algo que puede ocurrir aunque la
guardia caiga en un día laborable común.

```
bono_descanso(guardia) =
    0                                    si no linda ni cae dentro de
                                          ningún periodo de descanso
                                          continuo de 2+ días

    K_recorte × (longitud_periodo − 1)   si la guardia está en el BORDE
                                          del periodo (lo recorta)

    K_fragmenta × (longitud_periodo − 1) si la guardia está en el
                                          INTERIOR del periodo (lo
                                          fragmenta)

Con K_fragmenta > K_recorte, para reflejar que fragmentar pesa más que
recortar a igualdad de duración (VACATION_IMPACT_MODEL.md, sección 10.5).
```

**Valores propuestos como punto de partida:** `K_recorte = 0.3`,
`K_fragmenta = 0.6` (el doble). `longitud_periodo` es la cantidad de días
consecutivos no laborables (fin de semana + festivos + puentes) que
forman el tramo continuo — se resta 1 para que un periodo de un solo día
no sume nada (ya lo captura el peso base de `tipo_dia`).

## 2. Verificación contra los ejemplos ya razonados en el documento original

| Caso (`VACATION_IMPACT_MODEL.md`) | Periodo | Posición | Cálculo | Bono |
|---|---|---|---|---|
| 5.2 — lunes antes de festivo aislado | 1 día | — | `0,3 × (1−1)` | **0** — impacto de referencia, coincide con "bajo" |
| 5.3 — jueves antes de festivo que linda con finde | 3 días | Borde | `0,3 × (3−1)` | **0,6** |
| 5.4 — jueves (borde) del puente de 4 días | 4 días | Borde | `0,3 × (4−1)` | **0,9** |
| 5.4 — viernes (interior) del mismo puente de 4 días | 4 días | Interior | `0,6 × (4−1)` | **1,8** — el doble que el jueves, tal como exige la sección 10.2 |
| 10.2 — domingo (borde opuesto) del mismo puente | 4 días | Borde | `0,3 × (4−1)` | **0,9** — igual que el jueves, coherente con "misma naturaleza" |
| Navidad, bloque de 6 días, guardia en un borde | 6 días | Borde | `0,3 × (6−1)` | **1,5** |
| Navidad, bloque de 6 días, guardia el día central | 6 días | Interior | `0,6 × (6−1)` | **3,0** — el mayor de toda la tabla, coincide con "el escenario de mayor coste posible" (sección 10.3) |

La fórmula reproduce el orden relativo de todos los casos que el
documento original ya había razonado a mano, sin ninguna cifra — es
solo la primera vez que ese razonamiento se vuelve un número.

## 3. Cómo se usaría en el paquete de generación

Reemplaza la frase cualitativa de `docs/paquete-generacion-prompt.md`,
sección 2 ("preferí no fragmentar... vale más evitarla que una guardia en
el borde") por una instrucción con número:

```
IMPACTO SOBRE EL DESCANSO (criterio adicional, no obligatorio):
- Para cada guardia candidata, calculá el bono_descanso según esta regla:
  0 si no linda ni cae dentro de un periodo de 2+ días no laborables;
  si linda con el borde, 0.3 por cada día del periodo más allá del
  primero; si cae en el interior del periodo, 0.6 por cada día del
  periodo más allá del primero.
- Entre opciones que cumplen igual las reglas obligatorias, preferí la
  de menor bono_descanso.
```

## 4. Lo que esta propuesta NO resuelve (a propósito)

`VACATION_IMPACT_MODEL.md` sección 5.6-5.9 señala una dimensión aparte
—valor familiar/personal de Navidad y Semana Santa, sincronía social de
un puente nacional frente a uno local— que el propio documento reconoce
sin cuantificar. Esta propuesta tampoco la cuantifica: no hay ninguna
señal en la normativa ni en los documentos ya aprobados de la que derivar
un número razonable, y prefiero dejarlo marcado como pendiente en vez de
inventar una cifra sin fundamento. Ya está parcialmente cubierto de otra
forma: `EQUITY_SYSTEM.md` le da a `FESTIVO_ESPECIAL` el peso más alto de
su tabla (3.5) precisamente por este motivo — Semana Santa (que no cae en
esa categoría) queda sin ese reconocimiento adicional, señalado aquí para
que no se pierda de vista.

## 5. Preguntas abiertas

1. ¿Los valores `K_recorte = 0.3` / `K_fragmenta = 0.6` parecen
   razonables, o prefieren ajustarlos con otro criterio?
2. ¿Este bono debería sumarse alguna vez al índice oficial de
   `EQUITY_SYSTEM.md` (para el saldo pendiente de compensación), o queda
   exclusivamente como criterio de desempate del generador, sin
   persistirse en ningún lado? Por ahora se propone lo segundo — más
   simple, y suficiente para lo que hace falta hoy.

No se ha escrito código en este documento — es una propuesta de números,
a aprobar antes de fijarla en el paquete de generación.

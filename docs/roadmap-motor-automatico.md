# Roadmap del cuadrante automático — de "casi automático" a un motor real

Documento de propuesta, no de código ni de arquitectura decidida. Objetivo:
dejar por escrito **qué ya resuelve lo que armamos** y **qué faltaría** si
en algún momento no alcanza, sin construir de más antes de necesitarlo —
mismo criterio que ya usa `docs/adr/001-arquitectura.md` en toda su
redacción.

---

## 1. Lo que ya está resuelto (prioridad actual, según lo acordado)

El **paquete de generación** (`docs/paquete-generacion-prompt.md`) más el
**validador de invariantes** (ADR-001, Fase 1) ya cubren el objetivo
principal: que en la reunión de adjudicación, en vez de armar el
cuadrante a mano guardia por guardia, el responsable pega un texto,
recibe un borrador ya armado respetando cobertura/carga/equidad, y el
validador confirma que no viola nada — con un ciclo de reintento si algo
falla.

**Esto es "casi automático", no "automático garantizado":** un modelo de
lenguaje no resuelve el problema matemáticamente, así que puede necesitar
2-3 vueltas del ciclo de reintento para converger, y en casos muy
restringidos (pocos residentes disponibles, muchas reglas compitiendo a
la vez) podría no encontrar una solución tan buena como la que encontraría
un algoritmo dedicado. Es una limitación conocida y aceptada, no un
defecto del diseño — es exactamente el costo del enfoque "cero
infraestructura, cero costo" que se decidió en el ADR.

**Esta base es la prioridad — todo lo que sigue es fase posterior, no
bloqueante.**

---

## 2. Cuándo tendría sentido un motor real

No antes de tener evidencia real de que hace falta. Señales concretas que
lo justificarían (a observar durante el uso real, no a anticipar):

- El ciclo de reintento (sección 5 del paquete de generación) se repite
  muchas veces por trimestre sin converger a una solución sin
  incidencias.
- El responsable de turno nota que el borrador generado es notablemente
  peor (en equidad o en cobertura) que lo que armaría a mano.
- El volumen de reglas simultáneas crece (por ejemplo, si se suma la idea
  de preferencias personales de la sección 4) al punto de que un modelo
  de lenguaje empieza a "olvidar" restricciones dentro del mismo prompt.

Si ninguna de estas aparece en la práctica, **no hace falta construir un
motor real nunca** — el paquete de generación + validador es una solución
completa y suficiente por sí sola.

---

## 3. Si en el futuro hiciera falta un motor real

Solo para que quede pensado, no para construirlo ahora:

- **No entra dentro de Apps Script tal como está.** Apps Script corre
  JavaScript con límite de ejecución (6 min) y sin acceso nativo a
  librerías de optimización combinatoria (tipo OR-Tools). Un motor real
  necesitaría correr en otro lado.
- **La escala del problema es chica** (15 residentes, un trimestre) —
  mucho más chico que lo que estas herramientas resuelven normalmente en
  otros contextos, así que probablemente ni siquiera necesite
  infraestructura pesada: podría alcanzar con un servicio muy liviano, o
  incluso explorar si una librería de restricciones en JavaScript puro
  (sin salir del ecosistema actual) ya alcanza para este volumen — sin
  confirmar todavía, es una pregunta técnica a investigar el día que haga
  falta, no una decisión de hoy.
- **Encajaría como una pieza aparte, no como reemplazo del validador.**
  El validador de invariantes seguiría siendo la autoridad final sobre
  qué cuadrante es válido, tanto si lo propone un humano, un LLM copiado
  a mano, o un motor real — el motor solo cambiaría *quién* genera la
  propuesta inicial.
- **Degradación digna, sin cambios:** si el motor real algún día
  desapareciera o fallara, el sistema cae de vuelta al escalón anterior
  (prompt portátil), no a cero — mismo principio que ya fija el ADR en
  su sección 8.

---

## 4. Preferencias personales por residente (idea nueva, para más adelante)

Propuesta: además de vacaciones, rotaciones y días libres (datos ya
contemplados), que cada residente pueda escribir un texto libre con
preferencias por motivos personales (ej. "prefiero no hacer guardia el
fin de semana del 15, es el cumpleaños de mi hijo").

**Regla de oro, ya acordada:** esto es siempre **deseo, nunca obligación**
— jamás puede pisar cobertura, carga mensual ni equidad (la misma
jerarquía no negociable de `GUARD_COMPOSITION_RULES.md` §1, aplicada
acá). Encaja de forma natural en lo que ya existe, sin inventar un
mecanismo nuevo:

- Es del mismo tipo que los **bloqueos BLANDOS** que ya están en el
  paquete de generación (sección 3: "preferencia, no obligación") — no
  hace falta una categoría nueva, solo ampliar ese mismo campo para
  aceptar texto libre además de fechas.
- El modelo ya recibe la instrucción de "evitar, si es posible" los
  bloqueos blandos (sección 2) — el mismo criterio aplicaría a estas
  preferencias, con el mismo límite: nunca a costa de una regla
  obligatoria.
- El validador **no necesita entender el texto libre** — solo sigue
  comprobando las reglas obligatorias de siempre. La preferencia es
  información que usa el generador (LLM) para decidir *entre* soluciones
  ya válidas, exactamente el mismo rol que ya cumple el criterio de
  "impacto sobre el descanso" (sección 2 del paquete de generación).

**Por qué se deja para después, tal como decís:** no bloquea nada de la
base actual — es un campo de datos más que se suma al mismo paquete de
generación el día que se implemente, sin tocar el validador ni las reglas
obligatorias ya definidas.

---

## Próximo paso

Ninguno de estos dos puntos (motor real, preferencias personales) es
urgente ni bloqueante. La prioridad sigue siendo la que ya se acordó:
que tu amigo termine el backend (Apps Script + Sheet) usando el paquete
de generación y el validador ya diseñados — este documento queda como
referencia para cuando, más adelante, se evalúe si hace falta ir más
allá.

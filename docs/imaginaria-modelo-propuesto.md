# Propuesta para INV-13 (Imaginaria): modelo de datos y regla concreta

INV-13 ya existe en `spec.md` §5 ("⏳ pendiente... entidad no modelada
aún") — este documento no introduce el invariante, propone cómo
modelarlo, con las respuestas del autor (2026-08-01) sobre la práctica
real, que la normativa por sí sola no especifica.

## 1. Lo que dice `docs/normativa.pdf` (p.4, "-Imaginaria")

> Se dispone de dos listas de Imaginaria. Una para residentes mayores y
> otra para residentes pequeños.
>
> En caso de incidencia, se debe intentar suplir la guardia con un
> residente según lista del grupo del que crea la incidencia. Si
> persiste el conflicto se deberá consultar a tutoría de residentes. La
> cesión/compra de guardia de incidencia NO descuenta de la imaginaria.

Tres frases, sin definir cómo se ordena cada lista, quién puede estar en
ellas, ni si hay exigencia de equidad — de ahí las preguntas al autor.

## 2. Respuestas del autor sobre la práctica real (no están en la normativa)

- **Disparador:** una incidencia (ejemplo dado: baja de última hora) que
  deja una guardia sin cubrir. Se busca cubrirla con la lista del grupo
  (Mayor/Pequeño) al que pertenece la incidencia — literal de la
  normativa.
- **Exclusión de R1:** un R1 nunca puede estar en la lista de Pequeños,
  aunque R1/R2 formen el grupo Pequeño en todo lo demás (INV-1, INV-11).
  Excepción explícita a la agrupación general, solo para Imaginaria.
- **Exclusión por proximidad a otra guardia propia:** si la incidencia
  es el día X, queda excluido quien tenga guardia asignada el día X−1
  (estaría librando el día X) o el día X+1 (para no comprometer su
  descanso previo a esa guardia). Ejemplo del autor: incidencia el
  día 21 → excluidos quienes tengan guardia el 20 o el 22.
- **Rotación:** la lista **rota** — quien cubre una Imaginaria pasa al
  final de la cola de su grupo. No es una lista estática que siempre se
  recorre desde el mismo punto.
- **Equidad:** explícitamente **no regulada**. A diferencia de guardias
  (INV-3), 3P (INV-8) y dobletes, no hay ninguna exigencia de reparto
  parejo de Imaginarias — es cobertura de emergencia, no un eje de
  equidad.
- **Cesión/compra no consume turno** (literal de la normativa): si la
  incidencia se resuelve sin usar la lista (cedida/comprada), nadie de
  la lista se mueve — la rotación solo avanza cuando alguien de la
  lista efectivamente cubre.

## 3. Modelo de datos propuesto

Coherente con el principio "derivar > almacenar" (`spec.md` §1) y con el
mismo patrón append-only ya usado para `Responsable`/`sorteos`: no se
almacena "la cola" como estructura mutable, se registra cada cobertura
real y la cola se **deriva** de ese historial.

```
ImaginariaCobertura {
  id: UUID
  grupo: MAYOR | PEQUENO
  fechaIncidencia: date       # el día que hubo que cubrir
  residenteId                 # quien cubrió, ya después de aplicar exclusiones
  registradaEn: date
}
```

**Orden de la cola, derivado (no almacenado):** para un grupo dado, los
residentes elegibles (nivel MAYOR o PEQUENO por fecha, **nunca R1** en
Pequeños) se ordenan por la fecha de su `ImaginariaCobertura` más
reciente, ascendente (quien nunca cubrió ninguna, primero). Sobre esa
cola derivada se aplica la exclusión de proximidad (guardia el día
anterior o siguiente a `fechaIncidencia`) y se toma el primero que
quede. Una cesión/compra no genera fila en `ImaginariaCobertura` — por
eso no mueve a nadie en la cola (literal de la normativa).

## 4. Lo que esta propuesta deja explícitamente abierto

- **"Si persiste el conflicto se deberá consultar a tutoría"** — proceso
  de escalado, no una regla que un validador de datos pueda comprobar.
  Mismo criterio que ya usa `spec.md` para la comunicación trimestral a
  tutoría o el envío del cuadrante a Raquel: fuera del núcleo puro.
- **Severidad si nadie de la lista queda elegible** (los dos vecinos de
  fecha cubiertos por otros, o lista agotada): no decidido aquí. Dado el
  criterio ya fijado en V-14 (nada bloquea salvo lo imposible/ilegal),
  probablemente `aviso`, pero es una decisión de quien lo implemente,
  no algo que este documento cierre.
- **Si "el que crea la incidencia" puede ser el mismo grupo Pequeño
  cubriendo una incidencia de Mayores o viceversa** cuando su propia
  lista está agotada: la normativa dice "lista del grupo **del que**
  crea la incidencia", lectura literal = no cruza grupos. No se propone
  cambiar esa lectura aquí.

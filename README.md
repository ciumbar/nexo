# Nexo Agency CEO Leads

Este actor ya **no busca pymes locales genéricas**.
Ahora está enfocado en el target correcto:

- **agencias**
- **España**
- foco en **CEO / founder / director general**
- prioridad para agencias con **15+ personas** o señales fuertes de equipo mediano

## Qué hace

1. Busca agencias por ciudad y especialidad en Bing HTML.
2. Filtra directorios y listados tipo Sortlist/Clutch.
3. Visita solo pocas páginas por dominio para gastar poco.
4. Analiza páginas como:
   - inicio
   - nosotros
   - equipo
   - contacto
   - portfolio / casos
5. Extrae:
   - nombre de la agencia
   - ciudad
   - emails
   - teléfonos
   - decisores visibles (CEO/founder/director)
   - tamaño de equipo declarado
   - evidencia de página de equipo
   - señales de contratación
   - señales de stack comercial
6. Puntúa y devuelve solo leads que superan el umbral.

## Qué entiende como lead bueno

Sube score si detecta:

- agencia real, no directorio
- email o teléfono público
- decisor visible en la web
- texto tipo `somos 20 personas`, `equipo de 18`, `more than 25 people`
- página de equipo con muchos perfiles
- señales de crecimiento (`careers`, `vacantes`, `join our team`)
- portfolio / casos / clientes

Baja score si detecta:

- freelance
- autónomo
- microestudio muy pequeño
- directorio/agregador
- listados de terceros

## Output

Cada lead devuelve, entre otros:

- `businessName`
- `agencyType`
- `city`
- `website`
- `emails`
- `phones`
- `decisionMakers`
- `teamSizeExact`
- `teamPageCount`
- `hasHiringSignals`
- `hasCaseStudies`
- `platformSignals`
- `score`
- `priority`
- `reasons`
- `missingData`
- `recommendedPitch`

## Input recomendado

```json
{
  "cities": ["Madrid", "Barcelona", "Valencia", "Bilbao", "Sevilla"],
  "agencyTypes": [
    "agencia marketing digital",
    "agencia publicidad",
    "agencia creativa",
    "agencia seo",
    "agencia branding",
    "agencia diseño web"
  ],
  "maxLeads": 150,
  "maxDomainsPerQuery": 10,
  "maxPagesPerDomain": 4,
  "minScore": 52,
  "saveCsv": true
}
```

## Cómo usarlo bien

- para una primera corrida, usa 4 o 5 ciudades y 5 o 6 tipos de agencia
- si quieres más precisión, sube `minScore` a `60`
- si quieres más volumen, baja `minScore` a `45`
- si quieres controlar gasto, no subas `maxPagesPerDomain` por encima de `4`

## Limitaciones honestas

- no todas las agencias publican tamaño de equipo
- muchas esconden el CEO si la web es muy corporativa
- LinkedIn no se usa aquí, así que la confirmación de headcount es heurística web-first
- algunas agencias grandes pueden entrar como `B` o `C` si su web es mala, que también tiene su gracia

## Próxima mejora recomendada

Versión 2:

- enriquecimiento con LinkedIn / Apollo / Crunchbase / Clearbit si tienes fuente externa
- detección mejor de decisores por schema.org + páginas de team
- scoring por intención comercial y madurez operativa

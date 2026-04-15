# Nexo Qualified Local Leads

Actor de Apify pensado para **encontrar pymes locales con alto encaje** para vender:

- chatbots de atención 24/7
- automatizaciones operativas
- recepcionista IA

Está diseñado para gastar poco: **descubre dominios con Bing HTML + analiza solo unas pocas páginas por web**. Nada de navegar medio internet como pollo sin GPS.

## Qué hace

1. Genera búsquedas por sector + ciudad.
2. Descubre webs de negocio en resultados orgánicos.
3. Filtra directorios, agregadores y redes sociales.
4. Rastrea homepage + contacto + servicios.
5. Extrae email, teléfono, WhatsApp, formularios, booking, chat, CMS, señales locales.
6. Puntúa cada lead con un score de intención/encaje.
7. Guarda dataset y opcionalmente un CSV en el Key-Value Store.

## Por qué encaja con NexaIA

Analizando `nexaia.es`, el foco comercial más claro está en:

- pequeños negocios en España
- sectores con atención repetitiva y mucha consulta entrante
- necesidades de chatbot, automatización y recepcionista IA

La web menciona explícitamente restaurantes, clínicas dentales y barberías, y sus servicios centrales son chatbots, automatizaciones y recepcionistas IA.

## Nichos que el actor prioriza mejor

### Muy fuertes
- clínica dental
- clínica estética
- fisioterapia
- veterinaria
- inmobiliaria

### Buenos y escalables
- barbería / peluquería
- restaurante
- hotel pequeño / alojamiento
- academia
- taller

## Cómo decide si un lead es bueno

Sube score cuando detecta señales como:

- negocio local con ciudad/provincia clara
- formularios de contacto
- teléfono o WhatsApp público
- sector muy dependiente de citas, reservas o preguntas repetidas
- sin chatbot actual
- sin booking online claro
- sin automatización visible
- web simple o WordPress
- múltiples llamadas a contactar por WhatsApp/teléfono

Baja score cuando detecta:

- marketplace/directorio
- ecommerce puro sin componente local
- gran corporación
- agencia de marketing / software / competencia directa

## Estructura de salida

Cada item del dataset incluye:

- `businessName`
- `sector`
- `city`
- `website`
- `emails`
- `phones`
- `hasWhatsapp`
- `hasChatWidget`
- `hasBooking`
- `hasContactForm`
- `platformSignals`
- `score`
- `priority`
- `reasons`
- `recommendedPitch`
- `missingOpportunities`

## Input recomendado

```json
{
  "cities": ["Madrid", "Barcelona", "Valencia", "Sevilla", "Málaga"],
  "sectors": [
    "clínica dental",
    "clínica estética",
    "fisioterapia",
    "veterinaria",
    "barbería",
    "peluquería",
    "restaurante",
    "inmobiliaria"
  ],
  "maxLeads": 200,
  "maxDomainsPerQuery": 15,
  "maxPagesPerDomain": 3,
  "minScore": 55,
  "includeDirectories": false,
  "saveCsv": true
}
```

## Consejos para gastar poco

- Empieza con 3–5 ciudades y 4 nichos.
- Mantén `maxPagesPerDomain` en 2 o 3.
- Usa proxy solo cuando escales.
- Ataca nichos donde la demo sea obvia: dental, estética, fisio, veterinaria e inmobiliaria.
- Filtra por `minScore >= 60` para el primer outreach.

## Pitch sugerido por nicho

- **Dental / estética / fisio / veterinaria**: recepcionista IA para citas, WhatsApp, preguntas frecuentes y no perder leads fuera de horario.
- **Barbería / peluquería**: respuesta automática, agenda y recuperación de clientes.
- **Restauración**: reservas, menús, horarios, eventos y WhatsApp.
- **Inmobiliaria**: captación de leads, precalificación y seguimiento automático.

## Limitaciones honestas

- No sustituye Google Maps scraping profundo.
- La calidad depende del HTML público del sitio.
- Algunos negocios esconden contacto detrás de JS o iframes.
- Bing puede limitar volumen si no usas proxy.

## Siguiente iteración recomendada

Versión 2:

- enriquecimiento con GBP / mapas
- scoring por intención comercial histórica
- detección de WhatsApp Business API / widgets más precisa
- export a Sheets / HubSpot / Airtable

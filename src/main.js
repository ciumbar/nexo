import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, KeyValueStore, RequestQueue } from 'crawlee';
import { stringify } from 'csv-stringify/sync';

const DEFAULT_INPUT = {
    cities: ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Málaga'],
    sectors: [
        'clínica dental',
        'clínica estética',
        'fisioterapia',
        'veterinaria',
        'barbería',
        'peluquería',
        'restaurante',
        'inmobiliaria',
    ],
    country: 'España',
    maxLeads: 200,
    maxDomainsPerQuery: 15,
    maxPagesPerDomain: 3,
    minScore: 55,
    includeDirectories: false,
    saveCsv: true,
    searchEngine: 'bing',
    customQueries: [],
};

const BLOCKED_HOSTS = [
    'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com',
    'tripadvisor.', 'justeat.', 'glovoapp.', 'ubereats.', 'thefork.', 'idealista.com', 'fotocasa.',
    'google.com', 'google.es', 'bing.com', 'yelp.', 'pagesjaunes.', 'paginegialle.', 'wikipedia.org',
    'reddit.com', 'cronoshare.com', 'trustpilot.com', 'pinterest.', 'milanuncios.com', 'wallapop.com',
];

const DIRECTORY_HOST_HINTS = [
    'páginas amarillas', 'paginas amarillas', 'qdq', 'axesor', 'empresite', 'informa', 'cylex', 'yalwa',
    'infobel', 'hotfrog', 'vulka', 'opendi', 'guía', 'guia', 'directorio', 'directory', 'listing',
];

const SECTOR_PATTERNS = {
    'clínica dental': [/dent/i, /odont/i, /implante/i, /ortodon/i],
    'clínica estética': [/est[ée]tica/i, /medicina est[ée]tica/i, /depil/i, /botox/i],
    'fisioterapia': [/fisio/i, /rehabil/i, /osteopat/i],
    'veterinaria': [/veterin/i, /mascota/i, /animal/i],
    'barbería': [/barber/i, /barba/i],
    'peluquería': [/peluquer/i, /cabello/i, /capilar/i],
    'restaurante': [/restaurante/i, /carta/i, /reserv/i, /men[uú]/i],
    'inmobiliaria': [/inmobiliaria/i, /pisos/i, /vivienda/i, /alquiler/i, /venta/i],
    'hotel': [/hotel/i, /habitaciones/i, /booking/i, /reserv/i],
    'academia': [/academia/i, /cursos/i, /formaci[oó]n/i, /clases/i],
    'taller': [/taller/i, /mec[aá]nic/i, /revisi[oó]n/i, /veh[ií]culo/i],
};

const HIGH_FIT_SECTORS = new Set([
    'clínica dental', 'clínica estética', 'fisioterapia', 'veterinaria', 'inmobiliaria',
]);

await Actor.init();

const input = { ...DEFAULT_INPUT, ...(await Actor.getInput() ?? {}) };
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const requestQueue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await KeyValueStore.open();

const domainState = new Map();
const finalLeads = [];

function cleanText(value = '') {
    return value.replace(/\s+/g, ' ').trim();
}

function unique(arr = []) {
    return [...new Set(arr.filter(Boolean))];
}

function normalizeUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        url.hash = '';
        if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
        return url.toString();
    } catch {
        return null;
    }
}

function getHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

function isBlockedHost(host) {
    return BLOCKED_HOSTS.some((blocked) => host.includes(blocked));
}

function looksLikeDirectory(host, text) {
    const haystack = `${host} ${text}`.toLowerCase();
    return DIRECTORY_HOST_HINTS.some((hint) => haystack.includes(hint));
}

function extractEmails(text) {
    return unique((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((v) => v.toLowerCase()));
}

function extractPhones(text) {
    const matches = text.match(/(?:\+34|0034|34)?[\s.-]?(?:\(?\d{2,3}\)?[\s.-]?)?(?:\d[\s.-]?){8,12}/g) ?? [];
    return unique(matches.map((m) => cleanText(m)).filter((m) => m.replace(/\D/g, '').length >= 9 && m.replace(/\D/g, '').length <= 13));
}

function detectPlatformSignals(html, text) {
    const signals = [];
    const hay = `${html}\n${text}`.toLowerCase();
    if (hay.includes('wp-content') || hay.includes('wordpress')) signals.push('wordpress');
    if (hay.includes('elementor')) signals.push('elementor');
    if (hay.includes('woocommerce')) signals.push('woocommerce');
    if (hay.includes('shopify')) signals.push('shopify');
    if (hay.includes('wix.com') || hay.includes('wix-image')) signals.push('wix');
    if (hay.includes('webflow')) signals.push('webflow');
    if (hay.includes('calendly')) signals.push('calendly');
    if (hay.includes('treatwell')) signals.push('treatwell');
    if (hay.includes('booksy')) signals.push('booksy');
    return unique(signals);
}

function buildSearchQueries() {
    const queries = [];
    for (const sector of input.sectors) {
        for (const city of input.cities) {
            queries.push(`${sector} ${city} ${input.country} sitio web`);
            queries.push(`${sector} ${city} contacto`);
            queries.push(`${sector} ${city} whatsapp`);
        }
    }
    for (const customQuery of input.customQueries) queries.push(customQuery);
    return unique(queries);
}

function buildBingUrl(query) {
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=es-ES`;
}

function detectSector(text, fallbackSector) {
    const hay = text.toLowerCase();
    for (const [sector, patterns] of Object.entries(SECTOR_PATTERNS)) {
        if (patterns.some((regex) => regex.test(hay))) return sector;
    }
    return fallbackSector || 'desconocido';
}

function recommendedPitch(sector, flags) {
    if (['clínica dental', 'clínica estética', 'fisioterapia', 'veterinaria'].includes(sector)) {
        return 'Recepcionista IA para citas, preguntas frecuentes, WhatsApp y captación fuera de horario.';
    }
    if (['barbería', 'peluquería'].includes(sector)) {
        return 'Bot de WhatsApp + agenda + reactivación automática de clientes.';
    }
    if (sector === 'restaurante') {
        return 'Chatbot para reservas, horarios, menús, eventos y atención por WhatsApp.';
    }
    if (sector === 'inmobiliaria') {
        return 'Asistente IA para filtrar leads, responder portales y automatizar seguimiento.';
    }
    if (flags.hasBooking) {
        return 'Automatización alrededor de reservas, recordatorios y no-shows.';
    }
    return 'Chatbot + automatización comercial para captación, respuesta inmediata y ahorro operativo.';
}

function scoreLead(state) {
    let score = 0;
    const reasons = [];
    const missingOpportunities = [];

    if (HIGH_FIT_SECTORS.has(state.sector)) {
        score += 24;
        reasons.push(`Sector prioritario para Noxo IA Empresas: ${state.sector}`);
    } else if (state.sector !== 'desconocido') {
        score += 15;
        reasons.push(`Sector compatible: ${state.sector}`);
    }

    if (state.city) {
        score += 8;
        reasons.push(`Negocio local identificado en ${state.city}`);
    }

    if (state.phones.length) {
        score += 10;
        reasons.push('Teléfono público detectado');
    }

    if (state.emails.length) {
        score += 8;
        reasons.push('Email público detectado');
    }

    if (state.hasContactForm) {
        score += 6;
        reasons.push('Formulario de contacto detectado');
    }

    if (state.hasWhatsapp) {
        score += 4;
        reasons.push('Usa WhatsApp en captación');
    } else {
        score += 8;
        reasons.push('No se detecta WhatsApp visible');
        missingOpportunities.push('Atención por WhatsApp');
    }

    if (state.hasChatWidget) {
        score -= 6;
        reasons.push('Ya tiene chat/widget visible');
    } else {
        score += 10;
        reasons.push('No se detecta chatbot actual');
        missingOpportunities.push('Chatbot web');
    }

    if (state.hasBooking) {
        score += 3;
        reasons.push('Tiene reservas/citas online que se pueden automatizar');
    } else if (['clínica dental', 'clínica estética', 'fisioterapia', 'veterinaria', 'barbería', 'peluquería', 'restaurante'].includes(state.sector)) {
        score += 10;
        reasons.push('No se detecta motor de reserva/cita visible');
        missingOpportunities.push('Reservas o citas automáticas');
    }

    if (state.platformSignals.includes('wordpress') || state.platformSignals.includes('elementor')) {
        score += 6;
        reasons.push('Stack fácil de integrar (WordPress/Elementor)');
    }

    if (state.pagesVisited <= 2) {
        score += 2;
    }

    if (looksLikeDirectory(state.host, `${state.title} ${state.description}`)) {
        score -= 50;
        reasons.push('Parece directorio, no negocio final');
    }

    if (/agencia|marketing|software|consultor/i.test(`${state.title} ${state.textBlob}`)) {
        score -= 18;
        reasons.push('Probable competencia o negocio no objetivo');
    }

    if (/tienda online|ecommerce|shop/i.test(state.textBlob) && state.sector === 'desconocido') {
        score -= 10;
        reasons.push('Parece ecommerce genérico');
    }

    const priority = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';

    return {
        score: Math.max(0, Math.min(100, score)),
        priority,
        reasons: unique(reasons),
        missingOpportunities: unique(missingOpportunities),
    };
}

function inferBusinessName($, url) {
    const candidates = [
        cleanText($('meta[property="og:site_name"]').attr('content') || ''),
        cleanText($('title').first().text() || ''),
        cleanText($('h1').first().text() || ''),
    ].filter(Boolean);

    if (candidates.length) return candidates[0].split('|')[0].split('-')[0].trim();
    return getHost(url).split('.')[0];
}

function inferCity(text, cities) {
    const hay = text.toLowerCase();
    return cities.find((city) => hay.includes(city.toLowerCase())) || null;
}

for (const query of buildSearchQueries()) {
    await requestQueue.addRequest({
        url: buildBingUrl(query),
        userData: { label: 'SEARCH', query },
        uniqueKey: `search:${query}`,
    });
}

const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency: 8,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 2,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 30 },
    preNavigationHooks: [
        async ({ request, session }) => {
            log.debug(`Fetching ${request.url} with session ${session.id}`);
        },
    ],
    async requestHandler({ request, $, body, crawler }) {
        const { label } = request.userData;

        if (label === 'SEARCH') {
            const query = request.userData.query;
            const seenHosts = new Set();
            $('li.b_algo').each((index, el) => {
                if (index >= input.maxDomainsPerQuery) return;
                const href = $(el).find('h2 a').attr('href');
                const title = cleanText($(el).find('h2').text());
                const desc = cleanText($(el).find('.b_caption p').text());
                const normalized = normalizeUrl(href);
                if (!normalized) return;
                const host = getHost(normalized);
                if (!host || isBlockedHost(host)) return;
                if (!input.includeDirectories && looksLikeDirectory(host, `${title} ${desc}`)) return;
                if (seenHosts.has(host)) return;
                seenHosts.add(host);

                domainState.set(host, {
                    host,
                    seedQuery: query,
                    sourceSearchTitle: title,
                    sourceSearchDescription: desc,
                    website: `https://${host}`,
                    pagesVisited: 0,
                    urlsVisited: [],
                    emails: [],
                    phones: [],
                    hasWhatsapp: false,
                    hasChatWidget: false,
                    hasBooking: false,
                    hasContactForm: false,
                    platformSignals: [],
                    title: title,
                    description: desc,
                    businessName: null,
                    city: null,
                    sectorHint: input.sectors.find((s) => query.toLowerCase().includes(s.toLowerCase())) || null,
                    sector: null,
                    textBlob: '',
                    contactPages: [],
                });

                crawler.addRequests([
                    {
                        url: normalized,
                        userData: { label: 'SITE', host, pageType: 'home' },
                        uniqueKey: `site:${host}:${normalized}`,
                    },
                ]);
            });
            return;
        }

        if (label === 'SITE') {
            const host = request.userData.host;
            const state = domainState.get(host);
            if (!state) return;
            if (state.pagesVisited >= input.maxPagesPerDomain) return;

            const html = typeof body === 'string' ? body : body.toString('utf8');
            const text = cleanText($('body').text());
            const pageUrl = request.loadedUrl || request.url;

            state.pagesVisited += 1;
            state.urlsVisited.push(pageUrl);
            state.businessName ??= inferBusinessName($, pageUrl);
            state.city ??= inferCity(text, input.cities);
            state.sector ??= detectSector(`${state.title} ${state.description} ${text}`, state.sectorHint);
            state.emails = unique([...state.emails, ...extractEmails(html), ...extractEmails(text)]);
            state.phones = unique([...state.phones, ...extractPhones(text)]);
            state.platformSignals = unique([...state.platformSignals, ...detectPlatformSignals(html, text)]);
            state.textBlob = cleanText(`${state.textBlob} ${text}`).slice(0, 25000);
            state.hasWhatsapp ||= /wa\.me|api\.whatsapp\.com|whatsapp/i.test(html);
            state.hasChatWidget ||= /tidio|smartsupp|intercom|drift|hubspot.*chat|tawk|livechat|zendesk/i.test(html);
            state.hasBooking ||= /booksy|treatwell|calendly|booking|reservas|reserva ahora|cita online|book now/i.test(text + html);
            state.hasContactForm ||= $('form').length > 0;
            if (/contacto|contact|ubicaci[oó]n|aviso legal|pol[ií]tica de privacidad|empresa/i.test(pageUrl)) {
                state.contactPages.push(pageUrl);
            }

            if (state.pagesVisited < input.maxPagesPerDomain) {
                const candidateLinks = new Set();
                $('a[href]').each((_, a) => {
                    const href = $(a).attr('href');
                    const anchor = cleanText($(a).text());
                    if (!href) return;
                    try {
                        const abs = new URL(href, pageUrl).toString();
                        const absHost = getHost(abs);
                        if (absHost !== host) return;
                        if (!/contact|contacto|servicios|faq|reserv|cita|about|nosotros|equipo|clinic|menu|carta|tratamiento/i.test(`${abs} ${anchor}`)) return;
                        if (state.urlsVisited.includes(abs)) return;
                        candidateLinks.add(abs);
                    } catch {
                    }
                });

                let added = 0;
                for (const url of candidateLinks) {
                    if (added >= input.maxPagesPerDomain - state.pagesVisited) break;
                    await requestQueue.addRequest({
                        url,
                        userData: { label: 'SITE', host, pageType: 'detail' },
                        uniqueKey: `site:${host}:${url}`,
                    });
                    added += 1;
                }
            }

            const scoreData = scoreLead(state);
            const result = {
                businessName: state.businessName,
                sector: state.sector,
                city: state.city,
                website: state.website,
                host: state.host,
                sourceQuery: state.seedQuery,
                emails: state.emails,
                phones: state.phones,
                hasWhatsapp: state.hasWhatsapp,
                hasChatWidget: state.hasChatWidget,
                hasBooking: state.hasBooking,
                hasContactForm: state.hasContactForm,
                platformSignals: state.platformSignals,
                pagesVisited: state.pagesVisited,
                pages: state.urlsVisited,
                contactPages: state.contactPages,
                score: scoreData.score,
                priority: scoreData.priority,
                reasons: scoreData.reasons,
                missingOpportunities: scoreData.missingOpportunities,
                recommendedPitch: recommendedPitch(state.sector, state),
                scrapedAt: new Date().toISOString(),
            };

            domainState.set(host, { ...state, ...result });
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed ${request.url}: ${error.message}`);
    },
});

await crawler.run();

for (const lead of domainState.values()) {
    if (!lead.businessName || !lead.website) continue;
    if (lead.score < input.minScore) continue;
    finalLeads.push({
        businessName: lead.businessName,
        sector: lead.sector,
        city: lead.city,
        website: lead.website,
        host: lead.host,
        sourceQuery: lead.sourceQuery,
        emails: lead.emails,
        phones: lead.phones,
        hasWhatsapp: lead.hasWhatsapp,
        hasChatWidget: lead.hasChatWidget,
        hasBooking: lead.hasBooking,
        hasContactForm: lead.hasContactForm,
        platformSignals: lead.platformSignals,
        pagesVisited: lead.pagesVisited,
        pages: lead.pages,
        contactPages: lead.contactPages,
        score: lead.score,
        priority: lead.priority,
        reasons: lead.reasons,
        missingOpportunities: lead.missingOpportunities,
        recommendedPitch: lead.recommendedPitch,
        scrapedAt: lead.scrapedAt,
    });
}

const sortedLeads = finalLeads.sort((a, b) => b.score - a.score).slice(0, input.maxLeads);
if (sortedLeads.length) await dataset.pushData(sortedLeads);

if (input.saveCsv && sortedLeads.length) {
    const csv = stringify(sortedLeads.map((lead) => ({
        ...lead,
        emails: lead.emails.join(' | '),
        phones: lead.phones.join(' | '),
        platformSignals: lead.platformSignals.join(' | '),
        reasons: lead.reasons.join(' | '),
        missingOpportunities: lead.missingOpportunities.join(' | '),
        pages: lead.pages.join(' | '),
        contactPages: lead.contactPages.join(' | '),
    })), { header: true });
    await kv.setValue('QUALIFIED_LEADS.csv', csv, { contentType: 'text/csv' });
}

await Actor.setValue('SUMMARY', {
    totalQualified: sortedLeads.length,
    topPriority: sortedLeads.filter((l) => l.priority === 'A').length,
    avgScore: sortedLeads.length ? Math.round(sortedLeads.reduce((acc, item) => acc + item.score, 0) / sortedLeads.length) : 0,
    bestSectors: Object.entries(sortedLeads.reduce((acc, item) => {
        acc[item.sector] = (acc[item.sector] || 0) + 1;
        return acc;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
});

log.info(`Qualified leads: ${sortedLeads.length}`);
await Actor.exit();

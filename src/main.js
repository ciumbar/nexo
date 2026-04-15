import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, KeyValueStore, RequestQueue } from 'crawlee';
import { stringify } from 'csv-stringify/sync';

const DEFAULT_INPUT = {
    cities: ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Málaga', 'Bilbao'],
    country: 'España',
    agencyTypes: [
        'agencia marketing',
        'agencia marketing digital',
        'agencia publicidad',
        'agencia creativa',
        'agencia seo',
        'agencia branding',
        'agencia diseño web',
        'agencia social media',
        'agencia performance',
    ],
    customQueries: [],
    maxLeads: 200,
    maxDomainsPerQuery: 12,
    maxPagesPerDomain: 4,
    minScore: 52,
    includeDirectories: false,
    saveCsv: true,
};

const BLOCKED_HOSTS = [
    'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com',
    'google.com', 'google.es', 'bing.com', 'wikipedia.org', 'reddit.com', 'pinterest.', 'trustpilot.com',
];

const DIRECTORY_HOST_HINTS = [
    'sortlist', 'clutch', 'designrush', 'semrush', 'goodfirms', 'manifest', 'yelp', 'qdq',
    'páginas amarillas', 'paginas amarillas', 'guía', 'guia', 'directory', 'directorio', 'listing',
];

await Actor.init();

const input = { ...DEFAULT_INPUT, ...(await Actor.getInput() ?? {}) };
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const requestQueue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await KeyValueStore.open();

const domainState = new Map();

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
    return unique(matches.map((m) => cleanText(m)).filter((m) => {
        const digits = m.replace(/\D/g, '');
        return digits.length >= 9 && digits.length <= 13;
    }));
}

function detectPlatformSignals(html, text) {
    const hay = `${html}\n${text}`.toLowerCase();
    const signals = [];
    if (hay.includes('wp-content') || hay.includes('wordpress')) signals.push('wordpress');
    if (hay.includes('elementor')) signals.push('elementor');
    if (hay.includes('hubspot')) signals.push('hubspot');
    if (hay.includes('calendly')) signals.push('calendly');
    if (hay.includes('salesforce')) signals.push('salesforce');
    if (hay.includes('activecampaign')) signals.push('activecampaign');
    if (hay.includes('mailchimp')) signals.push('mailchimp');
    return unique(signals);
}

function buildSearchQueries() {
    const queries = [];
    for (const agencyType of input.agencyTypes) {
        for (const city of input.cities) {
            queries.push(`${agencyType} ${city} ${input.country}`);
            queries.push(`${agencyType} ${city} equipo`);
            queries.push(`${agencyType} ${city} ceo`);
            queries.push(`${agencyType} ${city} nosotros`);
        }
    }
    for (const customQuery of input.customQueries) queries.push(customQuery);
    return unique(queries);
}

function buildBingUrl(query) {
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=es-ES`;
}

function inferAgencyType(text, fallback = null) {
    const hay = text.toLowerCase();
    if (/seo|sem/i.test(hay)) return 'agencia seo';
    if (/branding|marca/i.test(hay)) return 'agencia branding';
    if (/social media|redes sociales|community manager/i.test(hay)) return 'agencia social media';
    if (/publicidad|ads|ppc|performance/i.test(hay)) return 'agencia performance';
    if (/diseño web|web design|desarrollo web/i.test(hay)) return 'agencia diseño web';
    if (/creativa|creative/i.test(hay)) return 'agencia creativa';
    if (/marketing digital|marketing/i.test(hay)) return 'agencia marketing digital';
    return fallback || 'agencia';
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

function extractTeamSize(text) {
    const compact = text.replace(/\s+/g, ' ');
    const patterns = [
        /\b(?:equipo|team|plantilla|somos)\s+de\s+(\d{1,3})\s+(?:personas|profesionales|empleados|especialistas|talentos)\b/i,
        /\bmás de\s+(\d{1,3})\s+(?:personas|profesionales|empleados|especialistas)\b/i,
        /\bmore than\s+(\d{1,3})\s+(?:people|employees|specialists)\b/i,
        /\b(\d{1,3})\+\s*(?:personas|people|empleados|profesionales)\b/i,
    ];
    for (const regex of patterns) {
        const match = compact.match(regex);
        if (match) return Number(match[1]);
    }
    return null;
}

function countTeamCards($) {
    const selectors = [
        '[class*="team"] [class*="member"]',
        '[class*="equipo"] [class*="item"]',
        '[class*="staff"] [class*="item"]',
        '[class*="team"] article',
        '.team-member',
        '.member',
    ];
    let maxCount = 0;
    for (const selector of selectors) {
        const count = $(selector).length;
        if (count > maxCount) maxCount = count;
    }
    return maxCount;
}

function extractDecisionMakers(text) {
    const compact = text.replace(/\s+/g, ' ');
    const results = [];
    const patterns = [
        /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})\s*[,|\-–]\s*(CEO|Founder|Co-Founder|Managing Director|Director General|Socio Director|Founder & CEO)\b/g,
        /\b(CEO|Founder|Co-Founder|Managing Director|Director General|Socio Director|Founder & CEO)\s*[:\-–]?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})\b/g,
    ];

    for (const regex of patterns) {
        for (const match of compact.matchAll(regex)) {
            const first = cleanText(match[1] || '');
            const second = cleanText(match[2] || '');
            const maybeName = first.split(' ').length >= 2 && !/CEO|Founder|Director|Socio/i.test(first) ? first : second;
            const maybeRole = maybeName === first ? second : first;
            if (maybeName && maybeRole) results.push(`${maybeName} (${maybeRole})`);
        }
    }

    return unique(results).slice(0, 10);
}

function scoreLead(state) {
    let score = 0;
    const reasons = [];
    const missingData = [];

    score += 18;
    reasons.push('Es una agencia, alineada con el target actual');

    if (state.city) {
        score += 6;
        reasons.push(`Ubicación detectada: ${state.city}`);
    }

    if (state.phones.length) {
        score += 8;
        reasons.push('Teléfono público disponible');
    }

    if (state.emails.length) {
        score += 10;
        reasons.push('Email público disponible');
    } else {
        missingData.push('Email directo');
    }

    if (state.hasContactForm) {
        score += 4;
        reasons.push('Formulario de contacto detectado');
    }

    if (state.decisionMakers.length) {
        score += 18;
        reasons.push('Se detectó decisor o liderazgo visible');
    } else {
        missingData.push('CEO/founder identificable');
    }

    if (state.teamSizeExact !== null) {
        if (state.teamSizeExact >= 15) {
            score += 24;
            reasons.push(`Equipo declarado de ${state.teamSizeExact} personas`);
        } else {
            score -= 18;
            reasons.push(`Equipo declarado inferior al umbral (${state.teamSizeExact})`);
        }
    } else if (state.teamPageCount >= 15) {
        score += 20;
        reasons.push(`Página de equipo con al menos ${state.teamPageCount} perfiles/elementos`);
    } else if (state.teamPageCount >= 8) {
        score += 10;
        reasons.push(`Página de equipo relativamente amplia (${state.teamPageCount} elementos)`);
        missingData.push('Confirmar si superan 15 personas');
    } else {
        missingData.push('Tamaño del equipo');
    }

    if (state.hasHiringSignals) {
        score += 8;
        reasons.push('Tiene señales de contratación/crecimiento');
    }

    if (state.hasCaseStudies) {
        score += 6;
        reasons.push('Tiene casos de éxito/portfolio, señal de agencia consolidada');
    }

    if (state.platformSignals.includes('hubspot') || state.platformSignals.includes('salesforce')) {
        score += 4;
        reasons.push('Usa stack comercial/CRM visible');
    }

    if (looksLikeDirectory(state.host, `${state.title} ${state.description}`)) {
        score -= 50;
        reasons.push('Parece directorio, no agencia final');
    }

    if (/freelance|autónomo|solopreneur/i.test(state.textBlob)) {
        score -= 22;
        reasons.push('Parece perfil individual o micro negocio');
    }

    const scoreClamped = Math.max(0, Math.min(100, score));
    const priority = scoreClamped >= 80 ? 'A' : scoreClamped >= 65 ? 'B' : scoreClamped >= 50 ? 'C' : 'D';

    return {
        score: scoreClamped,
        priority,
        reasons: unique(reasons),
        missingData: unique(missingData),
    };
}

function recommendedPitch(state) {
    if ((state.teamSizeExact ?? 0) >= 15 || state.teamPageCount >= 15) {
        return 'Automatización interna para agencias medianas: cualificación de leads, seguimiento comercial, reporting y asistente operativo para account/project managers.';
    }
    return 'Propuesta enfocada en automatizar captación, follow-up comercial y operaciones internas de agencia.';
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

                if (!domainState.has(host)) {
                    domainState.set(host, {
                        host,
                        website: `https://${host}`,
                        seedQueries: [],
                        pagesVisited: 0,
                        urlsVisited: [],
                        emails: [],
                        phones: [],
                        platformSignals: [],
                        title,
                        description: desc,
                        businessName: null,
                        city: null,
                        agencyTypeHint: input.agencyTypes.find((s) => query.toLowerCase().includes(s.toLowerCase())) || null,
                        agencyType: null,
                        textBlob: '',
                        hasContactForm: false,
                        hasHiringSignals: false,
                        hasCaseStudies: false,
                        teamSizeExact: null,
                        teamPageCount: 0,
                        decisionMakers: [],
                    });
                }

                const state = domainState.get(host);
                state.seedQueries = unique([...state.seedQueries, query]);

                crawler.addRequests([{
                    url: normalized,
                    userData: { label: 'SITE', host, pageType: 'home' },
                    uniqueKey: `site:${host}:${normalized}`,
                }]);
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
            state.agencyType ??= inferAgencyType(`${state.title} ${state.description} ${text}`, state.agencyTypeHint);
            state.emails = unique([...state.emails, ...extractEmails(html), ...extractEmails(text)]);
            state.phones = unique([...state.phones, ...extractPhones(text)]);
            state.platformSignals = unique([...state.platformSignals, ...detectPlatformSignals(html, text)]);
            state.textBlob = cleanText(`${state.textBlob} ${text}`).slice(0, 30000);
            state.hasContactForm ||= $('form').length > 0;
            state.hasHiringSignals ||= /trabaja con nosotros|join our team|we are hiring|vacantes|empleo|careers/i.test(text);
            state.hasCaseStudies ||= /casos de éxito|case stud|portfolio|clientes|proyectos/i.test(text);

            const detectedTeamSize = extractTeamSize(text);
            if (detectedTeamSize && (!state.teamSizeExact || detectedTeamSize > state.teamSizeExact)) {
                state.teamSizeExact = detectedTeamSize;
            }

            const teamCards = countTeamCards($);
            if (teamCards > state.teamPageCount) state.teamPageCount = teamCards;

            state.decisionMakers = unique([...state.decisionMakers, ...extractDecisionMakers(text)]);

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
                        if (state.urlsVisited.includes(abs)) return;

                        const navText = `${abs} ${anchor}`;
                        if (!/contact|contacto|about|nosotros|equipo|team|people|agencia|portfolio|clientes|casos|case|work|hiring|careers|empleo/i.test(navText)) return;

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
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed ${request.url}: ${error.message}`);
    },
});

await crawler.run();

const finalLeads = [];

for (const lead of domainState.values()) {
    if (!lead.businessName || !lead.website) continue;

    const scoreData = scoreLead(lead);
    if (scoreData.score < input.minScore) continue;

    finalLeads.push({
        businessName: lead.businessName,
        agencyType: lead.agencyType,
        city: lead.city,
        website: lead.website,
        host: lead.host,
        sourceQueries: lead.seedQueries,
        emails: lead.emails,
        phones: lead.phones,
        hasContactForm: lead.hasContactForm,
        hasHiringSignals: lead.hasHiringSignals,
        hasCaseStudies: lead.hasCaseStudies,
        platformSignals: lead.platformSignals,
        teamSizeExact: lead.teamSizeExact,
        teamPageCount: lead.teamPageCount,
        decisionMakers: lead.decisionMakers,
        pagesVisited: lead.pagesVisited,
        pages: lead.urlsVisited,
        score: scoreData.score,
        priority: scoreData.priority,
        reasons: scoreData.reasons,
        missingData: scoreData.missingData,
        recommendedPitch: recommendedPitch(lead),
        scrapedAt: new Date().toISOString(),
    });
}

const sortedLeads = finalLeads.sort((a, b) => b.score - a.score).slice(0, input.maxLeads);

if (sortedLeads.length) await dataset.pushData(sortedLeads);

if (input.saveCsv && sortedLeads.length) {
    const csv = stringify(sortedLeads.map((lead) => ({
        ...lead,
        sourceQueries: lead.sourceQueries.join(' | '),
        emails: lead.emails.join(' | '),
        phones: lead.phones.join(' | '),
        platformSignals: lead.platformSignals.join(' | '),
        decisionMakers: lead.decisionMakers.join(' | '),
        reasons: lead.reasons.join(' | '),
        missingData: lead.missingData.join(' | '),
        pages: lead.pages.join(' | '),
    })), { header: true });
    await kv.setValue('QUALIFIED_LEADS.csv', csv, { contentType: 'text/csv' });
}

await Actor.setValue('SUMMARY', {
    target: 'CEO/founders de agencias con 15+ personas',
    totalQualified: sortedLeads.length,
    topPriority: sortedLeads.filter((l) => l.priority === 'A').length,
    withDecisionMaker: sortedLeads.filter((l) => l.decisionMakers.length > 0).length,
    withTeam15PlusEvidence: sortedLeads.filter((l) => (l.teamSizeExact ?? 0) >= 15 || l.teamPageCount >= 15).length,
});

log.info(`Qualified agency leads: ${sortedLeads.length}`);
await Actor.exit();

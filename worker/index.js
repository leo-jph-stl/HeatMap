// Cloudflare Worker: echte, backend-durchgesetzte Zugriffskontrolle für die privaten
// PV-Anlagendaten von HeatMap. Alles, was hier nicht ausdrücklich freigegeben wird
// (siehe PRIVATE_KEYS), bleibt hinter einem gültigen Bearer-Token verborgen - die
// Prüfung passiert serverseitig bei jedem Request, nicht im Browser-JS der Seite.
//
// Auth-Design: signiertes Bearer-Token statt Cookie, weil Pages-Domain und
// Worker-Domain unterschiedliche Origins sind (Cross-Origin-Cookies bräuchten
// SameSite=None + credentialed CORS - unnötig komplex für einen einzelnen
// Admin-Zugang). Das Token ist trotzdem "echt": der Worker prüft die HMAC-Signatur
// und das Ablaufdatum bei jedem Request serverseitig, egal was der Client behauptet.

const PRIVATE_KEYS = new Set([
    'pv_data',
    'zun_pv_data',
    'pv_forecast_log',
    'pv_daily_history',
    'zun_daily_history',
    'pv_calibration_history',
    'pv_calibration_report',
    'forecast_solar_log',
]);

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

function base64urlEncode(bytes) {
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function hmacKey(secret) {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
    );
}

async function signToken(payloadObj, secret) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    const key = await hmacKey(secret);
    const sig = await crypto.subtle.sign('HMAC', key, payloadBytes);
    return `${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
}

async function verifyToken(token, secret) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const [payloadPart, sigPart] = token.split('.');
    if (!payloadPart || !sigPart) return false;
    let payloadBytes, sigBytes;
    try {
        payloadBytes = base64urlDecode(payloadPart);
        sigBytes = base64urlDecode(sigPart);
    } catch {
        return false;
    }
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
    if (!valid) return false;
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
        return false;
    }
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
}

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const headers = { Vary: 'Origin' };
    if (allowed.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
    }
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    return headers;
}

function json(data, status, extraHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}

function getBearerToken(request) {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1] : null;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const cors = corsHeaders(request, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        if (url.pathname === '/api/login' && request.method === 'POST') {
            let body;
            try {
                body = await request.json();
            } catch {
                return json({ error: 'invalid_body' }, 400, cors);
            }
            if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
                return json({ error: 'invalid_credentials' }, 401, cors);
            }
            const token = await signToken({ exp: Date.now() + TOKEN_TTL_MS }, env.SESSION_SECRET);
            return json({ token }, 200, cors);
        }

        if (url.pathname === '/api/session' && request.method === 'GET') {
            const token = getBearerToken(request);
            const authenticated = await verifyToken(token, env.SESSION_SECRET);
            return json({ authenticated }, 200, cors);
        }

        if (url.pathname.startsWith('/api/private/') && request.method === 'GET') {
            const token = getBearerToken(request);
            const authenticated = await verifyToken(token, env.SESSION_SECRET);
            if (!authenticated) {
                return json({ error: 'unauthorized' }, 401, cors);
            }
            const key = url.pathname.slice('/api/private/'.length);
            if (!PRIVATE_KEYS.has(key)) {
                return json({ error: 'not_found' }, 404, cors);
            }
            const value = await env.PV_KV.get(key);
            if (value === null) {
                return json({ error: 'no_data_yet' }, 404, cors);
            }
            return new Response(value, {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...cors },
            });
        }

        return json({ error: 'not_found' }, 404, cors);
    },
};

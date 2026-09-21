// Baut einen ECHTEN Day-Ahead-Prognose-Ledger für die eigene Kalibrierung auf: anders als der
// In-Sample-Fit in pv_calibration_review.js (der die Kalibrierung gegen dieselben Daten prüft, aus
// denen sie berechnet wurde) wird hier VOR dem jeweiligen Zieltag eine echte Vorhersage archiviert -
// genau nach demselben Muster wie fetch_forecast_solar.js für die externe Vergleichsprognose. Erst
// wenn eine hier gespeicherte Prognose mit dem später bekannten Ist-Wert verglichen wird, misst man
// echte Vorhersagegüte statt nur Modellanpassung im Nachhinein.
const fs = require('fs');

const LOG_FILE = 'pv_own_forecast_log.json';
const HISTORY_FILE = 'pv_calibration_history.json';
const SOLAR_DATA_FILE = 'solar_data.js';
const FORECAST_LOG_FILE = 'pv_forecast_log.json';
const PV_LAT = 50.008, PV_LNG = 8.350; // Hochheim am Main (Südstadt), siehe fetch_pv.py
const MAX_AGE_DAYS = 120;
const TZ_OFFSET_MS = 2 * 3600 * 1000; // Europe/Berlin, September = CEST (UTC+2)

// Identisch zu loadSolarData()/getValueAtStep() in log_pv_forecast.js - siehe dort für die
// Begründung, warum solar_data.js direkt geparst statt per require()/vm ausgeführt wird.
function loadSolarData(path) {
    if (!fs.existsSync(path)) return null;
    const text = fs.readFileSync(path, 'utf8');
    // "var" statt "const": siehe log_pv_forecast.js für den Hintergrund (2026-09-16-Fix in
    // fetch_solar_timeline.js hat beide Deklarationen auf var umgestellt).
    const metaMatch = text.match(/(?:const|var) solarMetadata = (\{[\s\S]*?\});/);
    const b64Match = text.match(/(?:const|var) solarB64 = "([^"]+)";/);
    if (!metaMatch || !b64Match) return null;
    const metadata = JSON.parse(metaMatch[1]);
    const buffer = Buffer.from(b64Match[1], 'base64');
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
    const ptsPerStep = metadata.nx * metadata.ny;
    return metadata.steps.map((s, idx) => ({
        timeMs: s.timeMs,
        header: { nx: metadata.nx, ny: metadata.ny, dx: metadata.dx, dy: metadata.dy, la1: metadata.la1, lo1: metadata.lo1 },
        scale: metadata.scale,
        data: int16.subarray(idx * ptsPerStep, (idx + 1) * ptsPerStep)
    }));
}

function getValueAtStep(step, lat, lng) {
    if (!step || !step.data) return null;
    const h = step.header;
    const lon360 = lng < 0 ? lng + 360 : lng;
    let y = (h.la1 - lat) / h.dy;
    let x = lon360 / h.dx;
    let y0 = Math.floor(y), x0 = Math.floor(x);
    let y1 = y0 + 1, x1 = x0 + 1;
    if (y0 < 0) y0 = 0; if (y0 >= h.ny) y0 = h.ny - 1;
    if (y1 < 0) y1 = 0; if (y1 >= h.ny) y1 = h.ny - 1;
    if (x0 < 0) x0 = 0; if (x0 >= h.nx) x0 = h.nx - 1;
    if (x1 < 0) x1 = 0; if (x1 >= h.nx) x1 = h.nx - 1;
    const dy = y - y0, dx = x - x0;
    const scale = h && step.scale ? step.scale : 1.0;
    const d = step.data;
    const i00 = y0 * h.nx + x0, i10 = y0 * h.nx + x1, i01 = y1 * h.nx + x0, i11 = y1 * h.nx + x1;
    return (d[i00] * scale) * (1 - dx) * (1 - dy) + (d[i10] * scale) * dx * (1 - dy)
         + (d[i01] * scale) * (1 - dx) * dy + (d[i11] * scale) * dx * dy;
}

function interpGhiAtTime(solarData, tMs) {
    if (!solarData || !solarData.length) return null;
    if (tMs < solarData[0].timeMs || tMs > solarData[solarData.length - 1].timeMs) return null;
    for (let i = 0; i < solarData.length - 1; i++) {
        const a = solarData[i], b = solarData[i + 1];
        if (tMs >= a.timeMs && tMs <= b.timeMs) {
            const va = Math.max(0, getValueAtStep(a, PV_LAT, PV_LNG));
            const vb = Math.max(0, getValueAtStep(b, PV_LAT, PV_LNG));
            const f = b.timeMs > a.timeMs ? (tMs - a.timeMs) / (b.timeMs - a.timeMs) : 0;
            return va + (vb - va) * f;
        }
    }
    return null;
}

function localDateStr(tMs) {
    return new Date(tMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// Zweite, unabhängige Day-Ahead-Prognose auf Basis von Open-Meteo/ICON statt GFS/THREDDS - siehe
// log_pv_forecast.js für den Hintergrund. Liefert einen Lookup targetDate -> {hour: ghi}.
async function fetchOpenMeteoHourlyByDay() {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${PV_LAT}&longitude=${PV_LNG}&hourly=shortwave_radiation&forecast_days=4&models=icon_seamless&timezone=UTC`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.log(`Open-Meteo-Abruf fehlgeschlagen (HTTP ${res.status}) - überspringe Open-Meteo-Day-Ahead für diesen Lauf.`);
            return new Map();
        }
        const json = await res.json();
        const times = json.hourly && json.hourly.time;
        const values = json.hourly && json.hourly.shortwave_radiation;
        if (!Array.isArray(times) || !Array.isArray(values)) return new Map();
        const byHour = new Map(); // tMs -> ghi
        times.forEach((t, i) => {
            const tMs = Date.parse(t + 'Z');
            if (isNaN(tMs) || typeof values[i] !== 'number') return;
            byHour.set(tMs, values[i]);
        });
        return byHour;
    } catch (e) {
        console.log(`Open-Meteo-Abruf fehlgeschlagen (${e.message}) - überspringe Open-Meteo-Day-Ahead für diesen Lauf.`);
        return new Map();
    }
}

async function run() {
    const solarData = loadSolarData(SOLAR_DATA_FILE);
    if (!solarData) {
        if (!fs.existsSync(SOLAR_DATA_FILE)) {
            console.log('solar_data.js noch nicht vorhanden - überspringe Day-Ahead-Prognose.');
            return;
        }
        // Siehe log_pv_forecast.js für den Hintergrund: Datei da, aber nicht parsebar ist ein
        // echter Bug (Format geändert), kein normaler Zwischenzustand - Workflow-Lauf soll fehlschlagen.
        console.error('FEHLER: solar_data.js existiert, konnte aber nicht geparst werden (Format geändert?). Day-Ahead-Prognose NICHT aktualisiert.');
        process.exitCode = 1;
        return;
    }

    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) {}
    }
    const latest = history.length ? history[history.length - 1] : null;
    if (!latest || typeof latest.medianRatio !== 'number') {
        console.log('Noch kein Kalibrierfaktor vorhanden (pv_calibration_history.json leer) - überspringe Day-Ahead-Prognose.');
        return;
    }
    const medianRatio = latest.medianRatio;

    // Wechselrichter-Kappung wie in pv_calibration_review.js: höchste je geloggte Ist-Leistung + 5%.
    let capKw = Infinity;
    if (fs.existsSync(FORECAST_LOG_FILE)) {
        try {
            const rows = JSON.parse(fs.readFileSync(FORECAST_LOG_FILE, 'utf8'));
            if (rows.length) capKw = Math.max(...rows.map(r => r.pv)) * 1.05;
        } catch (e) {}
    }

    const fetchedAt = Date.now();
    const now = new Date();
    // Nur vollständig in der Zukunft liegende Kalendertage vorhersagen (heute läuft schon,
    // ein Vergleich "Prognose vs. Ist" für einen bereits angebrochenen Tag wäre kein echtes
    // Day-Ahead mehr) - morgen und übermorgen, so weit die GFS-Prognose (+81h) reicht.
    const todayStr = localDateStr(now.getTime());
    const byTargetDay = new Map();
    for (const step of solarData) {
        const day = localDateStr(step.timeMs);
        if (day <= todayStr) continue;
        if (!byTargetDay.has(day)) byTargetDay.set(day, []);
    }

    const openMeteoHourly = await fetchOpenMeteoHourlyByDay();

    const newEntries = [];
    for (const targetDate of byTargetDay.keys()) {
        // Stündlich über den Zieltag integrieren (lineare Interpolation zwischen den 3h-GFS-Stützstellen).
        const dayStartMs = Date.parse(targetDate + 'T00:00:00+02:00');
        let sumKwh = 0;
        let hoursWithData = 0;
        let sumKwhOpenMeteo = 0;
        let hoursWithDataOpenMeteo = 0;
        for (let h = 0; h < 24; h++) {
            const tMs = dayStartMs + h * 3600 * 1000;
            const ghi = interpGhiAtTime(solarData, tMs);
            if (ghi !== null) {
                hoursWithData++;
                sumKwh += Math.min(capKw, Math.max(0, ghi) * medianRatio);
            }
            if (openMeteoHourly.has(tMs)) {
                hoursWithDataOpenMeteo++;
                sumKwhOpenMeteo += Math.min(capKw, Math.max(0, openMeteoHourly.get(tMs)) * medianRatio);
            }
        }
        if (hoursWithData < 20 && hoursWithDataOpenMeteo < 20) continue; // Zieltag liegt zu nah am Rand beider Prognosen
        const entry = { fetchedAt, targetDate, medianRatioUsed: medianRatio };
        if (hoursWithData >= 20) entry.predictedKwh = Math.round(sumKwh * 100) / 100;
        if (hoursWithDataOpenMeteo >= 20) entry.predictedKwhOpenMeteo = Math.round(sumKwhOpenMeteo * 100) / 100;
        newEntries.push(entry);
    }

    if (!newEntries.length) {
        console.log('Keine vollständig abgedeckten zukünftigen Tage in der aktuellen GFS-Prognose gefunden.');
        return;
    }

    let log = [];
    if (fs.existsSync(LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { log = []; }
    }
    log.push(...newEntries);
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
    log = log.filter(e => e.fetchedAt >= cutoff);

    fs.writeFileSync(LOG_FILE, JSON.stringify(log));
    const summary = newEntries.map(e => `${e.targetDate}=${e.predictedKwh ?? '–'}kWh(GFS)/${e.predictedKwhOpenMeteo ?? '–'}kWh(OM)`).join(', ');
    console.log(`Day-Ahead-Prognose: ${newEntries.length} neue Einträge (${summary}). Log gesamt: ${log.length}.`);
}

run().catch(e => {
    console.error('FEHLER:', e);
    process.exitCode = 1;
});

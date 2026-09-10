// Baut über die Zeit ein wachsendes Log aus (Ist-Leistung, GFS-Einstrahlungsprognose)-Paaren auf.
//
// Hintergrund: FoxESS liefert selbst nur 3 Tage Ist-Historie (history_3d in pv_data.json), und
// solar_data.js wird bei jedem Fetch überschrieben statt archiviert - ohne dieses Log gäbe es
// nirgends eine länger als ein paar Tage reichende Grundlage, um die PV-Prognose (siehe
// computePvForecast() in index.html) anlagenspezifisch zu kalibrieren. Läuft bei jedem
// update_pv.yml-Durchlauf (alle 15 Min) mit, hängt neue Stunden-Einträge an statt sie zu
// überschreiben, und verwirft nur Einträge, die älter als MAX_AGE_DAYS sind.
const fs = require('fs');

const LOG_FILE = 'pv_forecast_log.json';
const SOLAR_DATA_FILE = 'solar_data.js';
const PV_LAT = 50.008, PV_LNG = 8.350; // Hochheim am Main (Südstadt), siehe fetch_pv.py
const MAX_AGE_DAYS = 120;
const BUCKET_MS = 60 * 60 * 1000; // ein Eintrag pro Stunde reicht für die Kalibrierung

// solar_data.js absichtlich nicht per require()/vm ausführen (die darin verwendeten "const"
// würden bei einer Ausführung im vm-Kontext ohnehin nicht am globalen Objekt landen) - stattdessen
// werden Metadata (gültiges JSON, da per JSON.stringify eingebettet) und Base64-Block direkt
// herausgelesen. Robust unabhängig davon, ob fetch_solar_timeline.js das Format mal ändert, solange
// diese beiden Konstanten so heißen.
function loadSolarData(path) {
    if (!fs.existsSync(path)) return null;
    const text = fs.readFileSync(path, 'utf8');
    const metaMatch = text.match(/const solarMetadata = (\{[\s\S]*?\});/);
    const b64Match = text.match(/const solarB64 = "([^"]+)";/);
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

// Bilineare Interpolation eines einzelnen Zeitschritts - identisch zur getTempAtStep()-Logik in index.html.
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

// Lineare Interpolation zwischen den umgebenden 3h-Schritten. Bewusst KEIN Clamp-Fallback auf den
// ältesten verfügbaren Schritt für Zeitpunkte davor (anders als die gleichnamige Funktion in
// index.html, wo ein grober Nachtwert für die Live-Anzeige unkritisch ist): ein persistiertes Log
// würde einen erfundenen Wert für immer festschreiben. Bug gefunden am 2026-09-10 beim ersten
// Befüllen von pv_forecast_log.json, als solar_data.js erst 24h Rückblick hatte - ältere PV-Stunden
// wurden auf den einen frühesten Wert "geklemmt" (z.B. 213 W/m² auch nachts), was 25 von 74
// Kalibrierpaaren mit einer physikalisch unmöglichen, konstanten Einstrahlung verfälscht hat.
function interpSolarAtTime(solarData, tMs) {
    if (!solarData || !solarData.length) return null;
    if (tMs < solarData[0].timeMs) return null; // keine Abdeckung -> lieber gar nicht loggen als raten
    for (let i = 0; i < solarData.length - 1; i++) {
        const a = solarData[i], b = solarData[i + 1];
        if (tMs >= a.timeMs && tMs <= b.timeMs) {
            const va = Math.max(0, getValueAtStep(a, PV_LAT, PV_LNG));
            const vb = Math.max(0, getValueAtStep(b, PV_LAT, PV_LNG));
            const f = b.timeMs > a.timeMs ? (tMs - a.timeMs) / (b.timeMs - a.timeMs) : 0;
            return va + (vb - va) * f;
        }
    }
    return Math.max(0, getValueAtStep(solarData[solarData.length - 1], PV_LAT, PV_LNG));
}

// FoxESS-Rohformat ("yyyy-MM-dd HH:mm:ss zZ") als Fallback, falls t nicht schon normalisiertes ISO ist.
function parseTimestamp(t) {
    if (typeof t !== 'string') return NaN;
    let d = new Date(t);
    if (!isNaN(d.getTime())) return d.getTime();
    const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+[A-Za-z]*([+-]\d{4})$/);
    if (!m) return NaN;
    d = new Date(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`);
    return isNaN(d.getTime()) ? NaN : d.getTime();
}

function run() {
    if (!fs.existsSync('pv_data.json')) {
        console.log('pv_data.json nicht gefunden, überspringe Forecast-Log.');
        return;
    }
    const solarData = loadSolarData(SOLAR_DATA_FILE);
    if (!solarData) {
        console.log('solar_data.js nicht gefunden/lesbar, überspringe Forecast-Log (noch keine Einstrahlungsprognose zum Vergleichen).');
        return;
    }

    const pvData = JSON.parse(fs.readFileSync('pv_data.json', 'utf8'));
    const history = Array.isArray(pvData.history_3d) ? pvData.history_3d : [];

    let log = [];
    if (fs.existsSync(LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { log = []; }
    }
    const byBucket = new Map(log.map(r => [r.t, r]));

    let added = 0;
    for (const p of history) {
        const tMs = parseTimestamp(p.t);
        if (isNaN(tMs) || typeof p.pv !== 'number') continue;
        const bucket = Math.round(tMs / BUCKET_MS) * BUCKET_MS;
        if (byBucket.has(bucket)) continue; // diese Stunde ist schon geloggt
        const ghi = interpSolarAtTime(solarData, bucket);
        if (ghi === null) continue;
        byBucket.set(bucket, { t: bucket, pv: Math.round(p.pv * 1000) / 1000, ghi: Math.round(ghi * 10) / 10 });
        added++;
    }

    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
    log = [...byBucket.values()].filter(r => r.t >= cutoff).sort((a, b) => a.t - b.t);

    fs.writeFileSync(LOG_FILE, JSON.stringify(log));
    console.log(`Forecast-Log: ${added} neue Einträge, ${log.length} gesamt (Fenster: ${MAX_AGE_DAYS} Tage).`);
}

run();

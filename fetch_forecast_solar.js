// Unabhängige Vergleichsprognose über forecast.solar (kostenlose, keyfreie API) für ein
// Referenzsystem (10 kWp, 35° Neigung, Südausrichtung) am PV-Standort. Dient NICHT als
// Ersatz für die eigene GFS-basierte Prognose, sondern als zweite, unabhängige Quelle zum
// Gegenchecken - siehe pv_calibration_review.js, das beide (plus die echten Messwerte)
// wöchentlich nebeneinanderstellt.
//
// Wichtig: forecast.solar rechnet mit einem IDEALISIERTEN Referenzsystem, nicht zwingend den
// echten Anlagendaten (kWp/Neigung/Azimut der realen Anlage in Hochheim sind uns nicht bekannt) -
// ein Teil jeder Abweichung kann also echter Hardware-Unterschied sein, nicht Prognosefehler.
// Ebenso liefert die kostenlose Stufe nur "heute" und "morgen", nie weiter voraus - das ist eine
// echte Grenze des Tools, keine Einschränkung unsererseits.
const fs = require('fs');
const https = require('https');

const LAT = 50.008, LON = 8.350, DECLINATION = 35, AZIMUTH = 0, KWP = 10;
const API_URL = `https://api.forecast.solar/estimate/${LAT}/${LON}/${DECLINATION}/${AZIMUTH}/${KWP}`;
const LOG_FILE = 'forecast_solar_log.json';
const MAX_AGE_DAYS = 60;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'HeatMap-PV-Dashboard (Vergleichsprognose)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 429) {
                    return reject(new Error('Rate-Limit erreicht (429) - übersprungen, nächster Lauf versucht es wieder.'));
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function run() {
    let json;
    try {
        json = await fetchJson(API_URL);
    } catch (e) {
        // Rate-Limits (auch durch andere Nutzer auf denselben GitHub-Actions-IP-Bereichen) sind
        // erwartbar - kein Grund, den ganzen Workflow-Lauf fehlschlagen zu lassen.
        console.log('forecast.solar-Abruf übersprungen:', e.message);
        return;
    }

    const wattHoursDay = (json.result && json.result.watt_hours_day) || {};
    const fetchedAt = Date.now();
    const newEntries = Object.entries(wattHoursDay).map(([targetDate, wh]) => ({
        fetchedAt, targetDate, kwh: Math.round((wh / 1000) * 100) / 100
    }));

    if (!newEntries.length) {
        console.log('forecast.solar lieferte keine Tageswerte (evtl. Rate-Limit-Antwort ohne watt_hours_day).');
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
    console.log(`forecast.solar: ${newEntries.length} Tageswerte geloggt (${newEntries.map(e => `${e.targetDate}=${e.kwh}kWh`).join(', ')}). Log gesamt: ${log.length} Einträge.`);
}

run();

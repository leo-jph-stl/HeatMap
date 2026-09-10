// Day-Ahead-Strompreis (EPEX, deutsche/luxemburgische Gebotszone) über die kostenlose,
// keyfreie aWATTar-API. Liefert Ist-Preise für mehrere Tage zurück (echte Historie, keine
// Momentaufnahme wie bei solar_data.js) und Zukunftspreise nur soweit die Börse sie schon
// veröffentlicht hat - üblicherweise der Rest des heutigen Tages plus der morgige Tag, sobald
// die Auktion dafür (meist gegen 13-14 Uhr MEZ) durchgelaufen ist. Für Tag 2/3 der PV-Prognose
// gibt es deshalb bewusst keine erfundenen Platzhalterpreise, siehe computeEuroSummary() in
// index.html, die mit dieser Lücke ehrlich umgeht statt sie zu verschweigen.
const fs = require('fs');
const https = require('https');

const API_URL = 'https://api.awattar.de/v1/marketdata';
const HISTORY_DAYS = 5; // etwas mehr als die 3 Tage des PV-Charts, für Puffer
const FUTURE_DAYS = 3;  // real meist nur ~1.5 Tage gefüllt, Rest bleibt schlicht leer

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'HeatMap-PV-Dashboard' } }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} für ${url}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        const start = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
        const end = Date.now() + FUTURE_DAYS * 24 * 3600 * 1000;
        const url = `${API_URL}?start=${start}&end=${end}`;
        console.log('Rufe Day-Ahead-Preise ab:', url);
        const json = await fetchJson(url);
        const rows = Array.isArray(json.data) ? json.data : [];
        if (!rows.length) throw new Error('aWATTar lieferte keine Preisdaten');

        // EUR/MWh -> ct/kWh: 1 EUR/MWh = 0.1 ct/kWh
        const priceData = rows
            .filter(r => typeof r.start_timestamp === 'number' && typeof r.marketprice === 'number')
            .map(r => ({ t: r.start_timestamp, endT: r.end_timestamp, ctKwh: Math.round(r.marketprice * 0.1 * 100) / 100 }))
            .sort((a, b) => a.t - b.t);

        const fileContent = `// Day-Ahead-Strompreis (EPEX DE/LU) in ct/kWh, stündlich. Quelle: aWATTar API (api.awattar.de).
// Netto-Marktpreis ohne Steuern/Abgaben/Netzentgelte - nicht identisch mit einem konkreten Endkundentarif.
// Automatisch generiert von fetch_electricity_price.js
const priceMetadata = { generatedAt: ${JSON.stringify(new Date().toISOString())}, unit: 'ct/kWh', source: 'aWATTar (api.awattar.de)' };
const priceData = ${JSON.stringify(priceData)};
`;
        fs.writeFileSync('electricity_price.js', fileContent);
        fs.writeFileSync('electricity_price.json', JSON.stringify(priceData));
        console.log(`ERFOLG: ${priceData.length} Stundenpreise gespeichert (${new Date(priceData[0].t).toISOString()} bis ${new Date(priceData[priceData.length - 1].t).toISOString()}).`);
    } catch (e) {
        console.error('Fehler beim Abruf des Day-Ahead-Preises:', e);
        process.exitCode = 1;
    }
}

run();

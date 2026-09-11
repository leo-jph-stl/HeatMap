// Day-Ahead-Strompreis (EPEX, deutsche/luxemburgische Gebotszone) über die kostenlose,
// keyfreie aWATTar-API. Liefert Ist-Preise (inkl. Monats-Historie ab Mai 2025) und Zukunftspreise
// soweit die Börse sie schon veröffentlicht hat.
const fs = require('fs');
const https = require('https');

const API_URL = 'https://api.awattar.de/v1/marketdata';
// Fester Start ab 01.05.2025 für vollständige Monatsanalysen (Inbetriebnahme bis heute)
const MIN_HISTORY_START = new Date('2025-05-01T00:00:00Z').getTime();
const FUTURE_DAYS = 3;
const CHUNK_DAYS = 60; // 60 Tage pro Anfrage schont die aWATTar API

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
        const totalStart = MIN_HISTORY_START;
        const totalEnd = Date.now() + FUTURE_DAYS * 24 * 3600 * 1000;

        // Bestehende Preise laden
        let existingPrices = [];
        if (fs.existsSync('electricity_price.json')) {
            try { existingPrices = JSON.parse(fs.readFileSync('electricity_price.json', 'utf8')); } catch (e) {}
        }
        const priceMap = new Map();
        existingPrices.forEach(p => priceMap.set(p.t, p));
        console.log(`Bestehende Preisdaten im Cache: ${priceMap.size} Stunden.`);

        const chunkMs = CHUNK_DAYS * 24 * 3600 * 1000;
        let curStart = totalStart;
        let fetchedNewTotal = 0;

        while (curStart < totalEnd) {
            const curEnd = Math.min(curStart + chunkMs, totalEnd);
            const startIso = new Date(curStart).toISOString().slice(0, 10);
            const endIso = new Date(curEnd).toISOString().slice(0, 10);

            // Prüfen, ob dieses Intervall bereits lückenlos im Cache ist
            let allCached = true;
            for (let t = curStart; t < curEnd - 3600000; t += 24 * 3600 * 1000) {
                if (!priceMap.has(t)) {
                    allCached = false;
                    break;
                }
            }

            // Letzten Chunk (Gegenwart/Zukunft) immer abrufen
            const isLatestChunk = (curEnd >= Date.now() - 24 * 3600 * 1000);

            if (!allCached || isLatestChunk) {
                const url = `${API_URL}?start=${curStart}&end=${curEnd}`;
                console.log(`Rufe aWATTar-Preise ab: [${startIso} bis ${endIso}] ...`);
                try {
                    const json = await fetchJson(url);
                    const rows = Array.isArray(json.data) ? json.data : [];
                    let newInChunk = 0;
                    rows.forEach(r => {
                        if (typeof r.start_timestamp === 'number' && typeof r.marketprice === 'number') {
                            const ctKwh = Math.round(r.marketprice * 0.1 * 100) / 100;
                            priceMap.set(r.start_timestamp, {
                                t: r.start_timestamp,
                                endT: r.end_timestamp,
                                ctKwh
                            });
                            newInChunk++;
                        }
                    });
                    fetchedNewTotal += newInChunk;
                    console.log(`  -> ${rows.length} Stunden empfangen (${newInChunk} aktualisiert).`);
                } catch (fetchErr) {
                    console.warn(`  Warnung bei Chunk [${startIso} bis ${endIso}]: ${fetchErr.message}`);
                }
                await sleep(500); // Höfliche Pause zwischen den Chunks
            } else {
                console.log(`Überspringe [${startIso} bis ${endIso}] (bereits vollständig im Cache).`);
            }

            curStart = curEnd;
        }

        const priceData = Array.from(priceMap.values()).sort((a, b) => a.t - b.t);
        if (!priceData.length) throw new Error('Keine Preisdaten verfügbar.');

        const fileContent = `// Day-Ahead-Strompreis (EPEX DE/LU) in ct/kWh, stündlich. Quelle: aWATTar API (api.awattar.de).
// Netto-Marktpreis ohne Steuern/Abgaben/Netzentgelte - nicht identisch mit einem konkreten Endkundentarif.
// Automatisch generiert von fetch_electricity_price.js
const priceMetadata = { generatedAt: ${JSON.stringify(new Date().toISOString())}, unit: 'ct/kWh', source: 'aWATTar (api.awattar.de)' };
const priceData = ${JSON.stringify(priceData)};
`;
        fs.writeFileSync('electricity_price.js', fileContent);
        fs.writeFileSync('electricity_price.json', JSON.stringify(priceData));
        console.log(`ERFOLG: ${priceData.length} Stundenpreise archiviert (${new Date(priceData[0].t).toISOString()} bis ${new Date(priceData[priceData.length - 1].t).toISOString()}).`);
    } catch (e) {
        console.error('Fehler beim Abruf des Day-Ahead-Preises:', e);
        process.exitCode = 1;
    }
}

run();

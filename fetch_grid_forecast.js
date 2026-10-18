// Day-Ahead- und Live-Erzeugungsprognose für Photovoltaik und Windkraft (Onshore/Offshore)
// aus den offiziellen Schnittstellen der Bundesnetzagentur (SMARD.de) und Fraunhofer Energy-Charts.
// Völlig kostenlos, keyfrei und ohne Registrierung.
const fs = require('fs');
const https = require('https');

const SMARD_BASE = 'https://www.smard.de/app/chart_data';
const ENERGY_CHARTS_BASE = 'https://api.energy-charts.info';

function fetchJson(url, retries = 3) {
    return new Promise((resolve, reject) => {
        const attempt = (n) => {
            https.get(url, { headers: { 'User-Agent': 'HeatMap-WeatherGlobe/1.0' }, timeout: 15000 }, (res) => {
                if (res.statusCode !== 200) {
                    if (n > 1) return setTimeout(() => attempt(n - 1), 1000);
                    return resolve(null);
                }
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            }).on('error', err => {
                if (n > 1) return setTimeout(() => attempt(n - 1), 1000);
                resolve(null);
            });
        };
        attempt(retries);
    });
}

// Lädt eine SMARD-Zeitreihe (letzte 2 Index-Perioden für lückenlose Historie + Day-Ahead-Prognose)
async function fetchSmardSeries(filterId, region) {
    const idx = await fetchJson(`${SMARD_BASE}/${filterId}/${region}/index_hour.json`);
    if (!idx || !idx.timestamps || !idx.timestamps.length) return [];

    const count = Math.min(2, idx.timestamps.length);
    const recentTs = idx.timestamps.slice(-count);
    const map = new Map();

    for (const ts of recentTs) {
        const file = await fetchJson(`${SMARD_BASE}/${filterId}/${region}/${filterId}_${region}_hour_${ts}.json`);
        if (file && file.series) {
            file.series.forEach(([t, val]) => {
                if (val !== null && !isNaN(val)) {
                    map.set(t, Math.round(val));
                }
            });
        }
    }

    return Array.from(map.entries())
        .map(([t, mw]) => ({ t, mw }))
        .sort((a, b) => a.t - b.t);
}

// Lädt eine Zeitreihe von Fraunhofer Energy-Charts (z. B. Frankreich)
async function fetchEnergyChartsSeries(country, prodType) {
    const res = await fetchJson(`${ENERGY_CHARTS_BASE}/public_power_forecast?country=${country}&production_type=${prodType}`);
    if (!res || !res.unix_seconds || !res.forecast_values) return [];

    // Auf Stunden aggregieren oder stündliche Punkte abbilden
    const map = new Map();
    for (let i = 0; i < res.unix_seconds.length; i++) {
        const tMs = res.unix_seconds[i] * 1000;
        const hourMs = Math.floor(tMs / 3600000) * 3600000;
        const v = res.forecast_values[i];
        if (v !== null && !isNaN(v)) {
            // Mittelwert pro Stunde bilden
            if (!map.has(hourMs)) map.set(hourMs, { sum: 0, count: 0 });
            const item = map.get(hourMs);
            item.sum += v;
            item.count++;
        }
    }

    return Array.from(map.entries())
        .map(([t, item]) => ({ t, mw: Math.round(item.sum / item.count) }))
        .sort((a, b) => a.t - b.t);
}

// Führt zwei Zeitreihen (z. B. Onshore + Offshore) stundengenau zusammen
function mergeSeriesAdd(seriesA, seriesB) {
    const map = new Map();
    seriesA.forEach(p => map.set(p.t, (map.get(p.t) || 0) + p.mw));
    seriesB.forEach(p => map.set(p.t, (map.get(p.t) || 0) + p.mw));
    return Array.from(map.entries())
        .map(([t, mw]) => ({ t, mw }))
        .sort((a, b) => a.t - b.t);
}

async function run() {
    console.log('Starte Abruf der PV- und Windkraft-Prognosen (SMARD & Energy-Charts)...');
    const t0 = Date.now();

    const output = {
        updatedAt: new Date().toISOString(),
        germany: {},
        regions: {},
        neighbors: {}
    };

    // 1. Deutschland gesamt
    console.log('Lade Deutschland gesamt (DE)...');
    const [deSolar, deWindOn, deWindOff] = await Promise.all([
        fetchSmardSeries(125, 'DE'),
        fetchSmardSeries(123, 'DE'),
        fetchSmardSeries(3791, 'DE')
    ]);

    const deWindTotal = mergeSeriesAdd(deWindOn, deWindOff);
    const deRenewable = mergeSeriesAdd(deSolar, deWindTotal);

    output.germany = {
        name: 'Deutschland (Gesamt)',
        solar: deSolar,
        windOnshore: deWindOn,
        windOffshore: deWindOff,
        windTotal: deWindTotal,
        totalRenewable: deRenewable
    };

    // 2. Die 4 deutschen Regelzonen (Übertragungsnetzbetreiber)
    console.log('Lade deutsche Übertragungsnetzbetreiber (50Hertz, Amprion, TenneT, TransnetBW)...');
    const regionConfigs = [
        { id: '50Hertz', name: '50Hertz (Nord/Ost)', hasOffshore: true },
        { id: 'Amprion', name: 'Amprion (West)', hasOffshore: false },
        { id: 'TenneT', name: 'TenneT (Nord/Mitte/Süd)', hasOffshore: true },
        { id: 'TransnetBW', name: 'TransnetBW (Südwest)', hasOffshore: false }
    ];

    await Promise.all(regionConfigs.map(async (reg) => {
        const promises = [
            fetchSmardSeries(125, reg.id),
            fetchSmardSeries(123, reg.id)
        ];
        if (reg.hasOffshore) promises.push(fetchSmardSeries(3791, reg.id));

        const [solar, windOn, windOff] = await Promise.all(promises);
        const actualOff = windOff || [];
        const windTotal = mergeSeriesAdd(windOn, actualOff);
        const totalRenewable = mergeSeriesAdd(solar, windTotal);

        output.regions[reg.id] = {
            name: reg.name,
            solar,
            windOnshore: windOn,
            windOffshore: actualOff,
            windTotal,
            totalRenewable
        };
    }));

    // 3. Europäische Nachbarländer (Österreich via SMARD, Frankreich via Energy-Charts)
    console.log('Lade europäische Nachbarn (Österreich & Frankreich)...');
    try {
        const [atSolar, atWind] = await Promise.all([
            fetchSmardSeries(125, 'AT'),
            fetchSmardSeries(123, 'AT')
        ]);
        if (atSolar.length || atWind.length) {
            output.neighbors['AT'] = {
                name: 'Österreich',
                solar: atSolar,
                windOnshore: atWind,
                windOffshore: [],
                windTotal: atWind,
                totalRenewable: mergeSeriesAdd(atSolar, atWind)
            };
        }
    } catch (e) {
        console.warn('Österreich-Abruf fehlgeschlagen:', e.message);
    }

    try {
        const [frSolar, frWind] = await Promise.all([
            fetchEnergyChartsSeries('fr', 'solar'),
            fetchEnergyChartsSeries('fr', 'wind_onshore')
        ]);
        if (frSolar.length || frWind.length) {
            output.neighbors['FR'] = {
                name: 'Frankreich',
                solar: frSolar,
                windOnshore: frWind,
                windOffshore: [],
                windTotal: frWind,
                totalRenewable: mergeSeriesAdd(frSolar, frWind)
            };
        }
    } catch (e) {
        console.warn('Frankreich-Abruf fehlgeschlagen:', e.message);
    }

    // Speichern
    const jsonStr = JSON.stringify(output);
    fs.writeFileSync('grid_forecast.json', jsonStr);

    const jsStr = `// Offizielle Erzeugungsprognosen Photovoltaik & Wind (SMARD & Energy-Charts)
// Automatisch generiert von fetch_grid_forecast.js
var gridForecastData = ${jsonStr};
`;
    fs.writeFileSync('grid_forecast.js', jsStr);

    const duration = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`ERFOLG: grid_forecast.json und grid_forecast.js erfolgreich in ${duration}s geschrieben!`);
    console.log(`DE Solar Punkte: ${output.germany.solar.length}, Wind Gesamt Punkte: ${output.germany.windTotal.length}`);
}

run().catch(err => {
    console.error('Kritischer Fehler bei fetch_grid_forecast:', err);
    process.exitCode = 1;
});

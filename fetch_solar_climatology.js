// Globale Monats- und Jahresmittel der Sonneneinstrahlung (langjähriges Klimatologie-Mittel,
// All-Sky GHI in kWh/m^2/Tag) über die kostenlose NASA POWER Climatology API.
// https://power.larc.nasa.gov/docs/services/api/temporal/climatology/
//
// Die "regional"-Endpunkt-Antwort ist auf max. 10 Grad Spannweite pro Achse begrenzt, daher
// wird der Globus in 10x10-Grad-Kacheln zerlegt und zusammengesetzt (36 x 18 = 648 Kacheln,
// Ergebnisgitter 1x1 Grad). Kein API-Key nötig.
//
// CLI-Override für schnelle Tests: `node fetch_solar_climatology.js --lonStep=30 --latStep=30`
const fs = require('fs');
const https = require('https');

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const TILE_DEG = 10; // API-Limit: maximal 10 Grad Spannweite pro Request
const LON_STEP = parseInt(argv.lonStep || TILE_DEG, 10);
const LAT_STEP = parseInt(argv.latStep || TILE_DEG, 10);
const CONCURRENCY = parseInt(argv.concurrency || '5', 10);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'ANN'];

// Ergebnisgitter: 1x1 Grad, Punkte bei X.5/Y.5 (NASA POWER solar-Auflösung)
const NX = 360, NY = 180;
// Spalten in GFS-Konvention (0..360° Ost, aufsteigend) statt NASA POWERs -180..180°, damit
// dieselbe Spalten-Remapping-Logik wie bei den Live-GFS-Daten (buildTempDataTexture in
// index.html) greift - sonst landet die Klimatologie um ~180° längenverschoben auf dem Globus.
const LO1 = 0.5, LA1 = 89.5; // oben-links (Nordwesten), Zeilen laufen von Nord nach Süd

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'HeatMap-Prototype/1.0' } }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} für ${url}`));
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON-Fehler: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTile(lonMin, latMin) {
    const lonMax = Math.min(180, lonMin + TILE_DEG);
    const latMax = Math.min(90, latMin + TILE_DEG);
    const url = `https://power.larc.nasa.gov/api/temporal/climatology/regional?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude-min=${lonMin}&longitude-max=${lonMax}&latitude-min=${latMin}&latitude-max=${latMax}&format=JSON`;
    const json = await fetchJson(url);
    if (!json.features) {
        if (json.messages) console.warn(`  Kachel [${lonMin},${latMin}] keine Daten: ${json.messages.join(' | ')}`);
        return [];
    }
    return json.features.map(f => ({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        values: f.properties.parameter.ALLSKY_SFC_SW_DWN
    }));
}

async function run() {
    const tiles = [];
    for (let lonMin = -180; lonMin < 180; lonMin += LON_STEP) {
        for (let latMin = -90; latMin < 90; latMin += LAT_STEP) {
            tiles.push({ lonMin, latMin });
        }
    }
    console.log(`Lade Klimatologie in ${tiles.length} Kacheln à ${LON_STEP}x${LAT_STEP} Grad (Concurrency ${CONCURRENCY})...`);

    // 13 Layer (12 Monate + Jahr), je NX*NY Punkte, Int16 skaliert (0.01 kWh/m^2/Tag Genauigkeit)
    const layers = MONTHS.map(() => new Int16Array(NX * NY).fill(-1)); // -1 = "keine Daten"
    let done = 0;
    const startTime = Date.now();

    for (let i = 0; i < tiles.length; i += CONCURRENCY) {
        const batch = tiles.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ({ lonMin, latMin }) => {
            try {
                const points = await fetchTile(lonMin, latMin);
                for (const p of points) {
                    const lon360 = p.lon < 0 ? p.lon + 360 : p.lon;
                    const col = Math.round(lon360 - LO1);
                    const row = Math.round(LA1 - p.lat);
                    if (col < 0 || col >= NX || row < 0 || row >= NY) continue;
                    const idx = row * NX + col;
                    MONTHS.forEach((m, mi) => {
                        const v = p.values[m];
                        if (typeof v === 'number' && v > -900) {
                            layers[mi][idx] = Math.round(v * 100);
                        }
                    });
                }
            } catch (e) {
                console.warn(`  Kachel [${lonMin},${latMin}] fehlgeschlagen: ${e.message}`);
            }
        }));
        done += batch.length;
        if (done % 50 === 0 || done === tiles.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(`  ${done}/${tiles.length} Kacheln (${elapsed}s)...`);
        }
        await sleep(50); // kleine Pause zwischen Batches, um den kostenlosen Dienst nicht zu überlasten
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Fertig in ${elapsed}s. Kodiere...`);

    const combined = new Int16Array(layers.length * NX * NY);
    layers.forEach((layer, i) => combined.set(layer, i * NX * NY));
    const base64Str = Buffer.from(combined.buffer).toString('base64');
    console.log(`Base64-Größe: ${(base64Str.length / 1024 / 1024).toFixed(2)} MB`);

    const metadata = {
        nx: NX, ny: NY, dx: 1, dy: 1, la1: LA1, lo1: LO1,
        scale: 0.01, unit: 'kWh/m^2/day', fillValue: -1,
        layers: MONTHS,
        source: 'NASA POWER Climatology (SYN1DEG, 2001-2020)',
        generatedAt: new Date().toISOString()
    };

    const fileContent = `// Globale Monats-/Jahresmittel der Sonneneinstrahlung (langjähriges Klimatologie-Mittel).
// Automatisch generiert von fetch_solar_climatology.js. Quelle: NASA POWER (2001-2020).
const solarClimMetadata = ${JSON.stringify(metadata)};
const solarClimB64 = "${base64Str}";

const solarClimatologyData = (() => {
    const raw = typeof atob !== 'undefined' ? atob(solarClimB64) : Buffer.from(solarClimB64, 'base64').toString('binary');
    const len = raw.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const ptsPerLayer = solarClimMetadata.nx * solarClimMetadata.ny;
    return solarClimMetadata.layers.map((label, idx) => ({
        label,
        header: { nx: solarClimMetadata.nx, ny: solarClimMetadata.ny, dx: solarClimMetadata.dx, dy: solarClimMetadata.dy, la1: solarClimMetadata.la1, lo1: solarClimMetadata.lo1 },
        scale: solarClimMetadata.scale,
        fillValue: solarClimMetadata.fillValue,
        data: int16.subarray(idx * ptsPerLayer, (idx + 1) * ptsPerLayer)
    }));
})();
`;

    fs.writeFileSync('solar_climatology_data.js', fileContent);
    console.log('ERFOLG: solar_climatology_data.js geschrieben!');
}

run().catch(e => { console.error('Fehler:', e); process.exitCode = 1; });

// Globale Sonneneinstrahlung (Global Horizontal Irradiance) aus dem GFS 0.25°-Modell.
// Nutzt denselben THREDDS-Server wie fetch_gfs_0p25.js, Variable
// "Downward_Short-Wave_Radiation_Flux_surface_Mixed_intervals_Average" (W/m^2).
//
// Wichtig: Diese Radiations-Variable liegt auf einer eigenen Zeitachse ("time3") mit
// eigenem Referenzdatum, das sich unabhängig von der "time"-Achse der Temperatur
// verschiebt (rollierendes THREDDS-"Best"-Aggregat). Das Referenzdatum wird deshalb
// bei jedem Lauf dynamisch aus den .das-Attributen gelesen statt hartkodiert
// (im Gegensatz zu fetch_gfs_0p25.js, das das Datum für "time" fest im Code stehen hat
// und deshalb gelegentlich manuell nachgezogen werden muss).
//
// CLI-Override für schnelle Tests: `node fetch_solar_timeline.js --steps=3 --stride=4`
const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://thredds.ucar.edu/thredds/dodsC/grib/NCEP/GFS/Global_0p25deg/Best';
const VAR = 'Downward_Short-Wave_Radiation_Flux_surface_Mixed_intervals_Average';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const STRIDE = parseInt(argv.stride || '1', 10);      // 1 = volle 0.25°-Auflösung, 2 = 0.5°, 4 = 1.0° ...
const NUM_STEPS = parseInt(argv.steps || '33', 10);    // Standard wie fetch_gfs_0p25.js: -24h bis +72h
const BACK_STEPS = parseInt(argv.back || '8', 10);     // 8*3h = 24h zurück

const FULL_NX = 1440, FULL_NY = 721;
const LON_IDX = `0:${STRIDE}:${FULL_NX - 1}`;
const LAT_IDX = `0:${STRIDE}:${FULL_NY - 1}`;
const NX = Math.ceil(FULL_NX / STRIDE);
const NY = Math.ceil(FULL_NY / STRIDE);
const PTS_PER_STEP = NX * NY;

function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} für ${url}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchTimeIndices() {
    console.log('Ermittle Referenzdatum und Zeitachse (time3) für die Strahlungsdaten...');
    const das = await fetchText(`${BASE_URL}.das`);
    const timeBlockMatch = das.match(/time3\s*\{[^}]*units\s+"Hour since ([^"]+)"/);
    if (!timeBlockMatch) throw new Error('Konnte Referenzdatum für time3 nicht aus .das lesen');
    const baseDate = new Date(timeBlockMatch[1]).getTime();
    console.log(`Referenzdatum time3: ${timeBlockMatch[1]}`);

    const text = await fetchText(`${BASE_URL}.ascii?time3`);
    const lines = text.split('\n').filter(l => /^\d/.test(l.trim()));
    const times = lines.join(',').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

    const nowHours = (Date.now() - baseDate) / 3600000;
    let bestIdx = 0, minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(times[i] - nowHours);
        if (diff < minDiff) { minDiff = diff; bestIdx = i; }
    }

    const startIdx = Math.max(0, bestIdx - BACK_STEPS);
    const steps = [];
    for (let i = 0; i < NUM_STEPS; i++) {
        const targetIdx = startIdx + i;
        if (targetIdx >= times.length) break;
        const stepDate = new Date(baseDate + times[targetIdx] * 3600000);
        steps.push({
            threddsIdx: targetIdx,
            hour: (i - BACK_STEPS) * 3,
            timestamp: stepDate.toISOString(),
            timeMs: stepDate.getTime()
        });
    }
    console.log(`Live-Index: ${bestIdx} von ${times.length}. Zeitfenster: ${steps[0].timestamp} bis ${steps[steps.length - 1].timestamp} (${steps.length} Schritte)`);
    return steps;
}

async function fetchSingleStep(threddsIdx, stepNumber, totalSteps) {
    const t0 = Date.now();
    const url = `${BASE_URL}.ascii?${VAR}[${threddsIdx}][${LAT_IDX}][${LON_IDX}]`;
    const text = await fetchText(url);

    const marker = `${VAR}.${VAR}`;
    const parts = text.split(marker);
    if (parts.length < 2) throw new Error(`Parse-Fehler bei Schritt ${threddsIdx}`);
    const dataBlock = parts[1].split(`${VAR}.time3`)[0];

    const int16Array = new Int16Array(PTS_PER_STEP);
    let count = 0;
    // Jede Zeile ist "[i][j], val1, val2, ..." - das erste Feld ist der Zeilenindex, kein Messwert.
    const lines = dataBlock.split('\n').filter(l => l.includes(','));
    for (const line of lines) {
        const parts2 = line.split(',').slice(1); // erstes Feld ist der Zeilen-Index "[0][x]"
        for (const p of parts2) {
            const v = parseFloat(p.trim());
            if (isNaN(v) || count >= PTS_PER_STEP) continue;
            const clamped = Math.max(0, v); // negative Werte (Rundungsrauschen nachts) auf 0 klemmen
            int16Array[count++] = Math.round(clamped * 10); // 0.1 W/m^2 Genauigkeit
        }
    }

    const duration = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${stepNumber}/${totalSteps}] Schritt ${threddsIdx} geladen in ${duration}s (${count.toLocaleString()} Messpunkte)`);
    if (count !== PTS_PER_STEP) {
        console.warn(`  WARNUNG: erwartet ${PTS_PER_STEP} Punkte, erhalten ${count}`);
    }
    return int16Array;
}

async function run() {
    try {
        const steps = await fetchTimeIndices();
        const totalPoints = steps.length * PTS_PER_STEP;
        const masterInt16 = new Int16Array(totalPoints);

        console.log(`Starte Download von ${steps.length} Zeitschritten (Grid ${NX}x${NY}, Stride ${STRIDE}), insgesamt ${totalPoints.toLocaleString()} Messpunkte...`);
        const startTime = Date.now();

        const CONCURRENCY = 3;
        for (let i = 0; i < steps.length; i += CONCURRENCY) {
            const batch = [];
            for (let j = 0; j < CONCURRENCY && (i + j) < steps.length; j++) {
                const stepIdx = i + j;
                const p = fetchSingleStep(steps[stepIdx].threddsIdx, stepIdx + 1, steps.length).then(arr => {
                    masterInt16.set(arr, stepIdx * PTS_PER_STEP);
                });
                batch.push(p);
            }
            await Promise.all(batch);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Alle ${steps.length} Zeitschritte erfolgreich in ${elapsed}s heruntergeladen!`);

        const buffer = Buffer.from(masterInt16.buffer);
        const base64Str = buffer.toString('base64');
        console.log(`Base64-Größe: ${(base64Str.length / 1024 / 1024).toFixed(2)} MB`);

        const metadata = {
            nx: NX, ny: NY,
            dx: 0.25 * STRIDE, dy: 0.25 * STRIDE,
            la1: 90, lo1: 0,
            scale: 0.1,
            unit: 'W/m^2',
            steps: steps.map(s => ({ hour: s.hour, timestamp: s.timestamp, timeMs: s.timeMs }))
        };

        const fileContent = `// Globale Sonneneinstrahlung (GHI, Downward Shortwave Radiation) aus GFS 0.25°.
// Automatisch generiert von fetch_solar_timeline.js
const solarMetadata = ${JSON.stringify(metadata)};
const solarB64 = "${base64Str}";

const solarData = (() => {
    const raw = typeof atob !== 'undefined' ? atob(solarB64) : Buffer.from(solarB64, 'base64').toString('binary');
    const len = raw.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const ptsPerStep = solarMetadata.nx * solarMetadata.ny;
    return solarMetadata.steps.map((s, idx) => {
        const sub = int16.subarray(idx * ptsPerStep, (idx + 1) * ptsPerStep);
        return {
            hour: s.hour,
            timestamp: s.timestamp,
            timeMs: s.timeMs,
            header: { nx: solarMetadata.nx, ny: solarMetadata.ny, dx: solarMetadata.dx, dy: solarMetadata.dy, la1: solarMetadata.la1, lo1: solarMetadata.lo1 },
            scale: solarMetadata.scale,
            data: sub
        };
    });
})();
`;

        fs.writeFileSync('solar_data.js', fileContent);
        console.log('ERFOLG: solar_data.js geschrieben!');
    } catch (e) {
        console.error('Fehler:', e);
        process.exitCode = 1;
    }
}

run();

// Globale Sonneneinstrahlung (Global Horizontal Irradiance) aus dem GFS 0.25°-Modell.
// Nutzt denselben THREDDS-Server wie fetch_gfs_0p25.js, Variable
// "Downward_Short-Wave_Radiation_Flux_surface_Mixed_intervals_Average" (W/m^2).
//
// Wichtig: Diese Radiations-Variable liegt auf der "time3"-Achse.
// Im GFS GRIB2-Modell sind Strahlungsflüsse Intervall-Mittelwerte bezüglich des
// jeweiligen 6-stündigen Zyklus (00Z, 06Z, 12Z, 18Z):
// - Gerader Index 2k: Intervall [6k, 6k+3] -> direkter 3h-Mittelwert A_0-3
// - Ungerader Index 2k+1: Intervall [6k, 6k+6] -> 6h-Mittelwert A_0-6
// Um ein lückenloses 3h-Raster zu erhalten, wird der zweite 3h-Schritt [6k+3, 6k+6]
// per Dekonvolution berechnet: A_3-6 = max(0, 2 * A_0-6 - A_0-3).
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
// 36 Schritte: -24h bis +81h (9h Puffer über +72h hinaus für 6h-Pull-Staleness)
const NUM_STEPS = parseInt(argv.steps || '36', 10);
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
    const now3h = Math.round(nowHours / 3) * 3;
    const startHour = now3h - BACK_STEPS * 3;

    // Ein GFS-6h-Zyklus k deckt [6k, 6k+6] ab.
    const startCycle = Math.floor(startHour / 6);
    const numCycles = Math.ceil(NUM_STEPS / 2) + 2;

    const rawSteps = [];
    for (let c = 0; c < numCycles; c++) {
        const cycle = startCycle + c;
        const cycleStartHour = cycle * 6;
        const idxA = cycle * 2;
        const idxB = cycle * 2 + 1;
        if (idxB >= times.length) break;

        rawSteps.push({
            cycle,
            substep: 0,
            threddsIdxA: idxA,
            forecastHour: cycleStartHour,
            timestamp: new Date(baseDate + cycleStartHour * 3600000).toISOString(),
            timeMs: baseDate + cycleStartHour * 3600000
        });
        rawSteps.push({
            cycle,
            substep: 1,
            threddsIdxA: idxA,
            threddsIdxB: idxB,
            forecastHour: cycleStartHour + 3,
            timestamp: new Date(baseDate + (cycleStartHour + 3) * 3600000).toISOString(),
            timeMs: baseDate + (cycleStartHour + 3) * 3600000
        });
    }

    const startIdx = rawSteps.findIndex(s => s.forecastHour === startHour);
    if (startIdx === -1) throw new Error(`Konnte Start-Schritt für forecastHour=${startHour} nicht finden`);
    const selectedSteps = rawSteps.slice(startIdx, startIdx + NUM_STEPS);

    selectedSteps.forEach((s, idx) => {
        s.hour = (idx - BACK_STEPS) * 3;
    });

    console.log(`Zeitfenster: ${selectedSteps[0].timestamp} bis ${selectedSteps[selectedSteps.length - 1].timestamp} (${selectedSteps.length} Schritte à 3h)`);
    return { selectedSteps, baseDate };
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
        const parts2 = line.split(',').slice(1);
        for (const p of parts2) {
            const v = parseFloat(p.trim());
            if (isNaN(v) || count >= PTS_PER_STEP) continue;
            const clamped = Math.max(0, v); // negative Werte auf 0 klemmen
            int16Array[count++] = Math.round(clamped * 10); // 0.1 W/m^2 Genauigkeit
        }
    }

    const duration = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${stepNumber}/${totalSteps}] THREDDS-Index ${threddsIdx} geladen in ${duration}s (${count.toLocaleString()} Messpunkte)`);
    if (count !== PTS_PER_STEP) {
        console.warn(`  WARNUNG: erwartet ${PTS_PER_STEP} Punkte, erhalten ${count}`);
    }
    return int16Array;
}

const REF_LAT = 50.008, REF_LNG = 8.350; // Hochheim am Main - selber Punkt wie in log_pv_forecast.js
function checkPlausibility(masterInt16, steps) {
    const lon360 = REF_LNG < 0 ? REF_LNG + 360 : REF_LNG;
    const yIdx = Math.round((90 - REF_LAT) / (0.25 * STRIDE));
    const xIdx = Math.round(lon360 / (0.25 * STRIDE));
    if (yIdx < 0 || yIdx >= NY || xIdx < 0 || xIdx >= NX) return { ok: true };

    let middaySum = 0, middayN = 0, nightSum = 0, nightN = 0;
    steps.forEach((s, idx) => {
        const utcHour = new Date(s.timeMs).getUTCHours();
        const val = masterInt16[idx * PTS_PER_STEP + yIdx * NX + xIdx] * 0.1;
        // 09-15 UTC / 21-03 UTC deckt für Hochheim (8.35°O, CET/CEST) ganzjährig sicher Mittag bzw.
        // tiefe Nacht ab, unabhängig von der genauen Jahreszeit.
        if (utcHour >= 9 && utcHour <= 15) { middaySum += val; middayN++; }
        if (utcHour >= 21 || utcHour <= 3) { nightSum += val; nightN++; }
    });
    if (middayN < 3 || nightN < 3) return { ok: true };

    const middayAvg = middaySum / middayN, nightAvg = nightSum / nightN;
    return { ok: middayAvg > nightAvg, middayAvg, nightAvg };
}

async function run() {
    try {
        const { selectedSteps } = await fetchTimeIndices();

        // Ermittle alle eindeutigen THREDDS-Indizes, die heruntergeladen werden müssen
        const neededIndices = new Set();
        selectedSteps.forEach(s => {
            neededIndices.add(s.threddsIdxA);
            if (s.threddsIdxB !== undefined) neededIndices.add(s.threddsIdxB);
        });
        const sortedIndices = Array.from(neededIndices).sort((a, b) => a - b);

        console.log(`Benötige ${sortedIndices.length} THREDDS-Indizes für ${selectedSteps.length} 3h-Zeitschritte (Grid ${NX}x${NY}, Stride ${STRIDE})...`);
        const startTime = Date.now();

        const gridCache = new Map();
        const CONCURRENCY = 3;
        for (let i = 0; i < sortedIndices.length; i += CONCURRENCY) {
            const batch = [];
            for (let j = 0; j < CONCURRENCY && (i + j) < sortedIndices.length; j++) {
                const idxNum = i + j;
                const threddsIdx = sortedIndices[idxNum];
                const p = fetchSingleStep(threddsIdx, idxNum + 1, sortedIndices.length).then(arr => {
                    gridCache.set(threddsIdx, arr);
                });
                batch.push(p);
            }
            await Promise.all(batch);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Alle ${sortedIndices.length} THREDDS-Indizes erfolgreich in ${elapsed}s heruntergeladen!`);

        // Dekonvolution der 3h-Schritte
        const totalPoints = selectedSteps.length * PTS_PER_STEP;
        const masterInt16 = new Int16Array(totalPoints);

        selectedSteps.forEach((s, stepIdx) => {
            const arrA = gridCache.get(s.threddsIdxA);
            const destOffset = stepIdx * PTS_PER_STEP;
            if (s.substep === 0) {
                // Direkter 3h-Mittelwert [6k, 6k+3]
                masterInt16.set(arrA, destOffset);
            } else {
                // Dekonvolution von [6k+3, 6k+6]: A_3-6 = max(0, 2 * A_0-6 - A_0-3)
                const arrB = gridCache.get(s.threddsIdxB);
                for (let p = 0; p < PTS_PER_STEP; p++) {
                    const v = 2 * arrB[p] - arrA[p];
                    masterInt16[destOffset + p] = v > 0 ? (v > 32767 ? 32767 : v) : 0;
                }
            }
        });

        const plausibility = checkPlausibility(masterInt16, selectedSteps);
        if (!plausibility.ok) {
            console.error(`FEHLER: Plausibilitätsprüfung fehlgeschlagen - Referenzpunkt Hochheim zeigt nachts (Ø ${plausibility.nightAvg.toFixed(1)} W/m²) heller als mittags (Ø ${plausibility.middayAvg.toFixed(1)} W/m²). solar_data.js wird NICHT überschrieben.`);
            process.exitCode = 1;
            return;
        } else if (plausibility.middayAvg !== undefined) {
            console.log(`Plausibilitätsprüfung bestanden: Mittag Ø ${plausibility.middayAvg.toFixed(1)} W/m² vs. Nacht Ø ${plausibility.nightAvg.toFixed(1)} W/m².`);
        } else {
            console.log('Plausibilitätsprüfung: Zu wenige Schritte für statistische Mittelwertprüfung (Kurzlauf).');
        }

        const buffer = Buffer.from(masterInt16.buffer);
        const base64Str = buffer.toString('base64');
        console.log(`Base64-Größe: ${(base64Str.length / 1024 / 1024).toFixed(2)} MB`);

        const metadata = {
            nx: NX, ny: NY,
            dx: 0.25 * STRIDE, dy: 0.25 * STRIDE,
            la1: 90, lo1: 0,
            scale: 0.1,
            unit: 'W/m^2',
            steps: selectedSteps.map(s => ({ hour: s.hour, timestamp: s.timestamp, timeMs: s.timeMs }))
        };

        const fileContent = `// Globale Sonneneinstrahlung (GHI, Downward Shortwave Radiation) aus GFS 0.25°.
// Automatisch generiert von fetch_solar_timeline.js
var solarMetadata = ${JSON.stringify(metadata)};
var solarB64 = "${base64Str}";

var solarData = (() => {
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
solarB64 = null;
`;

        fs.writeFileSync('solar_data.js', fileContent);
        console.log('ERFOLG: solar_data.js geschrieben!');
    } catch (e) {
        console.error('Fehler:', e);
        process.exitCode = 1;
    }
}

run();

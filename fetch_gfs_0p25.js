const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://thredds.ucar.edu/thredds/dodsC/grib/NCEP/GFS/Global_0p25deg/Best';
const NX = 1440;
const NY = 721;
const PTS_PER_STEP = NX * NY; // 1,038,240
// 36 statt 33 Schritte: -24h bis +81h. Die 9h Extra-Puffer über die im UI beworbenen +72h hinaus
// gleichen aus, dass der Abruf nur alle 6h läuft - kurz vor dem nächsten Pull wäre das Array sonst
// nur noch "+66h ab jetzt" statt "+72h ab jetzt" (das Fenster ist am Abrufzeitpunkt verankert, nicht
// am Anzeigezeitpunkt). Siehe auch timeSlider-Anpassung in index.html (dynamisches max).
const NUM_STEPS = 36;

function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchTimeIndices() {
    console.log('Ermittle Referenzdatum und aktuelle Zeitstempel vom Unidata GFS 0.25 THREDDS Server...');
    const das = await fetchText(`${BASE_URL}.das`);
    const timeBlockMatch = das.match(/time\s*\{[^}]*units\s+"Hour since ([^"]+)"/);
    if (!timeBlockMatch) throw new Error('Konnte Referenzdatum für time nicht aus .das lesen');
    const baseDate = new Date(timeBlockMatch[1]).getTime();
    console.log(`Referenzdatum time: ${timeBlockMatch[1]}`);

    const text = await fetchText(`${BASE_URL}.ascii?time`);
    const lines = text.split('\n');
    const dataLines = lines.filter(l => /^\d/.test(l.trim()));
    const times = dataLines.join(',').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

    const nowHours = (Date.now() - baseDate) / 3600000;

    let bestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(times[i] - nowHours);
        if (diff < minDiff) {
            minDiff = diff;
            bestIdx = i;
        }
    }

    const startIdx = Math.max(0, bestIdx - 8);

    const steps = [];
    for (let i = 0; i < NUM_STEPS; i++) {
        const targetIdx = startIdx + i;
        const hourVal = times[targetIdx];
        const stepDate = new Date(baseDate + hourVal * 3600000);
        const hourOffset = (i - 8) * 3;
        steps.push({
            threddsIdx: targetIdx,
            hour: hourOffset,
            timestamp: stepDate.toISOString(),
            timeMs: stepDate.getTime()
        });
    }

    console.log(`Live Index: ${bestIdx} (${steps[8].timestamp})`);
    console.log(`Zeitfenster: -24h (${steps[0].timestamp}) bis +${steps[steps.length - 1].hour}h (${steps[steps.length - 1].timestamp})`);
    return steps;
}

async function fetchSingleStep(threddsIdx, stepNumber, totalSteps, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const t0 = Date.now();
            const url = `${BASE_URL}.ascii?Temperature_height_above_ground[${threddsIdx}][0][0:1:720][0:1:1439]`;
            const text = await fetchText(url);

            const parts = text.split('Temperature_height_above_ground.Temperature_height_above_ground');
            if (parts.length < 2) throw new Error(`Parse error at step ${threddsIdx}`);
            const dataBlock = parts[1].split(/Temperature_height_above_ground\.time/)[0];

            const regex = /-?\d+\.\d+/g;
            let match;
            const int16Array = new Int16Array(PTS_PER_STEP);
            let count = 0;
            while ((match = regex.exec(dataBlock)) !== null && count < PTS_PER_STEP) {
                let val = parseFloat(match[0]);
                if (val > 100) val -= 273.15; // Kelvin -> Celsius
                int16Array[count++] = Math.round(val * 10); // Genauigkeit 0.1 °C
            }

            if (count < PTS_PER_STEP * 0.95) {
                throw new Error(`Unvollständige Daten bei Schritt ${threddsIdx}: nur ${count} Messpunkte geladen`);
            }

            const duration = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`[${stepNumber}/${totalSteps}] Schritt ${threddsIdx} geladen in ${duration}s (${count.toLocaleString()} Messpunkte)`);
            return int16Array;
        } catch (err) {
            console.warn(`[Versuch ${attempt}/${retries}] Fehler bei Schritt ${threddsIdx}: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
}

async function run() {
    try {
        const steps = await fetchTimeIndices();
        const totalPoints = NUM_STEPS * PTS_PER_STEP;
        const masterInt16 = new Int16Array(totalPoints);
        const validSteps = new Array(steps.length).fill(false);

        console.log(`Starte Download von ${steps.length} Zeitschritten mit 0.25° Auflösung (insgesamt ${totalPoints.toLocaleString()} Messpunkte)...`);
        const startTime = Date.now();

        // Paralleler Download mit Concurrency Pool (2 gleichzeitige Anfragen für maximale Stabilität)
        const CONCURRENCY = 2;
        for (let i = 0; i < steps.length; i += CONCURRENCY) {
            const batch = [];
            for (let j = 0; j < CONCURRENCY && (i + j) < steps.length; j++) {
                const stepIdx = i + j;
                const p = fetchSingleStep(steps[stepIdx].threddsIdx, stepIdx + 1, steps.length)
                    .then(arr => {
                        masterInt16.set(arr, stepIdx * PTS_PER_STEP);
                        validSteps[stepIdx] = true;
                    })
                    .catch(e => {
                        console.error(`Schritt ${stepIdx} (${steps[stepIdx].timestamp}) konnte nach Wiederholungen nicht geladen werden:`, e.message);
                    });
                batch.push(p);
            }
            await Promise.all(batch);
        }

        // LERP-Interpolation für evtl. ausgefallene Zeitschritte (verhindert 0°C-Einfrieren)
        for (let i = 0; i < steps.length; i++) {
            if (!validSteps[i]) {
                let prevIdx = i - 1;
                while (prevIdx >= 0 && !validSteps[prevIdx]) prevIdx--;
                let nextIdx = i + 1;
                while (nextIdx < steps.length && !validSteps[nextIdx]) nextIdx++;

                const targetSub = masterInt16.subarray(i * PTS_PER_STEP, (i + 1) * PTS_PER_STEP);
                if (prevIdx >= 0 && nextIdx < steps.length) {
                    const t0 = steps[prevIdx].timeMs, t1 = steps[nextIdx].timeMs, tc = steps[i].timeMs;
                    const factor = (t1 !== t0) ? (tc - t0) / (t1 - t0) : 0.5;
                    const prevSub = masterInt16.subarray(prevIdx * PTS_PER_STEP, (prevIdx + 1) * PTS_PER_STEP);
                    const nextSub = masterInt16.subarray(nextIdx * PTS_PER_STEP, (nextIdx + 1) * PTS_PER_STEP);
                    const invF = 1 - factor;
                    for (let k = 0; k < PTS_PER_STEP; k++) {
                        targetSub[k] = Math.round(invF * prevSub[k] + factor * nextSub[k]);
                    }
                    validSteps[i] = true;
                    console.log(`Schritt ${i} (${steps[i].timestamp}) synthetisiert durch zeitliche Interpolation von Schritt ${prevIdx} und ${nextIdx}`);
                } else if (prevIdx >= 0) {
                    targetSub.set(masterInt16.subarray(prevIdx * PTS_PER_STEP, (prevIdx + 1) * PTS_PER_STEP));
                    validSteps[i] = true;
                } else if (nextIdx < steps.length) {
                    targetSub.set(masterInt16.subarray(nextIdx * PTS_PER_STEP, (nextIdx + 1) * PTS_PER_STEP));
                    validSteps[i] = true;
                }
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Alle Zeitschritte erfolgreich in ${elapsed}s validiert und bereitgestellt!`);

        console.log('Konvertiere in hochoptimiertes Binär-Format...');
        const buffer = Buffer.from(masterInt16.buffer);
        const base64Str = buffer.toString('base64');
        console.log(`Base64-Größe: ${(base64Str.length / 1024 / 1024).toFixed(2)} MB`);

        const metadata = {
            nx: NX,
            ny: NY,
            dx: 0.25,
            dy: 0.25,
            la1: 90,
            lo1: 0,
            scale: 0.1,
            steps: steps.map(s => ({ hour: s.hour, timestamp: s.timestamp, timeMs: s.timeMs }))
        };

        const fileContent = `// GFS 0.25° Ultra-High-Resolution (1440x721 Grid, 25 Timesteps)
// Automatisch generiert von fetch_gfs_0p25.js
var tempMetadata = ${JSON.stringify(metadata)};
var tempB64 = "${base64Str}";

var tempData = (() => {
    const raw = typeof atob !== 'undefined' ? atob(tempB64) : Buffer.from(tempB64, 'base64').toString('binary');
    const len = raw.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const ptsPerStep = tempMetadata.nx * tempMetadata.ny;
    return tempMetadata.steps.map((s, idx) => {
        const sub = int16.subarray(idx * ptsPerStep, (idx + 1) * ptsPerStep);
        return {
            hour: s.hour,
            timestamp: s.timestamp,
            timeMs: s.timeMs,
            header: { nx: tempMetadata.nx, ny: tempMetadata.ny, dx: tempMetadata.dx, dy: tempMetadata.dy, la1: tempMetadata.la1, lo1: tempMetadata.lo1 },
            scale: tempMetadata.scale,
            data: sub
        };
    });
})();
tempB64 = null;
`;

        fs.writeFileSync('temp_data.js', fileContent);
        console.log('ERFOLG: temp_data.js wurde mit echten 0.25° GFS-Daten aktualisiert!');

        const manifest = {
            generatedAt: new Date().toISOString(),
            timestamp: Date.now(),
            stepsCount: steps.length,
            model: 'NOAA GFS 0.25deg',
            latestRun: steps[8] ? steps[8].timestamp : new Date().toISOString()
        };
        fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
        console.log('ERFOLG: manifest.json aktualisiert!');
    } catch (e) {
        console.error('Fehler:', e);
    }
}

run();

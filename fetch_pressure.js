const https = require('https');
const fs = require('fs');

const BASE_URL = 'https://thredds.ucar.edu/thredds/dodsC/grib/NCEP/GFS/Global_0p25deg/Best';
const NY = 181;
const NX = 360;
const PTS_PER_STEP = NY * NX; // 65,160

function fetchText(u, retries = 3, delayMs = 1200) {
    return new Promise((resolve, reject) => {
        function attempt(n) {
            https.get(u, res => {
                if (res.statusCode !== 200) {
                    if (n > 1) {
                        setTimeout(() => attempt(n - 1), delayMs);
                    } else {
                        reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
                    }
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', err => {
                if (n > 1) {
                    setTimeout(() => attempt(n - 1), delayMs);
                } else {
                    reject(err);
                }
            });
        }
        attempt(retries);
    });
}

function interp(valA, valB, pA, pB, threshold) {
    if (valA === valB) return (pA + pB) / 2;
    const t = (threshold - valA) / (valB - valA);
    return pA + t * (pB - pA);
}

// Fast O(N) segment chaining using vertex hash map into continuous polylines
function fastChainSegments(segs) {
    const key = (x, y) => `${Math.round(x * 100)}_${Math.round(y * 100)}`;
    const adj = new Map();
    const numSegs = segs.length / 4;
    const edges = [];

    for (let i = 0; i < numSegs; i++) {
        const p1 = [segs[i * 4], segs[i * 4 + 1]];
        const p2 = [segs[i * 4 + 2], segs[i * 4 + 3]];
        if (Math.abs(p1[0] - p2[0]) > 180) continue;

        const edge = { p1, p2, used: false };
        edges.push(edge);

        const k1 = key(p1[0], p1[1]);
        const k2 = key(p2[0], p2[1]);

        if (!adj.has(k1)) adj.set(k1, []);
        if (!adj.has(k2)) adj.set(k2, []);

        adj.get(k1).push({ edge, to: p2 });
        adj.get(k2).push({ edge, to: p1 });
    }

    const polylines = [];
    for (const edge of edges) {
        if (edge.used) continue;
        edge.used = true;

        const chain = [edge.p1, edge.p2];

        let curr = edge.p2;
        while (true) {
            const k = key(curr[0], curr[1]);
            const neighbors = adj.get(k) || [];
            let found = false;
            for (const n of neighbors) {
                if (!n.edge.used) {
                    n.edge.used = true;
                    chain.push(n.to);
                    curr = n.to;
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }

        curr = edge.p1;
        while (true) {
            const k = key(curr[0], curr[1]);
            const neighbors = adj.get(k) || [];
            let found = false;
            for (const n of neighbors) {
                if (!n.edge.used) {
                    n.edge.used = true;
                    chain.unshift(n.to);
                    curr = n.to;
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }

        polylines.push(chain);
    }
    return polylines;
}

// Chaikin's corner-cutting algorithm for smooth meteorological curves
function chaikin(points, iterations = 1) {
    if (points.length < 3) return points;
    let current = points;
    const isClosed = Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 0.15;

    for (let it = 0; it < iterations; it++) {
        const next = [];
        if (!isClosed) next.push(current[0]);

        const len = isClosed ? current.length : current.length - 1;
        for (let i = 0; i < len; i++) {
            const p0 = current[i];
            const p1 = current[(i + 1) % current.length];
            if (Math.abs(p0[0] - p1[0]) > 180) {
                next.push(p0, p1);
                continue;
            }
            const q = [
                0.75 * p0[0] + 0.25 * p1[0],
                0.75 * p0[1] + 0.25 * p1[1]
            ];
            const r = [
                0.25 * p0[0] + 0.75 * p1[0],
                0.25 * p0[1] + 0.75 * p1[1]
            ];
            next.push(q, r);
        }

        if (isClosed) {
            next.push([next[0][0], next[0][1]]);
        } else {
            next.push(current[current.length - 1]);
        }
        current = next;
    }
    return current;
}

// Flatten polyline points into compact 1-decimal array [x1, y1, x2, y2, ...]
function flattenPolyline(poly) {
    const flat = [];
    for (let i = 0; i < poly.length; i++) {
        flat.push(parseFloat(poly[i][0].toFixed(1)), parseFloat(poly[i][1].toFixed(1)));
    }
    return flat;
}

function processStep(gridHpa, computeIsobars = false) {
    // 1. Detect High and Low pressure centers
    const rad = 4;
    const rawCenters = [];
    for (let y = rad; y < NY - rad; y += 2) {
        const lat = 90 - y;
        for (let x = 0; x < NX; x += 2) {
            const val = gridHpa[y * NX + x];
            let isMin = true, isMax = true;
            for (let dy = -rad; dy <= rad; dy++) {
                for (let dx = -rad; dx <= rad; dx++) {
                    if (dy === 0 && dx === 0) continue;
                    const nyIdx = y + dy;
                    const nxIdx = ((x + dx) % NX + NX) % NX;
                    const neighbor = gridHpa[nyIdx * NX + nxIdx];
                    if (neighbor <= val) isMin = false;
                    if (neighbor >= val) isMax = false;
                }
            }
            const lon = x > 180 ? x - 360 : x;
            if (isMin && val <= 1012) {
                rawCenters.push({ type: 'T', pressure: val, lat, lon });
            } else if (isMax && val >= 1015) {
                rawCenters.push({ type: 'H', pressure: val, lat, lon });
            }
        }
    }

    // Filter duplicates within 12 degrees
    const centers = [];
    rawCenters.sort((a, b) => (a.type === 'T' ? a.pressure - b.pressure : b.pressure - a.pressure));
    for (const c of rawCenters) {
        const tooClose = centers.some(existing => {
            const dLat = existing.lat - c.lat;
            let dLon = Math.abs(existing.lon - c.lon);
            if (dLon > 180) dLon = 360 - dLon;
            const dDist = Math.sqrt(dLat * dLat + (dLon * Math.cos(c.lat * Math.PI / 180)) ** 2);
            return dDist < 12;
        });
        if (!tooClose) centers.push(c);
    }

    if (!computeIsobars) {
        return { centers, isobars: [] };
    }

    // 2. Marching Squares for isobars (synoptic levels in 4 hPa steps)
    const isobarLevels = [
        976, 984, 992, 996, 1000, 1004, 1008, 1012, 1016, 1020, 1024, 1028, 1032, 1036
    ];

    const isobars = [];
    for (const level of isobarLevels) {
        const segs = [];
        for (let j = 0; j < NY - 1; j++) {
            const lat0 = 90 - j;
            const lat1 = 90 - (j + 1);
            for (let i = 0; i < NX; i++) {
                const iNext = (i + 1) % NX;
                const lon0 = i > 180 ? i - 360 : i;
                let lon1 = (i + 1) > 180 ? (i + 1) - 360 : (i + 1);
                if (lon0 > 100 && lon1 < -100) lon1 += 360;

                const v00 = gridHpa[j * NX + i];
                const v10 = gridHpa[j * NX + iNext];
                const v01 = gridHpa[(j + 1) * NX + i];
                const v11 = gridHpa[(j + 1) * NX + iNext];

                let mask = 0;
                if (v00 >= level) mask |= 1;
                if (v10 >= level) mask |= 2;
                if (v11 >= level) mask |= 4;
                if (v01 >= level) mask |= 8;
                if (mask === 0 || mask === 15) continue;

                const top = [interp(v00, v10, lon0, lon1, level), lat0];
                const bottom = [interp(v01, v11, lon0, lon1, level), lat1];
                const left = [lon0, interp(v00, v01, lat0, lat1, level)];
                const right = [lon1, interp(v10, v11, lat0, lat1, level)];

                function addSeg(p1, p2) {
                    const fixLon = (lon) => lon > 180 ? lon - 360 : (lon < -180 ? lon + 360 : lon);
                    segs.push(
                        parseFloat(fixLon(p1[0]).toFixed(1)), parseFloat(p1[1].toFixed(1)),
                        parseFloat(fixLon(p2[0]).toFixed(1)), parseFloat(p2[1].toFixed(1))
                    );
                }

                switch (mask) {
                    case 1: case 14: addSeg(left, top); break;
                    case 2: case 13: addSeg(top, right); break;
                    case 3: case 12: addSeg(left, right); break;
                    case 4: case 11: addSeg(bottom, right); break;
                    case 5: addSeg(left, top); addSeg(bottom, right); break;
                    case 6: case 9:  addSeg(top, bottom); break;
                    case 7: case 8:  addSeg(left, bottom); break;
                    case 10: addSeg(top, right); addSeg(left, bottom); break;
                }
            }
        }

        if (segs.length > 0) {
            // Filter noise loops (keep chains >= 8 points) and apply Chaikin smoothing
            const chains = fastChainSegments(segs).filter(c => c.length >= 8);
            const smoothedChains = chains.map(c => chaikin(c, 1));

            const lines = [];
            const labels = [];
            for (const poly of smoothedChains) {
                if (poly.length < 4) continue;
                lines.push(flattenPolyline(poly));
                // Add nicely spaced labels along significant lines
                if (poly.length >= 16) {
                    const midIdx = Math.floor(poly.length / 2);
                    labels.push({ lon: poly[midIdx][0], lat: poly[midIdx][1] });
                }
            }

            if (lines.length > 0) {
                isobars.push({ level, lines, labels });
            }
        }
    }

    return { centers, isobars };
}

async function run() {
    try {
        console.log('=== Fetching NOAA GFS Pressure & Synoptic Isobars (Timeline) ===');
        const t0 = Date.now();

        // 1. Fetch time indices to align with temperature and wind timeline
        console.log('Determining reference date and time indices from THREDDS...');
        const das = await fetchText(`${BASE_URL}.das`);
        const timeBlockMatch = das.match(/time\s*\{[^}]*units\s+"Hour since ([^"]+)"/);
        if (!timeBlockMatch) throw new Error('Could not find base date for time in .das');
        const baseDate = new Date(timeBlockMatch[1]).getTime();

        const timeTxt = await fetchText(`${BASE_URL}.ascii?time`);
        const lines = timeTxt.split('\n').filter(l => /^\d/.test(l.trim()));
        const times = lines.join(',').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

        const nowHours = (Date.now() - baseDate) / 3600000;
        let bestIdx = 0, minDiff = Infinity;
        for (let i = 0; i < times.length; i++) {
            const diff = Math.abs(times[i] - nowHours);
            if (diff < minDiff) { minDiff = diff; bestIdx = i; }
        }

        // 25 steps: -24h to +48h in 3h cadence (25 steps), matching windData and temperature timeline
        const NUM_STEPS = 25;
        const startIdx = Math.max(0, bestIdx - 8);
        const stepsMeta = [];
        for (let i = 0; i < NUM_STEPS; i++) {
            const tIdx = startIdx + i;
            if (tIdx >= times.length) break;
            const hourVal = times[tIdx];
            const stepDate = new Date(baseDate + hourVal * 3600000);
            const hourOffset = (i - 8) * 3;
            stepsMeta.push({
                threddsIdx: tIdx,
                hour: hourOffset,
                timestamp: stepDate.toISOString(),
                timeMs: stepDate.getTime()
            });
        }

        console.log(`Live index: ${bestIdx} (${stepsMeta[8].timestamp})`);
        console.log(`Time window: -24h (${stepsMeta[0].timestamp}) to +${stepsMeta[stepsMeta.length - 1].hour}h (${stepsMeta[stepsMeta.length - 1].timestamp}) [${stepsMeta.length} steps]`);

        // 2. Fetch in chunks of 5 steps to balance payload size and latency
        const CHUNK_SIZE = 5;
        const allSteps = [];
        let liveGrid = null;

        for (let c = 0; c < stepsMeta.length; c += CHUNK_SIZE) {
            const chunkEnd = Math.min(stepsMeta.length, c + CHUNK_SIZE);
            const firstTIdx = stepsMeta[c].threddsIdx;
            const lastTIdx = stepsMeta[chunkEnd - 1].threddsIdx;
            const chunkCount = chunkEnd - c;

            console.log(`Fetching steps ${c + 1}..${chunkEnd}/${stepsMeta.length} (indices [${firstTIdx}:1:${lastTIdx}])...`);
            const chunkUrl = `${BASE_URL}.ascii?Pressure_reduced_to_MSL_msl[${firstTIdx}:1:${lastTIdx}][0:4:720][0:4:1439]`;
            const chunkText = await fetchText(chunkUrl);

            const parts = chunkText.split('Pressure_reduced_to_MSL_msl.Pressure_reduced_to_MSL_msl');
            if (parts.length < 2) throw new Error(`Parse error in chunk ${c}`);
            const dataBlock = parts[1].split('Pressure_reduced_to_MSL_msl.time')[0];

            const regex = /\d+\.\d+/g;
            let match;
            const nums = [];
            while ((match = regex.exec(dataBlock)) !== null) {
                nums.push(Math.round(parseFloat(match[0]) / 100));
            }

            for (let s = 0; s < chunkCount; s++) {
                const stepMeta = stepsMeta[c + s];
                const gridSlice = new Int16Array(nums.slice(s * PTS_PER_STEP, (s + 1) * PTS_PER_STEP));
                const isLive = (stepMeta.hour === 0);
                const processed = processStep(gridSlice, isLive);

                const compactGrid = Buffer.alloc(PTS_PER_STEP);
                for (let i = 0; i < gridSlice.length; i++) {
                    compactGrid[i] = Math.max(0, Math.min(255, gridSlice[i] - 900));
                }

                if (isLive || liveGrid === null) {
                    liveGrid = Array.from(compactGrid);
                }

                allSteps.push({
                    hour: stepMeta.hour,
                    timestamp: stepMeta.timestamp,
                    timeMs: stepMeta.timeMs,
                    centers: processed.centers,
                    isobars: isLive ? processed.isobars : undefined,
                    gridB64: compactGrid.toString('base64')
                });
            }
        }

        const liveStep = allSteps.find(s => s.hour === 0) || allSteps[8] || allSteps[0];
        console.log(`Total processed steps: ${allSteps.length}. Live step has ${liveStep.centers.length} centers, ${liveStep.isobars ? liveStep.isobars.length : 0} isobars.`);

        const outputData = {
            generatedAt: new Date().toISOString(),
            nx: NX,
            ny: NY,
            liveIndex: allSteps.indexOf(liveStep),
            grid: liveGrid,
            centers: liveStep.centers,
            isobars: liveStep.isobars || [],
            steps: allSteps
        };

        const jsContent = `// NOAA GFS Mean Sea Level Pressure (MSLP) & Synoptic Isobars (Full Timeline)
const pressureData = ${JSON.stringify(outputData)};
if (typeof window !== 'undefined') window.pressureData = pressureData;
if (typeof module !== 'undefined' && module.exports) module.exports = { pressureData };
`;
        fs.writeFileSync('pressure_data.js', jsContent, 'utf8');
        const sizeMb = (fs.statSync('pressure_data.js').size / (1024 * 1024)).toFixed(2);
        console.log(`✅ SUCCESS: Saved pressure_data.js (${sizeMb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

    } catch (e) {
        console.error('Error fetching pressure data:', e.message);
        process.exitCode = 1;
    }
}

run();

const https = require('https');
const fs = require('fs');

console.log('Fetching live NOAA GFS Mean Sea Level Pressure (MSLP)...');
const url = 'https://thredds.ucar.edu/thredds/dodsC/grib/NCEP/GFS/Global_0p25deg/Best.ascii?Pressure_reduced_to_MSL_msl[0][0:4:720][0:4:1439]';

function fetchText(u) {
    return new Promise((resolve, reject) => {
        https.get(u, res => {
            if (res.statusCode !== 200) {
                return reject(new Error('HTTP ' + res.statusCode));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function run() {
    try {
        const t0 = Date.now();
        const raw = await fetchText(url);
        console.log(`Downloaded in ${((Date.now() - t0)/1000).toFixed(1)}s`);

        const parts = raw.split('Pressure_reduced_to_MSL_msl.Pressure_reduced_to_MSL_msl');
        if (parts.length < 2) throw new Error('Data parsing failed');

        const rawNums = parts[1].match(/\d+\.\d+/g);
        if (!rawNums || rawNums.length < 65000) throw new Error('Insufficient points parsed: ' + (rawNums ? rawNums.length : 0));

        const ny = 181;
        const nx = 360;
        const gridHpa = new Int16Array(ny * nx);

        for (let i = 0; i < ny * nx; i++) {
            gridHpa[i] = Math.round(parseFloat(rawNums[i]) / 100);
        }

        // 1. Find High ('H') and Low ('T') Pressure Centers
        const rad = 4;
        const rawCenters = [];
        for (let y = rad; y < ny - rad; y += 2) {
            const lat = 90 - y;
            for (let x = 0; x < nx; x += 2) {
                const val = gridHpa[y * nx + x];
                let isMin = true;
                let isMax = true;
                for (let dy = -rad; dy <= rad; dy++) {
                    for (let dx = -rad; dx <= rad; dx++) {
                        if (dy === 0 && dx === 0) continue;
                        const nyIdx = y + dy;
                        const nxIdx = ((x + dx) % nx + nx) % nx;
                        const neighbor = gridHpa[nyIdx * nx + nxIdx];
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

        // Filter duplicates that are too close (keep strongest extremum)
        const centers = [];
        rawCenters.sort((a, b) => (a.type === 'T' ? a.pressure - b.pressure : b.pressure - a.pressure));
        for (const c of rawCenters) {
            const tooClose = centers.some(existing => {
                const dLat = existing.lat - c.lat;
                let dLon = Math.abs(existing.lon - c.lon);
                if (dLon > 180) dLon = 360 - dLon;
                const dDist = Math.sqrt(dLat * dLat + (dLon * Math.cos(c.lat * Math.PI / 180)) ** 2);
                return dDist < 12; // Minimum 12 degrees between centers
            });
            if (!tooClose) {
                centers.push(c);
            }
        }

        console.log(`Found ${centers.length} prominent High & Low pressure centers.`);

        // 2. Generate Isobar Lines using Marching Squares
        // Standard synoptic isobars in steps of 4 hPa
        const isobarLevels = [
            960, 968, 976, 984, 988, 992, 996, 
            1000, 1004, 1008, 1012, 1016, 1020, 1024, 1028, 1032, 1036, 1040
        ];

        function interp(valA, valB, pA, pB, threshold) {
            if (valA === valB) return (pA + pB) / 2;
            const t = (threshold - valA) / (valB - valA);
            return pA + t * (pB - pA);
        }

        const isobars = [];
        for (const level of isobarLevels) {
            const segs = [];
            const labels = [];
            for (let j = 0; j < ny - 1; j++) {
                const lat0 = 90 - j;
                const lat1 = 90 - (j + 1);
                for (let i = 0; i < nx; i++) {
                    const iNext = (i + 1) % nx;
                    const lon0 = i > 180 ? i - 360 : i;
                    let lon1 = (i + 1) > 180 ? (i + 1) - 360 : (i + 1);

                    // Avoid wrap-around jump at antimeridian
                    if (lon0 > 100 && lon1 < -100) lon1 += 360;

                    const v00 = gridHpa[j * nx + i];
                    const v10 = gridHpa[j * nx + iNext];
                    const v01 = gridHpa[(j + 1) * nx + i];
                    const v11 = gridHpa[(j + 1) * nx + iNext];

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
                        const c1 = [parseFloat(fixLon(p1[0]).toFixed(2)), parseFloat(p1[1].toFixed(2))];
                        const c2 = [parseFloat(fixLon(p2[0]).toFixed(2)), parseFloat(p2[1].toFixed(2))];
                        segs.push(c1[0], c1[1], c2[0], c2[1]);
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

            // Pick nicely spaced label anchor positions along the isobar
            if (segs.length > 20) {
                const step = Math.max(16, Math.floor(segs.length / 16));
                for (let k = 0; k < segs.length; k += step * 4) {
                    labels.push({ lon: segs[k], lat: segs[k + 1] });
                }
            }

            if (segs.length > 0) {
                isobars.push({ level, coords: segs, labels });
            }
        }

        console.log(`Generated ${isobars.length} isobar levels with smooth line segments.`);

        // 3. Compact representation of pressure grid (delta from 900 hPa)
        const compactGrid = [];
        for (let i = 0; i < gridHpa.length; i++) {
            compactGrid.push(Math.max(0, Math.min(255, gridHpa[i] - 900)));
        }

        const outputData = {
            timestamp: new Date().toISOString(),
            nx,
            ny,
            centers,
            isobars,
            grid: compactGrid
        };

        const jsContent = `// NOAA GFS Mean Sea Level Pressure (MSLP) & Synoptic Isobars
const pressureData = ${JSON.stringify(outputData)};
if (typeof window !== 'undefined') window.pressureData = pressureData;
if (typeof module !== 'undefined' && module.exports) module.exports = { pressureData };
`;
        fs.writeFileSync('pressure_data.js', jsContent, 'utf8');
        console.log(`Saved pressure_data.js (${fs.statSync('pressure_data.js').size.toLocaleString()} bytes).`);

    } catch (e) {
        console.error('Error fetching pressure data:', e.message);
    }
}

run();

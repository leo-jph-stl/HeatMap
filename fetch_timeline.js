const fs = require('fs');
const https = require('https');

// Dynamische Berechnung des aktuellen Zeitpunkts ("Live")
// Das Modell in PACIOOS basiert auf Stunden seit 2022-12-01 00:00:00 UTC
// Zeitschritt: exakt alle 3 Stunden (12, 15, 18, 21, 24...)
const baseTime = new Date('2022-12-01T00:00:00Z').getTime();
const currentHours = (Date.now() - baseTime) / 3600000;
const liveIndex = Math.round((currentHours - 12) / 3);

// 25 Zeitschritte: von -24h (8 Schritte zurück) bis +48h (16 Schritte voraus)
const startIndex = liveIndex - 8;
const endIndex = liveIndex + 16;
const numSteps = endIndex - startIndex + 1; // 25

console.log(`Live Index: ${liveIndex} (aktuellste Modell-Vorhersage für Jetzt)`);
console.log(`Zeitfenster: Index ${startIndex} (-24h) bis ${endIndex} (+48h), insgesamt ${numSteps} Schritte`);

const urlT = `https://pae-paha.pacioos.hawaii.edu/thredds/dodsC/ncep_global/NCEP_Global_Atmospheric_Model_best.ncd.ascii?tmp2m[${startIndex}:1:${endIndex}][0:1:360][0:1:719]`;
const urlU = `https://pae-paha.pacioos.hawaii.edu/thredds/dodsC/ncep_global/NCEP_Global_Atmospheric_Model_best.ncd.ascii?ugrd10m[${startIndex}:1:${endIndex}][0:2:360][0:2:719]`;
const urlV = `https://pae-paha.pacioos.hawaii.edu/thredds/dodsC/ncep_global/NCEP_Global_Atmospheric_Model_best.ncd.ascii?vgrd10m[${startIndex}:1:${endIndex}][0:2:360][0:2:719]`;

function fetchGrid(url, varName, isHalfDegree) {
    return new Promise((resolve, reject) => {
        console.log(`Lade ${varName} (${numSteps} Zeitstempel)... Dies kann einen Moment dauern.`);
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`Parse ${varName}...`);
                const parts = data.split(varName + '.' + varName);
                if (parts.length < 2) return reject("Fehler beim Parsen von " + varName);
                
                const dataBlock = parts[1].split(varName + '.time')[0];
                const arr = [];
                const regex = /-?\d+\.\d+/g;
                let match;
                while ((match = regex.exec(dataBlock)) !== null) {
                    let val = parseFloat(match[0]);
                    if (varName === 'tmp2m') {
                        if (val > 100) val -= 273.15; // Kelvin zu Celsius
                    }
                    arr.push(Math.round(val * 10) / 10);
                }
                
                const pointsPerStep = isHalfDegree ? (361 * 720) : (181 * 360);
                const timeSeries = [];
                for (let i = 0; i < numSteps; i++) {
                    const stepData = arr.slice(i * pointsPerStep, (i + 1) * pointsPerStep);
                    const stepIndex = startIndex + i;
                    const stepHours = 12 + stepIndex * 3;
                    const stepDate = new Date(baseTime + stepHours * 3600000);
                    const hourOffset = (i - 8) * 3;
                    timeSeries.push({ 
                        hour: hourOffset, 
                        timestamp: stepDate.toISOString(),
                        timeMs: stepDate.getTime(),
                        data: stepData 
                    });
                }
                
                resolve(timeSeries);
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        const tSeries = await fetchGrid(urlT, 'tmp2m', true);
        const headerT = { nx: 720, ny: 361, lo1: 0, la1: 90, dx: 0.5, dy: 0.5, parameterCategory: 0, parameterNumber: 0 };
        const tempJson = tSeries.map(t => ({ 
            hour: t.hour, 
            timestamp: t.timestamp,
            timeMs: t.timeMs,
            header: headerT, 
            data: t.data 
        }));
        fs.writeFileSync('temp_data.js', 'const tempData = ' + JSON.stringify(tempJson) + ';');
        console.log("ERFOLG: Temperatur-Timeline mit echten Live-Zeitstempeln gespeichert!");

        const uSeries = await fetchGrid(urlU, 'ugrd10m', false);
        const vSeries = await fetchGrid(urlV, 'vgrd10m', false);
        const headerW = { nx: 360, ny: 181, lo1: 0, la1: 90, dx: 1.0, dy: 1.0 };
        
        const windJson = [];
        for (let i = 0; i < numSteps; i++) {
            windJson.push({
                hour: uSeries[i].hour,
                timestamp: uSeries[i].timestamp,
                timeMs: uSeries[i].timeMs,
                u: { header: { ...headerW, parameterCategory: 2, parameterNumber: 2 }, data: uSeries[i].data },
                v: { header: { ...headerW, parameterCategory: 2, parameterNumber: 3 }, data: vSeries[i].data }
            });
        }
        
        fs.writeFileSync('wind_data.js', 'const windData = ' + JSON.stringify(windJson) + ';');
        console.log("ERFOLG: Wind-Timeline mit echten Live-Zeitstempeln gespeichert!");
    } catch (e) {
        console.error(e);
    }
}
run();

// Erzeugt aus dem privaten pv_data.json (das nach dem Login-Umbau NICHT mehr ins
// öffentliche Repo committet wird) eine bewusst anonymisierte, rein numerische
// Zeitreihe für den öffentlich sichtbaren PV-Produktions-Graphen. Kein Standortname,
// keine Koordinaten, keine Finanz-/Anlagengrößen-Felder - nur Zeitstempel + PV-Leistung.
const fs = require('fs');

const SOURCE_FILE = 'pv_data.json';
const OUTPUT_FILE = 'pv_public_series.json';

let source;
try {
    source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
} catch (e) {
    console.log(`${SOURCE_FILE} nicht lesbar (${e.message}) - überspringe Public-Series-Export.`);
    process.exit(0);
}

const history = Array.isArray(source.history_3d) ? source.history_3d : [];
const publicSeries = history
    .filter(p => p && typeof p.t === 'string' && typeof p.pv === 'number')
    .map(p => ({ t: p.t, pv: p.pv }));

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(publicSeries));
console.log(`${OUTPUT_FILE}: ${publicSeries.length} anonymisierte Datenpunkte geschrieben.`);

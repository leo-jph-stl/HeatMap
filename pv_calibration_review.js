// Wöchentliche Kalibrierungs-Überprüfung für die PV-Prognose (computePvForecast() in index.html).
// Läuft jeden Montag über update_pv_calibration_review.yml. Baut Woche für Woche eine echte
// Langzeit-Historie auf (pv_calibration_history.json), statt nur eine Momentaufnahme zu liefern -
// das ist der Sinn dieses wiederkehrenden Jobs.
//
// Rechnet exakt dieselbe Kalibrierung wie computePvForecast() in index.html: Median aus pv/ghi im
// mittleren Einstrahlungsband. Prüft dabei gezielt auf das Fehlerbild, das am 2026-09-10 gefunden
// wurde (siehe log_pv_forecast.js): mehrstündige, exakt identische Nicht-Null-Einstrahlungswerte -
// physikalisch unmöglich, Hinweis auf den (mittlerweile behobenen) Clamp-Fallback-Bug.
const fs = require('fs');

const LOG_FILE = 'pv_forecast_log.json';
const HISTORY_FILE = 'pv_calibration_history.json';
const TZ_OFFSET_MS = 2 * 3600 * 1000; // Europe/Berlin, September = CEST (UTC+2)

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeCalibration(rows) {
    let calib = rows.filter(r => r.ghi >= 50 && r.ghi <= 700);
    if (calib.length < 5) calib = rows.filter(r => r.ghi >= 30);
    if (calib.length < 5) return null;
    const ratios = calib.map(r => r.pv / r.ghi);
    return { medianRatio: median(ratios), sampleCount: calib.length };
}

function findDataQualityFlags(rows) {
    const flags = [];
    const sorted = [...rows].sort((a, b) => a.t - b.t);

    // Serien von >=3 aufeinanderfolgenden, bit-identischen NICHT-Null ghi-Werten: das exakte
    // Fehlerbild des Clamp-Bugs vom 2026-09-10. Ein wiederholtes exaktes 0 über viele Nachtstunden
    // ist dagegen völlig normal und wird bewusst NICHT markiert.
    let streakStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i].ghi === sorted[streakStart].ghi) continue;
        const streakLen = i - streakStart;
        if (streakLen >= 3 && sorted[streakStart].ghi > 1) {
            flags.push(`${streakLen}h konstant identisches ghi=${sorted[streakStart].ghi} von ${new Date(sorted[streakStart].t).toISOString()} bis ${new Date(sorted[i - 1].t).toISOString()} - vermutlich derselbe Clamp-Fallback-Bug wie am 2026-09-10, oder ein neues Analogon davon.`);
        }
        streakStart = i;
    }

    const negPv = sorted.filter(r => r.pv < 0);
    if (negPv.length) flags.push(`${negPv.length} Einträge mit negativer PV-Leistung (unmöglich).`);

    const badGhi = sorted.filter(r => r.ghi < 0 || r.ghi > 1200);
    if (badGhi.length) flags.push(`${badGhi.length} Einträge mit unplausibler Einstrahlung (<0 oder >1200 W/m²).`);

    for (let i = 1; i < sorted.length; i++) {
        const gapH = (sorted[i].t - sorted[i - 1].t) / 3600000;
        if (gapH > 48) {
            flags.push(`Lücke von ${gapH.toFixed(0)}h zwischen ${new Date(sorted[i - 1].t).toISOString()} und ${new Date(sorted[i].t).toISOString()} - update_pv.yml/log_pv_forecast.js könnte ausgesetzt haben.`);
        }
    }

    return flags;
}

function localDateStr(tMs) {
    return new Date(tMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function weeklyFitCheck(rows, medianRatio, capKw) {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const recent = rows.filter(r => r.t >= cutoff);
    const byDay = new Map();
    for (const r of recent) {
        const day = localDateStr(r.t);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(r);
    }

    const days = [];
    for (const [day, entries] of [...byDay.entries()].sort()) {
        const actualKwh = entries.reduce((s, r) => s + r.pv, 0);
        const modeledKwh = entries.reduce((s, r) => s + Math.min(capKw, r.ghi * medianRatio), 0);
        const pctError = actualKwh > 0.01 ? ((modeledKwh - actualKwh) / actualKwh) * 100 : null;
        days.push({ date: day, actualKwh: round2(actualKwh), modeledKwh: round2(modeledKwh), pctError: pctError !== null ? round2(pctError) : null });
    }

    const withError = days.filter(d => d.pctError !== null);
    const meanAbsPctError = withError.length
        ? round2(withError.reduce((s, d) => s + Math.abs(d.pctError), 0) / withError.length)
        : null;

    return { days, meanAbsPctError };
}

function round2(v) { return Math.round(v * 100) / 100; }

function run() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log(`${LOG_FILE} nicht gefunden - noch keine Kalibrierdaten vorhanden.`);
        return;
    }
    const rows = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (!rows.length) {
        console.log('Log ist leer.');
        return;
    }

    const calib = computeCalibration(rows);
    const flags = findDataQualityFlags(rows);
    const capKw = Math.max(...rows.map(r => r.pv)) * 1.05;
    const fit = calib ? weeklyFitCheck(rows, calib.medianRatio, capKw) : null;

    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { history = []; }
    }
    const previous = history.length ? history[history.length - 1] : null;

    const sorted = [...rows].sort((a, b) => a.t - b.t);
    const entry = {
        date: new Date().toISOString().slice(0, 10),
        sampleCount: calib ? calib.sampleCount : 0,
        medianRatio: calib ? round2(calib.medianRatio * 10000) / 10000 : null,
        logEntryCount: rows.length,
        logDateRange: { from: new Date(sorted[0].t).toISOString(), to: new Date(sorted[sorted.length - 1].t).toISOString() },
        dataQualityFlags: flags,
        weeklyFitCheck: fit
    };
    history.push(entry);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

    // Menschenlesbarer Bericht für die GitHub-Action (wird 1:1 als Issue gepostet)
    const lines = [];
    lines.push(`## PV-Kalibrierung – Wochenbericht ${entry.date}`);
    lines.push('');
    lines.push(`**Log:** ${entry.logEntryCount} Einträge, ${entry.logDateRange.from.slice(0, 10)} bis ${entry.logDateRange.to.slice(0, 10)}`);
    lines.push('');
    if (calib) {
        lines.push(`**Kalibrierfaktor:** ${calib.medianRatio.toFixed(5)} kW je W/m² (${calib.sampleCount} Samples)`);
        if (previous && previous.medianRatio !== null) {
            const diffPct = ((calib.medianRatio - previous.medianRatio) / previous.medianRatio) * 100;
            const trend = Math.abs(diffPct) < 2 ? 'stabil' : (diffPct > 0 ? 'gestiegen' : 'gesunken');
            lines.push(`Vorwoche (${previous.date}): ${previous.medianRatio.toFixed(5)} kW/W/m² → ${trend} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%).`);
        } else {
            lines.push('Erster Lauf – noch kein Vorwochenvergleich möglich.');
        }
    } else {
        lines.push('**Kalibrierfaktor:** nicht berechenbar (zu wenige verwertbare Samples im Log).');
    }
    lines.push('');
    lines.push('**Datenqualität:**');
    if (flags.length) {
        flags.forEach(f => lines.push(`- ⚠️ ${f}`));
    } else {
        lines.push('- Keine Auffälligkeiten gefunden.');
    }
    lines.push('');
    if (fit && fit.days.length) {
        lines.push('**Wochen-Fit-Check (In-Sample – misst, wie gut das Modell zu den Daten passt, aus denen es selbst kalibriert wurde; KEIN Test echter Vorhersagegüte, da keine im Voraus gespeicherten Prognosen existieren):**');
        lines.push('');
        lines.push('| Tag | Ist (kWh) | Modell (kWh) | Abweichung |');
        lines.push('|---|---|---|---|');
        fit.days.forEach(d => {
            lines.push(`| ${d.date} | ${d.actualKwh.toFixed(1)} | ${d.modeledKwh.toFixed(1)} | ${d.pctError !== null ? d.pctError.toFixed(1) + '%' : '–'} |`);
        });
        lines.push('');
        lines.push(`Mittlerer absoluter Fehler diese Woche: ${fit.meanAbsPctError !== null ? fit.meanAbsPctError.toFixed(1) + '%' : 'n/a'}`);
    } else {
        lines.push('**Wochen-Fit-Check:** keine vollständigen Tage in den letzten 7 Tagen im Log.');
    }
    lines.push('');
    lines.push('---');
    lines.push('_Automatisch erzeugt von pv_calibration_review.js. Historie: `pv_calibration_history.json`._');

    fs.writeFileSync('pv_calibration_report.md', lines.join('\n'));
    console.log(lines.join('\n'));
}

run();

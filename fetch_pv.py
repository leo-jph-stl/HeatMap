import os
import json
import re
import sys
import time
import hashlib
import urllib.request
import urllib.parse
import traceback
from datetime import datetime

# Koordinaten Hochheim am Main (Südstadt / Mainufer - gerundet für Privatsphäre)
PV_LAT = 50.008
PV_LNG = 8.350
LOCATION_NAME = "Hochheim am Main (Südstadt)"

# Alle möglichen Key-Varianten absuchen
env_keys = list(os.environ.keys())
print(f"=== FoxESS Abruf gestartet am {datetime.utcnow().isoformat()}Z ===")
print("Vorhandene Umgebungsvariablen (gefiltert):", [k for k in env_keys if any(w in k.upper() for w in ['FOX', 'USER', 'PASS', 'API', 'SECRET', 'VAR'])])

def get_first_env(keys):
    for k in keys:
        v = os.environ.get(k, "").strip()
        if v:
            print(f"  -> Wert gefunden unter Key: '{k}' (Länge: {len(v)})")
            return v
    return ""

print("Prüfe Umgebungsvariablen auf Anmeldedaten...")
username = get_first_env([
    "FOX_USERNAME", "FOXESS_USERNAME", "FOX_USER", "FOXUSER", "USERNAME_FOX",
    "SEC_FOX_USERNAME", "SEC_FOXESS_USERNAME", "SEC_USERNAME", "SEC_USER", 
    "SEC_NUTZERNAME", "SEC_BENUTZERNAME", "SEC_BENUTZER", "SEC_NUTZER", "SEC_EMAIL", "SEC_MAIL", "SEC_LOGIN", "SEC_FOX", "SEC_FOXESS",
    "VAR_FOX_USERNAME", "VAR_FOXESS_USERNAME", "VAR_FOX_USER", "VAR_USERNAME", "VAR_NUTZERNAME", "VAR_BENUTZERNAME"
])

password = get_first_env([
    "FOX_PASSWORD", "FOXESS_PASSWORD", "FOX_PASS", "FOXPASS", "PASSWORD_FOX",
    "SEC_FOX_PASSWORD", "SEC_FOXESS_PASSWORD", "SEC_PASSWORD", "SEC_PASS",
    "SEC_PASSWORT", "SEC_KENNWORT",
    "VAR_FOX_PASSWORD", "VAR_FOXESS_PASSWORD", "VAR_FOX_PASS", "VAR_PASSWORD", "VAR_PASSWORT"
])

api_key = get_first_env([
    "FOX_API_KEY", "FOXESS_API_KEY", "FOX_APIKEY", "FOXAPIKEY", "API_KEY",
    "SEC_FOX_API_KEY", "SEC_FOXESS_API_KEY", "SEC_API_KEY",
    "VAR_FOX_API_KEY", "VAR_FOXESS_API_KEY"
])

device_sn = get_first_env([
    "FOX_DEVICE_SN", "FOXESS_DEVICE_SN", "FOX_SN", "FOXSN", "DEVICE_SN",
    "SEC_FOX_DEVICE_SN", "SEC_FOXESS_DEVICE_SN", "SEC_DEVICE_SN",
    "VAR_FOX_DEVICE_SN"
])

print(f"Benutzername konfiguriert: {'Ja (' + username[:2] + '***)' if username else 'Nein'}")
print(f"Passwort konfiguriert: {'Ja (' + str(len(password)) + ' Zeichen)' if password else 'Nein'}")
print(f"API-Key konfiguriert: {'Ja (' + api_key[:4] + '***)' if api_key else 'Nein'}")
print(f"Geräte-SN konfiguriert: {'Ja (' + device_sn + ')' if device_sn else 'Nein'}")

if not username and not api_key:
    print("\nHINWEIS: Keine FoxESS Zugangsdaten in den Umgebungsvariablen gefunden.")
    print("Bitte prüfen Sie die genaue Schreibweise in GitHub Settings -> Secrets and variables -> Actions.")
    sys.exit(0)

FOX_TIME_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+[A-Za-z]*([+-]\d{4})$')


def normalize_fox_time(t):
    """Wandelt FoxESS-Zeitstempel ("2026-09-06 21:04:03 CEST+0200") in ISO 8601 um.
    JS' `new Date(...)` kann das FoxESS-Format (Zeitzonen-Kürzel + Offset kombiniert)
    nicht zuverlässig parsen und liefert sonst still `Invalid Date`."""
    if not t:
        return None
    m = FOX_TIME_RE.match(t)
    if not m:
        return t
    date_part, time_part, offset = m.groups()
    return f"{date_part}T{time_part}{offset[:3]}:{offset[3:]}"


def extract_metrics(raw_data):
    """Extrahiert einheitliche Messwerte aus verschiedenen FoxESS JSON-Strukturen."""
    pv_power = 0.0
    load_power = 0.0
    soc = 0
    bat_power = 0.0
    feed_in = 0.0
    today_yield = 0.0

    if not raw_data:
        return None

    # Falls Daten in 'result' eingepackt sind
    res = raw_data.get("result", raw_data) if isinstance(raw_data, dict) else raw_data

    # Falls result ein Array von Variablen ist (z.B. Open API real query)
    if isinstance(res, list):
        for item in res:
            if not isinstance(item, dict):
                continue
            name = item.get("variable", item.get("name", "")).lower()
            val = item.get("value", 0.0)
            try:
                val = float(val)
            except Exception:
                continue

            # Exakte FoxESS-Variablennamen (Groß-/Kleinschreibung ist bei der API relevant,
            # hier aber bereits kleingeschrieben verglichen)
            if name == "pvpower":
                pv_power = val
            elif name == "loadspower":
                load_power = val
            elif name == "soc":
                soc = int(round(val))
            elif name == "invbatpower":
                bat_power = val
            elif name == "feedinpower":
                feed_in = val
            elif name == "todayyield":
                today_yield = val

    elif isinstance(res, dict):
        # Falls Datas als Dict vorliegen
        pv_power = float(res.get("pvPower", res.get("pv_power", res.get("pv", 0.0))))
        load_power = float(res.get("loadsPower", res.get("load_power", res.get("load", 0.0))))
        soc = int(round(float(res.get("SoC", res.get("soc", res.get("battery_soc", 0))))))
        bat_power = float(res.get("invBatPower", res.get("bat_power", res.get("bat", 0.0))))
        feed_in = float(res.get("feedinPower", res.get("feed_in_power", res.get("grid_feed_in", 0.0))))
        today_yield = float(res.get("todayYield", res.get("today_yield", 0.0)))

    return {
        "solar_power": round(pv_power, 2),
        "house_load": round(load_power, 2),
        "battery_soc": soc,
        "battery_power": round(bat_power, 2),
        "grid_feed_in": round(feed_in, 2),
        "today_yield": round(today_yield, 2)
    }

metrics = None
extra_data = {}  # Gerätestatus, Wochen-/Monats-/Jahres-/Gesamtertrag, 3-Tage-Verlauf (nur via Strategie 1 verfügbar)

# STRATEGIE 1: Offizielle FoxESS Open API (falls API-Key vorhanden)
if api_key and not metrics:
    print("\n[Strategie 1] Versuche Abruf über offizielle FoxESS Open API...")
    import requests
    session_api = requests.Session()

    def call_fox_openapi(path, payload_data):
        url = f"https://www.foxesscloud.com{path}"
        ts = str(int(time.time() * 1000))
        # FoxESS Open API Signatur: path + \r\n + token + \r\n + timestamp
        to_sign = f"{path}\r\n{api_key}\r\n{ts}"
        sig = hashlib.md5(to_sign.encode("utf-8")).hexdigest()
        hdrs = {
            "token": api_key,
            "timestamp": ts,
            "signature": sig,
            "lang": "en",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0"
        }
        r = session_api.post(url, json=payload_data, headers=hdrs, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if data.get("errno") not in [0, "0"]:
                print(f"OpenAPI Fehler bei {path}: errno={data.get('errno')} msg={data.get('msg')}")
                return None  # Fehler-Antwort NICHT als gültiges Ergebnis werten
            return data
        print(f"OpenAPI HTTP {r.status_code} für {path}: {r.text[:200]}")
        return None

    try:
        sn = device_sn
        # Falls keine Seriennummer vorgegeben: aus Device-List holen
        if not sn:
            list_res = call_fox_openapi("/op/v0/device/list", {"pageSize": 10, "currentPage": 1})
            if list_res and list_res.get("errno") in [0, "0"]:
                devices = list_res.get("result", {}).get("data", [])
                if devices:
                    sn = devices[0].get("deviceSN")
                    print(f"Wechselrichter via OpenAPI erkannt: {sn}")

        # Real-Query mit den tatsächlichen FoxESS-Variablennamen (siehe offizielle Variable-Table;
        # "loadPower"/"soc"/"batPower"/"generationToday" existieren dort NICHT und werden von der
        # API stillschweigend ignoriert, wenn sie falsch benannt sind)
        variables = [
            "pvPower", "loadsPower", "SoC", "invBatPower", "feedinPower",
            "todayYield", "batChargePower", "batDischargePower",
            "gridConsumptionPower", "meterPower"
        ]

        real_res = None
        if sn:
            # v0 (deprecated, aber noch aktiv): singuläres "sn"
            real_res = call_fox_openapi("/op/v0/device/real/query", {"sn": sn, "variables": variables})
            if not real_res:
                # v1 (aktuell): erwartet "sns" als Array, nicht "sn"
                real_res = call_fox_openapi("/op/v1/device/real/query", {"sns": [sn], "variables": variables})

        if real_res:
            # result ist eine Liste pro Gerät: [{deviceSN, datas: [{variable, value}, ...]}]
            result = real_res.get("result")
            datas = result[0].get("datas", []) if isinstance(result, list) and result else []
            if datas:
                print(f"OpenAPI: {len(datas)} Messwerte erhalten: {[d.get('variable') for d in datas]}")
                metrics = extract_metrics({"result": datas})
            else:
                print(f"OpenAPI: Antwort ok, aber 'datas' ist leer (Gerät liefert evtl. andere Variablennamen). Rohantwort: {json.dumps(real_res)[:500]}")
        elif sn:
            print("OpenAPI: Weder v0 noch v1 lieferten eine gültige Antwort für sn", sn)

        # Zusatzdaten: Gerätestatus, Ertrag (Tag/Woche/Monat/Jahr/gesamt), 3-Tage-Verlauf
        if sn:
            def call_fox_openapi_get(path, params):
                url = f"https://www.foxesscloud.com{path}"
                ts = str(int(time.time() * 1000))
                to_sign = f"{path}\r\n{api_key}\r\n{ts}"
                sig = hashlib.md5(to_sign.encode("utf-8")).hexdigest()
                hdrs = {
                    "token": api_key, "timestamp": ts, "signature": sig,
                    "lang": "en", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"
                }
                r = session_api.get(url, params=params, headers=hdrs, timeout=15)
                if r.status_code == 200:
                    data = r.json()
                    if data.get("errno") not in [0, "0"]:
                        print(f"OpenAPI Fehler (GET) bei {path}: errno={data.get('errno')} msg={data.get('msg')}")
                        return None
                    return data
                print(f"OpenAPI HTTP {r.status_code} (GET) für {path}: {r.text[:200]}")
            # Lokale Zeitzone der FoxESS-Anlage in Deutschland (Europe/Berlin):
            # Verhindert, dass zwischen 00:00 und 02:00 MESZ das falsche Datum (UTC-Versatz) abgefragt wird
            try:
                from zoneinfo import ZoneInfo
                tz_plant = ZoneInfo("Europe/Berlin")
                now = datetime.now(tz_plant)
            except Exception:
                from datetime import timezone, timedelta
                now = datetime.now(timezone(timedelta(hours=2)))

            time.sleep(1.1)
            detail_res = call_fox_openapi_get("/op/v1/device/detail", {"sn": sn})
            if detail_res:
                status_code = detail_res.get("result", {}).get("status")
                extra_data["device_status"] = {1: "online", 2: "fault", 3: "offline"}.get(status_code, "unknown")
                print(f"Gerätestatus: {extra_data['device_status']}")

            time.sleep(1.1)
            gen_res = call_fox_openapi_get("/op/v0/device/generation", {"sn": sn})
            if gen_res:
                g = gen_res.get("result", {})
                if g.get("today") is not None:
                    extra_data["today_yield"] = round(float(g["today"]), 2)
                if g.get("month") is not None:
                    extra_data["month_yield"] = round(float(g["month"]), 2)
                if g.get("cumulative") is not None:
                    extra_data["cumulative_yield"] = round(float(g["cumulative"]), 2)

            time.sleep(1.1)
            year_res = call_fox_openapi("/op/v0/device/report/query", {
                "sn": sn, "year": now.year, "dimension": "year", "variables": ["generation"]
            })
            if year_res:
                res_list = year_res.get("result", [])
                if res_list:
                    vals = [v for v in res_list[0].get("values", []) if isinstance(v, (int, float))]
                    extra_data["year_yield"] = round(sum(vals), 2)

            time.sleep(1.1)
            month_res = call_fox_openapi("/op/v0/device/report/query", {
                "sn": sn, "year": now.year, "month": now.month, "dimension": "month", "variables": ["generation"]
            })
            week_vals = []
            if month_res:
                res_list = month_res.get("result", [])
                if res_list:
                    vals = [v for v in res_list[0].get("values", []) if isinstance(v, (int, float))]
                    # Werte sind pro Kalendertag indiziert (Index 0 = Tag 1) und für den ganzen
                    # Monat vorbelegt -> nur bis "heute" nehmen, sonst zählen unerreichte Tage als 0 mit
                    week_vals = vals[:now.day][-7:]
                    if len(week_vals) < 7:
                        missing = 7 - len(week_vals)
                        prev_month = now.month - 1 or 12
                        prev_year = now.year if now.month > 1 else now.year - 1
                        time.sleep(1.1)
                        prev_res = call_fox_openapi("/op/v0/device/report/query", {
                            "sn": sn, "year": prev_year, "month": prev_month, "dimension": "month", "variables": ["generation"]
                        })
                        if prev_res:
                            prev_list = prev_res.get("result", [])
                            if prev_list:
                                prev_vals = [v for v in prev_list[0].get("values", []) if isinstance(v, (int, float))]
                                week_vals = prev_vals[-missing:] + week_vals
            if week_vals:
                extra_data["week_yield"] = round(sum(week_vals), 2)

            from datetime import timedelta
            # Stündliche Tagesberichte für heute und die letzten 3 Tage abrufen (24-Stunden-Vektoren)
            daily_reports = {}
            archive_file = "pv_daily_history.json"
            if os.path.exists(archive_file):
                try:
                    with open(archive_file, "r", encoding="utf-8") as f:
                        daily_reports = json.load(f)
                except Exception as ex:
                    print(f"Hinweis: Konnte {archive_file} nicht laden: {ex}")

            report_vars = ["feedin", "gridConsumption", "chargeEnergyToTal", "dischargeEnergyToTal", "generation", "loads"]

            # 1. Monatsabfragen für August und September 2026 (liefert aggregierte Tagessummen)
            for m in [8, 9]:
                if m > now.month and now.year == 2026:
                    continue
                time.sleep(1.1)
                m_res = call_fox_openapi("/op/v0/device/report/query", {
                    "sn": sn, "year": 2026, "month": m, "dimension": "month",
                    "variables": report_vars
                })
                if m_res and m_res.get("errno") in [0, "0"]:
                    m_list = m_res.get("result", [])
                    days_in_m = 31 if m == 8 else 30
                    for d_idx in range(days_in_m):
                        day_num = d_idx + 1
                        if m == now.month and day_num > now.day:
                            break
                        d_key = f"2026-{m:02d}-{day_num:02d}"
                        if d_key not in daily_reports:
                            daily_reports[d_key] = {"hours": list(range(24)), "totals": {}}
                        for item in m_list:
                            v_name = item.get("variable")
                            vals = item.get("values", [])
                            if d_idx < len(vals) and isinstance(vals[d_idx], (int, float)):
                                daily_reports[d_key]["totals"][v_name] = round(float(vals[d_idx]), 2)

            # 2. Stündliche 24h-Vektoren abfragen:
            # Heute und gestern immer aktualisieren, fehlende Tage ab 01.08.2026 schrittweise nachladen
            days_to_fetch = [0, 1]  # Heute und gestern
            start_date = datetime(2026, 8, 1, tzinfo=now.tzinfo)
            cur = now - timedelta(days=2)
            missing_days = []
            while cur >= start_date:
                d_key = cur.strftime("%Y-%m-%d")
                entry = daily_reports.get(d_key)
                has_hourly = entry and isinstance(entry.get("generation"), list) and len(entry["generation"]) == 24 and any(v > 0 for v in entry["generation"])
                if not has_hourly:
                    missing_days.append(cur)
                cur -= timedelta(days=1)

            # Pro Durchlauf bis zu 15 fehlende Tage nachladen (schont FoxESS Rate-Limits)
            for m_day in missing_days[:15]:
                days_to_fetch.append(m_day)

            for target_item in days_to_fetch:
                target_date = target_item if isinstance(target_item, datetime) else (now - timedelta(days=target_item))
                date_key = target_date.strftime("%Y-%m-%d")
                time.sleep(1.1)
                day_res = call_fox_openapi("/op/v0/device/report/query", {
                    "sn": sn, "year": target_date.year, "month": target_date.month, "day": target_date.day,
                    "dimension": "day",
                    "variables": report_vars
                })
                if day_res and day_res.get("errno") in [0, "0"]:
                    res_list = day_res.get("result", [])
                    day_entry = daily_reports.get(date_key, {"hours": list(range(24)), "totals": {}})
                    day_entry["hours"] = list(range(24))
                    for item in res_list:
                        var_name = item.get("variable")
                        vals = [round(float(v), 3) if isinstance(v, (int, float)) else 0.0 for v in item.get("values", [])]
                        if len(vals) < 24:
                            vals = vals + [0.0] * (24 - len(vals))
                        else:
                            vals = vals[:24]
                        day_entry[var_name] = vals
                        day_entry["totals"][var_name] = round(sum(vals), 2)
                    
                    if any(day_entry["totals"].get(k, 0) > 0 for k in ["feedin", "generation", "gridConsumption", "loads"]):
                        daily_reports[date_key] = day_entry

                    if date_key == now.strftime("%Y-%m-%d"):
                        totals = day_entry.get("totals", {})
                        if "feedin" in totals: extra_data["today_feedin"] = totals["feedin"]
                        if "gridConsumption" in totals: extra_data["today_grid_import"] = totals["gridConsumption"]
                        if "chargeEnergyToTal" in totals: extra_data["today_battery_charge"] = totals["chargeEnergyToTal"]
                        if "dischargeEnergyToTal" in totals: extra_data["today_battery_discharge"] = totals["dischargeEnergyToTal"]

            try:
                with open(archive_file, "w", encoding="utf-8") as f:
                    json.dump(daily_reports, f, indent=2, ensure_ascii=False)
                print(f"Tagesberichte im Archiv gespeichert: {list(daily_reports.keys())}")
            except Exception as ex:
                print(f"Fehler beim Speichern von {archive_file}: {ex}")

            extra_data["daily_reports"] = daily_reports

            # Bestehenden Verlauf als Fallback laden, falls API vorübergehend keine History liefert
            existing_history_3d = []
            if os.path.exists("pv_data.json"):
                try:
                    with open("pv_data.json", "r", encoding="utf-8") as f:
                        old_d = json.load(f)
                        existing_history_3d = old_d.get("history_3d", [])
                except Exception:
                    pass

            datas = []
            for vname in ["pvPower", "feedinPower", "loadsPower"]:
                time.sleep(1.1)
                res = call_fox_openapi("/op/v0/device/history/query", {"sn": sn, "variables": [vname]})
                if res and res.get("result"):
                    s_datas = res.get("result", [])[0].get("datas", [])
                    if s_datas:
                        datas.extend(s_datas)

            if datas:
                # 5-Minuten-Slots synchronisieren (tolerant gegenüber Zeitstempel-Verschiebungen)
                slots = {}
                for d in datas:
                    vname = (d.get("variable") or "").strip()
                    for point in d.get("data", []):
                        t_raw = point.get("time")
                        t_norm = normalize_fox_time(t_raw)
                        if not t_norm:
                            continue
                        try:
                            val = round(float(point.get("value", 0)), 3)
                        except (TypeError, ValueError):
                            continue
                        
                        try:
                            dt = datetime.fromisoformat(t_norm)
                            epoch = dt.timestamp()
                            slot_epoch = int(round(epoch / 300.0) * 300)
                            slot_dt = datetime.fromtimestamp(slot_epoch, tz=dt.tzinfo)
                            slot_key = slot_dt.isoformat()
                        except Exception:
                            slot_key = t_norm
                        
                        if slot_key not in slots:
                            slots[slot_key] = {"t": slot_key, "pv": 0.0, "feedin": 0.0, "loads": 0.0}
                        
                        if vname == "pvPower":
                            slots[slot_key]["pv"] = val
                        elif vname == "feedinPower":
                            slots[slot_key]["feedin"] = val
                        elif vname == "loadsPower":
                            slots[slot_key]["loads"] = val

                history_3d = sorted(slots.values(), key=lambda x: x["t"])
                if history_3d:
                    extra_data["history_3d"] = history_3d
                    print(f"3-Tage-Verlauf: {len(history_3d)} synchrone Datenpunkte (PV, Feedin, Loads)")

            if "history_3d" not in extra_data and existing_history_3d:
                extra_data["history_3d"] = existing_history_3d
                print(f"Bestehenden 3-Tage-Verlauf aus Cache erhalten ({len(existing_history_3d)} Datenpunkte)")
    except Exception as e:
        print(f"OpenAPI Abruf fehlgeschlagen: {e}")
        traceback.print_exc()

# STRATEGIE 2: FoxESS Cloud Web-Login mit initialer Cookie-Session & mobilen Headern
if username and password and not metrics:
    print("\n[Strategie 2] Versuche FoxESS Cloud Login mit Session & Cookie-Initialisierung...")
    import requests
    
    pwd_md5 = hashlib.md5(password.encode("utf-8")).hexdigest()
    session = requests.Session()

    # Schritt 1: Initialer GET-Aufruf zur Cookie-Initialisierung
    try:
        r_init = session.get("https://www.foxesscloud.com/login", headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "de,en-US;q=0.7,en;q=0.3"
        }, timeout=10)
        print(f"Cookie-Init Status: HTTP {r_init.status_code}, Erhaltene Cookies: {list(session.cookies.get_dict().keys())}")
    except Exception as e:
        print("Cookie-Init Warnung:", e)

    endpoints = [
        "https://www.foxesscloud.com/c/v0/user/login",
        "https://foxesscloud.com/c/v0/user/login",
        "https://www.foxesscloud.com/c/v1/user/login"
    ]
    
    headers_browser = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "de,en-US;q=0.7,en;q=0.3",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://www.foxesscloud.com",
        "Referer": "https://www.foxesscloud.com/login"
    }

    token = None
    successful_endpoint_base = "https://www.foxesscloud.com"

    for ep in endpoints:
        if token:
            break
        for p_val, p_desc in [(pwd_md5, "MD5"), (password, "Plain")]:
            for u_key in ["user", "username"]:
                try:
                    r = session.post(ep, json={u_key: username, "password": p_val}, headers=headers_browser, timeout=10)
                    print(f"Login {ep} ({p_desc}, Key={u_key}): HTTP {r.status_code}")
                    if r.status_code == 200:
                        data = r.json()
                        print(f"  -> Antwort: errno={data.get('errno')}, msg={data.get('msg')}")
                        if data.get("errno") in [0, "0", None] and data.get("result", {}).get("token"):
                            token = data["result"]["token"]
                            successful_endpoint_base = "/".join(ep.split("/")[:3])
                            print(f"✅ Login ERFOLGREICH! Token erhalten.")
                            break
                    elif r.status_code != 406:
                        print(f"  -> Status {r.status_code}: {r.text[:100]}")
                except Exception as ex:
                    print(f"  -> Fehler bei {ep}: {ex}")
            if token:
                break

    if token:
        try:
            req_headers = {
                "token": token,
                "Content-Type": "application/json;charset=UTF-8",
                "User-Agent": headers_browser["User-Agent"],
                "Origin": "https://www.foxesscloud.com",
                "Referer": "https://www.foxesscloud.com/",
                "lang": "en"
            }
            sn = device_sn
            if not sn:
                try:
                    r_addr = session.post(f"{successful_endpoint_base}/c/v0/device/addressbook", json={}, headers=req_headers, timeout=10)
                    if r_addr.status_code == 200:
                        devs = r_addr.json().get("result", {}).get("devices", [])
                        if devs:
                            sn = devs[0].get("deviceSN")
                            print(f"Wechselrichter Seriennummer gefunden: {sn}")
                except Exception as e:
                    print("Adressbuch-Abfrage:", e)

            query_url = f"{successful_endpoint_base}/c/v0/device/real/query"
            payload = {"sn": sn} if sn else {}
            r_query = session.post(query_url, json=payload, headers=req_headers, timeout=15)
            if r_query.status_code == 200:
                query_res = r_query.json()
                print("Live-Messdaten empfangen:", query_res.get("errno"), query_res.get("msg", ""))
                metrics = extract_metrics(query_res)
            else:
                print(f"Query HTTP {r_query.status_code}: {r_query.text[:150]}")
        except Exception as e:
            print("Fehler beim Abruf der Messdaten nach Login:", e)

# STRATEGIE 3: foxesscloud Python-Paket als Fallback
if not metrics:
    print("\n[Strategie 3] Versuche Fallback über foxesscloud Library...")
    try:
        try:
            import foxesscloud.foxesscloud as fox
        except Exception:
            import foxesscloud as fox

        print("Verfügbare foxesscloud Funktionen:", [m for m in dir(fox) if not m.startswith('_')])

        if username: fox.username = username
        if password: fox.password = password
        if device_sn: fox.device_sn = device_sn

        # Teste alle verfügbaren Methoden
        for method_name in ['get_realtime', 'get_raw', 'get_device', 'get_site', 'get_status', 'get_earnings']:
            if hasattr(fox, method_name):
                try:
                    fn = getattr(fox, method_name)
                    print(f"Rufe fox.{method_name}() auf...")
                    res = fn()
                    print(f"Ergebnis von {method_name}:", res)
                    m = extract_metrics(res)
                    if m and m.get("solar_power", 0) > 0 or m.get("battery_soc", 0) > 0:
                        metrics = m
                        break
                except Exception as ex:
                    print(f"Fehler bei fox.{method_name}(): {ex}")
    except Exception as e:
        print(f"Library-Fallback fehlgeschlagen: {e}")

if not metrics:
    print("\n[WARNUNG] Es konnten keine Live-Daten von FoxESS bezogen werden.")
    print("Bitte Zugangsdaten in GitHub Secrets prüfen (oder unter foxesscloud.com einen API-Key erstellen).")
    sys.exit(1)

# Daten erfolgreich generiert: JSON und JS schreiben
pv_data = {
    "location": {
        "name": LOCATION_NAME,
        "lat": PV_LAT,
        "lng": PV_LNG
    },
    **metrics,
    **extra_data,
    "status": extra_data.get("device_status", "online"),
    "last_updated": datetime.utcnow().isoformat() + "Z"
}

with open("pv_data.json", "w", encoding="utf-8") as f:
    json.dump(pv_data, f, indent=2, ensure_ascii=False)

with open("pv_data.js", "w", encoding="utf-8") as f:
    f.write(f"window.foxessPvData = {json.dumps(pv_data, indent=2, ensure_ascii=False)};\n")

print(f"\n✅ ERFOLG: Live-PV-Daten für {LOCATION_NAME} erfolgreich gespeichert!")
print(f"Erzeugung: {pv_data['solar_power']} kW | Hausverbrauch: {pv_data['house_load']} kW | Batterie: {pv_data['battery_soc']}% | Einspeisung: {pv_data['grid_feed_in']} kW")



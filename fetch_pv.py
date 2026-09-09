import os
import json
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

            if "pvpower" in name or name == "pv":
                pv_power = val
            elif "loadpower" in name or name == "load":
                load_power = val
            elif "soc" in name or name == "batsoc":
                soc = int(round(val))
            elif "batpower" in name or name == "bat":
                bat_power = val
            elif "feedinpower" in name or "gridpower" in name:
                feed_in = val
            elif "todayyield" in name or "generation" in name:
                today_yield = val

    elif isinstance(res, dict):
        # Falls Datas als Dict vorliegen
        pv_power = float(res.get("pvPower", res.get("pv_power", res.get("pv", 0.0))))
        load_power = float(res.get("loadPower", res.get("load_power", res.get("load", 0.0))))
        soc = int(round(float(res.get("soc", res.get("SoC", res.get("battery_soc", 0))))))
        bat_power = float(res.get("batPower", res.get("bat_power", res.get("bat", 0.0))))
        feed_in = float(res.get("feedInPower", res.get("feed_in_power", res.get("grid_feed_in", 0.0))))
        today_yield = float(res.get("todayYield", res.get("generationToday", res.get("today_yield", 0.0))))

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

        # Real-Query mit allen Standard-Variablen
        variables = [
            "pvPower", "loadPower", "soc", "batPower", "feedinPower",
            "todayYield", "generationToday", "batChargePower", "batDischargePower",
            "gridConsumptionPower", "invBatPower", "meterPower"
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
                return None

            now = datetime.utcnow()

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
            if month_res:
                res_list = month_res.get("result", [])
                if res_list:
                    vals = [v for v in res_list[0].get("values", []) if isinstance(v, (int, float))]
                    extra_data["week_yield"] = round(sum(vals[-7:]), 2)

            time.sleep(1.1)
            history_res = call_fox_openapi("/op/v0/device/history/query", {"sn": sn, "variables": ["pvPower"]})
            if history_res:
                res_list = history_res.get("result", [])
                if res_list:
                    history_3d = []
                    for d in res_list[0].get("datas", []):
                        if d.get("variable") == "pvPower":
                            for point in d.get("data", []):
                                try:
                                    history_3d.append({"t": point.get("time"), "pv": round(float(point.get("value", 0)), 3)})
                                except (TypeError, ValueError):
                                    continue
                    if history_3d:
                        extra_data["history_3d"] = history_3d
                        print(f"3-Tage-Verlauf: {len(history_3d)} Datenpunkte")
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



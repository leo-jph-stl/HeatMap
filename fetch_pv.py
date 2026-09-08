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

# STRATEGIE 1: Offizielle FoxESS Open API (falls API-Key vorhanden)
if api_key and not metrics:
    print("\n[Strategie 1] Versuche Abruf über offizielle FoxESS Open API...")
    try:
        path = "op/v1/device/real/query"
        url = f"https://www.foxesscloud.com/{path}"
        ts = str(int(time.time() * 1000))
        to_sign = f"{path}\\r\\n{api_key}\\r\\n{ts}"
        sig = hashlib.md5(to_sign.encode("utf-8")).hexdigest()

        headers = {
            "token": api_key,
            "timestamp": ts,
            "signature": sig,
            "lang": "en",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0"
        }
        payload = {"sn": device_sn} if device_sn else {}
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as response:
            res_json = json.loads(response.read().decode("utf-8"))
            print("OpenAPI Antwort erhalten:", res_json.get("errno"), res_json.get("msg", ""))
            metrics = extract_metrics(res_json)
    except Exception as e:
        print(f"OpenAPI Abruf fehlgeschlagen: {e}")

# STRATEGIE 2: FoxESS Cloud Web-Login mit requests.Session & vollständigen Browser-Headern
if username and password and not metrics:
    print("\n[Strategie 2] Versuche FoxESS Cloud Web-Login mit Session...")
    try:
        import requests
        session = requests.Session()
        browser_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://www.foxesscloud.com",
            "Referer": "https://www.foxesscloud.com/login",
            "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "lang": "en"
        }
        session.headers.update(browser_headers)

        pwd_md5 = hashlib.md5(password.encode("utf-8")).hexdigest()
        
        login_url = "https://www.foxesscloud.com/c/v0/user/login"
        login_res_json = None

        # Versuch A: MD5-Passwort
        try:
            r = session.post(login_url, json={"user": username, "password": pwd_md5}, timeout=15)
            print(f"Login-Versuch (MD5) HTTP Status: {r.status_code}")
            if r.status_code == 200:
                login_res_json = r.json()
        except Exception as e:
            print("Login A (MD5) Fehler:", e)

        # Versuch B: Plaintext Passwort falls MD5 417/400 liefert
        if not login_res_json or login_res_json.get("errno") not in [0, "0", None]:
            try:
                r = session.post(login_url, json={"user": username, "password": password}, timeout=15)
                print(f"Login-Versuch (Plain) HTTP Status: {r.status_code}")
                if r.status_code == 200:
                    login_res_json = r.json()
            except Exception as e:
                print("Login B (Plain) Fehler:", e)

        if login_res_json:
            print("FoxESS Login Antwort:", login_res_json.get("errno"), login_res_json.get("msg", ""))
            token = login_res_json.get("result", {}).get("token")
            if token:
                session.headers.update({"token": token})
                print("✅ Login erfolgreich! Token erhalten.")
                
                # Seriennummer ermitteln falls nicht vorgegeben
                sn = device_sn
                if not sn:
                    try:
                        r_addr = session.post("https://www.foxesscloud.com/c/v0/device/addressbook", json={}, timeout=10)
                        if r_addr.status_code == 200:
                            devs = r_addr.json().get("result", {}).get("devices", [])
                            if devs:
                                sn = devs[0].get("deviceSN")
                                print(f"Wechselrichter Seriennummer gefunden: {sn}")
                    except Exception as e:
                        print("Adressbuch-Abfrage:", e)

                query_url = "https://www.foxesscloud.com/c/v0/device/real/query"
                payload = {"sn": sn} if sn else {}
                r_query = session.post(query_url, json=payload, timeout=15)
                if r_query.status_code == 200:
                    query_res = r_query.json()
                    print("Live-Messdaten empfangen:", query_res.get("errno"), query_res.get("msg", ""))
                    metrics = extract_metrics(query_res)
    except Exception as e:
        print(f"Direkter Web-Login fehlgeschlagen: {e}")
        traceback.print_exc()

# STRATEGIE 3: foxesscloud Python-Paket als Fallback
if not metrics:
    print("\n[Strategie 3] Versuche Fallback über foxesscloud Library...")
    try:
        try:
            import foxesscloud.foxesscloud as fox
        except Exception:
            import foxesscloud as fox

        if username: fox.username = username
        if password: fox.password = password
        if api_key: fox.pv_api_key = api_key
        if device_sn: fox.device_sn = device_sn

        if hasattr(fox, 'get_realtime'):
            data = fox.get_realtime()
            metrics = extract_metrics(data)
        elif hasattr(fox, 'get_raw'):
            data = fox.get_raw(summary=1)
            metrics = extract_metrics(data)
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
    "status": "online",
    "last_updated": datetime.utcnow().isoformat() + "Z"
}

with open("pv_data.json", "w", encoding="utf-8") as f:
    json.dump(pv_data, f, indent=2, ensure_ascii=False)

with open("pv_data.js", "w", encoding="utf-8") as f:
    f.write(f"window.foxessPvData = {json.dumps(pv_data, indent=2, ensure_ascii=False)};\n")

print(f"\n✅ ERFOLG: Live-PV-Daten für {LOCATION_NAME} erfolgreich gespeichert!")
print(f"Erzeugung: {pv_data['solar_power']} kW | Hausverbrauch: {pv_data['house_load']} kW | Batterie: {pv_data['battery_soc']}% | Einspeisung: {pv_data['grid_feed_in']} kW")



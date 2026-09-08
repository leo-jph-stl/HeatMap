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

username = os.environ.get("FOX_USERNAME", "").strip()
password = os.environ.get("FOX_PASSWORD", "").strip()
api_key = os.environ.get("FOX_API_KEY", "").strip()
device_sn = os.environ.get("FOX_DEVICE_SN", "").strip()

print(f"=== FoxESS Abruf gestartet am {datetime.utcnow().isoformat()}Z ===")
print(f"Benutzername konfiguriert: {'Ja (' + username[:3] + '***)' if username else 'Nein'}")
print(f"Passwort konfiguriert: {'Ja' if password else 'Nein'}")
print(f"API-Key konfiguriert: {'Ja (' + api_key[:4] + '***)' if api_key else 'Nein'}")

if not username and not api_key:
    print("HINWEIS: Keine FoxESS Zugangsdaten in den GitHub Secrets hinterlegt.")
    print("Bitte FOX_USERNAME und FOX_PASSWORD (oder FOX_API_KEY) in den GitHub Secrets eintragen.")
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

# STRATEGIE 2: Direkter FoxESS Cloud Web-Login mit Benutzername & Passwort
if username and password and not metrics:
    print("\n[Strategie 2] Versuche direkten FoxESS Cloud Web-Login...")
    try:
        login_url = "https://www.foxesscloud.com/c/v0/user/login"
        pwd_md5 = hashlib.md5(password.encode("utf-8")).hexdigest()
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "lang": "en"
        }
        login_payload = {"user": username, "password": pwd_md5}
        req = urllib.request.Request(login_url, data=json.dumps(login_payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as response:
            login_res = json.loads(response.read().decode("utf-8"))
            print("Cloud-Login Antwort:", login_res.get("errno"), login_res.get("msg", ""))
            token = login_res.get("result", {}).get("token")

        if token:
            print("Login erfolgreich, Token erhalten! Frage Live-Messwerte ab...")
            real_headers = {
                "token": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                "lang": "en"
            }
            # Optional: Seriennummer aus Adressbuch holen
            sn = device_sn
            if not sn:
                try:
                    list_url = "https://www.foxesscloud.com/c/v0/device/addressbook"
                    req_list = urllib.request.Request(list_url, data=b"{}", headers=real_headers, method="POST")
                    with urllib.request.urlopen(req_list, timeout=10) as resp:
                        l_data = json.loads(resp.read().decode("utf-8"))
                        devices = l_data.get("result", {}).get("devices", [])
                        if devices:
                            sn = devices[0].get("deviceSN")
                            print(f"Wechselrichter erkannt: {sn}")
                except Exception as e:
                    print("Adressbuch-Abfrage:", e)

            query_url = "https://www.foxesscloud.com/c/v0/device/real/query"
            query_payload = {"sn": sn} if sn else {}
            req_query = urllib.request.Request(query_url, data=json.dumps(query_payload).encode("utf-8"), headers=real_headers, method="POST")
            with urllib.request.urlopen(req_query, timeout=15) as response:
                query_res = json.loads(response.read().decode("utf-8"))
                print("Live-Messdaten erhalten:", query_res.get("errno"), query_res.get("msg", ""))
                metrics = extract_metrics(query_res)

    except Exception as e:
        print(f"Direkter Web-Login fehlgeschlagen: {e}")

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



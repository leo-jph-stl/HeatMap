import os
import json
import sys
from datetime import datetime

# Koordinaten Hochheim am Main (Südstadt / Mainufer - gerundet für Privatsphäre)
PV_LAT = 50.008
PV_LNG = 8.350
LOCATION_NAME = "Hochheim am Main (Südstadt)"

username = os.environ.get("FOX_USERNAME")
password = os.environ.get("FOX_PASSWORD")

if not username or not password:
    print("HINWEIS: FOX_USERNAME oder FOX_PASSWORD Umgebungsvariablen nicht gesetzt.")
    print("Falls noch keine Secrets hinterlegt sind, wird eine Vorlage für die UI bereitgestellt.")
    # Falls noch keine Zugangsdaten hinterlegt sind, stellen wir eine gültige Standardstruktur bereit
    if not os.path.exists("pv_data.json"):
        default_data = {
            "location": {
                "name": LOCATION_NAME,
                "lat": PV_LAT,
                "lng": PV_LNG
            },
            "solar_power": 0.0,
            "house_load": 0.0,
            "battery_soc": 0,
            "battery_power": 0.0,
            "grid_feed_in": 0.0,
            "today_yield": 0.0,
            "status": "waiting_for_credentials",
            "last_updated": datetime.utcnow().isoformat() + "Z"
        }
        with open("pv_data.json", "w", encoding="utf-8") as f:
            json.dump(default_data, f, indent=2, ensure_ascii=False)
        with open("pv_data.js", "w", encoding="utf-8") as f:
            f.write(f"window.foxessPvData = {json.dumps(default_data, indent=2, ensure_ascii=False)};\n")
    sys.exit(0)

try:
    import foxesscloud
    foxesscloud.username = username
    foxesscloud.password = password

    # Realtime-Daten von FoxESS abrufen
    data = foxesscloud.get_realtime()
    
    # Werte extrahieren (Einheiten standardisiert in kW / %)
    pv_power = float(data.get("pvPower", 0.0))
    load_power = float(data.get("loadPower", 0.0))
    soc = int(round(float(data.get("soc", 0))))
    bat_power = float(data.get("batPower", 0.0))
    feed_in = float(data.get("feedInPower", 0.0))
    today_yield = float(data.get("todayYield", data.get("generationToday", 0.0)))

    pv_data = {
        "location": {
            "name": LOCATION_NAME,
            "lat": PV_LAT,
            "lng": PV_LNG
        },
        "solar_power": round(pv_power, 2),        # kW
        "house_load": round(load_power, 2),        # kW
        "battery_soc": soc,                        # %
        "battery_power": round(bat_power, 2),      # kW (+ Entladen, - Laden)
        "grid_feed_in": round(feed_in, 2),         # kW (+ Einspeisung, - Bezug)
        "today_yield": round(today_yield, 2),      # kWh
        "status": "online",
        "last_updated": datetime.utcnow().isoformat() + "Z"
    }

    with open("pv_data.json", "w", encoding="utf-8") as f:
        json.dump(pv_data, f, indent=2, ensure_ascii=False)
    with open("pv_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.foxessPvData = {json.dumps(pv_data, indent=2, ensure_ascii=False)};\n")

    print("FoxESS PV-Daten erfolgreich aktualisiert:", pv_data)

except Exception as e:
    print(f"Fehler beim Abruf der FoxESS Daten: {e}")
    if not os.path.exists("pv_data.json"):
        err_data = {
            "location": { "name": LOCATION_NAME, "lat": PV_LAT, "lng": PV_LNG },
            "solar_power": 0.0,
            "house_load": 0.0,
            "battery_soc": 0,
            "status": f"error: {str(e)}",
            "last_updated": datetime.utcnow().isoformat() + "Z"
        }
        with open("pv_data.json", "w", encoding="utf-8") as f:
            json.dump(err_data, f, indent=2, ensure_ascii=False)
        with open("pv_data.js", "w", encoding="utf-8") as f:
            f.write(f"window.foxessPvData = {json.dumps(err_data, indent=2, ensure_ascii=False)};\n")

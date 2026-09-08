import os
import json
import sys
import traceback
from datetime import datetime

# Koordinaten Hochheim am Main (Südstadt / Mainufer - gerundet für Privatsphäre)
PV_LAT = 50.008
PV_LNG = 8.350
LOCATION_NAME = "Hochheim am Main (Südstadt)"

username = os.environ.get("FOX_USERNAME")
password = os.environ.get("FOX_PASSWORD")
api_key = os.environ.get("FOX_API_KEY")
device_sn = os.environ.get("FOX_DEVICE_SN")

print(f"--- FoxESS Abruf gestartet am {datetime.utcnow().isoformat()}Z ---")
print(f"Benutzername gesetzt: {'Ja' if username else 'Nein'}")
print(f"Passwort gesetzt: {'Ja' if password else 'Nein'}")
print(f"API-Key gesetzt: {'Ja' if api_key else 'Nein'}")

if not username and not api_key:
    print("HINWEIS: Keine FoxESS Zugangsdaten in den GitHub Secrets gefunden.")
    print("Bitte FOX_USERNAME und FOX_PASSWORD in den Repository Secrets anlegen.")
    sys.exit(0)

try:
    try:
        import foxesscloud.foxesscloud as fox
    except Exception:
        import foxesscloud as fox

    if username:
        fox.username = username
    if password:
        fox.password = password
    if api_key:
        fox.pv_api_key = api_key
    if device_sn:
        fox.device_sn = device_sn

    print("Verbinde mit FoxESS Cloud...")
    
    # Realtime-Daten von FoxESS abrufen
    data = None
    if hasattr(fox, 'get_realtime'):
        try:
            data = fox.get_realtime()
            print("Daten via get_realtime() empfangen:", data)
        except Exception as e:
            print(f"get_realtime() fehlgeschlagen: {e}")

    if not data and hasattr(fox, 'get_raw'):
        try:
            data = fox.get_raw(summary=1)
            print("Daten via get_raw() empfangen:", data)
        except Exception as e:
            print(f"get_raw() fehlgeschlagen: {e}")

    if not data:
        raise ValueError("FoxESS hat keine Messwerte zurückgegeben. Bitte Zugangsdaten / Accountstatus prüfen.")

    # Werte extrahieren (Einheiten standardisiert in kW / %)
    if isinstance(data, dict):
        pv_power = float(data.get("pvPower", data.get("pv_power", data.get("generation", 0.0))))
        load_power = float(data.get("loadPower", data.get("load_power", data.get("loads", 0.0))))
        soc = int(round(float(data.get("soc", data.get("SoC", data.get("battery_soc", 0))))))
        bat_power = float(data.get("batPower", data.get("bat_power", data.get("battery_power", 0.0))))
        feed_in = float(data.get("feedInPower", data.get("feed_in_power", data.get("grid_feed_in", 0.0))))
        today_yield = float(data.get("todayYield", data.get("generationToday", data.get("today_yield", 0.0))))
    else:
        print("Unerwarteter Datentyp:", type(data), data)
        pv_power = 0.0
        load_power = 0.0
        soc = 0
        bat_power = 0.0
        feed_in = 0.0
        today_yield = 0.0

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

    print("FoxESS PV-Daten erfolgreich aktualisiert und gespeichert:", pv_data)

except Exception as e:
    print(f"FEHLER beim Abruf der FoxESS Daten: {e}")
    traceback.print_exc()
    sys.exit(1)


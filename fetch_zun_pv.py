import os
import json
import sys
import time
import urllib.request
import urllib.parse
import traceback
from datetime import datetime, timezone, date

# Standard-Fallback-Standort für zun PV (kann via ZUN_LAT, ZUN_LNG, ZUN_LOCATION_NAME konfiguriert werden)
DEFAULT_PV_LAT = 50.1109
DEFAULT_PV_LNG = 8.6821
DEFAULT_LOCATION_NAME = "zun PV-Anlage"

API_BASE = "https://dashboard-service.myzun.de"

def get_env_token():
    for k in ["ZUN_API_TOKEN", "ZUN_TOKEN", "SEC_ZUN_API_TOKEN", "VAR_ZUN_API_TOKEN"]:
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return ""

def api_get(endpoint, token, params=None):
    url = f"{API_BASE}{endpoint}"
    if params:
        query_str = urllib.parse.urlencode(params)
        url = f"{url}?{query_str}"
    
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeatMap/2.5"
        }
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        content = resp.read().decode("utf-8")
        try:
            return json.loads(content)
        except Exception:
            return content

def parse_kw(val):
    if val is None:
        return 0.0
    try:
        f = float(val)
        return round(f / 1000.0, 3) if f > 100.0 else round(f, 3)
    except Exception:
        return 0.0

def main():
    print(f"=== zun PV Abruf gestartet am {datetime.now(timezone.utc).isoformat()} ===")
    token = get_env_token()
    if not token:
        print("[HINWEIS] Kein ZUN_API_TOKEN in den Umgebungsvariablen / GitHub Secrets gefunden.")
        print("Bitte 'ZUN_API_TOKEN' unter GitHub Settings -> Secrets and variables -> Actions anlegen.")
        sys.exit(0)
    
    print("ZUN_API_TOKEN gefunden. Frage Wechselrichter bei myzun ab...")

    inverter_id = os.environ.get("ZUN_INVERTER_ID", "").strip()
    inverter_meta = {}
    try:
        inv_data = api_get("/inverter", token)
        print("Antwort /inverter erhalten.")
        if isinstance(inv_data, dict):
            if "inverter" in inv_data and isinstance(inv_data["inverter"], dict):
                inverter_id = inv_data["inverter"].get("id") or inverter_id
                inverter_meta = inv_data["inverter"]
            elif "id" in inv_data:
                inverter_id = inv_data.get("id") or inverter_id
                inverter_meta = inv_data
        elif isinstance(inv_data, list) and len(inv_data) > 0:
            inverter_id = inv_data[0].get("id") or inverter_id
            inverter_meta = inv_data[0]
    except Exception as e:
        print(f"Fehler beim Abruf von /inverter: {e}")

    if not inverter_id:
        print("[FEHLER] Keine Wechselrichter-ID ermittelt.")
        sys.exit(1)

    print(f"Wechselrichter-ID: {inverter_id}")

    # Live-Status abfragen
    status_data = {}
    try:
        status_data = api_get("/inverter/status", token, {"inverterId": inverter_id})
    except Exception as e:
        print(f"Hinweis /inverter/status: {e}")

    # Batterie-SoC abfragen
    battery_soc = None
    try:
        bat_res = api_get("/inverter/network/battery", token, {"inverterId": inverter_id})
        if isinstance(bat_res, dict):
            raw_bat = bat_res.get("battery", 0)
            battery_soc = raw_bat if raw_bat <= 100 else round(raw_bat)
        elif isinstance(bat_res, (int, float)):
            battery_soc = round(bat_res)
    except Exception as e:
        print(f"Hinweis /inverter/network/battery: {e}")

    # Tages-Summen abfragen (tRPC)
    today_iso = date.today().isoformat()
    day_sum = {}
    try:
        trpc_input = json.dumps({"inverterId": inverter_id, "date": today_iso})
        trpc_res = api_get("/trpc/inverter.network.sum", token, {"input": trpc_input})
        if isinstance(trpc_res, dict) and "result" in trpc_res and "data" in trpc_res["result"]:
            day_sum = trpc_res["result"]["data"].get("json", trpc_res["result"]["data"])
    except Exception as e:
        print(f"Hinweis tRPC inverter.network.sum: {e}")

    # Tages-Verlaufshistorie abfragen
    history_records = []
    try:
        hist_res = api_get("/inverter/network/history", token, {
            "inverterId": inverter_id,
            "date": today_iso,
            "resolution": "1 minute"
        })
        if isinstance(hist_res, list):
            history_records = hist_res
    except Exception as e:
        print(f"Hinweis /inverter/network/history: {e}")

    # Metriken berechnen
    solar_power = parse_kw(status_data.get("p_creation") or day_sum.get("p_creation_now") or status_data.get("solar_power"))
    house_load = parse_kw(status_data.get("p_usage") or day_sum.get("p_usage_now") or status_data.get("house_load"))
    grid_feed_in = parse_kw(status_data.get("p_grid_in") or day_sum.get("p_grid_in_now") or status_data.get("grid_feed_in"))
    grid_import = parse_kw(status_data.get("p_grid_out") or day_sum.get("p_grid_out_now") or status_data.get("grid_import"))
    battery_power = parse_kw(status_data.get("p_battery") or day_sum.get("p_battery_now"))

    net_grid = -grid_import if (grid_import > 0 and grid_feed_in == 0) else grid_feed_in

    today_yield = float(day_sum.get("p_creation") or status_data.get("today_yield") or 0.0)
    today_feedin = float(day_sum.get("p_grid_in") or status_data.get("today_feedin") or 0.0)
    today_grid_import = float(day_sum.get("p_grid_out") or status_data.get("today_grid_import") or 0.0)

    # Standort
    loc_lat = float(os.environ.get("ZUN_LAT", DEFAULT_PV_LAT))
    loc_lng = float(os.environ.get("ZUN_LNG", DEFAULT_PV_LNG))
    loc_name = os.environ.get("ZUN_LOCATION_NAME", DEFAULT_LOCATION_NAME)

    # Historische Tagesberichte
    daily_reports = {}
    if os.path.exists("zun_daily_history.json"):
        try:
            with open("zun_daily_history.json", "r", encoding="utf-8") as f:
                daily_reports = json.load(f)
        except Exception:
            pass

    if history_records:
        hourly_map = {h: {"gen": 0.0, "use": 0.0, "feed": 0.0, "count": 0} for h in range(24)}
        for pt in history_records:
            t_str = pt.get("time") or pt.get("timestamp")
            if t_str:
                try:
                    dt = datetime.fromisoformat(t_str.replace("Z", "+00:00"))
                    h = dt.hour
                    hourly_map[h]["gen"] += parse_kw(pt.get("p_creation") or pt.get("generation"))
                    hourly_map[h]["use"] += parse_kw(pt.get("p_usage") or pt.get("usage"))
                    hourly_map[h]["feed"] += parse_kw(pt.get("p_grid_in") or pt.get("feed_in"))
                    hourly_map[h]["count"] += 1
                except Exception:
                    pass
        
        hours_list = []
        gen_list = []
        use_list = []
        feed_list = []
        for h in range(24):
            cnt = hourly_map[h]["count"]
            hours_list.append(h)
            gen_list.append(round(hourly_map[h]["gen"] / cnt, 2) if cnt > 0 else 0.0)
            use_list.append(round(hourly_map[h]["use"] / cnt, 2) if cnt > 0 else 0.0)
            feed_list.append(round(hourly_map[h]["feed"] / cnt, 2) if cnt > 0 else 0.0)

        daily_reports[today_iso] = {
            "hours": hours_list,
            "generation": gen_list,
            "usage": use_list,
            "feed_in": feed_list,
            "total_yield": round(today_yield, 2)
        }

    with open("zun_daily_history.json", "w", encoding="utf-8") as f:
        json.dump(daily_reports, f, indent=2, ensure_ascii=False)

    zun_data = {
        "location": {
            "name": loc_name,
            "lat": loc_lat,
            "lng": loc_lng
        },
        "solar_power": round(solar_power, 2),
        "house_load": round(house_load, 2),
        "battery_soc": battery_soc if battery_soc is not None else 0,
        "battery_power": round(battery_power, 2),
        "grid_feed_in": round(net_grid, 2),
        "today_yield": round(today_yield, 1),
        "today_feedin": round(today_feedin, 1),
        "today_grid_import": round(today_grid_import, 1),
        "device_status": "online",
        "daily_reports": daily_reports,
        "last_updated": datetime.now(timezone.utc).isoformat()
    }

    with open("zun_pv_data.json", "w", encoding="utf-8") as f:
        json.dump(zun_data, f, indent=2, ensure_ascii=False)

    with open("zun_pv_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.zunPvData = {json.dumps(zun_data, indent=2, ensure_ascii=False)};\n")

    print(f"\n✅ ERFOLG: Live-PV-Daten für {loc_name} erfolgreich gespeichert!")
    print(f"Erzeugung: {zun_data['solar_power']} kW | Hausverbrauch: {zun_data['house_load']} kW | Batterie: {zun_data['battery_soc']}% | Einspeisung: {zun_data['grid_feed_in']} kW")

if __name__ == "__main__":
    main()

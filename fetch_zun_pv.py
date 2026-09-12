import os
import json
import sys
import time
import urllib.request
import urllib.parse
import traceback
from datetime import datetime, timezone, date, timedelta

# Standard-Standort für zun PV (Weilbach bei Flörsheim am Main)
DEFAULT_PV_LAT = 50.045
DEFAULT_PV_LNG = 8.436
DEFAULT_LOCATION_NAME = "Weilbach (Flörsheim am Main)"

API_BASE = "https://dashboard-service.myzun.de"

try:
    from zoneinfo import ZoneInfo
    BERLIN_TZ = ZoneInfo("Europe/Berlin")
except Exception:
    BERLIN_TZ = timezone(timedelta(hours=2))

def to_berlin_dt(dt_val):
    try:
        return dt_val.astimezone(BERLIN_TZ)
    except Exception:
        return dt_val.astimezone(timezone(timedelta(hours=2)))

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
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    now_utc = datetime.now(timezone.utc)
    print(f"=== zun PV Abruf gestartet am {now_utc.isoformat()} ===")
    token = get_env_token()
    is_offline_reprocess = "--offline" in sys.argv or (not token and os.environ.get("ZUN_OFFLINE"))

    if not token and not is_offline_reprocess:
        print("[HINWEIS] Kein ZUN_API_TOKEN in den Umgebungsvariablen / GitHub Secrets gefunden.")
        print("Bitte 'ZUN_API_TOKEN' unter GitHub Settings -> Secrets and variables -> Actions anlegen.")
        sys.exit(0)

    inverter_id = (os.environ.get("ZUN_INVERTER_ID") or "").strip()
    status_data = {}
    battery_soc = None
    day_sum = {}
    all_raw_records = []

    if token:
        print("ZUN_API_TOKEN gefunden. Frage Wechselrichter bei myzun ab...")
        try:
            inv_data = api_get("/inverter", token)
            print("Antwort /inverter:", inv_data)
            if isinstance(inv_data, dict):
                if "inverter" in inv_data and isinstance(inv_data["inverter"], dict):
                    inverter_id = inv_data["inverter"].get("id") or inverter_id
                elif "id" in inv_data:
                    inverter_id = inv_data.get("id") or inverter_id
            elif isinstance(inv_data, list) and len(inv_data) > 0:
                inverter_id = inv_data[0].get("id") or inverter_id
        except Exception as e:
            print(f"Fehler beim Abruf von /inverter: {e}")

        if not inverter_id:
            print("[FEHLER] Keine Wechselrichter-ID ermittelt.")
            sys.exit(1)

        print(f"Wechselrichter-ID: {inverter_id}")
        inv_id_val = int(inverter_id) if str(inverter_id).isdigit() else inverter_id

        # 1. Live-Status abfragen
        try:
            status_res = api_get("/inverter/status", token, {"inverterId": inv_id_val})
            if isinstance(status_res, dict):
                status_data = status_res
                print("Antwort /inverter/status:", status_data)
        except Exception as e:
            print(f"Hinweis /inverter/status: {e}")

        # 2. Batterie-SoC abfragen
        try:
            bat_res = api_get("/inverter/network/battery", token, {"inverterId": inv_id_val})
            print("Antwort /inverter/network/battery:", bat_res)
            if isinstance(bat_res, dict):
                raw_bat = bat_res.get("battery", 0)
                battery_soc = raw_bat if raw_bat <= 100 else round(raw_bat)
            elif isinstance(bat_res, (int, float)):
                battery_soc = round(bat_res)
        except Exception as e:
            print(f"Hinweis /inverter/network/battery: {e}")

        # 3. Tages-Summen abfragen (tRPC)
        today_iso = now_utc.strftime("%Y-%m-%d")
        trpc_payload = {"inverterId": inv_id_val, "date": today_iso}
        try:
            batch_input = json.dumps({"0": trpc_payload})
            trpc_res = api_get("/trpc/inverter.network.sum", token, {"batch": "1", "input": batch_input})
            if isinstance(trpc_res, list) and len(trpc_res) > 0:
                res_obj = trpc_res[0]
                if "result" in res_obj and "data" in res_obj["result"]:
                    day_sum = res_obj["result"]["data"].get("json", res_obj["result"]["data"])
            elif isinstance(trpc_res, dict) and "result" in trpc_res:
                day_sum = trpc_res["result"].get("data", {}).get("json", trpc_res["result"].get("data", {}))
            print("Antwort inverter.network.sum (batch):", day_sum)
        except Exception as e_batch:
            print(f"Hinweis tRPC batch inverter.network.sum: {e_batch}")
            try:
                solo_input = json.dumps(trpc_payload)
                trpc_res = api_get("/trpc/inverter.network.sum", token, {"input": solo_input})
                if isinstance(trpc_res, dict) and "result" in trpc_res:
                    day_sum = trpc_res["result"].get("data", {}).get("json", trpc_res["result"].get("data", {}))
                print("Antwort inverter.network.sum (standalone):", day_sum)
            except Exception as e_solo:
                print(f"Hinweis tRPC standalone inverter.network.sum: {e_solo}")

        # 4. Verlaufshistorie der letzten 3 Tage abfragen (Vorgestern, Gestern, Heute)
        days_to_query = [(now_utc - timedelta(days=d)).strftime("%Y-%m-%d") for d in (2, 1, 0)]
        for d_query in days_to_query:
            try:
                print(f"Lade Verlauf für {d_query}...")
                hist_res = api_get("/inverter/network/history", token, {
                    "inverterId": inv_id_val,
                    "date": d_query,
                    "resolution": "1 minute"
                })
                if isinstance(hist_res, list) and len(hist_res) > 0:
                    print(f"-> {len(hist_res)} Rohdatenpunkte für {d_query} geladen.")
                    all_raw_records.extend(hist_res)
            except Exception as e:
                print(f"Hinweis /inverter/network/history für {d_query}: {e}")
    else:
        print("[OFFLINE-MODUS] Verarbeite bestehende lokale Daten neu...")
        if os.path.exists("zun_pv_data.json"):
            try:
                with open("zun_pv_data.json", "r", encoding="utf-8") as f:
                    prev_d = json.load(f)
                    for p in prev_d.get("history_3d", []):
                        all_raw_records.append({
                            "time": p.get("t"),
                            "p_creation": p.get("pv"),
                            "p_usage": p.get("load") or p.get("loads"),
                            "p_grid_in": p.get("feed") or p.get("feedin"),
                            "p_grid_out": p.get("grid_import"),
                            "soc_battery_avg": p.get("soc")
                        })
                    status_data = prev_d
                    battery_soc = prev_d.get("battery_soc")
            except Exception as e:
                print(f"Fehler beim Laden lokaler Daten: {e}")

    # Bisherige Historie laden
    prev_history = []
    if os.path.exists("zun_pv_data.json"):
        try:
            with open("zun_pv_data.json", "r", encoding="utf-8") as f:
                prev_d = json.load(f)
                prev_history = prev_d.get("history_3d", [])
        except Exception:
            pass

    for p in prev_history:
        t_s = p.get("t")
        if t_s:
            all_raw_records.append({
                "time": t_s,
                "p_creation": p.get("pv"),
                "p_usage": p.get("load") or p.get("loads"),
                "p_grid_in": p.get("feed") or p.get("feedin"),
                "p_grid_out": p.get("grid_import"),
                "soc_battery_avg": p.get("soc")
            })

    # Punkte bereinigen, validieren und nach Zeit deduplizieren
    seen_map = {}
    for pt in all_raw_records:
        t_str = pt.get("time") or pt.get("timestamp")
        if not t_str:
            continue
        try:
            dt = datetime.fromisoformat(t_str.replace("Z", "+00:00"))
        except Exception:
            continue
        
        # Rigorose Filterung: Niemals Zeitpunkte nach aktuellem Zeitpunkt (+2 Min Puffer)
        if dt > now_utc + timedelta(minutes=2):
            continue

        pv_val = parse_kw(pt.get("p_creation") or pt.get("generation"))
        load_val = parse_kw(pt.get("p_usage") or pt.get("usage"))
        feed_val = parse_kw(pt.get("p_grid_in") or pt.get("feed_in"))
        grid_in_val = parse_kw(pt.get("p_grid_out") or pt.get("grid_import"))
        soc_val = pt.get("soc_battery_avg") or pt.get("battery") or 0
        if isinstance(soc_val, float):
            soc_val = round(soc_val)

        seen_map[t_str] = {
            "dt": dt,
            "t": t_str,
            "pv": pv_val,
            "load": load_val,
            "loads": load_val,
            "feed": feed_val,
            "feedin": feed_val,
            "grid_import": grid_in_val,
            "soc": soc_val
        }

    clean_points = sorted(seen_map.values(), key=lambda p: p["dt"])

    # Zukünftige leere Platzhalter (0-Werte) am Ende des heutigen Tages abschneiden
    last_active_idx = len(clean_points) - 1
    while last_active_idx >= 0:
        p = clean_points[last_active_idx]
        if p["pv"] > 0 or p["load"] > 0 or p["feed"] > 0 or (p["soc"] and p["soc"] > 0):
            break
        # Wenn der Punkt innerhalb der letzten 2 Stunden liegt und alle Werte 0 sind, ist es ein unbeschriebener Zukunftsslot
        if (now_utc - p["dt"]).total_seconds() < 7200:
            last_active_idx -= 1
        else:
            break

    if last_active_idx >= 0 and last_active_idx < len(clean_points) - 1:
        clean_points = clean_points[:last_active_idx + 1]

    print(f"Bereinigte historische Messpunkte: {len(clean_points)}")
    last_pt = clean_points[-1] if clean_points else None
    if last_pt:
        print(f"Letzter Messpunkt: {last_pt['t']} (PV: {last_pt['pv']} kW, Haus: {last_pt['load']} kW, Feed: {last_pt['feed']} kW, SOC: {last_pt['soc']}%)")

    # Live-Metriken mit Fallback auf letzten Messpunkt
    solar_power = parse_kw(status_data.get("p_creation") or day_sum.get("p_creation") or day_sum.get("p_creation_now") or status_data.get("solar_power"))
    if solar_power == 0.0 and last_pt and (now_utc - last_pt["dt"]).total_seconds() <= 3600:
        solar_power = last_pt["pv"]

    house_load = parse_kw(status_data.get("p_usage") or day_sum.get("p_usage") or day_sum.get("p_usage_now") or status_data.get("house_load"))
    if house_load == 0.0 and last_pt and (now_utc - last_pt["dt"]).total_seconds() <= 3600:
        house_load = last_pt["load"]

    grid_feed_in = parse_kw(status_data.get("p_grid_in") or day_sum.get("p_grid_in") or day_sum.get("p_grid_in_now") or status_data.get("grid_feed_in"))
    if grid_feed_in == 0.0 and last_pt and (now_utc - last_pt["dt"]).total_seconds() <= 3600:
        grid_feed_in = last_pt["feed"]

    grid_import = parse_kw(status_data.get("p_grid_out") or day_sum.get("p_grid_out") or day_sum.get("p_grid_out_now") or status_data.get("grid_import"))
    if grid_import == 0.0 and last_pt and (now_utc - last_pt["dt"]).total_seconds() <= 3600:
        grid_import = last_pt["grid_import"]

    battery_power = parse_kw(status_data.get("p_battery") or day_sum.get("p_battery") or day_sum.get("p_battery_now"))
    
    if (battery_soc is None or battery_soc == 0) and last_pt and last_pt.get("soc"):
        battery_soc = last_pt["soc"]

    net_grid = -grid_import if (grid_import > 0 and grid_feed_in == 0) else grid_feed_in

    # Standortdaten
    loc_lat = float(os.environ.get("ZUN_LAT") or DEFAULT_PV_LAT)
    loc_lng = float(os.environ.get("ZUN_LNG") or DEFAULT_PV_LNG)
    loc_name = os.environ.get("ZUN_LOCATION_NAME") or DEFAULT_LOCATION_NAME

    # Tagesberichte für alle erfassten Tage nach deutscher Zeit aufbauen
    daily_reports = {}
    if os.path.exists("zun_daily_history.json"):
        try:
            with open("zun_daily_history.json", "r", encoding="utf-8") as f:
                daily_reports = json.load(f)
        except Exception:
            pass

    points_by_date = {}
    for p in clean_points:
        dt_de = to_berlin_dt(p["dt"])
        d_key = dt_de.strftime("%Y-%m-%d")
        if d_key not in points_by_date:
            points_by_date[d_key] = []
        points_by_date[d_key].append((dt_de, p))

    today_de_str = to_berlin_dt(now_utc).strftime("%Y-%m-%d")

    for d_key, pts_list in points_by_date.items():
        hourly_map = {h: {"gen": 0.0, "load": 0.0, "feed": 0.0, "import": 0.0, "cnt": 0} for h in range(24)}
        for dt_de, p in pts_list:
            h = dt_de.hour
            hourly_map[h]["gen"] += p["pv"]
            hourly_map[h]["load"] += p["load"]
            hourly_map[h]["feed"] += p["feed"]
            hourly_map[h]["import"] += p["grid_import"]
            hourly_map[h]["cnt"] += 1

        gen_arr = []
        load_arr = []
        feed_arr = []
        import_arr = []
        for h in range(24):
            cnt = hourly_map[h]["cnt"]
            is_past_day = (d_key != today_de_str)
            if is_past_day:
                h_gen = (hourly_map[h]["gen"] / cnt) if cnt > 0 else 0.0
                h_load = (hourly_map[h]["load"] / cnt) if cnt > 0 else 0.0
                h_feed = (hourly_map[h]["feed"] / cnt) if cnt > 0 else 0.0
                h_import = (hourly_map[h]["import"] / cnt) if cnt > 0 else 0.0
            else:
                h_gen = hourly_map[h]["gen"] / 60.0
                h_load = hourly_map[h]["load"] / 60.0
                h_feed = hourly_map[h]["feed"] / 60.0
                h_import = hourly_map[h]["import"] / 60.0
            gen_arr.append(round(h_gen, 2))
            load_arr.append(round(h_load, 2))
            feed_arr.append(round(h_feed, 2))
            import_arr.append(round(h_import, 2))

        daily_reports[d_key] = {
            "hours": list(range(24)),
            "generation": gen_arr,
            "loads": load_arr,
            "feedin": feed_arr,
            "gridConsumption": import_arr,
            "chargeEnergyToTal": [0.0] * 24,
            "dischargeEnergyToTal": [0.0] * 24,
            "totals": {
                "generation": round(sum(gen_arr), 1),
                "feedin": round(sum(feed_arr), 1),
                "loads": round(sum(load_arr), 1),
                "gridConsumption": round(sum(import_arr), 1),
                "chargeEnergyToTal": 0.0,
                "dischargeEnergyToTal": 0.0
            },
            "is_real_hourly": True
        }

    with open("zun_daily_history.json", "w", encoding="utf-8") as f:
        json.dump(daily_reports, f, indent=2, ensure_ascii=False)

    today_rep = daily_reports.get(today_de_str, {})
    today_totals = today_rep.get("totals", {})
    today_yield = float(day_sum.get("p_creation") or status_data.get("today_yield") or today_totals.get("generation") or 0.0)
    today_feedin = float(day_sum.get("p_grid_in") or status_data.get("today_feedin") or today_totals.get("feedin") or 0.0)
    today_grid_import = float(day_sum.get("p_grid_out") or status_data.get("today_grid_import") or today_totals.get("gridConsumption") or 0.0)

    # 3-Tage-Verlauf für Web UI
    export_history = []
    for p in clean_points[-4320:]:
        export_history.append({
            "t": p["t"],
            "pv": p["pv"],
            "load": p["load"],
            "loads": p["loads"],
            "feed": p["feed"],
            "feedin": p["feedin"],
            "grid_import": p["grid_import"],
            "soc": p["soc"]
        })

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
        "history_3d": export_history,
        "last_updated": now_utc.isoformat()
    }

    with open("zun_pv_data.json", "w", encoding="utf-8") as f:
        json.dump(zun_data, f, indent=2, ensure_ascii=False)

    with open("zun_pv_data.js", "w", encoding="utf-8") as f:
        f.write(f"window.zunPvData = {json.dumps(zun_data, indent=2, ensure_ascii=False)};\n")

    print(f"\n✅ ERFOLG: Live-PV-Daten für {loc_name} erfolgreich gespeichert!")
    print(f"Erzeugung: {zun_data['solar_power']} kW | Hausverbrauch: {zun_data['house_load']} kW | Batterie: {zun_data['battery_soc']}% | Einspeisung: {zun_data['grid_feed_in']} kW | Ertrag heute: {zun_data['today_yield']} kWh")

if __name__ == "__main__":
    main()

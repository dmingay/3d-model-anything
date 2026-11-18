#!/usr/bin/env python3
"""Site layers for a garden: where it is, how high, what the soil and rock are, and the climate
it has actually had. Free, key-less public APIs only; each layer is independent and failures
are reported rather than fatal.

    python3 tools/garden/site_lookup.py "GU22 0HW"            # UK postcode
    python3 tools/garden/site_lookup.py 51.3099 -0.5783         # lat lon
    python3 tools/garden/site_lookup.py <bundle>/manifest.json  # an outdoor scan's recorded fix
    ... --json site.json                                        # also save the raw layers

Sources
  postcodes.io                  postcode → coordinates (ONS Postcode Directory, OGL)
  Open-Meteo                    elevation (Copernicus DEM 90 m), ERA5-Land daily archive (frost,
                                rain, sunshine), current soil temperature/moisture (free for
                                non-commercial use, no key)
  BGS / UK Soil Observatory     Soil Parent Material (1:50k): texture, depth, drainage, lime
                                (OGL; WMS GetFeatureInfo, no key)
  BGS Geology 50k               bedrock + superficial deposits (OGL; WMS GetFeatureInfo)
Not included (need registration): Cranfield LandIS Soilscapes (the "proper" soil series map),
Met Office DataHub. Add them when keys exist; the output shape leaves room.
"""
import argparse
import datetime as dt
import json
import re
import statistics
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "3d-model-anything-garden/0.1 (site lookup)"}


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def get_json(url, timeout=30):
    return json.loads(get(url, timeout))


# --- location -------------------------------------------------------------------------------

def locate(arg):
    """Returns (lat, lon, source dict)."""
    if arg.endswith("manifest.json"):
        m = json.load(open(arg))
        site = m.get("site") or {}
        if site.get("latitude") is None:
            sys.exit("manifest has no site.latitude (not an outdoor scan, or location was denied)")
        return site["latitude"], site["longitude"], {"kind": "scan", "manifest": arg,
                "horizontalAccuracy": site.get("horizontalAccuracy"), "worldMinusZBearing": site.get("worldMinusZBearing")}
    pc = re.sub(r"\s+", "", arg).upper()
    if re.fullmatch(r"[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}", pc):
        d = get_json(f"https://api.postcodes.io/postcodes/{pc}")["result"]
        return d["latitude"], d["longitude"], {"kind": "postcode", "postcode": d["postcode"],
                "district": d.get("admin_district"), "ward": d.get("admin_ward"), "region": d.get("region")}
    raise ValueError(arg)


# --- layers -----------------------------------------------------------------------------------

def elevation(lat, lon):
    d = get_json(f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}")
    return {"metres": d["elevation"][0], "source": "Open-Meteo / Copernicus DEM GLO-90"}


def bgs_feature(service, layer, lat, lon, d=0.002):
    bbox = f"{lon-d},{lat-d},{lon+d},{lat+d}"
    q = urllib.parse.urlencode({"service": "WMS", "version": "1.3.0", "request": "GetFeatureInfo", "layers": layer,
        "query_layers": layer, "crs": "CRS:84", "bbox": bbox, "width": 101, "height": 101, "i": 50, "j": 50,
        "info_format": "application/geo+json", "feature_count": 3})
    data = json.loads(get(f"https://map.bgs.ac.uk/arcgis/services/{service}/MapServer/WMSServer?{q}"))
    feats = data.get("features") or []
    if not feats:
        return None
    props = feats[0]["properties"]
    return {k: v for k, v in props.items() if v not in (None, "", " ", "Null") and not k.lower().startswith(("objectid", "shape"))}


def soil(lat, lon):
    p = bgs_feature("UKSO/UKSO_BGS", "Parent.Material.Soil.texture", lat, lon)
    if not p:
        return {"note": "no BGS parent-material polygon here"}
    return {
        "texture": p.get("SIMPLE_TEX"),
        "group": p.get("SOIL_GROUP"), "groupDescription": p.get("SOIL_GROUP_DESC"),
        "depth": p.get("SOIL_DEPTH"), "depthDescription": p.get("SOIL_DEPTH_DESC"),
        "parentMaterial": p.get("ESB_DESC"), "parentLithology": p.get("GEN_PMLITH"), "grain": p.get("GEN_GRAIN_DESC"),
        "calcareous": p.get("CACO3_RANK"),
        "waterErosionRisk": p.get("WATER_ERZ"), "windErosionRisk": p.get("WIND_ERZ"), "runoff": p.get("SOIL_WASH"),
        "source": "BGS Soil Parent Material Model 1:50k via UKSO (OGL)",
        "caveat": "Parent-material model, not a soil survey: it describes what the soil formed from. Garden topsoil may have been imported or improved; dig a test pit and do a jar test to confirm.",
    }


def geology(lat, lon):
    bed = bgs_feature("BGS_Detailed_Geology", "BGS.50k.Bedrock", lat, lon)
    sup = bgs_feature("BGS_Detailed_Geology", "BGS.50k.Superficial.deposits", lat, lon)
    return {
        "bedrock": bed and {"unit": bed.get("LEX_D"), "lithology": bed.get("RCS_D"), "age": f"{bed.get('MAX_EPOCH')} ({bed.get('MAX_AGE')})",
                             "group": bed.get("GP_EQ_D"), "setting": bed.get("ENVIRONM_D"), "lexicon": bed.get("LEX_WEB")},
        "superficial": sup and {"unit": sup.get("LEX_D"), "lithology": sup.get("RCS_D")} or "none mapped (bedrock at or near the surface)",
        "source": "BGS Geology 50k (OGL)",
    }


def climate(lat, lon, years=10):
    end = dt.date.today().replace(month=1, day=1) - dt.timedelta(days=1)
    start = dt.date(end.year - years + 1, 1, 1)
    d = get_json("https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": "temperature_2m_min,temperature_2m_max,precipitation_sum,sunshine_duration", "timezone": "Europe/London"}), timeout=60)["daily"]
    days, tmin, tmax, rain, sun = d["time"], d["temperature_2m_min"], d["temperature_2m_max"], d["precipitation_sum"], d["sunshine_duration"]
    by_year = {}
    for day, lo, hi, r, s in zip(days, tmin, tmax, rain, sun):
        y, m = int(day[:4]), int(day[5:7])
        Y = by_year.setdefault(y, {"last_spring_frost": None, "first_autumn_frost": None, "frost_days": 0, "rain": 0.0, "sun_h": 0.0, "min": 99, "max": -99, "ice_days": 0, "hot_days": 0})
        if lo is None:
            continue
        if lo <= 0:
            Y["frost_days"] += 1
            if m <= 7:
                Y["last_spring_frost"] = day
            elif Y["first_autumn_frost"] is None:
                Y["first_autumn_frost"] = day
        if hi is not None and hi <= 0:
            Y["ice_days"] += 1
        if hi is not None and hi >= 28:
            Y["hot_days"] += 1
        Y["min"] = min(Y["min"], lo)
        Y["max"] = max(Y["max"], hi if hi is not None else -99)
        Y["rain"] += r or 0
        Y["sun_h"] += (s or 0) / 3600
    yrs = sorted(by_year)
    doy = lambda s: dt.date.fromisoformat(s).timetuple().tm_yday
    lsf = [doy(by_year[y]["last_spring_frost"]) for y in yrs if by_year[y]["last_spring_frost"]]
    faf = [doy(by_year[y]["first_autumn_frost"]) for y in yrs if by_year[y]["first_autumn_frost"]]
    to_date = lambda n: (dt.date(2001, 1, 1) + dt.timedelta(days=n - 1)).strftime("%-d %b")
    abs_min = min(by_year[y]["min"] for y in yrs)
    # RHS hardiness ratings are keyed to typical winter minima (H4: −10 to −5 °C, H5: −15 to −10, H3: −5 to 1)
    typical_min = statistics.median(by_year[y]["min"] for y in yrs)
    rhs = "H5 (−15 to −10 °C)" if typical_min <= -10 else "H4 (−10 to −5 °C)" if typical_min <= -5 else "H3 (−5 to 1 °C)" if typical_min <= 1 else "H2 (1 to 5 °C)"
    return {
        "period": f"{yrs[0]}–{yrs[-1]}", "source": "Open-Meteo ERA5-Land reanalysis (~9 km grid; a garden's frost pocket or wall can differ by weeks)",
        "last_spring_frost": {"median": to_date(round(statistics.median(lsf))), "latest": to_date(max(lsf)), "earliest": to_date(min(lsf))} if lsf else None,
        "first_autumn_frost": {"median": to_date(round(statistics.median(faf))), "earliest": to_date(min(faf)), "latest": to_date(max(faf))} if faf else None,
        "frost_free_days_median": round(statistics.median(faf) - statistics.median(lsf)) if lsf and faf else None,
        "frost_days_per_year": round(statistics.mean(by_year[y]["frost_days"] for y in yrs)),
        "typical_winter_minimum_c": round(typical_min, 1), "absolute_minimum_c": round(abs_min, 1), "rhs_hardiness_zone": rhs,
        "hot_days_28c_per_year": round(statistics.mean(by_year[y]["hot_days"] for y in yrs), 1),
        "annual_rain_mm": round(statistics.mean(by_year[y]["rain"] for y in yrs)),
        "annual_sunshine_hours_model": round(statistics.mean(by_year[y]["sun_h"] for y in yrs)),
        "sunshine_caveat": "model direct-radiation hours; reads well above Met Office sunshine recorder totals (~1,600 h/yr in Surrey), use for relative comparison only",
        "years": {y: {k: (round(v, 1) if isinstance(v, float) else v) for k, v in by_year[y].items()} for y in yrs},
    }


def soil_now(lat, lon):
    d = get_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "hourly": "soil_temperature_6cm,soil_moisture_3_to_9cm", "forecast_days": 1, "timezone": "Europe/London"}))
    h = d["hourly"]
    return {"soil_temperature_6cm_c": round(statistics.mean(x for x in h["soil_temperature_6cm"] if x is not None), 1),
            "soil_moisture_3_9cm_m3m3": round(statistics.mean(x for x in h["soil_moisture_3_to_9cm"] if x is not None), 3),
            "date": h["time"][0][:10], "source": "Open-Meteo model (grid cell, not your bed)"}


# --- report -------------------------------------------------------------------------------------

def run(layers, lat, lon):
    out = {}
    for name, fn in layers:
        try:
            out[name] = fn(lat, lon)
        except Exception as e:  # noqa: BLE001 - each layer is independent
            out[name] = {"error": f"{type(e).__name__}: {e}"}
    return out


def summary(site):
    L = site["layers"]; loc = site["location"]
    lines = [f"Site {site['latitude']:.5f}, {site['longitude']:.5f}" + (f" · {loc.get('postcode')} ({loc.get('district')})" if loc.get("postcode") else "")]
    e = L.get("elevation", {}); lines.append(f"Elevation: {e.get('metres', '?')} m")
    s = L.get("soil", {})
    if "texture" in s:
        lines.append(f"Soil (parent material): {s['texture']}, {s['group'].lower()}, {s['depth'].lower()}; lime: {s['calcareous'].lower()}; from {s['parentMaterial'].lower()}")
        lines.append(f"  drought/erosion: {s['windErosionRisk'].lower()}; water erosion {s['waterErosionRisk'].split('.')[0].lower()}")
    else:
        lines.append(f"Soil: {s}")
    g = L.get("geology", {}); b = g.get("bedrock") or {}
    lines.append(f"Geology: {b.get('unit')} — {b.get('lithology')}, {b.get('age')}; superficial: {g.get('superficial') if isinstance(g.get('superficial'), str) else g['superficial'].get('unit')}")
    c = L.get("climate", {})
    if "rhs_hardiness_zone" in c:
        lines.append(f"Climate {c['period']}: last spring frost median {c['last_spring_frost']['median']} (latest {c['last_spring_frost']['latest']}); first autumn frost median {c['first_autumn_frost']['median']} (earliest {c['first_autumn_frost']['earliest']}); ~{c['frost_free_days_median']} frost-free days")
        lines.append(f"  winter minimum typically {c['typical_winter_minimum_c']} °C (lowest {c['absolute_minimum_c']} °C) → RHS {c['rhs_hardiness_zone']}; {c['frost_days_per_year']} frost days/yr; {c['hot_days_28c_per_year']} days ≥28 °C/yr; rain {c['annual_rain_mm']} mm/yr")
    n = L.get("soil_now", {})
    if "soil_temperature_6cm_c" in n:
        lines.append(f"Soil now ({n['date']}): {n['soil_temperature_6cm_c']} °C at 6 cm, moisture {n['soil_moisture_3_9cm_m3m3']} m³/m³")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("where", nargs="+", help="postcode, 'lat lon', or a manifest.json")
    ap.add_argument("--json", help="write the full result here")
    ap.add_argument("--years", type=int, default=10, help="climate archive window (default 10)")
    a = ap.parse_args()
    if len(a.where) == 2:
        lat, lon, loc = float(a.where[0]), float(a.where[1]), {"kind": "coordinates"}
    else:
        lat, lon, loc = locate(" ".join(a.where))
    layers = [("elevation", elevation), ("soil", soil), ("geology", geology), ("climate", lambda la, lo: climate(la, lo, a.years)), ("soil_now", soil_now)]
    site = {"latitude": lat, "longitude": lon, "location": loc, "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "layers": run(layers, lat, lon)}
    print(summary(site))
    errors = {k: v["error"] for k, v in site["layers"].items() if isinstance(v, dict) and "error" in v}
    if errors:
        print("Layers that failed:", json.dumps(errors, indent=1), file=sys.stderr)
    if a.json:
        json.dump(site, open(a.json, "w"), indent=2, ensure_ascii=False)
        print(f"→ {a.json}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bulk-download Mixamo animations (FBX, no skin) through Mixamo's own web API.

One-time setup (Monty): log in at mixamo.com in a browser, pick any character,
open the DevTools console and run  copy(localStorage.getItem('access_token'))
then in a terminal:  mkdir -p ~/.config/mixamo && pbpaste > ~/.config/mixamo/access_token
The token lives only in that file; this script never prints it.

Usage:
  python3 pipeline/anim/mixamo_fetch.py --out pipeline/anim/mixamo --query soccer goalkeeper "slide tackle"
  python3 pipeline/anim/mixamo_fetch.py --out ... --names "Soccer Pass" "Goalkeeper Dive Left"
  python3 pipeline/anim/mixamo_fetch.py --list soccer          # search only, no download

Port of the export flow used by github.com/juanjo4martinez/mixamo-downloader (MIT).
"""
import argparse, json, os, re, sys, time
import requests

API = "https://www.mixamo.com/api/v1"
TOKEN_FILE = os.path.expanduser("~/.config/mixamo/access_token")


def headers():
    if not os.path.exists(TOKEN_FILE):
        sys.exit(f"no token at {TOKEN_FILE}; see the docstring for the one-time setup")
    tok = open(TOKEN_FILE).read().strip()
    return {"Authorization": f"Bearer {tok}", "X-Api-Key": "mixamo2", "Content-Type": "application/json"}


def primary_character(s, h):
    r = s.get(f"{API}/characters/primary", headers=h)
    if r.status_code == 401:
        sys.exit("Mixamo rejected the token (401). Log in again and refresh ~/.config/mixamo/access_token.")
    r.raise_for_status()
    j = r.json()
    return j["primary_character_id"], j.get("primary_character_name")


def search(s, h, query):
    page, out = 1, {}
    while True:
        r = s.get(f"{API}/products", headers=h, params={"limit": 96, "page": page, "type": "Motion", "query": query})
        r.raise_for_status()
        j = r.json()
        for a in j["results"]:
            out[a["id"]] = a["description"]
        if page >= j["pagination"]["num_pages"]:
            break
        page += 1
    return out


def export_one(s, h, character_id, anim_id, fps):
    r = s.get(f"{API}/products/{anim_id}", headers=h, params={"similar": 0, "character_id": character_id})
    r.raise_for_status()
    j = r.json()
    name = j["description"]
    gms = j["details"]["gms_hash"]
    gms["params"] = ",".join(str(int(p[-1])) for p in gms["params"])
    gms["overdrive"] = 0
    gms["trim"] = [int(gms["trim"][0]), int(gms["trim"][1])]
    payload = {"character_id": character_id, "product_name": name, "type": j["type"],
               "preferences": {"format": "fbx7_2019", "skin": False, "fps": str(fps), "reducekf": "0"},
               "gms_hash": [gms]}
    for attempt in range(6):
        r = s.post(f"{API}/animations/export", headers=h, data=json.dumps(payload))
        if r.status_code != 429:
            break
        wait = 20 * (attempt + 1)
        print(f"    rate limited, waiting {wait}s"); time.sleep(wait)
    r.raise_for_status()
    for _ in range(120):
        time.sleep(1)
        m = s.get(f"{API}/characters/{character_id}/monitor", headers=h).json()
        if m.get("status") == "completed":
            return name, m["job_result"]
        if m.get("status") == "failed":
            raise RuntimeError(f"export failed for {name}: {m}")
    raise TimeoutError(name)


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="pipeline/anim/mixamo")
    ap.add_argument("--query", nargs="*", default=[], help="search terms; every hit is downloaded")
    ap.add_argument("--names", nargs="*", default=[], help="exact animation names (from --list)")
    ap.add_argument("--list", nargs="*", help="search terms; print hits and exit")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--exclude", default=r"(?i)zombie|dance|sword|gun|rifle|pistol|magic|drunk|female|sitting|sit ",
                    help="regex; matching names are skipped")
    a = ap.parse_args()
    s = requests.Session(); h = headers()
    cid, cname = primary_character(s, h)
    print(f"primary character: {cname}")
    if a.list is not None:
        for q in a.list:
            hits = search(s, h, q)
            print(f"== {q}: {len(hits)}")
            for i, n in sorted(hits.items(), key=lambda x: x[1]):
                print(f"  {n}")
        return
    wanted = {}
    for q in a.query:
        wanted.update(search(s, h, q))
    if a.names:
        pool = {}
        for n in a.names:
            pool.update(search(s, h, n))
        want = {x.lower() for x in a.names}
        wanted.update({i: n for i, n in pool.items() if n.lower() in want})
    ex = re.compile(a.exclude) if a.exclude else None
    todo = {i: n for i, n in wanted.items() if not (ex and ex.search(n))}
    os.makedirs(a.out, exist_ok=True)
    manifest_path = os.path.join(a.out, "manifest.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    print(f"{len(todo)} animations to fetch -> {a.out}")
    for k, (i, n) in enumerate(sorted(todo.items(), key=lambda x: x[1]), 1):
        fn = os.path.join(a.out, safe(n) + ".fbx")
        if os.path.exists(fn) and os.path.getsize(fn) > 1000:
            print(f"[{k}/{len(todo)}] have {n}"); continue
        try:
            name, url = export_one(s, h, cid, i, a.fps)
            data = s.get(url).content
            open(fn, "wb").write(data)
            manifest[safe(n)] = {"id": i, "name": n, "bytes": len(data), "fps": a.fps}
            json.dump(manifest, open(manifest_path, "w"), indent=1)
            print(f"[{k}/{len(todo)}] {n} ({len(data)//1024} KB)")
        except Exception as e:
            print(f"[{k}/{len(todo)}] FAILED {n}: {e}")
        time.sleep(1.5)


if __name__ == "__main__":
    main()

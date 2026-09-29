"""Validate landscape.csv and print the capability matrix.

    python3 docs/competitive-landscape/check.py            # exit 1 on problems
    python3 docs/competitive-landscape/check.py --matrix   # markdown matrix from the CSV

Stale = last_verified older than STALE_DAYS (pricing and product pages move fast).
"""
import csv, datetime, os, sys

STALE_DAYS = 90
HERE = os.path.dirname(__file__)
REQUIRED = ["id", "competitor", "relationship", "source_urls", "evidence", "last_verified", "confidence"]
TRI = ["on_device_vector", "hybrid_search", "sync_to_server", "selective_sync_control", "conflict_handling", "ops_console"]
OK_START = ("Y", "N", "?", "n.a.", "Ended", "Manual")

rows = list(csv.DictReader(open(os.path.join(HERE, "landscape.csv"))))
problems, today = [], datetime.date.today()
ids = [r["id"] for r in rows]
if len(ids) != len(set(ids)):
    problems.append("duplicate ids")
for r in rows:
    tag = r["id"] or "?"
    problems += [f"{tag}: missing {c}" for c in REQUIRED if not r[c].strip()]
    problems += [f"{tag}: {c}={r[c]!r} must start with one of {OK_START}" for c in TRI if not r[c].startswith(OK_START)]
    try:
        age = (today - datetime.date.fromisoformat(r["last_verified"])).days
        if age > STALE_DAYS:
            problems.append(f"{tag}: stale ({age} days since last_verified)")
    except ValueError:
        problems.append(f"{tag}: last_verified is not YYYY-MM-DD")
    for u in r["source_urls"].split(" | "):
        if not (u.startswith("http") or os.path.exists(os.path.join(HERE, "..", "..", u))):
            problems.append(f"{tag}: source {u!r} is neither a URL nor a repo path")

if "--matrix" in sys.argv:
    short = lambda v: v.split(" ")[0].rstrip(",;(") or "?"
    print("| Competitor | " + " | ".join(c.replace("_", " ") for c in TRI) + " | Confidence |")
    print("|---|" + "---|" * (len(TRI) + 1))
    for r in rows:
        print(f"| {r['competitor']} | " + " | ".join(short(r[c]) for c in TRI) + f" | {r['confidence'].split(' ')[0]} |")
    sys.exit(0)

print(f"{len(rows)} rows checked")
for p in problems:
    print("PROBLEM", p)
sys.exit(1 if problems else 0)

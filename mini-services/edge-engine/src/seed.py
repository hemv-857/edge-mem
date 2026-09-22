"""Seed data for the edge intelligence platform.

Two layers:
1. CLOUD (Qdrant Server knowledge) — pre-seeded with manuals, past incidents,
   and verified fixes originating from devices beta & gamma. This is the
   'fleet knowledge' that flows DOWN to a freshly-bootstrapped device.
2. DEVICE-ALPHA — starts essentially empty (only manuals bootstrapped) so the
   demo can show offline writes + sync pushing NEW knowledge UP to the cloud.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List

now = int(time.time() * 1000)

# Cloud knowledge base (originates from beta/gamma — the fleet's shared brain)
CLOUD_SEED: Dict[str, List[Dict[str, Any]]] = {
    "manuals": [
        {"slug": "manual-sop12-bearing", "text": "SOP-12: Bearing replacement procedure for centrifugal pumps P-200 series. Lock out power, drain casing, remove impeller, press out old bearings, press in new with 45Nm torque on M8 caps, verify 0.05mm clearance, reassemble, run vibration test below 4.5mm/s.", "domain": "manual", "criticality": "high", "sensitivity": "internal", "asset_id": "P-200-series", "title": "SOP-12 Bearing Replacement"},
        {"slug": "manual-motor-rebalance", "text": "Motor rebalance procedure M-series. Mount rotor on balance rig, measure initial unbalance, add correction weights at 0/90/180/270 degree planes, target ISO G2.5. Vibration must stay below 2.8mm/s after rebalance.", "domain": "manual", "criticality": "medium", "sensitivity": "internal", "asset_id": "M-series", "title": "Motor Rebalance Procedure"},
        {"slug": "manual-valve-gland", "text": "Control valve gland repacking. Isolate, depressurize, remove gland nut, extract old packing rings, install new PTFE/graphite rings staggered 90 degrees, compress evenly, re-torque to 20Nm, leak-test at 1.5x working pressure.", "domain": "manual", "criticality": "medium", "sensitivity": "internal", "asset_id": "CV-series", "title": "Valve Gland Repacking"},
        {"slug": "manual-sensor-calibration", "text": "Temperature sensor TT calibration. Compare against NIST-traceable reference at 3 points (0C, 50C, 100C). Apply linear offset correction. Drift > 0.5C requires sensor replacement. Recalibrate quarterly.", "domain": "manual", "criticality": "medium", "sensitivity": "internal", "asset_id": "TT-series", "title": "Sensor Calibration SOP"},
        {"slug": "manual-pump-seal", "text": "Mechanical seal replacement for P-300 high-pressure pumps. Vent system, remove seal housing, inspect shaft sleeve for wear, install new cartridge seal, align to within 0.05mm TIR, flush and pressure-test before restart.", "domain": "manual", "criticality": "high", "sensitivity": "internal", "asset_id": "P-300", "title": "Mechanical Seal Replacement"},
        {"slug": "manual-vibration-limits", "text": "Vibration severity chart ISO 10816. Below 2.8mm/s = good (zone A). 2.8-4.5 = acceptable (B). 4.5-7.1 = unsatisfactory (C, plan corrective). Above 7.1 = unacceptable (D, shut down). Bearing defect frequencies: BPFO, BPFI, BSF, FTF.", "domain": "manual", "criticality": "high", "sensitivity": "internal", "asset_id": "ISO-10816", "title": "Vibration Severity & Bearing Frequencies"},
        {"slug": "manual-lubrication", "text": "Lubrication schedule. Grease bearings every 2000 hrs with NLGI-2 lithium grease, 30g per bearing. Oil-bath gearboxes check monthly, change ISO VG 320 yearly. Over-greasing causes overheating — never exceed 40g.", "domain": "manual", "criticality": "low", "sensitivity": "internal", "asset_id": "LUBE", "title": "Lubrication Schedule"},
    ],
    "incidents": [
        {"slug": "incident-beta-vibration-fix", "text": "RESOLVED by device-beta: Robot inspector detected P-202 drive-end vibration rising from 3.1 to 9.8mm/s over 48h. BPFO peak at 142Hz confirmed outer-race defect. Replaced bearings per SOP-12. Post-repair vibration 2.1mm/s. Verified fix — propagate to fleet.", "domain": "incident", "criticality": "high", "sensitivity": "internal", "asset_id": "P-202", "title": "P-202 Vibration — Outer Race Defect (Resolved)"},
        {"slug": "incident-gamma-kiosk-overheat", "text": "RESOLVED by device-gamma: Kiosk terminal overheating, CPU throttling causing UI freezes. Root cause: dust-clogged intake filter. Cleaned filter, added temperature alert at 75C. Recurring prevention: monthly filter check.", "domain": "incident", "criticality": "medium", "sensitivity": "internal", "asset_id": "KIOSK-C", "title": "Kiosk Overheat — Dust Filter (Resolved)"},
        {"slug": "incident-beta-seal-leak", "text": "RESOLVED by device-beta: P-301 mechanical seal leak, process fluid at gland. Replaced cartridge seal per manual. Shaft sleeve had 0.08mm wear — acceptable. Leak stopped, pressure-test passed at 1.5x.", "domain": "incident", "criticality": "high", "sensitivity": "internal", "asset_id": "P-301", "title": "P-301 Seal Leak (Resolved)"},
        {"slug": "incident-gamma-power-fluctuation", "text": "RESOLVED by device-gamma: Intermittent kiosk reboot during grid fluctuation. Installed UPS, set graceful-shutdown at 30% battery. No recurrence in 30 days.", "domain": "incident", "criticality": "medium", "sensitivity": "internal", "asset_id": "KIOSK-C", "title": "Kiosk Power Fluctuation (Resolved)"},
        {"slug": "incident-beta-motor-bearing", "text": "RESOLVED by device-beta: Motor M-22 high-frequency vibration at BSF 95Hz. Confirmed rolling-element defect via envelope analysis. Replaced bearings + rebalanced per procedure. Final 2.3mm/s.", "domain": "incident", "criticality": "high", "sensitivity": "internal", "asset_id": "M-22", "title": "M-22 Bearing Defect (Resolved)"},
    ],
    "sensors": [],  # sensors are local-only firehose; cloud holds none raw
}

def seed_fleet(fleet):
    """Seed the cloud knowledge base (originating from beta/gamma) if empty.
    Devices start empty — the demo's first step is bootstrapping a device
    from the cloud snapshot."""
    import embed as _emb
    import uuid as _uuid

    def _origin_for(shard_name, idx):
        # alternate origin between beta & gamma for incidents; manuals are fleet-wide
        if shard_name == "incidents":
            return "device-beta" if idx % 2 == 0 else "device-gamma"
        return "device-gamma" if shard_name == "sensors" else "device-beta"

    def _seed_shard(store, points, shard_name):
        if store.count() > 0:
            return 0
        n = 0
        for i, p in enumerate(points):
            slug = p["slug"]
            pid = str(_uuid.uuid5(_uuid.NAMESPACE_URL, slug))
            text = p["text"]
            dense = _emb.embed_dense(text)
            sparse = _emb.embed_sparse_doc(text)
            payload = dict(p)
            payload.update({
                "origin_device": _origin_for(shard_name, i),
                "updated_at": now - 3 * 86400000 + i * 60000,  # ~3 days ago, staggered
                "sync_state": "synced",
            })
            payload["slug"] = slug
            store.upsert(pid, dense, sparse, payload)
            n += 1
        store.optimize(); store.flush()
        return n

    cloud_n = 0
    for shard_name, pts in CLOUD_SEED.items():
        cloud_n += _seed_shard(fleet.cloud.shards[shard_name], pts, shard_name)
    if cloud_n:
        fleet.log("system", "seed", f"Seeded cloud knowledge base — {cloud_n} points (from beta/gamma)",
                  {"cloud": cloud_n})

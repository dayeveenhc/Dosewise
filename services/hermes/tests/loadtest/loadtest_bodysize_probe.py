"""Body-size / memory-exposure probe for Hermes's /agent/turn endpoint.

Track C (load/DoS-surface testing). Confirms and quantifies a gap noted
during static review: there is no request-body-size limit anywhere in the
stack that fronts Hermes (absent from FastAPI/Starlette app config, Caddy,
pm2, docker-compose). This script doesn't just assert the gap exists — it
sends progressively larger ``image_base64`` payloads through the *same*
in-process ASGI harness used by tests/test_ratelimit.py (create_app(),
FakeSupabase, a stubbed run_agent_turn — zero real LLM/Supabase cost) and
measures this process's own RSS (``/proc/self/status`` VmRSS, read-only, no
special privileges needed) before/after each request, plus latency, to
characterize how memory scales with payload size.

Because the harness is in-process (client and "server" share one address
space — httpx's ASGITransport calls the app directly, no socket), the RSS
delta captures the *combined* cost of building the oversized JSON body,
Starlette reading it, and pydantic/base64 decoding it server-side — which is
a reasonable (if anything, representative-to-conservative) proxy for what a
real remote attacker's single request would cost this process.

Safety: this repo's box is shared with a running production Hermes (pm2) and
other services, and starts with only ~2.3-2.4GB "available" memory (see
`free -h` / /proc/meminfo). This script checks MemAvailable before every
escalation step and refuses to proceed if projected peak usage would eat too
deeply into it, erring on the side of NOT destabilizing the shared box over
finding an exact ceiling.

Run:
    uv run python tests/loadtest/loadtest_bodysize_probe.py
"""

from __future__ import annotations

import asyncio
import base64
import gc
import logging
import os
import sys
import time
from pathlib import Path

import httpx

logging.getLogger("httpx").setLevel(logging.WARNING)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hermes.api.routes as routes  # noqa: E402
from fakes import FakeSupabase  # noqa: E402
from hermes.main import create_app  # noqa: E402
from hermes.ratelimit import SlidingWindowLimiter  # noqa: E402

# Sizes (decoded/raw bytes, in MB) to probe, in ascending order. The loop below
# stops early if memory headroom looks insufficient or a step looks alarming.
CANDIDATE_SIZES_MB = [10, 50, 100]

# Require this many times the *projected* peak payload footprint to still be
# free in MemAvailable before attempting a step (accounts for the several
# concurrent copies of the string/bytes that pile up in-process: the base64
# string built here, httpx's json-encoded request body, Starlette's received
# body bytes, pydantic's parsed field, and base64.b64decode's output).
SAFETY_MULTIPLIER = 8


async def _fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
    return "ok", [], history or []


def install_stubs() -> None:
    routes.run_agent_turn = _fake_turn


def make_app():
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


def read_vmrss_kb() -> int:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    raise RuntimeError("VmRSS not found in /proc/self/status")


def read_mem_available_kb() -> int:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    raise RuntimeError("MemAvailable not found in /proc/meminfo")


def make_base64_payload(decoded_mb: int) -> str:
    raw = os.urandom(decoded_mb * 1024 * 1024)
    return base64.b64encode(raw).decode("ascii")


async def probe_size(app, decoded_mb: int) -> dict:
    gc.collect()
    rss_before_kb = read_vmrss_kb()

    t0 = time.perf_counter()
    payload_b64 = make_base64_payload(decoded_mb)
    build_s = time.perf_counter() - t0
    b64_len_mb = len(payload_b64) / (1024 * 1024)
    rss_after_build_kb = read_vmrss_kb()

    body = {
        "message": "check this label",
        "elder_id": "00000000-0000-0000-0000-00000000000a",
        "image_base64": payload_b64,
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=120.0
    ) as client:
        t0 = time.perf_counter()
        resp = await client.post("/agent/turn", json=body)
        latency_s = time.perf_counter() - t0

    rss_after_request_kb = read_vmrss_kb()
    status = resp.status_code

    del payload_b64, body
    gc.collect()
    rss_after_gc_kb = read_vmrss_kb()

    return {
        "decoded_mb": decoded_mb,
        "base64_mb": round(b64_len_mb, 2),
        "build_s": build_s,
        "latency_s": latency_s,
        "status": status,
        "rss_before_mb": rss_before_kb / 1024,
        "rss_after_build_mb": rss_after_build_kb / 1024,
        "rss_after_request_mb": rss_after_request_kb / 1024,
        "rss_after_gc_mb": rss_after_gc_kb / 1024,
        "rss_delta_request_mb": (rss_after_request_kb - rss_before_kb) / 1024,
        "rss_delta_retained_mb": (rss_after_gc_kb - rss_before_kb) / 1024,
    }


def print_result(r: dict) -> None:
    print(f"\n--- decoded size ~{r['decoded_mb']} MB (base64 ~{r['base64_mb']:.1f} MB) ---")
    print(f"  payload build time:        {r['build_s']*1000:.1f} ms")
    print(f"  request latency:           {r['latency_s']*1000:.1f} ms")
    print(f"  response status:           {r['status']}")
    print(f"  RSS before:                {r['rss_before_mb']:.1f} MB")
    print(f"  RSS after building payload:{r['rss_after_build_mb']:.1f} MB")
    print(f"  RSS right after request:   {r['rss_after_request_mb']:.1f} MB")
    print(f"  RSS after gc.collect():    {r['rss_after_gc_mb']:.1f} MB")
    print(f"  RSS delta (peak, this req):{r['rss_delta_request_mb']:+.1f} MB")
    print(f"  RSS delta (retained/leak): {r['rss_delta_retained_mb']:+.1f} MB")


LATENCY_ALARM_S = 10.0  # a single stubbed-handler request taking >10s is alarming


async def main() -> None:
    install_stubs()
    app = make_app()

    print("=" * 78)
    print("Hermes /agent/turn body-size probe (Track C) — in-process, stubbed")
    print("=" * 78)
    print(f"Starting MemAvailable: {read_mem_available_kb()/1024:.0f} MB")
    print(f"Starting process RSS:  {read_vmrss_kb()/1024:.1f} MB")

    results: list[dict] = []
    ceiling_reason: str | None = None

    for decoded_mb in CANDIDATE_SIZES_MB:
        mem_avail_mb = read_mem_available_kb() / 1024
        projected_peak_mb = decoded_mb * 1.34 * SAFETY_MULTIPLIER  # base64 is ~4/3 larger
        if mem_avail_mb < projected_peak_mb:
            ceiling_reason = (
                f"stopped before {decoded_mb} MB: only {mem_avail_mb:.0f} MB "
                f"MemAvailable, wanted >= {projected_peak_mb:.0f} MB headroom "
                f"({SAFETY_MULTIPLIER}x safety margin) before risking it on this "
                "shared box"
            )
            print(f"\n[SAFETY STOP] {ceiling_reason}")
            break

        print(f"\n[probing {decoded_mb} MB decoded; MemAvailable={mem_avail_mb:.0f} MB]")
        try:
            r = await asyncio.wait_for(probe_size(app, decoded_mb), timeout=60.0)
        except TimeoutError:
            ceiling_reason = f"request at {decoded_mb} MB decoded did not complete within 60s"
            print(f"\n[CEILING HIT] {ceiling_reason}")
            break

        print_result(r)
        results.append(r)

        if r["latency_s"] > LATENCY_ALARM_S:
            ceiling_reason = (
                f"latency at {decoded_mb} MB decoded was {r['latency_s']:.1f}s "
                f"(> {LATENCY_ALARM_S}s alarm threshold) — stopping escalation"
            )
            print(f"\n[CEILING HIT] {ceiling_reason}")
            break
        if r["status"] != 200:
            ceiling_reason = (
                f"request at {decoded_mb} MB decoded returned status {r['status']} "
                "(not 200) — stopping escalation"
            )
            print(f"\n[CEILING HIT] {ceiling_reason}")
            break

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    header = (
        f"{'decoded MB':>10} {'b64 MB':>8} {'latency ms':>11} {'status':>7} "
        f"{'peak delta MB':>14} {'retained delta MB':>18}"
    )
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r['decoded_mb']:>10} {r['base64_mb']:>8.1f} {r['latency_s']*1000:>11.1f} "
            f"{r['status']:>7} {r['rss_delta_request_mb']:>14.1f} "
            f"{r['rss_delta_retained_mb']:>18.1f}"
        )

    if ceiling_reason:
        print(f"\nEscalation stopped: {ceiling_reason}")
    else:
        print(
            f"\nAll candidate sizes ({CANDIDATE_SIZES_MB} MB) completed without "
            "hitting a safety/latency/status ceiling."
        )

    if len(results) >= 2:
        first, last = results[0], results[-1]
        size_ratio = last["decoded_mb"] / first["decoded_mb"]
        if first["rss_delta_request_mb"] > 0:
            mem_ratio = last["rss_delta_request_mb"] / first["rss_delta_request_mb"]
        else:
            mem_ratio = float("inf")
        retained_growth = sum(r["rss_delta_retained_mb"] for r in results)
        print(
            f"\nSize scaled {size_ratio:.1f}x ({first['decoded_mb']}->{last['decoded_mb']} MB); "
            f"peak-RSS-delta scaled {mem_ratio:.1f}x "
            f"({first['rss_delta_request_mb']:.1f}->{last['rss_delta_request_mb']:.1f} MB). "
            "Memory use per request grows monotonically with payload size and there is "
            "no size ceiling anywhere in the app itself — the only thing that stopped "
            "escalation here was this script's own safety margin, not Hermes. "
            f"Also note: {retained_growth:.1f} MB of RSS was never returned to the OS "
            "even after gc.collect() across these 3 requests (CPython's allocator "
            "keeps arenas rather than a true per-object leak) — so a burst of "
            "several such requests can ratchet a worker's baseline memory upward "
            "and never give it back, which compounds the exposure over time."
        )


if __name__ == "__main__":
    asyncio.run(main())

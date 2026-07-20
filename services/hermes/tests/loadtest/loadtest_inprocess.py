"""In-process concurrency/DoS-surface probe for Hermes's HTTP surface.

Track C (load/DoS-surface testing). Reuses the *exact* in-process ASGI harness
pattern from ``tests/test_ratelimit.py``:

    * ``hermes.main.create_app()`` for the real FastAPI app + middleware stack
      (including the per-IP rate-limit middleware and CORS), with
      ``app.state`` populated by hand (``ASGITransport`` never runs lifespan).
    * ``FakeSupabase`` (tests/fakes.py) instead of a live Supabase project.
    * ``routes.run_agent_turn`` / ``routes.extract_profile_fields`` monkeypatched
      to fast async stubs — zero real LLM cost, zero network.
    * ``httpx.AsyncClient(transport=httpx.ASGITransport(app=app))`` — requests
      go straight through ASGI call plumbing in-process, no socket, no
      real uvicorn worker.

This is NOT a pytest test (though it could be adapted into one) — it's a
standalone script that drives real concurrency via ``asyncio.gather`` /
``asyncio.wait_for`` against that in-process app, unlike the sequential
request-by-request unit tests in test_ratelimit.py, and reports latency
percentiles, error rate, and throughput.

Run:
    uv run python tests/loadtest/loadtest_inprocess.py
"""

from __future__ import annotations

import asyncio
import base64
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

# httpx logs an INFO line per request by default; at hundreds/thousands of
# requests per scenario that drowns the summary tables.
logging.getLogger("httpx").setLevel(logging.WARNING)

# tests/ has no __init__.py; under pytest, rootdir-insertion puts it on
# sys.path automatically. This script runs standalone, so do it ourselves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hermes.api.routes as routes  # noqa: E402
from fakes import FakeSupabase  # noqa: E402
from hermes.config import get_settings  # noqa: E402
from hermes.main import create_app  # noqa: E402
from hermes.ratelimit import SlidingWindowLimiter  # noqa: E402


# --- fast, zero-cost stubs (no LLM, no Supabase, no fastText) --------------
async def _fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
    await asyncio.sleep(0)  # yield once, like a real coroutine would
    return "ok", [], history or []


async def _fake_extract(client, *, image_bytes=None, image_media_type=None, pdf_text=None):
    await asyncio.sleep(0)
    return {"name": "Test Elder"}


def install_stubs() -> None:
    routes.run_agent_turn = _fake_turn
    routes.extract_profile_fields = _fake_extract


def make_app() -> FastAPI:  # noqa: F821 - just for readability
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


TINY_IMAGE_B64 = base64.b64encode(b"fake-image-bytes-for-load-test").decode()

AGENT_TURN_BODY = {
    "message": "hi",
    "elder_id": "00000000-0000-0000-0000-00000000000a",
}
PROFILE_EXTRACT_BODY = {"image_base64": TINY_IMAGE_B64}

ENDPOINTS = {
    "/agent/turn": AGENT_TURN_BODY,
    "/profile/extract": PROFILE_EXTRACT_BODY,
}


@dataclass
class ReqResult:
    status: int
    latency_ms: float
    error: str | None = None


@dataclass
class Stats:
    label: str
    n: int
    wall_s: float
    results: list[ReqResult]

    def summary(self) -> dict:
        latencies = sorted(r.latency_ms for r in self.results)
        n = len(latencies)

        def pct(p: float) -> float:
            if not n:
                return float("nan")
            idx = min(n - 1, int(round(p * (n - 1))))
            return latencies[idx]

        status_counts: dict[int, int] = {}
        transport_errors = 0
        for r in self.results:
            if r.error:
                transport_errors += 1
            else:
                status_counts[r.status] = status_counts.get(r.status, 0) + 1
        n_2xx = sum(c for s, c in status_counts.items() if 200 <= s < 300)
        n_429 = status_counts.get(429, 0)
        n_error = self.n - n_2xx  # everything not a clean 2xx counts as "error" here
        return {
            "label": self.label,
            "n": self.n,
            "wall_s": self.wall_s,
            "throughput_rps": self.n / self.wall_s if self.wall_s > 0 else float("inf"),
            "p50_ms": pct(0.50),
            "p95_ms": pct(0.95),
            "p99_ms": pct(0.99),
            "min_ms": latencies[0] if latencies else float("nan"),
            "max_ms": latencies[-1] if latencies else float("nan"),
            "status_counts": dict(sorted(status_counts.items())),
            "n_2xx": n_2xx,
            "n_429": n_429,
            "transport_errors": transport_errors,
            "error_rate": n_error / self.n if self.n else 0.0,
        }


def print_summary(s: dict) -> None:
    print(f"\n--- {s['label']} ---")
    print(f"  requests:        {s['n']}")
    print(f"  wall time:       {s['wall_s']:.3f}s")
    print(f"  throughput:      {s['throughput_rps']:.1f} req/s")
    print(f"  latency p50/p95/p99 (ms): {s['p50_ms']:.2f} / {s['p95_ms']:.2f} / {s['p99_ms']:.2f}")
    print(f"  latency min/max (ms):     {s['min_ms']:.2f} / {s['max_ms']:.2f}")
    print(f"  status counts:   {s['status_counts']}  (transport errors: {s['transport_errors']})")
    print(f"  2xx: {s['n_2xx']}  429: {s['n_429']}")
    print(f"  error rate (non-2xx): {s['error_rate']*100:.1f}%")


async def _one_request(client: httpx.AsyncClient, path: str, body: dict) -> ReqResult:
    t0 = time.perf_counter()
    try:
        resp = await client.post(path, json=body)
        dt = (time.perf_counter() - t0) * 1000
        return ReqResult(status=resp.status_code, latency_ms=dt)
    except Exception as exc:  # transport-level failure (should be rare/never in-process)
        dt = (time.perf_counter() - t0) * 1000
        return ReqResult(status=-1, latency_ms=dt, error=repr(exc))


async def run_burst(app, path: str, body: dict, *, n: int, label: str) -> Stats:
    """Fire ``n`` requests all at once via asyncio.gather — the worst-case
    concurrency spike (e.g. a retry storm or a scripted burst)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        t0 = time.perf_counter()
        results = await asyncio.gather(*(_one_request(client, path, body) for _ in range(n)))
        wall = time.perf_counter() - t0
    return Stats(label=label, n=n, wall_s=wall, results=list(results))


async def run_sustained(
    app, path: str, body: dict, *, workers: int, duration_s: float, label: str
) -> Stats:
    """``workers`` concurrent coroutines each loop requests back-to-back for
    ``duration_s`` real seconds — a sustained-load condition rather than a
    single spike."""
    results: list[ReqResult] = []
    stop_at = time.perf_counter() + duration_s

    async def worker(client: httpx.AsyncClient) -> None:
        while time.perf_counter() < stop_at:
            results.append(await _one_request(client, path, body))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        t0 = time.perf_counter()
        await asyncio.gather(*(worker(client) for _ in range(workers)))
        wall = time.perf_counter() - t0
    return Stats(label=label, n=len(results), wall_s=wall, results=results)


async def run_condition(rate_limit_enabled: bool) -> list[dict]:
    settings = get_settings()
    settings.rate_limit_enabled = rate_limit_enabled
    summaries: list[dict] = []

    for path, body in ENDPOINTS.items():
        app = make_app()
        label = (
            f"{path} | burst n=200 | rate_limit_enabled={rate_limit_enabled}"
        )
        stats = await run_burst(app, path, body, n=200, label=label)
        summaries.append(stats.summary())
        print_summary(summaries[-1])

    for path, body in ENDPOINTS.items():
        app = make_app()
        label = (
            f"{path} | sustained 20 workers x 5s | "
            f"rate_limit_enabled={rate_limit_enabled}"
        )
        stats = await run_sustained(
            app, path, body, workers=20, duration_s=5.0, label=label
        )
        summaries.append(stats.summary())
        print_summary(summaries[-1])

    return summaries


async def main() -> None:
    install_stubs()

    print("=" * 78)
    print("Hermes in-process load test (Track C) — zero real LLM/Supabase cost")
    print("=" * 78)

    all_summaries: dict[str, list[dict]] = {}

    print("\n########## CONDITION 1: rate_limit_enabled=True ##########")
    all_summaries["rate_limit_enabled=True"] = await run_condition(True)

    print("\n########## CONDITION 2: rate_limit_enabled=False ##########")
    all_summaries["rate_limit_enabled=False"] = await run_condition(False)

    print("\n" + "=" * 78)
    print("SUMMARY TABLE")
    print("=" * 78)
    header = (
        f"{'condition/scenario':<70} {'n':>5} {'p50':>8} {'p95':>8} {'p99':>8} "
        f"{'rps':>9} {'2xx':>6} {'429':>6} {'err%':>6}"
    )
    print(header)
    print("-" * len(header))
    for summaries in all_summaries.values():
        for s in summaries:
            print(
                f"{s['label']:<70.70} {s['n']:>5} {s['p50_ms']:>8.2f} {s['p95_ms']:>8.2f} "
                f"{s['p99_ms']:>8.2f} {s['throughput_rps']:>9.1f} {s['n_2xx']:>6} "
                f"{s['n_429']:>6} {s['error_rate']*100:>5.1f}%"
            )


if __name__ == "__main__":
    asyncio.run(main())

"""Risk classifier for the Guided Auto-Navigation ``*_auto`` walkthroughs
(cross-cutting decision A, ``for-the-ask-mei-iterative-wall.md``).

``start_walkthrough`` (walkthrough.py) queues a scripted, client-driven script
for a ``*_auto`` task — Mei fills the real form, the patient's own Confirm/
Submit taps commit it (see that module's docstring). This module computes a
lightweight, best-effort risk ASSESSMENT of one such dispatch — NOT a gate,
and not a model-callable tool (it isn't `register()`ed) — so the client's new
Confirm phase can force an explicit tap on anything worth a second look,
regardless of how trusted/veteran the user is (risk always overrides trust
level, per the walkthrough plan's decision C).

Four signals this module itself checks, ORed together with a fifth the caller
supplies (any one flags the whole result). Each has a stable ``code`` (see
``signals`` below) alongside its human-readable ``reasons`` string — Item 4's
`showDoseConfirm`-suppression decision needs to test for "the dosage-jump
signal fired" specifically, and matching English prose is exactly the
`q.addedAt.includes("Mei")`-shaped trap MEMORY.md already warns about:
  * ``irreversible_task`` — the CALLER passes in which task names qualify
    (``irreversible_tasks``); this module stays task-agnostic on purpose so it
    never needs to import walkthrough.py (which imports this module first —
    importing back would be a cycle).
  * ``dosage_jump`` / ``dosage_unparseable`` — dosage jump >=
    ``DOSAGE_INCREASE_MULTIPLIER`` vs an existing same-name medication
    (``dosage_ratio``, base.py). The unparseable/incomparable case FAILS
    CLOSED — the OPPOSITE bias from medications.py's own ``_dosage_warning``
    advisory caveat (see that function's docstring for why the two need
    opposite defaults: this is a deliberate, required inversion — false
    positives are far cheaper here than a missed real jump).
  * ``unknown_medication`` — the medication name zero-matches the patient's
    medication list at every ``find_medications`` tier — profile-match only,
    no OpenFDA check (out of scope for this pass). NOTE: for
    add_prescription_auto specifically, a genuinely brand-new drug ALWAYS
    zero-matches by construction (that's the point of the tool) — this signal
    is expected to fire on most real adds of a never-before-seen medication,
    not just malformed/mis-heard names. See
    test_brand_new_medication_always_flags_unknown_name
    (test_risk_classifier.py) for the tradeoff spelled out as a named,
    findable test rather than a side note.
  * ``fuzzy_match`` — the name only resolved via the fuzzy tier (dosage-
    suffix-stripped or wildcard), not an exact match — low-confidence
    disambiguation.
  * ``schedule_drift`` — a proposed time in ``params`` is unparseable, or is
    more than a few hours off every time already on the medication's
    ``schedule.times``.

Every reason string names the actual signal that fired — the Confirm-phase
UI/prompt surfaces it verbatim, and it is exactly what the adversarial tests
in test_risk_classifier.py assert on.
"""

from __future__ import annotations

from .base import DOSAGE_INCREASE_MULTIPLIER, ToolContext, dosage_ratio, find_medications_tiered

# How far a proposed dose TIME may drift from what's already on file before
# it's worth a second look — matches the ask's "more than a few hours".
_SCHEDULE_DRIFT_HOURS = 3.0

# The (varied) *_auto param shapes name the medication / new dose under
# different keys per task — add_prescription_auto's own params use
# "name"/"dose" (its schema, walkthrough.py); update_medication_dosage's TOOL
# schema — a different thing entirely — uses "medication_name"/"dosage".
# Checking every key a plausible param builder might use means a shape that
# matches none of them simply skips that signal rather than crashing.
_NAME_KEYS = ("name", "medication_name")
_DOSAGE_KEYS = ("dose", "dosage")
# Deliberately singular only. start_walkthrough stringifies every param value
# (``str(v)``), so a hypothetical list-valued "times" would arrive here as the
# Python repr of a list ("['08:00', '20:00']") — unparseable by _parse_hhmm,
# which would falsely flag an entirely ordinary multi-dose schedule. Add a
# multi-value key here only alongside code that actually parses that shape.
_TIME_KEYS = ("time",)


def _first(params: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = params.get(key)
        if value:
            return str(value)
    return None


def _parse_hhmm(value: str) -> float | None:
    """``"HH:MM"`` (or ``"H:MM"``) -> hour-of-day as a float, else ``None``."""
    hh, sep, mm = value.strip().partition(":")
    if not sep or not hh.isdigit() or not mm.isdigit():
        return None
    h, m = int(hh), int(mm)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h + m / 60


def _hours_apart(a: float, b: float) -> float:
    """Circular distance on a 24h clock (23:00 vs 01:00 is 2h apart, not 22)."""
    diff = abs(a - b) % 24
    return min(diff, 24 - diff)


async def assess_risk(
    ctx: ToolContext,
    task_name: str,
    params: dict,
    *,
    irreversible_tasks: frozenset[str] = frozenset(),
) -> dict:
    """``{"flagged": bool, "signals": [str, ...], "reasons": [str, ...]}`` for
    one ``start_walkthrough`` dispatch. ``signals`` is a stable machine-legible
    code per fired axis (see the module docstring); ``reasons`` is the matching
    human-readable prose, same order, same length — a caller that wants to test
    "did the dosage-jump signal fire" should check ``"dosage_jump" in signals``,
    never substring-match ``reasons``.

    Best-effort and read-only (the same medication lookup ``find_medications``
    already runs elsewhere for other tools) — never raises; a lookup failure
    counts as a flag for that axis rather than a silent pass, matching this
    module's fail-closed design (the opposite of most of this codebase's other
    best-effort checks, e.g. ``_interaction_warning``/``_dosage_warning``,
    which fail open — see the module docstring for why that inversion is
    deliberate here).
    """
    signals: list[str] = []
    reasons: list[str] = []

    def _flag(code: str, detail: str) -> None:
        signals.append(code)
        reasons.append(detail)

    if task_name in irreversible_tasks:
        _flag(
            "irreversible_task",
            f"'{task_name}' performs an irreversible write (discontinues, "
            "deletes, or revokes something already on file).",
        )

    name = _first(params, _NAME_KEYS)
    med: dict | None = None
    if name:
        try:
            meds, tier = await find_medications_tiered(
                ctx, name, columns="name,dosage,schedule", limit=1
            )
        except Exception:
            # Fail CLOSED — a lookup we couldn't even run is not a pass.
            meds, tier = [], None
        if not meds:
            _flag(
                "unknown_medication",
                f"'{name}' does not match any medication on the patient's profile.",
            )
        else:
            med = meds[0]
            if tier != "exact":
                _flag(
                    "fuzzy_match",
                    f"'{name}' only matched an existing medication "
                    f"('{med.get('name')}') via a fuzzy ({tier}) lookup, not an "
                    "exact name match.",
                )

    dose = _first(params, _DOSAGE_KEYS)
    if dose and med is not None:
        ratio = dosage_ratio(med.get("dosage"), dose)
        if ratio is None:
            _flag(
                "dosage_unparseable",
                f"the dosage ('{dose}' vs on-file '{med.get('dosage')}') could "
                "not be parsed/compared, so it can't be confirmed safe.",
            )
        elif ratio >= DOSAGE_INCREASE_MULTIPLIER:
            _flag(
                "dosage_jump",
                f"'{dose}' is {ratio:.3g}x the existing on-file dose "
                f"('{med.get('dosage')}') for '{name}'.",
            )

    proposed_time = _first(params, _TIME_KEYS)
    if proposed_time and med is not None:
        existing_times = (med.get("schedule") or {}).get("times") or []
        proposed_hour = _parse_hhmm(proposed_time)
        if proposed_hour is None:
            _flag("schedule_drift", f"the proposed time ('{proposed_time}') could not be parsed.")
        elif existing_times:
            parsed_existing: list[float] = []
            for t in existing_times:
                h = _parse_hhmm(t)
                if h is not None:
                    parsed_existing.append(h)
            if parsed_existing and all(
                _hours_apart(proposed_hour, h) > _SCHEDULE_DRIFT_HOURS
                for h in parsed_existing
            ):
                _flag(
                    "schedule_drift",
                    f"the proposed time ('{proposed_time}') is more than "
                    f"{_SCHEDULE_DRIFT_HOURS:g}h off every time already on file "
                    f"({', '.join(existing_times)}).",
                )

    return {"flagged": bool(reasons), "signals": signals, "reasons": reasons}

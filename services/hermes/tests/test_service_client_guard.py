"""Structural guard: the RLS-bypassing service role must not sprawl.

``service_client()`` and ``upload_object()`` skip Row-Level Security. If a future
change routes interactive elder data through either, RLS stops protecting that
path. This test pins the sanctioned call sites so such a change fails loudly and
has to update the allowlist on purpose (see db/supabase.py for the rationale).
"""

from __future__ import annotations

import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src" / "hermes"

# Sanctioned call sites (relative to src/hermes), mapping the bypass to its reason.
_SERVICE_CLIENT_ALLOWED = {
    "channels/scheduler.py",  # identity-less cron reads across all elders
    "tools/drug_info.py",     # drug_cache write-through (reference table)
}
_UPLOAD_OBJECT_ALLOWED = {
    "tools/medications.py",   # pill-photo Storage upload
}


def _files_calling(pattern: str) -> set[str]:
    rx = re.compile(pattern)
    hits: set[str] = set()
    for path in _SRC.rglob("*.py"):
        if rx.search(path.read_text()):
            hits.add(path.relative_to(_SRC).as_posix())
    return hits


def test_service_client_callers_are_allowlisted():
    # Match calls (leading dot) so the def/docstring in db/supabase.py is excluded.
    assert _files_calling(r"\.service_client\(") == _SERVICE_CLIENT_ALLOWED


def test_upload_object_callers_are_allowlisted():
    assert _files_calling(r"\.upload_object\(") == _UPLOAD_OBJECT_ALLOWED

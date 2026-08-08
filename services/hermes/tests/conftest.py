import os

import pytest

# Must be set before hermes.config builds its cached Settings.
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret-at-least-32-characters-long")
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:54321")
os.environ.setdefault("SUPABASE_ANON_KEY", "anon-test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-test")


@pytest.fixture(autouse=True)
def _no_answer_buttons_by_default():
    """Turn `answer_buttons` OFF for every test that doesn't ask for it.

    It is ON in production. But it spends one EXTRA completion on the same
    client whenever a reply ends in a question mark — and most tests here drive
    `run_agent_turn` with a fake client holding a scripted sequence of
    responses, so that extra call silently eats the next scripted item and the
    assertion fails several steps later, a long way from the cause. (It did:
    `test_resolve_missed_doses_time_qualified` broke exactly this way, because a
    propose turn legitimately ends by asking "…shall I mark them all as taken?")

    `test_answer_buttons.py` re-enables it explicitly per test.
    """
    from hermes.config import get_settings

    settings = get_settings()
    previous = getattr(settings, "answer_buttons", True)
    object.__setattr__(settings, "answer_buttons", False)
    yield
    object.__setattr__(settings, "answer_buttons", previous)

"""Outbound markdown stripping (Item 7)."""

from hermes.channels.format import strip_markdown


def test_strips_bold_and_italic():
    assert strip_markdown("Take your **Metformin** now, it is *important*.") == (
        "Take your Metformin now, it is important."
    )


def test_strips_headings_backticks_and_links():
    text = "# Your medicines\nCall `get_drug_info`.\nSee [the label](http://x.io)."
    out = strip_markdown(text)
    assert "#" not in out
    assert "`" not in out
    assert "get_drug_info" in out
    assert "the label (http://x.io)" in out


def test_preserves_dosages_emoji_and_inner_words():
    # No markdown here — must pass through untouched (word-internal underscores too).
    text = "💊 Metformin 500mg — 🕗 8:00am. See eye_drops guide."
    assert strip_markdown(text) == text


def test_converts_star_bullets_to_dashes():
    assert strip_markdown("* Metformin\n* Aspirin") == "- Metformin\n- Aspirin"


def test_empty_is_safe():
    assert strip_markdown("") == ""

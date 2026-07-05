"""PDF text extraction (Item 2a)."""

from __future__ import annotations

import io

from hermes.channels.pdf import extract_pdf_text


def _one_page_pdf(text: str) -> bytes:
    # Minimal valid PDF with a single text-showing operator, built via pypdf's writer
    # is overkill; use reportlab-free raw PDF. Simpler: reuse pypdf to round-trip.
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_extract_returns_empty_on_garbage():
    assert extract_pdf_text(b"not a pdf at all") == ""


def test_extract_blank_pdf_is_empty_not_error():
    # A blank (image-less, text-less) PDF extracts to "" without raising.
    assert extract_pdf_text(_one_page_pdf("")) == ""


def test_extract_never_raises_on_truncated():
    assert extract_pdf_text(b"%PDF-1.4 truncated") == ""

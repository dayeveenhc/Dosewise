"""Extract text from an uploaded PDF (prescription list / medical history).

Text-based PDFs only — a scanned/image PDF yields little or no text, in which case
the caller should ask the elder to send a photo instead (the vision path handles
images). Bounded on pages and output size so a large upload can't blow up a turn.
"""

from __future__ import annotations

import io
import logging

log = logging.getLogger("hermes.pdf")

_MAX_PAGES = 20
_MAX_CHARS = 8000


def extract_pdf_text(data: bytes) -> str:
    """Return the text of a PDF, capped at ~20 pages / 8k chars. "" if none/failed.

    Never raises — a malformed or image-only PDF just returns "" so the channel can
    fall back gracefully.
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        parts: list[str] = []
        for page in reader.pages[:_MAX_PAGES]:
            try:
                parts.append(page.extract_text() or "")
            except Exception:
                continue
        text = "\n".join(p.strip() for p in parts if p.strip()).strip()
        return text[:_MAX_CHARS]
    except Exception:
        log.warning("failed to extract PDF text", exc_info=True)
        return ""

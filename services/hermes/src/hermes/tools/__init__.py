"""Importing this package registers all 28 tools (across 15 modules —
``doses`` and ``medications`` register five each; ``caregiver`` and ``refills``
register three each; ``profile`` registers two) into the registry."""

from . import (  # noqa: F401  (imported for registration side effects)
    caregiver,
    choices,
    doctor,
    doses,
    drug_info,
    escalation,
    interactions,
    medications,
    profile,
    refills,
    schedule,
    symptoms,
    verify,
    videos,
    walkthrough,
)
from .base import ToolContext, get_handler, tool_schemas

__all__ = ["ToolContext", "get_handler", "tool_schemas"]

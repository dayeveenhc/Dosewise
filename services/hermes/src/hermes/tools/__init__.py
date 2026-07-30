"""Importing this package registers all 25 tools (across 14 modules —
``doses`` and ``medications`` register five each; ``caregiver``, ``profile``
and ``refills`` register two each) into the registry."""

from . import (  # noqa: F401  (imported for registration side effects)
    caregiver,
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

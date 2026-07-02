"""Importing this package registers all 8 tools into the registry."""

from . import (  # noqa: F401  (imported for registration side effects)
    caregiver,
    doctor,
    doses,
    drug_info,
    escalation,
    medications,
    videos,
)
from .base import ToolContext, get_handler, tool_schemas

__all__ = ["ToolContext", "get_handler", "tool_schemas"]

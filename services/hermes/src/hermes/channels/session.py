"""In-memory conversation state for the test channels.

A ``SessionState`` holds one chat's mapped elder identity, its running message
history, and any pending prescription proposal (the scan-propose-confirm guard).
The ``SessionRegistry`` maps Telegram chat ids -> state and profile ids -> chat
ids (so message_caregiver can DM a linked caregiver who is also using the bot).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Seed identities from supabase/seed/seed.sql, addressable by short code.
SEED_ELDERS: dict[str, str] = {
    "a": "00000000-0000-0000-0000-00000000000a",  # Elder A (Caregiver C linked)
    "b": "00000000-0000-0000-0000-00000000000b",  # Elder B (isolation test)
}


@dataclass
class SessionState:
    elder_id: str
    registry: SessionRegistry | None = None
    pending_proposal: dict | None = None
    messages: list[dict] = field(default_factory=list)
    # Raw bytes of a just-received prescription photo, held until the elder confirms
    # the scan so add_prescription can persist it to the pill-photos bucket.
    pending_image: bytes | None = None
    # The elder's preferred dialect, fetched once from profiles and cached here so
    # the agent loop can tailor its language without a per-turn DB read.
    dialect: str | None = None
    dialect_loaded: bool = False
    # The elder's dialect slang glossary (from MongoDB), fetched once and cached.
    slang: list | None = None
    slang_loaded: bool = False


class SessionRegistry:
    def __init__(self, default_elder_id: str) -> None:
        self._default = default_elder_id
        self._by_chat: dict[int, SessionState] = {}
        self._profile_to_chat: dict[str, int] = {}

    def get(self, chat_id: int) -> SessionState:
        state = self._by_chat.get(chat_id)
        if state is None:
            state = SessionState(elder_id=self._default, registry=self)
            self._by_chat[chat_id] = state
            self._profile_to_chat[self._default] = chat_id
        return state

    def switch(self, chat_id: int, elder_id: str) -> None:
        state = self.get(chat_id)
        state.elder_id = elder_id
        state.messages = []
        state.pending_proposal = None
        state.pending_image = None
        state.dialect = None
        state.dialect_loaded = False
        state.slang = None
        state.slang_loaded = False
        self._profile_to_chat[elder_id] = chat_id

    def chat_for_profile(self, profile_id: str) -> int | None:
        return self._profile_to_chat.get(profile_id)

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
    # The last confidently-detected input language (ISO 639-3), kept so a short
    # tap or "yes" that can't be detected doesn't flip the conversation language.
    last_lang_iso: str | None = None
    # The elder's dialect slang glossary (from MongoDB), fetched once and cached.
    slang: list | None = None
    slang_loaded: bool = False
    # Set True by a tool that just PROPOSED something needing a yes/no (e.g.
    # add_prescription / set_medication_reminder with confirmed=false), cleared
    # once it commits or is refused. The Telegram channel reads it to attach a
    # Yes/No tap-keyboard so the elder can confirm without typing.
    awaiting_confirmation: bool = False
    # A pending set_medication_reminder proposal ({"name", "times"}), held until the
    # elder confirms so the commit can only ever save the times it read back.
    pending_reminder: dict | None = None
    # A pending update_medication_dosage proposal ({"name", "dosage"}), held until the
    # elder confirms so a dose change only ever saves the value it read back.
    pending_dosage: dict | None = None
    # The full list of missed-dose slots read back by resolve_missed_doses
    # ([{"medication_id", "name", "slot"}, ...]), held until the elder confirms so
    # the bulk commit can only ever mark slots that were enumerated to them.
    pending_missed_doses: list | None = None
    # Whether the elder wants spoken replies for typed messages too (from
    # profiles.accessibility.tts, or the /voice command). Default False — voice
    # mirrors the user: a voice note always gets a spoken reply, typed messages
    # get text unless they opt in.
    voice_default: bool = False
    voice_loaded: bool = False
    # Recent conversation_turns folded into the system prompt for cross-restart
    # continuity, loaded once per session (only when there's no live history yet).
    memory_text: str | None = None
    memory_loaded: bool = False
    # The elder's saved medical profile (allergies/conditions/history) from
    # profiles.accessibility.medical_profile, fetched once and cached so drug answers
    # can be tailored. Context only — never a source of grounded drug facts.
    medical_profile: str | None = None
    medical_profile_loaded: bool = False
    # A pending update_medical_profile proposal ({"content", "replace"}), held until
    # the elder confirms so a profile write only ever saves what was read back.
    pending_profile: dict | None = None
    # True while a /setup re-run forces guided-intake mode even though a profile
    # already exists. Cleared when a profile update commits.
    intake_active: bool = False


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
        state.last_lang_iso = None
        state.slang = None
        state.slang_loaded = False
        state.awaiting_confirmation = False
        state.pending_reminder = None
        state.pending_dosage = None
        state.pending_missed_doses = None
        state.voice_default = False
        state.voice_loaded = False
        state.memory_text = None
        state.memory_loaded = False
        state.medical_profile = None
        state.medical_profile_loaded = False
        state.pending_profile = None
        state.intake_active = False
        self._profile_to_chat[elder_id] = chat_id

    def chat_for_profile(self, profile_id: str) -> int | None:
        return self._profile_to_chat.get(profile_id)

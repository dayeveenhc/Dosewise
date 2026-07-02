"""Terminal REPL harness — the fastest dev/debug loop.

Runs the same ``run_agent_turn`` core as Telegram, printing each tool call inline
so you can watch the safety rails fire and see Supabase changes reflected.
Entry point: ``uv run hermes-chat``.
"""

from __future__ import annotations

import asyncio
import sys

from anthropic import AsyncAnthropic

from ..agent.loop import run_agent_turn
from ..config import get_settings
from ..db.supabase import Supabase
from ..tools import ToolContext
from .session import SEED_ELDERS, SessionRegistry

_DIM = "\033[2m"
_RESET = "\033[0m"


async def _repl() -> None:
    settings = get_settings()
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY is not set in .env — cannot start.", file=sys.stderr)
        return

    anthropic = AsyncAnthropic(api_key=settings.anthropic_api_key)
    supabase = Supabase()
    registry = SessionRegistry(settings.dev_default_elder_id)
    chat_id = 0  # single synthetic chat for the CLI
    state = registry.get(chat_id)

    print(f"Hermes CLI — acting as elder {state.elder_id}")
    print("Type a message, '/switch a|b', '/whoami', or Ctrl-D to quit.\n")

    loop = asyncio.get_event_loop()
    try:
        while True:
            try:
                line = await loop.run_in_executor(None, lambda: input("you › "))
            except EOFError:
                break
            text = line.strip()
            if not text:
                continue
            if text == "/whoami":
                print(f"{_DIM}(elder {state.elder_id}){_RESET}")
                continue
            if text.startswith("/switch"):
                code = text.split(maxsplit=1)[1].strip().lower() if " " in text else ""
                if code in SEED_ELDERS:
                    registry.switch(chat_id, SEED_ELDERS[code])
                    state = registry.get(chat_id)
                    print(f"{_DIM}(now elder {state.elder_id}){_RESET}")
                else:
                    print(f"{_DIM}usage: /switch a|b{_RESET}")
                continue

            ctx = ToolContext(supabase=supabase, elder_id=state.elder_id, session=state)
            reply, tools_used, state.messages = await run_agent_turn(
                anthropic, ctx, text, history=state.messages
            )
            if tools_used:
                print(f"{_DIM}[tools: {', '.join(tools_used)}]{_RESET}")
            print(f"hermes › {reply}\n")
    finally:
        await supabase.aclose()
        await anthropic.close()


def main() -> None:
    try:
        asyncio.run(_repl())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

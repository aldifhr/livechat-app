"""Event adapter protocol.

Every external event source implements the EventAdapter protocol. This
decouples providers (TikTok, YouTube Live, Twitch, etc.) from the core
pipeline so adding a new provider does not require changes to backend logic.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Protocol, TYPE_CHECKING
if TYPE_CHECKING:
    from events import Event


class EventAdapter(Protocol):
    """Interface for all streaming platform event sources."""

    provider: str

    async def connect(self, **kwargs: Any) -> bool:
        """Establish connection to the provider's live stream.

        Returns:
            True if connected successfully, False otherwise.
        """
        ...

    async def disconnect(self) -> None:
        """Gracefully disconnect from the provider."""
        ...

    async def observe(self) -> AsyncGenerator[Event, None]:
        """Yield normalized events from the provider stream."""
        ...

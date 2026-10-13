"""Event adapter protocols and provider registry.

Every external event source implements the EventAdapter protocol. This
decouples providers (TikTok, YouTube Live, Twitch, etc.) from the core
pipeline so adding a new provider does not require changes to backend logic.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Protocol, Type, TYPE_CHECKING
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


class ProviderRegistry:
    """Registry mapping provider names to adapter classes.

    Usage:
        registry = ProviderRegistry()
        registry.register("tiktok", TikTokAdapter)

        adapter = registry.create("tiktok", username="someuser")
    """

    def __init__(self) -> None:
        self._adapters: dict[str, Type[EventAdapter]] = {}

    def register(self, name: str, adapter_cls: Type[EventAdapter]) -> None:
        """Register an adapter class under a provider name."""
        self._adapters[name] = adapter_cls

    def create(self, name: str, **kwargs: Any) -> EventAdapter:
        """Instantiate an adapter for the given provider.

        Raises:
            KeyError if the provider is not registered.
        """
        if name not in self._adapters:
            raise KeyError(f"Unknown provider '{name}'. Registered: {list(self._adapters)}")

        adapter_cls = self._adapters[name]
        return adapter_cls(**kwargs)

    @property
    def providers(self) -> list[str]:
        return list(self._adapters.keys())


# Global registry instance
registry = ProviderRegistry()
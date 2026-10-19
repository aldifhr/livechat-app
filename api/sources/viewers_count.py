"""Whether a room's audience figure may be sent on, and what to say about it.

Extracted from `sources/tiktok.py` because the handler that makes this decision is
a nested function registered through `@client.on(...)`, and a test cannot reach
it. That has been the recurring lesson in this repo — a test that cannot invoke
the thing it is testing ends up asserting on the source text instead, which is
how the poll gate and the `viewers` branch both went unnoticed for so long.

So the decision lives here, takes plain values and returns a plain result, and
the handler does nothing but call it.

Three numbers arrive from the same room and must never be mixed:

    total       how many are watching right now   -> sizes the city
    total_user  how many have been in the room    -> a session statistic
    join.viewers the count carried on a join      -> not a viewer count

Measured live: `total_user` 627,555 against `join.viewers` 19,682, 31.9 times
apart, both still climbing. Before the switch the city was reading duration.
"""

from dataclasses import dataclass

#: A room cannot hold this many people. Past it the field is something else.
MAX_PLAUSIBLE_VIEWERS = 50_000_000

#: How many times bigger the count may get than the last one before it is
#: reported, as a ratio of the larger to the smaller.
#:
#: Symmetric on purpose. Measuring the change as `abs(count - last) / last` made
#: the downward direction unreachable: a drop can never move more than 100%, so
#: any threshold above 1.0 silently disabled it — a room falling from 12,000 to
#: 200 reported nothing at all, which is a worse failure than a room jumping.
#:
#: A viral moment genuinely moves a room severalfold in a minute, so this is high
#: on purpose: the goal is to notice that the field changed meaning, not to cap
#: growth. The figure is still delivered — freezing the city while the stream is
#: enormous would be the worse failure.
JUMP_REPORT_RATIO = 3.0


@dataclass(frozen=True)
class Verdict:
    """What to send, and whether the operator should be told something."""

    #: The count to dispatch, or None when it is not worth sending.
    count: int | None
    #: A message for the log, or None when there is nothing to say.
    warning: str | None
    #: The count to remember for the next comparison.
    last: int


def judge(count: int, last: int, total_user: int) -> Verdict:
    """Decide whether `count` is a live audience figure worth forwarding.

    `last` is the previous accepted figure; pass 0 for the first one, which
    suppresses the jump check because there is nothing to compare against.
    """
    if count < 0 or count > MAX_PLAUSIBLE_VIEWERS:
        return Verdict(
            None,
            f"viewer count out of range ({count}, total_user {total_user}); ignoring",
            last,
        )

    warning = None
    if last > 0:
        # Larger over smaller, so a fall is judged as sharply as a rise.
        jump = max(count, last) / max(min(count, last), 1)
        if jump > JUMP_REPORT_RATIO:
            warning = (
                f"viewer count jumped {jump:.1f}x in one beat "
                f"({last} -> {count}, total_user {total_user})"
            )

    return Verdict(count, warning, count)
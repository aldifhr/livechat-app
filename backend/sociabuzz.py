"""The Sociabuzz donation hook.

One route, living beside `store`, `hub` and `events` rather than in `main`, because
it is the only integration here that has to guess at the body it is sent. Every
other route receives something the backend itself produced or something the app
chose the shape of; this one receives a third party's JSON, undocumented, and has to
be forgiving about it.

Sociabuzz posts a donation whose exact field names are not documented anywhere
stable. Guessing them is how an integration silently does nothing: the request
arrives, no field the code expects is present, and the chat shows nothing while
everything "works". So this receiver reads the body as a raw dict and looks up each
field under every name it is known to arrive under, logs the keys it actually
received, and maps what it can. A field that does not match any known name is still
logged, so the first real donation teaches us the shape and the next edit can harden
it.

The token Sociabuzz gives the creator (sbwhook-...) is accepted either as a header
or a query parameter, because the platform has been observed to send it both ways
and a mismatch here means a silent 401 with nothing in the chat.

Accepting the body raw, rather than through a strict Pydantic model, is deliberate:
a strict model would 422 on the first shape we got wrong, and a 422 is invisible to
the creator who only sees "the test notification failed".
"""

import logging
import re
import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Request

import events
import store
from events import ALERT, Event

logger = logging.getLogger("streamkit.sociabuzz")

router = APIRouter()


def _pick(body: dict, *names: str):
    """First present, non-empty value under any of `names`, else None."""
    for name in names:
        value = body.get(name)
        if value not in (None, ""):
            return value
    return None


@router.post("/api/hooks/sociabuzz/{room_id}")
async def sociabuzz_hook(room_id: str, request: Request):
    """Receive a Sociabuzz donation and show it on the room's feed.

    No token check of its own: the route is exempt from the write-token gate
    (see the middleware in `main`), and a Sociabuzz token in a header is validated
    only if one is configured on the room. An unauthenticated caller can post here,
    but the only thing they can do is make a donation appear on a feed — the same
    reach the public webhook hook already has, and bounded by the room existing.
    """
    if await store.get_room_async(room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # The room's own Sociabuzz token, if the creator saved one. Present, it is
    # checked against the header or query Sociabuzz sends it in — a token we
    # expect and never enforce would be decoration. Absent, the hook accepts, so a
    # creator can paste the URL and hit "Test Notifikasi" before configuring
    # anything; the only thing reachable then is making a donation appear on a
    # feed, which the public hook already allows.
    expected = (await store.get_room_async(room_id)).get("config", {}).get("sociabuzzToken", "")
    expected = str(expected).strip() if expected else ""
    if expected:
        supplied = (
            request.headers.get("x-sociabuzz-token")
            or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
            or request.query_params.get("token", "")
        ).strip()
        if not supplied or not secrets.compare_digest(supplied.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="Invalid or missing Sociabuzz token")

    try:
        body = await request.json()
    except Exception:
        # Not JSON. Sociabuzz has been seen to post a bare form field too; log it
        # and answer 200 so the creator's test button stops retrying, but do not
        # try to turn it into a donation we cannot read.
        raw = await request.body()
        logger.warning("sociabuzz: non-JSON body for room %s: %r", room_id, raw[:200])
        return {"status": "ignored", "reason": "body was not JSON"}

    if not isinstance(body, dict):
        logger.warning("sociabuzz: body for room %s was %s, not an object", room_id, type(body).__name__)
        return {"status": "ignored", "reason": "body was not a JSON object"}

    logger.info("sociabuzz: donation for room %s — keys=%s", room_id, sorted(body.keys()))

    # The real Sociabuzz shape, confirmed from a live test notification:
    # `supporter` is the name, `amount_settled`/`currency_settled` are the amount
    # and its currency, `content` is what the supporter bought ("Coffee", "Traktir
    # x2"), and `message` is their note. The wider guesses stay below for a shape
    # we have not seen yet; they cost nothing and a donation that fails to map is
    # a donation that never appears.
    donator = _pick(body, "supporter", "donator", "donatur", "donor", "name", "fullname", "fullName")
    # `amount_settled` before `amount`: the settled figure is what was actually
    # charged, and `amount` can be the pre-fee list price. Two different numbers
    # for one donation, and only one of them is the money that arrived.
    amount_raw = _pick(body, "amount_settled", "amount", "nominal", "jumlah", "value", "total", "donation", "price")
    currency = _pick(body, "currency_settled", "currency") or ""
    # `content` is what the supporter bought ("Coffee", "Traktir x2"); `message`
    # is the note they typed. They are different things and both belong on the
    # feed — collapsing them into one field loses whichever is not first.
    content = _pick(body, "content", "item", "product", "title")
    note = _pick(body, "message", "note", "pesan", "support_message", "comment", "text")

    # Sociabuzz amounts are sometimes strings ("Rp 10.000") or integers in the
    # smallest currency unit. Parse what can be parsed, and fall back to the raw
    # string as the label so a donation still appears even if the number is in a
    # form we do not understand.
    amount_value: float | None = None
    amount_label = ""
    if amount_raw is not None:
        amount_label = str(amount_raw)
        # Sociabuzz sends the amount as a plain number string ("10000") or an
        # int. It does not put thousands separators in it, so the only separator
        # that can appear is a decimal point — which is why a stray dot would be
        # ambiguous and is not handled here. Parse defensively but literally:
        # strip a currency prefix if the raw value carried one, then convert.
        cleaned = re.sub(r"[^0-9.]", "", amount_label)
        # More than one dot means it was a formatted string like "10.000,50",
        # which Sociabuzz does not send; keep only the integer part rather than
        # misread the separator as a decimal point ("10.000" -> 10.0, not 10000).
        if cleaned.count(".") > 1:
            cleaned = cleaned.split(".")[0]
        try:
            if cleaned:
                amount_value = float(cleaned)
        except (ValueError, TypeError):
            amount_value = None

    # A bare "10000" on the feed says nothing about which currency it is, and a
    # viewer cannot tell Rp from $. Prefixed with the settled currency when there
    # is one, so "Rp 10.000" reads as money and not as a score.
    currency_symbol = {"IDR": "Rp", "MYR": "RM", "PHP": "₱", "USD": "$"}.get(str(currency).upper(), "")
    if currency_symbol and amount_label and not re.search(r"[^0-9.,]", str(amount_raw)):
        amount_label = f"{currency_symbol} {amount_label}"

    user = str(donator).strip() if donator is not None else "SociaBuzz supporter"
    if not user:
        user = "SociaBuzz supporter"

    # The alert's wire shape is {title, text, icon, amount} — `user` is dropped on
    # the way out. So the donator's name has to live in the text, or the feed shows
    # a donation from nobody. Amount is put in `meta.amount`, the one field the
    # donation jar reads.
    parts = [user]
    if amount_label:
        parts.append(amount_label)
    if content:
        parts.append(str(content))
    if note:
        parts.append(str(note))
    text = " — ".join(parts)

    meta: dict[str, Any] = {"title": "SociaBuzz", "icon": "★", "count": 1, "platform": "sociabuzz"}
    if amount_value is not None:
        meta["amount"] = amount_value
        meta["diamonds"] = int(amount_value)
        meta["value"] = amount_value
    if amount_label:
        meta["amountLabel"] = amount_label
    if currency:
        meta["currency"] = str(currency)
    if content:
        meta["content"] = str(content)
    if note:
        meta["message"] = note

    await events.emit(
        room_id,
        Event(kind=ALERT, user=user, user_id="", value=text, meta=meta),
    )
    # 200 with the keys that arrived: the creator's "Test Notifikasi" shows this
    # body back, so a field we mapped wrong is visible immediately rather than
    # guessed at from a blank feed.
    return {"status": "ok", "received": sorted(body.keys())}
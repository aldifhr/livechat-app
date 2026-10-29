"""Publish and read public giveaway report snapshots."""

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import giveaway_store

router = APIRouter()
MAX_REPORT_BYTES = 2 * 1024 * 1024
SNAPSHOT_ID = re.compile(r"^[A-Za-z0-9_-]{16}$")


class SnapshotRequest(BaseModel):
    report: dict[str, Any] = Field(...)


@router.post("/api/giveaways/snapshots")
async def create_giveaway_snapshot(request: SnapshotRequest):
    """Store one published report and mint its public id.

    Token-gated like any other write. The desktop app has no credential, so it
    publishes through the dashboard's own `/api/giveaways/snapshots` route, which
    validates the report, rate-limits the caller and forwards this with the token
    attached. The exemption this route used to carry bought nothing that worked
    and cost an unauthenticated write straight at the backend: the cap is 1,000
    snapshots at 2 MB each, so anyone who found the host could fill it and lock
    real publishing out, and each write rewrites the whole JSON file under the
    store lock from inside an async handler.
    """
    try:
        encoded = json.dumps(request.report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="The giveaway report is invalid")
    if len(encoded) > MAX_REPORT_BYTES:
        raise HTTPException(status_code=413, detail="The giveaway report is too large (2 MB maximum)")
    if request.report.get("format") != "livechat-giveaway-audit-v1":
        raise HTTPException(status_code=400, detail="Unsupported giveaway report format")
    entrants = request.report.get("entrants")
    if not isinstance(entrants, list) or len(entrants) > 20_000:
        raise HTTPException(status_code=400, detail="The entrant list is invalid")
    draws = request.report.get("draws")
    if not isinstance(draws, list) or not draws or len(draws) > 100:
        raise HTTPException(status_code=400, detail="At least one completed winner draw is required")
    try:
        return await giveaway_store.create_snapshot_async(request.report)
    except giveaway_store.SnapshotCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/giveaways/snapshots")
async def list_giveaway_snapshots() -> dict[str, Any]:
    """List every stored giveaway snapshot, newest first.

    Token-gated, because the list is the ids and an id is the whole credential
    for the report behind it. The report body is excluded — a list request would
    otherwise carry every full report — and the dashboard reaches this through
    its proxy, which attaches the token.
    """
    return {"snapshots": await giveaway_store.list_snapshots_async()}


@router.get("/api/giveaways/snapshots/{snapshot_id}")
async def read_giveaway_snapshot(snapshot_id: str):
    """One report, by id, to anyone holding the link.

    This is the read the shared link depends on, so it stays open with no
    credential — the id is unguessable and the collection that would hand the ids
    out is gated. The DELETE below is a write like any other and carries the token.
    """
    if not SNAPSHOT_ID.fullmatch(snapshot_id):
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    snapshot = await giveaway_store.get_snapshot_async(snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    return snapshot


@router.delete("/api/giveaways/snapshots/{snapshot_id}")
async def delete_giveaway_snapshot(snapshot_id: str) -> dict[str, Any]:
    """Remove a published snapshot, so its public link stops resolving.

    Only for the operator: this is a write, so it carries the token like every
    other one. Deletes are irreversible — the report is not kept anywhere else —
    hence the confirmation the dashboard puts in front of it.
    """
    if not SNAPSHOT_ID.fullmatch(snapshot_id):
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    if not await giveaway_store.delete_snapshot_async(snapshot_id):
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    return {"status": "deleted"}

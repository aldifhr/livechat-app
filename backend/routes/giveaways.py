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
        return giveaway_store.create_snapshot(request.report)
    except giveaway_store.SnapshotCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/giveaways/snapshots/{snapshot_id}")
async def read_giveaway_snapshot(snapshot_id: str):
    if not SNAPSHOT_ID.fullmatch(snapshot_id):
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    snapshot = giveaway_store.get_snapshot(snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Giveaway report not found")
    return snapshot

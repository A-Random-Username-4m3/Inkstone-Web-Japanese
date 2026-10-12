"""Helpers for invalidating Inkstone's offline cache after data rebuilds."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
import secrets

REVISION_RE = re.compile(r"^(\s*)return '[^']*'; // INKSTONE_DATA_REVISION$", re.MULTILINE)


def bump_data_revision(sw_path: Path | None = None, revision: str | None = None) -> str:
    """Rewrite sw.js's data revision marker so deployed PWAs fetch rebuilt data."""
    if sw_path is None:
        sw_path = Path(__file__).resolve().parents[1] / 'sw.js'
    if revision is None:
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        revision = f"{stamp}-{secrets.token_hex(3)}"
    text = sw_path.read_text(encoding='utf-8')
    match = REVISION_RE.search(text)
    if not match:
        raise ValueError(f'{sw_path} has no INKSTONE_DATA_REVISION marker')
    replacement = f"{match.group(1)}return '{revision}'; // INKSTONE_DATA_REVISION"
    sw_path.write_text(REVISION_RE.sub(replacement, text, count=1), encoding='utf-8')
    return revision

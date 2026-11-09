"""Monthly usage counters, so the app never spends more than its budget.

Counters are stored in a small JSON file and reset automatically when the
month changes. A lock keeps them correct when two requests arrive together.
"""

import json
import threading
from datetime import datetime, timezone
from pathlib import Path


class UsageTracker:
    def __init__(self, file_path: Path):
        self.file_path = file_path
        self._lock = threading.Lock()

    @staticmethod
    def _current_month() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m")

    def _read(self) -> dict:
        empty = {"month": self._current_month(), "claude_usd": 0.0, "claude_requests": 0, "places_requests": 0}
        try:
            data = json.loads(self.file_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return empty
        # New month -> start from zero again.
        if data.get("month") != empty["month"]:
            return empty
        return {**empty, **data}

    def _write(self, data: dict) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(self.file_path)

    def snapshot(self) -> dict:
        with self._lock:
            return self._read()

    def claude_budget_left(self, monthly_budget_usd: float) -> bool:
        with self._lock:
            return self._read()["claude_usd"] < monthly_budget_usd

    def add_claude_cost(self, usd: float) -> None:
        with self._lock:
            data = self._read()
            data["claude_usd"] = round(data["claude_usd"] + usd, 6)
            data["claude_requests"] += 1
            self._write(data)

    def try_use_places(self, monthly_limit: int) -> bool:
        """Reserve one Places request. Returns False when the monthly limit is reached."""
        with self._lock:
            data = self._read()
            if data["places_requests"] >= monthly_limit:
                return False
            data["places_requests"] += 1
            self._write(data)
            return True

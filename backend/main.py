"""Backend for 台灣好味道抽籤所.

Run from the backend folder:
    uvicorn main:app --reload
then open http://127.0.0.1:8000

Endpoints
    POST /api/recommend  - AI recommendation (falls back to random when needed)
    POST /api/nearby     - restaurants near the user (Google Places)
    GET  /api/health     - which services are configured
Everything else is served from the frontend folder (index.html, app.js, ...).
"""

import json
import logging
import os
import random
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from claude_service import ClaudeError, ClaudeService
from maps_service import PlacesError, PlacesService
from usage_tracker import UsageTracker

BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("food-app")

# ---------- Settings (all can be changed in .env) ----------
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", BACKEND_DIR.parent / "frontend")).resolve()
FOODS_FILE = FRONTEND_DIR / "foods.json"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-haiku-5-5")
CLAUDE_MONTHLY_BUDGET_USD = float(os.getenv("CLAUDE_MONTHLY_BUDGET_USD", "3"))
CLAUDE_INPUT_PRICE = float(os.getenv("CLAUDE_INPUT_PRICE_PER_MTOK", "0.10"))
CLAUDE_OUTPUT_PRICE = float(os.getenv("CLAUDE_OUTPUT_PRICE_PER_MTOK", "0.50"))

GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
PLACES_MONTHLY_LIMIT = int(os.getenv("PLACES_MONTHLY_LIMIT", "900"))
PLACES_RADIUS_M = int(os.getenv("PLACES_RADIUS_M", "2000"))

RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "10"))

PREFERENCE_NAMES = {
    "湯類", "辣", "甜", "健康", "輕食", "重口味", "想吃肉", "想吃海鮮",
    "想吃蔬菜", "熱食", "冰品", "省錢", "犒賞自己", "一個人吃", "聚餐", "宵夜",
}


# ---------- Load the food database once at startup ----------
def load_foods() -> dict[str, dict]:
    try:
        data = json.loads(FOODS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"找不到 {FOODS_FILE}。請確認 foods.json（全部小寫）放在 frontend 資料夾。")
    foods = {}
    for food in data:
        food_id = str(food["id"])
        if food_id in foods:
            raise SystemExit(f"foods.json 有重複的 id：{food_id}")
        foods[food_id] = food
    return foods


FOODS = load_foods()
usage = UsageTracker(BACKEND_DIR / "usage.json")
claude = ClaudeService(ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_INPUT_PRICE, CLAUDE_OUTPUT_PRICE) if ANTHROPIC_API_KEY else None
places = PlacesService(GOOGLE_MAPS_API_KEY, PLACES_RADIUS_M) if GOOGLE_MAPS_API_KEY else None

logger.info("Loaded %d foods from %s", len(FOODS), FOODS_FILE)
logger.info("Claude: %s | Google Places: %s", "ON" if claude else "OFF (no key)", "ON" if places else "OFF (no key)")

app = FastAPI(title="台灣好味道抽籤所 API")


# ---------- Simple per-IP rate limit (protects the API budget) ----------
_recent_calls: dict[str, deque] = defaultdict(deque)


def check_rate_limit(request: Request, bucket: str) -> None:
    key = f"{bucket}:{request.client.host if request.client else 'unknown'}"
    now = time.monotonic()
    calls = _recent_calls[key]
    while calls and now - calls[0] > 60:
        calls.popleft()
    if len(calls) >= RATE_LIMIT_PER_MINUTE:
        raise HTTPException(status_code=429, detail="請求太頻繁了，請休息一分鐘再試。")
    calls.append(now)


# ---------- Request bodies ----------
class CandidateRef(BaseModel):
    # The frontend sends whole food objects; we only trust the id
    # and read the real data from our own foods.json.
    model_config = ConfigDict(extra="ignore")
    id: int | str


class RecommendRequest(BaseModel):
    preferences: list[str] = Field(default_factory=list, max_length=20)
    mood: str = ""
    excludePreviousId: int | str | None = None
    candidates: list[CandidateRef] = Field(min_length=1, max_length=200)


class NearbyRequest(BaseModel):
    foodId: int | str
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    area: str = Field(default="", max_length=60)


# ---------- Routes ----------
@app.get("/api/health")
def health():
    return {"foods": len(FOODS), "claude": claude is not None, "places": places is not None}


def random_fallback(candidates: list[dict], note: str) -> dict:
    food = random.choice(candidates)
    return {"recommendation": {"foodId": food["id"], "reason": f"{note}先從符合條件的餐點中隨機幫你挑了「{food['name']}」。"}, "source": "fallback"}


@app.post("/api/recommend")
def recommend(body: RecommendRequest, request: Request):
    check_rate_limit(request, "recommend")

    exclude_id = str(body.excludePreviousId) if body.excludePreviousId is not None else None
    candidates, seen = [], set()
    for ref in body.candidates:
        food_id = str(ref.id)
        if food_id in FOODS and food_id != exclude_id and food_id not in seen:
            seen.add(food_id)
            candidates.append(FOODS[food_id])
    if not candidates:
        raise HTTPException(status_code=400, detail="沒有可推薦的候選餐點。")

    preferences = [p for p in body.preferences if p in PREFERENCE_NAMES]
    mood = body.mood.strip()[:240]
    previous_name = FOODS[exclude_id]["name"] if exclude_id in FOODS else None

    if claude is None:
        return random_fallback(candidates, "AI 服務尚未設定，")
    if not usage.claude_budget_left(CLAUDE_MONTHLY_BUDGET_USD):
        return random_fallback(candidates, "本月 AI 推薦額度已用完，")

    try:
        food_id, reason, cost = claude.recommend(candidates, preferences, mood, previous_name)
    except ClaudeError as error:
        logger.warning("Claude failed, using random fallback: %s", error)
        return random_fallback(candidates, "AI 暫時沒有回應，")

    usage.add_claude_cost(cost)
    logger.info("Claude picked %s (cost $%.5f)", FOODS[food_id]["name"], cost)
    return {"recommendation": {"foodId": FOODS[food_id]["id"], "reason": reason}, "source": "claude"}


@app.post("/api/nearby")
async def nearby(body: NearbyRequest, request: Request):
    check_rate_limit(request, "nearby")

    food = FOODS.get(str(body.foodId))
    if food is None:
        raise HTTPException(status_code=400, detail="找不到這道餐點。")
    has_location = body.latitude is not None and body.longitude is not None
    area = body.area.strip()
    if not has_location and not area:
        raise HTTPException(status_code=400, detail="請允許定位，或輸入你所在的地區（例如：台北市大安區）。")

    if places is None:
        raise HTTPException(status_code=503, detail="附近餐廳搜尋尚未設定（缺少 Google Maps API key）。")
    if not usage.try_use_places(PLACES_MONTHLY_LIMIT):
        raise HTTPException(status_code=503, detail="本月附近餐廳搜尋額度已用完，下個月再來找找吧。")

    try:
        results = await places.search_nearby(food["name"], body.latitude, body.longitude, area)
    except PlacesError as error:
        logger.warning("Places failed: %s", error)
        raise HTTPException(status_code=502, detail="附近餐廳搜尋暫時無法使用，請稍後再試。")

    return {"food": food["name"], "places": results}


# Serve the frontend last, so /api/... routes are matched first.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

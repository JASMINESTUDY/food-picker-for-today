"""Find restaurants near the user with Google Places API (New) - Text Search.

Billing note: the field mask decides the price. places.rating and
places.userRatingCount put every call in the "Text Search Enterprise" SKU
(1,000 free calls per month at the time of writing). Do not add more fields
without checking Google's pricing page first.
"""

import math

import httpx

TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.googleMapsUri",
    "places.rating",
    "places.userRatingCount",
    "places.businessStatus",
])


class PlacesError(Exception):
    """Google Places could not answer."""


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    """Straight-line distance in metres (haversine formula)."""
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)))


class PlacesService:
    def __init__(self, api_key: str, search_radius_m: int = 2000, max_results: int = 9):
        self.api_key = api_key
        self.search_radius_m = search_radius_m
        self.max_results = max_results

    async def search_nearby(self, food_name: str, latitude: float | None, longitude: float | None, area: str) -> list[dict]:
        has_location = latitude is not None and longitude is not None
        body: dict = {
            # With an area typed by the user: "牛肉麵 台北市大安區". With GPS: just "牛肉麵".
            "textQuery": f"{food_name} {area}".strip() if area else food_name,
            "languageCode": "zh-TW",
            "regionCode": "TW",
            "pageSize": self.max_results,
        }
        if has_location:
            body["locationBias"] = {
                "circle": {
                    "center": {"latitude": latitude, "longitude": longitude},
                    "radius": float(self.search_radius_m),
                }
            }

        headers = {"X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": FIELD_MASK}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(TEXT_SEARCH_URL, json=body, headers=headers)
        except httpx.HTTPError as error:
            raise PlacesError(f"Network error: {error}") from error
        if response.status_code != 200:
            raise PlacesError(f"Google Places returned {response.status_code}: {response.text[:300]}")

        results = []
        for place in response.json().get("places", []):
            if place.get("businessStatus") not in (None, "OPERATIONAL"):
                continue  # skip closed shops
            location = place.get("location") or {}
            distance = None
            if has_location and "latitude" in location and "longitude" in location:
                distance = _distance_m(latitude, longitude, location["latitude"], location["longitude"])
            results.append({
                "id": place.get("id"),
                "name": (place.get("displayName") or {}).get("text", "（未提供名稱）"),
                "address": place.get("formattedAddress", ""),
                "rating": place.get("rating"),
                "ratingCount": place.get("userRatingCount"),
                "mapsUrl": place.get("googleMapsUri"),
                "distanceM": distance,
            })
        return results

(() => {
  const LOAD_DURATION_MS = 3000;
  const RECOMMENDATION_ENDPOINT = "/api/recommend";
  const NEARBY_ENDPOINT = "/api/nearby";
  const PLACES_PER_PAGE = 3;
  const HEALTH_ENDPOINT = "/api/health";
  const MAPS_SEARCH_URL = "https://www.google.com/maps/search/?api=1&query=";
  const LOCATION_TEXT = {
    maps: {
      copy: "你已經決定好這一餐了。按下按鈕，在 Google Maps 找附近的店家，評價和路線都看得到。",
      button: "📍 在 Google Maps 尋找附近餐廳",
      note: "本網站不會讀取你的位置，搜尋會在 Google Maps 中開啟。"
    },
    places: {
      copy: "你已經決定好這一餐了。按下按鈕，幫你找附近評價不錯的店家。",
      button: "📍 尋找附近餐廳",
      note: "只有按下按鈕才會詢問定位，位置僅用於這次搜尋，不會儲存。"
    }
  };
  const requiredFlags = [
    "spicy",
    "sweet",
    "healthy",
    "light",
    "budget",
    "solo",
    "group",
    "lateNight"
  ];
  const nutritionFields = ["kcal", "protein", "fat", "carbs"];
  const preferenceNames = [
    "湯類",
    "辣",
    "甜",
    "健康",
    "輕食",
    "重口味",
    "想吃肉",
    "想吃海鮮",
    "想吃蔬菜",
    "熱食",
    "冰品",
    "省錢",
    "犒賞自己",
    "一個人吃",
    "聚餐",
    "宵夜"
  ];
  const loadingMessages = [
    "🔮 正在詢問台灣美食之神...",
    "🍜 正在熬煮牛肉湯底...",
    "🥢 正在分析你的肚子需求...",
    "🤔 今天真的不想喝珍珠奶茶嗎？",
    "💸 正在計算快樂值與預算比例...",
    "😅 正在排除上一道推薦...",
    "🐷 正在評估今天放縱一下是否合理..."
  ];

  const elements = {
    randomMode: document.querySelector("#random-mode"),
    aiMode: document.querySelector("#ai-mode"),
    preferenceGrid: document.querySelector("#preference-grid"),
    moodInput: document.querySelector("#mood-input"),
    generateButton: document.querySelector("#generate-button"),
    statusMessage: document.querySelector("#status-message"),
    loadingOverlay: document.querySelector("#loading-overlay"),
    loadingMessage: document.querySelector("#loading-message"),
    resultSection: document.querySelector("#result-section"),
    resultName: document.querySelector("#result-name"),
    resultCategory: document.querySelector("#result-category"),
    resultReason: document.querySelector("#result-reason"),
    nutritionKcal: document.querySelector("#nutrition-kcal"),
    nutritionProtein: document.querySelector("#nutrition-protein"),
    nutritionFat: document.querySelector("#nutrition-fat"),
    nutritionCarbs: document.querySelector("#nutrition-carbs"),
    rerollButton: document.querySelector("#reroll-button"),
    confirmButton: document.querySelector("#confirm-button"),
    locationSection: document.querySelector("#location-section"),
    nearbyButton: document.querySelector("#nearby-button"),
    locationFeedback: document.querySelector("#location-feedback"),
    areaInput: document.querySelector("#area-input"),
    nearbyList: document.querySelector("#nearby-list"),
    moreButton: document.querySelector("#more-button"),
    placesAttribution: document.querySelector("#places-attribution"),
    locationCopy: document.querySelector("#location-copy"),
    nearbyLabel: document.querySelector("#nearby-label"),
    locationNoteText: document.querySelector("#location-note-text")
  };

  let foods = [];
  let mode = "random";
  let currentFood = null;
  let lastRandomFoodId = null;
  let lastAiFoodId = null;
  let isBusy = false;
  let loadingTimer = null;
  let nearbyPlaces = [];
  let nearbyShown = 0;
  let isSearchingNearby = false;
  // false = no Google key on the server -> open Google Maps instead (free, no key needed)
  let placesEnabled = false;

  function setStatus(message, tone = "") {
    elements.statusMessage.textContent = message;
    elements.statusMessage.classList.toggle("is-error", tone === "error");
    elements.statusMessage.classList.toggle("is-success", tone === "success");
  }

  function validateFoods(data) {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("foods.json 必須是至少包含一道餐點的 JSON 陣列。");
    }

    const seenIds = new Set();
    data.forEach((food, index) => {
      const label = `第 ${index + 1} 筆`;
      if (!food || typeof food !== "object" || Array.isArray(food)) {
        throw new Error(`${label}不是有效的餐點物件。`);
      }
      if ((typeof food.id !== "number" && typeof food.id !== "string") || String(food.id).trim() === "") {
        throw new Error(`${label}缺少有效的 id。`);
      }
      if (seenIds.has(String(food.id))) {
        throw new Error(`餐點 id「${food.id}」重複，請先修正 foods.json。`);
      }
      seenIds.add(String(food.id));

      if (typeof food.name !== "string" || !food.name.trim()) {
        throw new Error(`${label}缺少餐點名稱。`);
      }
      if (typeof food.category !== "string" || !food.category.trim()) {
        throw new Error(`「${food.name}」缺少 category。`);
      }
      if (!Array.isArray(food.tags) || !food.tags.every((tag) => typeof tag === "string")) {
        throw new Error(`「${food.name}」的 tags 必須是文字陣列。`);
      }

      for (const field of requiredFlags) {
        if (typeof food[field] !== "boolean") {
          throw new Error(`「${food.name}」的 ${field} 必須是 true 或 false。`);
        }
      }
      for (const field of nutritionFields) {
        if (!Number.isFinite(food[field]) || food[field] < 0) {
          throw new Error(`「${food.name}」的 ${field} 必須是非負數字。`);
        }
      }
    });
    return data;
  }

  function getTags(food) {
    return new Set(food.tags.map((tag) => tag.trim()));
  }

  function hasAnyTag(tags, names) {
    return names.some((name) => tags.has(name));
  }

  function matchesPreference(food, preference) {
    const tags = getTags(food);
    switch (preference) {
      case "湯類":
        return tags.has("湯類") || ["湯品", "鍋物", "火鍋/湯品"].includes(food.category);
      case "辣":
        return food.spicy || tags.has("辣");
      case "甜":
        return food.sweet || tags.has("甜");
      case "健康":
        return food.healthy || tags.has("健康");
      case "輕食":
        return food.light || tags.has("輕食");
      case "重口味":
        return tags.has("重口味");
      case "想吃肉":
        return hasAnyTag(tags, ["肉類", "肉品", "肉"]);
      case "想吃海鮮":
        return hasAnyTag(tags, ["海鮮", "海產"]);
      case "想吃蔬菜":
        return hasAnyTag(tags, ["蔬菜", "素食"]);
      case "熱食":
        return tags.has("熱食");
      case "冰品":
        return tags.has("冰品") || food.category === "冰品";
      case "省錢":
        return food.budget;
      case "犒賞自己":
        return tags.has("犒賞自己");
      case "一個人吃":
        return food.solo;
      case "聚餐":
        return food.group || tags.has("聚餐");
      case "宵夜":
        return food.lateNight || tags.has("宵夜");
      default:
        return false;
    }
  }

  function getSelectedPreferences() {
    return Array.from(
      elements.preferenceGrid.querySelectorAll('input[name="preference"]:checked'),
      (input) => input.value
    );
  }

  function getMatchingFoods(preferences) {
    if (!preferences.length) return foods;
    return foods.filter((food) => preferences.every((preference) => matchesPreference(food, preference)));
  }

  function setMode(nextMode) {
    mode = nextMode;
    elements.randomMode.setAttribute("aria-pressed", String(mode === "random"));
    elements.aiMode.setAttribute("aria-pressed", String(mode === "ai"));
    elements.generateButton.querySelector(".generate-label").textContent =
      mode === "random" ? "幫我隨機抽一道" : "請 AI 替我推薦";
    setStatus("");
  }

  function setLoading(isLoading) {
    elements.loadingOverlay.hidden = !isLoading;
    elements.generateButton.disabled = isLoading || foods.length === 0;
    elements.rerollButton.disabled = isLoading;
    elements.confirmButton.disabled = isLoading || !currentFood;
    elements.randomMode.disabled = isLoading;
    elements.aiMode.disabled = isLoading;
    for (const input of elements.preferenceGrid.querySelectorAll('input[name="preference"]')) {
      input.disabled = isLoading;
    }
    if (!isLoading && loadingTimer !== null) {
      window.clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function waitForLoadingScreen() {
    let messageIndex = 0;
    elements.loadingMessage.textContent = loadingMessages[messageIndex];
    loadingTimer = window.setInterval(() => {
      messageIndex = (messageIndex + 1) % loadingMessages.length;
      elements.loadingMessage.textContent = loadingMessages[messageIndex];
    }, 700);
    return new Promise((resolve) => window.setTimeout(resolve, LOAD_DURATION_MS));
  }

  function formatNutrition(value) {
    return Number(value).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
  }

  function showRecommendation(food, reason) {
    currentFood = food;
    elements.resultName.textContent = food.name;
    elements.resultCategory.textContent = food.category;
    elements.resultReason.textContent = reason;
    elements.nutritionKcal.textContent = formatNutrition(food.kcal);
    elements.nutritionProtein.textContent = formatNutrition(food.protein);
    elements.nutritionFat.textContent = formatNutrition(food.fat);
    elements.nutritionCarbs.textContent = formatNutrition(food.carbs);
    elements.resultSection.hidden = false;
    elements.locationSection.hidden = true;
    elements.locationFeedback.textContent = "";
    resetNearby();
    elements.confirmButton.disabled = false;
    elements.resultName.setAttribute("tabindex", "-1");
    elements.resultName.focus();
  }

  function chooseRandomFood(candidates, preferences) {
    const alternatives = candidates.filter((food) => food.id !== lastRandomFoodId);
    const pool = alternatives.length ? alternatives : candidates;
    const food = pool[Math.floor(Math.random() * pool.length)];
    lastRandomFoodId = food.id;
    const reason = preferences.length
      ? `依照你選擇的「${preferences.join("、")}」，從符合條件的餐點中隨機抽出。`
      : `從 ${foods.length} 道餐點中隨機抽出，今天就交給一點運氣。`;
    return { food, reason };
  }

  async function requestAiRecommendation(candidates, preferences, excludeId) {
    const response = await fetch(RECOMMENDATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferences,
        mood: elements.moodInput.value.trim(),
        excludePreviousId: excludeId,
        candidates
      })
    });

    if (response.status === 404) {
      throw new Error("AI 服務尚未連線。請先啟動 Python 後端，或切換到「隨機抽選」。");
    }
    if (!response.ok) {
      throw new Error(`AI 推薦暫時無法使用（${response.status}）。請稍後再試。`);
    }

    const result = await response.json();
    const recommendation = result.recommendation || result;
    const recommendedId = recommendation.foodId ?? recommendation.id;
    const reason = recommendation.reason;
    const food = candidates.find((item) => String(item.id) === String(recommendedId));

    if (!food) {
      throw new Error("AI 回傳的餐點不在 foods.json 清單中，已停止顯示這筆推薦。");
    }
    if (excludeId !== null && String(food.id) === String(excludeId)) {
      throw new Error("AI 重複推薦了上一道餐點，請再試一次。");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("AI 回應缺少推薦原因，請稍後再試。");
    }
    return { food, reason: reason.trim() };
  }

  async function generateRecommendation() {
    if (isBusy || foods.length === 0) return;

    const preferences = getSelectedPreferences();
    const matchingFoods = getMatchingFoods(preferences);
    if (!matchingFoods.length) {
      setStatus("目前沒有同時符合這些條件的餐點。請取消一兩個偏好再試一次。", "error");
      return;
    }

    const excludeId = mode === "ai" ? lastAiFoodId : null;
    const aiCandidates = mode === "ai" && excludeId !== null
      ? matchingFoods.filter((food) => String(food.id) !== String(excludeId))
      : matchingFoods;
    if (mode === "ai" && !aiCandidates.length) {
      setStatus("符合條件的餐點只有上一道，暫時沒有其他選項可推薦。", "error");
      return;
    }

    isBusy = true;
    setStatus("");
    setLoading(true);

    const aiPromise = mode === "ai"
      ? requestAiRecommendation(aiCandidates, preferences, excludeId)
          .then((value) => ({ value }))
          .catch((error) => ({ error }))
      : null;

    try {
      await waitForLoadingScreen();
      let result;
      if (mode === "random") {
        result = chooseRandomFood(matchingFoods, preferences);
      } else {
        const outcome = await aiPromise;
        if (outcome.error) throw outcome.error;
        result = outcome.value;
        lastAiFoodId = result.food.id;
      }
      showRecommendation(result.food, result.reason);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "發生未預期的錯誤，請再試一次。", "error");
    } finally {
      isBusy = false;
      setLoading(false);
    }
  }

  function resetNearby() {
    nearbyPlaces = [];
    nearbyShown = 0;
    elements.nearbyList.replaceChildren();
    elements.nearbyList.hidden = true;
    elements.moreButton.hidden = true;
    elements.placesAttribution.hidden = true;
  }

  function getBrowserLocation() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("unsupported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        (error) => reject(error),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  function formatDistance(meters) {
    if (meters === null || meters === undefined) return "";
    return meters < 1000 ? `${meters} 公尺` : `${(meters / 1000).toFixed(1)} 公里`;
  }

  function renderPlace(place) {
    const item = document.createElement("li");
    item.className = "nearby-item";

    const name = document.createElement(place.mapsUrl ? "a" : "span");
    name.className = "nearby-name";
    name.textContent = place.name;
    if (place.mapsUrl) {
      name.href = place.mapsUrl;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
    }

    const meta = document.createElement("p");
    meta.className = "nearby-meta";
    const parts = [];
    if (typeof place.rating === "number") {
      const count = typeof place.ratingCount === "number" ? `（${place.ratingCount.toLocaleString("zh-TW")}）` : "";
      parts.push(`⭐ ${place.rating.toFixed(1)}${count}`);
    }
    const distance = formatDistance(place.distanceM);
    if (distance) parts.push(`約 ${distance}`);
    meta.textContent = parts.join("・");

    const address = document.createElement("p");
    address.className = "nearby-address";
    address.textContent = place.address;

    item.append(name, meta, address);
    return item;
  }

  function showMorePlaces() {
    const nextPlaces = nearbyPlaces.slice(nearbyShown, nearbyShown + PLACES_PER_PAGE);
    if (!nextPlaces.length) return;
    // "再找 3 家" replaces the list with the next three shops.
    elements.nearbyList.replaceChildren(...nextPlaces.map(renderPlace));
    elements.nearbyList.start = nearbyShown + 1;
    nearbyShown += nextPlaces.length;
    elements.nearbyList.hidden = false;
    elements.placesAttribution.hidden = false;
    elements.moreButton.hidden = nearbyShown >= nearbyPlaces.length;
  }

  function applyLocationMode() {
    const text = placesEnabled ? LOCATION_TEXT.places : LOCATION_TEXT.maps;
    elements.locationCopy.textContent = text.copy;
    elements.nearbyLabel.textContent = text.button;
    elements.locationNoteText.textContent = text.note;
  }

  async function loadServiceStatus() {
    try {
      const response = await fetch(HEALTH_ENDPOINT, { cache: "no-store" });
      const data = response.ok ? await response.json() : {};
      placesEnabled = data.places === true;
    } catch {
      placesEnabled = false;
    }
    applyLocationMode();
  }

  function openGoogleMaps() {
    const area = elements.areaInput.value.trim();
    // No area typed -> "牛肉麵 附近" lets Google Maps search around the user.
    const query = area ? `${currentFood.name} ${area}` : `${currentFood.name} 附近`;
    const url = MAPS_SEARCH_URL + encodeURIComponent(query);
    window.open(url, "_blank", "noopener,noreferrer");

    // Backup link in case the browser blocked the new tab.
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "點這裡開啟";
    elements.locationFeedback.replaceChildren(
      `已在 Google Maps 搜尋「${query}」。沒有自動開啟的話，`,
      link,
      "。"
    );
  }

  async function searchNearby() {
    if (!currentFood || isSearchingNearby) return;
    if (!placesEnabled) {
      openGoogleMaps();
      return;
    }
    isSearchingNearby = true;
    elements.nearbyButton.disabled = true;
    resetNearby();

    const area = elements.areaInput.value.trim();
    const payload = { foodId: currentFood.id, area };

    try {
      if (!area) {
        elements.locationFeedback.textContent = "正在取得你的位置...";
        try {
          Object.assign(payload, await getBrowserLocation());
        } catch {
          throw new Error("無法取得定位。請允許瀏覽器定位，或在上方輸入地區後再按一次。");
        }
      }

      elements.locationFeedback.textContent = `正在尋找附近的「${currentFood.name}」...`;
      const response = await fetch(NEARBY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : `附近餐廳搜尋失敗（${response.status}）。`);
      }

      nearbyPlaces = Array.isArray(data.places) ? data.places : [];
      if (!nearbyPlaces.length) {
        elements.locationFeedback.textContent = "附近沒有找到這道餐點的店家，換個地區或換一道試試看。";
        return;
      }
      elements.locationFeedback.textContent = `找到 ${nearbyPlaces.length} 家，先給你前 ${Math.min(PLACES_PER_PAGE, nearbyPlaces.length)} 家：`;
      showMorePlaces();
    } catch (error) {
      elements.locationFeedback.textContent = error instanceof Error ? error.message : "附近餐廳搜尋失敗。";
    } finally {
      isSearchingNearby = false;
      elements.nearbyButton.disabled = false;
    }
  }

  async function loadFoods() {
    elements.generateButton.disabled = true;
    setStatus("正在載入 foods.json...");
    try {
      const response = await fetch("./foods.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`無法讀取 foods.json（${response.status}）。請確認檔案放在 index.html 同一個資料夾。`);
      }
      const data = await response.json();
      foods = validateFoods(data);
      setStatus(`已載入 ${foods.length} 道餐點。`, "success");
      elements.generateButton.disabled = false;
    } catch (error) {
      foods = [];
      elements.generateButton.disabled = true;
      setStatus(error instanceof Error ? error.message : "載入餐點資料失敗。", "error");
    }
  }

  elements.randomMode.addEventListener("click", () => setMode("random"));
  elements.aiMode.addEventListener("click", () => setMode("ai"));
  elements.generateButton.addEventListener("click", generateRecommendation);
  elements.rerollButton.addEventListener("click", generateRecommendation);
  elements.confirmButton.addEventListener("click", () => {
    if (!currentFood) return;
    elements.locationSection.hidden = false;
    elements.locationFeedback.textContent = "";
    elements.locationSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  elements.nearbyButton.addEventListener("click", searchNearby);
  elements.moreButton.addEventListener("click", showMorePlaces);
  elements.areaInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchNearby();
  });

  for (const input of elements.preferenceGrid.querySelectorAll('input[name="preference"]')) {
    if (!preferenceNames.includes(input.value)) {
      input.disabled = true;
      setStatus(`未識別的偏好條件「${input.value}」，請確認介面設定。`, "error");
    }
  }

  setMode("random");
  applyLocationMode();
  loadServiceStatus();
  loadFoods();
})();

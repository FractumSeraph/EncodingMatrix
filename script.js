const statusEl = document.getElementById("status");
const summaryTableBody = document.querySelector("#summaryTable tbody");
const compareGridEl = document.getElementById("compareGrid");
const diffStageEl = document.getElementById("diffStage");
const diffVideoAEl = document.getElementById("diffVideoA");
const diffVideoBEl = document.getElementById("diffVideoB");
const diffBadgeEl = document.getElementById("diffBadge");
const toggleLockButton = document.getElementById("toggleLockButton");
const toggleDiffButton = document.getElementById("toggleDiffButton");
const exportCsvButton = document.getElementById("exportCsvButton");
const refreshEncodeCacheButton = document.getElementById("refreshEncodeCacheButton");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const qualityMetricSelectEl = document.getElementById("qualityMetricSelect");
const filterCodecEl = document.getElementById("filterCodec");
const filterMinQualityEl = document.getElementById("filterMinQuality");
const filterMaxSizeEl = document.getElementById("filterMaxSize");
const filterMaxTimeEl = document.getElementById("filterMaxTime");
const weightQualityEl = document.getElementById("weightQuality");
const weightSizeEl = document.getElementById("weightSize");
const weightTimeEl = document.getElementById("weightTime");
const weightQualityValueEl = document.getElementById("weightQualityValue");
const weightSizeValueEl = document.getElementById("weightSizeValue");
const weightTimeValueEl = document.getElementById("weightTimeValue");
const scoreFormulaTextEl = document.getElementById("scoreFormulaText");
const shortcutChipEls = document.querySelectorAll(".shortcut-chip[data-action]");

const UI_STORAGE_KEY = "fractumseraph.encoding-comparisons.ui.v1";
const ENCODE_CACHE_KEY = "fractumseraph.encoding-comparisons.encode-cache.v1";
const FRAME_STEP_SECONDS = 1 / 30;

const state = {
  manifestResults: [],
  manifestSourceRows: [],
  sourceFrameRate: 30,
  activePlayer: "A",
  syncMaster: "A",
  spotlightMode: false,
  lockSync: true,
  syncGuard: false,
  diffMode: false,
  diffSide: "A",
  diffTimerId: null,
  diffSyncGuard: false,
  rankedRows: [],
  activeQualityMetric: "ssim",
  weights: {
    quality: 5,
    size: 2,
    time: 1,
  },
  filters: {
    codec: "All",
    minQuality: null,
    maxSizeMb: null,
    maxTimeS: null,
  },
  players: {
    A: {
      id: "A",
      card: document.getElementById("cardA"),
      codecSelect: document.getElementById("codecSelectA"),
      presetSelect: document.getElementById("presetSelectA"),
      crfSlider: document.getElementById("crfSliderA"),
      crfValue: document.getElementById("crfValueA"),
      crfTicks: document.getElementById("crfTicksA"),
      video: document.getElementById("videoPlayerA"),
      meta: {
        codec: document.getElementById("metaCodecA"),
        preset: document.getElementById("metaPresetA"),
        crf: document.getElementById("metaCrfA"),
        quality: document.getElementById("metaQualityA"),
        size: document.getElementById("metaSizeA"),
        time: document.getElementById("metaTimeA"),
        file: document.getElementById("metaFileA"),
      },
      crfValues: [],
    },
    B: {
      id: "B",
      card: document.getElementById("cardB"),
      codecSelect: document.getElementById("codecSelectB"),
      presetSelect: document.getElementById("presetSelectB"),
      crfSlider: document.getElementById("crfSliderB"),
      crfValue: document.getElementById("crfValueB"),
      crfTicks: document.getElementById("crfTicksB"),
      video: document.getElementById("videoPlayerB"),
      meta: {
        codec: document.getElementById("metaCodecB"),
        preset: document.getElementById("metaPresetB"),
        crf: document.getElementById("metaCrfB"),
        quality: document.getElementById("metaQualityB"),
        size: document.getElementById("metaSizeB"),
        time: document.getElementById("metaTimeB"),
        file: document.getElementById("metaFileB"),
      },
      crfValues: [],
    },
  },
};

function setStatus(message) {
  statusEl.textContent = message;
}

function uniqueSorted(values, numeric = false) {
  const valuesUnique = [...new Set(values)];
  if (numeric) {
    return valuesUnique.sort((a, b) => Number(a) - Number(b));
  }
  return valuesUnique.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }));
}

function sizeToMB(bytes) {
  return `${(Number(bytes) / (1024 * 1024)).toFixed(2)} MB`;
}

function timeToDisplay(seconds) {
  return `${Number(seconds).toFixed(2)} s`;
}

function qualityToDisplay(entry) {
  const score = getQualityScore(entry, state.activeQualityMetric);
  if (!Number.isFinite(Number(score))) {
    return "n/a";
  }
  return `${state.activeQualityMetric.toUpperCase()} ${Number(score).toFixed(6)}`;
}

function availableQualityMetrics() {
  const found = new Set();
  state.manifestResults.forEach((entry) => {
    if (entry && typeof entry.quality_metric === "string") {
      found.add(entry.quality_metric);
    }
    if (entry && entry.quality_scores && typeof entry.quality_scores === "object") {
      Object.keys(entry.quality_scores).forEach((metric) => found.add(metric));
    }
  });
  const metrics = [...found].filter(Boolean);
  metrics.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return metrics.length ? metrics : ["ssim"];
}

function getQualityScore(entry, metric) {
  if (entry && entry.quality_scores && typeof entry.quality_scores === "object") {
    const value = Number(entry.quality_scores[metric]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  if (entry?.quality_metric === metric) {
    const value = Number(entry.quality_score);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function updateScoreFormulaText() {
  scoreFormulaTextEl.textContent =
    `Lower score is better. Score = ${state.weights.quality.toFixed(1)} x quality loss + ` +
    `${state.weights.size.toFixed(1)} x size + ${state.weights.time.toFixed(1)} x time.`;
}

function updateWeightLabels() {
  weightQualityValueEl.textContent = state.weights.quality.toFixed(1);
  weightSizeValueEl.textContent = state.weights.size.toFixed(1);
  weightTimeValueEl.textContent = state.weights.time.toFixed(1);
  updateScoreFormulaText();
}

function readStorageJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStorageJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/security errors.
  }
}

function removeStorageItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore quota/security errors.
  }
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function manifestSignature(rows) {
  let hash = 2166136261;
  rows.forEach((row) => {
    const text = `${row?.codec_name ?? ""}|${row?.preset ?? ""}|${row?.crf_value ?? ""}|${row?.output_filename ?? ""}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  });
  return `${rows.length}:${(hash >>> 0).toString(16)}`;
}

function capturePlayerSelection(player) {
  return {
    codec: player.codecSelect.value || "",
    preset: player.presetSelect.value || "",
    crf: selectedCrf(player),
  };
}

function capturePreferences() {
  return {
    activePlayer: state.activePlayer,
    spotlightMode: state.spotlightMode,
    lockSync: state.lockSync,
    diffMode: state.diffMode,
    syncMaster: state.syncMaster,
    activeQualityMetric: state.activeQualityMetric,
    weights: { ...state.weights },
    filters: { ...state.filters },
    players: {
      A: capturePlayerSelection(state.players.A),
      B: capturePlayerSelection(state.players.B),
    },
  };
}

function savePreferences() {
  writeStorageJson(UI_STORAGE_KEY, capturePreferences());
}

function loadPreferences() {
  const stored = readStorageJson(UI_STORAGE_KEY);
  if (!stored || typeof stored !== "object") {
    return null;
  }

  return {
    activePlayer: stored.activePlayer === "B" ? "B" : "A",
    spotlightMode: Boolean(stored.spotlightMode),
    lockSync: typeof stored.lockSync === "boolean" ? stored.lockSync : state.lockSync,
    diffMode: Boolean(stored.diffMode),
    syncMaster: stored.syncMaster === "B" ? "B" : "A",
    activeQualityMetric: typeof stored.activeQualityMetric === "string" ? stored.activeQualityMetric : state.activeQualityMetric,
    weights: {
      quality: toFiniteNumber(stored?.weights?.quality, state.weights.quality),
      size: toFiniteNumber(stored?.weights?.size, state.weights.size),
      time: toFiniteNumber(stored?.weights?.time, state.weights.time),
    },
    filters: {
      codec: typeof stored?.filters?.codec === "string" ? stored.filters.codec : "All",
      minQuality:
        stored?.filters?.minQuality === null || stored?.filters?.minQuality === undefined
          ? null
          : toFiniteNumber(stored.filters.minQuality, null),
      maxSizeMb:
        stored?.filters?.maxSizeMb === null || stored?.filters?.maxSizeMb === undefined
          ? null
          : toFiniteNumber(stored.filters.maxSizeMb, null),
      maxTimeS:
        stored?.filters?.maxTimeS === null || stored?.filters?.maxTimeS === undefined
          ? null
          : toFiniteNumber(stored.filters.maxTimeS, null),
    },
    players: {
      A: stored?.players?.A && typeof stored.players.A === "object" ? stored.players.A : null,
      B: stored?.players?.B && typeof stored.players.B === "object" ? stored.players.B : null,
    },
  };
}

function applyPreferencesToState(preferences) {
  if (!preferences) {
    return;
  }

  state.activePlayer = preferences.activePlayer;
  state.spotlightMode = preferences.spotlightMode;
  state.lockSync = preferences.lockSync;
  state.diffMode = preferences.diffMode;
  state.syncMaster = preferences.syncMaster;
  state.activeQualityMetric = preferences.activeQualityMetric;
  state.weights = { ...state.weights, ...preferences.weights };
  state.filters = { ...state.filters, ...preferences.filters };
}

function applyPlayerSelection(player, selection) {
  if (!selection) {
    return;
  }

  const codecValues = allCodecs();
  const selectedCodec = codecValues.includes(selection.codec) ? selection.codec : player.codecSelect.value || codecValues[0];
  fillSelect(player.codecSelect, codecValues, selectedCodec);

  const presetValues = presetsForCodec(player.codecSelect.value);
  const selectedPreset = presetValues.includes(selection.preset) ? selection.preset : player.presetSelect.value || presetValues[0];
  fillSelect(player.presetSelect, presetValues, selectedPreset);

  const crfValues = crfValuesFor(player.codecSelect.value, player.presetSelect.value);
  const selectedCrfValue = crfValues.includes(Number(selection.crf)) ? Number(selection.crf) : null;
  updateCrfControl(player, crfValues, selectedCrfValue);
}

async function loadAvailableEncodes(manifestRows, forceRefresh = false) {
  const signature = manifestSignature(manifestRows);
  if (!forceRefresh) {
    const cached = readStorageJson(ENCODE_CACHE_KEY);
    if (cached && cached.signature === signature && Array.isArray(cached.results)) {
      return { results: cached.results, source: "cache" };
    }
  }

  const results = await keepOnlyEncodedRows(manifestRows);
  writeStorageJson(ENCODE_CACHE_KEY, {
    signature,
    results,
    createdAt: Date.now(),
  });
  return { results, source: forceRefresh ? "rebuilt" : "scanned" };
}

async function rebuildEncodeCache() {
  const manifestData = await loadManifest();
  state.manifestSourceRows = manifestData.rows;
  state.sourceFrameRate = manifestData.sourceFrameRate;

  const cache = await loadAvailableEncodes(manifestData.rows, true);
  state.manifestResults = cache.results;
  await refreshUiAfterManifestLoad(`Encode cache rebuilt from ${state.manifestSourceRows.length} manifest entries.`);
}

function clearSelect(selectEl) {
  while (selectEl.firstChild) {
    selectEl.removeChild(selectEl.firstChild);
  }
}

function fillSelect(selectEl, values, selectedValue = null) {
  clearSelect(selectEl);
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    if (selectedValue !== null && String(value) === String(selectedValue)) {
      option.selected = true;
    }
    selectEl.appendChild(option);
  });
}

function populateFilterCodec() {
  const codecs = ["All", ...allCodecs()];
  if (!codecs.includes(state.filters.codec)) {
    state.filters.codec = "All";
  }
  fillSelect(filterCodecEl, codecs, state.filters.codec);
}

function populateQualityMetricSelect() {
  const metrics = availableQualityMetrics();
  if (!metrics.includes(state.activeQualityMetric)) {
    state.activeQualityMetric = metrics[0];
  }
  fillSelect(qualityMetricSelectEl, metrics, state.activeQualityMetric);
}

function syncFiltersFromInputs() {
  state.filters.codec = filterCodecEl.value || "All";
  state.filters.minQuality = filterMinQualityEl.value === "" ? null : Number(filterMinQualityEl.value);
  state.filters.maxSizeMb = filterMaxSizeEl.value === "" ? null : Number(filterMaxSizeEl.value);
  state.filters.maxTimeS = filterMaxTimeEl.value === "" ? null : Number(filterMaxTimeEl.value);
}

function clearFilters() {
  state.filters = {
    codec: "All",
    minQuality: null,
    maxSizeMb: null,
    maxTimeS: null,
  };
  filterCodecEl.value = "All";
  filterMinQualityEl.value = "";
  filterMaxSizeEl.value = "";
  filterMaxTimeEl.value = "";
}

function allCodecs() {
  return uniqueSorted(state.manifestResults.map((x) => x.codec_name));
}

function presetsForCodec(codec) {
  return uniqueSorted(state.manifestResults.filter((x) => x.codec_name === codec).map((x) => x.preset));
}

function crfValuesFor(codec, preset) {
  return uniqueSorted(
    state.manifestResults
      .filter((x) => x.codec_name === codec && x.preset === preset)
      .map((x) => Number(x.crf_value)),
    true
  );
}

function findEntry(codec, preset, crf) {
  return state.manifestResults.find(
    (item) => item.codec_name === codec && item.preset === preset && Number(item.crf_value) === Number(crf)
  );
}

function getCurrentEntryForPlayer(player) {
  const codec = player.codecSelect.value;
  const preset = player.presetSelect.value;
  const crf = selectedCrf(player);
  if (!codec || !preset || crf === null) {
    return null;
  }
  return findEntry(codec, preset, crf) || null;
}

function updateCrfControl(player, values, preferredCrf = null) {
  player.crfValues = values;
  player.crfSlider.min = "0";
  player.crfSlider.max = String(Math.max(0, values.length - 1));
  player.crfSlider.step = "1";

  let index = 0;
  if (preferredCrf !== null) {
    const maybeIndex = values.findIndex((x) => Number(x) === Number(preferredCrf));
    if (maybeIndex >= 0) {
      index = maybeIndex;
    }
  }
  player.crfSlider.value = String(index);

  const current = player.crfValues[Number(player.crfSlider.value)] ?? null;
  player.crfValue.textContent = current === null ? "-" : String(current);

  player.crfTicks.innerHTML = "";
  values.forEach((v) => {
    const tick = document.createElement("span");
    tick.textContent = String(v);
    player.crfTicks.appendChild(tick);
  });
}

function selectedCrf(player) {
  if (!player.crfValues.length) {
    return null;
  }
  return player.crfValues[Number(player.crfSlider.value)] ?? null;
}

function updateMetadata(player, entry) {
  player.meta.codec.textContent = entry.codec_name;
  player.meta.preset.textContent = entry.preset;
  player.meta.crf.textContent = String(entry.crf_value);
  player.meta.quality.textContent = qualityToDisplay(entry);
  player.meta.size.textContent = sizeToMB(Number(entry.file_size_bytes));
  player.meta.time.textContent = timeToDisplay(Number(entry.encode_time_seconds));
  player.meta.file.textContent = entry.output_filename;
}

function setActivePlayer(id) {
  state.activePlayer = id;
  const playerA = state.players.A;
  const playerB = state.players.B;
  playerA.card.classList.toggle("focused", id === "A");
  playerB.card.classList.toggle("focused", id === "B");
}

function applySpotlight() {
  const playerA = state.players.A;
  const playerB = state.players.B;

  if (!state.spotlightMode) {
    playerA.card.classList.remove("dimmed");
    playerB.card.classList.remove("dimmed");
    return;
  }

  playerA.card.classList.toggle("dimmed", state.activePlayer !== "A");
  playerB.card.classList.toggle("dimmed", state.activePlayer !== "B");
}

function maxSeekableTime(video) {
  if (!Number.isFinite(video.duration)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, video.duration - 0.001);
}

function clampVideoTime(video, time) {
  return Math.min(Math.max(0, Number(time) || 0), maxSeekableTime(video));
}

function syncPlayerToTime(player, sourceTime) {
  const next = clampVideoTime(player.video, sourceTime);
  if (!Number.isFinite(next)) {
    return;
  }
  player.video.currentTime = next;
}

function otherPlayerOf(player) {
  return player.id === "A" ? state.players.B : state.players.A;
}

function normalizePlaybackRate(video) {
  if (Math.abs(video.playbackRate - 1) > 0.001) {
    video.playbackRate = 1;
  }
}

function resetSyncPlaybackRates() {
  normalizePlaybackRate(state.players.A.video);
  normalizePlaybackRate(state.players.B.video);
}

function syncVideoTime(sourceVideo, targetVideo, forceSeek = false) {
  if (!state.lockSync || state.syncGuard) {
    return;
  }
  if (!Number.isFinite(sourceVideo.currentTime)) {
    return;
  }

  const drift = (sourceVideo.currentTime || 0) - (targetVideo.currentTime || 0);
  const absDrift = Math.abs(drift);
  const tinyDriftThreshold = 1 / 240;
  const hardSeekThreshold = 0.12;

  if (absDrift < tinyDriftThreshold) {
    normalizePlaybackRate(targetVideo);
    return;
  }

  const bothPlaying = !sourceVideo.paused && !targetVideo.paused;
  if (!forceSeek && bothPlaying && absDrift < hardSeekThreshold) {
    // Smooth catch-up while playing to avoid visible jump cuts.
    const correctionGain = 0.35;
    const correction = Math.max(-0.06, Math.min(0.06, drift * correctionGain));
    targetVideo.playbackRate = Math.max(0.94, Math.min(1.06, 1 + correction));
    return;
  }

  state.syncGuard = true;
  const targetTime = clampVideoTime(targetVideo, sourceVideo.currentTime || 0);
  targetVideo.currentTime = targetTime;
  normalizePlaybackRate(targetVideo);
  requestAnimationFrame(() => {
    state.syncGuard = false;
  });
}

function updateLockButtonUi() {
  toggleLockButton.textContent = `Lock Sync: ${state.lockSync ? "On" : "Off"}`;
  toggleLockButton.classList.toggle("active", state.lockSync);
}

function updateDiffButtonUi() {
  toggleDiffButton.textContent = `Diff Mode: ${state.diffMode ? "On" : "Off"}`;
  toggleDiffButton.classList.toggle("active", state.diffMode);
}

function swapVideoSource(player, nextSource, entry) {
  const previousSource = player.video.getAttribute("src") || "";
  if (previousSource === nextSource) {
    updateMetadata(player, entry);
    return;
  }

  const wasPaused = player.video.paused;
  const other = otherPlayerOf(player);
  const currentTime = state.lockSync ? other.video.currentTime || 0 : player.video.currentTime || 0;

  player.video.src = nextSource;
  player.video.load();

  const onLoaded = () => {
    const target = clampVideoTime(player.video, currentTime);
    if (Number.isFinite(target)) {
      player.video.currentTime = target;
    }

    if (state.lockSync) {
      syncVideoTime(player.video, other.video);
    }

    if (!wasPaused) {
      player.video.play().catch(() => {});
    }

    updateMetadata(player, entry);
    player.video.removeEventListener("loadedmetadata", onLoaded);
  };

  player.video.addEventListener("loadedmetadata", onLoaded);
}

function refreshPlayer(player, refreshDiff = true) {
  const codec = player.codecSelect.value;
  const preset = player.presetSelect.value;
  const crf = selectedCrf(player);

  if (!codec || !preset || crf === null) {
    setStatus("No matching encode selection available.");
    return;
  }

  player.crfValue.textContent = String(crf);
  const entry = findEntry(codec, preset, crf);

  if (!entry) {
    setStatus("No manifest entry for this exact combination.");
    return;
  }

  setStatus("");
  swapVideoSource(player, entry.output_filename, entry);

  if (refreshDiff && state.diffMode) {
    refreshDiffView().catch(() => {
      setStatus("Could not initialize side-by-side wipe.");
    });
  }
}

function updatePlayerControls(player, preferredSelection = null) {
  const codecValues = allCodecs();
  const preferredCodec = preferredSelection?.codec;
  const selectedCodec = codecValues.includes(preferredCodec) ? preferredCodec : player.codecSelect.value || codecValues[0];
  fillSelect(player.codecSelect, codecValues, selectedCodec);

  const codec = player.codecSelect.value;
  const presetValues = presetsForCodec(codec);
  const preferredPreset = preferredSelection?.preset;
  const selectedPreset = presetValues.includes(preferredPreset) ? preferredPreset : player.presetSelect.value || presetValues[0];
  fillSelect(player.presetSelect, presetValues, selectedPreset);

  const preset = player.presetSelect.value;
  const crfValues = crfValuesFor(codec, preset);
  const preferredCrf = preferredSelection?.crf;
  updateCrfControl(player, crfValues, Number.isFinite(Number(preferredCrf)) ? Number(preferredCrf) : null);
}

function rowHtml(cells) {
  return `<tr>${cells.map((x) => `<td>${x}</td>`).join("")}</tr>`;
}

function toggleLockSync() {
  state.lockSync = !state.lockSync;
  updateLockButtonUi();
  if (state.lockSync) {
    state.syncMaster = state.activePlayer;
    const master = state.players[state.syncMaster];
    const follower = otherPlayerOf(master);
    syncVideoTime(master.video, follower.video, true);
  } else {
    resetSyncPlaybackRates();
  }
}

function runShortcutAction(action) {
  const active = state.players[state.activePlayer];

  if (action === "focusA") {
    setActivePlayer("A");
    applySpotlight();
    savePreferences();
    return true;
  }
  if (action === "focusB") {
    setActivePlayer("B");
    applySpotlight();
    savePreferences();
    return true;
  }
  if (action === "spotlight") {
    state.spotlightMode = !state.spotlightMode;
    applySpotlight();
    savePreferences();
    return true;
  }
  if (action === "syncBtoA") {
    const a = state.players.A.video;
    const b = state.players.B.video;
    syncVideoTime(a, b, true);
    return true;
  }
  if (action === "toggleLock") {
    toggleLockSync();
    return true;
  }
  if (action === "toggleDiff") {
    setDiffMode(!state.diffMode);
    return true;
  }
  if (action === "exportCsv") {
    exportSummaryCsv();
    return true;
  }
  if (action === "playPause") {
    if (active.video.paused) {
      active.video.play().catch(() => {});
    } else {
      active.video.pause();
    }
    return true;
  }
  if (action === "frameBack") {
    stepOneFrame(active, -1);
    return true;
  }
  if (action === "frameForward") {
    stepOneFrame(active, 1);
    return true;
  }

  return false;
}

function renderSummaryTable() {
  if (!state.manifestResults.length) {
    summaryTableBody.innerHTML = "";
    state.rankedRows = [];
    return;
  }

  const sizes = state.manifestResults.map((x) => Number(x.file_size_bytes));
  const times = state.manifestResults.map((x) => Number(x.encode_time_seconds));
  const qualityValues = state.manifestResults
    .map((x) => getQualityScore(x, state.activeQualityMetric))
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minQuality = qualityValues.length ? Math.min(...qualityValues) : 0;
  const maxQuality = qualityValues.length ? Math.max(...qualityValues) : 1;
  const denomSize = maxSize - minSize || 1;
  const denomTime = maxTime - minTime || 1;
  const denomQuality = maxQuality - minQuality || 1;

  state.rankedRows = state.manifestResults
    .map((entry) => {
      const sizeNorm = (Number(entry.file_size_bytes) - minSize) / denomSize;
      const timeNorm = (Number(entry.encode_time_seconds) - minTime) / denomTime;
      const qualityScore = getQualityScore(entry, state.activeQualityMetric);
      const qualityNorm = Number.isFinite(qualityScore) ? (qualityScore - minQuality) / denomQuality : 0.5;
      const qualityLoss = 1 - qualityNorm;
      const score =
        state.weights.size * sizeNorm +
        state.weights.time * timeNorm +
        state.weights.quality * qualityLoss;
      return {
        codec_name: entry.codec_name,
        preset: entry.preset,
        crf_value: Number(entry.crf_value),
        quality_metric: state.activeQualityMetric,
        quality_score: Number.isFinite(qualityScore) ? qualityScore : null,
        size_mb: Number(entry.file_size_bytes) / (1024 * 1024),
        time_s: Number(entry.encode_time_seconds),
        score,
      };
    })
    .filter((row) => {
      if (state.filters.codec !== "All" && row.codec_name !== state.filters.codec) {
        return false;
      }
      if (state.filters.minQuality !== null && (row.quality_score === null || row.quality_score < state.filters.minQuality)) {
        return false;
      }
      if (state.filters.maxSizeMb !== null && row.size_mb > state.filters.maxSizeMb) {
        return false;
      }
      if (state.filters.maxTimeS !== null && row.time_s > state.filters.maxTimeS) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.score - b.score)
    .map((x, idx) => ({ ...x, rank: idx + 1 }));

  summaryTableBody.innerHTML = state.rankedRows
    .slice(0, 100)
    .map((row) =>
      rowHtml([
        row.rank,
        row.codec_name,
        row.preset,
        row.crf_value,
        row.quality_score === null ? "n/a" : `${row.quality_metric.toUpperCase()} ${row.quality_score.toFixed(6)}`,
        row.size_mb.toFixed(2),
        row.time_s.toFixed(2),
        row.score.toFixed(3),
      ])
    )
    .join("");
}

function exportSummaryCsv() {
  if (!state.rankedRows.length) {
    setStatus("No rows available to export.");
    return;
  }

  const lines = [
    ["rank", "codec_name", "preset", "crf_value", "quality_metric", "quality_score", "size_mb", "time_s", "score"].join(","),
    ...state.rankedRows.map((row) =>
      [
        row.rank,
        `"${String(row.codec_name).replace(/"/g, '""')}"`,
        `"${String(row.preset).replace(/"/g, '""')}"`,
        row.crf_value,
        `"${String(row.quality_metric).replace(/"/g, '""')}"`,
        row.quality_score === null ? "" : row.quality_score.toFixed(6),
        row.size_mb.toFixed(4),
        row.time_s.toFixed(4),
        row.score.toFixed(6),
      ].join(",")
    ),
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "encode_scoreboard.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus("Scoreboard CSV exported.");
}

function stepOneFrame(player, direction) {
  const frameStepSeconds = frameStepSecondsForPlayer(player);
  const currentFrame = frameIndexForTime(player.video.currentTime || 0, frameStepSeconds, direction);
  const next = clampVideoTime(player.video, (currentFrame + direction) * frameStepSeconds);
  player.video.pause();
  normalizePlaybackRate(player.video);
  player.video.currentTime = next;

  if (state.lockSync) {
    state.syncMaster = player.id;
    const other = otherPlayerOf(player);
    other.video.pause();
    normalizePlaybackRate(other.video);
    syncVideoTime(player.video, other.video, true);
  }
}

function stopDiffLoop() {
  if (state.diffTimerId !== null) {
    clearInterval(state.diffTimerId);
    state.diffTimerId = null;
  }
}

function syncDiffVideos(sourceVideo, targetVideo, forceSeek = false) {
  if (state.diffSyncGuard) {
    return;
  }

  const sourceTime = sourceVideo.currentTime || 0;
  const targetTime = clampVideoTime(targetVideo, sourceTime);
  const delta = Math.abs((targetVideo.currentTime || 0) - targetTime);

  if (!forceSeek && delta < 1 / 240) {
    return;
  }

  state.diffSyncGuard = true;
  targetVideo.currentTime = targetTime;
  targetVideo.playbackRate = sourceVideo.playbackRate;
  requestAnimationFrame(() => {
    state.diffSyncGuard = false;
  });
}

async function loadDiffVideo(videoEl, source, targetTime, shouldPlay) {
  return new Promise((resolve) => {
    const applyReadyState = () => {
      const next = clampVideoTime(videoEl, targetTime);
      if (Number.isFinite(next)) {
        videoEl.currentTime = next;
      }
      if (shouldPlay) {
        videoEl.play().catch(() => {});
      } else {
        videoEl.pause();
      }
      resolve();
    };

    if ((videoEl.getAttribute("src") || "") === source) {
      applyReadyState();
      return;
    }

    const onLoaded = () => {
      videoEl.removeEventListener("loadedmetadata", onLoaded);
      applyReadyState();
    };

    videoEl.addEventListener("loadedmetadata", onLoaded);
    videoEl.src = source;
    videoEl.load();
  });
}

async function refreshDiffView() {
  if (!state.diffMode) {
    return;
  }

  const entryA = getCurrentEntryForPlayer(state.players.A);
  const entryB = getCurrentEntryForPlayer(state.players.B);
  if (!entryA || !entryB) {
    setStatus("Side-by-side wipe needs valid selections in both players.");
    return;
  }

  const syncSourceTime = Number.isFinite(diffVideoAEl.currentTime)
    ? diffVideoAEl.currentTime
    : state.players[state.syncMaster].video.currentTime || 0;
  const shouldPlay = !diffVideoAEl.paused || !diffVideoBEl.paused || !state.players[state.syncMaster].video.paused;

  await Promise.all([
    loadDiffVideo(diffVideoAEl, entryA.output_filename, syncSourceTime, shouldPlay),
    loadDiffVideo(diffVideoBEl, entryB.output_filename, syncSourceTime, shouldPlay),
  ]);

  diffVideoAEl.muted = true;
  diffVideoBEl.muted = true;
  diffVideoAEl.playbackRate = 1;
  diffVideoBEl.playbackRate = 1;
  diffBadgeEl.textContent = `Comparing ${entryA.codec_name} / ${entryB.codec_name}`;
}

function setDiffMode(enabled) {
  state.diffMode = enabled;
  updateDiffButtonUi();

  if (!enabled) {
    stopDiffLoop();
    diffVideoAEl.pause();
    diffVideoBEl.pause();
    compareGridEl.classList.remove("hidden");
    diffStageEl.classList.add("hidden");
    savePreferences();
    return;
  }

  compareGridEl.classList.add("hidden");
  diffStageEl.classList.remove("hidden");
  refreshDiffView().catch(() => {
    setStatus("Could not initialize side-by-side wipe.");
  });
  savePreferences();
}

function wireDiffVideoEvents() {
  const wire = (sourceVideo, targetVideo) => {
    sourceVideo.addEventListener("play", () => {
      if (!state.diffMode) {
        return;
      }
      syncDiffVideos(sourceVideo, targetVideo, true);
      if (targetVideo.paused) {
        targetVideo.play().catch(() => {});
      }
    });

    sourceVideo.addEventListener("pause", () => {
      if (!state.diffMode) {
        return;
      }
      if (!targetVideo.paused) {
        targetVideo.pause();
      }
      syncDiffVideos(sourceVideo, targetVideo, true);
    });

    sourceVideo.addEventListener("seeking", () => {
      if (!state.diffMode) {
        return;
      }
      syncDiffVideos(sourceVideo, targetVideo, true);
    });

    sourceVideo.addEventListener("ratechange", () => {
      if (!state.diffMode) {
        return;
      }
      targetVideo.playbackRate = sourceVideo.playbackRate;
    });

    sourceVideo.addEventListener("timeupdate", () => {
      if (!state.diffMode || sourceVideo.paused) {
        return;
      }
      syncDiffVideos(sourceVideo, targetVideo, false);
    });
  };

  wire(diffVideoAEl, diffVideoBEl);
  wire(diffVideoBEl, diffVideoAEl);
}

function wirePlayerEvents(player) {
  player.card.addEventListener("click", () => {
    setActivePlayer(player.id);
    applySpotlight();
    savePreferences();
  });

  player.video.addEventListener("click", () => {
    setActivePlayer(player.id);
    applySpotlight();
    savePreferences();
  });

  player.video.addEventListener("timeupdate", () => {
    if (!state.lockSync || state.syncMaster !== player.id) {
      return;
    }
    const other = otherPlayerOf(player);
    syncVideoTime(player.video, other.video);
  });

  player.video.addEventListener("seeking", () => {
    if (!state.lockSync || state.syncGuard) {
      return;
    }
    state.syncMaster = player.id;
    state.syncGuard = true;
    const other = otherPlayerOf(player);
    syncPlayerToTime(other, player.video.currentTime || 0);
    normalizePlaybackRate(other.video);
    requestAnimationFrame(() => {
      state.syncGuard = false;
    });
  });

  player.video.addEventListener("seeked", () => {
    if (state.lockSync) {
      state.syncMaster = player.id;
    }
    const other = otherPlayerOf(player);
    syncVideoTime(player.video, other.video, true);
  });

  player.video.addEventListener("play", () => {
    if (!state.lockSync) {
      return;
    }
    state.syncMaster = player.id;
    const other = otherPlayerOf(player);
    syncVideoTime(player.video, other.video, true);
    if (other.video.paused) {
      other.video.play().catch(() => {});
    }
  });

  player.video.addEventListener("pause", () => {
    if (!state.lockSync) {
      return;
    }
    const other = otherPlayerOf(player);
    if (!other.video.paused) {
      other.video.pause();
    }
    syncVideoTime(player.video, other.video, true);
    resetSyncPlaybackRates();
  });

  player.codecSelect.addEventListener("change", () => {
    updatePlayerControls(player);
    refreshPlayer(player);
    savePreferences();
  });

  player.presetSelect.addEventListener("change", () => {
    updatePlayerControls(player);
    refreshPlayer(player);
    savePreferences();
  });

  player.crfSlider.addEventListener("input", () => {
    const current = selectedCrf(player);
    player.crfValue.textContent = current === null ? "-" : String(current);
    refreshPlayer(player);
    savePreferences();
  });
}

function wireActions() {
  toggleLockButton.addEventListener("click", () => {
    toggleLockSync();
  });

  toggleDiffButton.addEventListener("click", () => {
    setDiffMode(!state.diffMode);
  });

  exportCsvButton.addEventListener("click", () => {
    exportSummaryCsv();
  });

  refreshEncodeCacheButton.addEventListener("click", () => {
    setStatus("Rebuilding encode cache...");
    rebuildEncodeCache().catch((error) => {
      setStatus(`Could not rebuild encode cache: ${error.message}`);
    });
  });

  clearFiltersButton.addEventListener("click", () => {
    clearFilters();
    renderSummaryTable();
    savePreferences();
  });

  qualityMetricSelectEl.addEventListener("change", () => {
    state.activeQualityMetric = qualityMetricSelectEl.value;
    renderSummaryTable();
    refreshPlayer(state.players.A);
    refreshPlayer(state.players.B);
    savePreferences();
  });

  [filterCodecEl, filterMinQualityEl, filterMaxSizeEl, filterMaxTimeEl].forEach((el) => {
    el.addEventListener("input", () => {
      syncFiltersFromInputs();
      renderSummaryTable();
      savePreferences();
    });
    el.addEventListener("change", () => {
      syncFiltersFromInputs();
      renderSummaryTable();
      savePreferences();
    });
  });

  [
    [weightQualityEl, "quality"],
    [weightSizeEl, "size"],
    [weightTimeEl, "time"],
  ].forEach(([el, key]) => {
    el.addEventListener("input", () => {
      state.weights[key] = Number(el.value);
      updateWeightLabels();
      renderSummaryTable();
      savePreferences();
    });
  });
}

function wireKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "1") {
      runShortcutAction("focusA");
      return;
    }
    if (event.key === "2") {
      runShortcutAction("focusB");
      return;
    }

    if (event.key.toLowerCase() === "q") {
      runShortcutAction("spotlight");
      return;
    }

    if (event.key.toLowerCase() === "s") {
      runShortcutAction("syncBtoA");
      return;
    }

    if (event.key.toLowerCase() === "l") {
      runShortcutAction("toggleLock");
      return;
    }

    if (event.key.toLowerCase() === "d") {
      runShortcutAction("toggleDiff");
      return;
    }

    if (event.key.toLowerCase() === "e") {
      runShortcutAction("exportCsv");
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      runShortcutAction("playPause");
      return;
    }

    if (event.key === ",") {
      event.preventDefault();
      runShortcutAction("frameBack");
      return;
    }

    if (event.key === ".") {
      event.preventDefault();
      runShortcutAction("frameForward");
    }
  });
}

function wireShortcutChipActions() {
  shortcutChipEls.forEach((chipEl) => {
    chipEl.addEventListener("click", () => {
      runShortcutAction(chipEl.dataset.action);
    });
  });
}

function frameStepSecondsForPlayer(player) {
  const entry = getCurrentEntryForPlayer(player);
  const fps = Number(entry?.source_frame_rate ?? state.sourceFrameRate);
  if (Number.isFinite(fps) && fps > 0) {
    return 1 / fps;
  }
  return FRAME_STEP_SECONDS;
}

function frameIndexForTime(currentTime, frameStepSeconds, direction) {
  const rawFrame = Number(currentTime || 0) / frameStepSeconds;
  if (direction > 0) {
    return Math.floor(rawFrame + 0.000001);
  }
  return Math.ceil(rawFrame - 0.000001);
}

async function refreshUiAfterManifestLoad(statusMessage = "", preferences = null) {
  const playerA = state.players.A;
  const playerB = state.players.B;

  populateFilterCodec();
  populateQualityMetricSelect();

  weightQualityEl.value = String(state.weights.quality);
  weightSizeEl.value = String(state.weights.size);
  weightTimeEl.value = String(state.weights.time);
  updateWeightLabels();

  updatePlayerControls(playerA, preferences?.players?.A || null);
  updatePlayerControls(playerB, preferences?.players?.B || null);

  refreshPlayer(playerA, false);
  refreshPlayer(playerB, false);

  setActivePlayer(state.activePlayer);
  applySpotlight();

  compareGridEl.classList.toggle("hidden", state.diffMode);
  diffStageEl.classList.toggle("hidden", !state.diffMode);

  renderSummaryTable();
  updateLockButtonUi();
  updateDiffButtonUi();

  if (state.diffMode) {
    try {
      await refreshDiffView();
    } catch {
      statusMessage = "Could not initialize side-by-side wipe.";
    }
  }

  setStatus(statusMessage);
  savePreferences();
}

async function loadManifest() {
  const response = await fetch(`manifest.json?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`Could not load manifest.json (HTTP ${response.status})`);
  }

  const data = await response.json();
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.encodes) ? data.encodes : null;
  if (!rows) {
    throw new Error("manifest.json is missing a valid results or encodes array.");
  }

  const sourceFrameRate = Number(data?.source_frame_rate);
  return {
    rows,
    sourceFrameRate: Number.isFinite(sourceFrameRate) && sourceFrameRate > 0 ? sourceFrameRate : 30,
  };
}

async function outputFileExists(path) {
  if (!path || typeof path !== "string") {
    return false;
  }

  const cacheBustedPath = `${path}?t=${Date.now()}`;

  try {
    const response = await fetch(cacheBustedPath, {
      method: "HEAD",
      cache: "no-store",
    });
    if (response.ok) {
      return true;
    }
    if (response.status !== 405) {
      return false;
    }
  } catch {
    // Fall back to a lightweight GET probe if HEAD is not supported.
  }

  try {
    const response = await fetch(cacheBustedPath, {
      method: "GET",
      cache: "no-store",
      headers: {
        Range: "bytes=0-0",
      },
    });
    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

async function keepOnlyEncodedRows(rows) {
  const exists = await Promise.all(rows.map((row) => outputFileExists(row?.output_filename)));
  return rows.filter((_, index) => exists[index]);
}

async function initialize() {
  try {
    const preferences = loadPreferences();
    applyPreferencesToState(preferences);

    const manifestData = await loadManifest();
    state.manifestSourceRows = manifestData.rows;
    state.sourceFrameRate = manifestData.sourceFrameRate;

    const availableEncodes = await loadAvailableEncodes(manifestData.rows);
    state.manifestResults = availableEncodes.results;

    if (!state.manifestResults.length) {
      setStatus("No encoded output files were found. Run batch_encode.py first.");
      return;
    }

    const playerA = state.players.A;
    const playerB = state.players.B;

    wirePlayerEvents(playerA);
    wirePlayerEvents(playerB);
    wireDiffVideoEvents();
    wireActions();
    wireKeyboardShortcuts();
    wireShortcutChipActions();

    await refreshUiAfterManifestLoad(
      availableEncodes.source === "cache" ? "Loaded cached available-encode list." : "Refreshed available-encode list.",
      preferences
    );
  } catch (error) {
    setStatus(`Load error: ${error.message}. Serve this folder over HTTP, for example: python -m http.server 8000.`);
  }
}

initialize();
/* SES Locations (PWA)
   - Viewer build: index.html (GET only, no token, no logging)
   - Logger build: logger.html (GET + POST, token hardcoded in logger.html)
*/

(() => {
  const $ = (id) => document.getElementById(id);

  // Injected per-page (index.html vs logger.html)
  const CFG = window.SESLOC_CONFIG || {};
  const BACKEND_URL = (CFG.backendUrl || "").trim();
  const API_TOKEN = (CFG.token || "").trim(); // only present on logger.html
  const VIEW_ONLY = !!CFG.viewOnly;

  // Default center (Lismore)
  const MAP_DEFAULT = { lat: -28.8125, lng: 153.2770, zoom: 13 };

  const CATEGORIES = ["Drain", "Boat launch", "Flood prone", "Access issue", "Other"];

  const CATEGORY_COLORS = {
    "Drain": "#2e6bff",
    "Boat launch": "#25c26e",
    "Flood prone": "#f5b942",
    "Access issue": "#ff5a6e",
    "Other": "#cbd6f5",
  };

  // UI elements (safe lookups)
  const el = {
    subTitle: $("subTitle"),
    status: $("status"),

    tabMap: $("tabMap"),
    tabList: $("tabList"),
    mapView: $("mapView"),
    listView: $("listView"),

    btnRefresh: $("btnRefresh"),
    btnSync: $("btnSync"),
    pendingPill: $("pendingPill"),
    pendingCount: $("pendingCount"),

    search: $("search"),
    chips: $("chips"),
    list: $("list"),

    // Logger UI (may not exist on viewer page)
    btnLog: $("btnLog"),
    logModal: $("logModal"),
    category: $("category"),
    name: $("name"),
    description: $("description"),
    btnCapture: $("btnCapture"),
    btnOpenMap: $("btnOpenMap"),
    btnSave: $("btnSave"),
    btnDictate: $("btnDictate"),
    btnClear: $("btnClear"),
    latVal: $("latVal"),
    lngVal: $("lngVal"),
    accVal: $("accVal"),
    logStatus: $("logStatus"),

    btnCenterMe: $("btnCenterMe"),
  };

  // State
  let map = null;
  let markersLayer = null;
  let meMarker = null;
  let meCircle = null;

  let items = [];
  let activeCategory = "All";
  let searchTerm = "";
  let lastFix = null; // { lat, lng, accuracy }

  // ---------- Helpers ----------
  function setSubTitle() {
    if (!el.subTitle) return;

    if (!BACKEND_URL) {
      el.subTitle.textContent = "Backend not set";
      return;
    }

    if (VIEW_ONLY) el.subTitle.textContent = "Viewer";
    else el.subTitle.textContent = API_TOKEN ? "Logger" : "Logger (token missing)";
  }

  function setStatus(msg) {
    if (el.status) el.status.textContent = msg;
  }

  function round6(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  function fmtAcc(m) {
    if (m == null || m === "") return "—";
    return "±" + Math.round(m) + " m";
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function trunc(s, n = 120) {
    const t = (s || "").trim();
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + "…";
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function mapsLink(lat, lng) {
    const q = `${lat},${lng}`;
    return isIOS()
      ? `https://maps.apple.com/?q=${q}`
      : `https://maps.google.com/?q=${q}`;
  }

  function uid() {
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    }
  }

  function nowISO() {
    return new Date().toISOString();
  }

  // ---------- Backend ----------
  async function fetchItems() {
    if (!BACKEND_URL) throw new Error("Backend URL not set");
    const res = await fetch(BACKEND_URL, { method: "GET" });
    if (!res.ok) throw new Error(`GET failed (${res.status})`);

    const data = await res.json();
    const arr = Array.isArray(data.items) ? data.items : [];
    return arr.map(normalizeItem);
  }

  async function postItem(payload) {
    if (!BACKEND_URL) throw new Error("Backend URL not set");
    if (!API_TOKEN) throw new Error("Token missing (logger only)");

    const url = `${BACKEND_URL}?token=${encodeURIComponent(API_TOKEN)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`POST failed (${res.status})`);
    const data = await res.json();
    return normalizeItem(data?.item || payload);
  }

  function normalizeItem(x) {
    const it = { ...x };
    it.id = it.id || it._id || "";
    it.createdAt = it.createdAt || it.timestamp || "";
    it.category = it.category || "Other";
    it.name = it.name || "";
    it.description = it.description || "";
    it.lat = typeof it.lat === "string" ? parseFloat(it.lat) : it.lat;
    it.lng = typeof it.lng === "string" ? parseFloat(it.lng) : it.lng;
    it.accuracy = typeof it.accuracy === "string" ? parseFloat(it.accuracy) : it.accuracy;
    return it;
  }

  // ---------- Offline queue (IndexedDB) ----------
  const DB_NAME = "sesloc_db";
  const DB_VERSION = 1;
  const STORE_QUEUE = "queue";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function queueAdd(item) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      tx.objectStore(STORE_QUEUE).put(item);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await updatePendingUI();
  }

  async function queueAll() {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readonly");
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function queueDelete(id) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      tx.objectStore(STORE_QUEUE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await updatePendingUI();
  }

  async function updatePendingUI() {
    if (!el.pendingPill || !el.pendingCount) return;

    let count = 0;
    try {
      const all = await queueAll();
      count = all.length;
    } catch {
      // ignore
    }

    if (count > 0 && !VIEW_ONLY) {
      el.pendingCount.textContent = String(count);
      el.pendingPill.hidden = false;
    } else {
      el.pendingPill.hidden = true;
    }
  }

  // ---------- Map ----------
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([MAP_DEFAULT.lat, MAP_DEFAULT.lng], MAP_DEFAULT.zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
  }

  function pinIcon(color) {
    const svg = encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
        <path d="M14 0C6.8 0 1 5.8 1 13c0 10.4 13 27 13 27s13-16.6 13-27C27 5.8 21.2 0 14 0z" fill="${color}"/>
        <circle cx="14" cy="13" r="5" fill="#0f1a2e"/>
      </svg>
    `);

    return L.icon({
      iconUrl: "data:image/svg+xml;charset=UTF-8," + svg,
      iconSize: [28, 40],
      iconAnchor: [14, 40],
      popupAnchor: [0, -36],
    });
  }

  function setMeMarker(lat, lng, accuracy) {
    if (!map) return;
    const ll = [lat, lng];

    if (!meMarker) {
      meMarker = L.circleMarker(ll, { radius: 7, weight: 2, opacity: 1, fillOpacity: 0.35 }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
    }

    if (!meCircle) {
      meCircle = L.circle(ll, { radius: Math.max(accuracy || 0, 5), weight: 1, opacity: 0.7, fillOpacity: 0.08 }).addTo(map);
    } else {
      meCircle.setLatLng(ll);
      meCircle.setRadius(Math.max(accuracy || 0, 5));
    }
  }

  // ---------- Filter + render ----------
  function filteredItems() {
    const term = (searchTerm || "").toLowerCase().trim();

    return items.filter((it) => {
      const catOk = (activeCategory === "All") || (it.category === activeCategory);
      if (!catOk) return false;

      if (!term) return true;
      const hay = ((it.name || "") + " " + (it.description || "")).toLowerCase();
      return hay.includes(term);
    });
  }

  function renderChips() {
    if (!el.chips) return;
    el.chips.innerHTML = "";

    const all = ["All", ...CATEGORIES];
    for (const c of all) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", c === activeCategory ? "true" : "false");
      b.textContent = c;
      b.addEventListener("click", () => {
        activeCategory = c;
        renderChips();
        renderMap();
        renderList();
      });
      el.chips.appendChild(b);
    }
  }

  function renderMap() {
    if (!map || !markersLayer) return;

    markersLayer.clearLayers();
    const arr = filteredItems();

    for (const it of arr) {
      if (!isFinite(it.lat) || !isFinite(it.lng)) continue;

      const color = CATEGORY_COLORS[it.category] || CATEGORY_COLORS.Other;
      const icon = pinIcon(color);
      const link = mapsLink(it.lat, it.lng);

      const popupHtml = `
        <div>
          <div style="font-weight:900;margin-bottom:6px">${esc(it.name || "(No name)")}</div>
          <div style="opacity:.9;margin-bottom:6px">${esc(it.category || "Other")}</div>
          ${it.description ? `<div style="opacity:.9;margin-bottom:8px">${esc(it.description)}</div>` : ""}
          <a href="${link}" target="_blank" rel="noopener noreferrer">Open in Maps</a>
        </div>
      `;

      L.marker([it.lat, it.lng], { icon }).bindPopup(popupHtml).addTo(markersLayer);
    }
  }

  function renderList() {
    if (!el.list) return;
    el.list.innerHTML = "";

    const arr = filteredItems();
    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.innerHTML = `<div class="item__name">No matching locations</div>
                         <div class="item__desc">Try clearing filters or search.</div>`;
      el.list.appendChild(empty);
      return;
    }

    for (const it of arr) {
      const link = (isFinite(it.lat) && isFinite(it.lng)) ? mapsLink(it.lat, it.lng) : "#";
      const desc = trunc(it.description || "", 120);
      const badgeColor = CATEGORY_COLORS[it.category] || CATEGORY_COLORS.Other;

      const metaParts = [];
      if (it.createdAt) {
        const d = new Date(it.createdAt);
        if (!isNaN(d)) metaParts.push(d.toLocaleString());
      }
      const meta = metaParts.join(" • ");

      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `
        <div class="item__top">
          <div class="item__name">${esc(it.name || "(No name)")}</div>
          <div class="badge" style="background:${badgeColor}">${esc(it.category || "Other")}</div>
        </div>
        <div class="item__desc">${esc(desc || "(No description)")}</div>
        ${meta ? `<div class="item__meta">${esc(meta)}</div>` : ""}
        ${link !== "#" ? `<div><a href="${link}" target="_blank" rel="noopener noreferrer">Open in Maps</a></div>` : ""}
      `;

      // Tap row (not link) => jump to map
      card.addEventListener("click", (ev) => {
        const a = ev.target.closest("a");
        if (a) return;

        if (isFinite(it.lat) && isFinite(it.lng)) {
          showTab("Map");
          map.setView([it.lat, it.lng], Math.max(map.getZoom(), 16));
        }
      });

      el.list.appendChild(card);
    }
  }

  function showTab(which) {
    const isMap = which === "Map";
    if (el.tabMap) el.tabMap.setAttribute("aria-selected", isMap ? "true" : "false");
    if (el.tabList) el.tabList.setAttribute("aria-selected", isMap ? "false" : "true");
    if (el.mapView) el.mapView.hidden = !isMap;
    if (el.listView) el.listView.hidden = isMap;
    if (isMap && map) setTimeout(() => map.invalidateSize(), 50);
  }

  // ---------- GPS ----------
  function captureGPS() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = round6(pos.coords.latitude);
          const lng = round6(pos.coords.longitude);
          const accuracy = pos.coords.accuracy;
          resolve({ lat, lng, accuracy });
        },
        (err) => reject(new Error(err.message || "Could not get location")),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 }
      );
    });
  }

  function setLogFix(fix) {
    lastFix = fix;

    if (el.latVal) el.latVal.textContent = fix ? String(fix.lat) : "—";
    if (el.lngVal) el.lngVal.textContent = fix ? String(fix.lng) : "—";
    if (el.accVal) el.accVal.textContent = fix ? fmtAcc(fix.accuracy) : "—";

    const okFix = !!(fix && isFinite(fix.lat) && isFinite(fix.lng));
    if (el.btnOpenMap) el.btnOpenMap.disabled = !okFix;

    const okName = (el.name?.value || "").trim().length > 0;
    if (el.btnSave) el.btnSave.disabled = !(okFix && okName);
  }

  function updateSaveEnabled() {
    const okFix = !!(lastFix && isFinite(lastFix.lat) && isFinite(lastFix.lng));
    const okName = (el.name?.value || "").trim().length > 0;
    if (el.btnSave) el.btnSave.disabled = !(okFix && okName);
  }

  // ---------- Dictation (optional best-effort) ----------
  function startDictation() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Dictation isn’t supported in this browser. You can type normally.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = "en-AU";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    if (el.btnDictate) {
      el.btnDictate.disabled = true;
      el.btnDictate.textContent = "Listening…";
    }

    rec.onresult = (e) => {
      const t = e.results?.[0]?.[0]?.transcript || "";
      if (!t || !el.description) return;
      const cur = (el.description.value || "").trim();
      el.description.value = cur ? (cur + " " + t) : t;
    };

    rec.onerror = () => alert("Dictation failed. You can type normally.");

    rec.onend = () => {
      if (el.btnDictate) {
        el.btnDictate.disabled = false;
        el.btnDictate.textContent = "Dictate";
      }
    };

    rec.start();
  }

  // ---------- Data ops ----------
  async function refresh() {
    if (!BACKEND_URL) {
      setStatus("Backend URL not set.");
      return;
    }
    setStatus("Loading…");

    try {
      const arr = await fetchItems();
      arr.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      items = arr;
      renderMap();
      renderList();
      setStatus(`Loaded ${items.length} locations.`);
    } catch (e) {
      setStatus(`Could not load. (${e.message})`);
    }
  }

  async function syncQueue() {
    if (VIEW_ONLY) return; // viewers can’t sync writes
    if (!API_TOKEN) {
      setStatus("Logger token missing.");
      return;
    }

    setStatus("Syncing…");
    const queued = await queueAll();
    if (queued.length === 0) {
      setStatus("Nothing to sync.");
      await updatePendingUI();
      return;
    }

    let ok = 0, fail = 0;
    for (const q of queued) {
      try {
        await postItem(q.payload);
        await queueDelete(q.id);
        ok++;
      } catch {
        fail++;
      }
    }

    await updatePendingUI();
    if (fail === 0) setStatus(`Synced ${ok} queued item(s).`);
    else setStatus(`Synced ${ok}. ${fail} still pending.`);
    await refresh();
  }

  // ---------- Logging ----------
  function openLog() {
    if (VIEW_ONLY) return;
    if (!API_TOKEN) {
      alert("Logger token missing.");
      return;
    }

    if (el.name) el.name.value = "";
    if (el.description) el.description.value = "";
    setLogFix(null);

    if (el.logStatus) el.logStatus.textContent = "Capture GPS, add a name, then save.";
    if (el.logModal?.showModal) el.logModal.showModal();
  }

  async function handleCapture() {
    if (VIEW_ONLY) return;

    try {
      if (el.logStatus) el.logStatus.textContent = "Getting GPS…";
      const fix = await captureGPS();
      setLogFix(fix);
      setMeMarker(fix.lat, fix.lng, fix.accuracy);
      if (map) map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 16));
      if (el.logStatus) el.logStatus.textContent = `GPS captured (${fmtAcc(fix.accuracy)}).`;
    } catch (e) {
      if (el.logStatus) el.logStatus.textContent = `GPS failed: ${e.message}`;
    }
  }

  function openCapturedInMaps() {
    if (!lastFix) return;
    window.open(mapsLink(lastFix.lat, lastFix.lng), "_blank", "noopener,noreferrer");
  }

  async function handleSave() {
    if (VIEW_ONLY) return;

    const name = (el.name?.value || "").trim();
    if (!name) {
      alert("Please enter a name.");
      return;
    }
    if (!lastFix) return;

    const payload = {
      id: uid(),
      createdAt: nowISO(),
      category: el.category?.value || "Other",
      name,
      description: (el.description?.value || "").trim(),
      lat: lastFix.lat,
      lng: lastFix.lng,
      accuracy: lastFix.accuracy,
      createdBy: (CFG.createdBy || "").trim(),
    };

    if (el.btnSave) el.btnSave.disabled = true;
    if (el.logStatus) el.logStatus.textContent = "Saving…";

    try {
      const saved = await postItem(payload);
      items = [saved, ...items];
      renderMap();
      renderList();
      if (el.logModal?.close) el.logModal.close();
      setStatus("Saved a new location.");
    } catch (e) {
      // Queue for later
      await queueAdd({ id: payload.id, payload, createdAt: payload.createdAt });
      if (el.logModal?.close) el.logModal.close();
      setStatus("Saved to queue. Tap Sync when online.");
    } finally {
      if (el.btnSave) el.btnSave.disabled = false;
    }
  }

  // ---------- “Center on me” ----------
  async function centerOnMe() {
    try {
      setStatus("Getting your location…");
      const fix = await captureGPS();
      setMeMarker(fix.lat, fix.lng, fix.accuracy);
      map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 16));
      setStatus(`Centered on you (${fmtAcc(fix.accuracy)}).`);
    } catch (e) {
      setStatus(`Could not get your location. (${e.message})`);
    }
  }

  // ---------- Service worker ----------
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }

  // ---------- Wire up ----------
  function bindEvents() {
    el.tabMap?.addEventListener("click", () => showTab("Map"));
    el.tabList?.addEventListener("click", () => showTab("List"));

    el.search?.addEventListener("input", () => {
      searchTerm = el.search.value || "";
      renderMap();
      renderList();
    });

    el.btnRefresh?.addEventListener("click", refresh);

    if (!VIEW_ONLY) {
      el.btnSync?.addEventListener("click", syncQueue);
      el.btnLog?.addEventListener("click", openLog);

      el.btnCapture?.addEventListener("click", handleCapture);
      el.btnOpenMap?.addEventListener("click", openCapturedInMaps);
      el.btnSave?.addEventListener("click", handleSave);

      el.btnClear?.addEventListener("click", () => { if (el.description) el.description.value = ""; });
      el.btnDictate?.addEventListener("click", startDictation);
      el.name?.addEventListener("input", updateSaveEnabled);
    }

    el.btnCenterMe?.addEventListener("click", centerOnMe);

    window.addEventListener("online", () => setStatus("Online."));
    window.addEventListener("offline", () => setStatus("Offline."));

    updatePendingUI();
  }

  function applyModeUI() {
    // Hide write-only UI for viewers
    if (VIEW_ONLY) {
      if (el.btnLog) el.btnLog.style.display = "none";
      if (el.btnSync) el.btnSync.style.display = "none";
      if (el.pendingPill) el.pendingPill.hidden = true;
    } else {
      // Logger: Sync shown; pending pill managed elsewhere
    }
  }

  // ---------- Boot ----------
  function boot() {
    setSubTitle();
    applyModeUI();

    initMap();
    renderChips();
    bindEvents();
    registerSW();

    refresh();
  }

  boot();
})();

/* Parcel Dispatch frontend. API calls are POSTed to Apps Script.
   The short-lived result is retrieved using JSONP to avoid CORS fetch issues. */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    token: "",
    role: "",
    parcels: [],
    visibleCount: 40,
    scanner: null,
    scannerRunning: false,
    scanBusy: false,
    lastScan: null
  };

  const API_URL = (window.PARCEL_CONFIG && window.PARCEL_CONFIG.API_URL || "").trim();

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    $("loginForm").addEventListener("submit", onLogin);
    $("logoutButton").addEventListener("click", onLogout);
    $("refreshButton").addEventListener("click", loadParcels);
    $("startCameraButton").addEventListener("click", startCamera);
    $("stopCameraButton").addEventListener("click", stopCamera);
    $("manualScanButton").addEventListener("click", manualScan);
    $("manualTracking").addEventListener("keydown", (e) => {
      if (e.key === "Enter") manualScan();
    });
    $("searchInput").addEventListener("input", () => {
      state.visibleCount = 40;
      renderParcels();
    });
    $("statusFilter").addEventListener("change", () => {
      state.visibleCount = 40;
      renderParcels();
    });
    $("loadMoreButton").addEventListener("click", () => {
      state.visibleCount += 40;
      renderParcels();
    });

    $("todayLabel").textContent = new Intl.DateTimeFormat("en-PH", {
      weekday: "long", month: "long", day: "numeric"
    }).format(new Date());

    if (!API_URL || API_URL.includes("PASTE_YOUR")) {
      showNotice("loginMessage", "Setup needed: add your Apps Script Web App URL to config.js.", "error");
    }
  }

  function onLogin(event) {
    event.preventDefault();
    const code = $("userCode").value.trim();
    if (!code) return;
    setButtonBusy("loginButton", true, "Signing in…");

    api("login", { userCode: code })
      .then((result) => {
        if (!result.success) throw new Error(result.error || "Login failed.");
        state.token = result.token;
        state.role = result.role;
        $("loginView").classList.add("hidden");
        $("appView").classList.remove("hidden");
        $("rolePill").textContent = state.role === "WAREHOUSE" ? "WAREHOUSE" : "GUARD HOUSE";
        $("dashboardTitle").textContent = state.role === "WAREHOUSE" ? "Warehouse dashboard" : "Guard house dashboard";
        $("dashboardSubtitle").textContent = state.role === "WAREHOUSE"
          ? "Scan parcels as they leave the warehouse."
          : "Verify parcels as they pass the guard house.";
        $("scannerTitle").textContent = state.role === "WAREHOUSE" ? "Warehouse Out scanner" : "Guard House Out scanner";
        $("scannerDescription").textContent = state.role === "WAREHOUSE"
          ? "Scan the parcel barcode when it leaves the warehouse."
          : "Scan only parcels already recorded as Warehouse Out.";
        $("loginMessage").classList.add("hidden");
        loadParcels();
      })
      .catch((err) => showNotice("loginMessage", err.message, "error"))
      .finally(() => setButtonBusy("loginButton", false, "Sign in"));
  }

  function onLogout() {
    stopCamera();
    const oldToken = state.token;
    state.token = "";
    state.role = "";
    state.parcels = [];
    state.lastScan = null;
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    $("userCode").value = "";
    $("userCode").focus();
    if (oldToken) api("logout", { token: oldToken }).catch(() => {});
  }

  async function loadParcels() {
    if (!state.token) return;
    $("parcelList").innerHTML = '<div class="loading-state">Refreshing parcel records…</div>';
    try {
      const result = await api("getParcels", { token: state.token });
      if (!result.success) throw new Error(result.error || "Could not load parcels.");
      state.parcels = result.parcels || [];
      updateStats();
      renderParcels();
    } catch (err) {
      showNotice("scanMessage", err.message, "error");
      $("parcelList").innerHTML = '<div class="empty-state">Unable to load parcel records. Try Refresh.</div>';
    }
  }

  function updateStats() {
    const total = state.parcels.length;
    const warehouse = state.parcels.filter(p => p.warehouse).length;
    const guard = state.parcels.filter(p => p.guardhouse).length;
    const awaiting = state.parcels.filter(p => p.warehouse && !p.guardhouse).length;
    $("totalCount").textContent = total.toLocaleString();
    $("warehouseCount").textContent = warehouse.toLocaleString();
    $("guardCount").textContent = guard.toLocaleString();
    $("awaitingCount").textContent = awaiting.toLocaleString();
  }

  function filteredParcels() {
    const q = $("searchInput").value.trim().toLowerCase();
    const filter = $("statusFilter").value;
    return state.parcels.filter(p => {
      const matchText = !q || p.tracking.toLowerCase().includes(q) || p.order.toLowerCase().includes(q);
      let matchStatus = true;
      if (filter === "PENDING") matchStatus = !p.warehouse;
      if (filter === "IN_TRANSIT") matchStatus = !!p.warehouse && !p.guardhouse;
      if (filter === "COMPLETED") matchStatus = !!p.warehouse && !!p.guardhouse;
      return matchText && matchStatus;
    });
  }

  function renderParcels() {
    const list = $("parcelList");
    const filtered = filteredParcels();
    const shown = filtered.slice(0, state.visibleCount);
    $("recordCount").textContent = filtered.length.toLocaleString() + " records";
    $("listSummary").textContent = "Showing " + shown.length.toLocaleString() + " of " + filtered.length.toLocaleString() + " matching parcels";
    $("loadMoreButton").classList.toggle("hidden", shown.length >= filtered.length);

    if (!shown.length) {
      list.innerHTML = '<div class="empty-state">No matching parcels found.</div>';
      return;
    }

    const header = document.createElement("div");
    header.className = "parcel-row header-row";
    ["Parcel / tracking number", "Order number", "Warehouse out", "Guard house out", "Dispatch status"].forEach(t => {
      const el = document.createElement("div");
      el.textContent = t;
      header.appendChild(el);
    });
    list.replaceChildren(header);

    shown.forEach(p => {
      const row = document.createElement("article");
      row.className = "parcel-row";

      const parcel = document.createElement("div");
      parcel.className = "parcel-main";
      const tracking = document.createElement("strong");
      tracking.textContent = p.tracking;
      const trackingSub = document.createElement("small");
      trackingSub.textContent = "TRACKING NUMBER";
      parcel.append(tracking, trackingSub);

      const order = document.createElement("div");
      order.className = "status-cell";
      order.innerHTML = '<span class="mobile-label">Order number</span>';
      const orderText = document.createElement("strong");
      orderText.textContent = p.order || "—";
      order.appendChild(orderText);

      const warehouse = makeCheckpoint("Warehouse out", p.warehouse);
      const guard = makeCheckpoint("Guard house out", p.guardhouse);

      const overall = document.createElement("div");
      overall.className = "overall-status";
      overall.innerHTML = p.completed
        ? '<span class="status-pill status-done">✓ COMPLETED</span>'
        : p.warehouse
          ? '<span class="status-pill status-transit">IN TRANSIT</span>'
          : '<span class="status-pill status-pending">PENDING</span>';

      row.append(parcel, order, warehouse, guard, overall);
      list.appendChild(row);
    });
  }

  function makeCheckpoint(label, timestamp) {
    const cell = document.createElement("div");
    cell.className = "status-cell";
    const labelEl = document.createElement("span");
    labelEl.className = "mobile-label";
    labelEl.textContent = label;
    const pill = document.createElement("span");
    pill.className = "status-pill " + (timestamp ? "status-done" : "status-pending");
    pill.textContent = timestamp ? "✓ OUT" : "PENDING";
    cell.append(labelEl, pill);
    if (timestamp) {
      const time = document.createElement("small");
      time.className = "status-time";
      time.textContent = timestamp;
      cell.appendChild(time);
    }
    return cell;
  }

  async function startCamera() {
    if (state.scannerRunning) return;

    if (!window.isSecureContext) {
      showNotice("scanMessage", "Camera access requires a secure HTTPS page. Open the GitHub Pages https:// address.", "error");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNotice("scanMessage", "This browser does not provide camera access. Open this page in Chrome and check Android camera permissions.", "error");
      return;
    }
    if (typeof Html5Qrcode === "undefined") {
      showNotice("scanMessage", "The barcode scanner library did not load. Check your internet connection and reload.", "error");
      return;
    }

    try {
      showNotice("scanMessage", "Requesting camera access…", "info");
      $("cameraPlaceholder").classList.remove("hidden");

      // Html5Qrcode.start calls getUserMedia from this user-click flow.
      // Chrome shows its permission prompt if permission has not already been decided.
      state.scanner = new Html5Qrcode("reader", {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.CODABAR,
          Html5QrcodeSupportedFormats.QR_CODE
        ],
        verbose: false
      });

      await state.scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: { width: 280, height: 135 }, aspectRatio: 1.8 },
        (decodedText) => onBarcodeDetected(decodedText),
        () => {}
      );

      state.scannerRunning = true;
      $("cameraPlaceholder").classList.add("hidden");
      $("startCameraButton").classList.add("hidden");
      $("stopCameraButton").classList.remove("hidden");
      showNotice("scanMessage", "Camera ready. Point it at a parcel barcode.", "success");

    } catch (err) {
      console.error("Camera start failed:", err);
      const message = cameraErrorMessage(err);
      showNotice("scanMessage", message, "error");
      if (state.scanner) {
        try { await state.scanner.clear(); } catch (_) {}
        state.scanner = null;
      }
    }
  }

  function cameraErrorMessage(err) {
    const name = err && err.name ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Camera permission was blocked. In Android Chrome, open this site's settings → Permissions → Camera → Allow, then reload.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No camera was found on this device.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "The camera is busy. Close other camera apps or browser tabs and try again.";
    }
    if (name === "OverconstrainedError") {
      return "The rear camera could not be selected. Check that your phone camera is available.";
    }
    return "Camera could not start: " + (err && err.message ? err.message : "Unknown error");
  }

  async function stopCamera() {
    if (state.scanner && state.scannerRunning) {
      try { await state.scanner.stop(); } catch (err) { console.warn(err); }
    }
    if (state.scanner) {
      try { await state.scanner.clear(); } catch (_) {}
    }
    state.scanner = null;
    state.scannerRunning = false;
    $("cameraPlaceholder").classList.remove("hidden");
    $("startCameraButton").classList.remove("hidden");
    $("stopCameraButton").classList.add("hidden");
  }

  async function onBarcodeDetected(decodedText) {
    if (state.scanBusy) return;
    state.scanBusy = true;
    await stopCamera();
    await submitScan(decodedText);
    state.scanBusy = false;
  }

  async function manualScan() {
    const tracking = $("manualTracking").value.trim();
    if (!tracking) {
      showNotice("scanMessage", "Enter a tracking number first.", "error");
      return;
    }
    if (state.scanBusy) return;
    state.scanBusy = true;
    await submitScan(tracking);
    state.scanBusy = false;
  }

  async function submitScan(trackingNumber) {
    showNotice("scanMessage", "Checking " + trackingNumber + "…", "info");
    $("manualScanButton").disabled = true;

    try {
      const result = await api("scan", {
        token: state.token,
        trackingNumber: trackingNumber
      });
      if (!result.success) throw new Error(result.error || "Scan was rejected.");

      state.lastScan = result;
      showLastScan(result);
      $("manualTracking").value = "";
      showNotice("scanMessage", "Scan accepted: " + result.tracking + " marked " + result.checkpoint + ".", "success");
      await loadParcels();
      if (state.scannerRunning) await stopCamera();

    } catch (err) {
      showNotice("scanMessage", err.message, "error");
    } finally {
      $("manualScanButton").disabled = false;
      $("manualTracking").focus();
    }
  }

  function showLastScan(result) {
    $("lastScanEmpty").classList.add("hidden");
    $("lastScanCard").classList.remove("hidden");
    $("lastScanTracking").textContent = result.tracking;
    $("lastScanOrder").textContent = "Order " + (result.order || "—");
    $("lastScanCheckpoint").textContent = result.checkpoint;
    $("lastScanTime").textContent = result.timestamp;
  }

  function showNotice(id, text, type) {
    const el = $(id);
    el.textContent = text;
    el.className = "notice " + type;
  }

  function setButtonBusy(id, busy, normalText) {
    const button = $(id);
    button.disabled = busy;
    button.textContent = busy ? "Please wait…" : normalText;
  }

  /**
   * POST the operation to Apps Script using a hidden iframe form.
   * Then poll a JSONP endpoint for the short-lived result.
   */
  function api(action, fields) {
    if (!API_URL || API_URL.includes("PASTE_YOUR")) {
      return Promise.reject(new Error("Apps Script API URL is not configured in config.js."));
    }

    const requestId = makeRequestId();
    const form = document.createElement("form");
    form.method = "POST";
    form.action = API_URL;
    form.target = "apiPostFrame";
    form.style.display = "none";

    const data = Object.assign({}, fields, {
      action: action,
      requestId: requestId
    });

    Object.keys(data).forEach((key) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = String(data[key] == null ? "" : data[key]);
      form.appendChild(input);
    });

    document.body.appendChild(form);
    form.submit();
    form.remove();

    return pollResult(requestId, 0);
  }

  function pollResult(requestId, attempt) {
    if (attempt > 40) {
      return Promise.reject(new Error("The server did not respond in time. Check the Apps Script deployment and try again."));
    }

    return jsonp("result", requestId)
      .then(async (result) => {
        if (result && result.pending) {
          await delay(350);
          return pollResult(requestId, attempt + 1);
        }
        if (result && result.chunked) {
          const chunks = [];
          for (let i = 0; i < result.chunkCount; i++) {
            const part = await jsonp("chunk", requestId, i);
            if (!part || typeof part.chunk !== "string") {
              throw new Error("Could not retrieve the full parcel list. Please refresh.");
            }
            chunks.push(part.chunk);
          }
          return JSON.parse(chunks.join(""));
        }
        return result;
      });
  }

  function jsonp(action, requestId, index) {
    return new Promise((resolve, reject) => {
      const callbackName = "parcelCallback_" + makeRequestId().replace(/-/g, "");
      const script = document.createElement("script");
      const params = new URLSearchParams({
        action: action,
        requestId: requestId,
        callback: callbackName,
        _: String(Date.now())
      });
      if (typeof index === "number") params.set("index", String(index));

      const cleanup = () => {
        delete window[callbackName];
        script.remove();
      };

      window[callbackName] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("Could not contact Apps Script. Check the API URL and deployment access."));
      };
      script.src = API_URL + "?" + params.toString();
      document.head.appendChild(script);
    });
  }

  function makeRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();

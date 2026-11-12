/* Parcel Dispatch frontend. API calls are POSTed to Apps Script.
   The short-lived result is retrieved using JSONP to avoid CORS fetch issues. */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    token: "",
    role: "",
    parcels: [],
    batches: [],
    today: "",
    signatureDrawn: false,
    visibleCount: 40,
    scanner: null,
    scannerRunning: false,
    scanBusy: false,
    lastScan: null,
    lastDecodedText: "",
    lastDecodedAt: 0,
    processedScans: new Set(),
    audioContext: null,
    scannerRecoveryPromise: null
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
    $("uploadExcelButton").addEventListener("click", uploadExcelFile);
    $("clearSignature").addEventListener("click", clearSignature);
    $("confirmHandover").addEventListener("click", confirmHandover);
    $("openWarehouseHandover").addEventListener("click", () => {
      $("handoverPanel").scrollIntoView({behavior:"smooth",block:"start"});
      $("signaturePad").classList.add("signature-attention");
      setTimeout(() => $("signaturePad").classList.remove("signature-attention"),1800);
    });
    $("batchPicker").addEventListener("change", renderHandover);
    setupSignaturePad();

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
        state.userName = result.name || "";
        $("loginView").classList.add("hidden");
        $("appView").classList.remove("hidden");
        const isBackend = state.role === "BACKEND";
        $("rolePill").textContent = isBackend ? "BACKEND" : state.role === "WAREHOUSE" ? "WAREHOUSE" : "GUARD HOUSE";
        $("dashboardTitle").textContent = isBackend ? "Backend dashboard" : state.role === "WAREHOUSE" ? "Warehouse dashboard" : "Guard house dashboard";
        $("dashboardSubtitle").textContent = isBackend
          ? "View dispatch progress and upload parcel tracking lists."
          : state.role === "WAREHOUSE"
            ? "Scan parcels as they leave the warehouse."
            : "Verify parcels as they pass the guard house.";
        // Warehouse/Backend dashboard labels; Guard House labels remain unchanged.
        const dailySummary = isBackend || state.role === "WAREHOUSE";
        const summaryLabels = [
          ["totalCount", "Total Parcels to be Processed Today", "Today's uploads + outstanding backlogs"],
          ["warehouseCount", "Release From Warehouse", "Parcels signed and released today"],
          ["guardCount", "Received By Guard", "Parcels signed and received today"],
          ["awaitingCount", "Pending to be receive by Guard", "Released parcels awaiting guard confirmation"],
          ["backlogCount", "Backlogs", "Older uncompleted parcels"]
        ];
        if (dailySummary) {
          const cards = document.querySelectorAll(".stats-grid .stat-card");
          summaryLabels.forEach(([id, label, hint], i) => {
            const card = cards[i];
            if (!card || !card.querySelector("#" + id)) return;
            card.querySelector(".stat-label").textContent = label;
            card.querySelector(".stat-hint").textContent = hint;
          });
        } else {
          const originalLabels = [
            ["Total to process today", "Today's uploads + outstanding backlogs"],
            ["Warehouse out", "Signed and forwarded by warehouse"],
            ["Guard house out", "Signed and confirmed by guard"],
            ["Awaiting guard scan", "Forwarded but not yet guard-scanned"],
            ["Backlogs", "Older uncompleted parcels"]
          ];
          document.querySelectorAll(".stats-grid .stat-card").forEach((card, i) => {
            if (!originalLabels[i]) return;
            card.querySelector(".stat-label").textContent = originalLabels[i][0];
            card.querySelector(".stat-hint").textContent = originalLabels[i][1];
          });
        }
        $("workspaceGrid").classList.toggle("hidden", isBackend);
        $("backendUploadPanel").classList.toggle("hidden", !isBackend);
        $("handoverPanel").classList.toggle("hidden", isBackend);
        $("warehouseForwardBanner").classList.toggle("hidden", state.role !== "WAREHOUSE");
        $("confirmHandover").textContent = state.role === "WAREHOUSE" ? "Sign & Forward to Guard House" : "Confirm Guard Handover & Email PDF";
        $("handoverTitle").textContent = state.role === "WAREHOUSE" ? "Sign and forward scanned parcels" : "Sign completed guard handover";
        $("handoverHint").textContent = state.role === "WAREHOUSE" ? "Your signature releases all warehouse-scanned parcels not yet forwarded to the guard." : "Select a forwarded batch. All its parcels must be guard-scanned before you can sign and send the PDF report.";
        $("batchPickerWrap").classList.toggle("hidden", state.role !== "GUARDHOUSE");
        clearSignature();
        $("scannerTitle").textContent = state.role === "WAREHOUSE" ? "Warehouse scanner" : "Guard House scanner";
        $("scannerDescription").textContent = state.role === "WAREHOUSE"
          ? "Scan parcels first. Warehouse Out is recorded only after signing and forwarding."
          : "Scan forwarded parcels first. Guard House Out is recorded only after signing the batch.";
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
    state.userName = "";
    state.parcels = [];
    state.batches = [];
    state.lastScan = null;
    state.lastDecodedText = "";
    state.lastDecodedAt = 0;
    state.processedScans.clear();
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
      state.batches = result.batches || [];
      state.today = result.today || new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Manila"});
      renderHandover();
      updateStats();
      renderParcels();
    } catch (err) {
      showNotice("scanMessage", err.message, "error");
      $("parcelList").innerHTML = '<div class="empty-state">Unable to load parcel records. Try Refresh.</div>';
    }
  }

  function setupSignaturePad() {
    const canvas = $("signaturePad"), ctx = canvas.getContext("2d");
    let drawing = false;
    const point = e => { const r = canvas.getBoundingClientRect(); return {
      x: (e.clientX-r.left)*canvas.width/r.width,
      y: (e.clientY-r.top)*canvas.height/r.height
    }; };
    canvas.addEventListener("pointerdown", e => {
      e.preventDefault(); drawing = true; canvas.setPointerCapture(e.pointerId);
      const p = point(e); ctx.beginPath(); ctx.moveTo(p.x,p.y);
    });
    canvas.addEventListener("pointermove", e => {
      if (!drawing) return;
      e.preventDefault(); const p = point(e);
      ctx.strokeStyle = "#172b4d"; ctx.lineWidth = 3.5; ctx.lineCap = "round";
      ctx.lineJoin = "round"; ctx.lineTo(p.x,p.y); ctx.stroke();
      state.signatureDrawn = true;
    });
    ["pointerup","pointercancel","lostpointercapture"].forEach(t => canvas.addEventListener(t,()=>{drawing=false;}));
  }
  function clearSignature() {
    const canvas=$("signaturePad");
    canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);
    state.signatureDrawn=false;
  }
  function renderHandover() {
    if (state.role === "WAREHOUSE") {
      const count=state.parcels.filter(p=>p.warehouseScanned && !p.batchId).length;
      $("handoverCount").textContent=count+" scanned parcel(s) awaiting warehouse signature and forwarding";
      $("confirmHandover").disabled=!count;
      $("openWarehouseHandover").disabled=!count;
      $("warehouseForwardStatus").textContent = count
        ? count + " scanned parcel(s) ready to forward. Tap here, sign, then confirm."
        : "Scan parcels first. This button becomes available when a parcel is scanned.";
    } else if (state.role === "GUARDHOUSE") {
      const picker=$("batchPicker"), selected=picker.value;
      const open=state.batches.filter(b => b && typeof b.id === "string" && b.id.trim() && !b.guardAt);
      picker.replaceChildren();
      if (!open.length) {
        const placeholder=document.createElement("option");
        placeholder.value="";
        placeholder.textContent="No batches awaiting confirmation";
        picker.appendChild(placeholder);
      }
      open.forEach(b => {
        const id=b.id.trim();
        const actualCount=state.parcels.filter(p => p.batchId === id).length;
        const option=document.createElement("option");
        option.value=id;
        option.textContent=id+" ("+actualCount+" parcel"+(actualCount===1?"":"s")+")";
        picker.appendChild(option);
      });
      if(open.some(b=>b.id.trim()===selected)) picker.value=selected;
      const id=picker.value, parcels=state.parcels.filter(p=>p.batchId===id);
      const remaining=parcels.filter(p=>!p.guardScanned).length;
      $("handoverCount").textContent=!open.length ? "No batches awaiting guard confirmation" :
        parcels.length+" forwarded parcels · "+remaining+" still need guard scanning";
      $("confirmHandover").disabled=!id || remaining!==0 || !parcels.length;
    }
  }
  async function confirmHandover() {
    if (!state.signatureDrawn) {showNotice("handoverMessage","Draw your signature before confirming.","error");return;}
    const warehouse=state.role==="WAREHOUSE";
    const batchId=warehouse?"":$("batchPicker").value;
    const count=warehouse?state.parcels.filter(p=>p.warehouseScanned&&!p.batchId).length:
      state.parcels.filter(p=>p.batchId===batchId).length;
    if (!count) return;
    const question=warehouse ? "Forward "+count+" scanned parcels to Guard House with your signature?" :
      "Confirm "+count+" guard-scanned parcels and email the signed PDF to all active recipients?";
    if (!window.confirm(question)) return;
    setButtonBusy("confirmHandover",true,"Confirm signed handover");
    showNotice("handoverMessage","Saving signed handover…","info");
    try {
      const result=await api(warehouse?"confirmWarehouse":"confirmGuard",{
        token:state.token,batchId:batchId,signature:$("signaturePad").toDataURL("image/png")
      });
      if(!result.success) throw new Error(result.error||"Confirmation failed");
      showNotice("handoverMessage",warehouse ? "Batch "+result.batchId+" forwarded: "+result.count+" parcels." :
        "Batch "+result.batchId+" confirmed. PDF emailed to "+result.emailed+" recipient(s). "+(result.notice||""),"success");
      clearSignature(); await loadParcels();
    } catch(err) {showNotice("handoverMessage",err.message,"error");}
    finally {setButtonBusy("confirmHandover",false,warehouse ? "Sign & Forward to Guard House" : "Confirm Guard Handover & Email PDF");renderHandover();}
  }

  async function uploadExcelFile() {
    if (state.role !== "BACKEND") {
      showNotice("uploadMessage", "This function is only available to BACKEND users.", "error");
      return;
    }
    const file = $("excelFile").files[0];
    if (!file) {
      showNotice("uploadMessage", "Choose an Excel file first.", "error");
      return;
    }
    if (typeof XLSX === "undefined") {
      showNotice("uploadMessage", "The Excel reader could not load. Check your internet connection and reload.", "error");
      return;
    }

    setButtonBusy("uploadExcelButton", true, "Upload Excel file");
    showNotice("uploadMessage", "Reading Excel file…", "info");
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", raw: false });
      if (!workbook.SheetNames.length) throw new Error("The Excel file has no worksheets.");
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
      if (!matrix.length) throw new Error("The first worksheet is empty.");

      const normalize = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const header = matrix[0].map(normalize);
      const trackingIndex = header.findIndex(v => ["trackingnumber", "trackingno", "tracking", "waybillnumber", "waybill"].includes(v));
      const orderIndex = header.findIndex(v => ["ordernumber", "orderno", "order", "ordernum"].includes(v));
      if (trackingIndex < 0 || orderIndex < 0) {
        throw new Error("Could not find both required headings. Use 'Tracking Number' and 'Order Number' in the first row.");
      }

      const rows = matrix.slice(1).map(row => ({
        tracking: String(row[trackingIndex] == null ? "" : row[trackingIndex]).trim(),
        order: String(row[orderIndex] == null ? "" : row[orderIndex]).trim()
      })).filter(row => row.tracking || row.order);
      if (!rows.length) throw new Error("No parcel rows were found below the headings.");
      if (rows.length > 3000) throw new Error("This file contains " + rows.length.toLocaleString() + " rows. Please split it into files of 3,000 rows or fewer.");

      showNotice("uploadMessage", "Uploading " + rows.length.toLocaleString() + " parcel rows…", "info");
      const result = await api("uploadParcels", { token: state.token, rowsJson: JSON.stringify(rows) });
      if (!result.success) throw new Error(result.error || "Upload failed.");
      showNotice("uploadMessage", "Upload complete. Added " + result.added.toLocaleString() + " new parcels; skipped " + result.skipped.toLocaleString() + " duplicate or incomplete rows.", "success");
      $("excelFile").value = "";
      await loadParcels();
    } catch (err) {
      showNotice("uploadMessage", err.message || "Could not process this Excel file.", "error");
    } finally {
      setButtonBusy("uploadExcelButton", false, "Upload Excel file");
    }
  }

  function isBacklog(p) {
    // Undated legacy records are treated as outstanding until completed.
    return !p.guardhouse && (!p.uploadedDate || p.uploadedDate < state.today);
  }

  function updateStats() {
    const todays = state.parcels.filter(p => p.uploadedDate === state.today);
    const backlog = state.parcels.filter(isBacklog);
    const workload = new Set([...todays, ...backlog].map(p => p.tracking));
    // For Warehouse and Backend: checkpoint totals refer to today's confirmed
    // activity in Asia/Manila. A scan alone is not a confirmed release/receipt.
    // Guard House keeps its existing cumulative dashboard behavior.
    const dailySummary = state.role === "WAREHOUSE" || state.role === "BACKEND";
    const datePart = timestamp => String(timestamp || "").slice(0, 10);
    const warehouse = state.parcels.filter(p => p.warehouse && (!dailySummary || datePart(p.warehouse) === state.today)).length;
    const guard = state.parcels.filter(p => p.guardhouse && (!dailySummary || datePart(p.guardhouse) === state.today)).length;
    // Pending guard receipt means forwarded but not yet guard-confirmed;
    // it includes parcels already scanned by guard but awaiting signature.
    const awaiting = state.parcels.filter(p => p.warehouse && (dailySummary ? !p.guardhouse : !p.guardScanned)).length;
    $("totalCount").textContent = workload.size.toLocaleString();
    $("backlogCount").textContent = backlog.length.toLocaleString();
    $("warehouseCount").textContent = warehouse.toLocaleString();
    $("guardCount").textContent = guard.toLocaleString();
    $("awaitingCount").textContent = awaiting.toLocaleString();
  }

  function filteredParcels() {
    const q = $("searchInput").value.trim().toLowerCase();
    const filter = $("statusFilter").value;
    return state.parcels.filter(p => {
      const matchText = !q || p.tracking.toLowerCase().includes(q) || p.order.toLowerCase().includes(q) || (p.batchId || "").toLowerCase().includes(q);
      let matchStatus = true;
      if (filter === "BACKLOG") matchStatus = isBacklog(p);
      if (filter === "TODAY") matchStatus = p.uploadedDate === state.today;
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
    ["Parcel / tracking number", "Order number", "Dispatch batch number", "Warehouse out", "Warehouse scanned by", "Guard house out", "Guard scanned by", "Dispatch status"].forEach(t => {
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
      trackingSub.textContent = p.uploadedAt ? "Uploaded: " + p.uploadedAt : "UPLOAD DATE NOT RECORDED";
      parcel.append(tracking, trackingSub);

      const order = document.createElement("div");
      order.className = "status-cell order-cell";
      order.innerHTML = '<span class="mobile-label">Order number</span>';
      const orderText = document.createElement("strong");
      orderText.textContent = p.order || "—";
      orderText.title = p.order || "";
      order.appendChild(orderText);

      const dispatchBatch = document.createElement("div");
      dispatchBatch.className = "status-cell batch-cell";
      const batchLabel = document.createElement("span");
      batchLabel.className = "mobile-label";
      batchLabel.textContent = "Dispatch batch number";
      const batchValue = document.createElement("strong");
      batchValue.textContent = p.batchId || "Not assigned";
      batchValue.title = p.batchId || "Warehouse has not signed and forwarded this parcel";
      if (!p.batchId) batchValue.className = "batch-unassigned";
      dispatchBatch.append(batchLabel, batchValue);

      const warehouse = makeCheckpoint("Warehouse out", p.warehouse);
      const warehouseBy = makeScannedBy("Warehouse scanned by", p.warehouseBy);
      const guard = makeCheckpoint("Guard house out", p.guardhouse);
      const guardBy = makeScannedBy("Guard scanned by", p.guardhouseBy);

      const overall = document.createElement("div");
      overall.className = "overall-status";
      overall.innerHTML = p.completed
        ? '<span class="status-pill status-done">✓ COMPLETED</span>'
        : p.warehouse
          ? '<span class="status-pill status-transit">IN TRANSIT</span>'
          : p.warehouseScanned
            ? '<span class="status-pill status-transit">AWAITING WAREHOUSE SIGNATURE</span>'
            : '<span class="status-pill status-pending">PENDING</span>';

      if (p.warehouseScanned && !p.warehouse) {
        warehouse.querySelector(".status-pill")?.replaceChildren(document.createTextNode("SCANNED · SIGN PENDING"));
      }
      if (p.guardScanned && !p.guardhouse) {
        guard.querySelector(".status-pill")?.replaceChildren(document.createTextNode("SCANNED · SIGN PENDING"));
      }
      row.append(parcel, order, dispatchBatch, warehouse, warehouseBy, guard, guardBy, overall);
      list.appendChild(row);
    });
  }

  function makeScannedBy(label, name) {
    const cell = document.createElement("div");
    cell.className = "status-cell";
    const labelEl = document.createElement("span");
    labelEl.className = "mobile-label";
    labelEl.textContent = label;
    const value = document.createElement("strong");
    value.textContent = name || "—";
    cell.append(labelEl, value);
    return cell;
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
      prepareScanAudio();

      // Html5Qrcode.start calls getUserMedia from this user-click flow.
      // Chrome shows its permission prompt if permission has not already been decided.
      state.scanner = createScanner();
      await startScannerEngine(state.scanner);

      state.scannerRunning = true;
      $("cameraPlaceholder").classList.add("hidden");
      $("startCameraButton").classList.add("hidden");
      $("stopCameraButton").classList.remove("hidden");
      showNotice("scanMessage", "Camera ready. Scan parcels one after another; the camera will stay on.", "success");

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

  function createScanner() {
    return new Html5Qrcode("reader", {
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
  }

  function startScannerEngine(scanner) {
    return scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 280, height: 135 }, aspectRatio: 1.8 },
      (decodedText) => onBarcodeDetected(decodedText),
      () => {}
    );
  }

  // Some mobile browsers or scanner-library states can leave the video stopped
  // after a decode. Check the engine after processing and recover automatically.
  async function ensureScannerActive() {
    if (!state.scannerRunning || !state.scanner) return;
    if (state.scannerRecoveryPromise) return state.scannerRecoveryPromise;

    state.scannerRecoveryPromise = (async () => {
      try {
        const current = state.scanner;
        const scannerState = current.getState();
        // html5-qrcode: 1 = PAUSED, 2 = SCANNING.
        if (scannerState === 2) return;
        if (scannerState === 1 && typeof current.resume === "function") {
          await current.resume();
          return;
        }

        try { await current.stop(); } catch (_) {}
        try { await current.clear(); } catch (_) {}
        if (!state.scannerRunning) return;

        const replacement = createScanner();
        state.scanner = replacement;
        await startScannerEngine(replacement);
        if (!state.scannerRunning) {
          try { await replacement.stop(); } catch (_) {}
          try { await replacement.clear(); } catch (_) {}
          return;
        }
        showNotice("scanMessage", "Scanner is active and ready for the next parcel.", "success");
      } catch (err) {
        console.warn("Automatic scanner recovery failed:", err);
        showNotice("scanMessage", "The camera paused. Tap Start Camera to resume. " + (err && err.message ? err.message : ""), "error");
      }
    })();

    try {
      await state.scannerRecoveryPromise;
    } finally {
      state.scannerRecoveryPromise = null;
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
    const tracking = String(decodedText || "").trim();
    if (!tracking || state.scanBusy || state.processedScans.has(tracking)) return;

    // Barcode libraries can decode the same label many times per second.
    // Ignore repeat callbacks briefly while the first request is being handled.
    const now = Date.now();
    if (tracking === state.lastDecodedText && now - state.lastDecodedAt < 2500) return;
    state.lastDecodedText = tracking;
    state.lastDecodedAt = now;

    state.scanBusy = true;
    try {
      const accepted = await submitScan(tracking);
      if (accepted) state.processedScans.add(tracking);
    } finally {
      state.scanBusy = false;
      await ensureScannerActive();
    }
  }

  async function manualScan() {
    const tracking = $("manualTracking").value.trim();
    if (!tracking) {
      showNotice("scanMessage", "Enter a tracking number first.", "error");
      return;
    }
    if (state.scanBusy) return;
    state.scanBusy = true;
    try {
      const accepted = await submitScan(tracking);
      if (accepted) state.processedScans.add(tracking);
    } finally {
      state.scanBusy = false;
      await ensureScannerActive();
    }
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
      showNotice("scanMessage", "✓ Scan accepted: " + result.tracking + " marked " + result.checkpoint + ". Camera is still active.", "success");
      playScanFeedback(true);
      await loadParcels();
      return true;

    } catch (err) {
      showNotice("scanMessage", "Scan not accepted: " + err.message, "error");
      playScanFeedback(false);
      return false;
    } finally {
      $("manualScanButton").disabled = false;
      if (!state.scannerRunning) $("manualTracking").focus();
    }
  }

  // Prepare audio while the user is pressing Start Camera. This helps Chrome
  // allow a short beep later, when a barcode is decoded asynchronously.
  function prepareScanAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!state.audioContext) state.audioContext = new AudioContextClass();
      if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => {});
    } catch (err) {
      console.warn("Audio feedback is unavailable:", err);
    }
  }

  function playBeep(success) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!state.audioContext && AudioContextClass) prepareScanAudio();
    const context = state.audioContext;
    if (!context) return;

    try {
      if (context.state === "suspended") context.resume().catch(() => {});
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = success ? 1150 : 360;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (success ? 0.16 : 0.28));
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + (success ? 0.18 : 0.30));
    } catch (err) {
      console.warn("Beep could not play:", err);
    }
  }

  function playScanFeedback(success) {
    // Android Chrome supports vibration on many devices; beep is the fallback.
    let vibrated = false;
    if (typeof navigator.vibrate === "function") {
      try { vibrated = navigator.vibrate(success ? [100] : [70, 60, 70]); } catch (_) {}
    }
    playBeep(success);
  }

  function showLastScan(result) {
    $("lastScanEmpty").classList.add("hidden");
    $("lastScanCard").classList.remove("hidden");
    $("lastScanTracking").textContent = result.tracking;
    $("lastScanOrder").textContent = "Order " + (result.order || "—");
    $("lastScanCheckpoint").textContent = result.checkpoint;
    $("lastScanTime").textContent = result.timestamp;
    $("lastScanScannedBy").textContent = result.scannedBy || "—";
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
    if (attempt > 160) {
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

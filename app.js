"use strict";

/*
 * StreamDrop frontend
 * Works with:
 *   GET  /api/health
 *   GET  /api/stats
 *   POST /api/metadata
 *   POST /api/download
 *
 * IMPORTANT:
 * API URLs are relative to the current origin.
 * No localhost:3000 / localhost:3001 is hardcoded.
 */

const API = {
  health: "/api/health",
  stats: "/api/stats",
  metadata: "/api/metadata",
  download: "/api/download",
};


// =========================================================
// ELEMENTS
// =========================================================

const els = {
  urlInput: document.getElementById("urlInput"),
  pasteBtn: document.getElementById("pasteBtn"),

  metadataPanel: document.getElementById("metadataPanel"),
  metadataThumb: document.getElementById("metadataThumb"),
  videoTitle: document.getElementById("videoTitle"),
  videoUploader: document.getElementById("videoUploader"),
  videoDuration: document.getElementById("videoDuration"),

  qualitySelect: document.getElementById("qualitySelect"),
  formatSelect: document.getElementById("formatSelect"),

  downloadBtn: document.getElementById("downloadBtn"),

  progressSection: document.getElementById("progressSection"),
  progressBar: document.getElementById("progressBar"),
  progressPercent: document.getElementById("progressPercent"),
  progressText: document.getElementById("progressText"),
  progressDetail: document.getElementById("progressDetail"),
  cancelBtn: document.getElementById("cancelBtn"),

  errorBox: document.getElementById("errorBox"),
  errorMessage: document.getElementById("errorMessage"),

  successBox: document.getElementById("successBox"),
  successMessage: document.getElementById("successMessage"),

  globalCount: document.getElementById("globalCount"),
};


// =========================================================
// STATE
// =========================================================

let metadataTimer = null;
let statsTimer = null;
let currentController = null;
let currentObjectUrl = null;
let metadataRequestId = 0;


// =========================================================
// HELPERS
// =========================================================

function isElement(element) {
  return element instanceof HTMLElement;
}


function setHidden(element, hidden) {
  if (!isElement(element)) return;
  element.classList.toggle("hidden", hidden);
}


function setText(element, value) {
  if (!element) return;
  element.textContent = String(value ?? "");
}


function showError(message) {
  setHidden(els.errorBox, false);
  setHidden(els.successBox, true);

  setText(
    els.errorMessage,
    message || "Something went wrong while processing the download."
  );
}


function hideError() {
  setHidden(els.errorBox, true);
}


function showSuccess(message) {
  setHidden(els.successBox, false);
  setHidden(els.errorBox, true);

  setText(
    els.successMessage,
    message || "Your video has been downloaded successfully."
  );
}


function hideSuccess() {
  setHidden(els.successBox, true);
}


function showProgress() {
  setHidden(els.progressSection, false);
}


function hideProgress() {
  setHidden(els.progressSection, true);
}


function setProgress(percent, text, detail) {
  const safePercent = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  if (els.progressBar) {
    els.progressBar.style.width = `${safePercent}%`;
  }

  setText(els.progressPercent, `${Math.round(safePercent)}%`);

  if (text !== undefined) {
    setText(els.progressText, text);
  }

  if (detail !== undefined) {
    setText(els.progressDetail, detail);
  }
}


function setDownloadingState(active) {
  if (!els.downloadBtn) return;

  els.downloadBtn.disabled = active;

  const label = els.downloadBtn.querySelector(
    ".download-btn-content span"
  );

  if (label) {
    label.textContent = active
      ? "Downloading..."
      : "Download Video";
  }
}


function formatDuration(seconds) {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value <= 0) {
    return "Duration unavailable";
  }

  const total = Math.round(value);

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      secs
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}


function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "0";
  }

  return new Intl.NumberFormat("en-US").format(number);
}


function validHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}


function getResponseFilename(response) {
  const disposition = response.headers.get("Content-Disposition");

  if (!disposition) {
    return "StreamDrop_Download";
  }

  // RFC 5987 / UTF-8 filename
  const utfMatch = disposition.match(
    /filename\*\s*=\s*UTF-8''([^;]+)/i
  );

  if (utfMatch) {
    try {
      return decodeURIComponent(
        utfMatch[1].trim().replace(/^["']|["']$/g, "")
      );
    } catch {
      // Continue to normal filename parser.
    }
  }

  // Normal filename
  const normalMatch = disposition.match(
    /filename\s*=\s*"([^"]+)"/i
  );

  if (normalMatch) {
    return normalMatch[1];
  }

  const unquotedMatch = disposition.match(
    /filename\s*=\s*([^;]+)/i
  );

  if (unquotedMatch) {
    return unquotedMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  return "StreamDrop_Download";
}


function cleanupObjectUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}


// =========================================================
// API ERROR PARSER
// =========================================================

async function getApiError(response) {
  const contentType =
    response.headers.get("content-type") || "";

  try {
    if (contentType.includes("application/json")) {
      const data = await response.json();

      return (
        data.error ||
        data.message ||
        `Request failed with HTTP ${response.status}.`
      );
    }

    const text = await response.text();

    if (text.trim()) {
      return text.slice(0, 800);
    }
  } catch {
    // Ignore parsing error and return generic message.
  }

  return `Request failed with HTTP ${response.status}.`;
}


// =========================================================
// PASTE BUTTON
// =========================================================

async function pasteUrl() {
  hideError();
  hideSuccess();

  try {
    if (!navigator.clipboard?.readText) {
      throw new Error(
        "Clipboard access is not available in this browser."
      );
    }

    const text = (await navigator.clipboard.readText()).trim();

    if (!text) {
      throw new Error("Your clipboard is empty.");
    }

    if (els.urlInput) {
      els.urlInput.value = text;
      els.urlInput.focus();
    }

    scheduleMetadataLookup();
  } catch (error) {
    showError(error.message || "Unable to paste the URL.");
  }
}


// =========================================================
// METADATA
// =========================================================

function resetMetadata() {
  setHidden(els.metadataPanel, true);

  setText(els.videoTitle, "Loading video...");
  setText(els.videoUploader, "—");
  setText(els.videoDuration, "—");

  if (els.metadataThumb) {
    els.metadataThumb.innerHTML = `
      <div class="thumb-placeholder">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16v14H4z"></path>
          <path d="M10 9l5 3-5 3z"></path>
        </svg>
      </div>
    `;
  }
}


function showMetadata(data) {
  if (!data) return;

  setHidden(els.metadataPanel, false);

  setText(
    els.videoTitle,
    data.title || "Untitled Video"
  );

  setText(
    els.videoUploader,
    data.uploader || "Unknown uploader"
  );

  setText(
    els.videoDuration,
    data.duration
      ? formatDuration(data.duration)
      : "Duration unavailable"
  );

  /*
   * The backend currently returns title/duration/uploader.
   * If later it returns thumbnail, this will automatically use it.
   */
  if (data.thumbnail && els.metadataThumb) {
    const img = document.createElement("img");

    img.src = data.thumbnail;
    img.alt = data.title || "Video thumbnail";
    img.loading = "lazy";

    img.onerror = () => {
      els.metadataThumb.innerHTML = `
        <div class="thumb-placeholder">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16v14H4z"></path>
            <path d="M10 9l5 3-5 3z"></path>
          </svg>
        </div>
      `;
    };

    els.metadataThumb.replaceChildren(img);
  }
}


async function fetchMetadata(url) {
  const requestId = ++metadataRequestId;

  try {
    const response = await fetch(API.metadata, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ url }),
    });

    if (requestId !== metadataRequestId) {
      return;
    }

    if (!response.ok) {
      const message = await getApiError(response);
      throw new Error(message);
    }

    const data = await response.json();

    if (requestId !== metadataRequestId) {
      return;
    }

    showMetadata(data);
  } catch (error) {
    if (requestId !== metadataRequestId) {
      return;
    }

    /*
     * Do not show a noisy error for every URL while the user is typing.
     * Metadata is optional for the download itself.
     */
    console.warn(
      "[StreamDrop] Metadata unavailable:",
      error.message
    );

    setHidden(els.metadataPanel, true);
  }
}


function scheduleMetadataLookup() {
  clearTimeout(metadataTimer);

  hideError();

  const url = els.urlInput?.value.trim();

  if (!url) {
    resetMetadata();
    return;
  }

  if (!validHttpUrl(url)) {
    resetMetadata();
    return;
  }

  /*
   * Wait until the user stops typing.
   */
  metadataTimer = setTimeout(() => {
    fetchMetadata(url);
  }, 700);
}


// =========================================================
// GLOBAL STATS
// =========================================================

async function refreshGlobalCount() {
  try {
    const response = await fetch(API.stats, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Stats request failed with HTTP ${response.status}.`
      );
    }

    const data = await response.json();

    const count = Number(data.successfulDownloads);

    if (Number.isFinite(count) && count >= 0) {
      setText(
        els.globalCount,
        formatNumber(Math.floor(count))
      );
    }
  } catch (error) {
    /*
     * Stats should never break the website.
     * Do not spam the console.
     */
    console.warn(
      "[StreamDrop] Global counter unavailable."
    );

    stopStatsPolling();
  }
}


function startStatsPolling() {
  stopStatsPolling();

  refreshGlobalCount();

  /*
   * Reasonable interval.
   * Prevents the repeated localhost:3001 errors
   * that occurred previously.
   */
  statsTimer = setInterval(() => {
    refreshGlobalCount();
  }, 5000);
}


function stopStatsPolling() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}


// =========================================================
// DOWNLOAD
// =========================================================

async function downloadVideo() {
  hideError();
  hideSuccess();

  const url = els.urlInput?.value.trim();

  const quality =
    els.qualitySelect?.value || "best";

  const format =
    els.formatSelect?.value || "original";

  if (!url) {
    showError("Please paste a video URL first.");
    els.urlInput?.focus();
    return;
  }

  if (!validHttpUrl(url)) {
    showError("Please enter a valid HTTP or HTTPS video URL.");
    els.urlInput?.focus();
    return;
  }

  /*
   * Cancel any previous download.
   */
  if (currentController) {
    currentController.abort();
  }

  currentController = new AbortController();

  setDownloadingState(true);

  showProgress();

  setProgress(
    5,
    "Preparing download...",
    "Connecting to StreamDrop"
  );

  try {
    const response = await fetch(API.download, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
      },

      cache: "no-store",

      body: JSON.stringify({
        url,
        quality,
        format,
      }),

      signal: currentController.signal,
    });

    setProgress(
      25,
      "Processing source...",
      "Receiving response"
    );

    if (!response.ok) {
      const message = await getApiError(response);
      throw new Error(message);
    }

    /*
     * Backend returns the REAL media file.
     */
    const contentLength =
      Number(response.headers.get("Content-Length")) || 0;

    let blob;

    if (
      response.body &&
      contentLength > 0
    ) {
      blob = await readResponseWithProgress(
        response,
        contentLength
      );
    } else {
      setProgress(
        65,
        "Preparing file...",
        "Reading downloaded media"
      );

      blob = await response.blob();

      setProgress(
        95,
        "Preparing download...",
        "Finalizing file"
      );
    }

    if (!blob || blob.size === 0) {
      throw new Error(
        "The server returned an empty file."
      );
    }

    /*
     * IMPORTANT:
     * Use the backend's Content-Disposition filename.
     * Do not generate a random filename from the URL.
     */
    const filename = getResponseFilename(response);

    cleanupObjectUrl();

    currentObjectUrl =
      URL.createObjectURL(blob);

    const anchor =
      document.createElement("a");

    anchor.href = currentObjectUrl;
    anchor.download =
      filename || "StreamDrop_Download";

    anchor.style.display = "none";

    document.body.appendChild(anchor);

    anchor.click();

    anchor.remove();

    /*
     * Keep the object URL alive briefly so the browser
     * has time to start the download.
     */
    const urlToCleanup = currentObjectUrl;

    setTimeout(() => {
      if (urlToCleanup) {
        URL.revokeObjectURL(urlToCleanup);

        if (currentObjectUrl === urlToCleanup) {
          currentObjectUrl = null;
        }
      }
    }, 60000);

    setProgress(
      100,
      "Download completed",
      filename
    );

    showSuccess(
      `Downloaded successfully: ${filename}`
    );

    /*
     * Ask the backend for the updated global count.
     */
    setTimeout(() => {
      refreshGlobalCount();
    }, 700);

  } catch (error) {
    if (error.name === "AbortError") {
      setProgress(
        0,
        "Download cancelled",
        "Ready for another download"
      );

      setHidden(
        els.progressSection,
        true
      );

      return;
    }

    console.error(
      "[StreamDrop] Download error:",
      error
    );

    showError(
      error.message ||
      "The download could not be completed."
    );

    setProgress(
      0,
      "Download failed",
      "See the error message above"
    );

  } finally {
    currentController = null;
    setDownloadingState(false);
  }
}


// =========================================================
// REAL RESPONSE PROGRESS
// =========================================================

async function readResponseWithProgress(
  response,
  totalBytes
) {
  const reader = response.body.getReader();

  const chunks = [];

  let receivedBytes = 0;

  while (true) {
    const { done, value } =
      await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      receivedBytes += value.byteLength;

      const downloadRatio =
        receivedBytes / totalBytes;

      /*
       * Keep the first 25% for backend processing
       * and use 25–95% for actual browser transfer.
       */
      const percent =
        25 + downloadRatio * 70;

      setProgress(
        percent,
        "Downloading...",
        `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
      );
    }
  }

  setProgress(
    96,
    "Preparing file...",
    "Creating downloadable file"
  );

  return new Blob(chunks, {
    type:
      response.headers.get("Content-Type") ||
      "application/octet-stream",
  });
}


function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB",
    "TB",
  ];

  const index = Math.min(
    Math.floor(
      Math.log(value) / Math.log(1024)
    ),
    units.length - 1
  );

  return `${(value / Math.pow(1024, index)).toFixed(
    index === 0 ? 0 : 1
  )} ${units[index]}`;
}


// =========================================================
// CANCEL
// =========================================================

function cancelDownload() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}


// =========================================================
// INPUT EVENTS
// =========================================================

function setupEvents() {
  els.pasteBtn?.addEventListener(
    "click",
    pasteUrl
  );

  els.downloadBtn?.addEventListener(
    "click",
    downloadVideo
  );

  els.cancelBtn?.addEventListener(
    "click",
    cancelDownload
  );

  els.urlInput?.addEventListener(
    "input",
    scheduleMetadataLookup
  );

  els.urlInput?.addEventListener(
    "paste",
    () => {
      setTimeout(
        scheduleMetadataLookup,
        50
      );
    }
  );

  els.urlInput?.addEventListener(
    "keydown",
    event => {
      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        downloadVideo();
      }
    }
  );

  /*
   * Stop Ctrl/Cmd + click from doing anything unexpected.
   */
  els.downloadBtn?.addEventListener(
    "contextmenu",
    event => {
      event.preventDefault();
    }
  );
}


// =========================================================
// BACKEND HEALTH
// =========================================================

async function checkBackendHealth() {
  try {
    const response = await fetch(
      API.health,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Backend health check failed: ${response.status}`
      );
    }

    const data = await response.json();

    if (
      data.success !== true ||
      data.status !== "ok"
    ) {
      throw new Error(
        "Backend returned an invalid health response."
      );
    }

    console.log(
      "[StreamDrop] Backend connected successfully."
    );

    return true;

  } catch (error) {
    console.warn(
      "[StreamDrop] Backend is unavailable:",
      error.message
    );

    return false;
  }
}


// =========================================================
// INITIALIZATION
// =========================================================

async function init() {
  console.log(
    "[StreamDrop] Initializing..."
  );

  resetMetadata();
  hideError();
  hideSuccess();
  hideProgress();

  setProgress(
    0,
    "Ready",
    "Paste a supported video URL"
  );

  setupEvents();

  /*
   * Health check is informational.
   * It must not prevent the UI from loading.
   */
  await checkBackendHealth();

  startStatsPolling();

  console.log(
    "[StreamDrop] Frontend ready."
  );
}


// =========================================================
// PAGE LIFECYCLE
// =========================================================

window.addEventListener(
  "beforeunload",
  () => {
    if (currentController) {
      currentController.abort();
    }

    stopStatsPolling();
    cleanupObjectUrl();
  }
);


document.addEventListener(
  "visibilitychange",
  () => {
    /*
     * Don't keep hitting the stats endpoint aggressively
     * when the tab is hidden.
     */
    if (document.hidden) {
      stopStatsPolling();
    } else {
      startStatsPolling();
    }
  }
);


// =========================================================
// START APP
// =========================================================

if (
  document.readyState === "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    init,
    { once: true }
  );
} else {
  init();
}
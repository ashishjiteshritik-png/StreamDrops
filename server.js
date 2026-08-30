"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const dns = require("dns").promises;
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");

// ============================================================
// CONFIG
// ============================================================

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const DATA_DIR = path.join(os.tmpdir(), "streamdrop");
const JOB_DIR = path.join(DATA_DIR, "jobs");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

fs.mkdirSync(JOB_DIR, { recursive: true });


// ============================================================
// STATIC MIME TYPES
// ============================================================

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};


// ============================================================
// STATS
// ============================================================

async function readStats() {
  try {
    const text = await fsp.readFile(STATS_FILE, "utf8");
    const data = JSON.parse(text);

    return {
      successfulDownloads: Number(data.successfulDownloads || 0),
    };
  } catch {
    return {
      successfulDownloads: 0,
    };
  }
}

let statsQueue = Promise.resolve();

async function incrementStats() {
  const stats = await readStats();

  stats.successfulDownloads =
    Number(stats.successfulDownloads || 0) + 1;

  await fsp.mkdir(DATA_DIR, { recursive: true });

  await fsp.writeFile(
    STATS_FILE,
    JSON.stringify(stats, null, 2),
    "utf8"
  );

  return stats;
}

function recordSuccessfulDownload() {
  statsQueue = statsQueue.then(() => incrementStats());
  return statsQueue;
}


// ============================================================
// JSON RESPONSE
// ============================================================

function sendJson(res, statusCode, data) {
  if (res.headersSent) {
    return;
  }

  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(body);
}


// ============================================================
// REQUEST BODY
// ============================================================

async function readJsonBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk.toString();

    if (body.length > 100000) {
      throw new Error("Request body is too large.");
    }
  }

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON request.");
  }
}


// ============================================================
// URL VALIDATION / SSRF PROTECTION
// ============================================================

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n))
  ) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIPv6(ip) {
  const value = String(ip).toLowerCase();

  return (
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

async function validatePublicUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIPv4(hostname) ||
    isPrivateIPv6(hostname)
  ) {
    throw new Error("Private/local URLs are not allowed.");
  }

  try {
    const records = await dns.lookup(hostname, {
      all: true,
    });

    for (const record of records) {
      if (
        isPrivateIPv4(record.address) ||
        isPrivateIPv6(record.address)
      ) {
        throw new Error(
          "Private/local network targets are not allowed."
        );
      }
    }
  } catch (error) {
    if (
      error.message.includes("Private") ||
      error.message.includes("private")
    ) {
      throw error;
    }

    if (error.code === "ENOTFOUND") {
      throw new Error(
        "Could not resolve the video host."
      );
    }

    throw new Error(
      "Could not validate the video host."
    );
  }

  return url;
}


// ============================================================
// YT-DLP COMMAND
// ============================================================

function getYtDlpCommand() {
  // Explicit executable
  if (process.env.YTDLP_BIN) {
    return {
      command: process.env.YTDLP_BIN,
      prefix: [],
    };
  }

  // Windows: use Python module
  if (process.platform === "win32") {
    return {
      command: process.env.YTDLP_PYTHON || "python",
      prefix: ["-m", "yt_dlp"],
    };
  }

  // Linux/macOS
  return {
    command: "yt-dlp",
    prefix: [],
  };
}


// ============================================================
// FFMPEG
// ============================================================

function getFfmpegCommand() {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      windowsHide: true,
      shell: false,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          code,
          stdout,
          stderr,
        });
        return;
      }

      const output =
        stderr.trim() ||
        stdout.trim() ||
        `Process exited with code ${code}.`;

      reject(
        new Error(
          output.slice(-8000)
        )
      );
    });
  });
}

async function checkFfmpeg() {
  try {
    await runProcess(
      getFfmpegCommand(),
      ["-version"]
    );

    return true;
  } catch {
    return false;
  }
}


// ============================================================
// QUALITY
// ============================================================

function qualityHeight(quality) {
  const heights = {
    "16k": 8640,
    "8k": 4320,
    "4k": 2160,
    "1080p": 1080,
    "720p": 720,
  };

  return heights[quality] || null;
}


// ============================================================
// FORMAT
// ============================================================

function normalizeFormat(format) {
  if (format === "audio") {
    return "mp3";
  }

  if (
    ["original", "mp4", "webm", "mov"].includes(format)
  ) {
    return format;
  }

  if (format === "mp3") {
    return "mp3";
  }

  return "original";
}


// ============================================================
// DIRECT MEDIA
// ============================================================

function isDirectMedia(url) {
  try {
    const pathname = new URL(url).pathname;

    return /\.(mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|m4a)$/i.test(
      pathname
    );
  } catch {
    return false;
  }
}


// ============================================================
// SAFE FILENAME
// ============================================================

function safeFilename(name) {
  let value = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_{2,}/g, "_")
    .trim();

  // Remove trailing period/space for Windows compatibility
  value = value.replace(/[. ]+$/g, "");

  // Avoid Windows reserved names
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

  if (reserved.test(value)) {
    value = `_${value}`;
  }

  if (!value) {
    value = "StreamDrop_Download";
  }

  return value.slice(0, 180);
}


function getExtensionFromFilename(filename) {
  return path.extname(filename).toLowerCase();
}


function extensionForFormat(format, originalExt) {
  if (format === "mp4") return ".mp4";
  if (format === "webm") return ".webm";
  if (format === "mov") return ".mov";
  if (format === "mp3") return ".mp3";

  return originalExt || ".mp4";
}


// ============================================================
// DIRECT DOWNLOAD
// ============================================================

async function downloadDirectMedia(
  url,
  targetPath
) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    throw new Error(
      `Direct media request failed with HTTP ${response.status}.`
    );
  }

  if (!response.body) {
    throw new Error(
      "The source returned an empty response."
    );
  }

  await pipeline(
    response.body,
    fs.createWriteStream(targetPath, {
      flags: "wx",
    })
  );
}


// ============================================================
// METADATA
// ============================================================

async function getMetadata(url) {
  const ytdlp = getYtDlpCommand();

  const args = [
    ...ytdlp.prefix,
    "-j",
    "--no-playlist",
    "--no-warnings",
    url,
  ];

  const result = await runProcess(
    ytdlp.command,
    args
  );

  let data;

  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "yt-dlp returned invalid metadata."
    );
  }

  return {
    title: data.title || "Untitled Video",
    uploader: data.uploader || null,
    duration: data.duration || null,
    thumbnail: data.thumbnail || null,
    formats: Array.isArray(data.formats)
      ? data.formats.length
      : 0,
  };
}


// ============================================================
// HANDLE METADATA API
// ============================================================

async function handleMetadata(req, res) {
  let data;

  try {
    data = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, {
      success: false,
      message: error.message,
    });
  }

  const url = data.url;

  if (
    typeof url !== "string" ||
    !url.trim() ||
    url.length > 4096
  ) {
    return sendJson(res, 400, {
      success: false,
      message: "Invalid video URL.",
    });
  }

  try {
    await validatePublicUrl(url);

    const metadata = await getMetadata(url);

    return sendJson(res, 200, {
      success: true,
      ...metadata,
    });
  } catch (error) {
    console.error(
      "[METADATA ERROR]",
      error.message
    );

    return sendJson(res, 422, {
      success: false,
      message:
        "Unable to read video information: " +
        error.message.slice(0, 900),
    });
  }
}


// ============================================================
// DOWNLOAD FORMAT / YT-DLP ARGS
// ============================================================

function buildYtDlpArgs({
  url,
  quality,
  format,
  outputTemplate,
}) {
  const heightMap = {
    "16k": 8640,
    "8k": 4320,
    "4k": 2160,
    "1080p": 1080,
    "720p": 720
  };

  const height = heightMap[quality];

  let selector;

  if (format === "mp3" || format === "audio") {
    selector = "bestaudio/best";
  } else if (height) {
    selector =
      `bestvideo[height<=${height}]+bestaudio/` +
      `best[height<=${height}]`;
  } else {
    selector = "bestvideo+bestaudio/best";
  }

  const args = [
    "-f",
    selector,
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "-o",
    outputTemplate
  ];

  if (format === "mp3" || format === "audio") {
    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0"
    );
  }

  if (format === "mp4") {
    args.push(
      "--merge-output-format",
      "mp4"
    );
  }

  // URL must always be the final argument.
  args.push(String(url));

  // Prevent invalid boolean/null arguments.
  for (const arg of args) {
    if (
      arg === false ||
      arg === true ||
      arg === null ||
      arg === undefined
    ) {
      throw new Error(
        `Invalid yt-dlp argument detected: ${String(arg)}`
      );
    }
  }

  console.log("[YT-DLP ARGS]", args);

  return args;
}

function buildArgs({
  url,
  quality,
  format,
  outputTemplate,
}) {
  const height = qualityHeight(quality);

  let selector;

  if (format === "mp3") {
    selector = "bestaudio/best";
  } else if (format === "mp4") {
    if (height) {
      selector =
        `bestvideo[height<=${height}][ext=mp4]+` +
        `bestaudio[ext=m4a]/` +
        `best[height<=${height}][ext=mp4]/` +
        `best[height<=${height}]`;
    } else {
      selector =
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
    }
  } else if (format === "webm") {
    if (height) {
      selector =
        `bestvideo[height<=${height}]+bestaudio/` +
        `best[height<=${height}]`;
    } else {
      selector =
        "bestvideo+bestaudio/best";
    }
  } else {
    if (height) {
      selector =
        `bestvideo[height<=${height}]+bestaudio/` +
        `best[height<=${height}]`;
    } else {
      selector =
        "bestvideo+bestaudio/best";
    }
  }

  const args = [
    "-f",
    selector,

    "--no-playlist",
    "--newline",
    "--no-warnings",

    "--restrict-filenames",
    "false",

    "-o",
    outputTemplate,
  ];

  if (format === "mp3") {
    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0"
    );
  }

  if (format === "mp4") {
    args.push(
      "--merge-output-format",
      "mp4"
    );
  }

  if (format === "webm") {
    args.push(
      "--merge-output-format",
      "webm"
    );
  }

  args.push(url);

  return args;
}


// ============================================================
// FIND CREATED MEDIA FILE
// ============================================================

async function findOutputFile(jobDir) {
  const entries = await fsp.readdir(
    jobDir,
    { withFileTypes: true }
  );

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase();

      return (
        !lower.endsWith(".part") &&
        !lower.endsWith(".ytdl") &&
        !lower.endsWith(".temp")
      );
    });

  if (!files.length) {
    throw new Error(
      "No downloadable media file was created."
    );
  }

  // Pick the largest output file
  let bestFile = files[0];
  let bestSize = 0;

  for (const filename of files) {
    const full = path.join(
      jobDir,
      filename
    );

    const stat = await fsp.stat(full);

    if (
      stat.isFile() &&
      stat.size >= bestSize
    ) {
      bestSize = stat.size;
      bestFile = filename;
    }
  }

  return path.join(
    jobDir,
    bestFile
  );
}


// ============================================================
// CONVERT WITH FFMPEG
// ============================================================

async function convertToMov(input, output) {
  await runProcess(
    getFfmpegCommand(),
    [
      "-y",
      "-i",
      input,
      "-c",
      "copy",
      output,
    ]
  );
}


// ============================================================
// HANDLE DOWNLOAD API
// ============================================================

async function handleDownload(req, res) {
  let data;

  try {
    data = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, {
      success: false,
      message: error.message,
    });
  }

  const url = data.url;
  const quality = data.quality || "best";
  const requestedFormat =
    data.format || "original";

  const format =
    normalizeFormat(requestedFormat);

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "[DOWNLOAD] Request received"
  );
  console.log(
    "[DOWNLOAD] URL:",
    url
  );
  console.log(
    "[DOWNLOAD] Quality:",
    quality
  );
  console.log(
    "[DOWNLOAD] Format:",
    format
  );

  if (
    typeof url !== "string" ||
    !url.trim() ||
    url.length > 4096
  ) {
    return sendJson(res, 400, {
      success: false,
      message: "Invalid video URL.",
    });
  }

  const allowedQualities = [
    "best",
    "original",
    "16k",
    "8k",
    "4k",
    "1080p",
    "720p",
  ];

  if (!allowedQualities.includes(quality)) {
    return sendJson(res, 400, {
      success: false,
      message: "Invalid quality selection.",
    });
  }

  const allowedFormats = [
    "original",
    "mp4",
    "webm",
    "mov",
    "audio",
    "mp3",
  ];

  if (!allowedFormats.includes(requestedFormat)) {
    return sendJson(res, 400, {
      success: false,
      message: "Invalid format selection.",
    });
  }

  try {
    await validatePublicUrl(url);
  } catch (error) {
    console.error(
      "[DOWNLOAD] URL validation failed:",
      error.message
    );

    return sendJson(res, 400, {
      success: false,
      message: error.message,
    });
  }

  const jobId =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

  const jobDir =
    path.join(JOB_DIR, jobId);

  await fsp.mkdir(jobDir, {
    recursive: true,
  });

  try {
    // --------------------------------------------------------
    // Direct media URL
    // --------------------------------------------------------

    if (
      isDirectMedia(url) &&
      format === "original"
    ) {
      console.log(
        "[DOWNLOAD] Direct media URL detected."
      );

      const sourceUrl =
        new URL(url);

      const sourceName =
        path.basename(
          sourceUrl.pathname
        ) || "StreamDrop_Download";

      const filename =
        safeFilename(sourceName);

      const targetPath =
        path.join(
          jobDir,
          filename
        );

      await downloadDirectMedia(
        url,
        targetPath
      );
    } else {
      // ------------------------------------------------------
      // yt-dlp
      // ------------------------------------------------------

      const ytdlp =
        getYtDlpCommand();

      const outputTemplate =
        path.join(
          jobDir,
          "%(title)s.%(ext)s"
        );

      const args =
        buildYtDlpArgs({
          url,
          quality,
          format,
          outputTemplate,
        });

      console.log(
        "[DOWNLOAD] Starting yt-dlp:"
      );

      console.log(
        ytdlp.command,
        ...ytdlp.prefix,
        ...args
      );

      let result;

      try {
        result = await runProcess(
          ytdlp.command,
          [
            ...ytdlp.prefix,
            ...args,
          ],
          {
            cwd: jobDir,
          }
        );
      } catch (error) {
        console.error(
          "[DOWNLOAD] yt-dlp failed:"
        );

        console.error(
          error.message
        );

        throw new Error(
          `yt-dlp failed: ${error.message}`
        );
      }

      console.log(
        "[DOWNLOAD] yt-dlp completed successfully."
      );

      /*
       * Keep yt-dlp output available for debugging.
       */
      if (result.stdout.trim()) {
        const lastOutput =
          result.stdout
            .trim()
            .split(/\r?\n/)
            .slice(-5)
            .join("\n");

        console.log(
          "[DOWNLOAD] yt-dlp output:"
        );

        console.log(
          lastOutput
        );
      }
    }

    // --------------------------------------------------------
    // Find file
    // --------------------------------------------------------

    let outputFile =
      await findOutputFile(jobDir);

    console.log(
      "[DOWNLOAD] File created:",
      path.basename(outputFile)
    );

    // --------------------------------------------------------
    // MOV conversion
    // --------------------------------------------------------

    if (format === "mov") {
      const ffmpegAvailable =
        await checkFfmpeg();

      if (!ffmpegAvailable) {
        throw new Error(
          "FFmpeg is required for MOV conversion but was not found."
        );
      }

      const outputMov =
        path.join(
          jobDir,
          path.parse(outputFile).name +
            ".mov"
        );

      console.log(
        "[DOWNLOAD] Converting to MOV..."
      );

      await convertToMov(
        outputFile,
        outputMov
      );

      if (outputMov !== outputFile) {
        await fsp.unlink(
          outputFile
        ).catch(() => {});
      }

      outputFile =
        outputMov;
    }

    // --------------------------------------------------------
    // Final file checks
    // --------------------------------------------------------

    const stat =
      await fsp.stat(outputFile);

    if (!stat.isFile()) {
      throw new Error(
        "Generated media is not a file."
      );
    }

    if (stat.size <= 0) {
      throw new Error(
        "Generated media file is empty."
      );
    }

    // --------------------------------------------------------
    // Filename / title
    // --------------------------------------------------------

    let filename =
      safeFilename(
        path.basename(outputFile)
      );

    /*
     * Make sure extension matches requested
     * conversion format where applicable.
     */
    if (
      format === "mp4" ||
      format === "webm" ||
      format === "mov" ||
      format === "mp3"
    ) {
      const expectedExt =
        extensionForFormat(
          format,
          getExtensionFromFilename(
            filename
          )
        );

      const currentExt =
        path.extname(filename)
          .toLowerCase();

      if (
        currentExt !== expectedExt
      ) {
        filename =
          safeFilename(
            path.parse(filename)
              .name
          ) +
          expectedExt;
      }
    }

    const encodedFilename =
      encodeURIComponent(
        filename
      );

    // --------------------------------------------------------
    // MIME
    // --------------------------------------------------------

    let contentType =
      "application/octet-stream";

    if (filename.toLowerCase().endsWith(".mp4")) {
      contentType = "video/mp4";
    } else if (
      filename.toLowerCase().endsWith(".webm")
    ) {
      contentType = "video/webm";
    } else if (
      filename.toLowerCase().endsWith(".mov")
    ) {
      contentType = "video/quicktime";
    } else if (
      filename.toLowerCase().endsWith(".mp3")
    ) {
      contentType = "audio/mpeg";
    } else if (
      filename.toLowerCase().endsWith(".m4a")
    ) {
      contentType = "audio/mp4";
    }

    // --------------------------------------------------------
    // Send actual file
    // --------------------------------------------------------

    console.log(
      "[DOWNLOAD] Sending:",
      filename
    );

    res.writeHead(200, {
      "Content-Type": contentType,

      "Content-Disposition":
        `attachment; filename="${filename
          .replace(/"/g, "")}"; ` +
        `filename*=UTF-8''${encodedFilename}`,

      "Content-Length":
        stat.size,

      "Cache-Control":
        "no-store, no-cache, must-revalidate",

      "Pragma": "no-cache",

      "Access-Control-Expose-Headers":
        "Content-Disposition, Content-Length",
    });

    let completed = false;

    const fileStream =
      fs.createReadStream(
        outputFile
      );

    fileStream.on(
      "error",
      async (error) => {
        console.error(
          "[DOWNLOAD] File stream error:",
          error.message
        );

        if (!res.headersSent) {
          sendJson(res, 500, {
            success: false,
            message:
              "File streaming failed.",
          });
        }

        await fsp.rm(
          jobDir,
          {
            recursive: true,
            force: true,
          }
        );
      }
    );

    /*
     * finish means Node completed writing the
     * response to the underlying socket.
     */
    res.on(
      "finish",
      async () => {
        if (!completed) {
          completed = true;

          await recordSuccessfulDownload();

          console.log(
            "[DOWNLOAD] Successful download recorded."
          );
        }

        await fsp.rm(
          jobDir,
          {
            recursive: true,
            force: true,
          }
        );
      }
    );

    /*
     * Client disconnected early.
     */
    res.on(
      "close",
      () => {
        if (!res.writableEnded) {
          fileStream.destroy();
        }
      }
    );

    fileStream.pipe(res);

  } catch (error) {
    console.error(
      "[DOWNLOAD] ERROR:",
      error.message
    );

    await fsp.rm(
      jobDir,
      {
        recursive: true,
        force: true,
      }
    ).catch(() => {});

    let message =
      error.message ||
      "Download failed.";

    const lower =
      message.toLowerCase();

    if (
      lower.includes("drm") ||
      lower.includes("encrypted") ||
      lower.includes("protected")
    ) {
      message =
        "This source is protected/encrypted and cannot be downloaded.";
    }

    if (
      lower.includes("enoent") &&
      lower.includes("ffmpeg")
    ) {
      message =
        "FFmpeg is required for this operation but was not found.";
    }

    return sendJson(res, 422, {
      success: false,
      message:
        `Download failed: ${message}`,
    });
  }
}


// ============================================================
// STATIC FILE SERVER
// ============================================================

function serveStatic(req, res) {
  let pathname;

  try {
    pathname =
      decodeURIComponent(
        new URL(
          req.url,
          "http://localhost"
        ).pathname
      );
  } catch {
    return sendJson(res, 400, {
      success: false,
      message: "Bad URL.",
    });
  }

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    pathname = "/index.html";
  }

  const relativePath =
    pathname.replace(
      /^[/\\]+/,
      ""
    );

  const fullPath =
    path.resolve(
      ROOT,
      relativePath
    );

  const rootPath =
    path.resolve(ROOT);

  /*
   * Prevent path traversal.
   */
  if (
    fullPath !== rootPath &&
    !fullPath.startsWith(
      rootPath + path.sep
    )
  ) {
    return sendJson(res, 403, {
      success: false,
      message: "Forbidden.",
    });
  }

  fs.stat(
    fullPath,
    (error, stat) => {
      if (
        error ||
        !stat.isFile()
      ) {
        return sendJson(res, 404, {
          success: false,
          message: "Not found.",
        });
      }

      const ext =
        path.extname(fullPath)
          .toLowerCase();

      const contentType =
        MIME_TYPES[ext] ||
        "application/octet-stream";

      res.writeHead(200, {
        "Content-Type":
          contentType,
        "Cache-Control":
          "no-cache",
      });

      fs.createReadStream(
        fullPath
      ).pipe(res);
    }
  );
}


// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {
      const pathname =
        req.url.split("?")[0];

      // Health
      if (
        req.method === "GET" &&
        pathname === "/api/health"
      ) {
        return sendJson(
          res,
          200,
          {
            success: true,
            service: "StreamDrop",
            status: "ok",
          }
        );
      }

      // Stats
      if (
        req.method === "GET" &&
        pathname === "/api/stats"
      ) {
        return sendJson(
          res,
          200,
          await readStats()
        );
      }

      // Metadata
      if (
        req.method === "POST" &&
        pathname === "/api/metadata"
      ) {
        return handleMetadata(
          req,
          res
        );
      }

      // Download
      if (
        req.method === "POST" &&
        pathname === "/api/download"
      ) {
        return handleDownload(
          req,
          res
        );
      }

      // favicon
      if (
        req.method === "GET" &&
        pathname === "/favicon.ico"
      ) {
        const favicon =
          path.join(
            ROOT,
            "favicon.ico"
          );

        if (
          fs.existsSync(favicon)
        ) {
          res.writeHead(200, {
            "Content-Type":
              "image/x-icon",
          });

          return fs
            .createReadStream(favicon)
            .pipe(res);
        }

        res.writeHead(204);
        return res.end();
      }

      // Static frontend
      if (
        req.method === "GET"
      ) {
        return serveStatic(
          req,
          res
        );
      }

      return sendJson(
        res,
        405,
        {
          success: false,
          message:
            "Method not allowed.",
        }
      );
    }
  );


// ============================================================
// START
// ============================================================

server.on(
  "error",
  (error) => {
    console.error(
      "[SERVER ERROR]",
      error
    );
  }
);

server.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "          StreamDrop Server"
    );
    console.log(
      "========================================"
    );
    console.log(
      `Local:  http://localhost:${PORT}`
    );
    console.log(
      `Host:   ${HOST}`
    );
    console.log(
      "========================================"
    );
    console.log("");
  }
);


// ============================================================
// CLEAN SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `\n[SERVER] ${signal} received.`
  );

  server.close(
    async () => {
      /*
       * Don't leave old jobs behind.
       */
      await fsp.rm(
        JOB_DIR,
        {
          recursive: true,
          force: true,
        }
      ).catch(() => {});

      console.log(
        "[SERVER] Shutdown complete."
      );

      process.exit(0);
    }
  );
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);


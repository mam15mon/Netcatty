/**
 * Session Log Stream Manager - Manages real-time log write streams per session
 */

const fs = require("node:fs");
const path = require("node:path");
const { toLocalISOString, stripAnsi, terminalDataToHtml } = require("./sessionLogsBridge.cjs");

// Active log streams keyed by sessionId
const activeStreams = new Map();

// Buffer flush interval (ms)
const FLUSH_INTERVAL = 500;
// Max buffer size before immediate flush (bytes)
const MAX_BUFFER_SIZE = 64 * 1024;

/**
 * Strip ANSI/OSC sequences but keep core control chars for line buffering logic.
 */
function stripAnsiSequences(str) {
  return String(str || "")
    // OSC: ESC ] ... BEL or ESC ] ... ESC \
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    // ANSI CSI / ESC sequences
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function createEntry(sessionId, opts) {
  const {
    filePath,
    format = "txt",
    hostLabel = "unknown",
    startTime = Date.now(),
    replaceExisting = true,
    lineBuffered = false,
    discardPartialLineOnStop = false,
    sanitizeControlSequences = false,
    initialLine = "",
  } = opts;

  if (!filePath) {
    return { ok: false, error: "No log file path provided" };
  }

  if (activeStreams.has(sessionId)) {
    if (!replaceExisting) {
      return { ok: false, error: "Log stream already active" };
    }
    stopStream(sessionId);
  }

  const isHtml = format === "html";
  const writeStream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf8" });

  writeStream.on("error", (err) => {
    console.error(`[SessionLogStream] Write error for ${sessionId}:`, err.message);
    const entry = activeStreams.get(sessionId);
    if (entry) {
      entry.disabled = true;
    }
  });

  const entry = {
    writeStream,
    filePath,
    format,
    isHtml,
    hostLabel,
    startTime,
    lineBuffered,
    discardPartialLineOnStop,
    sanitizeControlSequences,
    currentLine: lineBuffered ? String(initialLine || "") : "",
    pendingCarriageReturn: false,
    buffer: "",
    flushTimer: null,
    disabled: false,
  };

  entry.flushTimer = setInterval(() => {
    flushBuffer(entry);
  }, FLUSH_INTERVAL);

  activeStreams.set(sessionId, entry);
  console.log(`[SessionLogStream] Started stream for ${sessionId} -> ${filePath}`);
  return { ok: true, filePath };
}

/**
 * Start auto-save log stream using directory + host folder convention.
 */
function startStream(sessionId, opts) {
  const { hostLabel, hostname, directory, format, startTime } = opts || {};
  if (!directory) {
    console.warn("[SessionLogStream] No directory specified, skipping");
    return { ok: false, error: "No directory specified" };
  }

  try {
    const safeHostLabel = (hostLabel || hostname || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
    const hostDir = path.join(directory, safeHostLabel);
    fs.mkdirSync(hostDir, { recursive: true });

    const date = new Date(startTime || Date.now());
    const dateStr = toLocalISOString(date);
    const isHtml = format === "html";
    const ext = isHtml ? "log.tmp" : format === "raw" ? "log" : "txt";
    const fileName = `${dateStr}.${ext}`;
    const filePath = path.join(hostDir, fileName);

    return createEntry(sessionId, {
      filePath,
      format: format || "txt",
      hostLabel: hostLabel || hostname || "unknown",
      startTime: startTime || Date.now(),
      replaceExisting: true,
    });
  } catch (err) {
    console.error(`[SessionLogStream] Failed to start stream for ${sessionId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Start manual stream to an explicit file path.
 */
function startStreamToFile(sessionId, opts) {
  const { filePath, format, hostLabel, startTime, initialLine } = opts || {};
  if (!filePath) {
    return { ok: false, error: "No file path specified" };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return createEntry(sessionId, {
      filePath,
      format: format || "raw",
      hostLabel: hostLabel || "unknown",
      startTime: startTime || Date.now(),
      replaceExisting: false,
      lineBuffered: true,
      discardPartialLineOnStop: false,
      sanitizeControlSequences: true,
      initialLine: initialLine || "",
    });
  } catch (err) {
    console.error(`[SessionLogStream] Failed to start manual stream for ${sessionId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Flush buffered data to the write stream.
 */
function flushBuffer(entry) {
  if (!entry || entry.disabled || entry.buffer.length === 0) return;

  try {
    const data = entry.buffer;
    entry.buffer = "";

    if (entry.isHtml) {
      entry.writeStream.write(data);
    } else if (entry.format === "raw") {
      entry.writeStream.write(data);
    } else {
      entry.writeStream.write(stripAnsi(data));
    }
  } catch (err) {
    console.error("[SessionLogStream] Flush error:", err.message);
    entry.disabled = true;
  }
}

function appendLineBufferedData(entry, dataChunk) {
  const source = entry.sanitizeControlSequences ? stripAnsiSequences(dataChunk) : String(dataChunk || "");
  for (const ch of source) {
    if (entry.pendingCarriageReturn) {
      if (ch === "\n") {
        entry.buffer += `${entry.currentLine}\n`;
        entry.currentLine = "";
        entry.pendingCarriageReturn = false;
        continue;
      }
      // Standalone '\r': cursor returned to line start, next chars overwrite line.
      entry.currentLine = "";
      entry.pendingCarriageReturn = false;
    }

    if (ch === "\r") {
      // Delay decision: CRLF means real newline; standalone CR means line overwrite.
      entry.pendingCarriageReturn = true;
      continue;
    }

    if (ch === "\n") {
      entry.buffer += `${entry.currentLine}\n`;
      entry.currentLine = "";
      continue;
    }

    if (ch === "\b" || ch === "\x7f") {
      if (entry.currentLine.length > 0) {
        entry.currentLine = entry.currentLine.slice(0, -1);
      }
      continue;
    }

    const code = ch.codePointAt(0) || 0;
    if (code < 32 && ch !== "\t") {
      continue;
    }

    entry.currentLine += ch;
  }
}

/**
 * Append data to session log buffer.
 */
function appendData(sessionId, dataChunk) {
  const entry = activeStreams.get(sessionId);
  if (!entry || entry.disabled) return;

  if (entry.lineBuffered) {
    appendLineBufferedData(entry, dataChunk);
  } else {
    entry.buffer += dataChunk;
  }

  if (entry.buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(entry);
  }
}

/**
 * Stop stream and finalize output.
 */
async function stopStream(sessionId) {
  const entry = activeStreams.get(sessionId);
  if (!entry) return null;
  activeStreams.delete(sessionId);

  if (entry.flushTimer) {
    clearInterval(entry.flushTimer);
    entry.flushTimer = null;
  }

  if (entry.lineBuffered) {
    if (entry.pendingCarriageReturn) {
      entry.buffer += `${entry.currentLine}\n`;
      entry.currentLine = "";
      entry.pendingCarriageReturn = false;
    }
    if (!entry.discardPartialLineOnStop && entry.currentLine.length > 0) {
      entry.buffer += `${entry.currentLine}\n`;
    }
    entry.currentLine = "";
  }

  flushBuffer(entry);

  await new Promise((resolve) => {
    entry.writeStream.end(resolve);
  });

  let finalPath = entry.filePath;

  if (entry.isHtml && !entry.disabled) {
    try {
      const rawData = await fs.promises.readFile(entry.filePath, "utf8");
      const htmlContent = terminalDataToHtml(rawData, entry.hostLabel, entry.startTime);
      const htmlPath = entry.filePath.replace(/\.log\.tmp$/, ".html");
      await fs.promises.writeFile(htmlPath, htmlContent, "utf8");
      try {
        await fs.promises.unlink(entry.filePath);
      } catch {
        // ignore
      }
      finalPath = htmlPath;
    } catch (err) {
      console.error(`[SessionLogStream] HTML conversion failed for ${sessionId}:`, err.message);
    }
  }

  console.log(`[SessionLogStream] Stopped stream for ${sessionId} -> ${finalPath}`);
  return finalPath;
}

function hasStream(sessionId) {
  return activeStreams.has(sessionId);
}

async function cleanupAll() {
  console.log(`[SessionLogStream] Cleaning up ${activeStreams.size} active streams`);
  const ids = [...activeStreams.keys()];
  await Promise.allSettled(ids.map(id => stopStream(id)));
}

module.exports = {
  startStream,
  startStreamToFile,
  appendData,
  stopStream,
  hasStream,
  cleanupAll,
};

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
    currentLineCursor: lineBuffered ? String(initialLine || "").length : 0,
    pendingEscape: "",
    pendingCarriageReturn: false,
    skipNextLFAfterCRLF: false,
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
      // Manual log should follow terminal display semantics instead of dumping raw escapes.
      lineBuffered: true,
      discardPartialLineOnStop: false,
      sanitizeControlSequences: false,
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
  const chunk = entry.sanitizeControlSequences ? stripAnsiSequences(dataChunk) : String(dataChunk || "");
  const source = `${entry.pendingEscape || ""}${chunk}`;
  entry.pendingEscape = "";
  const overwriteCharAt = (line, index, ch) => {
    if (index < 0) return line;
    if (index >= line.length) {
      return `${line}${" ".repeat(index - line.length)}${ch}`;
    }
    return `${line.slice(0, index)}${ch}${line.slice(index + 1)}`;
  };

  const removeCharAt = (line, index) => {
    if (index < 0 || index >= line.length) return line;
    return `${line.slice(0, index)}${line.slice(index + 1)}`;
  };

  const clampCursor = () => {
    if (!Number.isFinite(entry.currentLineCursor)) {
      entry.currentLineCursor = entry.currentLine.length;
      return;
    }
    if (entry.currentLineCursor < 0) entry.currentLineCursor = 0;
    if (entry.currentLineCursor > entry.currentLine.length) {
      entry.currentLineCursor = entry.currentLine.length;
    }
  };

  const applyCsi = (params, final) => {
    const rawParts = params === "" ? [] : params.split(";");
    const toNum = (value, fallback) => {
      const parsed = Number.parseInt(value || "", 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    switch (final) {
      case "D": { // Cursor Back
        const count = Math.max(1, toNum(rawParts[0], 1));
        entry.currentLineCursor = Math.max(0, entry.currentLineCursor - count);
        break;
      }
      case "C": { // Cursor Forward
        const count = Math.max(1, toNum(rawParts[0], 1));
        entry.currentLineCursor = Math.min(entry.currentLine.length, entry.currentLineCursor + count);
        break;
      }
      case "G": { // Cursor Horizontal Absolute
        const col = Math.max(1, toNum(rawParts[0], 1));
        entry.currentLineCursor = Math.min(entry.currentLine.length, col - 1);
        break;
      }
      case "K": { // Erase in Line
        const mode = toNum(rawParts[0], 0);
        clampCursor();
        if (mode === 0) {
          entry.currentLine = entry.currentLine.slice(0, entry.currentLineCursor);
        } else if (mode === 1) {
          entry.currentLine = entry.currentLine.slice(entry.currentLineCursor);
          entry.currentLineCursor = 0;
        } else if (mode === 2) {
          entry.currentLine = "";
          entry.currentLineCursor = 0;
        }
        break;
      }
      case "P": { // Delete Character(s)
        const count = Math.max(1, toNum(rawParts[0], 1));
        clampCursor();
        for (let i = 0; i < count; i += 1) {
          entry.currentLine = removeCharAt(entry.currentLine, entry.currentLineCursor);
        }
        break;
      }
      case "@": { // Insert Character(s)
        const count = Math.max(1, toNum(rawParts[0], 1));
        clampCursor();
        entry.currentLine = `${entry.currentLine.slice(0, entry.currentLineCursor)}${" ".repeat(count)}${entry.currentLine.slice(entry.currentLineCursor)}`;
        break;
      }
      case "J": { // Erase in Display (line-mode fallback: clear to EOL)
        clampCursor();
        entry.currentLine = entry.currentLine.slice(0, entry.currentLineCursor);
        break;
      }
      default:
        // Ignore unsupported sequences.
        break;
    }
    clampCursor();
  };

  const consumeEscape = (input, startIndex) => {
    const next = input[startIndex + 1];
    if (!next) {
      entry.pendingEscape = input.slice(startIndex);
      return input.length - 1;
    }

    // OSC: ESC ] ... BEL or ESC ] ... ESC \
    if (next === "]") {
      let cursor = startIndex + 2;
      while (cursor < input.length) {
        if (input[cursor] === "\x07") return cursor;
        if (input[cursor] === "\x1b" && input[cursor + 1] === "\\") return cursor + 1;
        cursor += 1;
      }
      entry.pendingEscape = input.slice(startIndex);
      return input.length - 1;
    }

    // CSI: ESC [ ... final-byte
    if (next === "[") {
      let cursor = startIndex + 2;
      let params = "";
      while (cursor < input.length) {
        const ch = input[cursor];
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          applyCsi(params, ch);
          return cursor;
        }
        params += ch;
        cursor += 1;
      }
      entry.pendingEscape = input.slice(startIndex);
      return input.length - 1;
    }

    // Other ESC forms: skip ESC + next byte.
    return startIndex + 1;
  };

  for (let idx = 0; idx < source.length; idx += 1) {
    const ch = source[idx];

    if (ch === "\x1b") {
      idx = consumeEscape(source, idx);
      continue;
    }

    if (entry.pendingCarriageReturn) {
      if (ch === "\r") {
        // Collapse repeated CR (e.g. CRCRLF) into a single pending newline.
        continue;
      }
      if (ch === "\n") {
        entry.buffer += `${entry.currentLine}\n`;
        entry.currentLine = "";
        entry.currentLineCursor = 0;
        entry.pendingCarriageReturn = false;
        entry.skipNextLFAfterCRLF = true;
        continue;
      }
      if (entry.currentLine.length > 0) {
        entry.buffer += `${entry.currentLine}\n`;
      }
      entry.currentLine = "";
      entry.currentLineCursor = 0;
      entry.pendingCarriageReturn = false;
      entry.skipNextLFAfterCRLF = false;
    }

    if (ch === "\r") {
      entry.pendingCarriageReturn = true;
      continue;
    }

    if (ch === "\n") {
      // Some devices emit CRLF + LF; drop the extra LF only once.
      if (entry.currentLine.length === 0 && entry.skipNextLFAfterCRLF) {
        entry.skipNextLFAfterCRLF = false;
        continue;
      }
      entry.buffer += `${entry.currentLine}\n`;
      entry.currentLine = "";
      entry.currentLineCursor = 0;
      entry.skipNextLFAfterCRLF = false;
      continue;
    }

    if (ch === "\b") {
      if (entry.currentLineCursor > 0) {
        entry.currentLineCursor -= 1;
      }
      continue;
    }

    if (ch === "\x7f") {
      if (entry.currentLineCursor > 0) {
        entry.currentLineCursor -= 1;
        entry.currentLine = removeCharAt(entry.currentLine, entry.currentLineCursor);
      }
      continue;
    }

    const code = ch.codePointAt(0) || 0;
    if (code < 32 && ch !== "\t") {
      continue;
    }

    entry.skipNextLFAfterCRLF = false;
    clampCursor();
    entry.currentLine = overwriteCharAt(entry.currentLine, entry.currentLineCursor, ch);
    entry.currentLineCursor += 1;
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
    if (entry.pendingEscape) {
      entry.pendingEscape = "";
    }
    if (entry.pendingCarriageReturn) {
      entry.buffer += `${entry.currentLine}\n`;
      entry.currentLine = "";
      entry.currentLineCursor = 0;
      entry.pendingCarriageReturn = false;
    }
    entry.skipNextLFAfterCRLF = false;
    if (!entry.discardPartialLineOnStop && entry.currentLine.length > 0) {
      entry.buffer += `${entry.currentLine}\n`;
    }
    entry.currentLine = "";
    entry.currentLineCursor = 0;
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

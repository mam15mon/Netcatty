
import { Terminal as XTerm, IDecoration, IDisposable, IMarker, IBufferLine } from "@xterm/xterm";
import { KeywordHighlightRule } from "../../types";

import { XTERM_PERFORMANCE_CONFIG } from "../../infrastructure/config/xtermPerformance";
import { forEachNonEmptyRegexMatch } from "./keywordHighlightRegex";

/** Pre-compiled rule with regex ready for matching */
interface CompiledRule {
  regex: RegExp;
  color: string;
}

interface CachedDecorationRange {
  x: number;
  width: number;
  color: string;
}

interface DirtyLineSegment {
  start: number;
  end: number;
}

interface LineDecorationState {
  marker: IMarker;
  decorations: IDecoration[];
  signature: string;
}

type RefreshReason = "scroll" | "write" | "full";

interface BufferSnapshot {
  length: number;
  baseY: number;
  viewportY: number;
  cursorAbsoluteY: number;
}

/** Shared empty array for non-matching lines to avoid per-call allocations. */
const EMPTY_RANGES: readonly CachedDecorationRange[] = Object.freeze([]);

/** ASCII-only test — when true, string indices equal cell columns. */
// eslint-disable-next-line no-control-regex
const RE_ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Manages terminal decorations for keyword highlighting.
 * Uses xterm.js Decoration API to overlay styles without modifying the data stream.
 * This ensures zero impact on scrolling performance ("lazy" highlighting).
 */
export class KeywordHighlighter implements IDisposable {
  private term: XTerm;
  private compiledRules: CompiledRule[] = [];
  private lineDecorations = new Map<number, LineDecorationState>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private animationFrameId: number | null = null;
  private lastRefreshTime: number = 0;
  private matchCache = new Map<string, CachedDecorationRange[]>();
  private enabled: boolean = false;
  private disposables: IDisposable[] = [];
  private lastViewportY: number = -1;
  private lastViewportRange: { start: number; end: number } | null = null;
  private lastRenderRange: { start: number; end: number } | null = null;
  private pendingRefreshReason: RefreshReason = "scroll";
  private dirtySegments: DirtyLineSegment[] = [];
  private dirtyLineCount = 0;
  private dirtyAllInRenderRange = false;
  private lastBufferSnapshot: BufferSnapshot | null = null;
  private recentWriteBurst = 0;
  private lastWriteAt = 0;
  private lastBurstDecayAt = 0;
  private static readonly DIRTY_SCAN_PADDING = XTERM_PERFORMANCE_CONFIG.highlighting.dirtyScanPadding;
  private static readonly WRITE_BURST_INTERVAL_MS = 28;
  private static readonly WRITE_BURST_DECAY_MS = 80;
  private static readonly WRITE_BURST_THRESHOLD = 6;
  private static readonly WRITE_BURST_OVERSCAN_SCALE = 0.35;
  private static readonly WRITE_BURST_BUDGET_SCALE = 0.5;
  private static readonly WRITE_BURST_CHUNK_SCALE = 0.5;
  private static readonly WRITE_BURST_DEBOUNCE_MS = 140;
  private static readonly WRITE_BURST_IMMEDIATE_MIN_INTERVAL_MS = 32;
  private static readonly WRITE_BURST_HIGHLIGHT_PAUSE_MS = 180;

  constructor(term: XTerm) {
    this.term = term;

    // Hook into terminal events to trigger highlighting
    this.disposables.push(
      // When user scrolls, refresh visible area
      this.term.onScroll(() => {
        this.triggerRefresh("immediate", "scroll");
      }),
      // When new data is written, refresh on the next frame so highlights land
      // with the freshly rendered content instead of trailing behind it.
      this.term.onWriteParsed(() => {
        this.markDirtyFromWrite();
        this.triggerRefresh("immediate", "write");
      }),
      // Also refresh on resize as viewport content changes
      this.term.onResize(() => this.triggerRefresh("debounced", "full")),
      // onRender fires after each render cycle - catch scrolls that onScroll might miss
      this.term.onRender(() => {
        // Only trigger refresh if viewport position changed
        const currentViewportY = this.term.buffer.active?.viewportY ?? 0;
        if (currentViewportY !== this.lastViewportY) {
          this.lastViewportY = currentViewportY;
          this.triggerRefresh("immediate", "scroll");
        }
      })
    );
    this.lastBufferSnapshot = this.readBufferSnapshot();
  }

  public setRules(rules: KeywordHighlightRule[], enabled: boolean) {
    this.enabled = enabled;
    this.matchCache.clear();

    // Pre-compile all patterns into regexes for better performance
    // This avoids creating new RegExp objects on every viewport refresh
    this.compiledRules = [];
    for (const rule of rules) {
      if (!rule.enabled || rule.patterns.length === 0) continue;
      for (const pattern of rule.patterns) {
        try {
          this.compiledRules.push({
            regex: new RegExp(pattern, "gi"),
            color: rule.color,
          });
        } catch (err) {
          console.error("Invalid regex pattern:", pattern, err);
        }
      }
    }

    // Clear existing and force an immediate refresh if enabling
    this.clearDecorations();
    if (this.enabled && this.compiledRules.length > 0) {
      this.triggerRefresh("immediate", "full");
    }
  }

  public dispose() {
    this.clearDecorations();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.matchCache.clear();
  }

  /** Shared refresh execution for both rAF and timer callbacks. */
  private executeRefresh() {
    // Cancel any stale rAF that will never fire (e.g. hidden tab)
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Re-check state: may have changed since the refresh was scheduled
    if (!this.enabled || this.compiledRules.length === 0) return;
    if (this.term.buffer.active.type === 'alternate') {
      if (this.lineDecorations.size > 0) this.clearDecorations();
      return;
    }
    this.lastRefreshTime = performance.now();
    const reason = this.pendingRefreshReason;
    this.pendingRefreshReason = "scroll";
    this.refreshViewport(reason);
    this.lastBufferSnapshot = this.readBufferSnapshot();
  }

  private clearDecorations() {
    for (const [lineY, state] of this.lineDecorations) {
      this.disposeLineDecorations(lineY, state);
    }
    this.lineDecorations.clear();
    this.lastViewportRange = null;
    this.lastRenderRange = null;
    this.clearDirtySegments();
    this.dirtyAllInRenderRange = false;
  }

  private disposeLineDecorations(lineY: number, state?: LineDecorationState) {
    const target = state ?? this.lineDecorations.get(lineY);
    if (!target) return;
    target.decorations.forEach((decoration) => decoration.dispose());
    target.marker.dispose();
    this.lineDecorations.delete(lineY);
  }

  private buildRangesSignature(ranges: readonly CachedDecorationRange[]): string {
    if (ranges.length === 0) return "";
    let signature = "";
    for (const range of ranges) {
      signature += `${range.x}:${range.width}:${range.color};`;
    }
    return signature;
  }

  private applyLineDecorations(
    lineY: number,
    ranges: readonly CachedDecorationRange[],
    signature: string,
    cursorAbsoluteY: number,
  ) {
    const offset = lineY - cursorAbsoluteY;
    const marker = this.term.registerMarker(offset);
    if (!marker) {
      this.lineDecorations.delete(lineY);
      return;
    }

    const decorations: IDecoration[] = [];
    for (const range of ranges) {
      const decoration = this.term.registerDecoration({
        marker,
        x: range.x,
        width: range.width,
        foregroundColor: range.color,
      });
      if (decoration) {
        decorations.push(decoration);
      }
    }

    if (decorations.length === 0) {
      marker.dispose();
      this.lineDecorations.delete(lineY);
      return;
    }

    this.lineDecorations.set(lineY, {
      marker,
      decorations,
      signature,
    });
  }

  /**
   * Build a mapping from string character index to terminal cell column.
   * This handles wide characters (CJK, emoji) and combining characters correctly.
   *
   * For example, with "A中B":
   * - String indices: 0='A', 1='中', 2='B'
   * - Cell columns:   0='A', 1='中'(width 2), 3='B'
   * - Result map: [0, 1, 3, 4] (includes end position)
   */
  private buildStringToCellMap(line: IBufferLine): number[] {
    const map: number[] = [];
    let cellCol = 0;

    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell) break;

      const chars = cell.getChars();
      const width = cell.getWidth();

      // Skip continuation cells (width 0) - these are the 2nd cell of wide characters
      if (width === 0) continue;

      if (chars.length > 0) {
        // Map each character in this cell to the current cell column
        for (let i = 0; i < chars.length; i++) {
          map.push(cellCol);
        }
      } else {
        // Empty cell (codepoint 0) — translateToString() outputs a space
        // for it, so we must push one entry to keep the map aligned.
        map.push(cellCol);
      }

      cellCol += width;
    }

    // Add final position for calculating end column of matches
    map.push(cellCol);

    return map;
  }

  private triggerRefresh(mode: "immediate" | "debounced" | "continuation", reason: RefreshReason = "full") {
    if (!this.enabled || this.compiledRules.length === 0) return;
    this.pendingRefreshReason = this.mergeRefreshReason(this.pendingRefreshReason, reason);

    // Optimization: Disable highlighting in Alternate Buffer (e.g. Vim, Htop)
    // These apps manage their own highlighting and have rapid repaints.
    if (this.term.buffer.active.type === 'alternate') {
      if (this.lineDecorations.size > 0) {
        this.clearDecorations();
      }
      return;
    }

    const now = performance.now();
    if (this.shouldDeferRefreshForWriteBurst(mode, reason, now)) {
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      const delay = this.getWriteBurstDeferDelay(now);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.executeRefresh();
      }, delay);
      return;
    }

    if (mode === "continuation") {
      if (this.animationFrameId !== null) {
        return;
      }
      this.animationFrameId = requestAnimationFrame(() => {
        this.animationFrameId = null;
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        this.executeRefresh();
      });
      return;
    }

    if (mode === "immediate") {
      // Throttle: skip if a rAF is already pending.
      // Don't clear the debounce timer here — in a hidden tab rAF never
      // fires, so the fallback timer is the only path that will run.
      if (this.animationFrameId !== null) {
        return;
      }
      const now = performance.now();
      const minInterval = this.getAdaptiveHighlightingProfile(now).immediateMinIntervalMs;
      if (reason !== "scroll" && now - this.lastRefreshTime < minInterval) {
        // Too soon — fall through to debounced path instead of dropping
        this.triggerRefresh("debounced", reason);
        return;
      }
      this.animationFrameId = requestAnimationFrame(() => {
        this.animationFrameId = null;
        // rAF fired — cancel the fallback timer to avoid a redundant refresh
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        this.executeRefresh();
      });
      // Arm a debounced fallback: rAF does not fire in background/hidden
      // tabs (Chromium throttles it), so the timer ensures highlights
      // still update for ongoing output.  If rAF fires first it cancels
      // this timer (see above), preventing a double refresh.
      if (!this.debounceTimer) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.executeRefresh();
        }, this.getAdaptiveHighlightingProfile().debounceMs);
      }
      return;
    }

    if (this.animationFrameId !== null) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const delay = this.getAdaptiveHighlightingProfile().debounceMs;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeRefresh();
    }, delay);
  }

  private refreshViewport(reason: RefreshReason) {
    // Safety check just in case
    if (!this.term?.buffer?.active) return;
    this.reindexLineDecorationsFromMarkers();

    const buffer = this.term.buffer.active;
    const viewportY = buffer.viewportY;
    const rows = this.term.rows;
    const cursorY = buffer.cursorY;
    const baseY = buffer.baseY;
    const cursorAbsoluteY = baseY + cursorY;
    const overscan = this.getOverscanLines(reason);
    const viewportStart = viewportY;
    const viewportEnd = viewportY + rows - 1;
    const rangeStart = Math.max(0, viewportY - overscan);
    const rangeEnd = viewportEnd + overscan;

    const previousRange = this.lastRenderRange;
    const previousViewportRange = this.lastViewportRange;

    if (reason === "write") {
      this.processDirtyLinesInRange(rangeStart, rangeEnd, cursorAbsoluteY, "write");
    } else if (reason === "scroll") {
      const shouldIncrementalViewport =
        previousViewportRange !== null &&
        this.lineDecorations.size > 0 &&
        viewportStart <= previousViewportRange.end &&
        viewportEnd >= previousViewportRange.start;
      if (!shouldIncrementalViewport) {
        this.processLineRange(viewportStart, viewportEnd, cursorAbsoluteY);
      } else {
        if (viewportStart < previousViewportRange.start) {
          this.processLineRange(viewportStart, Math.min(viewportEnd, previousViewportRange.start - 1), cursorAbsoluteY);
        }
        if (viewportEnd > previousViewportRange.end) {
          this.processLineRange(Math.max(viewportStart, previousViewportRange.end + 1), viewportEnd, cursorAbsoluteY);
        }
      }
      if (rangeStart < viewportStart) {
        this.addDirtyRange(rangeStart, viewportStart - 1);
      }
      if (rangeEnd > viewportEnd) {
        this.addDirtyRange(viewportEnd + 1, rangeEnd);
      }
      this.processDirtyLinesInRange(rangeStart, rangeEnd, cursorAbsoluteY, "scroll");
    } else if (previousRange !== null && this.lineDecorations.size > 0) {
      if (rangeStart < previousRange.start) {
        this.processLineRange(rangeStart, Math.min(rangeEnd, previousRange.start - 1), cursorAbsoluteY);
      }
      if (rangeEnd > previousRange.end) {
        this.processLineRange(Math.max(rangeStart, previousRange.end + 1), rangeEnd, cursorAbsoluteY);
      }
    } else {
      this.processLineRange(rangeStart, rangeEnd, cursorAbsoluteY);
    }

    for (const [lineY, state] of this.lineDecorations) {
      if (lineY < rangeStart || lineY > rangeEnd || state.marker.isDisposed) {
        this.disposeLineDecorations(lineY, state);
      }
    }

    this.lastViewportRange = { start: viewportStart, end: viewportEnd };
    this.lastRenderRange = { start: rangeStart, end: rangeEnd };
  }

  private reindexLineDecorationsFromMarkers() {
    if (this.lineDecorations.size === 0) return;
    const entries = Array.from(this.lineDecorations.entries());
    for (const [lineY, state] of entries) {
      if (state.marker.isDisposed || state.marker.line < 0) {
        this.disposeLineDecorations(lineY, state);
        continue;
      }
      const markerLine = state.marker.line;
      if (markerLine === lineY) continue;
      this.lineDecorations.delete(lineY);
      const existing = this.lineDecorations.get(markerLine);
      if (existing && existing !== state) {
        this.disposeLineDecorations(markerLine, existing);
      }
      this.lineDecorations.set(markerLine, state);
    }
  }

  private processDirtyLinesInRange(
    rangeStart: number,
    rangeEnd: number,
    cursorAbsoluteY: number,
    continuationReason: RefreshReason
  ) {
    if (this.dirtyAllInRenderRange) {
      this.processLineRange(rangeStart, rangeEnd, cursorAbsoluteY);
      this.dirtyAllInRenderRange = false;
      this.clearDirtySegments();
      return;
    }

    if (this.dirtySegments.length === 0) {
      return;
    }

    const dirtyInRange: DirtyLineSegment[] = [];
    for (const segment of this.dirtySegments) {
      if (segment.end < rangeStart) continue;
      if (segment.start > rangeEnd) break;
      dirtyInRange.push({
        start: Math.max(segment.start, rangeStart),
        end: Math.min(segment.end, rangeEnd),
      });
    }

    if (dirtyInRange.length === 0) {
      return;
    }

    const { writeRefreshBudgetMs, dirtySegmentChunkSize } = this.getAdaptiveHighlightingProfile();
    const segmentChunkSize = Math.max(1, dirtySegmentChunkSize);
    const startTime = performance.now();

    for (const segment of dirtyInRange) {
      let chunkStart = segment.start;
      while (chunkStart <= segment.end) {
        const chunkEnd = Math.min(segment.end, chunkStart + segmentChunkSize - 1);
        this.processLineRange(chunkStart, chunkEnd, cursorAbsoluteY);
        this.removeDirtyRange(chunkStart, chunkEnd);
        chunkStart = chunkEnd + 1;

        if (chunkStart <= segment.end && performance.now() - startTime >= writeRefreshBudgetMs) {
          this.triggerRefresh("continuation", continuationReason);
          return;
        }
      }
      if (performance.now() - startTime >= writeRefreshBudgetMs) {
        this.triggerRefresh("continuation", continuationReason);
        return;
      }
    }
  }

  private mergeRefreshReason(current: RefreshReason, next: RefreshReason): RefreshReason {
    const weight: Record<RefreshReason, number> = { scroll: 0, write: 1, full: 2 };
    return weight[next] > weight[current] ? next : current;
  }

  private readBufferSnapshot(): BufferSnapshot | null {
    const buffer = this.term?.buffer?.active;
    if (!buffer) return null;
    return {
      length: buffer.length,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorAbsoluteY: buffer.baseY + buffer.cursorY,
    };
  }

  private markVisibleRangeDirty() {
    this.dirtyAllInRenderRange = true;
    this.clearDirtySegments();
  }

  private clearDirtySegments() {
    this.dirtySegments = [];
    this.dirtyLineCount = 0;
  }

  private rebuildDirtyLineCount() {
    let total = 0;
    for (const segment of this.dirtySegments) {
      total += segment.end - segment.start + 1;
    }
    this.dirtyLineCount = total;
  }

  private removeDirtyRange(start: number, end: number) {
    if (end < start || this.dirtySegments.length === 0) return;
    const next: DirtyLineSegment[] = [];

    for (const segment of this.dirtySegments) {
      if (segment.end < start || segment.start > end) {
        next.push(segment);
        continue;
      }
      if (segment.start < start) {
        next.push({ start: segment.start, end: start - 1 });
      }
      if (segment.end > end) {
        next.push({ start: end + 1, end: segment.end });
      }
    }

    this.dirtySegments = next;
    this.rebuildDirtyLineCount();
  }

  private addDirtyRange(start: number, end: number) {
    if (this.dirtyAllInRenderRange) return;
    if (end < start) return;
    const maxDirtyLines = this.getMaxDirtyLines();
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.max(clampedStart, end);
    const rangeSize = clampedEnd - clampedStart + 1;
    if (rangeSize > maxDirtyLines) {
      this.markVisibleRangeDirty();
      return;
    }
    const merged: DirtyLineSegment[] = [];
    let mergeStart = clampedStart;
    let mergeEnd = clampedEnd;
    let inserted = false;

    for (const segment of this.dirtySegments) {
      if (segment.end + 1 < mergeStart) {
        merged.push(segment);
        continue;
      }
      if (mergeEnd + 1 < segment.start) {
        if (!inserted) {
          merged.push({ start: mergeStart, end: mergeEnd });
          inserted = true;
        }
        merged.push(segment);
        continue;
      }
      mergeStart = Math.min(mergeStart, segment.start);
      mergeEnd = Math.max(mergeEnd, segment.end);
    }

    if (!inserted) {
      merged.push({ start: mergeStart, end: mergeEnd });
    }

    this.dirtySegments = merged;
    this.rebuildDirtyLineCount();
    if (this.dirtyLineCount > maxDirtyLines) {
      this.markVisibleRangeDirty();
    }
  }

  private getMaxDirtyLines(): number {
    const rows = Math.max(1, this.term.rows);
    const perViewportRow = XTERM_PERFORMANCE_CONFIG.highlighting.dirtyLinesPerViewportRow;
    const minDirtyLines = XTERM_PERFORMANCE_CONFIG.highlighting.minDirtyLines;
    const maxDirtyLines = XTERM_PERFORMANCE_CONFIG.highlighting.maxDirtyLines;
    const dynamicDirtyLines = Math.round(rows * perViewportRow);
    return Math.min(maxDirtyLines, Math.max(minDirtyLines, dynamicDirtyLines));
  }

  private markDirtyFromWrite() {
    this.updateWriteBurst();
    const snapshot = this.readBufferSnapshot();
    if (!snapshot) {
      this.markVisibleRangeDirty();
      return;
    }

    if (!this.enabled || this.compiledRules.length === 0) {
      this.lastBufferSnapshot = snapshot;
      return;
    }

    const prev = this.lastBufferSnapshot;
    this.lastBufferSnapshot = snapshot;

    if (!prev) {
      this.markVisibleRangeDirty();
      return;
    }

    if (snapshot.length < prev.length || snapshot.baseY < prev.baseY) {
      this.markVisibleRangeDirty();
      return;
    }

    const rows = this.term.rows;
    const padding = KeywordHighlighter.DIRTY_SCAN_PADDING;
    const cursorSpan = Math.abs(snapshot.cursorAbsoluteY - prev.cursorAbsoluteY);
    const baseSpan = Math.abs(snapshot.baseY - prev.baseY);
    const largeDeltaThreshold = rows * 4;

    if (cursorSpan > largeDeltaThreshold || baseSpan > largeDeltaThreshold) {
      this.markVisibleRangeDirty();
      return;
    }

    const cursorStart = Math.min(prev.cursorAbsoluteY, snapshot.cursorAbsoluteY) - padding;
    const cursorEnd = Math.max(prev.cursorAbsoluteY, snapshot.cursorAbsoluteY) + padding;
    this.addDirtyRange(cursorStart, cursorEnd);

    if (snapshot.viewportY !== prev.viewportY) {
      const prevViewportEnd = prev.viewportY + rows - 1;
      const currViewportEnd = snapshot.viewportY + rows - 1;
      if (snapshot.viewportY > prev.viewportY) {
        this.addDirtyRange(prevViewportEnd + 1 - padding, currViewportEnd + padding);
      } else {
        this.addDirtyRange(snapshot.viewportY - padding, prev.viewportY - 1 + padding);
      }
    }
  }

  private decayWriteBurst(now: number) {
    if (this.lastBurstDecayAt === 0) {
      this.lastBurstDecayAt = now;
      return;
    }
    const elapsed = now - this.lastBurstDecayAt;
    if (elapsed < KeywordHighlighter.WRITE_BURST_DECAY_MS) return;
    const steps = Math.floor(elapsed / KeywordHighlighter.WRITE_BURST_DECAY_MS);
    if (steps <= 0) return;
    this.recentWriteBurst = Math.max(0, this.recentWriteBurst - steps);
    this.lastBurstDecayAt += steps * KeywordHighlighter.WRITE_BURST_DECAY_MS;
  }

  private updateWriteBurst() {
    const now = performance.now();
    this.decayWriteBurst(now);
    if (this.lastWriteAt === 0) {
      this.recentWriteBurst = 1;
      this.lastWriteAt = now;
      this.lastBurstDecayAt = now;
      return;
    }

    const interval = now - this.lastWriteAt;
    if (interval <= KeywordHighlighter.WRITE_BURST_INTERVAL_MS) {
      this.recentWriteBurst = Math.min(64, this.recentWriteBurst + 1);
    } else {
      this.recentWriteBurst = Math.max(1, this.recentWriteBurst - 1);
    }
    this.lastWriteAt = now;
    this.lastBurstDecayAt = now;
  }

  private isWriteBurstActive(now: number): boolean {
    this.decayWriteBurst(now);
    if (this.recentWriteBurst < KeywordHighlighter.WRITE_BURST_THRESHOLD) {
      return false;
    }
    return now - this.lastWriteAt <= KeywordHighlighter.WRITE_BURST_DECAY_MS * 2;
  }

  private getAdaptiveHighlightingProfile(now = performance.now()) {
    const config = XTERM_PERFORMANCE_CONFIG.highlighting;
    if (!this.isWriteBurstActive(now)) {
      return {
        overscanLines: config.overscanLines,
        writeRefreshBudgetMs: config.writeRefreshBudgetMs,
        dirtySegmentChunkSize: config.dirtySegmentChunkSize,
        debounceMs: config.debounceMs,
        immediateMinIntervalMs: config.immediateMinIntervalMs,
      };
    }

    return {
      overscanLines: Math.max(8, Math.round(config.overscanLines * KeywordHighlighter.WRITE_BURST_OVERSCAN_SCALE)),
      writeRefreshBudgetMs: Math.max(1, config.writeRefreshBudgetMs * KeywordHighlighter.WRITE_BURST_BUDGET_SCALE),
      dirtySegmentChunkSize: Math.max(8, Math.round(config.dirtySegmentChunkSize * KeywordHighlighter.WRITE_BURST_CHUNK_SCALE)),
      debounceMs: Math.max(config.debounceMs, KeywordHighlighter.WRITE_BURST_DEBOUNCE_MS),
      immediateMinIntervalMs: Math.max(
        config.immediateMinIntervalMs,
        KeywordHighlighter.WRITE_BURST_IMMEDIATE_MIN_INTERVAL_MS
      ),
    };
  }

  private shouldDeferRefreshForWriteBurst(
    mode: "immediate" | "debounced" | "continuation",
    reason: RefreshReason,
    now: number
  ): boolean {
    if (mode !== "immediate") return false;
    if (!this.isWriteBurstActive(now)) return false;
    return reason === "write";
  }

  private getOverscanLines(reason: RefreshReason): number {
    if (reason === "write") {
      return this.getAdaptiveHighlightingProfile().overscanLines;
    }
    return XTERM_PERFORMANCE_CONFIG.highlighting.overscanLines;
  }

  private getWriteBurstDeferDelay(now: number): number {
    const quietWindow = Math.max(
      KeywordHighlighter.WRITE_BURST_HIGHLIGHT_PAUSE_MS,
      this.getAdaptiveHighlightingProfile(now).debounceMs
    );
    if (this.lastWriteAt <= 0) {
      return quietWindow;
    }
    const elapsedSinceWrite = now - this.lastWriteAt;
    return Math.max(16, quietWindow - elapsedSinceWrite);
  }

  private processLineRange(start: number, end: number, cursorAbsoluteY: number) {
    if (end < start) return;
    const buffer = this.term.buffer.active;
    for (let lineY = start; lineY <= end; lineY++) {
      const line = buffer.getLine(lineY);
      if (!line) {
        this.disposeLineDecorations(lineY);
        continue;
      }

      const lineText = line.translateToString(true); // true = trim right whitespace
      if (!lineText) {
        this.disposeLineDecorations(lineY);
        continue;
      }

      const cachedRanges = this.getCachedRanges(line, lineText);
      if (cachedRanges.length === 0) {
        this.disposeLineDecorations(lineY);
        continue;
      }

      const signature = this.buildRangesSignature(cachedRanges);
      const existing = this.lineDecorations.get(lineY);
      if (
        existing &&
        !existing.marker.isDisposed &&
        existing.marker.line === lineY &&
        existing.signature === signature
      ) {
        continue;
      }

      this.disposeLineDecorations(lineY, existing);
      this.applyLineDecorations(lineY, cachedRanges, signature, cursorAbsoluteY);
    }
  }

  private getCachedRanges(line: IBufferLine, lineText: string): CachedDecorationRange[] {
    const cached = this.matchCache.get(lineText);
    if (cached) {
      // LRU: move to end
      this.matchCache.delete(lineText);
      this.matchCache.set(lineText, cached);
      return cached;
    }

    const ranges = this.scanLine(line, lineText);
    this.matchCache.set(lineText, ranges);

    const maxEntries = XTERM_PERFORMANCE_CONFIG.highlighting.cacheEntries;
    if (this.matchCache.size > maxEntries) {
      const oldestKey = this.matchCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.matchCache.delete(oldestKey);
      }
    }

    return ranges;
  }

  private scanLine(line: IBufferLine, lineText: string): CachedDecorationRange[] {
    // ASCII-only lines have a 1:1 string-index-to-cell-column mapping,
    // so we can skip the expensive buildStringToCellMap call entirely.
    const asciiOnly = RE_ASCII_ONLY.test(lineText);
    let cellMap: number[] | null = null;
    let ranges: CachedDecorationRange[] | null = null;

    // Process each pre-compiled rule
    for (const { regex, color } of this.compiledRules) {
      forEachNonEmptyRegexMatch(regex, lineText, (match) => {
        const strStart = match.index;
        const strEnd = strStart + match[0].length;

        let cellStartCol: number;
        let cellEndCol: number;

        if (asciiOnly) {
          cellStartCol = strStart;
          cellEndCol = strEnd;
        } else {
          // Lazily build cellMap only when a match is found
          if (cellMap === null) {
            cellMap = this.buildStringToCellMap(line);
          }
          cellStartCol = cellMap[strStart] ?? strStart;
          cellEndCol = cellMap[strEnd] ?? strEnd;
        }

        const cellWidth = cellEndCol - cellStartCol;

        // Skip if width is 0 or negative (shouldn't happen, but be safe)
        if (cellWidth <= 0) return;

        if (ranges === null) {
          ranges = [];
        }
        ranges.push({
          x: cellStartCol,
          width: cellWidth,
          color,
        });
      });
    }

    if (!ranges || ranges.length === 0) {
      return EMPTY_RANGES as CachedDecorationRange[];
    }
    if (ranges.length === 1) {
      return ranges;
    }
    return this.mergeDecorationRanges(ranges);
  }

  private mergeDecorationRanges(ranges: CachedDecorationRange[]): CachedDecorationRange[] {
    const merged: CachedDecorationRange[] = [ranges[0]];

    for (let index = 1; index < ranges.length; index += 1) {
      const current = ranges[index];
      const previous = merged[merged.length - 1];
      if (
        current.color === previous.color &&
        current.x >= previous.x &&
        current.x <= previous.x + previous.width
      ) {
        const mergedEnd = Math.max(previous.x + previous.width, current.x + current.width);
        previous.width = mergedEnd - previous.x;
      } else {
        merged.push(current);
      }
    }

    return merged;
  }
}

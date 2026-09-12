import { performance } from "node:perf_hooks";
import { firstDifference, sliceLines, type Lines } from "./lines.ts";
import { Patches, type Mutable } from "./patch.ts";
import { RenderTree, type RenderStats } from "./tree.ts";
import { Container, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const COORDINATES = ["cursorRow", "hardwareCursorRow", "maxLinesRendered", "previousViewportTop"] as const;
const INSTALLED = Symbol.for("pi-optimized-render.controller");

export interface RendererOptions {
  onError?: (error: Error) => void;
}

function checkTui(tui: Mutable): void {
  if (!tui || !["regular", "fullscreen"].includes(tui.mode) || !Array.isArray(tui.children)) {
    throw new Error("Unsupported Pi renderer: expected the regular/fullscreen component tree");
  }
  for (const method of [
    "doRender",
    "render",
    "invalidate",
    "resetRenderState",
    "requestRender",
    "extractCursorPosition",
    "applyLineResets",
  ]) {
    if (typeof tui[method] !== "function") throw new Error(`Unsupported Pi renderer: missing ${method}`);
  }
  const prototype = (tui.mode === "regular"
    ? TuiMainScreen.prototype
    : TuiAltScreen.prototype) as unknown as Mutable;
  const render = tui.mode === "regular" ? Container.prototype.render : TuiAltScreen.prototype.render;
  if (tui.doRender !== prototype.doRender || tui.render !== render)
    throw new Error("Another extension owns Pi's renderer; leaving it unchanged");
  if (!tui.terminal || typeof tui.terminal.write !== "function") throw new Error("Unsupported Pi terminal");
  if (tui.mode === "regular") {
    if (!Array.isArray(tui.previousLines) || !(tui.previousKittyImageIds instanceof Set))
      throw new Error("Unsupported Pi frame state");
    for (const field of [...COORDINATES, "previousWidth", "previousHeight"]) {
      if (!Number.isFinite(tui[field])) throw new Error(`Unsupported Pi frame field: ${field}`);
    }
  }
}

/** Keeps Pi's terminal writer and rebases safe, text-only updates onto the visible tail. */
export class OptimizedRenderer {
  readonly stats: RenderStats = {
    frames: 0,
    fastFrames: 0,
    nativeFrames: 0,
    componentRenders: 0,
    cacheHits: 0,
    lastFrameMs: 0,
    totalFrameMs: 0,
    lastFrameLines: 0,
    transcriptLines: 0,
    fallbackReason: "warming up",
  };
  readonly tree: RenderTree;
  private readonly patches = new Patches();
  private previousRaw?: Lines;
  private previousNative?: string[];
  private previousHadOverlays = false;
  private rendering = false;
  private frameHook?: (...args: unknown[]) => unknown;
  disposed = false;

  constructor(
    readonly tui: Mutable,
    private options: RendererOptions = {},
  ) {
    checkTui(tui);
    if (tui[INSTALLED]) throw new Error("Pi renderer already has an optimizer attached");
    let tree: RenderTree | undefined;
    try {
      this.tree = tree = new RenderTree(tui, this.stats);
      this.patches.method(
        tui,
        "doRender",
        (native) => (this.frameHook = (...args: unknown[]) => this.frame(native, args)),
      );
      this.patches.method(tui, "resetRenderState", (native) => (...args: unknown[]) => {
        this.invalidate();
        return native.apply(tui, args);
      });
      tui[INSTALLED] = this;
    } catch (error) {
      this.patches.dispose();
      tree?.dispose();
      throw error;
    }
  }

  invalidate(): void {
    this.previousRaw = undefined;
    this.previousNative = undefined;
    this.tree.invalidate();
  }

  private fastCut(raw: Lines, width: number, height: number): number {
    const tui = this.tui;
    const reject = (reason: string) => {
      this.stats.fallbackReason = reason;
      return 0;
    };
    if (!this.previousRaw || this.previousNative !== tui.previousLines)
      return reject("first frame or external reset");
    if (tui.previousWidth !== width || tui.previousHeight !== height) return reject("terminal resize");
    if (tui.hasOverlayEntries || this.previousHadOverlays) return reject("overlay composition");
    if (raw.images || this.previousRaw.images || tui.previousKittyImageIds.size > 0)
      return reject("image protocol");
    if (
      raw.length < tui.previousLines.length ||
      (tui.getClearOnShrink() && raw.length < tui.maxLinesRendered)
    )
      return reject("content shrink");
    if (this.previousRaw.length !== tui.previousLines.length)
      return reject("frame length changed externally");
    if (process.env.PI_TUI_DEBUG === "1" || process.env.PI_TUI_DEBUG_REDRAW === "1")
      return reject("native debug logging");
    const cut = tui.previousViewportTop as number;
    if (
      !Number.isInteger(cut) ||
      cut <= 0 ||
      cut !== tui.previousLines.length - height ||
      tui.cursorRow < cut ||
      tui.hardwareCursorRow < cut
    )
      return reject("short transcript or displaced viewport");
    if (firstDifference(this.previousRaw, raw) < cut) return reject("offscreen content changed");
    this.stats.fallbackReason = "";
    return cut;
  }

  private project(raw: Lines, cut: number, native: (...args: any[]) => any, args: unknown[]): void {
    const tui = this.tui;
    const full = tui.previousLines as string[];
    const suffix = full.slice(cut);
    this.tree.regularOutput = () => sliceLines(raw, cut);
    tui.previousLines = suffix;
    for (const field of COORDINATES) tui[field] -= cut;
    try {
      native.apply(tui, args);
    } finally {
      const updated = tui.previousLines as string[];
      // The stable prefix remains available to captureRenderState(), redraws, and terminal scrollback.
      full.length = cut;
      for (const line of updated) full.push(line);
      tui.previousLines = full;
      for (const field of COORDINATES) tui[field] += cut;
    }
  }

  private frame(native: (...args: any[]) => any, args: unknown[]): unknown {
    if (this.disposed || this.rendering) return native.apply(this.tui, args);
    if (this.tui.doRender !== this.frameHook || !this.tree.ownsRootRender) {
      this.dispose();
      return native.apply(this.tui, args);
    }
    if (this.tui.stopped || (this.tui.mode === "fullscreen" && !this.tui.altScreenActive)) return;
    const start = performance.now();
    let nativeStarted = false;
    this.rendering = true;
    this.stats.frames++;
    try {
      this.tree.begin();
      if (this.tree.conflict) {
        this.dispose();
        nativeStarted = true;
        return native.apply(this.tui, args);
      }
      const width = this.tui.terminal.columns as number;
      const height = this.tui.terminal.rows as number;
      if (this.tui.mode === "fullscreen") {
        this.tree.prepareFullscreen();
        nativeStarted = true;
        native.apply(this.tui, args);
        this.stats.nativeFrames++;
        this.stats.lastFrameLines = height;
        this.stats.transcriptLines = this.tree.lineCount;
        this.stats.fallbackReason = "native fullscreen viewport";
      } else {
        const raw = this.tree.read(width);
        const cut = this.fastCut(raw, width, height);
        nativeStarted = true;
        if (cut) {
          this.project(raw, cut, native, args);
          this.stats.fastFrames++;
        } else {
          this.tree.regularOutput = () => sliceLines(raw);
          native.apply(this.tui, args);
          this.stats.nativeFrames++;
        }
        this.stats.transcriptLines = raw.length;
        this.stats.lastFrameLines = raw.length - cut;
        this.previousRaw = raw;
        this.previousNative = this.tui.previousLines;
        this.previousHadOverlays = this.tui.hasOverlayEntries;
      }
    } catch (error) {
      this.dispose();
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      // Native render errors may follow terminal writes. Retrying could duplicate scrollback.
      if (nativeStarted) throw error;
      return native.apply(this.tui, args);
    } finally {
      this.tree.end();
      this.rendering = false;
      this.stats.lastFrameMs = performance.now() - start;
      this.stats.totalFrameMs += this.stats.lastFrameMs;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.patches.dispose();
    this.tree.dispose();
    if (this.tui[INSTALLED] === this) delete this.tui[INSTALLED];
    this.previousRaw = undefined;
    this.previousNative = undefined;
  }
}

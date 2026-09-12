import {
  Container,
  CURSOR_MARKER,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { OptimizedRenderer } from "../src/renderer.ts";
import { CACHEABLE } from "../src/tree.ts";
import type { Mutable } from "../src/patch.ts";

export class TestTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  chunks: string[] = [];
  written = 0;
  capture = true;
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(input: (data: string) => void, resize: () => void) {
    this.onInput = input;
    this.onResize = resize;
  }
  stop() {
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput() {}
  write(data: string) {
    this.written += data.length;
    if (this.capture) this.chunks.push(data);
  }
  moveBy(lines: number) {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  hideCursor() {
    this.write("\x1b[?25l");
  }
  showCursor() {
    this.write("\x1b[?25h");
  }
  clearLine() {
    this.write("\x1b[2K");
  }
  clearFromCursor() {
    this.write("\x1b[J");
  }
  clearScreen() {
    this.write("\x1b[2J");
  }
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  take() {
    const output = this.chunks.join("");
    this.chunks = [];
    return output;
  }
}

export class Counted implements Component {
  [CACHEABLE] = true;
  renders = 0;
  constructor(public lines: string[]) {}
  setLines(lines: string[]) {
    this.lines = lines;
  }
  invalidate() {}
  render(width: number) {
    this.renders++;
    return this.lines.map((line) => line.slice(0, width));
  }
}

export class Live implements Component {
  frame = 0;
  renders = 0;
  render() {
    this.renders++;
    return [`live ${this.frame}`];
  }
  invalidate() {}
}

export class CursorEditor implements Component {
  value = "";
  cursor = 0;
  focused = true;
  render() {
    return [
      `> ${this.value.slice(0, this.cursor)}${this.focused ? CURSOR_MARKER : ""}${this.value.slice(this.cursor)}`,
    ];
  }
  invalidate() {}
}

export function scene(optimized: boolean, mode: "regular" | "fullscreen" = "regular", size = 400) {
  const terminal = new TestTerminal();
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const chat = new Container();
  const document = new Container();
  document.addChild(chat);
  const history = Array.from({ length: size }, (_, i) => new Counted([`history ${i} a`, `history ${i} b`]));
  for (const row of history) chat.addChild(row);
  const streaming = new Counted(["stream"]);
  chat.addChild(streaming);
  const live = new Live();
  const editor = new CursorEditor();
  const dock = new Container();
  dock.addChild(live);
  dock.addChild(editor);
  tui.addChild(document);
  tui.addChild(dock);
  const scroll = new ScrollView(document, { follow: "end", primary: true });
  if (tui instanceof TuiAltScreen)
    tui.setLayoutRoot(new VStack([{ component: scroll, grow: 1, basis: 0 }, dock]));
  const controller = optimized ? new OptimizedRenderer(tui as unknown as Mutable) : undefined;
  tui.start();
  return {
    terminal,
    tui,
    chat,
    document,
    history,
    streaming,
    live,
    editor,
    dock,
    scroll,
    controller,
    frame() {
      tui.renderNow();
      return terminal.take();
    },
    close() {
      controller?.dispose();
      tui.stop({ preserveScreen: true });
    },
  };
}

export type Scene = ReturnType<typeof scene>;

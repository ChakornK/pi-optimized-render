import assert from "node:assert/strict";
import test from "node:test";
import headless from "@xterm/headless";
import { Text, TuiAltScreen, type OverlayHandle } from "@earendil-works/pi-tui";
import { scene } from "./helpers.ts";

const { Terminal } = headless;

function snapshot(terminal: InstanceType<typeof Terminal>) {
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(false)),
    cells: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row);
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line?.getCell(col);
        return (
          cell && [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColor(),
            cell.getBgColor(),
            cell.isBold(),
            cell.isInverse(),
          ]
        );
      });
    }),
  };
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: xterm screen, scrollback, styles, and cursor match native rendering`, async () => {
    const native = scene(false, mode, 80);
    const optimized = scene(true, mode, 80);
    const terminals = [
      new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true }),
      new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true }),
    ];
    const scenes = [native, optimized];
    const handles: OverlayHandle[] = [];
    const frame = async (label: string) => {
      await Promise.all(
        scenes.map((s, i) => new Promise<void>((resolve) => terminals[i]!.write(s.frame(), resolve))),
      );
      assert.deepEqual(snapshot(terminals[1]!), snapshot(terminals[0]!), label);
    };
    try {
      for (const s of scenes)
        s.chat.addChild(
          new Text("\x1b[1;31mStyled 界 café\x1b[0m\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07", 0, 0),
        );
      await frame("initial transcript");
      for (let i = 0; i < 8; i++) {
        for (const s of scenes) {
          s.editor.value = `界 ${i}`;
          s.editor.cursor = 1;
          s.streaming.setLines(Array.from({ length: i + 2 }, (_, row) => `stream ${i} row ${row}`));
        }
        await frame(`stream ${i}`);
      }
      for (const s of scenes)
        handles.push(s.tui.showOverlay(new Text("dialog", 0, 0), { anchor: "center", width: 20 }));
      await frame("overlay");
      handles.forEach((handle) => handle.hide());
      await frame("overlay closes");
      for (const s of scenes) s.history[0]!.setLines(["edited history"]);
      await frame("offscreen change");
      for (const s of scenes) s.streaming.setLines([]);
      await frame("shrink");
      for (const s of scenes) {
        s.terminal.columns = 55;
        s.terminal.rows = 18;
      }
      terminals.forEach((terminal) => terminal.resize(55, 18));
      await frame("resize");
      if (mode === "fullscreen") {
        for (const s of scenes) (s.tui as TuiAltScreen).scrollToTop();
        await frame("scroll to first message");
      }
      for (const s of scenes) s.tui.renderNow(true);
      await frame("forced redraw");
    } finally {
      native.close();
      optimized.close();
      terminals.forEach((terminal) => terminal.dispose());
    }
  });
}

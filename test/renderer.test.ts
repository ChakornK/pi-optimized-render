import assert from "node:assert/strict";
import test from "node:test";
import { Box, Container, Input, Markdown, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { OptimizedRenderer } from "../src/renderer.ts";
import type { Mutable } from "../src/patch.ts";
import { Counted, Live, scene, TestTerminal, type Scene } from "./helpers.ts";

function sameFrame(a: Scene, b: Scene, label: string) {
  assert.equal(b.frame(), a.frame(), label);
  if (a.tui instanceof TuiMainScreen && b.tui instanceof TuiMainScreen) {
    assert.deepEqual(b.tui.captureRenderState(), a.tui.captureRenderState(), `${label}: state`);
  }
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: byte-for-byte native output across edits and invalidations`, () => {
    const a = scene(false, mode);
    const b = scene(true, mode);
    try {
      sameFrame(a, b, "initial");
      for (let frame = 0; frame < 12; frame++) {
        for (const s of [a, b]) {
          s.live.frame = frame;
          s.editor.value = "typing".slice(0, frame % 7);
          s.editor.cursor = s.editor.value.length;
          s.streaming.setLines([`stream ${frame}`, ...Array.from({ length: frame }, (_, i) => `new ${i}`)]);
        }
        sameFrame(a, b, `stream ${frame}`);
      }
      assert.ok(
        b.history.every((row) => row.renders === 1),
        "unchanged history renders once",
      );
      for (const s of [a, b]) s.history[3]!.setLines(["changed offscreen", "extra", "lines"]);
      sameFrame(a, b, "offscreen edit");
      for (const s of [a, b]) s.tui.invalidate();
      sameFrame(a, b, "theme invalidation");
      for (const s of [a, b]) {
        s.terminal.columns = 43;
        s.terminal.rows = 17;
      }
      sameFrame(a, b, "resize");
      for (const s of [a, b]) s.streaming.setLines([]);
      sameFrame(a, b, "shrink");
      for (const s of [a, b]) s.chat.children.splice(2, 1, new Counted(["replacement"]));
      sameFrame(a, b, "splice");
      for (const s of [a, b]) s.chat.children.reverse();
      sameFrame(a, b, "reverse");
      for (const s of [a, b]) s.chat.children = s.chat.children.slice(0, 8);
      sameFrame(a, b, "replace children array");
      for (const s of [a, b]) s.chat.clear();
      sameFrame(a, b, "empty transcript");
      if (mode === "regular") assert.ok(b.controller!.stats.fastFrames >= 10);
      assert.equal(b.controller!.disposed, false);
    } finally {
      a.close();
      b.close();
    }
  });

  test(`${mode}: overlays, cursor movement, and expansion retain native semantics`, () => {
    const a = scene(false, mode);
    const b = scene(true, mode);
    try {
      sameFrame(a, b, "warmup");
      const overlays = [a, b].map((s) =>
        s.tui.showOverlay(new Text("overlay\nsecond row", 0, 0), { width: "60%", anchor: "center" }),
      );
      sameFrame(a, b, "show overlay");
      overlays.forEach((overlay) => overlay.setHidden(true));
      sameFrame(a, b, "hide overlay");
      overlays.forEach((overlay) => overlay.setHidden(false));
      sameFrame(a, b, "restore overlay");
      overlays.forEach((overlay) => overlay.hide());
      sameFrame(a, b, "remove overlay");
      for (const s of [a, b]) {
        s.editor.value = "界 café 👩‍💻";
        s.editor.cursor = 1;
        s.tui.setShowHardwareCursor(true);
        s.tui.setFocus(s.editor);
      }
      sameFrame(a, b, "unicode cursor");
      for (const s of [a, b]) s.editor.cursor = 6;
      sameFrame(a, b, "cursor-only update");
      for (const s of [a, b]) s.tui.setClearOnShrink(true);
      for (const s of [a, b]) s.streaming.setLines(Array.from({ length: 40 }, (_, i) => `expanded ${i}`));
      sameFrame(a, b, "expand");
      for (const s of [a, b]) s.streaming.setLines(["collapsed"]);
      sameFrame(a, b, "collapse");
    } finally {
      a.close();
      b.close();
    }
  });
}

test("regular: idle and keystroke frame work does not grow with history", () => {
  for (const size of [100, 3000]) {
    const s = scene(true, "regular", size);
    try {
      s.frame();
      const before = s.controller!.stats.componentRenders;
      for (let i = 0; i < 30; i++) {
        s.editor.value = `key ${i}`;
        s.frame();
      }
      assert.equal(s.controller!.stats.componentRenders - before, 60);
      assert.ok(s.controller!.stats.lastFrameLines <= s.terminal.rows);
      assert.ok(s.history.every((row) => row.renders === 1));
      assert.equal(s.controller!.stats.fastFrames, 30);
    } finally {
      s.close();
    }
  }
});

test("regular: streaming within a large component compares only that component", () => {
  const a = scene(false);
  const b = scene(true);
  try {
    for (const s of [a, b]) s.streaming.setLines(Array.from({ length: 300 }, (_, i) => `paragraph ${i}`));
    sameFrame(a, b, "large response");
    for (const s of [a, b]) s.streaming.setLines([...s.streaming.lines, "appended"]);
    sameFrame(a, b, "append response");
    assert.equal(b.controller!.stats.fastFrames, 1);
    assert.ok(b.controller!.stats.lastFrameLines <= b.terminal.rows + 1);
  } finally {
    a.close();
    b.close();
  }
});

test("regular: image frames bypass tail projection", () => {
  const a = scene(false);
  const b = scene(true);
  try {
    for (const s of [a, b]) s.chat.addChild(new Counted(["\x1b_Ga=T,f=100,i=17,r=2;AAAA\x1b\\", ""]));
    sameFrame(a, b, "image initial");
    for (const s of [a, b]) s.editor.value = "changed";
    sameFrame(a, b, "image update");
    assert.equal(b.controller!.stats.fastFrames, 0);
    assert.equal(b.controller!.stats.fallbackReason, "image protocol");
  } finally {
    a.close();
    b.close();
  }
});

test("fullscreen: scrolling, mouse layout, and search retain the entire transcript", () => {
  const a = scene(false, "fullscreen");
  const b = scene(true, "fullscreen");
  try {
    sameFrame(a, b, "initial");
    for (const s of [a, b]) (s.tui as TuiAltScreen).scrollToTop();
    sameFrame(a, b, "top");
    for (const s of [a, b]) (s.tui as TuiAltScreen).scrollBy(77);
    sameFrame(a, b, "middle");
    for (const s of [a, b]) {
      const tui = s.tui as unknown as Mutable;
      tui.toggleSearch();
      tui.updateSearchQuery("history 15");
    }
    sameFrame(a, b, "search");
    for (const s of [a, b]) (s.tui as unknown as Mutable).navigateSearch(1);
    sameFrame(a, b, "next match");
    for (const s of [a, b]) {
      (s.tui as unknown as Mutable).closeSearch();
      (s.tui as TuiAltScreen).scrollToBottom();
    }
    sameFrame(a, b, "follow output");
    assert.deepEqual(
      (b.chat as unknown as Mutable).mouseLayout.children.map((x: Mutable) => x.height),
      (a.chat as unknown as Mutable).mouseLayout.children.map((x: Mutable) => x.height),
    );
    assert.ok(b.history.every((row) => row.renders === 1));
  } finally {
    a.close();
    b.close();
  }
});

test("unknown nested renderers keep animating; native setters invalidate cached subtrees", () => {
  const a = scene(false);
  const b = scene(true);
  try {
    const rows = [a, b].map((s) => {
      const container = new Container();
      const box = new Box(0, 0);
      const text = new Text("old", 0, 0);
      const live = new Live();
      box.addChild(text);
      box.addChild(live);
      container.addChild(box);
      s.chat.addChild(container);
      return { box, text, live };
    });
    sameFrame(a, b, "nested warmup");
    for (const row of rows) {
      row.live.frame = 9;
      row.text.setText("new");
    }
    sameFrame(a, b, "nested animation and setter");
    for (const row of rows) row.box.removeChild(row.live);
    sameFrame(a, b, "remove animation");
    rows.forEach((row) => row.text.setText("settled"));
    sameFrame(a, b, "cached child mutation");
    sameFrame(a, b, "cached idle");
  } finally {
    a.close();
    b.close();
  }
});

test("native Markdown and Text handle ANSI normalization and width invalidation", () => {
  initTheme("dark");
  const a = scene(false);
  const b = scene(true);
  try {
    for (const s of [a, b]) {
      s.chat.addChild(
        new Markdown("# Heading\n\n- item\n\n```ts\nconst x = 123;\n```", 1, 0, getMarkdownTheme()),
      );
      s.chat.addChild(
        new Text("\x1b[31mred\x1b[0m\tTabbed\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07", 0, 0),
      );
    }
    sameFrame(a, b, "formatted initial");
    sameFrame(a, b, "formatted idle");
    for (const s of [a, b]) s.terminal.columns = 27;
    sameFrame(a, b, "formatted resize");
  } finally {
    a.close();
    b.close();
  }
});

test("disposal restores instance methods and child arrays; removed subtrees are released", () => {
  const terminal = new TestTerminal();
  const tui = new TuiMainScreen(terminal);
  const chat = new Container();
  const row = new Counted(["retained"]);
  chat.addChild(row);
  tui.addChild(chat);
  const render = tui.render;
  const doRender = (tui as unknown as Mutable).doRender;
  const originalChildren = chat.children;
  const rowRender = row.render;
  const optimizer = new OptimizedRenderer(tui as unknown as Mutable);
  try {
    tui.renderNow();
    const count = optimizer.tree.nodes.size;
    chat.removeChild(row);
    tui.renderNow();
    assert.equal(optimizer.tree.nodes.size, count - 1);
    assert.equal(row.render, rowRender);
    const laterRender = function (width: number) {
      return render.call(tui, width);
    };
    tui.render = laterRender;
    optimizer.dispose();
    optimizer.dispose();
    assert.equal(tui.render, laterRender, "preserve a later extension replacement");
    assert.equal((tui as unknown as Mutable).doRender, doRender);
    assert.equal(chat.children, originalChildren);
    assert.equal(Object.hasOwn(chat, "render"), false);
    assert.equal(optimizer.tree.nodes.size, 0);
    assert.equal(optimizer.tree.root.index.value.length, 0);
  } finally {
    optimizer.dispose();
    tui.stop({ preserveScreen: true });
  }
});

test("force redraw and render-state restoration cannot reuse a stale prefix", () => {
  const a = scene(false);
  const b = scene(true);
  try {
    sameFrame(a, b, "warmup");
    for (const s of [a, b]) s.tui.renderNow(true);
    assert.equal(b.terminal.take(), a.terminal.take());
    assert.equal(b.controller!.stats.fastFrames, 0);
    for (const s of [a, b]) {
      const tui = s.tui as TuiMainScreen;
      tui.restoreRenderState(tui.captureRenderState());
      s.editor.value = "restored";
    }
    sameFrame(a, b, "restore");
    assert.equal(b.controller!.stats.fastFrames, 0);
  } finally {
    a.close();
    b.close();
  }
});

test("native rendering errors propagate without retrying terminal output", () => {
  const s = scene(true);
  try {
    s.frame();
    const bad = {
      invalidate() {},
      render() {
        throw new Error("component failure");
      },
    };
    s.chat.addChild(bad);
    assert.throws(() => s.tui.renderNow(), /component failure/);
    assert.equal(s.controller!.disposed, true);
  } finally {
    s.close();
  }
});

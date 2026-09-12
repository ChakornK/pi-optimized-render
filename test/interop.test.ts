import assert from "node:assert/strict";
import test from "node:test";
import type { Mutable } from "../src/patch.ts";
import { MouseRegion } from "@earendil-works/pi-tui";
import { Counted, Live, scene } from "./helpers.ts";

for (const method of ["render", "doRender"] as const) {
  test(`a later ${method} wrapper takes ownership without observing projected state`, () => {
    const s = scene(true);
    try {
      s.frame();
      const tui = s.tui as unknown as Mutable;
      const fullLength = tui.previousLines.length;
      const previous = tui[method];
      const replacement = function (this: Mutable, ...args: unknown[]) {
        assert.ok(this.previousLines.length >= fullLength);
        return previous.apply(this, args);
      };
      tui[method] = replacement;
      s.editor.value = "changed";
      s.frame();
      assert.equal(s.controller!.disposed, true);
      assert.equal(tui[method], replacement);
    } finally {
      s.close();
    }
  });
}

test("replacing and invalidating a cached row yields to the new renderer", () => {
  const s = scene(true);
  try {
    s.frame();
    const row = s.history[0]!;
    row.render = () => ["replacement renderer"];
    row.invalidate();
    assert.match(s.frame(), /replacement renderer/);
    assert.equal(s.controller!.disposed, true);
  } finally {
    s.close();
  }
});

test("an unpatchable child falls back without leaving a partial cache installed", () => {
  const s = scene(true);
  try {
    s.frame();
    s.chat.addChild(Object.freeze({ render: () => ["frozen row"], invalidate() {} }));
    assert.match(s.frame(), /frozen row/);
    assert.equal(s.controller!.disposed, true);
    assert.equal(s.controller!.tree.nodes.size, 0);
    assert.equal(s.controller!.tree.root.index.value.length, 0);
  } finally {
    s.close();
  }
});

test("inherited native mouse regions propagate nested animation liveness", () => {
  class ExtendedRegion extends MouseRegion {}
  const a = scene(false);
  const b = scene(true);
  const animations = [a, b].map((s) => {
    const live = new Live();
    s.chat.addChild(new ExtendedRegion(live, () => undefined));
    return live;
  });
  try {
    assert.equal(b.frame(), a.frame());
    animations.forEach((live) => {
      live.frame = 40;
    });
    assert.equal(b.frame(), a.frame());
    assert.equal(animations[1]!.renders, 2);
  } finally {
    a.close();
    b.close();
  }
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: seeded structural edits match native frames`, () => {
    const a = scene(false, mode, 50);
    const b = scene(true, mode, 50);
    let seed = 92135;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    try {
      assert.equal(b.frame(), a.frame());
      for (let step = 0; step < 120; step++) {
        const action = random(9);
        const position = random(a.chat.children.length || 1);
        const length = random(8);
        const width = [40, 55, 80][random(3)]!;
        const height = [15, 24, 30][random(3)]!;
        for (const s of [a, b]) {
          const row = s.chat.children[position];
          switch (action) {
            case 0:
              s.chat.addChild(new Counted([`append ${step}`]));
              break;
            case 1:
              if (row instanceof Counted) row.setLines(Array.from({ length }, (_, i) => `row ${step}:${i}`));
              break;
            case 2:
              s.chat.children.splice(position, 0, new Counted([`insert ${step}`]));
              break;
            case 3:
              if (s.chat.children.length > 1) s.chat.children.splice(position, 1);
              break;
            case 4:
              s.terminal.columns = width;
              break;
            case 5:
              s.terminal.rows = height;
              break;
            case 6:
              s.editor.value = `key ${step}`;
              s.editor.cursor = length;
              break;
            case 7:
              s.tui.invalidate();
              break;
            case 8:
              s.tui.renderNow(true);
              break;
          }
        }
        assert.equal(b.frame(), a.frame(), `step ${step}, action ${action}`);
        assert.equal(b.controller!.disposed, false);
      }
    } finally {
      a.close();
      b.close();
    }
  });
}

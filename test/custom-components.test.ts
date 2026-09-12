import assert from "node:assert/strict";
import test from "node:test";
import { Box, MouseRegion, truncateToWidth } from "@earendil-works/pi-tui";
import { CACHEABLE, DYNAMIC } from "../src/tree.ts";
import { scene, type Scene } from "./helpers.ts";

function closureComponent(cacheable = false, dynamic = false) {
  let label = "initial";
  let renders = 0;
  const component = {
    [CACHEABLE]: cacheable,
    [DYNAMIC]: dynamic,
    invalidate() {},
    render(width: number) {
      renders++;
      return [truncateToWidth(label, width, "")];
    },
  };
  return {
    component,
    get renders() {
      return renders;
    },
    change(value: string, invalidate = true) {
      label = value;
      if (invalidate) component.invalidate();
    },
  };
}

function sameFrame(native: Scene, optimized: Scene): void {
  assert.equal(optimized.frame(), native.frame());
  assert.equal(optimized.controller!.disposed, false);
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: unknown closure-backed components stay live after unchanged frames`, () => {
    const native = scene(false, mode);
    const optimized = scene(true, mode);
    const components = [native, optimized].map((s) => {
      const view = closureComponent();
      const box = new Box(0, 0);
      box.addChild(view.component);
      s.chat.addChild(box);
      return view;
    });
    try {
      for (let frame = 0; frame < 5; frame++) sameFrame(native, optimized);
      for (const view of components) view.change("external state changed", false);
      sameFrame(native, optimized);
      assert.equal(components[1]!.renders, 6);
    } finally {
      native.close();
      optimized.close();
    }
  });

  test(`${mode}: generic opt-in caches idle rows and honors invalidation and width`, () => {
    const native = scene(false, mode);
    const optimized = scene(true, mode);
    const components = [native, optimized].map((s) => {
      const view = closureComponent(true);
      s.chat.addChild(view.component);
      return view;
    });
    try {
      sameFrame(native, optimized);
      for (let frame = 0; frame < 5; frame++) {
        native.editor.value = optimized.editor.value = `input ${frame}`;
        sameFrame(native, optimized);
      }
      assert.equal(components[0]!.renders, 6);
      assert.equal(components[1]!.renders, 1);
      for (const view of components) view.change("settings changed");
      sameFrame(native, optimized);
      assert.equal(components[1]!.renders, 2);
      native.terminal.columns = optimized.terminal.columns = 60;
      sameFrame(native, optimized);
      assert.equal(components[1]!.renders, 3);
      native.tui.invalidate();
      optimized.tui.invalidate();
      sameFrame(native, optimized);
      assert.equal(components[1]!.renders, 4);
    } finally {
      native.close();
      optimized.close();
    }
  });

  test(`${mode}: dynamic takes precedence over opt-in through native wrappers`, () => {
    const native = scene(false, mode);
    const optimized = scene(true, mode);
    const components = [native, optimized].map((s) => {
      const view = closureComponent(true, true);
      s.chat.addChild(new MouseRegion(view.component, () => undefined));
      return view;
    });
    try {
      for (let frame = 0; frame < 4; frame++) {
        for (const view of components) view.change(`tick ${frame}`, false);
        sameFrame(native, optimized);
      }
      assert.equal(components[1]!.renders, 4);
    } finally {
      native.close();
      optimized.close();
    }
  });

  test(`${mode}: removed and disposed custom components regain their methods`, () => {
    const s = scene(true, mode);
    const view = closureComponent(true);
    const { render, invalidate } = view.component;
    try {
      s.chat.addChild(view.component);
      s.frame();
      assert.notEqual(view.component.render, render);
      assert.notEqual(view.component.invalidate, invalidate);
      s.chat.removeChild(view.component);
      s.frame();
      assert.equal(s.controller!.tree.nodes.has(view.component), false);
      assert.equal(view.component.render, render);
      assert.equal(view.component.invalidate, invalidate);
      view.change("remounted", false);
      s.chat.addChild(view.component);
      s.frame();
      assert.equal(view.renders, 2);
    } finally {
      s.close();
    }
    assert.equal(view.component.render, render);
    assert.equal(view.component.invalidate, invalidate);
  });
}

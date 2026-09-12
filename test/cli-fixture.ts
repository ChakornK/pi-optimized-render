import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Mutable } from "../src/patch.ts";

interface EntryData {
  label: string;
  policy: "cache" | "live" | "dynamic";
}

interface RenderRecord {
  policy: EntryData["policy"];
  renders: number;
  revision: number;
}

export default function fixture(pi: ExtensionAPI) {
  let reference: Mutable | undefined;
  let resourcesReady = false;
  let revision = 0;
  const components = new Set<Component>();
  const records = new WeakMap<object, RenderRecord>();

  pi.registerEntryRenderer<EntryData>("render-test-entry", (entry) => {
    const policy = entry.data?.policy ?? "live";
    const record: RenderRecord = { policy, renders: 0, revision: -1 };
    const view = {
      [Symbol.for("pi-optimized-render.cacheable")]: policy !== "live",
      [Symbol.for("pi-optimized-render.dynamic")]: policy === "dynamic",
      render(width: number) {
        record.renders++;
        record.revision = revision;
        return [truncateToWidth(`${entry.data?.label ?? "fixture"} · revision ${revision}`, width, "")];
      },
      invalidate() {},
    };
    components.add(view);
    records.set(view, record);
    return view;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      "render-test-probe",
      (tui) => {
        reference = tui as unknown as Mutable;
        return {
          render() {
            const focus = (tui as unknown as Mutable).getFocusedComponent();
            if (
              resourcesReady &&
              typeof focus?.handleInput === "function" &&
              process.env.PI_TEST_READY_FILE
            ) {
              writeFileSync(process.env.PI_TEST_READY_FILE, randomUUID(), { mode: 0o600 });
              resourcesReady = false;
            }
            return [];
          },
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );
  });
  pi.on("resources_discover", () => {
    resourcesReady = true;
  });
  pi.on("session_shutdown", () => {
    reference = undefined;
    components.clear();
  });

  pi.registerCommand("render-test-change", {
    async handler(nonce, ctx) {
      revision++;
      for (const component of components) component.invalidate();
      ctx.ui.notify(`Fixture changed ${nonce}`, "info");
    },
  });

  pi.registerCommand("render-test-probe", {
    async handler(path, ctx) {
      reference?.renderNow();
      const controller = reference?.[Symbol.for("pi-optimized-render.controller")];
      const nodes = controller ? ([...controller.tree.nodes.values()] as Mutable[]) : [];
      const custom = nodes.filter((node) => records.has(node.component));
      const cached = custom.filter((node) => records.get(node.component)!.policy === "cache");
      const live = custom.filter((node) => records.get(node.component)!.policy !== "cache");
      const renderCount = (rows: Mutable[]) =>
        rows.reduce((sum, node) => sum + records.get(node.component)!.renders, 0);
      const cachedBefore = renderCount(cached);
      const liveBefore = renderCount(live);
      reference?.renderNow();
      const result = {
        controller: Boolean(controller && !controller.disposed),
        nodeCount: nodes.length,
        fixtureRows: custom.length,
        cacheableRows: cached.length,
        retainedRows: cached.filter((node) => !node.live).length,
        dynamicRows: live.length,
        liveRows: live.filter((node) => node.live).length,
        staleRows: custom.filter((node) => records.get(node.component)!.revision !== revision).length,
        idleCachedRenders: renderCount(cached) - cachedBefore,
        idleLiveRenders: renderCount(live) - liveBefore,
        revision,
        sessionEntries: ctx.sessionManager.getEntries().length,
        stats: controller?.stats,
      };
      writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 });
      ctx.ui.notify(`Render probe saved ${basename(path)}`, "info");
    },
  });
}

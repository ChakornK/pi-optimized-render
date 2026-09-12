import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveTui, type Mutable } from "./patch.ts";
import type { OptimizedRenderer } from "./renderer.ts";

const WIDGET = "pi-optimized-render:attachment";
const SUPPORTED_PI = "0.85.1";
const PLUGIN_VERSION = "0.1.0";

interface Attachment {
  active: boolean;
  enabled: boolean;
  pending: boolean;
  reference?: Mutable;
  controller?: OptimizedRenderer;
  failed: WeakSet<object>;
  ctx: ExtensionContext;
}

export default async function optimizedRender(pi: ExtensionAPI): Promise<void> {
  const Renderer = VERSION === SUPPORTED_PI ? (await import("./renderer.ts")).OptimizedRenderer : undefined;
  let attachment: Attachment | undefined;

  pi.registerFlag("no-render-optimization", {
    description: "Use Pi's native renderer without retained transcript caching",
    type: "boolean",
    default: false,
  });

  const stop = (): void => {
    if (!attachment) return;
    attachment.active = false;
    attachment.controller?.dispose();
    attachment = undefined;
  };

  const attach = (state: Attachment, actual?: Mutable): void => {
    if (!state.active || !state.enabled || !state.reference) return;
    if (!Renderer) {
      state.enabled = false;
      state.ctx.ui.notify(
        `Render optimization is disabled on Pi ${VERSION}; this release supports Pi ${SUPPORTED_PI}. The native renderer is unchanged.`,
        "warning",
      );
      return;
    }
    try {
      actual ??= resolveTui(state.reference);
      if ((state.controller?.tui === actual && !state.controller.disposed) || state.failed.has(actual))
        return;
      state.controller?.dispose();
      state.controller = new Renderer(actual, {
        onError(error) {
          state.failed.add(actual!);
          queueMicrotask(() => {
            if (state.active)
              state.ctx.ui.notify(`Render optimization disabled: ${error.message}`, "warning");
          });
        },
      });
    } catch (error) {
      if (actual) state.failed.add(actual);
      state.enabled = false;
      state.ctx.ui.notify(
        `Render optimization unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  };

  const setup = (ctx: ExtensionContext, enabled: boolean): Attachment => {
    stop();
    const state: Attachment = {
      active: true,
      enabled,
      pending: false,
      failed: new WeakSet(),
      ctx,
    };
    attachment = state;
    ctx.ui.setWidget(
      WIDGET,
      (reference) => {
        state.reference = reference as unknown as Mutable;
        attach(state);
        return {
          render() {
            if (state.active && state.enabled && !state.pending) {
              const actual = resolveTui(state.reference!);
              if (actual !== state.controller?.tui && !state.failed.has(actual)) {
                state.pending = true;
                // Renderer switches remount the widget during a native frame. Attach after that frame completes.
                queueMicrotask(() => {
                  state.pending = false;
                  if (!state.active || !state.enabled) return;
                  attach(state);
                  state.reference?.requestRender();
                });
              }
            }
            return [];
          },
          invalidate() {},
          dispose() {
            state.active = false;
            state.controller?.dispose();
          },
        };
      },
      { placement: "belowEditor" },
    );
    return state;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") setup(ctx, pi.getFlag("no-render-optimization") !== true);
  });
  pi.on("session_shutdown", stop);

  pi.registerCommand("render-opt", {
    description: "Renderer optimization: status, on, off, or clear",
    getArgumentCompletions(prefix) {
      return ["status", "on", "off", "clear"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Render optimization only runs in interactive TUI mode.", "info");
        return;
      }
      const command = args.trim() || "status";
      if (!["status", "on", "off", "clear"].includes(command)) {
        ctx.ui.notify("Usage: /render-opt [status|on|off|clear]", "warning");
        return;
      }
      const state = attachment?.active ? attachment : setup(ctx, false);
      if (command === "off") {
        state.enabled = false;
        state.controller?.dispose();
        state.reference?.requestRender();
        ctx.ui.notify("Render optimization off; native rendering restored.", "info");
      } else if (command === "on") {
        state.enabled = true;
        state.failed = new WeakSet();
        attach(state);
        state.reference?.requestRender();
        if (state.controller && !state.controller.disposed) ctx.ui.notify("Render optimization on.", "info");
      } else if (command === "clear") {
        state.controller?.invalidate();
        state.reference?.invalidate();
        state.reference?.requestRender(true);
        ctx.ui.notify("Render caches cleared; requested a native redraw.", "info");
      } else {
        const controller = state.controller;
        if (!controller || controller.disposed) {
          ctx.ui.notify("Render optimization is off.", "info");
          return;
        }
        const stats = controller.stats;
        const mean = stats.frames ? stats.totalFrameMs / stats.frames : 0;
        ctx.ui.notify(
          [
            `Render optimization on (${controller.tui.mode}) · v${PLUGIN_VERSION}`,
            `Frame CPU: ${stats.lastFrameMs.toFixed(2)} ms last / ${mean.toFixed(2)} ms mean`,
            `Lines processed last frame: ${stats.lastFrameLines} / ${stats.transcriptLines}`,
            `Tail frames: ${stats.fastFrames}; native frames: ${stats.nativeFrames}; tracked components: ${controller.tree.nodes.size}; live: ${controller.tree.live.size}`,
            ...(stats.fallbackReason ? [`Native path: ${stats.fallbackReason}`] : []),
          ].join("\n"),
          "info",
        );
      }
    },
  });
}

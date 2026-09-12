import type { Mutable } from "./patch.ts";

/** Reads the native footer's dependencies without enumerating session history. */
export function footerKey(footer: Mutable, statuses = true): unknown[] | undefined {
  const session = footer.session;
  const manager = session?.sessionManager;
  const state = session?.state;
  const provider = footer.footerData;
  if (
    !state ||
    !Array.isArray(state.messages) ||
    typeof manager?.getLeafId !== "function" ||
    typeof provider?.getExtensionStatuses !== "function" ||
    typeof provider?.getGitBranch !== "function" ||
    typeof provider?.getAvailableProviderCount !== "function"
  )
    return undefined;
  const messages = state.messages;
  const last = messages[messages.length - 1];
  const model = state.model;
  const entries = manager.fileEntries;
  const key: unknown[] = [
    session,
    manager,
    manager.getLeafId(),
    entries,
    entries?.length,
    entries?.[entries.length - 1],
    messages,
    messages.length,
    last,
    last?.content,
    last?.usage,
    last?.usage?.input,
    last?.usage?.output,
    last?.usage?.cacheRead,
    last?.usage?.cacheWrite,
    last?.usage?.cost?.total,
    model,
    model?.id,
    model?.provider,
    model?.contextWindow,
    model?.reasoning,
    state.thinkingLevel,
    footer.autoCompactEnabled,
    provider,
    provider.getGitBranch(),
    provider.getAvailableProviderCount(),
    manager.getCwd?.(),
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.PI_EXPERIMENTAL,
    model && session.modelRuntime?.isUsingSubscription?.(model.provider),
  ];
  if (statuses) for (const [name, value] of provider.getExtensionStatuses()) key.push(name, value);
  return key;
}

/** Reuses native history-derived rows while rendering status changes without scanning entries. */
export class FooterMemo {
  private key?: unknown[];
  private base?: string[];

  constructor(
    private footer: Mutable,
    private original: (width: number) => string[],
  ) {}

  render(width: number, generation: number): string[] {
    const dependencies = footerKey(this.footer, false);
    if (!dependencies) return this.original.call(this.footer, width);
    const key = [width, generation, ...dependencies];
    if (
      !this.base ||
      !this.key ||
      key.length !== this.key.length ||
      key.some((value, i) => value !== this.key![i])
    ) {
      const lines = this.original.call(this.footer, width);
      this.key = key;
      this.base = lines.slice(0, 2);
      return lines;
    }
    // Use the status rows from this shadow render; leave the live session and its methods unchanged.
    const shadow = Object.create(this.footer) as Mutable;
    shadow.session = {
      state: this.footer.session.state,
      modelRuntime: this.footer.session.modelRuntime,
      sessionManager: { getEntries: () => [], getCwd: () => "", getSessionName: () => undefined },
      getContextUsage: () => undefined,
    };
    const status = this.original.call(shadow, width).slice(2);
    return [...this.base, ...status];
  }
}

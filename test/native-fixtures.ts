import {
  AgentSession,
  FooterComponent,
  SessionManager,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Mutable } from "../src/patch.ts";

export function assistant(text: string, id = 0): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: id,
    usage: {
      input: 80,
      output: 40,
      cacheRead: 60,
      cacheWrite: 0,
      totalTokens: 180,
      cost: { input: 0.0008, output: 0.0004, cacheRead: 0.0001, cacheWrite: 0, total: 0.0013 },
    },
  };
}

export function footerFixture(messages: AssistantMessage[]) {
  const manager = SessionManager.inMemory("/test/project");
  for (const message of messages) manager.appendMessage(message);
  let entryScans = 0;
  let contextScans = 0;
  const getEntries = manager.getEntries;
  manager.getEntries = function () {
    entryScans++;
    return getEntries.call(this);
  };
  const state = {
    messages: [...messages],
    thinkingLevel: "off",
    model: { id: "test", provider: "test", reasoning: true, contextWindow: 200000 },
  };
  const session = {
    state,
    sessionManager: manager,
    modelRuntime: { isUsingSubscription: () => false },
    get messages() {
      return state.messages;
    },
    get model() {
      return state.model;
    },
    getContextUsage() {
      contextScans++;
      return AgentSession.prototype.getContextUsage.call(this as unknown as AgentSession);
    },
  };
  let branch = "main";
  const statuses = new Map<string, string>();
  const provider = {
    getGitBranch: () => branch,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  } as ReadonlyFooterDataProvider;
  const footer = new FooterComponent(session as unknown as AgentSession, provider);
  return {
    footer,
    manager,
    state,
    statuses,
    session,
    get entryScans() {
      return entryScans;
    },
    get contextScans() {
      return contextScans;
    },
    setBranch(value: string) {
      branch = value;
    },
    append(message: AssistantMessage) {
      state.messages.push(message);
      manager.appendMessage(message);
    },
    raw() {
      return manager as unknown as Mutable;
    },
  };
}

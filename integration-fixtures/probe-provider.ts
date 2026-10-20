// fallow-ignore-file unused-file
// Pi loads this integration fixture dynamically through an explicit --extension path.

import { writeFileSync } from "node:fs";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "context-control-probe";
const MODEL = "probe-model";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing integration-test environment variable: ${name}`);
  return value;
}

function writeProbeResult(pi: ExtensionAPI, modelContext: string): void {
  const resultPath = requiredEnvironment("CONTEXT_CONTROL_PROBE_RESULT");
  const allowedMarker = requiredEnvironment("CONTEXT_CONTROL_ALLOWED_MARKER");
  const blockedMarker = requiredEnvironment("CONTEXT_CONTROL_BLOCKED_MARKER");
  const commandNames = pi.getCommands().map((command) => command.name);

  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        allowedVisible: modelContext.includes(allowedMarker),
        blockedVisible: modelContext.includes(blockedMarker),
        blockedNameVisible: modelContext.includes("<name>blocked</name>"),
        blockedPathVisible: modelContext.includes("/blocked/SKILL.md"),
        allowedCommandRegistered: commandNames.includes("skill:allowed"),
        blockedCommandRegistered: commandNames.includes("skill:blocked"),
        commandNames,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createProbeStream(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const text = "probe-ok";
  output.content.push({ type: "text", text });
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: output,
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: output,
  });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
  return stream;
}

export default function probeProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1",
    apiKey: "integration-test-key",
    api: "context-control-probe-api",
    models: [
      {
        id: MODEL,
        name: "Context Control Probe",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 16_384,
        maxTokens: 128,
      },
    ],
    streamSimple: (model, context) => {
      // Covers both legacy systemPrompt and transcript-based system messages in newer Pi.
      writeProbeResult(pi, JSON.stringify(context));
      return createProbeStream(model);
    },
  });
}

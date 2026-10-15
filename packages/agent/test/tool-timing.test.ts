import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function responses(names: string[]): StreamFn {
	let turn = 0;
	return () => {
		const first = turn++ === 0;
		const message: AssistantMessage = {
			role: "assistant",
			content: first ? names.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })) : [],
			api: "openai-responses",
			provider: "openai",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: first ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done",
			() => message,
		);
		queueMicrotask(() => stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }));
		return stream;
	};
}

const config: AgentLoopConfig = { model, convertToLlm: (messages) => messages as Message[] };

afterEach(() => vi.restoreAllMocks());

describe("tool event timing", () => {
	it.each([false, true])("times parallel tools before result messages (continuation=%s)", async (continuation) => {
		let clock = 0;
		let wall = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		let releaseSlow: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const tools: AgentTool[] = ["fast", "slow"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			async execute() {
				if (name === "slow") await slow;
				clock = name === "fast" ? 20 : 100;
				wall = name === "fast" ? 900 : 2000;
				return { content: [], details: {} };
			},
		}));
		const context: AgentContext = {
			messages: [{ role: "user", content: "synthetic", timestamp: 1000 }],
			tools,
		};
		const events: AgentEvent[] = [];
		const emit = (event: AgentEvent) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "fast") releaseSlow();
		};
		if (continuation) {
			await runAgentLoopContinue(context, config, emit, undefined, responses(["fast", "slow"]));
		} else {
			await runAgentLoop([], context, config, emit, undefined, responses(["fast", "slow"]));
		}
		const starts = events.filter((event) => event.type === "tool_execution_start");
		const ends = events.filter((event) => event.type === "tool_execution_end");
		expect(starts.map((event) => event.timestamp)).toEqual([1000, 1000]);
		expect(ends.map((event) => [event.toolCallId, event.timestamp, event.durationMs])).toEqual([
			["fast", 900, 20],
			["slow", 2000, 100],
		]);
		const firstResult = events.findIndex(
			(event) => event.type === "message_start" && event.message.role === "toolResult",
		);
		expect(firstResult).toBeGreaterThan(events.indexOf(ends[1]));
	});

	it.each(["missing", "blocked", "throws", "cancelled"])("times %s outcomes", async (failure) => {
		const tool: AgentTool = {
			name: "synthetic",
			label: "Synthetic",
			description: "Synthetic",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("synthetic failure");
			},
		};
		const events: AgentEvent[] = [];
		const controller = new AbortController();
		if (failure === "cancelled") controller.abort();
		await runAgentLoop(
			[],
			{ messages: [], tools: failure === "missing" ? [] : [tool] },
			{
				...config,
				toolExecution: "sequential",
				beforeToolCall: failure === "blocked" ? async () => ({ block: true, reason: "blocked" }) : undefined,
			},
			(event) => {
				events.push(event);
			},
			controller.signal,
			responses(["synthetic"]),
		);
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toMatchObject({ isError: true, timestamp: expect.any(Number), durationMs: expect.any(Number) });
		expect(end?.durationMs).toBeGreaterThanOrEqual(0);
	});
});

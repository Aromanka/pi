import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { NestedToolCallRunner, type NestedToolExecutionEvent } from "../src/core/nested-tool-calls.ts";

afterEach(() => vi.restoreAllMocks());

it("keeps nested call ids and records elapsed time when wall time moves backwards", async () => {
	let clock = 10;
	let wall = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	vi.spyOn(Date, "now").mockImplementation(() => wall);
	const tool: AgentTool = {
		name: "synthetic",
		label: "Synthetic",
		description: "Synthetic",
		parameters: Type.Object({}),
		async execute() {
			clock = 35;
			wall = 900;
			return { content: [], details: {} };
		},
	};
	const events: NestedToolExecutionEvent[] = [];
	const runner = new NestedToolCallRunner({
		getTools: () => [tool],
		isSequential: () => false,
		runToolCall: async (toolCall) => ({
			toolCall,
			result: await tool.execute(toolCall.id, toolCall.arguments),
			isError: false,
		}),
		emit: async (event) => {
			events.push(event);
		},
	});
	await runner.execute("parent", "synthetic", {});
	expect(events).toMatchObject([
		{ type: "tool_execution_start", toolCallId: "parent/1", parentToolCallId: "parent", timestamp: 1000 },
		{
			type: "tool_execution_end",
			toolCallId: "parent/1",
			parentToolCallId: "parent",
			timestamp: 900,
			durationMs: 25,
		},
	]);
});

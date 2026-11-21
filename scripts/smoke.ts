/**
 * Dev-only smoke test — never shipped, not part of the published package.
 *
 *   node --experimental-strip-types scripts/smoke.ts [--live]
 *
 * Without --live it only loads the extension, prints the registered tool
 * inventory and validates every tool's JSON schema accepts its documented
 * minimal arguments. With --live it also hits two cheap endpoints, so the API
 * key from the environment / ~/.pi/agent/minimax.json must be valid.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import extension from "../index.ts";

const home = homedir();

interface CapturedTool {
	name: string;
	label?: string;
	description?: string;
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

const tools: CapturedTool[] = [];
const commands: string[] = [];
const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
const events: string[] = [];

const pi = {
	registerTool(tool: CapturedTool) {
		tools.push(tool);
	},
	registerCommand(name: string, options?: { handler?: (args: string, ctx: unknown) => Promise<void> }) {
		commands.push(name);
		if (options?.handler) handlers.set(name, options.handler);
	},
	on(name: string) {
		events.push(name);
	},
	registerProvider() {},
	registerCommand2() {},
};

extension(pi as never);

console.log(`tools (${tools.length}):`);
for (const tool of tools) {
	const required = (tool.parameters?.required as string[] | undefined) ?? [];
	console.log(`  ${tool.name.padEnd(28)} ${required.length ? `required: ${required.join(",")}` : ""}`);
}
console.log(`commands: ${commands.join(", ")}`);
console.log(`events: ${events.join(", ")}`);

// every tool must reject an empty payload and accept its documented minimal args
const minimal: Record<string, Record<string, unknown>> = {
	minimax_video_create: { prompt: "a cat surfing" },
	minimax_video_query: { task_id: "1" },
	minimax_video_list: {},
	minimax_video_cancel: { task_id: "1" },
	minimax_video_context_ir: { prompt: "x", duration: 5 },
	minimax_video_regenerate: { source_task_id: "1" },
	minimax_image_generate: { prompt: "x" },
	minimax_image_edit: { prompt: "x", images: ["a.png"] },
	minimax_image_prompt: { prompt: "x" },
	minimax_speech: { text: "x" },
	minimax_speech_async: { text: "x" },
	minimax_transcribe: { audio: "a.mp3" },
	minimax_voice_clone: { audio: "a.mp3", voice_id: "abcdefgh" },
	minimax_voice_design: { prompt: "x", preview_text: "y" },
	minimax_voice_list: {},
	minimax_voice_delete: { voice_id: "v", voice_type: "voice_cloning" },
	minimax_music: { prompt: "x", lyrics: "a\nb" },
	minimax_music_cover_preprocess: { audio: "a.mp3" },
	minimax_lyrics: { prompt: "城市夜景" },
	minimax_file_upload: { path: "/tmp/x.png", purpose: "video_generation_input" },
	minimax_file_list: { purpose: "video_generation_input" },
	minimax_file_get: { file_id: 1 },
	minimax_file_delete: { file_id: 1, purpose: "video_generation_input" },
};

let bad = 0;
for (const tool of tools) {
	const sample = minimal[tool.name];
	if (!sample) {
		console.log(`! ${tool.name}: no sample args in the smoke map`);
		bad += 1;
		continue;
	}
	if (!Value.Check(tool.parameters as never, sample)) {
		const error = [...Value.Errors(tool.parameters as never, sample)][0];
		console.log(`! ${tool.name}: ${error?.message ?? "invalid"}`);
		bad += 1;
		continue;
	}
	const required = ((tool.parameters?.required as string[] | undefined) ?? []).filter((key) => !(key in sample));
	if (required.length > 0) {
		console.log(`! ${tool.name}: sample misses required field(s) ${required.join(",")}`);
		bad += 1;
	}
}
console.log(bad === 0 ? "\nschema check: OK" : `\nschema check: ${bad} problem(s)`);

if (process.argv.includes("--live")) {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const run = async (name: string, args: Record<string, unknown>) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`missing tool ${name}`);
		const result = await tool.execute("smoke", args, undefined, undefined, {});
		const text = result.content.map((block) => block.text ?? `<${block.type}>`).join("\n");
		console.log(`\n=== ${name} ${result.isError ? "(ERROR)" : "OK"} ===\n${text.slice(0, 700)}`);
		return result;
	};
	await run("minimax_voice_list", { voice_type: "system" });
	await run("minimax_lyrics", { prompt: "秋天的城市夜景，city pop", mode: "write_full_song" });
	await run("minimax_video_list", { page_size: 3 });
	if (process.argv.includes("--video")) {
		// cheapest billable path: H3-Lite / 480P / 4s, text-to-video (ratio defaults to 16:9)
		const tool = byName.get("minimax_video_create");
		if (!tool) throw new Error("missing minimax_video_create");
		const result = await tool.execute(
			"smoke",
			{
				prompt: "一只橘猫在雨后的霓虹小巷里慢慢抬头看向镜头，电影感灯光",
				model: "MiniMax-H3-Lite",
				resolution: "480P",
				duration: 4,
				timeout_s: 600,
				out_dir: "/tmp/pi-minimax-smoke",
			},
			undefined,
			async (update: { content: Array<{ text?: string }> }) => {
				console.log(`  .. ${update.content.map((b) => b.text ?? "").join(" ")}`);
			},
			{},
		);
		console.log(`\n=== minimax_video_create ${result.isError ? "(ERROR)" : "OK"} ===\n${result.content
			.map((b) => b.text ?? `<${b.type}>`)
			.join("\n")}`);
	}
	if (process.argv.includes("--media")) {
		await run("minimax_speech", { text: "你好，这是 pi 的 MiniMax 语音合成冒烟测试。", format: "mp3" });
		await run("minimax_image_generate", { prompt: "一只坐在霓虹灯下的猫，赛博朋克插画", size: "auto", area: "1K", n: 1, out_dir: "/tmp/pi-minimax-smoke" });
	}
}

// --command: exercise the /minimax command flow with a fake TUI.
// Run it with HOME=/tmp/... so the real ~/.pi/agent/minimax.json is never touched.
if (process.argv.includes("--command")) {
	type FakeUI = {
		custom: (factory: unknown) => Promise<unknown>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, type?: string) => void;
	};
	const makeCtx = (opts: {
		typedKey: string;
		selectChoice: number;
		confirmAnswer: boolean;
		/** When set, deliver the whole value as one bracketed-paste chunk. */
		pasteInsteadOfTyping?: boolean;
	}): { ctx: unknown; notes: string[] } => {
		const notes: string[] = [];
		const ui: FakeUI = {
			custom: (factory: unknown) => {
				return new Promise((resolve) => {
					const tui = { requestRender() {} };
					const component = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
						handleInput?: (data: string) => void;
					})(tui, {}, {}, (value: unknown) => resolve(value));
					if (opts.pasteInsteadOfTyping) {
						// pi forwards clipboard pastes wrapped in bracketed-paste markers,
						// including the trailing newline a user's clipboard usually has.
						component.handleInput?.(`\x1b[200~${opts.typedKey}\r\n\x1b[201~`);
					} else {
						for (const char of opts.typedKey) component.handleInput?.(char);
					}
					component.handleInput?.("\r");
				});
			},
			select: async (_title, options) => options[opts.selectChoice],
			confirm: async () => opts.confirmAnswer,
			input: async () => opts.typedKey,
			notify: (message, type) => notes.push(`[${type ?? "info"}] ${message}`),
		};
		return { ctx: { ui, mode: "tui", hasUI: true, cwd: process.cwd() }, notes };
	};

	const handler = handlers.get("minimax");
	if (!handler) throw new Error("missing /minimax command handler");

	// 1) bogus key -> verification fails -> user answers "save anyway"
	const bogus = makeCtx({ typedKey: "sk-bogus-0123456789abcdef", selectChoice: 0, confirmAnswer: true });
	await handler("set", bogus.ctx);
	console.log(`\n=== /minimax set (bogus key) ===\n${bogus.notes.join("\n")}`);

	// 1b) paste path: the whole key arrives as one bracketed-paste chunk
	const pasted = makeCtx({
		typedKey: "sk-pasted-0123456789abcdef",
		selectChoice: 0,
		confirmAnswer: true,
		pasteInsteadOfTyping: true,
	});
	await handler("set", pasted.ctx);
	const saved = JSON.parse(readFileSync(join(home, ".pi", "agent", "minimax.json"), "utf8")) as { apiKey?: string };
	const pasteOk = saved.apiKey === "sk-pasted-0123456789abcdef";
	console.log(`\n=== /minimax set (pasted key) ===\n${pasted.notes.join("\n")}`);
	console.log(`paste check: ${pasteOk ? "OK" : `FAIL (saved ${JSON.stringify(saved.apiKey)})`}`);

	// 2) status shows the saved key
	const status = makeCtx({ typedKey: "", selectChoice: 0, confirmAnswer: false });
	await handler("", status.ctx);
	console.log(`\n=== /minimax (status) ===\n${status.notes.join("\n")}`);

	// 3) cancel keeps the key
	const cancel = makeCtx({ typedKey: "", selectChoice: 0, confirmAnswer: false });
	await handler("set", cancel.ctx);
	console.log(`\n=== /minimax set (cancelled) ===\n${cancel.notes.join("\n")}`);

	// 4) clear removes the saved key again
	const clear = makeCtx({ typedKey: "", selectChoice: 0, confirmAnswer: true });
	await handler("clear", clear.ctx);
	console.log(`\n=== /minimax clear ===\n${clear.notes.join("\n")}`);
}

process.exit(bad === 0 ? 0 : 1);

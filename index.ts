/**
 * pi-minimax-multimodal — MiniMax 多模态能力接入 pi
 *
 * Provides 23 tools under the `minimax` namespace:
 *   video  : create / query / list / cancel / context-ir / regenerate
 *   image  : generate / edit / prompt rewrite
 *   speech : tts / async tts / transcribe / voice clone / voice design / voice list / voice delete
 *   music  : generate / cover preprocess / lyrics
 *   files  : upload / list / get / delete
 *
 * `/minimax set` configures and saves the API key (masked input + live validation).
 *
 * Docs: https://platform.minimaxi.com/docs/api-reference/
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	clearSavedKey,
	loadConfig,
	mcpFallbackEnabled,
	MCP_FALLBACK_ENV,
	maskKey,
	requireConfig,
	saveKey,
	CONFIG_PATH,
	MCP_PATH,
	type MinimaxConfig,
} from "./src/config.ts";
import { MinimaxError, requestJson } from "./src/client.ts";
import { askSecret } from "./src/prompt.ts";
import { registerFileTools } from "./src/tools/files.ts";
import { registerImageTools } from "./src/tools/image.ts";
import { registerMusicTools } from "./src/tools/music.ts";
import { registerSpeechTools } from "./src/tools/speech.ts";
import { registerVideoTools } from "./src/tools/video.ts";

const namespace = {
	name: "minimax",
	description: "MiniMax open platform (video / image / speech / music / files)",
};

type NoticeType = "info" | "warning" | "error";

const SITE_CN = "https://api.minimax.cn";
const SITE_INTL = "https://api.minimaxi.com";

export default function (pi: ExtensionAPI): void {
	registerVideoTools(pi, namespace);
	registerImageTools(pi, namespace);
	registerSpeechTools(pi, namespace);
	registerMusicTools(pi, namespace);
	registerFileTools(pi, namespace);

	/** `POST /v1/get_voice` is free and fast — used as the credential probe. */
	const probe = async (cfg: MinimaxConfig): Promise<number> => {
		const payload = await requestJson<{ system_voice?: unknown[] }>(cfg, {
			path: "/v1/get_voice",
			method: "POST",
			json: { voice_type: "system" },
			timeoutMs: 30_000,
		});
		return payload.system_voice?.length ?? 0;
	};

	const describeError = (error: unknown): string =>
		error instanceof MinimaxError ? error.describe() : String((error as Error)?.message ?? error);

	/**
	 * Notifications only exist in TUI/RPC. `--print` has no UI but a usable stdout,
	 * so mirror there; `--mode json`'s stdout is the event stream and must stay clean.
	 */
	const emit = (ctx: ExtensionCommandContext, message: string, type: NoticeType = "info"): void => {
		if (ctx.hasUI) {
			ctx.ui.notify(message, type);
			return;
		}
		if (ctx.mode === "print") console.log(`[minimax ${type}] ${message}`);
	};

	const handleStatus = (ctx: ExtensionCommandContext): void => {
		const cfg = loadConfig();
		const lines = [
			cfg.apiKey ? `api key : ${maskKey(cfg.apiKey)} (from ${cfg.apiKeySource})` : "api key : NOT configured",
			`base url: ${cfg.baseUrl}`,
			`outputs : ${cfg.outputDir}`,
			"",
			"tools   : minimax_video_*, minimax_image_*, minimax_speech*, minimax_transcribe,",
			"          minimax_voice_*, minimax_music*, minimax_lyrics, minimax_file_*",
			"",
			`config  : ${CONFIG_PATH}  ({"apiKey": "..."})`,
			`fallback: ${MCP_PATH} → mcpServers.*.env.MINIMAX_API_KEY ` +
				(mcpFallbackEnabled() ? `(opt-in ${MCP_FALLBACK_ENV}=1: ON)` : `(opt-in ${MCP_FALLBACK_ENV}=1: OFF)`),
			"env     : MINIMAX_API_KEY / MINIMAX_API_BASE / MINIMAX_OUTPUT_DIR",
			`          ${MCP_FALLBACK_ENV}=1  (允许复用 mcp.json 里已配的 key)`,
			"",
			"commands: /minimax set    配置并保存 key（隐藏输入 + 真实校验）",
			"          /minimax clear  删除已保存的 key",
			"          /minimax ping   用当前 key 打一次接口",
		];
		emit(ctx, lines.join("\n"), cfg.apiKey ? "info" : "warning");
	};

	const handleSet = async (ctx: ExtensionCommandContext): Promise<void> => {
		const current = loadConfig();
		if (!ctx.hasUI) {
			emit(
				ctx,
				`当前模式（${ctx.mode}）没有交互界面。请改用 export MINIMAX_API_KEY=sk-...，或写入 ${CONFIG_PATH}`,
				"warning",
			);
			return;
		}

		const key = await askSecret(ctx, {
			title: "MiniMax API Key（输入不回显）",
			hint: "Enter 保存 · Esc 取消 · 可直接粘贴（Ctrl+Shift+V）",
		});
		if (!key) {
			emit(ctx, `已取消，key 未改动（当前：${current.apiKey ? maskKey(current.apiKey) : "未配置"}）`, "info");
			return;
		}
		if (key.length < 20) {
			emit(ctx, `这个 key 看起来太短了（${key.length} 字符），未保存`, "error");
			return;
		}

		const keepLabel = `保持当前 (${current.baseUrl})`;
		const choice = await ctx.ui.select("API 站点", [`${SITE_CN}（国内站）`, `${SITE_INTL}（国际站）`, keepLabel]);
		if (choice === undefined) {
			emit(ctx, "已取消，key 未保存", "info");
			return;
		}
		const baseUrl = choice === keepLabel ? current.baseUrl : (choice.split("（")[0] ?? current.baseUrl);

		try {
			const count = await probe({ ...current, apiKey: key, baseUrl });
			const path = saveKey(key, baseUrl);
			emit(
				ctx,
				[
					`✓ 已保存并通过验证：${maskKey(key)} @ ${baseUrl}`,
					`文件：${path}（权限 600）`,
					`系统音色：${count} 个`,
					process.env.MINIMAX_API_KEY
						? "注意：环境变量 MINIMAX_API_KEY 优先级更高，仍会覆盖这个文件里的 key"
						: "",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		} catch (error) {
			const detail = describeError(error);
			const saveAnyway = await ctx.ui.confirm("验证失败，仍然保存这个 key？", detail.slice(0, 800));
			if (!saveAnyway) {
				emit(ctx, `未保存。验证错误：\n${detail.slice(0, 800)}`, "error");
				return;
			}
			const path = saveKey(key, baseUrl);
			emit(ctx, `已保存（未通过验证）：${maskKey(key)} → ${path}`, "warning");
		}
	};

	const handleClear = async (ctx: ExtensionCommandContext): Promise<void> => {
		const before = loadConfig();
		if (!before.apiKey) {
			emit(ctx, `没有可删除的 key（${CONFIG_PATH} 不存在或为空）`, "info");
			return;
		}
		const ok = await ctx.ui.confirm(
			"删除已保存的 MiniMax key？",
			`将从 ${CONFIG_PATH} 移除 apiKey（当前生效来源：${before.apiKeySource}）`,
		);
		if (!ok) {
			emit(ctx, "已取消", "info");
			return;
		}
		const result = clearSavedKey();
		const after = loadConfig();
		emit(
			ctx,
			[
				result.removedKey ? `✓ 已从 ${result.path} 移除 apiKey` : `${result.path} 里没有 apiKey`,
				result.removedFile ? "文件已清空并删除" : "",
				after.apiKey ? `当前仍生效的 key：${maskKey(after.apiKey)}（来自 ${after.apiKeySource}）` : "现在没有可用的 key",
			]
				.filter(Boolean)
				.join("\n"),
			after.apiKey ? "warning" : "info",
		);
	};

	const handlePing = async (ctx: ExtensionCommandContext): Promise<void> => {
		const cfg = requireConfig();
		try {
			const count = await probe(cfg);
			emit(ctx, `MiniMax OK — key ${maskKey(cfg.apiKey)} @ ${cfg.baseUrl}, ${count} system voices`, "info");
		} catch (error) {
			emit(ctx, `MiniMax ping failed: ${describeError(error)}`, "error");
		}
	};

	pi.registerCommand("minimax", {
		description: "MiniMax plugin: status / `set` (configure & save key) / `clear` / `ping`",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			switch (sub) {
				case "":
				case "status":
				case "help":
					handleStatus(ctx);
					return;
				case "set":
				case "key":
				case "login":
				case "config":
					await handleSet(ctx);
					return;
				case "clear":
				case "logout":
				case "remove":
					await handleClear(ctx);
					return;
				case "ping":
					await handlePing(ctx);
					return;
				default:
					emit(ctx, `未知子命令 "${sub}"。可用：set / clear / ping / status`, "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!loadConfig().apiKey && ctx.hasUI) {
			ctx.ui.notify(
				`MiniMax: no API key — run /minimax set, or export MINIMAX_API_KEY (config: ${CONFIG_PATH})`,
				"warning",
			);
		}
	});
}

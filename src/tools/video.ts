/**
 * Video generation tools (MiniMax H3, V2 API):
 *   POST   /v2/video_generation
 *   GET    /v2/query/video_generation/{task_id}
 *   GET    /v2/query/video_generation
 *   DELETE /v2/video_generation/{task_id}
 *   POST   /v2/h3_context_ir
 *   POST   /v2/video_regeneration
 *
 * The `content[]` array is the single input surface: one text item plus any mix of
 * image_url / video_url / audio_url items, each with an optional `role`
 * (first_frame | last_frame | reference_image | reference_video | reference_audio | base_video).
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { MinimaxError, requestJson } from "../client.ts";
import { requireConfig } from "../config.ts";
import { downloadTo, resolveRef, resolveRefs } from "../media.ts";
import {
	delay,
	errorMessage,
	failResult,
	fieldLines,
	nowStamp,
	textBlock,
	textResult,
	truncate,
	type ToolResult,
} from "../shared.ts";

const VIDEO_MODELS = ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"] as const;
const RESOLUTIONS = ["480P", "768P", "2K"] as const;
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const TASK_TYPES = ["generation", "h3_context_ir", "regeneration"] as const;

const MEDIA_PURPOSE = "video_generation_input";

interface VideoTask {
	id?: string;
	model?: string;
	status?: string;
	task_type?: string;
	modality?: string;
	resolution?: string;
	duration?: number;
	ratio?: string;
	created_at?: number | string;
	updated_at?: number | string;
	error?: { code?: number | string; message?: string };
	content?: { url?: string; prompt?: string };
	usage?: Record<string, number>;
}

interface Downloaded {
	path: string;
	bytes: number;
}

function statusOf(task: VideoTask): string {
	return task.status ?? "unknown";
}

function renderTask(task: VideoTask, saved?: Downloaded): string {
	const usage = task.usage;
	return fieldLines([
		["task_id", task.id],
		["status", statusOf(task)],
		["model", task.model],
		["task_type", task.task_type],
		["resolution", task.resolution],
		["duration", task.duration !== undefined ? `${task.duration}s` : undefined],
		["ratio", task.ratio],
		["error", task.error ? `${task.error.code ?? ""} ${task.error.message ?? ""}`.trim() : undefined],
		[
			"usage",
			usage
				? Object.entries(usage)
						.filter(([, value]) => value !== 0 && value !== undefined)
						.map(([key, value]) => `${key}=${value}`)
						.join(" ")
				: undefined,
		],
		["prompt", task.content?.prompt ? truncate(task.content.prompt, 400) : undefined],
		["url", task.content?.url],
		["saved_to", saved?.path],
		["saved_bytes", saved ? `${saved.bytes}B` : undefined],
		["remote_url", saved ? task.content?.url : undefined],
	]);
}

async function queryTask(cfg: ReturnType<typeof requireConfig>, taskId: string, signal?: AbortSignal) {
	const json = await requestJson<Record<string, unknown>>(cfg, {
		path: `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
		signal,
	});
	const wrapped = json.task;
	if (wrapped && typeof wrapped === "object") return wrapped as VideoTask;
	return json as VideoTask;
}

interface WaitOptions {
	signal?: AbortSignal;
	onUpdate?: (message: string) => void | Promise<void>;
	timeoutMs: number;
	intervalMs?: number;
	download: boolean;
	outDir: string;
	stem: string;
}

interface WaitOutcome {
	task: VideoTask;
	timedOut: boolean;
	saved?: Downloaded;
}

async function waitForTask(
	cfg: ReturnType<typeof requireConfig>,
	taskId: string,
	options: WaitOptions,
): Promise<WaitOutcome> {
	const interval = options.intervalMs ?? 5_000;
	const deadline = Date.now() + options.timeoutMs;
	let task = await queryTask(cfg, taskId, options.signal);
	let polls = 0;

	while (statusOf(task) === "queued" || statusOf(task) === "running") {
		if (Date.now() > deadline) return { task, timedOut: true };
		await delay(interval, options.signal);
		task = await queryTask(cfg, taskId, options.signal);
		polls += 1;
		if (polls % 2 === 0) {
			await options.onUpdate?.(`task ${taskId}: ${statusOf(task)} (${Math.round((Date.now() - (deadline - options.timeoutMs)) / 1000)}s)`);
		}
	}

	if (options.download && statusOf(task) === "succeeded" && task.content?.url) {
		const saved = await downloadTo(task.content.url, {
			dir: options.outDir,
			stem: `${options.stem}-${taskId}-${nowStamp()}`,
			ext: ".mp4",
			signal: options.signal,
		});
		return { task, timedOut: false, saved };
	}
	return { task, timedOut: false };
}

interface ContentBuilderParams {
	first_frame?: string;
	last_frame?: string;
	reference_images?: string[];
	reference_videos?: string[];
	reference_audios?: string[];
}

async function buildContent(
	cfg: ReturnType<typeof requireConfig>,
	prompt: string,
	params: ContentBuilderParams,
	signal?: AbortSignal,
): Promise<unknown[]> {
	const content: unknown[] = [{ type: "text", text: prompt }];
	const push = (type: "image_url" | "video_url" | "audio_url", url: string, role: string) => {
		content.push({ type, [type]: { url }, role });
	};

	const refs = async (values: readonly string[] | undefined) =>
		values && values.length > 0 ? await resolveRefs(cfg, values, { purpose: MEDIA_PURPOSE, signal }) : [];

	if (params.first_frame) push("image_url", await resolveRef(cfg, params.first_frame, { purpose: MEDIA_PURPOSE, signal }), "first_frame");
	if (params.last_frame) push("image_url", await resolveRef(cfg, params.last_frame, { purpose: MEDIA_PURPOSE, signal }), "last_frame");
	for (const url of await refs(params.reference_images)) push("image_url", url, "reference_image");
	for (const url of await refs(params.reference_videos)) push("video_url", url, "reference_video");
	for (const url of await refs(params.reference_audios)) push("audio_url", url, "reference_audio");
	return content;
}

function validateCommon(prompt: string, model: string, resolution: string, duration: number): void {
	if (!prompt.trim()) throw new Error("prompt must not be empty");
	if (prompt.length > 7_000) throw new Error(`prompt is ${prompt.length} chars, limit is 7000`);
	if ((model === "MiniMax-H3-Highspeed" || model === "MiniMax-H3-Lite") && resolution === "2K") {
		throw new Error(`${model} does not support resolution=2K (use 480P or 768P)`);
	}
	const minDuration = model === "MiniMax-H3-Max" ? 5 : 4;
	if (!Number.isInteger(duration) || duration < minDuration || duration > 15) {
		throw new Error(`duration must be an integer between ${minDuration} and 15 for ${model}`);
	}
}

function validateReferences(params: ContentBuilderParams): void {
	const images = (params.reference_images?.length ?? 0) + (params.first_frame ? 1 : 0) + (params.last_frame ? 1 : 0);
	if (images > 9) throw new Error(`at most 9 image inputs are allowed, got ${images}`);
	if ((params.reference_videos?.length ?? 0) > 3) throw new Error("at most 3 reference videos are allowed");
	if ((params.reference_audios?.length ?? 0) > 3) throw new Error("at most 3 reference audios are allowed");
	if (params.first_frame && (params.last_frame || (params.reference_images?.length ?? 0) > 0)) {
		throw new Error(
			"first_frame (image-to-video) cannot be combined with last_frame or reference_images (reference-to-video)",
		);
	}
}

const mediaParams = {
	first_frame: Type.Optional(
		Type.String({ description: "首帧图片（本地路径 / https / mm_file:// / data URI）。图生视频模式" }),
	),
	last_frame: Type.Optional(Type.String({ description: "尾帧图片，与 first_frame 一起构成首尾帧模式" })),
	reference_images: Type.Optional(
		Type.Array(Type.String(), { description: "参考图列表，最多 9 张（含首尾帧），用于主体/风格参考" }),
	),
	reference_videos: Type.Optional(
		Type.Array(Type.String(), {
			description: "参考视频列表，最多 3 段，每段 2~15s、MP4/MOV、≤50MB",
		}),
	),
	reference_audios: Type.Optional(
		Type.Array(Type.String(), { description: "参考音频列表，最多 3 段，每段 2~15s、WAV/MP3、≤15MB" }),
	),
};

export function registerVideoTools(pi: ExtensionAPI, namespace: ToolNamespace): void {
	pi.registerTool({
		name: "minimax_video_create",
		label: "MiniMax: create video",
		description:
			"创建 MiniMax H3 视频生成任务（V2）。同一个接口覆盖文生视频（t2va）、图生视频（first_frame，i2va）、" +
			"多模态参考生视频（reference_images/videos/audios，r2va，r2va/i2va 互斥）。" +
			"本地文件会自动上传成 `mm_file://{file_id}`。默认阻塞轮询直到任务结束并把成片下载到本地，返回本地路径。" +
			"model 可选 MiniMax-H3 / -Highspeed / -Lite / -Max；分辨率 480P/768P/2K（Highspeed、Lite 不支持 2K）；" +
			"时长 4~15 秒（Max 为 5~15）；文本提示词最长 7000 字符。",
		parameters: Type.Object({
			prompt: Type.String({ description: "视频描述/指令，最长 7000 字符" }),
			model: Type.Optional(Type.Union(VIDEO_MODELS.map((m) => Type.Literal(m)), { description: "默认 MiniMax-H3" })),
			...mediaParams,
			resolution: Type.Optional(Type.Union(RESOLUTIONS.map((r) => Type.Literal(r)), { description: "默认 768P" })),
			duration: Type.Optional(Type.Integer({ minimum: 4, maximum: 15, description: "秒，默认 6" })),
			ratio: Type.Optional(
				Type.Union(RATIOS.map((r) => Type.Literal(r)), {
					description: "宽高比；纯文生视频默认 16:9，图生视频固定 adaptive（不传即可）",
				}),
			),
			generate_audio: Type.Optional(Type.Boolean({ description: "是否生成音频，默认 true" })),
			prompt_expansion_mode: Type.Optional(
				Type.Union([Type.Literal("disabled"), Type.Literal("balanced"), Type.Literal("quality")], {
					description: "仅 MiniMax-H3-Max 支持，默认 balanced",
				}),
			),
			aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加 AIGC 水印，默认 false" })),
			callback_url: Type.Optional(Type.String({ description: "任务状态回调地址（需回显 challenge）" })),
			extra_content: Type.Optional(
				Type.Array(Type.Unknown(), {
					description: "高级用法：直接追加/覆盖 content 数组元素（不做本地路径处理），一般不需要",
				}),
			),
			wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待完成，默认 true" })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600, description: "等待超时秒数，默认 900" })),
			download: Type.Optional(Type.Boolean({ description: "成功后是否下载到本地，默认 true" })),
			out_dir: Type.Optional(Type.String({ description: "下载目录，默认插件输出目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const model: string = params.model ?? "MiniMax-H3";
				const resolution = params.resolution ?? "768P";
				const duration = params.duration ?? 6;
				validateCommon(params.prompt, model, resolution, duration);
				validateReferences(params);

				const content = await buildContent(cfg, params.prompt, params, signal);
				for (const extra of params.extra_content ?? []) content.push(extra);

				const body: Record<string, unknown> = { model, content, resolution, duration };
				if (params.generate_audio !== undefined) body.generate_audio = params.generate_audio;
				if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;
				if (params.callback_url) body.callback_url = params.callback_url;
				if (params.prompt_expansion_mode && model === "MiniMax-H3-Max") {
					body.extra = { prompt_expansion_mode: params.prompt_expansion_mode };
				}

				// t2va requires an explicit non-adaptive ratio; i2va is always adaptive; r2va may infer it.
				const hasFrame = Boolean(params.first_frame);
				const hasRefs =
					(params.reference_images?.length ?? 0) > 0 ||
					(params.reference_videos?.length ?? 0) > 0 ||
					(params.reference_audios?.length ?? 0) > 0;
				if (params.ratio) body.ratio = params.ratio;
				else if (!hasFrame && !hasRefs) body.ratio = "16:9";

				const created = await requestJson<{ task_id?: string; task?: { id?: string } }>(cfg, {
					path: "/v2/video_generation",
					method: "POST",
					json: body,
					signal,
				});
				const taskId = created.task_id ?? created.task?.id;
				if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(created).slice(0, 500)}`);

				const wait = params.wait ?? true;
				if (!wait) {
					return textResult(
						fieldLines([
							["task_id", taskId],
							["status", "submitted"],
							["model", model],
							["resolution", resolution],
							["duration", `${duration}s`],
							["ratio", body.ratio],
							["note", "poll with minimax_video_query"],
						]),
						{ task_id: taskId, response: created },
					);
				}

				await onUpdate?.({ content: [textBlock(`task ${taskId} submitted, waiting…`)], details: null });
				const outcome = await waitForTask(cfg, taskId, {
					signal,
					onUpdate: async (message) => {
						await onUpdate?.({ content: [textBlock(message)], details: null });
					},
					timeoutMs: (params.timeout_s ?? 900) * 1000,
					download: params.download ?? true,
					outDir: params.out_dir ?? cfg.outputDir,
					stem: "video",
				});

				const rendered = renderTask(outcome.task, outcome.saved);
				if (outcome.timedOut) {
					return failResult(
						`timed out after ${params.timeout_s ?? 900}s; task still ${statusOf(outcome.task)}.\n${rendered}\ncontinue with minimax_video_query`,
						{ task: outcome.task },
					);
				}
				if (statusOf(outcome.task) !== "succeeded") {
					return failResult(rendered, { task: outcome.task });
				}
				return textResult(rendered, { task: outcome.task, saved_path: outcome.saved?.path });
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `create video failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_video_query",
		label: "MiniMax: query video task",
		description:
			"按 task_id 查询视频任务状态；默认轮询到 queued/running 结束，成功时下载成片到本地并返回路径。" +
			"任务结果仅保留 7 天。",
		parameters: Type.Object({
			task_id: Type.String({ description: "任务 ID" }),
			wait: Type.Optional(Type.Boolean({ description: "是否阻塞轮询，默认 true" })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "等待超时秒数，默认 900" })),
			download: Type.Optional(Type.Boolean({ description: "成功后是否下载，默认 true" })),
			out_dir: Type.Optional(Type.String({ description: "下载目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				if (!(params.wait ?? true)) {
					const task = await queryTask(cfg, params.task_id, signal);
					return textResult(renderTask(task), { task });
				}
				const outcome = await waitForTask(cfg, params.task_id, {
					signal,
					onUpdate: async (message) => {
						await onUpdate?.({ content: [textBlock(message)], details: null });
					},
					timeoutMs: (params.timeout_s ?? 900) * 1000,
					download: params.download ?? true,
					outDir: params.out_dir ?? cfg.outputDir,
					stem: "video",
				});
				const rendered = renderTask(outcome.task, outcome.saved);
				if (outcome.timedOut) {
					return failResult(`still ${statusOf(outcome.task)} when the wait timed out.\n${rendered}`, {
						task: outcome.task,
					});
				}
				if (statusOf(outcome.task) !== "succeeded") return failResult(rendered, { task: outcome.task });
				return textResult(rendered, { task: outcome.task, saved_path: outcome.saved?.path });
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `query video failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_video_list",
		label: "MiniMax: list video tasks",
		description: "分页查询最近 7 天的视频任务列表，可按状态 / 模型 / 任务类型 / 任务 ID 过滤。",
		parameters: Type.Object({
			status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)), { description: "按状态过滤" })),
			model: Type.Optional(Type.String({ description: "按模型过滤，如 MiniMax-H3" })),
			task_type: Type.Optional(Type.Union(TASK_TYPES.map((t) => Type.Literal(t)), { description: "按任务类型过滤" })),
			task_ids: Type.Optional(Type.Array(Type.String(), { description: "按任务 ID 过滤" })),
			page_num: Type.Optional(Type.Integer({ minimum: 1, description: "页码，默认 1" })),
			page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每页数量，默认 20" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const json = await requestJson<{ items?: VideoTask[]; total?: number }>(cfg, {
					path: "/v2/query/video_generation",
					query: {
						page_num: params.page_num ?? 1,
						page_size: params.page_size ?? 20,
						"filter.status": params.status,
						"filter.model": params.model,
						"filter.task_type": params.task_type,
						"filter.task_ids": params.task_ids,
					},
					signal,
				});
				const items = json.items ?? [];
				if (items.length === 0) return textResult("no tasks matched", json);
				const lines = items.map((task) =>
					[
						`- ${task.id ?? "?"}  ${statusOf(task)}  ${task.model ?? ""}  ${task.resolution ?? ""}  ${
							task.duration ? `${task.duration}s` : ""
						}`,
						task.error?.message ? `    error: ${task.error.message}` : undefined,
						task.content?.url ? `    url: ${truncate(task.content.url, 120)}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
				);
				return textResult([`${items.length} task(s), total ${json.total ?? items.length}:`, ...lines].join("\n"), json);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `list video tasks failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_video_cancel",
		label: "MiniMax: cancel/delete video task",
		description: "取消排队中的任务，或删除成功/失败的任务记录（DELETE /v2/video_generation/{task_id}）。",
		parameters: Type.Object({
			task_id: Type.String({ description: "任务 ID" }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const json = await requestJson<{ task_id?: string; action?: string; status?: string }>(cfg, {
					path: `/v2/video_generation/${encodeURIComponent(params.task_id)}`,
					method: "DELETE",
					signal,
				});
				return textResult(
					fieldLines([
						["task_id", json.task_id ?? params.task_id],
						["action", json.action],
						["status", json.status],
					]),
					json,
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `cancel video task failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_video_context_ir",
		label: "MiniMax: H3-Context-IR",
		description:
			"用 H3-Context-IR 把粗略创意 + 参考素材深度理解成结构化视频提示词（不生成视频）。" +
			"产出可直接喂给 minimax_video_create 的 prompt。",
		parameters: Type.Object({
			prompt: Type.String({ description: "原始创意/指令" }),
			...mediaParams,
			duration: Type.Integer({ minimum: 4, maximum: 15, description: "目标视频时长（秒）" }),
			ratio: Type.Optional(Type.Union(RATIOS.map((r) => Type.Literal(r)), { description: "目标宽高比" })),
			wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待，默认 true" })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 10, maximum: 1800, description: "等待超时秒数，默认 300" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				validateReferences(params);
				const content = await buildContent(cfg, params.prompt, params, signal);
				const body: Record<string, unknown> = { model: "MiniMax-H3", content, duration: params.duration };
				if (params.ratio) body.ratio = params.ratio;

				const created = await requestJson<{ task_id?: string }>(cfg, {
					path: "/v2/h3_context_ir",
					method: "POST",
					json: body,
					signal,
				});
				const taskId = created.task_id;
				if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(created).slice(0, 500)}`);

				if (!(params.wait ?? true)) {
					return textResult(`task_id: ${taskId}\nstatus: submitted\npoll with minimax_video_query`, created);
				}

				const outcome = await waitForTask(cfg, taskId, {
					signal,
					onUpdate: async (message) => {
						await onUpdate?.({ content: [textBlock(message)], details: null });
					},
					timeoutMs: (params.timeout_s ?? 300) * 1000,
					download: false,
					outDir: cfg.outputDir,
					stem: "context-ir",
				});
				if (outcome.timedOut) {
					return failResult(`timed out; task ${taskId} still ${statusOf(outcome.task)}`, { task: outcome.task });
				}
				if (statusOf(outcome.task) !== "succeeded") {
					return failResult(renderTask(outcome.task), { task: outcome.task });
				}
				const enhanced = outcome.task.content?.prompt ?? "";
				return textResult(
					[`enhanced prompt (${enhanced.length} chars):`, "", enhanced].join("\n"),
					{ task: outcome.task, prompt: enhanced },
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `context-ir failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_video_regenerate",
		label: "MiniMax: regenerate video in 2K",
		description:
			"把符合 MiniMax-H3 768P 规格的源视频再生成 2K 成片（POST /v2/video_regeneration）。" +
			"二选一：source_task_id（复用该任务的源视频与最终提示词）或 base_video（源视频路径，需同时给 prompt）。",
		parameters: Type.Object({
			source_task_id: Type.Optional(Type.String({ description: "源任务 ID（其成片需为 768P）" })),
			base_video: Type.Optional(Type.String({ description: "源视频：本地路径 / https / mm_file://" })),
			prompt: Type.Optional(Type.String({ description: "base_video 模式下的原始最终提示词（最长 40000 字符）" })),
			model: Type.Optional(Type.Union(VIDEO_MODELS.map((m) => Type.Literal(m)), { description: "默认 MiniMax-H3" })),
			generate_audio: Type.Optional(Type.Boolean({ description: "是否生成音频，不传则沿用源视频" })),
			aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加 AIGC 水印" })),
			wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待，默认 true" })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600, description: "等待超时秒数，默认 900" })),
			download: Type.Optional(Type.Boolean({ description: "成功后是否下载，默认 true" })),
			out_dir: Type.Optional(Type.String({ description: "下载目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				if (!params.source_task_id && !params.base_video) {
					throw new Error("provide either source_task_id or base_video");
				}
				const model: string = params.model ?? "MiniMax-H3";
				const body: Record<string, unknown> = { model, resolution: "2K" };
				if (params.generate_audio !== undefined) body.generate_audio = params.generate_audio;
				if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;

				if (params.source_task_id) {
					body.source_task_id = params.source_task_id;
				} else {
					const text = params.prompt?.trim();
					if (!text) throw new Error("base_video mode requires prompt (the original final prompt)");
					const url = await resolveRef(cfg, params.base_video as string, { purpose: MEDIA_PURPOSE, signal });
					body.content = [
						{ type: "text", text },
						{ type: "video_url", video_url: { url }, role: "base_video" },
					];
				}

				const created = await requestJson<{ task_id?: string }>(cfg, {
					path: "/v2/video_regeneration",
					method: "POST",
					json: body,
					signal,
				});
				const taskId = created.task_id;
				if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(created).slice(0, 500)}`);
				if (!(params.wait ?? true)) {
					return textResult(`task_id: ${taskId}\nstatus: submitted\npoll with minimax_video_query`, created);
				}

				const outcome = await waitForTask(cfg, taskId, {
					signal,
					onUpdate: async (message) => {
						await onUpdate?.({ content: [textBlock(message)], details: null });
					},
					timeoutMs: (params.timeout_s ?? 900) * 1000,
					download: params.download ?? true,
					outDir: params.out_dir ?? cfg.outputDir,
					stem: "video-2k",
				});
				const rendered = renderTask(outcome.task, outcome.saved);
				if (outcome.timedOut) return failResult(`timed out; task ${taskId}\n${rendered}`, { task: outcome.task });
				if (statusOf(outcome.task) !== "succeeded") return failResult(rendered, { task: outcome.task });
				return textResult(rendered, { task: outcome.task, saved_path: outcome.saved?.path });
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `regenerate failed: ${errorMessage(error)}`,
				);
			}
		},
	});
}

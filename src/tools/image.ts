/**
 * Image tools (MiniMax H3-Image):
 *   POST /v1/images/generations   — text-to-image
 *   POST /v1/images/edits         — image editing (1..16 input images)
 *   POST /v1/h3_image_context_ir — rewrite a rough prompt into a structured image prompt
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { MinimaxError, requestJson } from "../client.ts";
import { requireConfig } from "../config.ts";
import { downloadTo, ensureDir, resolveRefs, saveBuffer } from "../media.ts";
import {
	errorMessage,
	failResult,
	fieldLines,
	imageBlockFromFile,
	nowStamp,
	textResult,
	truncate,
	type ResultBlock,
	type ToolResult,
} from "../shared.ts";

const IMAGE_MODELS = ["MiniMax-H3-Image", "MiniMax-H3-Highspeed"] as const;
const AREAS = ["1K", "2K", "4K"] as const;
const FORMATS = ["png", "jpeg", "jpg", "webp"] as const;

interface ImageItem {
	url?: string;
	b64_json?: string;
	size?: string;
	revised_prompt?: string;
	error?: { code?: number | string; message?: string };
}

interface ImagePayload {
	created?: number;
	data?: ImageItem[];
	output_format?: string;
	request_id?: string;
	usage?: Record<string, number>;
	base_resp?: { status_code?: number; status_msg?: string };
}

const styleParams = {
	model: Type.Optional(
		Type.Union(IMAGE_MODELS.map((m) => Type.Literal(m)), {
			description: "默认 MiniMax-H3-Image；-Highspeed 更快",
		}),
	),
	n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "生成张数，默认 1" })),
	size: Type.Optional(
		Type.String({ description: '尺寸 "宽x高"（256~5760 每边），或 "auto"（配合 area）' }),
	),
	aspect_ratio: Type.Optional(Type.String({ description: "宽高比，如 1:1 / 16:9 / 9:16；与 size 互斥" })),
	area: Type.Optional(
		Type.Union(AREAS.map((a) => Type.Literal(a)), { description: "画幅档位 1K/2K/4K，仅 size=auto 时可用" }),
	),
	output_format: Type.Optional(
		Type.Union(FORMATS.map((f) => Type.Literal(f)), { description: "输出格式，默认 png" }),
	),
	output_compression: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 100, description: "jpeg/webp 压缩质量（0~100）" }),
	),
	disable_prompt_enhanced: Type.Optional(Type.Boolean({ description: "关闭内置提示词增强" })),
	aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加 AIGC 水印，默认 false" })),
	inline: Type.Optional(Type.Boolean({ description: "是否把图片直接返回给模型看（默认 true，最多 4 张）" })),
	out_dir: Type.Optional(Type.String({ description: "保存目录，默认插件输出目录" })),
};

function validateImageParams(params: {
	prompt?: string;
	size?: string;
	aspect_ratio?: string;
	area?: string;
	output_compression?: number;
}): void {
	if (params.prompt !== undefined) {
		if (!params.prompt.trim()) throw new Error("prompt must not be empty");
		if (params.prompt.length > 32_000) throw new Error(`prompt is ${params.prompt.length} chars, limit is 32000`);
	}
	if (params.size && params.aspect_ratio) throw new Error("size and aspect_ratio are mutually exclusive");
	if (params.size && params.size !== "auto" && !/^\d+x\d+$/.test(params.size)) {
		throw new Error(`size must look like "1024x1024" or "auto", got "${params.size}"`);
	}
	if (params.area && params.size !== "auto") {
		throw new Error("area is only valid together with size=auto");
	}
	if (params.output_compression !== undefined) {
		// only meaningful for lossy formats, but the API accepts it regardless; just range-checked by schema
	}
}

function buildImageBody(params: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: params.model ?? "MiniMax-H3-Image",
		prompt: params.prompt,
		n: params.n ?? 1,
	};
	if (params.size) body.size = params.size;
	else if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
	if (params.area) body.area = params.area;
	if (params.output_format) body.output_format = params.output_format;
	if (params.output_compression !== undefined) body.output_compression = params.output_compression;
	if (params.disable_prompt_enhanced !== undefined) body.disable_prompt_enhanced = params.disable_prompt_enhanced;
	if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;
	body.response_format = "url";
	return body;
}

interface SavedImage {
	path: string;
	bytes: number;
}

interface SavedImages {
	/** index-aligned with payload.data */
	entries: (SavedImage | undefined)[];
	blocks: ResultBlock[];
}

async function persistImages(
	payload: ImagePayload,
	options: { outDir: string; stem: string; format: string; inline: boolean; signal?: AbortSignal },
): Promise<SavedImages> {
	await ensureDir(options.outDir);
	// the API may normalise the format (e.g. requested png -> jpeg), so trust payload first
	const declared = (payload.output_format ?? options.format).toLowerCase();
	const ext = declared === "jpeg" || declared === "jpg" ? "jpg" : declared === "webp" ? "webp" : "png";
	const items = payload.data ?? [];
	const saved: SavedImages = { entries: items.map(() => undefined), blocks: [] };
	let index = 0;
	for (const item of items) {
		const slot = index;
		index += 1;
		if (item.error) continue;
		let target: { path: string; bytes: number } | undefined;
		try {
			if (item.b64_json) {
				target = await saveBuffer(Buffer.from(item.b64_json, "base64"), {
					dir: options.outDir,
					stem: `${options.stem}-${index + 1}-${nowStamp()}`,
					ext: `.${ext}`,
				});
			} else if (item.url) {
				target = await downloadTo(item.url, {
					dir: options.outDir,
					stem: `${options.stem}-${index + 1}-${nowStamp()}`,
					ext: `.${ext}`,
					signal: options.signal,
				});
			}
		} catch {
			// download failures are reported through the url in the text output below
		}
		if (target) {
			saved.entries[slot] = target;
			if (options.inline && saved.blocks.length < 4) {
				const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
				const block = await imageBlockFromFile(target.path, mime);
				if (block) saved.blocks.push(block);
			}
		}
	}
	return saved;
}

function renderImagePayload(payload: ImagePayload, saved: SavedImages): string {
	const items = payload.data ?? [];
	const lines: string[] = [];
	lines.push(
		fieldLines([
			["request_id", payload.request_id],
			["images", String(items.length)],
			["output_format", payload.output_format],
			[
				"usage",
				payload.usage
					? Object.entries(payload.usage)
							.filter(([, value]) => typeof value === "number")
							.map(([key, value]) => `${key}=${value}`)
							.join(" ")
					: undefined,
			],
		]),
	);
	items.forEach((item, i) => {
		const entry = saved.entries[i];
		lines.push(
			fieldLines([
				[`#${i + 1}`, item.size],
				["saved_to", entry?.path],
				["bytes", entry ? `${entry.bytes}B` : undefined],
				["revised_prompt", item.revised_prompt ? truncate(item.revised_prompt, 240) : undefined],
				["url", item.url],
				["error", item.error ? `${item.error.code ?? ""} ${item.error.message ?? ""}`.trim() : undefined],
			]),
		);
	});
	return lines.join("\n");
}

export function registerImageTools(pi: ExtensionAPI, namespace: ToolNamespace): void {
	pi.registerTool({
		name: "minimax_image_generate",
		label: "MiniMax: generate image",
		description:
			"用 MiniMax H3-Image 根据提示词生成图片（文生图）。支持指定尺寸/宽高比/画幅档位（1K/2K/4K）、" +
			"一次生成 1~10 张、png/jpeg/webp 输出。图片会自动下载到本地，并把前 4 张直接返回给模型查看。",
		parameters: Type.Object({
			prompt: Type.String({ description: "图片描述，最长 32000 字符" }),
			...styleParams,
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				validateImageParams(params);
				const body = buildImageBody(params);
				const payload = await requestJson<ImagePayload>(cfg, {
					path: "/v1/images/generations",
					method: "POST",
					json: body,
					signal,
				});
				const saved = await persistImages(payload, {
					outDir: params.out_dir ?? cfg.outputDir,
					stem: "image",
					format: params.output_format ?? "png",
					inline: params.inline ?? true,
					signal,
				});
				const text = renderImagePayload(payload, saved);
				const files = saved.entries.filter((entry): entry is SavedImage => Boolean(entry));
				if (files.length === 0) return failResult(text, { response: payload });
				return { content: [{ type: "text", text }, ...saved.blocks], details: { response: payload, files } };
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `generate image failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_image_edit",
		label: "MiniMax: edit image",
		description:
			"用 MiniMax H3-Image 做图像编辑/合成（图片编辑）。传入 1~16 张参考图（本地路径自动上传）+ 编辑指令，" +
			"支持与文生图相同的尺寸/画幅/格式参数。结果同样下载并回显图片。",
		parameters: Type.Object({
			prompt: Type.String({ description: "编辑指令，例如「把背景换成海滩」" }),
			images: Type.Array(Type.String(), {
				minItems: 1,
				description: "输入图片：本地路径 / https / mm_file:// / data URI，1~16 张",
			}),
			...styleParams,
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				validateImageParams(params);
				if (params.images.length > 16) throw new Error("at most 16 input images are allowed");
				const urls = await resolveRefs(cfg, params.images, {
					purpose: "image_generation_input",
					signal,
				});
				const body = buildImageBody(params);
				body.images = urls.map((url) => ({ image_url: url }));
				const payload = await requestJson<ImagePayload>(cfg, {
					path: "/v1/images/edits",
					method: "POST",
					json: body,
					signal,
				});
				const saved = await persistImages(payload, {
					outDir: params.out_dir ?? cfg.outputDir,
					stem: "edit",
					format: params.output_format ?? "png",
					inline: params.inline ?? true,
					signal,
				});
				const text = renderImagePayload(payload, saved);
				const files = saved.entries.filter((entry): entry is SavedImage => Boolean(entry));
				if (files.length === 0) return failResult(text, { response: payload });
				return { content: [{ type: "text", text }, ...saved.blocks], details: { response: payload, files } };
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `edit image failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_image_prompt",
		label: "MiniMax: rewrite image prompt",
		description:
			"用 H3-Image-Context-IR 把粗略想法改写成结构化图像提示词（同步返回，不生成图片），" +
			"可作为 minimax_image_generate 的 prompt 使用。",
		parameters: Type.Object({
			prompt: Type.String({ description: "粗略想法/指令" }),
			images: Type.Optional(Type.Array(Type.String(), { description: "可选的参考图，1~16 张" })),
			size: Type.Optional(Type.String({ description: '"宽x高" 或 "auto"' })),
			aspect_ratio: Type.Optional(Type.String({ description: "目标宽高比" })),
			area: Type.Optional(Type.Union(AREAS.map((a) => Type.Literal(a)), { description: "目标画幅档位" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				validateImageParams(params);
				const body: Record<string, unknown> = { model: "MiniMax-H3-Image", prompt: params.prompt };
				if (params.images && params.images.length > 0) {
					if (params.images.length > 16) throw new Error("at most 16 input images are allowed");
					const urls = await resolveRefs(cfg, params.images, { purpose: "image_generation_input", signal });
					body.images = urls.map((url) => ({ image_url: url }));
				}
				if (params.size) body.size = params.size;
				else if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
				if (params.area) body.area = params.area;

				const payload = await requestJson<{
					revised_prompt?: string;
					aspect_ratio?: string;
					usage?: Record<string, number>;
					request_id?: string;
				}>(cfg, { path: "/v1/h3_image_context_ir", method: "POST", json: body, signal });

				const revised = payload.revised_prompt ?? "";
				return textResult(
					fieldLines([
						["chars", String(revised.length)],
						["aspect_ratio", payload.aspect_ratio],
						["request_id", payload.request_id],
					]) + "\n\n" + revised,
					payload,
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `rewrite prompt failed: ${errorMessage(error)}`,
				);
			}
		},
	});
}

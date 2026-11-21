/**
 * Music tools (MiniMax music):
 *   POST /v1/music_generation          — full song / instrumental / cover
 *   POST /v1/music_cover_preprocess    — analyse a reference track for cover generation
 *   POST /v1/lyrics_generation         — write or edit lyrics
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { MinimaxError, requestJson } from "../client.ts";
import { requireConfig } from "../config.ts";
import { decodeHexAudio, downloadTo, ensureDir, isRemoteRef, saveBuffer, uploadFile } from "../media.ts";
import { errorMessage, failResult, fieldLines, nowStamp, textResult, truncate, type ToolResult } from "../shared.ts";

const MUSIC_MODELS = [
	"music-3.0",
	"music-2.6",
	"music-cover",
	"music-3.0-free",
	"music-2.6-free",
	"music-cover-free",
] as const;
const COVER_MODELS = ["music-cover", "music-cover-free"] as const;
const MUSIC_FORMATS = ["mp3", "wav", "flac", "pcm"] as const;
const SAMPLE_RATES = [16000, 24000, 32000, 44100] as const;
const BITRATES = [32000, 64000, 128000, 256000] as const;

interface MusicData {
	status?: number;
	audio?: string;
}

async function persistMusic(
	audio: string | undefined,
	options: { dir: string; stem: string; format: string; signal?: AbortSignal },
): Promise<{ path: string; bytes: number } | undefined> {
	if (!audio) return undefined;
	ensureDir(options.dir);
	const stem = `${options.stem}-${nowStamp()}`;
	if (/^https?:\/\//i.test(audio)) {
		return downloadTo(audio, { dir: options.dir, stem, ext: `.${options.format}`, signal: options.signal });
	}
	if (/^data:/i.test(audio)) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(audio);
		if (!match) return undefined;
		const buffer = Buffer.from(match[3] ?? "", match[2] ? "base64" : "utf8");
		return saveBuffer(buffer, { dir: options.dir, stem, ext: `.${options.format}` });
	}
	return saveBuffer(decodeHexAudio(audio), { dir: options.dir, stem, ext: `.${options.format}` });
}

/**
 * The music endpoints were withdrawn for new accounts: status_code 2153 / HTTP 410.
 * Keep the tools (existing paying customers can still use them) but explain the failure.
 */
function musicFailure(error: unknown, action: string): string {
	if (error instanceof MinimaxError && error.statusCode === 2153) {
		return [
			`${action} failed: MiniMax 音乐 API 已停止向新用户开放 (status_code 2153, HTTP ${error.httpStatus}).`,
			"现有付费客户仍可继续使用；新接入请改用 MiniMax Audio (https://www.minimax.io/audio)",
			"或开源模型 https://huggingface.co/MiniMaxAI/MiniMax-Music3",
			`upstream message: ${error.message}`,
		].join("\n");
	}
	if (error instanceof MinimaxError) return error.describe();
	return `${action} failed: ${errorMessage(error)}`;
}

export function registerMusicTools(pi: ExtensionAPI, namespace: ToolNamespace): void {
	pi.registerTool({
		name: "minimax_music",
		label: "MiniMax: generate music",
		description:
			"用 MiniMax 音乐模型生成整首歌 / 纯音乐 / 翻唱（music_generation）。" +
			"提供 prompt（风格描述）+ lyrics（歌词，用换行分段，支持 [Verse]/[Chorus] 等标签）；" +
			"is_instrumental=true 时忽略歌词。翻唱模型（music-cover）需要同时给 reference_audio 或 cover_feature_id。" +
			"音频自动保存到本地并返回路径。" +
			"注意：该接口已对新用户下线（status_code 2153），仅现有付费客户可用。",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "音乐风格/情绪描述，如「轻快的city pop，女声」" })),
			lyrics: Type.Optional(Type.String({ description: "歌词，用 \\n 分行，可含 [Intro]/[Verse]/[Chorus] 标签" })),
			model: Type.Optional(
				Type.Union(MUSIC_MODELS.map((m) => Type.Literal(m)), { description: "默认 music-2.6" }),
			),
			is_instrumental: Type.Optional(Type.Boolean({ description: "是否纯音乐（无人声）" })),
			lyrics_optimizer: Type.Optional(
				Type.Boolean({ description: "让模型根据 prompt 自动生成/优化歌词（给了 lyrics 时可省略）" }),
			),
			reference_audio: Type.Optional(
				Type.String({ description: "翻唱参考音频：本地路径或 URL（6s~6min，≤50MB），仅 cover 模型" }),
			),
			cover_feature_id: Type.Optional(
				Type.String({ description: "先用 minimax_music_cover_preprocess 得到，24h 内可用" }),
			),
			format: Type.Optional(
				Type.Union(MUSIC_FORMATS.map((f) => Type.Literal(f)), { description: "音频格式，默认 mp3" }),
			),
			sample_rate: Type.Optional(
				Type.Union(SAMPLE_RATES.map((r) => Type.Literal(r)), { description: "采样率，默认 44100" }),
			),
			bitrate: Type.Optional(Type.Union(BITRATES.map((b) => Type.Literal(b)), { description: "码率，默认 256000" })),
			aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加 AIGC 水印" })),
			out_dir: Type.Optional(Type.String({ description: "保存目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const model: string = params.model ?? "music-2.6";
				const isCover = (COVER_MODELS as readonly string[]).includes(model);
				if (!params.prompt && !params.lyrics) throw new Error("provide prompt and/or lyrics");
				if (isCover && !params.reference_audio && !params.cover_feature_id) {
					throw new Error(`${model} requires reference_audio or cover_feature_id`);
				}
				if (!isCover && params.reference_audio) {
					throw new Error("reference_audio is only supported by music-cover / music-cover-free");
				}
				if (params.is_instrumental && params.lyrics) {
					throw new Error("is_instrumental=true cannot be combined with lyrics");
				}

				const format = params.format ?? "mp3";
				const body: Record<string, unknown> = {
					model,
					output_format: "hex",
					stream: false,
					audio_setting: {
						format,
						...(params.sample_rate ? { sample_rate: params.sample_rate } : {}),
						...(params.bitrate ? { bitrate: params.bitrate } : {}),
					},
				};
				if (params.prompt) body.prompt = params.prompt;
				if (params.lyrics) body.lyrics = params.lyrics;
				if (params.is_instrumental !== undefined) body.is_instrumental = params.is_instrumental;
				if (params.lyrics_optimizer !== undefined) body.lyrics_optimizer = params.lyrics_optimizer;
				if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;
				if (params.cover_feature_id) body.cover_feature_id = params.cover_feature_id;

				let uploadedNote: string | undefined;
				if (params.reference_audio) {
					const local = !isRemoteRef(params.reference_audio);
					if (local) {
						const upload = await uploadFile(cfg, params.reference_audio, "video_generation_input", signal);
						body.audio_url = upload.mmFileRef;
						uploadedNote = `${params.reference_audio} -> ${upload.mmFileRef}`;
					} else if (/^data:/i.test(params.reference_audio)) {
						const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(params.reference_audio);
						body.audio_base64 = match?.[3] ?? params.reference_audio;
					} else {
						body.audio_url = params.reference_audio;
					}
				}

				const payload = await requestJson<{ data?: MusicData; trace_id?: string }>(cfg, {
					path: "/v1/music_generation",
					method: "POST",
					json: body,
					signal,
					timeoutMs: 900_000,
				});

				const status = payload.data?.status;
				if (status === 1) {
					return failResult(
						"music generation still in progress (status=1) — streaming-only state; retry with the same parameters",
						payload,
					);
				}
				const saved = await persistMusic(payload.data?.audio, {
					dir: params.out_dir ?? cfg.outputDir,
					stem: "music",
					format,
					signal,
				});
				if (!saved) return failResult("no audio returned", payload);
				return textResult(
					fieldLines([
						["model", model],
						["saved_to", saved.path],
						["bytes", `${saved.bytes}B`],
						["format", format],
						["trace_id", payload.trace_id],
						["reference", uploadedNote],
					]),
					{ saved_path: saved.path, trace_id: payload.trace_id },
				);
			} catch (error) {
				return failResult(musicFailure(error, "music generation"));
			}
		},
	});

	pi.registerTool({
		name: "minimax_music_cover_preprocess",
		label: "MiniMax: analyse cover reference",
		description:
			"(已对新用户下线) 分析翻唱参考曲目（music_cover_preprocess），返回 cover_feature_id、结构化歌词与段落结构，" +
			"可直接传给 minimax_music 的 cover_feature_id。适合反复生成多个翻唱版本。",
		parameters: Type.Object({
			audio: Type.String({ description: "参考音频：本地路径或 URL（6s~6min，≤50MB，mp3/wav/m4a/flac）" }),
			model: Type.Optional(
				Type.Union(COVER_MODELS.map((m) => Type.Literal(m)), { description: "默认 music-cover" }),
			),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const body: Record<string, unknown> = { model: params.model ?? "music-cover" };
				if (isRemoteRef(params.audio)) {
					if (/^data:/i.test(params.audio)) {
						const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(params.audio);
						body.audio_base64 = match?.[3] ?? params.audio;
					} else {
						body.audio_url = params.audio;
					}
				} else {
					const upload = await uploadFile(cfg, params.audio, "video_generation_input", signal);
					body.audio_url = upload.mmFileRef;
				}

				const payload = await requestJson<{
					cover_feature_id?: string;
					formatted_lyrics?: string;
					structure_result?: unknown;
					audio_duration?: number;
					trace_id?: string;
				}>(cfg, { path: "/v1/music_cover_preprocess", method: "POST", json: body, signal, timeoutMs: 900_000 });

				return textResult(
					fieldLines([
						["cover_feature_id", payload.cover_feature_id],
						["audio_duration_s", payload.audio_duration],
						["trace_id", payload.trace_id],
						["structure", payload.structure_result ? truncate(JSON.stringify(payload.structure_result), 1200) : undefined],
					]) +
						(payload.formatted_lyrics ? `\n\nformatted_lyrics:\n${truncate(payload.formatted_lyrics, 4000)}` : ""),
					payload,
				);
			} catch (error) {
				return failResult(musicFailure(error, "cover preprocess"));
			}
		},
	});

	pi.registerTool({
		name: "minimax_lyrics",
		label: "MiniMax: generate lyrics",
		description:
			"(已对新用户下线) 生成或修改歌词（lyrics_generation）。mode=write_full_song 按主题写整首歌词；" +
			"mode=edit 在原歌词上按指令修改。返回标题、风格标签与带段落标签的歌词。",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union([Type.Literal("write_full_song"), Type.Literal("edit")], {
					description: "默认 write_full_song",
				}),
			),
			prompt: Type.Optional(Type.String({ description: "主题 / 修改指令" })),
			lyrics: Type.Optional(Type.String({ description: "mode=edit 时的原始歌词" })),
			title: Type.Optional(Type.String({ description: "歌曲标题（可选）" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const mode = params.mode ?? "write_full_song";
				if (mode === "edit" && !params.lyrics) throw new Error("mode=edit requires lyrics");
				const body: Record<string, unknown> = { mode };
				if (params.prompt) body.prompt = params.prompt;
				if (params.lyrics) body.lyrics = params.lyrics;
				if (params.title) body.title = params.title;

				const payload = await requestJson<{
					song_title?: string;
					style_tags?: string[] | string;
					lyrics?: string;
				}>(cfg, { path: "/v1/lyrics_generation", method: "POST", json: body, signal });

				const tags = Array.isArray(payload.style_tags)
					? payload.style_tags.join(", ")
					: payload.style_tags;
				return textResult(
					fieldLines([
						["title", payload.song_title ?? params.title],
						["style_tags", tags],
					]) +
						`\n\n${payload.lyrics ?? ""}`,
					payload,
				);
			} catch (error) {
				return failResult(musicFailure(error, "lyrics generation"));
			}
		},
	});
}

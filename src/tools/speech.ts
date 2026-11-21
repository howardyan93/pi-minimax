/**
 * Speech tools (MiniMax audio):
 *   POST /v1/t2a_v2                     — synchronous TTS (hex or url output)
 *   POST /v1/t2a_async_v2               — async TTS for long text
 *   GET  /v1/query/t2a_async_query_v2   — async TTS status
 *   POST /v1/speech_to_text             — ASR (asr-1.0)
 *   POST /v1/voice_clone                — clone a voice from an audio sample
 *   POST /v1/voice_design               — design a voice from a text description
 *   POST /v1/get_voice                  — list system / cloned / designed voices
 *   POST /v1/delete_voice               — delete a cloned / designed voice
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { MinimaxError, request, requestJson } from "../client.ts";
import { requireConfig } from "../config.ts";
import { decodeHexAudio, downloadTo, ensureDir, extFromUrl, readAnyFile, saveBuffer, uniquePath, uploadFile } from "../media.ts";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { delay, errorMessage, failResult, fieldLines, nowStamp, textBlock, textResult, truncate, type ToolResult } from "../shared.ts";

const TTS_MODELS = [
	"speech-2.8-hd",
	"speech-2.8-turbo",
	"speech-2.6-hd",
	"speech-2.6-turbo",
	"speech-02-hd",
	"speech-02-turbo",
	"speech-01-hd",
	"speech-01-turbo",
] as const;
const EMOTIONS = [
	"happy",
	"sad",
	"angry",
	"fearful",
	"disgusted",
	"surprised",
	"calm",
	"fluent",
	"whisper",
] as const;
const AUDIO_FORMATS = ["mp3", "pcm", "flac", "wav", "pcmu_raw", "pcmu_wav", "opus"] as const;
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100] as const;
const BITRATES = [32000, 64000, 128000, 256000] as const;
const DEFAULT_VOICE = "male-qn-qingse";

const EXT_BY_FORMAT: Record<string, string> = {
	mp3: ".mp3",
	pcm: ".pcm",
	flac: ".flac",
	wav: ".wav",
	pcmu_raw: ".pcmu",
	pcmu_wav: ".wav",
	opus: ".opus",
};

function audioExt(format: string | undefined, url?: string): string {
	const fmt = format ?? "mp3";
	return EXT_BY_FORMAT[fmt] ?? (url ? extFromUrl(url, ".bin") : ".bin");
}

/** T2A / music style response: `data.audio` is hex unless output_format=url. */
async function saveAudioPayload(
	audio: string | undefined,
	options: { dir: string; stem: string; format?: string; signal?: AbortSignal },
): Promise<{ path: string; bytes: number } | undefined> {
	if (!audio) return undefined;
	ensureDir(options.dir);
	const isHex = /^[0-9a-fA-F]+$/.test(audio.slice(0, 64)) && audio.length % 2 === 0 && !/^https?:/i.test(audio);
	if (isHex) {
		const buffer = decodeHexAudio(audio);
		return saveBuffer(buffer, {
			dir: options.dir,
			stem: `${options.stem}-${nowStamp()}`,
			ext: audioExt(options.format),
		});
	}
	if (/^https?:\/\//i.test(audio)) {
		return downloadTo(audio, {
			dir: options.dir,
			stem: `${options.stem}-${nowStamp()}`,
			ext: audioExt(options.format, audio),
			signal: options.signal,
		});
	}
	if (audio.startsWith("data:")) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(audio);
		if (!match) return undefined;
		const buffer = Buffer.from(match[3] ?? "", match[2] ? "base64" : "utf8");
		const ext = audioExt(options.format);
		const path = uniquePath(options.dir, `${options.stem}-${nowStamp()}`, ext);
		writeFileSync(path, buffer);
		return { path, bytes: buffer.byteLength };
	}
	return undefined;
}

const voiceSettingParams = {
	voice_id: Type.Optional(Type.String({ description: `音色 ID，默认 ${DEFAULT_VOICE}` })),
	speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2, description: "语速 0.5~2，默认 1" })),
	vol: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10, description: "音量 (0,10]，默认 1" })),
	pitch: Type.Optional(Type.Integer({ minimum: -12, maximum: 12, description: "音调 -12~12，默认 0" })),
	emotion: Type.Optional(
		Type.Union(EMOTIONS.map((e) => Type.Literal(e)), { description: "情绪，仅 2.x/02 系列部分音色支持" }),
	),
	language_boost: Type.Optional(
		Type.String({ description: "语言增强，如 Chinese / English / auto（默认 auto）" }),
	),
};

function buildVoiceSetting(params: {
	voice_id?: string;
	speed?: number;
	vol?: number;
	pitch?: number;
	emotion?: string;
}): Record<string, unknown> {
	const setting: Record<string, unknown> = { voice_id: params.voice_id ?? DEFAULT_VOICE };
	if (params.speed !== undefined) setting.speed = params.speed;
	if (params.vol !== undefined) setting.vol = params.vol;
	if (params.pitch !== undefined) setting.pitch = params.pitch;
	if (params.emotion) setting.emotion = params.emotion;
	return setting;
}

async function fetchFileContent(
	cfg: ReturnType<typeof requireConfig>,
	fileId: number | string,
	signal?: AbortSignal,
): Promise<Buffer> {
	const response = await request(cfg, {
		path: "/v1/files/retrieve_content",
		query: { file_id: fileId },
		signal,
		timeoutMs: 600_000,
	});
	if (!response.ok) {
		throw new MinimaxError(`retrieve file content failed: HTTP ${response.status}`, {
			httpStatus: response.status,
		});
	}
	return Buffer.from(await response.arrayBuffer());
}

export function registerSpeechTools(pi: ExtensionAPI, namespace: ToolNamespace): void {
	pi.registerTool({
		name: "minimax_speech",
		label: "MiniMax: text to speech",
		description:
			"MiniMax 同步语音合成（T2A v2）。可设置音色、语速、音量、音调、情绪、采样率、码率、输出格式。" +
			"音频自动保存到本地并返回路径（默认 mp3）。文本上限 1 万字符，更长请用 minimax_speech_async。",
		parameters: Type.Object({
			text: Type.String({ description: "要朗读的文本，≤10000 字符" }),
			model: Type.Optional(
				Type.Union(TTS_MODELS.map((m) => Type.Literal(m)), { description: "默认 speech-2.6-hd" }),
			),
			...voiceSettingParams,
			format: Type.Optional(
				Type.Union(AUDIO_FORMATS.map((f) => Type.Literal(f)), { description: "音频格式，默认 mp3" }),
			),
			sample_rate: Type.Optional(
				Type.Union(SAMPLE_RATES.map((r) => Type.Literal(r)), { description: "采样率，默认 32000" }),
			),
			bitrate: Type.Optional(Type.Union(BITRATES.map((b) => Type.Literal(b)), { description: "码率，默认 128000" })),
			channel: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)], { description: "声道，默认 1" })),
			subtitle: Type.Optional(Type.Boolean({ description: "同时返回字幕文件" })),
			aigc_watermark: Type.Optional(Type.Boolean({ description: "是否加 AIGC 水印" })),
			out_dir: Type.Optional(Type.String({ description: "保存目录，默认插件输出目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				if (!params.text.trim()) throw new Error("text must not be empty");
				if (params.text.length > 10_000) {
					throw new Error(`text is ${params.text.length} chars, limit is 10000 — use minimax_speech_async`);
				}
				const format = params.format ?? "mp3";
				const body: Record<string, unknown> = {
					model: params.model ?? "speech-2.6-hd",
					text: params.text,
					stream: false,
					output_format: "hex",
					voice_setting: buildVoiceSetting(params),
					audio_setting: {
						format,
						...(params.sample_rate ? { sample_rate: params.sample_rate } : {}),
						...(params.bitrate ? { bitrate: params.bitrate } : {}),
						...(params.channel ? { channel: params.channel } : {}),
					},
				};
				if (params.language_boost) body.language_boost = params.language_boost;
				if (params.subtitle) body.subtitle_enable = true;
				if (params.aigc_watermark !== undefined) body.aigc_watermark = params.aigc_watermark;

				const payload = await requestJson<{
					data?: { audio?: string; subtitle_file?: string; status?: number };
					extra_info?: Record<string, unknown>;
					trace_id?: string;
				}>(cfg, { path: "/v1/t2a_v2", method: "POST", json: body, signal, timeoutMs: 600_000 });

				const dir = params.out_dir ?? cfg.outputDir;
				const saved = await saveAudioPayload(payload.data?.audio, {
					dir,
					stem: "speech",
					format,
					signal,
				});

				let subtitlePath: string | undefined;
				if (payload.data?.subtitle_file) {
					const savedSub = await downloadTo(payload.data.subtitle_file, {
						dir,
						stem: `speech-${nowStamp()}`,
						ext: ".json",
						signal,
					}).catch(() => undefined);
					subtitlePath = savedSub?.path;
				}

				const info = payload.extra_info ?? {};
				return textResult(
					fieldLines([
						["saved_to", saved?.path],
						["bytes", saved ? `${saved.bytes}B` : undefined],
						["format", format],
						["duration_ms", info.audio_length],
						["sample_rate", info.audio_sample_rate],
						["channels", info.channel],
						["bitrate", info.bitrate],
						["subtitle", subtitlePath],
						["trace_id", payload.trace_id],
						["chars", String(params.text.length)],
					]),
					{ saved_path: saved?.path, subtitle_path: subtitlePath, extra_info: info },
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `text to speech failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_speech_async",
		label: "MiniMax: async text to speech",
		description:
			"MiniMax 异步长文本语音合成（t2a_async_v2）。提交后轮询任务状态，完成后下载音频到本地。" +
			"适合超过 1 万字符的长文；结果文件保留 7 天。",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "文本内容（与 text_file 二选一）" })),
			text_file: Type.Optional(Type.String({ description: "长文本文件本地路径（与 text 二选一）" })),
			model: Type.Optional(
				Type.Union(TTS_MODELS.map((m) => Type.Literal(m)), { description: "默认 speech-2.6-hd" }),
			),
			...voiceSettingParams,
			format: Type.Optional(
				Type.Union(AUDIO_FORMATS.map((f) => Type.Literal(f)), { description: "音频格式，默认 mp3" }),
			),
			wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待完成，默认 true" })),
			timeout_s: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600, description: "等待超时秒数，默认 600" })),
			out_dir: Type.Optional(Type.String({ description: "保存目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				if (!params.text && !params.text_file) throw new Error("provide either text or text_file");
				const body: Record<string, unknown> = {
					model: params.model ?? "speech-2.6-hd",
					voice_setting: buildVoiceSetting(params),
					audio_setting: params.format ? { format: params.format } : { format: "mp3" },
				};
				if (params.text) body.text = params.text;
				if (params.language_boost) body.language_boost = params.language_boost;
				if (params.text_file) {
					const upload = await uploadFile(cfg, params.text_file, "t2a_async_input", signal);
					body.text_file_id = upload.fileId;
				}

				const created = await requestJson<{ task_id?: string; file_id?: number; task_token?: string }>(cfg, {
					path: "/v1/t2a_async_v2",
					method: "POST",
					json: body,
					signal,
				});
				const taskId = created.task_id;
				if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(created).slice(0, 500)}`);

				const deadline = Date.now() + (params.timeout_s ?? 600) * 1000;
				let status = "processing";
				let fileId = created.file_id;
				while (params.wait ?? true) {
					const poll = await requestJson<{ status?: string; file_id?: number }>(cfg, {
						path: "/v1/query/t2a_async_query_v2",
						query: { task_id: taskId },
						signal,
					});
					status = poll.status ?? status;
					fileId = poll.file_id ?? fileId;
					if (status !== "processing") break;
					if (Date.now() > deadline) {
						return failResult(
							fieldLines([
								["task_id", taskId],
								["status", "timeout"],
								["note", "poll again with minimax_speech_async_status? not available — re-query via task_id"],
							]),
							{ task_id: taskId, file_id: fileId },
						);
					}
					await delay(5_000, signal);
					await onUpdate?.({ content: [textBlock(`task ${taskId}: ${status}`)], details: null });
				}

				if (status === "success" && fileId !== undefined && (params.wait ?? true)) {
					const buffer = await fetchFileContent(cfg, fileId, signal);
					const saved = saveBuffer(buffer, {
						dir: params.out_dir ?? cfg.outputDir,
						stem: `speech-async-${nowStamp()}`,
						ext: audioExt(params.format),
					});
					return textResult(
						fieldLines([
							["task_id", taskId],
							["status", status],
							["saved_to", saved.path],
							["bytes", `${saved.bytes}B`],
							["file_id", fileId],
						]),
						{ task_id: taskId, file_id: fileId, saved_path: saved.path },
					);
				}

				return textResult(
					fieldLines([
						["task_id", taskId],
						["status", status],
						["file_id", fileId],
						["note", status === "success" ? undefined : "not finished / failed"],
					]),
					{ task_id: taskId, file_id: fileId },
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `async tts failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_transcribe",
		label: "MiniMax: speech to text",
		description:
			"MiniMax 语音转写（speech-2.5 / asr-1.0）。上传本地音频或给 URL，返回文本；" +
			"可选 json / verbose_json / srt / vtt 输出与句级或词级时间戳。",
		parameters: Type.Object({
			audio: Type.String({ description: "本地音频路径或 https URL" }),
			model: Type.Optional(Type.String({ description: "默认 asr-1.0" })),
			response_format: Type.Optional(
				Type.Union(["json", "verbose_json", "srt", "vtt"].map((f) => Type.Literal(f)), {
					description: "默认 json",
				}),
			),
			timestamp_level: Type.Optional(
				Type.Union(["", "sentence", "word"].map((f) => Type.Literal(f)), {
					description: "时间戳粒度（sentence / word）",
				}),
			),
			out_dir: Type.Optional(Type.String({ description: "srt/vtt 保存目录" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const { buffer, name } = await readAnyFile(params.audio, signal);
				const form = new FormData();
				form.append("model", params.model ?? "asr-1.0");
				form.append("file", new Blob([new Uint8Array(buffer)]), name || basename(params.audio) || "audio.mp3");
				if (params.response_format) form.append("response_format", params.response_format);
				if (params.timestamp_level) form.append("timestamp_level", params.timestamp_level);

				const response = await request(cfg, {
					path: "/v1/speech_to_text",
					method: "POST",
					form,
					signal,
					timeoutMs: 600_000,
				});
				const raw = await response.text();
				if (!response.ok) {
					throw new MinimaxError(`transcribe failed: HTTP ${response.status} ${truncate(raw, 800)}`, {
						httpStatus: response.status,
					});
				}

				const fmt: string = params.response_format ?? "json";
				if (fmt === "srt" || fmt === "vtt") {
					const saved = saveBuffer(Buffer.from(raw, "utf8"), {
						dir: params.out_dir ?? cfg.outputDir,
						stem: `transcript-${nowStamp()}`,
						ext: `.${fmt}`,
					});
					return textResult(`saved_to: ${saved.path}\n\n${truncate(raw, 4000)}`, { saved_path: saved.path });
				}

				const json = JSON.parse(raw) as {
					text?: string;
					duration?: number;
					n_speakers?: number;
					segments?: unknown[];
					trace_id?: string;
				};
				return textResult(
					fieldLines([
						["duration", json.duration !== undefined ? `${json.duration}s` : undefined],
						["speakers", json.n_speakers],
						["segments", json.segments ? String(json.segments.length) : undefined],
						["trace_id", json.trace_id],
					]) + `\n\n${json.text ?? ""}`,
					json,
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `transcribe failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_voice_clone",
		label: "MiniMax: clone voice",
		description:
			"用一段 10s~5min 的干净人声克隆音色（voice_clone）。音频会先上传（purpose=voice_clone）。" +
			"voice_id 需全局唯一（8~256 字符），返回试听音频本地路径。",
		parameters: Type.Object({
			audio: Type.String({ description: "音色样本：本地路径或 https URL" }),
			voice_id: Type.String({ description: "新音色 ID，8~256 字符，字母开头，唯一" }),
			text: Type.Optional(Type.String({ description: "复刻校验用的文本（可选）" })),
			model: Type.Optional(Type.String({ description: "默认 speech-2.6-hd" })),
			need_noise_reduction: Type.Optional(Type.Boolean({ description: "降噪，默认 true" })),
			need_volume_normalization: Type.Optional(Type.Boolean({ description: "音量归一化，默认 false" })),
			accuracy: Type.Optional(Type.Number({ description: "文本校验准确度阈值 0~1" })),
			language_boost: Type.Optional(Type.String({ description: "语言增强" })),
			out_dir: Type.Optional(Type.String({ description: "试听音频保存目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const { buffer, name } = await readAnyFile(params.audio, signal);
				const form = new FormData();
				form.append("purpose", "voice_clone");
				form.append("file", new Blob([new Uint8Array(buffer)]), name || "voice-sample.mp3");
				const uploaded = await requestJson<{ file?: { file_id?: number } }>(cfg, {
					path: "/v1/files/upload",
					method: "POST",
					form,
					signal,
					timeoutMs: 600_000,
				});
				const fileId = uploaded.file?.file_id;
				if (fileId === undefined) throw new Error("upload returned no file_id");

				const body: Record<string, unknown> = { file_id: fileId, voice_id: params.voice_id };
				if (params.text) body.text = params.text;
				if (params.model) body.model = params.model;
				if (params.accuracy !== undefined) body.accuracy = params.accuracy;
				if (params.need_noise_reduction !== undefined) body.need_noise_reduction = params.need_noise_reduction;
				if (params.need_volume_normalization !== undefined) {
					body.need_volume_normalization = params.need_volume_normalization;
				}
				if (params.language_boost) body.language_boost = params.language_boost;

				const payload = await requestJson<{ demo_audio?: string; input_sensitive?: boolean }>(cfg, {
					path: "/v1/voice_clone",
					method: "POST",
					json: body,
					signal,
					timeoutMs: 600_000,
				});
				const saved = await saveAudioPayload(payload.demo_audio, {
					dir: params.out_dir ?? cfg.outputDir,
					stem: `voice-clone-${params.voice_id}`,
					format: "mp3",
					signal,
				});
				return textResult(
					fieldLines([
						["voice_id", params.voice_id],
						["file_id", fileId],
						["input_sensitive", payload.input_sensitive],
						["demo_saved_to", saved?.path],
					]),
					{ voice_id: params.voice_id, file_id: fileId, demo_path: saved?.path },
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `voice clone failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_voice_design",
		label: "MiniMax: design voice",
		description: "用一段文字描述生成新音色（voice_design），返回 voice_id 与试听音频。",
		parameters: Type.Object({
			prompt: Type.String({ description: "音色描述，如「低沉沙哑的中年男声」" }),
			preview_text: Type.String({ description: "试听文本" }),
			voice_id: Type.Optional(Type.String({ description: "自定义音色 ID，可选" })),
			out_dir: Type.Optional(Type.String({ description: "试听音频保存目录" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const body: Record<string, unknown> = { prompt: params.prompt, preview_text: params.preview_text };
				if (params.voice_id) body.voice_id = params.voice_id;
				const payload = await requestJson<{ voice_id?: string; audio?: string }>(cfg, {
					path: "/v1/voice_design",
					method: "POST",
					json: body,
					signal,
					timeoutMs: 600_000,
				});
				const saved = await saveAudioPayload(payload.audio, {
					dir: params.out_dir ?? cfg.outputDir,
					stem: `voice-design-${payload.voice_id ?? "voice"}`,
					format: "mp3",
					signal,
				});
				return textResult(
					fieldLines([
						["voice_id", payload.voice_id],
						["preview_saved_to", saved?.path],
					]),
					{ voice_id: payload.voice_id, preview_path: saved?.path },
				);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `voice design failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_voice_list",
		label: "MiniMax: list voices",
		description: "列出可用音色（系统音色 / 已克隆 / 已设计）。",
		parameters: Type.Object({
			voice_type: Type.Optional(
				Type.Union(["system", "voice_cloning", "voice_generation", "all"].map((t) => Type.Literal(t)), {
					description: "默认 all",
				}),
			),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const payload = await requestJson<{
					system_voice?: Array<{ voice_id?: string; voice_name?: string; description?: string[] }>;
					voice_cloning?: Array<{ voice_id?: string; description?: string[]; created_time?: string }>;
					voice_generation?: Array<{ voice_id?: string; description?: string[]; created_time?: string }>;
				}>(cfg, {
					path: "/v1/get_voice",
					method: "POST",
					json: { voice_type: params.voice_type ?? "all" },
					signal,
				});
				const lines: string[] = [];
				const section = (title: string, items?: Array<{ voice_id?: string; voice_name?: string; description?: string[] }>) => {
					if (!items || items.length === 0) return;
					lines.push(`${title} (${items.length}):`);
					for (const item of items) {
						const desc = (item.description ?? []).join("；");
						lines.push(`- ${item.voice_id ?? "?"}${item.voice_name ? ` | ${item.voice_name}` : ""}${desc ? ` | ${truncate(desc, 80)}` : ""}`);
					}
				};
				section("system_voice", payload.system_voice);
				section("voice_cloning", payload.voice_cloning);
				section("voice_generation", payload.voice_generation);
				return textResult(lines.length > 0 ? lines.join("\n") : "no voices returned", payload);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `list voices failed: ${errorMessage(error)}`,
				);
			}
		},
	});

	pi.registerTool({
		name: "minimax_voice_delete",
		label: "MiniMax: delete voice",
		description: "删除已克隆（voice_cloning）或已设计（voice_generation）的音色。",
		parameters: Type.Object({
			voice_id: Type.String({ description: "要删除的音色 ID" }),
			voice_type: Type.Union([Type.Literal("voice_cloning"), Type.Literal("voice_generation")], {
				description: "音色类型",
			}),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const cfg = requireConfig();
				const payload = await requestJson<Record<string, unknown>>(cfg, {
					path: "/v1/delete_voice",
					method: "POST",
					json: { voice_id: params.voice_id, voice_type: params.voice_type },
					signal,
				});
				return textResult(fieldLines([["voice_id", params.voice_id], ["deleted", "ok"]]), payload);
			} catch (error) {
				return failResult(
					error instanceof MinimaxError ? error.describe() : `delete voice failed: ${errorMessage(error)}`,
				);
			}
		},
	});
}

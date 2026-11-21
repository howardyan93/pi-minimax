/**
 * File management tools: /v1/files/{upload,list,retrieve,retrieve_content,delete}
 *
 * Uploaded files are referenced from media fields as `mm_file://{file_id}` and
 * stay valid for 7 days.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { requestJson } from "../client.ts";
import { requireConfig } from "../config.ts";
import { downloadTo, extFromUrl, formatBytes, uploadFile } from "../media.ts";
import { errorMessage, failResult, fieldLines, nowStamp, textResult } from "../shared.ts";

const PURPOSES = [
	"voice_clone",
	"prompt_audio",
	"t2a_async_input",
	"video_understanding",
	"video_generation_input",
	"image_generation_input",
	"video_generation",
	"t2a_async",
] as const;

export function registerFileTools(pi: ExtensionAPI, namespace: ToolNamespace): void {
	pi.registerTool({
		name: "minimax_file_upload",
		label: "MiniMax: upload file",
		description:
			"把本地文件上传到 MiniMax 文件存储，返回 `mm_file://{file_id}`（有效期 7 天）。" +
			"用于给视频/图片/语音接口提供参考素材、音色复刻样本、异步 TTS 文本等。" +
			"purpose 决定分类：video_generation_input（视频生成素材，图片/视频/音频均可）、image_generation_input（图片生成参考图）、" +
			"voice_clone（音色复刻样本）、prompt_audio（复刻示例音频）、t2a_async_input（异步 TTS 文本）。",
		parameters: Type.Object({
			path: Type.String({ description: "本地文件绝对或相对路径" }),
			purpose: Type.Optional(
				Type.Union(
					PURPOSES.map((value) => Type.Literal(value)),
					{ description: "文件用途，默认 video_generation_input" },
				),
			),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			try {
				const cfg = requireConfig();
				const upload = await uploadFile(cfg, params.path, params.purpose ?? "video_generation_input", signal);
				return textResult(
					[
						`uploaded: ${upload.filename} (${formatBytes(upload.bytes)})`,
						`reference: ${upload.mmFileRef}`,
						"note: valid for 7 days; pass this string wherever a media URL is accepted.",
					].join("\n"),
					{ file_id: upload.fileId, bytes: upload.bytes, filename: upload.filename },
				);
			} catch (error) {
				return failResult(`upload failed: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "minimax_file_list",
		label: "MiniMax: list files",
		description: "列出 MiniMax 文件存储中某个 purpose 下的文件。",
		parameters: Type.Object({
			purpose: Type.Union(
				PURPOSES.map((value) => Type.Literal(value)),
				{ description: "文件分类" },
			),
			page_num: Type.Optional(Type.Integer({ minimum: 1, description: "页码，默认 1" })),
			page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每页数量，默认 20" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			try {
				const cfg = requireConfig();
				const json = await requestJson<{
					files?: Array<{ file_id?: number; filename?: string; bytes?: number; created_at?: number }>;
					total?: number;
				}>(cfg, {
					path: "/v1/files/list",
					query: { purpose: params.purpose, page_num: params.page_num, page_size: params.page_size ?? 20 },
					signal,
				});
				const files = json.files ?? [];
				if (files.length === 0) return textResult(`no files for purpose=${params.purpose}`, json);
				const lines = files.map(
					(file) =>
						`- ${file.file_id}  ${file.filename ?? "(unnamed)"}  ${formatBytes(file.bytes ?? 0)}  ${
							file.created_at ? new Date(file.created_at * 1000).toISOString() : ""
						}`,
				);
				return textResult(
					[`${files.length} file(s), total ${json.total ?? files.length}:`, ...lines].join("\n"),
					json,
				);
			} catch (error) {
				return failResult(`list files failed: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "minimax_file_get",
		label: "MiniMax: fetch file",
		description:
			"检索 MiniMax 文件元信息（含 download_url），并可把内容下载到本地目录。可用于取回异步 TTS 生成的音频。",
		parameters: Type.Object({
			file_id: Type.Integer({ description: "文件 ID" }),
			download: Type.Optional(Type.Boolean({ description: "是否下载到本地，默认 true" })),
			out_dir: Type.Optional(Type.String({ description: "下载目录，默认插件输出目录" })),
			stem: Type.Optional(Type.String({ description: "保存文件名（不含扩展名）" })),
		}),
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			try {
				const cfg = requireConfig();
				const json = await requestJson<{
					file?: { file_id?: number; filename?: string; bytes?: number; download_url?: string };
				}>(cfg, { path: "/v1/files/retrieve", query: { file_id: params.file_id }, signal });
				const file = json.file ?? {};
				const shouldDownload = params.download ?? true;
				let saved: string | undefined;
				if (shouldDownload && file.download_url) {
					const result = await downloadTo(file.download_url, {
						dir: params.out_dir ?? cfg.outputDir,
						stem: params.stem ?? `file-${params.file_id}-${nowStamp()}`,
						ext: file.filename ? extFromUrl(file.filename, ".bin") : undefined,
						signal,
					});
					saved = result.path;
				}
				return textResult(
					fieldLines([
						["file_id", file.file_id ?? params.file_id],
						["filename", file.filename],
						["bytes", file.bytes !== undefined ? formatBytes(file.bytes) : undefined],
						["download_url", file.download_url],
						["saved_to", saved],
					]),
					{ ...json, saved_path: saved },
				);
			} catch (error) {
				return failResult(`retrieve file failed: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "minimax_file_delete",
		label: "MiniMax: delete file",
		description: "删除 MiniMax 文件存储中的文件。",
		parameters: Type.Object({
			file_id: Type.Integer({ description: "文件 ID" }),
			purpose: Type.String({ description: "文件分类（需与上传时一致）" }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			try {
				const cfg = requireConfig();
				const json = await requestJson<{ base_resp?: unknown }>(cfg, {
					path: "/v1/files/delete",
					method: "POST",
					json: { file_id: params.file_id, purpose: params.purpose },
					signal,
				});
				return textResult(`deleted file_id=${params.file_id}`, json);
			} catch (error) {
				return failResult(`delete file failed: ${errorMessage(error)}`);
			}
		},
	});
}

/**
 * Local file handling: upload to MiniMax storage (`mm_file://`), inline as a
 * data URI, or download artifacts to disk.
 *
 * MiniMax media fields accept exactly three URL forms:
 *   - public https URL
 *   - `mm_file://{file_id}` (from POST /v1/files/upload, valid 7 days)
 *   - `data:<fmt>;base64,<payload>` (request body must stay under 64 MB)
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fetchBytes, requestJson } from "./client.ts";
import type { MinimaxConfig } from "./config.ts";

export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".hei": "image/heic",
	".heic": "image/heic",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".m4v": "video/x-m4v",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".opus": "audio/opus",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".srt": "text/plain",
	".vtt": "text/plain",
	".zip": "application/zip",
	".pdf": "application/pdf",
};

export function mimeOf(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function isRemoteRef(value: string): boolean {
	return /^(https?:\/\/|data:|mm_file:\/\/)/i.test(value);
}

export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return -1;
	}
}

export function readLocalFile(path: string): Buffer {
	if (!existsSync(path)) throw new Error(`local file not found: ${path}`);
	const stats = statSync(path);
	if (stats.isDirectory()) throw new Error(`expected a file, got a directory: ${path}`);
	return readFileSync(path);
}

export function toDataUri(path: string): string {
	const buffer = readLocalFile(path);
	const mime = mimeOf(path);
	return `data:${mime};base64,${buffer.toString("base64")}`;
}

export interface UploadResult {
	fileId: number;
	mmFileRef: string;
	bytes: number;
	filename: string;
	raw: unknown;
}

export async function uploadFile(
	cfg: MinimaxConfig,
	path: string,
	purpose: string,
	signal?: AbortSignal,
): Promise<UploadResult> {
	const buffer = readLocalFile(path);
	const filename = basename(path);
	const form = new FormData();
	form.append("purpose", purpose);
	form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeOf(path) }), filename);

	const json = await requestJson<{ file?: { file_id?: number; bytes?: number; filename?: string } }>(cfg, {
		path: "/v1/files/upload",
		method: "POST",
		form,
		signal,
		timeoutMs: 600_000,
	});

	const fileId = json.file?.file_id;
	if (typeof fileId !== "number") {
		throw new Error(`upload succeeded but no file_id returned: ${JSON.stringify(json).slice(0, 800)}`);
	}
	return {
		fileId,
		mmFileRef: `mm_file://${fileId}`,
		bytes: json.file?.bytes ?? buffer.byteLength,
		filename: json.file?.filename ?? filename,
		raw: json,
	};
}

export interface ResolveOptions {
	purpose: string;
	/** "file" uploads whenever possible; "inline" prefers data URIs for small files. */
	prefer?: "file" | "inline";
	signal?: AbortSignal;
	maxInlineBytes?: number;
	/** Upload destination override, reported back to the caller. */
	onUpload?: (upload: UploadResult, source: string) => void;
}

/**
 * Turn one user-supplied media reference into something MiniMax accepts.
 * Remote URLs and existing refs pass through untouched.
 */
export async function resolveRef(cfg: MinimaxConfig, value: string, options: ResolveOptions): Promise<string> {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("empty media reference");
	if (isRemoteRef(trimmed)) return trimmed;

	const size = fileSize(trimmed);
	if (size < 0) {
		throw new Error(
			`media reference is neither a URL (https://, data:, mm_file://) nor a readable local path: ${trimmed}`,
		);
	}

	const prefer = options.prefer ?? "file";
	const maxInline = options.maxInlineBytes ?? MAX_INLINE_BYTES;
	if (prefer === "inline" && size <= maxInline) return toDataUri(trimmed);

	const upload = await uploadFile(cfg, trimmed, options.purpose, options.signal);
	options.onUpload?.(upload, trimmed);
	return upload.mmFileRef;
}

export async function resolveRefs(
	cfg: MinimaxConfig,
	values: readonly string[] | undefined,
	options: ResolveOptions,
): Promise<string[]> {
	const out: string[] = [];
	for (const value of values ?? []) out.push(await resolveRef(cfg, value, options));
	return out;
}

export function ensureDir(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}

const EXT_BY_MIME: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"audio/mpeg": ".mp3",
	"audio/mp4": ".m4a",
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/flac": ".flac",
	"audio/ogg": ".ogg",
};

export function extFromUrl(url: string, fallback: string): string {
	try {
		const pathname = new URL(url).pathname;
		const ext = extname(pathname).toLowerCase();
		if (ext && ext.length <= 6) return ext;
	} catch {
		/* not a URL */
	}
	return fallback;
}

export interface SaveResult {
	path: string;
	bytes: number;
}

export function uniquePath(dir: string, stem: string, ext: string): string {
	ensureDir(dir);
	const safeStem = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 80) || "minimax";
	const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
	let path = join(dir, `${safeStem}${safeExt}`);
	let index = 1;
	while (existsSync(path)) {
		path = join(dir, `${safeStem}-${index}${safeExt}`);
		index += 1;
	}
	return path;
}

export async function downloadTo(
	url: string,
	options: { dir: string; stem: string; ext?: string; signal?: AbortSignal },
): Promise<SaveResult> {
	const ext = options.ext ?? extFromUrl(url, ".bin");
	const buffer = await fetchBytes(url, options.signal);
	const path = uniquePath(options.dir, options.stem, ext);
	writeFileSync(path, buffer);
	return { path, bytes: buffer.byteLength };
}

export function saveBuffer(buffer: Buffer, options: { dir: string; stem: string; ext: string }): SaveResult {
	const path = uniquePath(options.dir, options.stem, options.ext);
	writeFileSync(path, buffer);
	return { path, bytes: buffer.byteLength };
}

export function decodeHexAudio(hex: string): Buffer {
	return Buffer.from(hex, "hex");
}

export function saveDataUrl(dataUrl: string, options: { dir: string; stem: string }): SaveResult {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
	if (!match) throw new Error("unsupported data URL format");
	const mime = match[1] ?? "application/octet-stream";
	const isBase64 = Boolean(match[2]);
	const payload = match[3] ?? "";
	const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
	const ext = EXT_BY_MIME[mime] ?? extname(options.stem) ?? ".bin";
	return saveBuffer(buffer, { dir: options.dir, stem: options.stem, ext: ext || ".bin" });
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Read a media file as a Buffer, following http(s) URLs when needed. */
export async function readAnyFile(pathOrUrl: string, signal?: AbortSignal): Promise<{ buffer: Buffer; name: string }> {
	if (/^https?:\/\//i.test(pathOrUrl)) {
		const buffer = await fetchBytes(pathOrUrl, signal);
		return { buffer, name: basename(new URL(pathOrUrl).pathname) || "download" };
	}
	if (/^data:/i.test(pathOrUrl)) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(pathOrUrl);
		const buffer = match?.[2]
			? Buffer.from(match[3] ?? "", "base64")
			: Buffer.from(decodeURIComponent(match?.[3] ?? ""), "utf8");
		return { buffer, name: "inline" };
	}
	return { buffer: readLocalFile(pathOrUrl), name: basename(pathOrUrl) };
}

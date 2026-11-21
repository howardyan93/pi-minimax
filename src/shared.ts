/**
 * Small helpers shared by the tool modules: result shaping, formatting,
 * cancellation-aware sleeping.
 */
import { readFileSync } from "node:fs";

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type ResultBlock = TextBlock | ImageBlock;

export interface ToolResult {
	content: ResultBlock[];
	/** AgentToolResult requires a details field; pass whatever is useful for programmatic consumers. */
	details: unknown;
	isError?: boolean;
}

export function textBlock(text: string): TextBlock {
	return { type: "text", text };
}

export function imageBlockFromFile(path: string, mimeType: string): ImageBlock {
	return { type: "image", data: readFileSync(path).toString("base64"), mimeType };
}

export function textResult(text: string, details?: unknown): ToolResult {
	return { content: [textBlock(text)], details: details ?? null };
}

export function mixedResult(text: string, images: ImageBlock[], details?: unknown): ToolResult {
	return { content: [textBlock(text), ...images], details: details ?? null };
}

export function failResult(text: string, details?: unknown): ToolResult {
	return { content: [textBlock(text)], details: details ?? null, isError: true };
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted by caller"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted by caller"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function nowStamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

/** Render a label/value block, skipping empty values. */
export function fieldLines(pairs: Array<[string, unknown]>): string {
	const lines: string[] = [];
	for (const [label, value] of pairs) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		const rendered = Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
		lines.push(`${label}: ${rendered}`);
	}
	return lines.join("\n");
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

export function toArray(value: string | readonly string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim().length > 0);
	const single = String(value).trim();
	return single ? [single] : undefined;
}

/**
 * Thin HTTP client for the MiniMax open platform.
 *
 * MiniMax signals most errors inside a 200 response under `base_resp`
 * ({status_code, status_msg}), so every JSON call goes through
 * `assertBaseResp`. Image / ASR endpoints use an OpenAI-style `error`
 * object instead; both shapes are handled.
 */
import type { MinimaxConfig } from "./config.ts";

export interface ApiErrorPayload {
	status_code?: number;
	status_msg?: string;
	trace_id?: string;
}

export class MinimaxError extends Error {
	readonly httpStatus: number;
	readonly statusCode: number | undefined;
	readonly traceId: string | undefined;
	readonly body: unknown;

	constructor(
		message: string,
		options: { httpStatus?: number; statusCode?: number; traceId?: string; body?: unknown } = {},
	) {
		super(message);
		this.name = "MinimaxError";
		this.httpStatus = options.httpStatus ?? 0;
		this.statusCode = options.statusCode;
		this.traceId = options.traceId;
		this.body = options.body;
	}

	/** Compact multi-line rendering for the model. */
	describe(): string {
		const parts = [`MiniMax API error: ${this.message}`];
		if (this.httpStatus) parts.push(`http_status: ${this.httpStatus}`);
		if (this.statusCode !== undefined) parts.push(`status_code: ${this.statusCode}`);
		if (this.traceId) parts.push(`trace_id: ${this.traceId}`);
		if (this.body !== undefined) {
			let body = "";
			try {
				body = JSON.stringify(this.body);
			} catch {
				body = String(this.body);
			}
			if (body && body !== "{}") parts.push(`body: ${body.slice(0, 2000)}`);
		}
		return parts.join("\n");
	}
}

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

export interface ApiRequest {
	path: string;
	method?: "GET" | "POST" | "DELETE";
	query?: Record<string, QueryValue>;
	json?: unknown;
	form?: FormData;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Skip the base_resp check (used for raw file transfers). */
	raw?: boolean;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function buildUrl(cfg: MinimaxConfig, path: string, query?: Record<string, QueryValue>): URL {
	const url = new URL(`${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) url.searchParams.append(key, String(item));
		} else {
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
	const factory = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
	return typeof factory === "function" ? factory.call(AbortSignal, ms) : undefined;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((s): s is AbortSignal => Boolean(s));
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	const anyFactory = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFactory === "function") return anyFactory.call(AbortSignal, active);
	const controller = new AbortController();
	for (const signal of active) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

function errorFromBody(body: unknown, httpStatus: number): MinimaxError | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as Record<string, unknown>;

	const baseResp = record.base_resp as ApiErrorPayload | undefined;
	if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
		return new MinimaxError(baseResp.status_msg || `status_code ${baseResp.status_code}`, {
			httpStatus,
			statusCode: baseResp.status_code,
			traceId: baseResp.trace_id ?? (record.trace_id as string | undefined),
			body,
		});
	}

	const error = record.error as Record<string, unknown> | string | undefined;
	if (error) {
		const message =
			typeof error === "string" ? error : String(error.message ?? error.code ?? JSON.stringify(error));
		return new MinimaxError(message, {
			httpStatus,
			statusCode: typeof error === "object" ? Number(error.code) || undefined : undefined,
			traceId: record.request_id as string | undefined,
			body,
		});
	}
	return undefined;
}

export async function request(cfg: MinimaxConfig, req: ApiRequest): Promise<Response> {
	const method = req.method ?? (req.json || req.form ? "POST" : "GET");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cfg.apiKey}`,
		Accept: "application/json",
	};
	if (req.json !== undefined) headers["Content-Type"] = "application/json";

	const response = await fetch(buildUrl(cfg, req.path, req.query), {
		method,
		headers,
		body: req.json !== undefined ? JSON.stringify(req.json) : req.form,
		signal: combineSignals([req.signal, timeoutSignal(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)]),
	});
	return response;
}

/** Parse the body, raise on transport or MiniMax-level errors, return the JSON payload. */
export async function requestJson<T>(cfg: MinimaxConfig, req: ApiRequest): Promise<T> {
	const response = await request(cfg, req);
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = text;
	}

	if (!response.ok) {
		const parsed = errorFromBody(body, response.status);
		if (parsed) throw parsed;
		throw new MinimaxError(`HTTP ${response.status} ${response.statusText}`, {
			httpStatus: response.status,
			body: typeof body === "string" ? body.slice(0, 2000) : body,
		});
	}

	const parsed = errorFromBody(body, response.status);
	if (parsed) throw parsed;
	return body as T;
}

/** Download bytes from an arbitrary URL (artifact CDN links are pre-signed, no auth needed). */
export async function fetchBytes(url: string, signal?: AbortSignal, timeoutMs = 300_000): Promise<Buffer> {
	const response = await fetch(url, { signal: combineSignals([signal, timeoutSignal(timeoutMs)]) });
	if (!response.ok) {
		throw new MinimaxError(`download failed: HTTP ${response.status} ${response.statusText}`, {
			httpStatus: response.status,
		});
	}
	return Buffer.from(await response.arrayBuffer());
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal: combineSignals([signal, timeoutSignal(120_000)]) });
	if (!response.ok) {
		throw new MinimaxError(`download failed: HTTP ${response.status} ${response.statusText}`, {
			httpStatus: response.status,
		});
	}
	return await response.text();
}

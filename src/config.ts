/**
 * Configuration resolution for the MiniMax plugin.
 *
 * Order of precedence for the API key:
 *   1. env MINIMAX_API_KEY
 *   2. ~/.pi/agent/minimax.json  (or ~/.minimax.json) field "apiKey"
 *   3. ~/.pi/agent/mcp.json      -> any mcpServers.*.env.MINIMAX_API_KEY,
 *                                   but ONLY when MINIMAX_ALLOW_MCP_KEY=1 (opt-in)
 *
 * Base URL: env MINIMAX_API_BASE / MINIMAX_API_HOST, then config "baseUrl",
 * then https://api.minimax.cn
 *
 * Output dir: env MINIMAX_OUTPUT_DIR, then config "outputDir",
 * then ~/.pi/agent/artifacts/minimax
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MinimaxConfig {
	apiKey: string;
	apiKeySource: string;
	baseUrl: string;
	outputDir: string;
}

export const DEFAULT_BASE_URL = "https://api.minimax.cn";
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(PI_AGENT_DIR, "minimax.json");
export const MCP_PATH = join(PI_AGENT_DIR, "mcp.json");
/** Opt-in flag: reuse an MCP server's key without writing our own config file. */
export const MCP_FALLBACK_ENV = "MINIMAX_ALLOW_MCP_KEY";

type Json = Record<string, unknown>;

interface FileConfig {
	apiKey?: string;
	baseUrl?: string;
	outputDir?: string;
}

function readJson(path: string): Json | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
	} catch {
		return undefined;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function fileConfig(): { config: FileConfig; path?: string } {
	for (const path of [CONFIG_PATH, join(homedir(), ".minimax.json")]) {
		const json = readJson(path);
		if (json) return { config: json as FileConfig, path };
	}
	return { config: {} };
}

/**
 * Reading a credential out of an unrelated MCP server's config is convenient but
 * surprising, so it is opt-in: set MINIMAX_ALLOW_MCP_KEY=1 and the fallback
 * engages. Without the flag we never look inside mcp.json.
 */
export function mcpFallbackEnabled(): boolean {
	const raw = asString(process.env[MCP_FALLBACK_ENV])?.toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function keyFromMcpJson(): { key: string; server: string } | undefined {
	const json = readJson(MCP_PATH);
	const servers = json?.mcpServers;
	if (!servers || typeof servers !== "object") return undefined;
	for (const [name, raw] of Object.entries(servers as Json)) {
		if (!raw || typeof raw !== "object") continue;
		const env = (raw as Json).env;
		if (!env || typeof env !== "object") continue;
		const key = asString((env as Json).MINIMAX_API_KEY);
		if (key) return { key, server: name };
	}
	return undefined;
}

let cached: { at: number; config: MinimaxConfig } | undefined;

/** Resolve config (cached for 5s so env edits during a session are picked up). */
export function loadConfig(): MinimaxConfig {
	if (cached && Date.now() - cached.at < 5_000) return cached.config;

	const { config, path: configPath } = fileConfig();
	const envKey = asString(process.env.MINIMAX_API_KEY);
	const fromMcp = mcpFallbackEnabled() ? keyFromMcpJson() : undefined;
	const fileKey = asString(config.apiKey);

	const apiKey = envKey ?? fileKey ?? fromMcp?.key ?? "";
	const apiKeySource = envKey
		? "env MINIMAX_API_KEY"
		: fileKey
			? `config ${configPath}`
			: fromMcp
				? `mcp.json server "${fromMcp.server}" (${MCP_FALLBACK_ENV}=1)`
				: "not configured";

	const baseUrl =
		asString(process.env.MINIMAX_API_BASE) ??
		asString(process.env.MINIMAX_API_HOST) ??
		asString(config.baseUrl) ??
		DEFAULT_BASE_URL;

	const outputDir =
		asString(process.env.MINIMAX_OUTPUT_DIR) ??
		asString(config.outputDir) ??
		join(PI_AGENT_DIR, "artifacts", "minimax");

	const result: MinimaxConfig = { apiKey, apiKeySource, baseUrl: baseUrl.replace(/\/+$/, ""), outputDir };
	cached = { at: Date.now(), config: result };
	return result;
}

/** Throws a model-readable error explaining exactly how to configure the key. */
export function requireConfig(): MinimaxConfig {
	const config = loadConfig();
	if (!config.apiKey) {
		throw new Error(
			[
				"MINIMAX API key not found.",
				"Provide it in one of these ways:",
				"  1. export MINIMAX_API_KEY=sk-...        (recommended)",
				`  2. write {"apiKey": "sk-..."} to ${CONFIG_PATH}`,
				`  3. set ${MCP_FALLBACK_ENV}=1 to reuse mcpServers.<name>.env.MINIMAX_API_KEY from ${MCP_PATH}`,
			].join("\n"),
		);
	}
	return config;
}

/** Drop the 5s cache so a freshly saved key is used immediately. */
export function bustConfigCache(): void {
	cached = undefined;
}

/**
 * Persist the key (and optionally the base URL) to ~/.pi/agent/minimax.json.
 * Written with mode 0600 and re-chmoded so an existing looser file is tightened.
 * Other fields already in the file (baseUrl/outputDir) are preserved.
 */
export function saveKey(apiKey: string, baseUrl?: string): string {
	const path = CONFIG_PATH;
	const existing = readJson(path) ?? {};
	const next: Json = { ...existing, apiKey };
	if (baseUrl) next.baseUrl = baseUrl;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort — some filesystems (e.g. mounted FAT) refuse chmod
	}
	bustConfigCache();
	return path;
}

/** Remove the saved key; deletes the file when nothing else is left in it. */
export function clearSavedKey(): { path: string; removedFile: boolean; removedKey: boolean } {
	const path = CONFIG_PATH;
	if (!existsSync(path)) return { path, removedFile: false, removedKey: false };
	const existing = readJson(path) ?? {};
	const hadKey = asString(existing.apiKey) !== undefined;
	delete existing.apiKey;
	const remaining = Object.keys(existing);
	if (remaining.length === 0) {
		unlinkSync(path);
		bustConfigCache();
		return { path, removedFile: true, removedKey: hadKey };
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
	bustConfigCache();
	return { path, removedFile: false, removedKey: hadKey };
}

export function maskKey(key: string): string {
	if (key.length <= 8) return key ? "****" : "(empty)";
	return `${key.slice(0, 5)}…${key.slice(-4)} (${key.length} chars)`;
}

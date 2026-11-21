/**
 * Masked single-line prompt for secrets.
 *
 * `ctx.ui.input()` echoes what you type, which is the wrong thing for an API key
 * (it stays in the terminal scrollback). pi-tui's `Input` component has no mask
 * option either, so this is a deliberately tiny component: take over the screen
 * via `ctx.ui.custom()`, keep the value in memory, and render one bullet per
 * character.
 *
 * Only printable ASCII is accepted — API keys are ASCII, and doing our own
 * grapheme/IME handling for a 126-char token is not worth it.
 *
 * Note: the component is returned as an object literal (not a class instance).
 * pi feeds input to it fine either way, but only a literal gets re-rendered on
 * `tui.requestRender()`; a prototype-method component stayed frozen at its first
 * frame during testing.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

interface TuiLike {
	requestRender(force?: boolean): void;
}

export interface SecretPromptOptions {
	title: string;
	hint?: string;
	/** Characters shown unmasked at the end, so users can eyeball a paste. Default 4. */
	revealTail?: number;
}

/** Returns the trimmed value, or undefined when cancelled / not available. */
export async function askSecret(ctx: ExtensionCommandContext, options: SecretPromptOptions): Promise<string | undefined> {
	const { title, hint, revealTail = 4 } = options;

	// RPC can forward plain dialogs but not custom components; json/print have no
	// UI at all. Fall back to the visible input so the command still works.
	if (ctx.mode !== "tui") {
		const typed = await ctx.ui.input(title, "sk-...");
		const trimmed = (typed ?? "").trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	try {
		const value = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
			createMaskedInput(tui as TuiLike, done, { title, hint, revealTail }),
		);
		const trimmed = (value ?? "").trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function createMaskedInput(
	tui: TuiLike,
	done: (result: string | undefined) => void,
	options: { title: string; hint?: string; revealTail: number },
): Component {
	let value = "";
	let finished = false;

	const finish = (result: string | undefined) => {
		if (finished) return;
		finished = true;
		done(result);
	};

	const refresh = () => {
		tui.requestRender();
	};

	const render = (width: number): string[] => {
		const tail = options.revealTail > 0 ? value.slice(-options.revealTail) : "";
		const masked = "•".repeat(Math.max(0, value.length - tail.length));
		const lines = [
			"",
			`  ${options.title}`,
			"",
			`  > ${masked}${tail}\u2588`,
			"",
			`  ${value.length} chars`,
			`  ${options.hint ?? "Enter 保存 · Esc 取消 · 可直接粘贴"}`,
			"",
		];
		return lines.map((line) => truncate(line, width));
	};

	// pi's terminal layer delivers a clipboard paste as one chunk wrapped in the
	// bracketed-paste markers (\x1b[200~ … \x1b[201~). Without unwrapping it, the
	// whole chunk looks like a control sequence and gets dropped — which made
	// pasting a key impossible. Handle the wrapper, including chunks that split
	// it across reads, and keep the printable content.
	const PASTE_START = "\x1b[200~";
	const PASTE_END = "\x1b[201~";
	const MAX_LENGTH = 4096;

	let inPaste = false;
	let partial = "";

	const printable = (text: string): string =>
		[...text].filter((char) => char >= " " && char <= "~").join("");

	const append = (text: string) => {
		const clean = printable(text);
		if (clean.length === 0) return;
		value = (value + clean).slice(0, MAX_LENGTH);
		refresh();
	};

	/** Longest suffix of `text` that could be the start of `marker` (split reads). */
	const partialMarkerLength = (text: string, marker: string): number => {
		for (let size = Math.min(marker.length - 1, text.length); size > 0; size -= 1) {
			if (text.endsWith(marker.slice(0, size))) return size;
		}
		return 0;
	};

	const handleKey = (data: string) => {
		// Enter (Kitty protocol sends CSI 13 u, legacy sends CR/LF)
		if (data === "\r" || data === "\n" || data === "\x1b[13u") {
			finish(value);
			return;
		}
		// Escape / Ctrl-C
		if (data === "\x1b" || data === "\x03") {
			finish(undefined);
			return;
		}
		// Backspace (DEL, Ctrl-H, or Kitty CSI 127 u)
		if (data === "\x7f" || data === "\b" || data === "\x1b[127u") {
			value = value.slice(0, -1);
			refresh();
			return;
		}
		// Ctrl-U clears the line
		if (data === "\x15") {
			value = "";
			refresh();
			return;
		}
		// Ignore other control sequences (arrows, mouse, Kitty key releases).
		if (data.startsWith("\x1b")) return;
		append(data);
	};

	const handleInput = (data: string) => {
		if (finished) return;

		let rest = data;
		while (rest.length > 0) {
			if (!inPaste) {
				const start = rest.indexOf(PASTE_START);
				if (start < 0) {
					handleKey(rest);
					return;
				}
				if (start > 0) handleKey(rest.slice(0, start));
				rest = rest.slice(start + PASTE_START.length);
				inPaste = true;
				continue;
			}

			const end = rest.indexOf(PASTE_END);
			if (end < 0) {
				partial += rest;
				const keep = partialMarkerLength(partial, PASTE_END);
				append(partial.slice(0, partial.length - keep));
				partial = partial.slice(partial.length - keep);
				return;
			}
			append(partial + rest.slice(0, end));
			partial = "";
			inPaste = false;
			rest = rest.slice(end + PASTE_END.length);
		}
	};

	return {
		render,
		handleInput,
		invalidate: () => {},
		dispose: () => {
			finished = true;
		},
	};
}

function truncate(line: string, width: number): string {
	if (width <= 0) return "";
	return line.length <= width ? line : line.slice(0, Math.max(0, width - 1)) + "…";
}

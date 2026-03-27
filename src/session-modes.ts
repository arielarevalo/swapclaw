// ── Session modes ────────────────────────────────────────────────────

/** Available session modes. */
export type SessionMode = "code" | "ask" | "architect";

/** System prompt additions for each mode. */
const MODE_PROMPTS: Record<SessionMode, string> = {
	code: "You are in code mode. Write, edit, and execute code freely.",
	ask: "You are in ask mode. Answer questions about the codebase without modifying files.",
	architect: "You are in architect mode. Plan and design but do not write implementation code.",
};

/** All valid mode values. */
const VALID_MODES: ReadonlySet<string> = new Set<string>(["code", "ask", "architect"]);

/** Marker comments used to delimit the mode section in CLAUDE.md. */
export const MODE_MARKER_START = "<!-- SWAPCLAW_MODE -->";
export const MODE_MARKER_END = "<!-- /SWAPCLAW_MODE -->";

/** Return the system prompt preamble for the given mode. */
export function getModePreamble(mode: SessionMode): string {
	return MODE_PROMPTS[mode];
}

/** Type guard: returns true if `value` is a valid SessionMode. */
export function isValidMode(value: string): value is SessionMode {
	return VALID_MODES.has(value);
}

/**
 * Inject or replace the mode preamble section in a CLAUDE.md string.
 * Uses marker comments to identify the section.
 */
export function applyModeToClaude(content: string, mode: SessionMode): string {
	const modeBlock = `${MODE_MARKER_START}\n## Session Mode\n\n${getModePreamble(mode)}\n${MODE_MARKER_END}`;

	const markerRegex = new RegExp(
		`${escapeRegex(MODE_MARKER_START)}[\\s\\S]*?${escapeRegex(MODE_MARKER_END)}`,
	);

	if (markerRegex.test(content)) {
		return content.replace(markerRegex, modeBlock);
	}

	// No existing marker — append to the end.
	return `${content}\n\n${modeBlock}\n`;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * FastBlog Deadline Superman — Zero-Font 2-Bit Anti-Aliased Pixel Glyph Atlas & Presets
 *
 * Pure TypeScript, zero external dependencies, zero font files, zero WASM.
 * 100% compatible with Cloudflare Workers (workerd) and Node.js 20/24+.
 *
 * Each glyph is pre-rasterized with 4x supersampling into 2-bit alpha levels (0..3):
 *   0 = transparent (background)
 *   1 = 33% foreground blend
 *   2 = 66% foreground blend
 *   3 = 100% solid foreground
 */

export interface DeadlineGifPalette {
	id: string;
	label: string;
	outerBg: string;
	cardBg: string;
	cardBorder: string;
	digitFg: string;
	labelFg: string;
	colonAccent: string;
	expiredAccent: string;
}

export interface DeadlineExpiredPreset {
	id: string;
	label: string;
	text: string;
}

export const DEFAULT_DEADLINE_GIF_STYLE = "midnight-gold";
export const DEFAULT_DEADLINE_EXPIRED_PRESET = "offer_ended";

export const DEADLINE_GIF_PALETTES: Record<string, DeadlineGifPalette> = {
	"midnight-gold": {
		id: "midnight-gold",
		label: "深夜曜金 (預設)",
		outerBg: "#0F172A",
		cardBg: "#1E293B",
		cardBorder: "#334155",
		digitFg: "#FFFFFF",
		labelFg: "#FBBF24",
		colonAccent: "#F59E0B",
		expiredAccent: "#F59E0B",
	},
	"crimson-urgency": {
		id: "crimson-urgency",
		label: "限時搶購紅",
		outerBg: "#FFFFFF",
		cardBg: "#DC2626",
		cardBorder: "#B91C1C",
		digitFg: "#FFFFFF",
		labelFg: "#FEE2E2",
		colonAccent: "#DC2626",
		expiredAccent: "#DC2626",
	},
	"emerald-clean": {
		id: "emerald-clean",
		label: "清新翡翠綠",
		outerBg: "#FFFFFF",
		cardBg: "#065F46",
		cardBorder: "#047857",
		digitFg: "#FFFFFF",
		labelFg: "#A7F3D0",
		colonAccent: "#059669",
		expiredAccent: "#059669",
	},
	"indigo-pro": {
		id: "indigo-pro",
		label: "商務靛藍",
		outerBg: "#0F172A",
		cardBg: "#312E81",
		cardBorder: "#4338CA",
		digitFg: "#FFFFFF",
		labelFg: "#C7D2FE",
		colonAccent: "#818CF8",
		expiredAccent: "#818CF8",
	},
	"minimal-light": {
		id: "minimal-light",
		label: "極簡淺灰白",
		outerBg: "#FFFFFF",
		cardBg: "#F1F5F9",
		cardBorder: "#CBD5E1",
		digitFg: "#0F172A",
		labelFg: "#475569",
		colonAccent: "#64748B",
		expiredAccent: "#DC2626",
	},
};

export const DEADLINE_EXPIRED_PRESETS: Record<string, DeadlineExpiredPreset> = {
	offer_ended: {
		id: "offer_ended",
		label: "限時優惠已結束",
		text: "限時優惠已結束",
	},
	event_closed: {
		id: "event_closed",
		label: "活動已截止",
		text: "活動已截止",
	},
	reg_closed: {
		id: "reg_closed",
		label: "報名已結束",
		text: "報名已結束",
	},
};

export const DIGIT_GLYPH_WIDTH = 18;
export const DIGIT_GLYPH_HEIGHT = 28;
export const COLON_GLYPH_WIDTH = 6;
export const COLON_GLYPH_HEIGHT = 28;
export const ALARM_GLYPH_WIDTH = 22;
export const ALARM_GLYPH_HEIGHT = 22;
export const CJK_GLYPH_WIDTH = 16;
export const CJK_GLYPH_HEIGHT = 16;

export interface GlyphBitmap {
	width: number;
	height: number;
	/** 2-bit alpha values (0..3), length = width * height */
	pixels: Uint8Array;
}

/**
 * Packed 2-bit Base64 bitmaps (4 pixels per byte, MSB first).
 */
const RAW_DIGIT_GLYPHS_B64: Record<string, string> = {
	"0": "AAAAAAAAAQAAABv/gAAL//9AAv///QB//v/wC/4H/0D/wC/4H/gB/8L/QA/8P/QA/8P/AA/9P/AA/9P/AA/9P/AA/9P/AA/9P/QA/8L/QA/8L/gB/4H/wC/0D/4H/wB////QAv//+AAL//4AABv+QAAAAAAAAAAAAAAAAAAA",
	"1": "AAAAAAAAAFQAAAB/wAAAf/wAAH//wAA///wAA///wAA/7/wAA+T/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAAD/wAAACqgAAAAAAAAAAAAAAAAAAA",
	"2": "AAAAAAAABAAAAG//gAB///9AC////AC////gC5AL/wCQAD/wAAAD/0AAAD/wAAAH/wAAAP/gAAB//AAAH/9AAAv/0AAD//AAAP/4AAA//QAAC/8AAAD/wAAAH/6qqgL////wP////wP////wKqqqqgAAAAAAAAAAAAAAAAAA",
	"3": "AAAAAAAABAAAAb/+QAB///4AB///+AB/r//ABgAf/QAAAP/QAAAL/QAAAP/AAABv+AAP//4AAP//QAAP//kAAP//+AAAB//QAAAL/wAAAD/wAAAD/wAAAH/wHgAf/gH////QH///9AH///0ABv/5AAAAAAAAAAAAAAAAAAAA",
	"4": "AAAAAAAAAAAAAAAP+AAAAv/AAAA//AAAC//AAAH//AAAP//AAAv//AAB/7/AAD/b/AAL+L/AAf8L/AB/0L/AD/QL/AP+AL/Av/qv/pv////+v////+v////+AAAL/AAAAL/AAAAL/AAAAL/AAAAKqAAAAAAAAAAAAAAAAAAA",
	"5": "AAAAAAAAAAAAAv///QA////QA////QA////QA/1VVAA/wAAAA/wAAAB/wAAAB/1UAAB///kAB///9AC////QBqq//gAAAL/wAAAD/0AAAD/0AAAD/wAAAH/wDkAf/gD////AD///9AD///0ABv/5AAAAAAAAAAAAAAAAAAAA",
	"6": "AAAAAAAAABQAAAG//gAAv//gAD///gAP/+vgAv/QAQA/8AAAC/0AAAD/wAAAD/hvkAH/r//AH////wL////4L/4C/8L/wA/8H/gAv9H/gAv9D/gAv9D/wA/8B/8C/4A////wAf///QAH//9AAAv/gAAAAAAAAAAAAAAAAAAA",
	"7": "AAAAAAAAAAAAL////8L////8L////8L////8BVVW/0AAAD/wAAAL/QAAAP+AAAAv9AAAA/4AAAC/0AAAD/wAAAL/QAAAP/AAAAf+AAAAv9AAAA/8AAAB/8AAAC/4AAAD/0AAAD/wAAAH/wAAAGqgAAAAAAAAAAAAAAAAAAAA",
	"8": "AAAAAAAAAQAAAB//gAAP//9AA////QC/+v/wD/0C/0D/gB/0D/gA/0C/wC/wB/4H/gAf//+AAH//0AAL//9AB////gD/0H/0H/QA/8L/AAv8P/AAv8L/AA/8L/wC/8D/+v/0B////gAf//+AABv/gAAAAAAAAAAAAAAAAAAA",
	"9": "AAAAAAAAAAAAAC//QAAf//4AA///+AD/+v/QH/wH/wL/QC/0P/AB/4P/AA/4P/AB/8L/gC/8H/4L/8D////8B////8Af/9/4ABqQ/4AAAB/0AAAD/wAAAH/gCQAv/AC///+AC///4AC///QAAv/4AAAAAAAAAAAAAAAAAAAA",
};

const RAW_COLON_GLYPH_B64 = "AAAAAAAAAAAAAAL8f+v/f+GkAAAAAAAAAABQP9v/v/P9BQAAAAAAAAAA";

const RAW_ALARM_GLYPH_B64 =
	"AAAAAAAAAdAAdAAAfwAL4AAv0AA/wAvxv/S/ALi///bwAT/Ub9UAC9CwfwAB9A8A+AAvAPAHwAPQDwA9ADwA9APQA8AL4D4APQAv09AD4AAtfAAvAAAPwAD8AAL0AAf0Af4AAD///9AAD6//70AC4BZAfAAEAAABQA==";

const RAW_CJK_GLYPHS_B64: Record<string, string> = {
	天: "AAAAAAf//+AAAcAAAAGAAAACgAAAAoAAD///9AADwAAAB5AAAA0wAAAoKAAAsA4AB4AC0B0AAHgAAAAAAAAAAA==",
	時: "AAAAAAAADAAP9q6gDDauoAwwDAAMMq6QDrKqkA6wAMAMO//4DDAAwAwxwMAOsHDADrAQwAwQD8AAAAAAAAAAAA==",
	分: "AAAAAAAYPAAANAwAAHAGAADAA0ADQADAHaqqdACrq0QACgNAAAwDAAAcAwAAMAMAANAHAAdA/QAEAAAAAAAAAA==",
	秒: "AAAAAAB4DAAP0AwAAMDcwAHAzHAf+YwwAtNMKAP3DAAK3AwgDMAMMCTAANAAwANAAMAtAADG4AAAAQAAAAAAAA==",
	限: "AAAAAAvx/+AMMoBwDDKAcAyi//AMwoAwDKLqsAwy6pAMJogUDCaNcA3yh8AMAoKADAKY0AwC9CgAAAAAAAAAAA==",
	優: "AAAAAAGv//QCRXVAAw6qwAcOqsALDqrADy6q4Bd1UGQDHmWgAyXqMAMa6lADH0eAAxC9AAMq66QAAAAAAAAAAA==",
	惠: "AAAAAAABgAAf///0AAKAAAOq6sADqurAAwKAwAOr6sAAAYHAH///8AERQFADJODQDSQWMAQv/RQAAAAAAAAAAA==",
	已: "AAAAAA///9AAAACQAAAAkAEAAJADAACQA6qq0AOqqoADAAAAAwAAAAMAACgDAAAkAwAAMAL//+AAAAAAAAAAAA==",
	結: "AAAAAADADAABwAwAA0P/+AooDAAesAwABdL/8AKQAAAOfKqQH5nqsAiVgDAM3YAwHM3qsCiB6rAAAAAAAAAAAA==",
	束: "AAAAAAABgAAKquqkCqrqpAABgAAH///gBgGAoAYBgKAH///gAAvgAAApqAAAoYtAB0GB8BgBgCQAAAAAAAAAAA==",
	活: "AAAAAA4ABuACn/0AAEAkAAAAJAAcP//4AwAkAABAJAAACrqQAM6qsAJMAHADDABwDQ//8BgMAHAAAAAAAAAAAA==",
	動: "AAAAAAFbgwALtAMAH/+DAAAwL/AL/0MwDDKGMA//hjAMMokwC/9MMAa6TDAGulgwADF0MB/+c+AAAAAAAAAAAA==",
	截: "AAAAAAAoDIAL/9ygACgMIAAoDQAf///4AowJEAOvmmAPDAbQG66HwAMMA0ADrocYA66eqAMAAPAAAAAAAAAAAA==",
	止: "AAAAAAAAkAAAAJAAAICQAADAkAAAwKqgAMCqoADAkAAAwJAAAMCQAADAkAAAwJAAAcDQAB////gAAAAAAAAAAA==",
	報: "AAAAAADAv+AK6cAwCunAMADAw+Af/sAABxj/8AMk2DAf/cxwAMDMoBrpxsAa6cPAAMDH0ADA3DQAAAAAAAAAAA==",
	名: "AAAAAAADAAAAH//QALQBwAesBwAJCiwAAAPgAAAfQAAC///gHnAAcAAwAHAAMABwAD//8AAwAHAAAAAAAAAAAA==",
};

function unpack2BitBase64(b64: string, width: number, height: number): GlyphBitmap {
	const bin = atob(b64);
	const total = width * height;
	const pixels = new Uint8Array(total);
	let p = 0;
	for (let i = 0; i < bin.length && p < total; i++) {
		const byte = bin.charCodeAt(i);
		pixels[p++] = (byte >> 6) & 3;
		if (p < total) pixels[p++] = (byte >> 4) & 3;
		if (p < total) pixels[p++] = (byte >> 2) & 3;
		if (p < total) pixels[p++] = byte & 3;
	}
	return { width, height, pixels };
}

let decodedDigits: Record<string, GlyphBitmap> | null = null;
let decodedColon: GlyphBitmap | null = null;
let decodedAlarm: GlyphBitmap | null = null;
let decodedCjk: Record<string, GlyphBitmap> | null = null;

export function getDigitGlyph(digit: string): GlyphBitmap {
	if (!decodedDigits) {
		decodedDigits = {};
		for (const [k, b64] of Object.entries(RAW_DIGIT_GLYPHS_B64)) {
			decodedDigits[k] = unpack2BitBase64(b64, DIGIT_GLYPH_WIDTH, DIGIT_GLYPH_HEIGHT);
		}
	}
	return decodedDigits[digit] || decodedDigits["0"];
}

export function getColonGlyph(): GlyphBitmap {
	if (!decodedColon) {
		decodedColon = unpack2BitBase64(RAW_COLON_GLYPH_B64, COLON_GLYPH_WIDTH, COLON_GLYPH_HEIGHT);
	}
	return decodedColon;
}

export function getAlarmGlyph(): GlyphBitmap {
	if (!decodedAlarm) {
		decodedAlarm = unpack2BitBase64(RAW_ALARM_GLYPH_B64, ALARM_GLYPH_WIDTH, ALARM_GLYPH_HEIGHT);
	}
	return decodedAlarm;
}

export function getCjkGlyph(char: string): GlyphBitmap | null {
	if (!decodedCjk) {
		decodedCjk = {};
		for (const [k, b64] of Object.entries(RAW_CJK_GLYPHS_B64)) {
			decodedCjk[k] = unpack2BitBase64(b64, CJK_GLYPH_WIDTH, CJK_GLYPH_HEIGHT);
		}
	}
	return decodedCjk[char] || null;
}

export function resolveDeadlineGifPalette(style?: string): DeadlineGifPalette {
	const key = String(style || "").trim().toLowerCase();
	return DEADLINE_GIF_PALETTES[key] || DEADLINE_GIF_PALETTES[DEFAULT_DEADLINE_GIF_STYLE];
}

export function resolveDeadlineExpiredPreset(preset?: string): DeadlineExpiredPreset {
	const key = String(preset || "").trim().toLowerCase();
	return DEADLINE_EXPIRED_PRESETS[key] || DEADLINE_EXPIRED_PRESETS[DEFAULT_DEADLINE_EXPIRED_PRESET];
}

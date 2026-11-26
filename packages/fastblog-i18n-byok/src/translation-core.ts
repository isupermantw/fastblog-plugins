export const TRANSLATION_DEFAULT_MODEL = "gpt-6-luna";
export const TRANSLATION_DEFAULT_REASONING_EFFORT = "none";
export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALE_POOL = [
	"en",
	"zh-TW",
	"zh-CN",
	"ja",
	"ko",
	"es",
	"fr",
	"de",
] as const;

export interface LocaleMeta {
	code: string;
	nativeName: string;
	englishName: string;
	isCjk: boolean;
}

export const LOCALE_METADATA: Record<string, LocaleMeta> = {
	"zh-TW": { code: "zh-TW", nativeName: "繁體中文", englishName: "Traditional Chinese (Taiwan)", isCjk: true },
	"zh-CN": { code: "zh-CN", nativeName: "简体中文", englishName: "Simplified Chinese", isCjk: true },
	en: { code: "en", nativeName: "English", englishName: "English", isCjk: false },
	ja: { code: "ja", nativeName: "日本語", englishName: "Japanese", isCjk: true },
	ko: { code: "ko", nativeName: "한국어", englishName: "Korean", isCjk: true },
	es: { code: "es", nativeName: "Español", englishName: "Spanish", isCjk: false },
	fr: { code: "fr", nativeName: "Français", englishName: "French", isCjk: false },
	de: { code: "de", nativeName: "Deutsch", englishName: "German", isCjk: false },
};

export interface GlossaryEntry {
	id?: string;
	sourceTerm: string;
	targetTerm: string;
	lockExact?: boolean;
	notes?: string;
}

export interface PortableTextSegment {
	id: string;
	text: string;
	meta: Record<string, unknown>;
}

export interface PlaceholderToken {
	placeholder: string;
	original: string;
}

export interface TranslationUsage {
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	requests: number;
}

export const BUILTIN_TECH_LOCKS: GlossaryEntry[] = [
	{ sourceTerm: "EmDash", targetTerm: "EmDash", lockExact: true },
	{ sourceTerm: "PortableText", targetTerm: "PortableText", lockExact: true },
];

const SIMPLIFIED_RESIDUE_RE =
	/[们这为产发经动国开关进时对实说长体书车点问学业头边网线图设选认许语读调测验录]/;

const SIMPLIFIED_PHRASE_RESIDUE = [
	"数据",
	"數據",
	"视频",
	"視頻",
	"激活",
	"软件",
	"軟件",
	"默认",
	"默認",
	"服务器",
	"服務器",
	"博客",
	"程序",
	"点击这里",
	"内存",
	"內存",
	"硬盘",
	"硬盤",
	"网络",
	"登录",
];

function cloneJson<T>(value: T): T {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

function escapeRegExp(str: string): string {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function estimateTokenCount(text: unknown): number {
	const raw = String(text || "");
	if (!raw) return 0;
	let cjkCount = 0;
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0xac00 && code <= 0xd7af)
		) {
			cjkCount++;
		}
	}
	const otherCount = raw.length - cjkCount;
	return Math.ceil(cjkCount * 1.5 + otherCount / 3.6);
}

interface SpanMeta {
	index: number;
	_key?: string;
	marks: string[];
	originalText: string;
}

function coalesceBlockSpans(block: Record<string, unknown>): {
	combinedText: string;
	spans: SpanMeta[];
} {
	const children = Array.isArray(block?.children) ? block.children : [];
	if (children.length === 0) return { combinedText: "", spans: [] };

	const spans: SpanMeta[] = [];
	let combinedText = "";
	for (const rawChild of children) {
		if (!rawChild || typeof rawChild !== "object") continue;
		const child = rawChild as Record<string, unknown>;
		if (child._type !== "span" && typeof child.text !== "string") continue;
		const text = String(child.text ?? "");
		const marks = Array.isArray(child.marks)
			? (child.marks as unknown[]).filter((m): m is string => typeof m === "string" && m.length > 0)
			: [];
		if (!text) continue;
		if (marks.length === 0) {
			combinedText += text;
		} else {
			const spanIdx = spans.length;
			spans.push({
				index: spanIdx,
				_key: typeof child._key === "string" ? child._key : undefined,
				marks: [...marks],
				originalText: text,
			});
			combinedText += `<m${spanIdx}>${text}</m${spanIdx}>`;
		}
	}
	return { combinedText, spans };
}

function rebuildBlockSpans(
	translatedText: string,
	meta: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const originalChildren = Array.isArray(meta?.originalChildren)
		? (meta.originalChildren as Array<Record<string, unknown>>)
		: [];
	const metaSpans = Array.isArray(meta?.spans) ? (meta.spans as SpanMeta[]) : [];
	const spanMap = new Map<number, SpanMeta>(metaSpans.map((s) => [Number(s.index), s]));
	const text = String(translatedText ?? "");

	if (spanMap.size === 0) {
		const firstKey = typeof originalChildren[0]?._key === "string" ? originalChildren[0]._key : undefined;
		return [
			{
				_type: "span",
				...(firstKey ? { _key: firstKey } : {}),
				marks: [],
				text,
			},
		];
	}

	const result: Array<Record<string, unknown>> = [];
	const markerRe = /<m(\d+)>([\s\S]*?)<\/m\1>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	let spanSeq = 0;

	while ((match = markerRe.exec(text)) !== null) {
		if (match.index > lastIndex) {
			const plain = text.slice(lastIndex, match.index);
			if (plain) {
				result.push({ _type: "span", _key: `sp_${spanSeq++}`, marks: [], text: plain });
			}
		}
		const idx = Number(match[1]);
		const innerText = match[2] ?? "";
		const spec = spanMap.get(idx);
		if (innerText) {
			result.push({
				_type: "span",
				_key: spec?._key || `sp_${spanSeq++}`,
				marks: spec ? [...spec.marks] : [],
				text: innerText,
			});
		}
		lastIndex = markerRe.lastIndex;
	}

	if (lastIndex < text.length) {
		const tail = text.slice(lastIndex);
		if (tail) {
			result.push({ _type: "span", _key: `sp_${spanSeq++}`, marks: [], text: tail });
		}
	}

	if (result.length === 0) {
		return [
			{
				_type: "span",
				_key: "sp_0",
				marks: [],
				text: text.replace(/<\/?m\d+>/g, ""),
			},
		];
	}
	return result;
}

export function extractPortableTextSegments(blocksInput: unknown): {
	segments: PortableTextSegment[];
	blockCount: number;
} {
	if (!Array.isArray(blocksInput) || blocksInput.length === 0) {
		return { segments: [], blockCount: 0 };
	}

	const segments: PortableTextSegment[] = [];
	for (let bIdx = 0; bIdx < blocksInput.length; bIdx++) {
		const rawBlock = blocksInput[bIdx];
		if (!rawBlock || typeof rawBlock !== "object") continue;
		const block = rawBlock as Record<string, unknown>;
		const type = String(block._type || "block");

		if (type === "block" && Array.isArray(block.children)) {
			const { combinedText, spans } = coalesceBlockSpans(block);
			if (combinedText.trim()) {
				segments.push({
					id: `pt:${bIdx}`,
					text: combinedText,
					meta: { kind: "block", blockIndex: bIdx, spans, originalChildren: block.children },
				});
			}
			continue;
		}

		if (type === "table" && Array.isArray(block.rows)) {
			for (let rIdx = 0; rIdx < block.rows.length; rIdx++) {
				const row = block.rows[rIdx] as Record<string, unknown> | undefined;
				const cells = Array.isArray(row?.cells) ? row.cells : [];
				for (let cIdx = 0; cIdx < cells.length; cIdx++) {
					const cell = cells[cIdx];
					if (typeof cell === "string" && cell.trim()) {
						segments.push({
							id: `pt:${bIdx}:tbl:${rIdx}:${cIdx}`,
							text: cell,
							meta: { kind: "table_cell_string", blockIndex: bIdx, rowIndex: rIdx, cellIndex: cIdx },
						});
					} else if (Array.isArray(cell)) {
						const nested = extractPortableTextSegments(cell);
						for (const sub of nested.segments) {
							segments.push({
								id: `pt:${bIdx}:tbl:${rIdx}:${cIdx}:${sub.id}`,
								text: sub.text,
								meta: {
									kind: "table_cell_nested",
									blockIndex: bIdx,
									rowIndex: rIdx,
									cellIndex: cIdx,
									subMeta: sub.meta,
								},
							});
						}
					}
				}
			}
			continue;
		}

		for (const field of ["title", "caption", "alt"]) {
			const val = block[field];
			if (typeof val === "string" && val.trim()) {
				segments.push({
					id: `pt:${bIdx}:prop:${field}`,
					text: val,
					meta: { kind: "block_prop", blockIndex: bIdx, field },
				});
			}
		}
	}

	return { segments, blockCount: blocksInput.length };
}

export function applyPortableTextSegments(
	blocksInput: unknown,
	translatedById: Map<string, string> | Record<string, string>,
): Array<Record<string, unknown>> {
	if (!Array.isArray(blocksInput) || blocksInput.length === 0) return [];
	const getTranslated = (id: string) =>
		translatedById instanceof Map ? translatedById.get(id) : translatedById?.[id];

	const cloned = cloneJson(blocksInput) as Array<Record<string, unknown>>;
	const extracted = extractPortableTextSegments(blocksInput);

	for (const seg of extracted.segments) {
		const translatedText = getTranslated(seg.id);
		if (typeof translatedText !== "string") continue;
		const meta = seg.meta;
		const blockIdx = Number(meta.blockIndex);
		const targetBlock = cloned[blockIdx];
		if (!targetBlock) continue;

		if (meta.kind === "block") {
			targetBlock.children = rebuildBlockSpans(translatedText, meta);
		} else if (meta.kind === "table_cell_string") {
			const rows = targetBlock.rows as Array<{ cells?: unknown[] }> | undefined;
			const rowIdx = Number(meta.rowIndex);
			const cellIdx = Number(meta.cellIndex);
			if (rows?.[rowIdx]?.cells) {
				rows[rowIdx].cells[cellIdx] = translatedText;
			}
		} else if (meta.kind === "table_cell_nested") {
			const rows = targetBlock.rows as Array<{ cells?: unknown[] }> | undefined;
			const rowIdx = Number(meta.rowIndex);
			const cellIdx = Number(meta.cellIndex);
			const cellArr = rows?.[rowIdx]?.cells?.[cellIdx];
			const subMeta = meta.subMeta as Record<string, unknown> | undefined;
			if (Array.isArray(cellArr) && subMeta?.kind === "block") {
				const subBlock = cellArr[Number(subMeta.blockIndex)] as Record<string, unknown> | undefined;
				if (subBlock) {
					subBlock.children = rebuildBlockSpans(translatedText, subMeta);
				}
			}
		} else if (meta.kind === "block_prop") {
			targetBlock[String(meta.field)] = translatedText;
		}
	}

	return cloned;
}

export function maskPlaceholders(
	text: unknown,
	lockTerms: string[] = [],
): { maskedText: string; tokens: PlaceholderToken[] } {
	const raw = String(text ?? "");
	const tokens: PlaceholderToken[] = [];
	const pushToken = (original: string) => {
		const placeholder = `__PH_${tokens.length}__`;
		tokens.push({ placeholder, original });
		return placeholder;
	};

	let maskedText = raw;
	maskedText = maskedText.replace(/<\/?m\d+>/g, (m) => pushToken(m));
	maskedText = maskedText.replace(/\{\{[^{}]+\}\}/g, (m) => pushToken(m));
	maskedText = maskedText.replace(/\{[a-zA-Z0-9_.-]+\}/g, (m) => pushToken(m));
	maskedText = maskedText.replace(/%(?:\d+\$)?[sdif%]/g, (m) => pushToken(m));
	maskedText = maskedText.replace(/`[^`\n]+`/g, (m) => pushToken(m));
	maskedText = maskedText.replace(/https?:\/\/[^\s<>"')\]]+/g, (m) => pushToken(m));

	const cleanLocks = Array.from(
		new Set(
			(Array.isArray(lockTerms) ? lockTerms : [])
				.map((t) => String(t || "").trim())
				.filter((t) => t.length >= 2),
		),
	).sort((a, b) => b.length - a.length);

	if (cleanLocks.length > 0) {
		const phSplitRe = /(__PH_\d+__)/g;
		const termAlternation = cleanLocks.map((t) => escapeRegExp(t)).join("|");
		const termRe = new RegExp(termAlternation, "g");
		const parts = maskedText.split(phSplitRe);
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!part || /^__PH_\d+__$/.test(part)) continue;
			parts[i] = part.replace(termRe, (m) => pushToken(m));
		}
		maskedText = parts.join("");
	}

	return { maskedText, tokens };
}

export function unmaskAndValidateSegment(
	translatedMaskedText: unknown,
	tokens: PlaceholderToken[] = [],
	targetLocale = "",
): { ok: boolean; text?: string; reason?: string } {
	if (typeof translatedMaskedText !== "string") {
		return { ok: false, reason: "EMPTY_OR_NON_STRING" };
	}
	const trimmed = translatedMaskedText.trim();
	if (!trimmed && tokens.length === 0) {
		return { ok: false, reason: "EMPTY_TRANSLATION" };
	}

	const expectedCounts = new Map<string, number>();
	for (const t of tokens) {
		expectedCounts.set(t.placeholder, (expectedCounts.get(t.placeholder) || 0) + 1);
	}
	const actualMatches = translatedMaskedText.match(/__PH_\d+__/g) || [];
	const actualCounts = new Map<string, number>();
	for (const ph of actualMatches) {
		actualCounts.set(ph, (actualCounts.get(ph) || 0) + 1);
	}

	for (const [ph, expCnt] of expectedCounts.entries()) {
		if ((actualCounts.get(ph) || 0) !== expCnt) {
			return { ok: false, reason: "PLACEHOLDER_MISMATCH" };
		}
	}
	for (const ph of actualCounts.keys()) {
		if (!expectedCounts.has(ph)) {
			return { ok: false, reason: "PLACEHOLDER_MISMATCH" };
		}
	}

	let restored = translatedMaskedText;
	for (let i = tokens.length - 1; i >= 0; i--) {
		const { placeholder, original } = tokens[i]!;
		restored = restored.split(placeholder).join(original);
	}

	if (targetLocale === "zh-TW") {
		const visibleOnly = restored
			.replace(/<\/?m\d+>/g, "")
			.replace(/`[^`\n]+`/g, "")
			.replace(/https?:\/\/[^\s<>"')\]]+/g, "");
		if (SIMPLIFIED_RESIDUE_RE.test(visibleOnly)) {
			return { ok: false, reason: "ZH_TW_SIMPLIFIED_RESIDUE" };
		}
		for (const badPhrase of SIMPLIFIED_PHRASE_RESIDUE) {
			if (visibleOnly.includes(badPhrase)) {
				return { ok: false, reason: "ZH_TW_MAINLAND_LEXICON" };
			}
		}
	}

	return { ok: true, text: restored };
}

export function buildStaticGlossaryPrefix(opts: {
	sourceLocale?: string;
	targetLocale?: string;
	glossaryEntries?: GlossaryEntry[];
	tone?: string;
} = {}): string {
	const sourceLocale = opts.sourceLocale || DEFAULT_LOCALE;
	const targetLocale = opts.targetLocale || "zh-TW";
	const tone = opts.tone || "natural";
	const srcMeta = LOCALE_METADATA[sourceLocale] || { nativeName: sourceLocale, englishName: sourceLocale };
	const dstMeta = LOCALE_METADATA[targetLocale] || { nativeName: targetLocale, englishName: targetLocale };

	const merged: GlossaryEntry[] = [];
	const seen = new Set<string>();
	const customList = [...(opts.glossaryEntries || [])]
		.filter((g) => g?.sourceTerm && g?.targetTerm)
		.sort((a, b) => a.sourceTerm.localeCompare(b.sourceTerm));
	for (const item of customList) {
		const k = item.sourceTerm.trim();
		if (!k || seen.has(k)) continue;
		seen.add(k);
		merged.push({
			sourceTerm: k,
			targetTerm: item.targetTerm.trim(),
			lockExact: Boolean(item.lockExact),
			notes: item.notes?.trim() || "",
		});
	}
	for (const b of BUILTIN_TECH_LOCKS) {
		if (seen.has(b.sourceTerm)) continue;
		seen.add(b.sourceTerm);
		merged.push(b);
	}

	const glossaryLines = merged
		.map((g) => `- "${g.sourceTerm}" => "${g.targetTerm}"${g.lockExact ? " [KEEP EXACT]" : ""}${g.notes ? ` (${g.notes})` : ""}`)
		.join("\n");

	return [
		`You are a senior localization engineer and editorial translator for EmDash CMS sites.`,
		``,
		`## Translation Directive`,
		`- Source Language: ${srcMeta.englishName} (${sourceLocale})`,
		`- Target Language: ${dstMeta.englishName} (${targetLocale})`,
		`- Tone: ${tone}`,
		`- Return strict JSON matching: {"translations": [{"id": "<exact input id>", "text": "<translated text>"}]}.`,
		``,
		`## Structural & Placeholder Invariance`,
		`1. __PH_0__, __PH_1__, ... protect inline markers (<m0>...</m0>), template variables, code spans, URLs, and locked terms.`,
		`2. Every __PH_n__ token MUST appear with exact spelling and exact multiset count.`,
		`3. Keep numbers, currency symbols, dates, and URLs untouched.`,
		`4. For zh-TW targets, strictly use authentic Taiwanese Traditional Chinese (資料, 影片, 啟用, 軟體, 預設, 伺服器, 部落格, 程式, 網路, 登入) and zero Simplified characters.`,
		`5. For ja targets, use polite natural です・ます調 web copy.`,
		``,
		`## Brand & Site Glossary`,
		glossaryLines,
	].join("\n");
}

export function chunkSegments<T extends { text?: string; maskedText?: string; sourceText?: string }>(
	segments: T[],
	opts: { maxItems?: number; maxEstTokens?: number } = {},
): T[][] {
	const maxItems = opts.maxItems ?? 18;
	const maxEstTokens = opts.maxEstTokens ?? 4500;
	if (!Array.isArray(segments) || segments.length === 0) return [];
	const chunks: T[][] = [];
	let current: T[] = [];
	let currentTokens = 0;
	for (const seg of segments) {
		const est = Math.max(10, estimateTokenCount(seg?.text || seg?.maskedText || seg?.sourceText || ""));
		if (current.length > 0 && (current.length >= maxItems || currentTokens + est > maxEstTokens)) {
			chunks.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(seg);
		currentTokens += est;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

const STRICT_TRANSLATION_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["translations"],
	properties: {
		translations: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "text"],
				properties: {
					id: { type: "string" },
					text: { type: "string" },
				},
			},
		},
	},
};

export function buildOpenAiChatPayload(opts: {
	model: string;
	systemPrompt: string;
	items: Array<{ id: string; maskedText: string }>;
	reasoningEffort?: string;
}): Record<string, unknown> {
	const model = String(opts.model || TRANSLATION_DEFAULT_MODEL).trim() || TRANSLATION_DEFAULT_MODEL;
	const isReasoningFamily = /^gpt-[56]|^o\d/i.test(model);
	const effort = opts.reasoningEffort === "low" || opts.reasoningEffort === "medium" ? opts.reasoningEffort : "none";
	const userContent = JSON.stringify({
		items: opts.items.map((it) => ({ id: it.id, text: it.maskedText })),
	});

	const payload: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: opts.systemPrompt },
			{ role: "user", content: userContent },
		],
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "emdash_translation_batch",
				strict: true,
				schema: STRICT_TRANSLATION_JSON_SCHEMA,
			},
		},
	};
	if (isReasoningFamily) {
		payload.temperature = 1;
		payload.reasoning_effort = effort;
	} else {
		payload.temperature = 0.2;
	}
	return payload;
}

export async function translateSegmentsWithOpenAi(opts: {
	segments: Array<{ id: string; text: string }>;
	apiKey: string;
	model: string;
	sourceLocale: string;
	targetLocale: string;
	glossaryEntries?: GlossaryEntry[];
	tone?: string;
	reasoningEffort?: string;
	maxRetries?: number;
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{
	translatedMap: Map<string, string>;
	failedIds: string[];
	errors: Record<string, string>;
	usage: TranslationUsage;
}> {
	if (!opts.apiKey.trim()) {
		throw new Error("Missing OpenAI API key");
	}
	if (!Array.isArray(opts.segments) || opts.segments.length === 0) {
		return {
			translatedMap: new Map(),
			failedIds: [],
			errors: {},
			usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0 },
		};
	}

	const systemPrompt = buildStaticGlossaryPrefix({
		sourceLocale: opts.sourceLocale,
		targetLocale: opts.targetLocale,
		glossaryEntries: opts.glossaryEntries,
		tone: opts.tone,
	});
	const exactLocks = [
		...BUILTIN_TECH_LOCKS.filter((b) => b.lockExact).map((b) => b.sourceTerm),
		...(opts.glossaryEntries || []).filter((g) => g.lockExact).map((g) => g.sourceTerm),
	];

	const prepared = opts.segments.map((seg) => {
		const { maskedText, tokens } = maskPlaceholders(seg.text, exactLocks);
		return { id: String(seg.id), sourceText: String(seg.text ?? ""), maskedText, tokens };
	});

	const translatedMap = new Map<string, string>();
	const errors: Record<string, string> = {};
	const usage: TranslationUsage = {
		inputTokens: 0,
		cachedTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		requests: 0,
	};

	const maxRetries = opts.maxRetries ?? 2;
	let pending = prepared;
	for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
		const chunks = chunkSegments(pending);
		const nextPending: typeof prepared = [];

		for (const chunk of chunks) {
			const payload = buildOpenAiChatPayload({
				model: opts.model,
				systemPrompt,
				items: chunk.map((it) => ({ id: it.id, maskedText: it.maskedText })),
				reasoningEffort: opts.reasoningEffort,
			});

			let data: Record<string, unknown>;
			try {
				const res = await opts.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${opts.apiKey.trim()}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				});
				usage.requests += 1;
				if (!res.ok) {
					const errText = await res.text().catch(() => "");
					throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 180)}`);
				}
				data = (await res.json()) as Record<string, unknown>;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				for (const item of chunk) {
					errors[item.id] = msg;
					nextPending.push(item);
				}
				continue;
			}

			const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
			const rawContent = String((choices[0]?.message as Record<string, unknown> | undefined)?.content || "");
			let parsed: { translations?: Array<{ id?: string; text?: string }> } = {};
			try {
				parsed = JSON.parse(rawContent) as { translations?: Array<{ id?: string; text?: string }> };
			} catch {
				for (const item of chunk) {
					errors[item.id] = "INVALID_JSON_RESPONSE";
					nextPending.push(item);
				}
				continue;
			}

			const u = (data.usage || {}) as Record<string, unknown>;
			const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
			const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
			usage.inputTokens += inputTokens;
			usage.outputTokens += outputTokens;
			usage.totalTokens += Number(u.total_tokens ?? inputTokens + outputTokens);

			const returned = new Map<string, string>();
			for (const row of parsed.translations || []) {
				if (row && typeof row.id === "string" && typeof row.text === "string") {
					returned.set(row.id, row.text);
				}
			}

			for (const item of chunk) {
				const cand = returned.get(item.id);
				if (typeof cand !== "string") {
					errors[item.id] = "MISSING_ID";
					nextPending.push(item);
					continue;
				}
				const check = unmaskAndValidateSegment(cand, item.tokens, opts.targetLocale);
				if (!check.ok || typeof check.text !== "string") {
					errors[item.id] = check.reason || "VALIDATION_FAILED";
					nextPending.push(item);
					continue;
				}
				delete errors[item.id];
				translatedMap.set(item.id, check.text);
			}
		}

		pending = nextPending;
	}

	return {
		translatedMap,
		failedIds: pending.map((p) => p.id),
		errors,
		usage,
	};
}

export function slugifyLocalizedTitle(title: string, fallbackSlug: string, targetLocale = "en"): string {
	const raw = String(title || "").trim();
	const fallback = String(fallbackSlug || "").trim() || "post";
	if (!raw) return fallback;
	const meta = LOCALE_METADATA[targetLocale];
	if (meta && !meta.isCjk) {
		const ascii = raw
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96);
		if (ascii.length >= 2) return ascii;
	} else {
		const cjk = raw
			.replace(/[^\p{L}\p{N}\-_ ]+/gu, "")
			.trim()
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80);
		if (cjk.length >= 1) return cjk.toLowerCase();
	}
	return fallback;
}

export function estimateTranslationCost(opts: {
	segments: Array<{ id: string; text: string }>;
	sourceLocale?: string;
	targetLocale?: string;
	glossaryEntries?: GlossaryEntry[];
	tone?: string;
}): {
	segmentsCount: number;
	chunksCount: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	estimatedTotalTokens: number;
} {
	const active = opts.segments.filter((s) => String(s.text || "").trim());
	if (active.length === 0) {
		return { segmentsCount: 0, chunksCount: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0 };
	}
	const sysTokens = Math.max(512, estimateTokenCount(buildStaticGlossaryPrefix(opts)));
	const chunks = chunkSegments(active);
	const sourceTokens = active.reduce((sum, s) => sum + estimateTokenCount(s.text), 0);
	const estimatedInputTokens = sysTokens * chunks.length + sourceTokens;
	const estimatedOutputTokens = Math.ceil(sourceTokens * 1.15);
	return {
		segmentsCount: active.length,
		chunksCount: chunks.length,
		estimatedInputTokens,
		estimatedOutputTokens,
		estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
	};
}

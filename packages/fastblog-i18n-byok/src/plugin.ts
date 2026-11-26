import {
	pluginRoute,
	type PluginContext,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import type { CollectionSchemaInfo, PluginContentItem } from "emdash";
import {
	blocks,
	elements,
	type Block,
	type BlockInteraction,
	type BlockResponse,
	type ContentEditorPanelInteraction,
	type TableColumn,
} from "@emdash-cms/blocks/server";
import { z } from "zod";
import {
	buildGuideKitBlocks,
	buildLocaleSwitcherMenu,
	formatUiTemplate,
	handleGuideKitAction,
	loadGuideKitState,
	resolveSandboxUiLocale,
	UI_LOCALE_LABELS,
} from "../../../shared/block-guide-kit.js";
import { I18N_BYOK_MESSAGES, type I18nByokMsgKey } from "./i18n-messages.js";
import {
	applyPortableTextSegments,
	DEFAULT_LOCALE,
	estimateTranslationCost,
	extractPortableTextSegments,
	LOCALE_METADATA,
	slugifyLocalizedTitle,
	SUPPORTED_LOCALE_POOL,
	translateSegmentsWithOpenAi,
	TRANSLATION_DEFAULT_MODEL,
	TRANSLATION_DEFAULT_REASONING_EFFORT,
	type GlossaryEntry,
	type PortableTextSegment,
	type TranslationUsage,
} from "./translation-core.js";

const KV_GLOSSARY_KEY = "glossary:items";
const KV_TRANSLATED_COUNT_KEY = "stats:translated_count";
const KV_LAST_ESTIMATE_KEY = "ui:last_estimate";
const KV_LAST_QUEUE_KEY = "ui:last_queue";

interface LoadedByokSettings {
	openaiApiKey: string;
	model: string;
	sourceLocale: string;
	targetLocales: string[];
	tone: string;
	autoPublish: boolean;
	reasoningEffort: string;
}

interface QueueRow {
	id: string;
	collection: string;
	title: string;
	sourceLocale: string;
	targetLocale: string;
	status: string;
}

interface EstimateSummary {
	collection: string;
	entryId: string;
	targetLocale: string;
	segmentsCount: number;
	chunksCount: number;
	estimatedTotalTokens: number;
}

function parseLocaleCsv(raw: unknown, excludeLocale: string): string[] {
	const items = String(raw ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (item === excludeLocale || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

async function loadSettings(ctx: PluginContext): Promise<LoadedByokSettings> {
	const [
		rawKey,
		rawModel,
		rawCustomModel,
		rawSource,
		rawTargets,
		rawTone,
		rawAutoPub,
		rawEffort,
	] = await Promise.all([
		ctx.settings.get<string>("openaiApiKey").catch(() => ""),
		ctx.settings.get<string>("model").catch(() => TRANSLATION_DEFAULT_MODEL),
		ctx.settings.get<string>("customModel").catch(() => ""),
		ctx.settings.get<string>("sourceLocale").catch(() => ""),
		ctx.settings.get<string>("targetLocales").catch(() => "zh-TW,ja,es"),
		ctx.settings.get<string>("tone").catch(() => "natural"),
		ctx.settings.get<boolean>("autoPublish").catch(() => false),
		ctx.settings.get<string>("reasoningEffort").catch(() => TRANSLATION_DEFAULT_REASONING_EFFORT),
	]);

	const sourceLocale =
		(typeof rawSource === "string" && rawSource.trim()) ||
		ctx.site.locale ||
		DEFAULT_LOCALE;
	const customModel = typeof rawCustomModel === "string" ? rawCustomModel.trim() : "";
	const model =
		customModel ||
		(typeof rawModel === "string" && rawModel.trim()) ||
		TRANSLATION_DEFAULT_MODEL;
	const targetLocales = parseLocaleCsv(rawTargets ?? "zh-TW,ja,es", sourceLocale);

	return {
		openaiApiKey: typeof rawKey === "string" ? rawKey.trim() : "",
		model,
		sourceLocale,
		targetLocales,
		tone: typeof rawTone === "string" && rawTone.trim() ? rawTone.trim() : "natural",
		autoPublish: Boolean(rawAutoPub),
		reasoningEffort:
			rawEffort === "low" || rawEffort === "medium"
				? rawEffort
				: TRANSLATION_DEFAULT_REASONING_EFFORT,
	};
}

async function listGlossary(ctx: PluginContext): Promise<GlossaryEntry[]> {
	const stored = await ctx.kv.get<GlossaryEntry[]>(KV_GLOSSARY_KEY).catch(() => null);
	return Array.isArray(stored) ? stored : [];
}

async function incrementTranslatedCount(ctx: PluginContext, delta = 1): Promise<number> {
	const cur = Number((await ctx.kv.get<number>(KV_TRANSLATED_COUNT_KEY).catch(() => 0)) || 0);
	const next = cur + Math.max(1, delta);
	await ctx.kv.set(KV_TRANSLATED_COUNT_KEY, next);
	return next;
}

function isPortableTextArray(val: unknown): val is Array<Record<string, unknown>> {
	if (!Array.isArray(val) || val.length === 0) return false;
	const first = val[0];
	return Boolean(first && typeof first === "object" && "_type" in first);
}

function resolveTranslatableFieldSlugs(
	entry: PluginContentItem,
	colSchema: CollectionSchemaInfo | null,
): Set<string> {
	const allowed = new Set<string>();
	if (colSchema?.fields && colSchema.fields.length > 0) {
		for (const f of colSchema.fields) {
			if (f.translatable !== false) {
				allowed.add(f.slug);
			}
		}
	}
	if (allowed.size === 0) {
		for (const k of ["title", "excerpt", "summary", "subtitle", "content", "body", "description"]) {
			if (k in (entry.data || {})) allowed.add(k);
		}
	}
	return allowed;
}

function collectTranslatableSegmentsForEntry(
	entry: PluginContentItem,
	colSchema: CollectionSchemaInfo | null,
): {
	segments: Array<{ id: string; text: string }>;
	ptFields: Map<string, Array<Record<string, unknown>>>;
	stringFields: string[];
	titleField: string;
} {
	const fieldSlugs = resolveTranslatableFieldSlugs(entry, colSchema);
	const titleField = colSchema?.titleField || "title";
	const segments: Array<{ id: string; text: string }> = [];
	const ptFields = new Map<string, Array<Record<string, unknown>>>();
	const stringFields: string[] = [];

	const data = entry.data || {};
	for (const slug of fieldSlugs) {
		if (slug === "slug") continue;
		const val = data[slug];
		if (typeof val === "string" && val.trim()) {
			segments.push({ id: `field:${slug}`, text: val });
			stringFields.push(slug);
		} else if (isPortableTextArray(val)) {
			ptFields.set(slug, val);
			const extracted: { segments: PortableTextSegment[] } = extractPortableTextSegments(val);
			for (const ptSeg of extracted.segments) {
				segments.push({ id: `pt:${slug}:${ptSeg.id}`, text: ptSeg.text });
			}
		}
	}

	if (entry.seo) {
		if (typeof entry.seo.title === "string" && entry.seo.title.trim()) {
			segments.push({ id: "seo:title", text: entry.seo.title });
		}
		if (typeof entry.seo.description === "string" && entry.seo.description.trim()) {
			segments.push({ id: "seo:description", text: entry.seo.description });
		}
	}

	return { segments, ptFields, stringFields, titleField };
}

async function translateSingleEntry(
	ctx: PluginContext,
	opts: {
		collection: string;
		entryId: string;
		targetLocale: string;
		publishOverride?: boolean;
	},
): Promise<{
	id: string;
	slug: string | null;
	locale: string;
	action: "created" | "updated";
	published: boolean;
	usage: TranslationUsage;
}> {
	if (!ctx.content) {
		throw new Error("Missing content:read/write capability");
	}
	if (!ctx.http) {
		throw new Error("Missing network:request capability");
	}
	const settings = await loadSettings(ctx);
	if (!settings.openaiApiKey) {
		throw new Error("OpenAI API Key is missing. Configure it in plugin settings.");
	}

	const entry = await ctx.content.get(opts.collection, opts.entryId);
	if (!entry) {
		throw new Error(`Entry "${opts.entryId}" not found in "${opts.collection}"`);
	}

	const colSchema = ctx.schema
		? await ctx.schema.getCollection(opts.collection).catch(() => null)
		: null;
	const glossaryEntries = await listGlossary(ctx);
	const sourceLocale = entry.locale || settings.sourceLocale;

	const { segments, ptFields, stringFields, titleField } = collectTranslatableSegmentsForEntry(
		entry,
		colSchema,
	);
	if (segments.length === 0) {
		throw new Error("No translatable text fields or PortableText blocks found in entry");
	}

	const res = await translateSegmentsWithOpenAi({
		segments,
		apiKey: settings.openaiApiKey,
		model: settings.model,
		sourceLocale,
		targetLocale: opts.targetLocale,
		glossaryEntries,
		tone: settings.tone,
		reasoningEffort: settings.reasoningEffort,
		fetchImpl: (u, init) => ctx.http!.fetch(u, init),
	});

	if (res.failedIds.length > 0 && res.translatedMap.size === 0) {
		const firstErr = res.errors[res.failedIds[0]!] || "Translation failed";
		throw new Error(firstErr);
	}

	const nextData: Record<string, unknown> = { ...(entry.data || {}) };
	for (const slug of stringFields) {
		const translatedVal = res.translatedMap.get(`field:${slug}`);
		if (typeof translatedVal === "string") {
			nextData[slug] = translatedVal;
		}
	}
	for (const [slug, ptBlocks] of ptFields.entries()) {
		const ptMap = new Map<string, string>();
		const prefix = `pt:${slug}:`;
		for (const [k, v] of res.translatedMap.entries()) {
			if (k.startsWith(prefix)) {
				ptMap.set(k.slice(prefix.length), v);
			}
		}
		if (ptMap.size > 0) {
			nextData[slug] = applyPortableTextSegments(ptBlocks, ptMap);
		}
	}

	const translatedTitle =
		typeof nextData[titleField] === "string"
			? String(nextData[titleField])
			: String(nextData.title || "");
	if (translatedTitle || entry.slug) {
		nextData.slug = slugifyLocalizedTitle(
			translatedTitle,
			entry.slug || entry.id,
			opts.targetLocale,
		);
	}

	const writeInput: Record<string, unknown> & { seo?: Record<string, unknown> } = {
		...nextData,
	};
	if (colSchema?.hasSeo !== false && entry.seo) {
		const nextSeoTitle = res.translatedMap.get("seo:title") ?? entry.seo.title;
		const nextSeoDesc = res.translatedMap.get("seo:description") ?? entry.seo.description;
		writeInput.seo = {
			...(nextSeoTitle !== undefined ? { title: nextSeoTitle } : {}),
			...(nextSeoDesc !== undefined ? { description: nextSeoDesc } : {}),
		};
	}

	const existingTranslations = ctx.content.getTranslations
		? await ctx.content.getTranslations(opts.collection, opts.entryId).catch(() => null)
		: null;
	const existingTarget = existingTranslations?.translations?.find(
		(tr) => tr.locale === opts.targetLocale,
	);

	let saved: PluginContentItem;
	let action: "created" | "updated";
	if (existingTarget && ctx.content.update) {
		saved = await ctx.content.update(opts.collection, existingTarget.id, writeInput);
		action = "updated";
	} else if (ctx.content.create) {
		saved = await ctx.content.create(opts.collection, writeInput, {
			locale: opts.targetLocale,
			translationOf: opts.entryId,
		});
		action = "created";
	} else {
		throw new Error("Missing content:write capability");
	}

	let published = saved.status === "published";
	const wantPublish = opts.publishOverride ?? settings.autoPublish;
	if (wantPublish && !published && ctx.content.publish && ctx.content.getVersioned) {
		const ver = await ctx.content.getVersioned(opts.collection, saved.id).catch(() => null);
		if (ver?._rev) {
			const pubRes = await ctx.content.publish(opts.collection, saved.id, { _rev: ver._rev });
			published = pubRes.item.status === "published";
		}
	}

	await incrementTranslatedCount(ctx, 1);

	return {
		id: saved.id,
		slug: saved.slug,
		locale: opts.targetLocale,
		action,
		published,
		usage: res.usage,
	};
}

async function scanUntranslatedEntries(
	ctx: PluginContext,
	opts: { collection: string; targetLocale: string; limit?: number },
): Promise<QueueRow[]> {
	if (!ctx.content) return [];
	const scanLimit = Math.min(50, Math.max(10, Number(opts.limit || 20)));
	const listRes = await ctx.content.list(opts.collection, { limit: scanLimit });
	const out: QueueRow[] = [];

	for (const item of listRes.items || []) {
		const itemLocale = item.locale || ctx.site.locale || DEFAULT_LOCALE;
		if (itemLocale === opts.targetLocale) continue;
		const translations = ctx.content.getTranslations
			? await ctx.content.getTranslations(opts.collection, item.id).catch(() => null)
			: null;
		const alreadyHasTarget = Boolean(
			translations?.translations?.some((tr) => tr.locale === opts.targetLocale),
		);
		if (!alreadyHasTarget) {
			out.push({
				id: item.id,
				collection: opts.collection,
				title: String(item.data?.title || item.slug || item.id),
				sourceLocale: itemLocale,
				targetLocale: opts.targetLocale,
				status: item.status,
			});
		}
	}
	return out;
}

async function translateTaxonomiesBatch(
	ctx: PluginContext,
	opts: { taxonomy: string; targetLocale: string },
): Promise<{ translatedCount: number; skippedCount: number; usage: TranslationUsage }> {
	if (!ctx.taxonomies || !ctx.taxonomies.createTerm || !ctx.http) {
		throw new Error("Missing taxonomies:write or network:request capability");
	}
	const settings = await loadSettings(ctx);
	if (!settings.openaiApiKey) {
		throw new Error("OpenAI API Key is missing.");
	}
	const allTerms = await ctx.taxonomies.getTerms(opts.taxonomy);
	const groupsWithTarget = new Set<string>();
	for (const term of allTerms) {
		if (term.locale === opts.targetLocale && term.translationGroup) {
			groupsWithTarget.add(term.translationGroup);
		}
	}

	const missing = allTerms.filter(
		(t) =>
			t.locale !== opts.targetLocale &&
			!(t.translationGroup && groupsWithTarget.has(t.translationGroup)),
	);
	if (missing.length === 0) {
		return {
			translatedCount: 0,
			skippedCount: allTerms.length,
			usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0 },
		};
	}

	const glossaryEntries = await listGlossary(ctx);
	const segments: Array<{ id: string; text: string }> = [];
	for (const term of missing) {
		segments.push({ id: `tax:${term.id}:label`, text: term.label });
		const desc = typeof term.data?.description === "string" ? term.data.description : "";
		if (desc.trim()) {
			segments.push({ id: `tax:${term.id}:desc`, text: desc });
		}
	}

	const res = await translateSegmentsWithOpenAi({
		segments,
		apiKey: settings.openaiApiKey,
		model: settings.model,
		sourceLocale: settings.sourceLocale,
		targetLocale: opts.targetLocale,
		glossaryEntries,
		tone: settings.tone,
		reasoningEffort: settings.reasoningEffort,
		fetchImpl: (u, init) => ctx.http!.fetch(u, init),
	});

	let translatedCount = 0;
	for (const term of missing) {
		const newLabel = res.translatedMap.get(`tax:${term.id}:label`);
		if (!newLabel) continue;
		const newDesc = res.translatedMap.get(`tax:${term.id}:desc`);
		await ctx.taxonomies.createTerm(opts.taxonomy, {
			label: newLabel,
			slug: slugifyLocalizedTitle(newLabel, term.slug, opts.targetLocale),
			...(newDesc ? { description: newDesc } : {}),
			locale: opts.targetLocale,
			translationOf: term.id,
		});
		translatedCount++;
	}

	if (translatedCount > 0) {
		await incrementTranslatedCount(ctx, translatedCount);
	}

	return {
		translatedCount,
		skippedCount: allTerms.length - missing.length,
		usage: res.usage,
	};
}

async function renderAdminDashboard(
	routeCtx: Pick<SandboxedRouteContext, "ui"> | undefined,
	ctx: PluginContext,
	toast?: BlockResponse["toast"],
): Promise<BlockResponse> {
	const [settings, glossary, translatedCount, uiLocale, guideState, lastEstimate, lastQueue] =
		await Promise.all([
			loadSettings(ctx),
			listGlossary(ctx),
			ctx.kv.get<number>(KV_TRANSLATED_COUNT_KEY).catch(() => 0),
			resolveSandboxUiLocale(routeCtx, ctx),
			loadGuideKitState(ctx),
			ctx.kv.get<EstimateSummary>(KV_LAST_ESTIMATE_KEY).catch(() => null),
			ctx.kv.get<QueueRow[]>(KV_LAST_QUEUE_KEY).catch(() => null),
		]);

	const dict = I18N_BYOK_MESSAGES[uiLocale];
	const t = (key: I18nByokMsgKey, vars?: Record<string, string | number>) =>
		formatUiTemplate(dict[key], vars);

	const totalTranslated = Number(translatedCount || 0);
	const targetOptions = (
		settings.targetLocales.length > 0 ? settings.targetLocales : ["zh-TW", "ja", "es"]
	).map((code) => ({
		value: code,
		label: `${LOCALE_METADATA[code]?.nativeName || code} (${code})`,
	}));
	const defaultTarget = targetOptions[0]?.value || "zh-TW";
	const queueRows: QueueRow[] = Array.isArray(lastQueue) ? lastQueue : [];

	const screenBlocks: Block[] = [
		blocks.header(t("headerTitle")),
		blocks.section(t("headerDesc"), {
			accessory: buildLocaleSwitcherMenu(uiLocale, t("languageMenu")),
		}),
		blocks.actions([
			elements.button(
				"guide_start",
				guideState.activeStep > 0 ? t("replayTourBtn") : t("startTourBtn"),
				{ style: "secondary" },
			),
			elements.link(t("settingsBtn"), { kind: "plugin-settings" }, { appearance: "secondary" }),
		]),
		blocks.stats([
			{
				label: t("statModelLabel"),
				value: settings.model,
				description: t("statModelDesc"),
			},
			{
				label: t("statLocalesLabel"),
				value: settings.targetLocales.length,
				description: settings.targetLocales.join(", ") || t("statLocalesDesc"),
			},
			{
				label: t("statGlossaryLabel"),
				value: glossary.length,
				description: t("statGlossaryDesc"),
			},
		]),
	];

	if (!settings.openaiApiKey) {
		screenBlocks.push(
			blocks.banner({
				blockId: "missing_key_banner",
				variant: "alert",
				title: t("missingKeyTitle"),
				description: t("missingKeyDesc"),
			}),
		);
	}

	screenBlocks.push(
		...buildGuideKitBlocks({
			activeStep: guideState.activeStep,
			checklistCollapsed: guideState.checklistCollapsed,
			checklist: [
				{
					done: Boolean(settings.openaiApiKey),
					label: t("chkKeyTitle"),
					detail: settings.openaiApiKey
						? t("chkKeyDone", { model: settings.model })
						: t("chkKeyTodo"),
				},
				{
					done: settings.targetLocales.length > 0,
					label: t("chkTargetTitle"),
					detail:
						settings.targetLocales.length > 0
							? t("chkTargetDone", { locales: settings.targetLocales.join(", ") })
							: t("chkTargetTodo"),
				},
				{
					done: totalTranslated > 0,
					label: t("chkFirstTitle"),
					detail:
						totalTranslated > 0
							? t("chkFirstDone", { count: totalTranslated })
							: t("chkFirstTodo"),
				},
			],
			steps: [
				{ title: t("step1Title"), description: t("step1Desc") },
				{ title: t("step2Title"), description: t("step2Desc") },
				{ title: t("step3Title"), description: t("step3Desc") },
				{ title: t("step4Title"), description: t("step4Desc") },
			],
			faq: [
				{ q: t("faq1Q"), a: t("faq1A") },
				{ q: t("faq2Q"), a: t("faq2A") },
				{ q: t("faq3Q"), a: t("faq3A") },
			],
			labels: {
				checklistTitle: t("checklistTitle"),
				progressLabel: t("progressLabel"),
				tourButtonLabel: t("startTourBtn"),
				replayButtonLabel: t("replayTourBtn"),
				stepBadgePrefix: t("stepBadgePrefix"),
				prevLabel: t("prevBtn"),
				nextLabel: t("nextBtn"),
				finishLabel: t("finishBtn"),
				closeLabel: t("closeBtn"),
				faqTitle: t("faqTitle"),
			},
		}),
	);

	// Tab 1: Quick Translate & 0-LLM Cost Estimate
	const tab1Blocks: Block[] = [
		blocks.header(t("quickTranslateHeader")),
		blocks.context(t("quickTranslateDesc")),
	];
	if (lastEstimate) {
		tab1Blocks.push(
			blocks.banner({
				blockId: "estimate_result_banner",
				variant: "default",
				title: t("estimateBannerTitle", {
					collection: lastEstimate.collection,
					entryId: lastEstimate.entryId,
					targetLocale: lastEstimate.targetLocale,
				}),
				description: t("estimateBannerDesc", {
					segmentsCount: lastEstimate.segmentsCount,
					chunksCount: lastEstimate.chunksCount,
					estimatedTotalTokens: lastEstimate.estimatedTotalTokens,
				}),
			}),
		);
	}
	tab1Blocks.push(
		blocks.form({
			blockId: "quick_estimate_form",
			fields: [
				elements.textInput("collection", t("fieldCollection"), {
					initialValue: "posts",
					placeholder: "posts",
				}),
				elements.textInput("entryId", t("fieldEntryId"), {
					placeholder: "post_123",
				}),
				elements.select("targetLocale", t("fieldTargetLocale"), targetOptions, {
					initialValue: defaultTarget,
				}),
			],
			submit: {
				label: t("btnEstimate"),
				actionId: "estimate_entry",
			},
		}),
		blocks.form({
			blockId: "quick_translate_form",
			fields: [
				elements.textInput("collection", t("fieldCollection"), {
					initialValue: "posts",
					placeholder: "posts",
				}),
				elements.textInput("entryId", t("fieldEntryId"), {
					placeholder: "post_123",
				}),
				elements.select("targetLocale", t("fieldTargetLocale"), targetOptions, {
					initialValue: defaultTarget,
				}),
			],
			submit: {
				label: t("btnTranslateNow"),
				actionId: "translate_single",
			},
		}),
	);

	// Tab 2: Untranslated Queue & Batch (up to 5)
	const queueCols: TableColumn[] = [
		{ key: "title", label: t("colTitle") },
		{ key: "sourceLocale", label: t("colLocale"), format: "badge" },
		{ key: "status", label: t("colStatus"), format: "badge" },
		{ key: "translateBtn", label: t("colAction"), format: "element" },
	];
	const queueTableRows = queueRows.map((q) => ({
		id: q.id,
		title: `${q.title} (${q.collection}/${q.id} -> ${q.targetLocale})`,
		sourceLocale: q.sourceLocale,
		status: q.status,
		translateBtn: elements.button("translate_queue_row", t("btnTranslateRow"), {
			style: "primary",
			value: JSON.stringify({
				collection: q.collection,
				entryId: q.id,
				targetLocale: q.targetLocale,
			}),
		}),
	}));
	const tab2Blocks: Block[] = [
		blocks.header(t("queueHeader")),
		blocks.context(t("queueDesc")),
		blocks.form({
			blockId: "scan_queue_form",
			fields: [
				elements.textInput("collection", t("fieldCollection"), { initialValue: "posts" }),
				elements.select("targetLocale", t("fieldTargetLocale"), targetOptions, {
					initialValue: defaultTarget,
				}),
			],
			submit: {
				label: t("btnScanQueue"),
				actionId: "scan_queue",
			},
		}),
		blocks.actions([
			elements.button("translate_batch_5", t("btnTranslateBatch"), { style: "primary" }),
		]),
		blocks.table({
			blockId: "untranslated_queue_table",
			columns: queueCols,
			rows: queueTableRows,
			pageActionId: "queue_page",
			emptyText: t("queueEmpty"),
		}),
	];

	// Tab 3: Glossary
	const glossaryCols: TableColumn[] = [
		{ key: "sourceTerm", label: t("colSourceTerm") },
		{ key: "targetTerm", label: t("colTargetTerm") },
		{ key: "lockExact", label: t("colExact"), format: "badge" },
		{ key: "deleteBtn", label: t("colDelete"), format: "element" },
	];
	const glossaryRows = glossary.map((g, idx) => ({
		id: g.id || String(idx),
		sourceTerm: g.sourceTerm,
		targetTerm: g.targetTerm,
		lockExact: g.lockExact ? "LOCKED" : "HINT",
		deleteBtn: elements.button("delete_glossary", t("btnDelete"), {
			style: "danger",
			value: g.sourceTerm,
		}),
	}));
	const tab3Blocks: Block[] = [
		blocks.header(t("glossaryHeader")),
		blocks.form({
			blockId: "glossary_form",
			fields: [
				elements.textInput("sourceTerm", t("fieldSourceTerm"), { placeholder: "Cloudflare Workers" }),
				elements.textInput("targetTerm", t("fieldTargetTerm"), { placeholder: "Cloudflare Workers" }),
				elements.toggle("lockExact", t("fieldLockExact"), { initialValue: true }),
			],
			submit: {
				label: t("btnSaveGlossary"),
				actionId: "save_glossary",
			},
		}),
		blocks.table({
			blockId: "glossary_table",
			columns: glossaryCols,
			rows: glossaryRows,
			pageActionId: "glossary_page",
			emptyText: t("glossaryEmpty"),
		}),
	];

	// Tab 4: Taxonomies
	const tab4Blocks: Block[] = [
		blocks.header(t("taxHeader")),
		blocks.context(t("taxDesc")),
		blocks.form({
			blockId: "taxonomy_translate_form",
			fields: [
				elements.textInput("taxonomy", t("fieldTaxonomy"), { initialValue: "category" }),
				elements.select("targetLocale", t("fieldTargetLocale"), targetOptions, {
					initialValue: defaultTarget,
				}),
			],
			submit: {
				label: t("btnTranslateTax"),
				actionId: "translate_taxonomies",
			},
		}),
	];

	screenBlocks.push(
		blocks.divider(),
		blocks.tab([
			{ label: t("tabOverview"), blocks: tab1Blocks },
			{ label: t("tabQueue"), blocks: tab2Blocks },
			{ label: t("tabGlossary"), blocks: tab3Blocks },
			{ label: t("tabTaxonomies"), blocks: tab4Blocks },
		]),
		blocks.context(t("footerNote")),
	);

	return {
		blocks: screenBlocks,
		...(toast ? { toast } : {}),
	};
}

async function renderEditorPanel(
	routeCtx: SandboxedRouteContext,
	ctx: PluginContext,
	toast?: BlockResponse["toast"],
): Promise<BlockResponse> {
	const [settings, uiLocale] = await Promise.all([
		loadSettings(ctx),
		resolveSandboxUiLocale(routeCtx, ctx),
	]);
	const dict = I18N_BYOK_MESSAGES[uiLocale];
	const t = (key: I18nByokMsgKey, vars?: Record<string, string | number>) =>
		formatUiTemplate(dict[key], vars);

	const entryRef = routeCtx.ui?.surface === "content-editor-panel" ? routeCtx.ui.entry : undefined;
	const out: Block[] = [blocks.header(t("panelTitle"))];

	if (!settings.openaiApiKey) {
		out.push(
			blocks.banner({
				variant: "alert",
				title: t("missingKeyTitle"),
				description: t("missingKeyDesc"),
			}),
		);
	}

	if (!entryRef || !ctx.content) {
		out.push(blocks.context(t("panelNoTargetLocales")));
		return { blocks: out, ...(toast ? { toast } : {}) };
	}

	const transInfo = ctx.content.getTranslations
		? await ctx.content.getTranslations(entryRef.collection, entryRef.id).catch(() => null)
		: null;
	const existing = transInfo?.translations || [];
	const srcLocale = entryRef.locale || settings.sourceLocale;
	const targetList = settings.targetLocales.filter((loc) => loc !== srcLocale);

	if (targetList.length === 0) {
		out.push(blocks.context(t("panelNoTargetLocales")));
		return { blocks: out, ...(toast ? { toast } : {}) };
	}

	const existingByLocale = new Map(existing.map((tr) => [tr.locale || "", tr]));
	const doneCount = targetList.filter((loc) => existingByLocale.has(loc)).length;
	out.push(
		blocks.context(
			t("panelStats", { doneCount, totalCount: targetList.length, sourceLocale: srcLocale }),
		),
	);

	const actionElements = [];
	for (const loc of targetList) {
		const hit = existingByLocale.get(loc);
		if (hit) {
			actionElements.push(
				elements.link(t("panelBtnEdit", { locale: loc }), {
					kind: "content",
					collection: entryRef.collection,
					id: hit.id,
					locale: loc,
				}),
			);
		} else {
			actionElements.push(
				elements.button("panel_translate_locale", t("panelBtnTranslate", { locale: loc }), {
					style: "primary",
					value: loc,
				}),
			);
		}
	}
	out.push(blocks.actions(actionElements));

	return {
		blocks: out,
		...(toast ? { toast } : {}),
	};
}

const plugin: SandboxedPlugin = {
	routes: {
		admin: pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const interaction = (routeCtx.input ?? {
					type: "page_load",
					page: "/translate",
				}) as BlockInteraction;

				const guideResult = await handleGuideKitAction(interaction, ctx, 4);
				if (guideResult.handled) {
					const loc = await resolveSandboxUiLocale(routeCtx, ctx);
					const t = (key: I18nByokMsgKey, vars?: Record<string, string | number>) =>
						formatUiTemplate(I18N_BYOK_MESSAGES[loc][key], vars);
					let toast: BlockResponse["toast"] | undefined;
					if (guideResult.localeChangedTo) {
						toast = {
							message: t("toastLocaleChanged", {
								locale: UI_LOCALE_LABELS[guideResult.localeChangedTo],
							}),
							type: "success",
						};
					} else if (guideResult.guideCompleted) {
						toast = { message: t("toastGuideFinished"), type: "success" };
					}
					return renderAdminDashboard(routeCtx, ctx, toast);
				}

				const uiLocale = await resolveSandboxUiLocale(routeCtx, ctx);
				const t = (key: I18nByokMsgKey, vars?: Record<string, string | number>) =>
					formatUiTemplate(I18N_BYOK_MESSAGES[uiLocale][key], vars);

				try {
					if (interaction.type === "form_submit" && interaction.action_id === "estimate_entry") {
						const v = interaction.values || {};
						const collection = String(v.collection || "posts").trim() || "posts";
						const entryId = String(v.entryId || "").trim();
						const targetLocale = String(v.targetLocale || "zh-TW").trim();
						if (!entryId || !ctx.content) {
							return renderAdminDashboard(routeCtx, ctx, {
								message: "Missing entryId",
								type: "error",
							});
						}
						const entry = await ctx.content.get(collection, entryId);
						if (!entry) {
							return renderAdminDashboard(routeCtx, ctx, {
								message: `Entry not found: ${entryId}`,
								type: "error",
							});
						}
						const settings = await loadSettings(ctx);
						const colSchema = ctx.schema
							? await ctx.schema.getCollection(collection).catch(() => null)
							: null;
						const { segments } = collectTranslatableSegmentsForEntry(entry, colSchema);
						const glossary = await listGlossary(ctx);
						const est = estimateTranslationCost({
							segments,
							sourceLocale: entry.locale || settings.sourceLocale,
							targetLocale,
							glossaryEntries: glossary,
							tone: settings.tone,
						});
						await ctx.kv.set(KV_LAST_ESTIMATE_KEY, {
							collection,
							entryId,
							targetLocale,
							segmentsCount: est.segmentsCount,
							chunksCount: est.chunksCount,
							estimatedTotalTokens: est.estimatedTotalTokens,
						} satisfies EstimateSummary);
						return renderAdminDashboard(routeCtx, ctx);
					}

					if (interaction.type === "form_submit" && interaction.action_id === "translate_single") {
						const v = interaction.values || {};
						const collection = String(v.collection || "posts").trim() || "posts";
						const entryId = String(v.entryId || "").trim();
						const targetLocale = String(v.targetLocale || "zh-TW").trim();
						const out = await translateSingleEntry(ctx, { collection, entryId, targetLocale });
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastTranslated", { locale: out.locale, id: out.id }),
							type: "success",
						});
					}

					if (interaction.type === "form_submit" && interaction.action_id === "scan_queue") {
						const v = interaction.values || {};
						const collection = String(v.collection || "posts").trim() || "posts";
						const targetLocale = String(v.targetLocale || "zh-TW").trim();
						const rows = await scanUntranslatedEntries(ctx, { collection, targetLocale, limit: 20 });
						await ctx.kv.set(KV_LAST_QUEUE_KEY, rows);
						return renderAdminDashboard(routeCtx, ctx);
					}

					if (interaction.type === "block_action" && interaction.action_id === "translate_queue_row") {
						const payload = JSON.parse(String(interaction.value || "{}")) as {
							collection: string;
							entryId: string;
							targetLocale: string;
						};
						const out = await translateSingleEntry(ctx, payload);
						const prevQueue = (await ctx.kv.get<QueueRow[]>(KV_LAST_QUEUE_KEY).catch(() => [])) || [];
						await ctx.kv.set(
							KV_LAST_QUEUE_KEY,
							prevQueue.filter((q) => !(q.id === payload.entryId && q.targetLocale === payload.targetLocale)),
						);
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastTranslated", { locale: out.locale, id: out.id }),
							type: "success",
						});
					}

					if (interaction.type === "block_action" && interaction.action_id === "translate_batch_5") {
						const prevQueue = (await ctx.kv.get<QueueRow[]>(KV_LAST_QUEUE_KEY).catch(() => [])) || [];
						const batch = prevQueue.slice(0, 5);
						let okCount = 0;
						for (const item of batch) {
							await translateSingleEntry(ctx, {
								collection: item.collection,
								entryId: item.id,
								targetLocale: item.targetLocale,
							});
							okCount++;
						}
						await ctx.kv.set(KV_LAST_QUEUE_KEY, prevQueue.slice(okCount));
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastBatchDone", { count: okCount }),
							type: "success",
						});
					}

					if (interaction.type === "form_submit" && interaction.action_id === "save_glossary") {
						const v = interaction.values || {};
						const sourceTerm = String(v.sourceTerm || "").trim();
						const targetTerm = String(v.targetTerm || "").trim();
						const lockExact = Boolean(v.lockExact);
						if (!sourceTerm || !targetTerm) {
							return renderAdminDashboard(routeCtx, ctx, {
								message: "Source and target terms are required.",
								type: "error",
							});
						}
						const list = await listGlossary(ctx);
						const filtered = list.filter((g) => g.sourceTerm !== sourceTerm);
						filtered.unshift({ sourceTerm, targetTerm, lockExact });
						await ctx.kv.set(KV_GLOSSARY_KEY, filtered);
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastGlossarySaved", { source: sourceTerm, target: targetTerm }),
							type: "success",
						});
					}

					if (interaction.type === "block_action" && interaction.action_id === "delete_glossary") {
						const sourceTerm = String(interaction.value || "").trim();
						const list = await listGlossary(ctx);
						await ctx.kv.set(
							KV_GLOSSARY_KEY,
							list.filter((g) => g.sourceTerm !== sourceTerm),
						);
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastGlossaryDeleted"),
							type: "info",
						});
					}

					if (interaction.type === "form_submit" && interaction.action_id === "translate_taxonomies") {
						const v = interaction.values || {};
						const taxonomy = String(v.taxonomy || "category").trim() || "category";
						const targetLocale = String(v.targetLocale || "zh-TW").trim();
						const out = await translateTaxonomiesBatch(ctx, { taxonomy, targetLocale });
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastTaxDone", {
								taxonomy,
								count: out.translatedCount,
								locale: targetLocale,
							}),
							type: "success",
						});
					}
				} catch (err) {
					return renderAdminDashboard(routeCtx, ctx, {
						message: err instanceof Error ? err.message : String(err),
						type: "error",
					});
				}

				return renderAdminDashboard(routeCtx, ctx);
			},
		}),

		"editor-panel": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const interaction = (routeCtx.input ?? {
					type: "panel_load",
				}) as ContentEditorPanelInteraction;
				const uiLocale = await resolveSandboxUiLocale(routeCtx, ctx);
				const t = (key: I18nByokMsgKey, vars?: Record<string, string | number>) =>
					formatUiTemplate(I18N_BYOK_MESSAGES[uiLocale][key], vars);

				if (
					interaction.type === "block_action" &&
					interaction.action_id === "panel_translate_locale" &&
					routeCtx.ui?.surface === "content-editor-panel"
				) {
					const targetLocale = String(interaction.value || "").trim();
					try {
						const out = await translateSingleEntry(ctx, {
							collection: routeCtx.ui.entry.collection,
							entryId: routeCtx.ui.entry.id,
							targetLocale,
						});
						const panelRes = await renderEditorPanel(routeCtx, ctx, {
							message: t("toastTranslated", { locale: out.locale, id: out.id }),
							type: "success",
						});
						return { ...panelRes, refresh: true as const };
					} catch (err) {
						return renderEditorPanel(routeCtx, ctx, {
							message: err instanceof Error ? err.message : String(err),
							type: "error",
						});
					}
				}

				return renderEditorPanel(routeCtx, ctx);
			},
		}),

		"mcp-list-locales": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (_routeCtx, ctx) => {
				const settings = await loadSettings(ctx);
				return {
					sourceLocale: settings.sourceLocale,
					targetLocales: settings.targetLocales,
					supportedPool: SUPPORTED_LOCALE_POOL,
					model: settings.model,
				};
			},
		}),

		"mcp-get-status": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (_routeCtx, ctx) => {
				const [settings, glossary, translatedCount, collections] = await Promise.all([
					loadSettings(ctx),
					listGlossary(ctx),
					ctx.kv.get<number>(KV_TRANSLATED_COUNT_KEY).catch(() => 0),
					ctx.schema ? ctx.schema.listCollections().catch(() => []) : Promise.resolve([]),
				]);
				return {
					hasApiKey: Boolean(settings.openaiApiKey),
					model: settings.model,
					sourceLocale: settings.sourceLocale,
					targetLocales: settings.targetLocales,
					glossaryCount: glossary.length,
					translatedCount: Number(translatedCount || 0),
					collections: collections.map((c) => c.slug),
				};
			},
		}),

		"mcp-list-untranslated": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const b = (routeCtx.input ?? {}) as Record<string, unknown>;
				const collection = String(b.collection || "posts").trim() || "posts";
				const targetLocale = String(b.targetLocale || "zh-TW").trim();
				const limit = Math.min(50, Math.max(1, Number(b.limit || 20)));
				const items = await scanUntranslatedEntries(ctx, { collection, targetLocale, limit });
				return { collection, targetLocale, count: items.length, items };
			},
		}),

		"mcp-translate-entry": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const b = (routeCtx.input ?? {}) as Record<string, unknown>;
				return translateSingleEntry(ctx, {
					collection: String(b.collection || "posts").trim() || "posts",
					entryId: String(b.entryId || "").trim(),
					targetLocale: String(b.targetLocale || "").trim(),
					...(typeof b.publish === "boolean" ? { publishOverride: b.publish } : {}),
				});
			},
		}),

		"mcp-translate-taxonomies": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const b = (routeCtx.input ?? {}) as Record<string, unknown>;
				return translateTaxonomiesBatch(ctx, {
					taxonomy: String(b.taxonomy || "category").trim() || "category",
					targetLocale: String(b.targetLocale || "zh-TW").trim(),
				});
			},
		}),

		"mcp-upsert-glossary": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const b = (routeCtx.input ?? {}) as Record<string, unknown>;
				const action = b.action === "delete" ? "delete" : "upsert";
				const sourceTerm = String(b.sourceTerm || "").trim();
				if (!sourceTerm) throw new Error("sourceTerm is required");
				const list = await listGlossary(ctx);
				if (action === "delete") {
					const next = list.filter((g) => g.sourceTerm !== sourceTerm);
					await ctx.kv.set(KV_GLOSSARY_KEY, next);
					return { ok: true, action: "deleted", glossaryCount: next.length };
				}
				const targetTerm = String(b.targetTerm || "").trim();
				if (!targetTerm) throw new Error("targetTerm is required for upsert");
				const next = [
					{ sourceTerm, targetTerm, lockExact: Boolean(b.lockExact) },
					...list.filter((g) => g.sourceTerm !== sourceTerm),
				];
				await ctx.kv.set(KV_GLOSSARY_KEY, next);
				return { ok: true, action: "upserted", glossaryCount: next.length };
			},
		}),
	},

	mcp: {
		tools: {
			list_locales: {
				description: "List configured source/target locales, model setting, and supported language pool.",
				route: "mcp-list-locales",
				input: z.object({}),
				destructive: false,
			},
			get_translation_status: {
				description: "Get API key readiness, active model, glossary term count, and collection list.",
				route: "mcp-get-status",
				input: z.object({}),
				destructive: false,
			},
			list_untranslated: {
				description: "List entries in a collection that do not yet have a linked translation in targetLocale.",
				route: "mcp-list-untranslated",
				input: z.object({
					collection: z.string().default("posts"),
					targetLocale: z.string().min(2),
					limit: z.number().int().min(1).max(50).optional(),
				}),
				destructive: false,
			},
			translate_entry: {
				description: "Translate a single content entry (PortableText, fields, and SEO) via BYOK OpenAI into targetLocale.",
				route: "mcp-translate-entry",
				input: z.object({
					collection: z.string().default("posts"),
					entryId: z.string().min(1),
					targetLocale: z.string().min(2),
					publish: z.boolean().optional(),
				}),
				destructive: false,
			},
			translate_taxonomies: {
				description: "Translate missing taxonomy terms (categories/tags) into targetLocale using translationOf.",
				route: "mcp-translate-taxonomies",
				input: z.object({
					taxonomy: z.string().default("category"),
					targetLocale: z.string().min(2),
				}),
				destructive: false,
			},
			upsert_glossary: {
				description: "Add, update, or delete a brand/terminology glossary rule used during translation.",
				route: "mcp-upsert-glossary",
				input: z.object({
					action: z.enum(["upsert", "delete"]).default("upsert"),
					sourceTerm: z.string().min(1),
					targetTerm: z.string().optional(),
					lockExact: z.boolean().optional(),
				}),
				destructive: false,
			},
		},
	},
};

export default plugin;

import {
	pluginResponse,
	pluginRoute,
	type PluginContext,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import {
	blocks,
	elements,
	type Block,
	type BlockInteraction,
	type BlockResponse,
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
import { COUNTDOWN_MESSAGES, type CountdownMsgKey } from "./i18n-messages.js";
import {
	DEADLINE_EXPIRED_PRESETS,
	DEADLINE_GIF_PALETTES,
	renderCountdownGif,
	signDeadlineGifParams,
	verifyDeadlineGifSignature,
	type DeadlineGifLayout,
} from "./gif-encoder.js";

const KV_SIGNING_SECRET_KEY = "signing_secret";
const KV_TIMER_PREFIX = "timer:";
const KV_LAST_PREVIEW_ID_KEY = "ui:last_preview_id";
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;

export interface TimerRecord {
	id: string;
	name: string;
	mode: "fixed" | "evergreen";
	endAt?: string;
	durationMinutes?: number;
	activeUrl: string;
	expiredUrl: string;
	style: string;
	layout: DeadlineGifLayout;
	expiredPreset: string;
	createdAt: string;
	updatedAt: string;
}

function randomHex(byteCount: number): string {
	const bytes = new Uint8Array(byteCount);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i]!.toString(16).padStart(2, "0");
	}
	return out;
}

async function ensureSigningSecret(ctx: PluginContext): Promise<string> {
	const existing = await ctx.kv.get<string>(KV_SIGNING_SECRET_KEY);
	if (typeof existing === "string" && existing.trim().length >= 16) {
		return existing.trim();
	}
	const generated = `cdg_${randomHex(24)}`;
	const cas = await ctx.kv.compareAndSet(KV_SIGNING_SECRET_KEY, null, generated);
	if (cas.applied) {
		return generated;
	}
	const raced = await ctx.kv.get<string>(KV_SIGNING_SECRET_KEY);
	if (typeof raced === "string" && raced.trim().length >= 16) {
		return raced.trim();
	}
	await ctx.kv.set(KV_SIGNING_SECRET_KEY, generated);
	return generated;
}

function sanitizeId(raw: unknown): string {
	const cleaned = String(raw || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	if (SAFE_ID_RE.test(cleaned)) return cleaned;
	return `t-${randomHex(4)}`;
}

function parseSafeRedirectUrl(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const u = new URL(trimmed);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return u.toString();
	} catch {
		return null;
	}
}

function parseDeadlineUnix(raw: unknown): number | null {
	if (raw === undefined || raw === null) return null;
	const str = String(raw).trim();
	if (!str) return null;
	if (/^\d{9,13}$/.test(str)) {
		const n = Number(str);
		if (!Number.isFinite(n) || n <= 0) return null;
		return str.length >= 13 ? Math.floor(n / 1000) : Math.floor(n);
	}
	const ms = Date.parse(str);
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return Math.floor(ms / 1000);
}

function normalizeStyle(raw: unknown, fallback = "dark"): string {
	const v = String(raw || "").trim().toLowerCase();
	if (v && Object.prototype.hasOwnProperty.call(DEADLINE_GIF_PALETTES, v)) {
		return v;
	}
	return Object.prototype.hasOwnProperty.call(DEADLINE_GIF_PALETTES, fallback)
		? fallback
		: "dark";
}

function normalizeLayout(raw: unknown, fallback: DeadlineGifLayout = "card"): DeadlineGifLayout {
	const v = String(raw || "").trim().toLowerCase();
	if (v === "pill" || v === "card") return v;
	return fallback === "pill" ? "pill" : "card";
}

function normalizeExpiredPreset(raw: unknown, fallback = "expired_en"): string {
	const v = String(raw || "").trim().toLowerCase();
	if (v && Object.prototype.hasOwnProperty.call(DEADLINE_EXPIRED_PRESETS, v)) {
		return v;
	}
	return Object.prototype.hasOwnProperty.call(DEADLINE_EXPIRED_PRESETS, fallback)
		? fallback
		: "expired_en";
}

function normalizeHex(raw: unknown): string | undefined {
	const s = String(raw || "").trim().replace(/^#/, "");
	return HEX_COLOR_RE.test(s) ? s.toLowerCase() : undefined;
}

function readQueryRecord(
	input: unknown,
	requestUrl: string,
): { params: Record<string, string>; syntheticUrl: URL } {
	const params: Record<string, string> = {};
	try {
		const parsed = new URL(requestUrl);
		for (const [k, v] of parsed.searchParams.entries()) {
			if (v !== "") params[k] = v;
		}
	} catch {
		// ignore malformed fallback URL; input record below will populate
	}
	if (input && typeof input === "object" && !Array.isArray(input)) {
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
			if (typeof v === "string" && v !== "") {
				params[k] = v;
			} else if (Array.isArray(v) && typeof v[0] === "string" && v[0] !== "") {
				params[k] = v[0];
			}
		}
	}
	const syntheticUrl = new URL("https://plugin.local/route");
	for (const [k, v] of Object.entries(params)) {
		syntheticUrl.searchParams.set(k, v);
	}
	return { params, syntheticUrl };
}

async function listTimers(ctx: PluginContext): Promise<TimerRecord[]> {
	const entries = await ctx.kv.list(KV_TIMER_PREFIX);
	const out: TimerRecord[] = [];
	for (const item of entries) {
		const val = item.value as TimerRecord | null;
		if (val && typeof val === "object" && typeof val.id === "string") {
			out.push(val);
		}
	}
	out.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
	return out;
}

function buildPublicRouteUrl(
	ctx: PluginContext,
	siteOrigin: string | undefined,
	routeName: string,
	query: Record<string, string>,
): string {
	const routePath = `/_emdash/api/plugins/countdown-gif/${routeName}`;
	const qs = new URLSearchParams(query).toString();
	const origin = String(siteOrigin || "").trim().replace(/\/+$/, "");
	if (origin && /^https?:\/\//i.test(origin)) {
		return qs ? `${origin}${routePath}?${qs}` : `${origin}${routePath}`;
	}
	const hostUrl = ctx.url(routePath);
	const sep = hostUrl.includes("?") ? "&" : "?";
	return qs ? `${hostUrl}${sep}${qs}` : hostUrl;
}

async function getDefaultsFromSettings(ctx: PluginContext): Promise<{
	style: string;
	layout: DeadlineGifLayout;
	expiredPreset: string;
	siteOrigin?: string;
}> {
	const [sStyle, sLayout, sExpired, sOrigin] = await Promise.all([
		ctx.settings.get<string>("defaultStyle").catch(() => undefined),
		ctx.settings.get<string>("defaultLayout").catch(() => undefined),
		ctx.settings.get<string>("defaultExpiredPreset").catch(() => undefined),
		ctx.settings.get<string>("siteOrigin").catch(() => undefined),
	]);
	return {
		style: normalizeStyle(sStyle, "dark"),
		layout: normalizeLayout(sLayout, "card"),
		expiredPreset: normalizeExpiredPreset(sExpired, "expired_en"),
		siteOrigin: typeof sOrigin === "string" && sOrigin.trim() ? sOrigin.trim() : undefined,
	};
}

async function generateSignedEmbedForTimer(
	ctx: PluginContext,
	timer: TimerRecord,
	opts?: { deadlineOverrideIsoOrUnix?: unknown; siteOriginOverride?: string },
): Promise<{
	timerId: string;
	deadlineUnix: number;
	deadlineIso: string;
	gifUrl: string;
	redirectUrl: string;
	imgHtml: string;
	linkedHtml: string;
}> {
	const secret = await ensureSigningSecret(ctx);
	const defaults = await getDefaultsFromSettings(ctx);
	const siteOrigin = opts?.siteOriginOverride || defaults.siteOrigin;

	let deadlineUnix = parseDeadlineUnix(opts?.deadlineOverrideIsoOrUnix);
	if (deadlineUnix === null) {
		if (timer.mode === "fixed" && timer.endAt) {
			deadlineUnix = parseDeadlineUnix(timer.endAt);
		} else {
			const mins = Math.max(1, Math.min(525600, Number(timer.durationMinutes || 60)));
			deadlineUnix = Math.floor(Date.now() / 1000) + mins * 60;
		}
	}
	if (deadlineUnix === null) {
		deadlineUnix = Math.floor(Date.now() / 1000) + 3600;
	}

	const gifParams: Record<string, string> = {
		id: timer.id,
		end: String(deadlineUnix),
		style: timer.style,
		layout: timer.layout,
		expired: timer.expiredPreset,
	};
	const gifSig = await signDeadlineGifParams(gifParams, secret);
	const gifUrl = buildPublicRouteUrl(ctx, siteOrigin, "timer-gif", {
		...gifParams,
		sig: gifSig,
	});

	const goParams: Record<string, string> = {
		id: timer.id,
		exp: String(deadlineUnix),
	};
	const goSig = await signDeadlineGifParams(goParams, secret);
	const redirectUrl = buildPublicRouteUrl(ctx, siteOrigin, "go", {
		...goParams,
		sig: goSig,
	});

	const safeAlt = timer.name.replace(/["<>]/g, "").trim() || "Countdown Timer";
	const dims = timer.layout === "pill" ? `width="300" height="56"` : `width="460" height="104"`;
	const imgHtml = `<img src="${gifUrl}" alt="${safeAlt}" ${dims} style="display:block;border:0;max-width:100%;height:auto;" />`;
	const linkedHtml = `<a href="${redirectUrl}" target="_blank" rel="noopener noreferrer">${imgHtml}</a>`;

	return {
		timerId: timer.id,
		deadlineUnix,
		deadlineIso: new Date(deadlineUnix * 1000).toISOString(),
		gifUrl,
		redirectUrl,
		imgHtml,
		linkedHtml,
	};
}

async function renderAdminDashboard(
	routeCtx: Pick<SandboxedRouteContext, "ui"> | undefined,
	ctx: PluginContext,
	toast?: BlockResponse["toast"],
	selectedTimerId?: string | null,
): Promise<BlockResponse> {
	const [timers, defaults, uiLocale, guideState] = await Promise.all([
		listTimers(ctx),
		getDefaultsFromSettings(ctx),
		resolveSandboxUiLocale(routeCtx, ctx),
		loadGuideKitState(ctx),
	]);
	const dict = COUNTDOWN_MESSAGES[uiLocale];
	const t = (key: CountdownMsgKey, vars?: Record<string, string | number>) =>
		formatUiTemplate(dict[key], vars);

	const targetPreviewId =
		selectedTimerId ?? (await ctx.kv.get<string>(KV_LAST_PREVIEW_ID_KEY)) ?? timers[0]?.id ?? null;
	const selectedTimer = targetPreviewId
		? timers.find((tItem) => tItem.id === targetPreviewId) ?? timers[0] ?? null
		: null;

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
				label: t("statSavedLabel"),
				value: timers.length,
				description: t("statSavedDesc"),
			},
			{
				label: t("statFixedLabel"),
				value: timers.filter((tItem) => tItem.mode === "fixed").length,
				description: t("statFixedDesc"),
			},
			{
				label: t("statEvergreenLabel"),
				value: timers.filter((tItem) => tItem.mode === "evergreen").length,
				description: t("statEvergreenDesc"),
			},
		]),
		...buildGuideKitBlocks({
			activeStep: guideState.activeStep,
			checklistCollapsed: guideState.checklistCollapsed,
			checklist: [
				{
					done: Boolean(defaults.siteOrigin),
					label: t("chkOriginTitle"),
					detail: defaults.siteOrigin
						? t("chkOriginDone", { origin: defaults.siteOrigin })
						: t("chkOriginTodo"),
				},
				{
					done: timers.length > 0,
					label: t("chkTimerTitle"),
					detail: timers.length > 0
						? t("chkTimerDone", { count: timers.length })
						: t("chkTimerTodo"),
				},
				{
					done: Boolean(selectedTimer),
					label: t("chkEmbedTitle"),
					detail: selectedTimer
						? t("chkEmbedDone", { id: selectedTimer.id })
						: t("chkEmbedTodo"),
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
		blocks.divider(),
	];

	if (timers.length === 0) {
		screenBlocks.push(
			blocks.empty({
				blockId: "countdown_empty_state",
				title: t("emptyTitle"),
				description: t("emptyDesc"),
				size: "base",
				actions: [
					elements.button("create_demo_timer", t("emptyCreateDemoBtn"), { style: "primary" }),
				],
			}),
			blocks.divider(),
		);
	}

	if (selectedTimer) {
		const preview = await generateSignedEmbedForTimer(ctx, selectedTimer);
		screenBlocks.push(
			blocks.banner({
				variant: "default",
				title: t("embedReadyTitle", { name: selectedTimer.name, id: selectedTimer.id }),
				description: t("embedReadyDesc", {
					deadlineIso: preview.deadlineIso,
					activeUrl: selectedTimer.activeUrl,
					expiredUrl: selectedTimer.expiredUrl,
				}),
			}),
			blocks.code({
				code: `<!-- Email HTML (<img src> + Evergreen 302 link) -->\n${preview.linkedHtml}\n\n# Direct GIF URL\n${preview.gifUrl}\n\n# Evergreen Redirect URL\n${preview.redirectUrl}`,
			}),
			blocks.divider(),
		);
	}

	const defaultFutureIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
	screenBlocks.push(
		blocks.header(t("formHeader")),
		blocks.form({
			blockId: "create_timer_form",
			fields: [
				elements.textInput("name", t("fieldName"), {
					placeholder: t("fieldNamePh"),
				}),
				elements.select(
					"mode",
					t("fieldMode"),
					[
						{ value: "fixed", label: t("modeFixed") },
						{ value: "evergreen", label: t("modeEvergreen") },
					],
					{ initialValue: "fixed" },
				),
				elements.textInput("endAt", t("fieldEndAt"), {
					initialValue: defaultFutureIso,
					placeholder: "2026-12-31T23:59:59Z",
				}),
				elements.numberInput("durationMinutes", t("fieldDuration"), {
					initialValue: 1440,
					min: 1,
					max: 525600,
				}),
				elements.textInput("activeUrl", t("fieldActiveUrl"), {
					placeholder: "https://example.com/offer",
				}),
				elements.textInput("expiredUrl", t("fieldExpiredUrl"), {
					placeholder: "https://example.com/offer-ended",
				}),
				elements.select(
					"style",
					t("fieldStyle"),
					[
						{ value: "dark", label: t("styleDark") },
						{ value: "light", label: t("styleLight") },
						{ value: "red", label: t("styleRed") },
						{ value: "gold", label: t("styleGold") },
						{ value: "emerald", label: t("styleEmerald") },
					],
					{ initialValue: defaults.style },
				),
				elements.select(
					"layout",
					t("fieldLayout"),
					[
						{ value: "card", label: t("layoutCard") },
						{ value: "pill", label: t("layoutPill") },
					],
					{ initialValue: defaults.layout },
				),
				elements.select(
					"expiredPreset",
					t("fieldExpiredPreset"),
					[
						{ value: "expired_en", label: "OFFER EXPIRED" },
						{ value: "closed_en", label: "DOORS CLOSED" },
						{ value: "ended_en", label: "DEAL ENDED" },
						{ value: "expired_zh", label: "優惠已截止" },
						{ value: "closed_zh", label: "報名已結束" },
						{ value: "ended_zh", label: "活動已結束" },
					],
					{ initialValue: defaults.expiredPreset },
				),
			],
			submit: {
				label: t("formSubmit"),
				actionId: "create_timer",
			},
		}),
		blocks.divider(),
		blocks.header(t("savedHeader")),
	);

	const columns: TableColumn[] = [
		{ key: "name", label: t("colName") },
		{ key: "mode", label: t("colMode"), format: "badge" },
		{ key: "style", label: t("colStyle"), format: "badge" },
		{ key: "target", label: t("colTarget") },
		{ key: "previewBtn", label: t("colEmbed"), format: "element" },
		{ key: "deleteBtn", label: t("colDelete"), format: "element" },
	];

	const rows = timers.map((timerRow) => ({
		id: timerRow.id,
		name: `${timerRow.name} (${timerRow.id})`,
		mode: timerRow.mode,
		style: `${timerRow.style}/${timerRow.layout}`,
		target: timerRow.mode === "fixed" ? timerRow.endAt || "-" : `${timerRow.durationMinutes || 60} min`,
		previewBtn: elements.button("preview_timer", t("btnGetEmbed"), {
			style: "secondary",
			value: timerRow.id,
		}),
		deleteBtn: elements.button("delete_timer", t("btnDelete"), {
			style: "danger",
			value: timerRow.id,
			confirm: {
				title: t("confirmDeleteTitle"),
				text: t("confirmDeleteText", { name: timerRow.name }),
				confirm: t("confirmDeleteOk"),
				deny: t("confirmDeleteCancel"),
				style: "danger",
			},
		}),
	}));

	screenBlocks.push(
		blocks.table({
			blockId: "timers_table",
			columns,
			rows,
			pageActionId: "timers_page",
			emptyText: t("tableEmpty"),
		}),
		blocks.context(t("footerNote")),
	);

	return {
		blocks: screenBlocks,
		...(toast ? { toast } : {}),
	};
}

const CreateTimerInputSchema = z.object({
	id: z.string().optional(),
	name: z.string().min(1),
	mode: z.enum(["fixed", "evergreen"]).default("fixed"),
	endAt: z.string().optional(),
	durationMinutes: z.number().int().min(1).max(525600).optional(),
	activeUrl: z.string().url(),
	expiredUrl: z.string().url(),
	style: z.enum(["dark", "light", "red", "gold", "emerald"]).optional(),
	layout: z.enum(["card", "pill"]).optional(),
	expiredPreset: z
		.enum(["expired_en", "closed_en", "ended_en", "expired_zh", "closed_zh", "ended_zh"])
		.optional(),
});

const GenerateEmbedInputSchema = z.object({
	timerId: z.string().min(1),
	deadline: z.string().optional(),
	siteOrigin: z.string().optional(),
});

const DeleteTimerInputSchema = z.object({
	timerId: z.string().min(1),
});

const ListTimersInputSchema = z.object({});

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			await ensureSigningSecret(ctx);
			ctx.log.info("countdown-gif signing secret initialized");
		},
	},
	routes: {
		"timer-gif": pluginRoute({
			public: true,
			methods: ["GET", "HEAD"],
			request: { body: "none" },
			response: "raw",
			cacheControl: "public, max-age=30, s-maxage=30",
			handler: async (routeCtx, ctx) => {
				const { params, syntheticUrl } = readQueryRecord(routeCtx.input, routeCtx.request.url);
				const secret = await ensureSigningSecret(ctx);
				const validSig = await verifyDeadlineGifSignature(syntheticUrl, secret);
				if (!validSig) {
					return pluginResponse({
						status: 403,
						headers: {
							"content-type": "text/plain; charset=utf-8",
							"cache-control": "no-store",
						},
						body: { kind: "text", value: "Forbidden: invalid or missing signature" },
					});
				}

				let stored: TimerRecord | null = null;
				if (params.id && SAFE_ID_RE.test(params.id)) {
					stored = await ctx.kv.get<TimerRecord>(`${KV_TIMER_PREFIX}${params.id}`);
				}

				const defaults = await getDefaultsFromSettings(ctx);
				const endUnix =
					parseDeadlineUnix(params.end) ??
					(stored?.endAt ? parseDeadlineUnix(stored.endAt) : null);
				const nowUnix = Math.floor(Date.now() / 1000);
				const remainingSeconds = endUnix !== null ? Math.max(0, endUnix - nowUnix) : 0;

				const style = normalizeStyle(params.style ?? stored?.style, defaults.style);
				const layout = normalizeLayout(params.layout ?? stored?.layout, defaults.layout);
				const expiredPreset = normalizeExpiredPreset(
					params.expired ?? stored?.expiredPreset,
					defaults.expiredPreset,
				);
				const bgHex = normalizeHex(params.bg);
				const accentHex = normalizeHex(params.accent);
				const textHex = normalizeHex(params.text);

				const method = String(routeCtx.request.method || "GET").toUpperCase();
				if (method === "HEAD") {
					return pluginResponse({
						status: 200,
						headers: {
							"content-type": "image/gif",
							"cache-control": "public, max-age=30, s-maxage=30, no-transform",
							"x-content-type-options": "nosniff",
						},
						body: null,
					});
				}

				const gifBytes = renderCountdownGif({
					remainingSeconds,
					style,
					layout,
					expiredPreset,
					bgHex,
					accentHex,
					textHex,
				});

				return pluginResponse({
					status: 200,
					headers: {
						"content-type": "image/gif",
						"cache-control": "public, max-age=30, s-maxage=30, no-transform",
						"x-content-type-options": "nosniff",
					},
					body: { kind: "bytes", value: gifBytes },
				});
			},
		}),

		go: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			cacheControl: "no-store",
			handler: async (routeCtx, ctx) => {
				const { params, syntheticUrl } = readQueryRecord(routeCtx.input, routeCtx.request.url);
				const secret = await ensureSigningSecret(ctx);
				const validSig = await verifyDeadlineGifSignature(syntheticUrl, secret);
				if (!validSig) {
					return pluginResponse({
						status: 403,
						headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
						body: { kind: "text", value: "Forbidden: invalid or missing signature" },
					});
				}

				const timerId = String(params.id || "").trim();
				if (!SAFE_ID_RE.test(timerId)) {
					return pluginResponse({
						status: 400,
						headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
						body: { kind: "text", value: "Invalid timer id" },
					});
				}
				const timer = await ctx.kv.get<TimerRecord>(`${KV_TIMER_PREFIX}${timerId}`);
				if (!timer) {
					return pluginResponse({
						status: 404,
						headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
						body: { kind: "text", value: "Timer not found" },
					});
				}

				const explicitExp = parseDeadlineUnix(params.exp);
				const storedEnd = timer.endAt ? parseDeadlineUnix(timer.endAt) : null;
				const deadlineUnix = explicitExp ?? storedEnd;
				const nowUnix = Math.floor(Date.now() / 1000);
				const isExpired = deadlineUnix !== null ? nowUnix > deadlineUnix : true;

				const target = parseSafeRedirectUrl(isExpired ? timer.expiredUrl : timer.activeUrl);
				if (!target) {
					return pluginResponse({
						status: 400,
						headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
						body: { kind: "text", value: "Invalid destination URL" },
					});
				}

				return pluginResponse({
					status: 302,
					headers: {
						location: target,
						"cache-control": "no-store",
					},
					body: null,
				});
			},
		}),

		admin: pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const interaction = (routeCtx.input ?? { type: "page_load", page: "/timers" }) as BlockInteraction;

				const guideResult = await handleGuideKitAction(interaction, ctx, 4);
				if (guideResult.handled) {
					const loc = await resolveSandboxUiLocale(routeCtx, ctx);
					const t = (key: CountdownMsgKey, vars?: Record<string, string | number>) =>
						formatUiTemplate(COUNTDOWN_MESSAGES[loc][key], vars);
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
				const t = (key: CountdownMsgKey, vars?: Record<string, string | number>) =>
					formatUiTemplate(COUNTDOWN_MESSAGES[uiLocale][key], vars);

				if (interaction.type === "block_action" && interaction.action_id === "create_demo_timer") {
					const defaults = await getDefaultsFromSettings(ctx);
					const baseOrigin = parseSafeRedirectUrl(defaults.siteOrigin || ctx.site.url) || "https://example.com";
					const cleanOrigin = baseOrigin.replace(/\/+$/, "");
					const id = "demo-launch-72h";
					const nowIso = new Date().toISOString();
					const endAtIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
					const demoName = t("fieldNamePh");
					const demoRecord: TimerRecord = {
						id,
						name: demoName,
						mode: "fixed",
						endAt: endAtIso,
						activeUrl: `${cleanOrigin}/offer`,
						expiredUrl: `${cleanOrigin}/expired`,
						style: defaults.style,
						layout: defaults.layout,
						expiredPreset: defaults.expiredPreset,
						createdAt: nowIso,
						updatedAt: nowIso,
					};
					await ctx.kv.set(`${KV_TIMER_PREFIX}${id}`, demoRecord);
					await ctx.kv.set(KV_LAST_PREVIEW_ID_KEY, id);
					return renderAdminDashboard(
						routeCtx,
						ctx,
						{ message: t("toastDemoCreated", { name: demoName }), type: "success" },
						id,
					);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "create_timer") {
					const vals = interaction.values ?? {};
					const name = String(vals.name || "").trim();
					const activeUrl = parseSafeRedirectUrl(vals.activeUrl);
					const expiredUrl = parseSafeRedirectUrl(vals.expiredUrl);
					if (!name) {
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastNameRequired"),
							type: "error",
						});
					}
					if (!activeUrl || !expiredUrl) {
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastUrlInvalid"),
							type: "error",
						});
					}

					const mode = vals.mode === "evergreen" ? "evergreen" : "fixed";
					const defaults = await getDefaultsFromSettings(ctx);
					const id = sanitizeId(name);
					const nowIso = new Date().toISOString();
					const existing = await ctx.kv.get<TimerRecord>(`${KV_TIMER_PREFIX}${id}`);

					let endAtIso: string | undefined;
					let durationMinutes: number | undefined;
					if (mode === "fixed") {
						const endUnix = parseDeadlineUnix(vals.endAt);
						if (!endUnix) {
							return renderAdminDashboard(routeCtx, ctx, {
								message: t("toastFixedTimeInvalid"),
								type: "error",
							});
						}
						endAtIso = new Date(endUnix * 1000).toISOString();
					} else {
						const mins = Number(vals.durationMinutes || 60);
						durationMinutes = Math.max(1, Math.min(525600, Math.round(mins)));
					}

					const record: TimerRecord = {
						id,
						name,
						mode,
						...(endAtIso ? { endAt: endAtIso } : {}),
						...(durationMinutes ? { durationMinutes } : {}),
						activeUrl,
						expiredUrl,
						style: normalizeStyle(vals.style, defaults.style),
						layout: normalizeLayout(vals.layout, defaults.layout),
						expiredPreset: normalizeExpiredPreset(vals.expiredPreset, defaults.expiredPreset),
						createdAt: existing?.createdAt || nowIso,
						updatedAt: nowIso,
					};

					await ctx.kv.set(`${KV_TIMER_PREFIX}${id}`, record);
					await ctx.kv.set(KV_LAST_PREVIEW_ID_KEY, id);
					return renderAdminDashboard(
						routeCtx,
						ctx,
						{ message: t("toastSaved", { name, id }), type: "success" },
						id,
					);
				}

				if (interaction.type === "block_action" && interaction.action_id === "preview_timer") {
					const targetId = String(interaction.value || "").trim();
					if (targetId) await ctx.kv.set(KV_LAST_PREVIEW_ID_KEY, targetId);
					return renderAdminDashboard(routeCtx, ctx, undefined, targetId || null);
				}

				if (interaction.type === "block_action" && interaction.action_id === "delete_timer") {
					const targetId = String(interaction.value || "").trim();
					if (targetId && SAFE_ID_RE.test(targetId)) {
						await ctx.kv.delete(`${KV_TIMER_PREFIX}${targetId}`);
						const currentPreview = await ctx.kv.get<string>(KV_LAST_PREVIEW_ID_KEY);
						if (currentPreview === targetId) {
							await ctx.kv.delete(KV_LAST_PREVIEW_ID_KEY);
						}
						return renderAdminDashboard(routeCtx, ctx, {
							message: t("toastDeleted", { id: targetId }),
							type: "info",
						});
					}
				}

				return renderAdminDashboard(routeCtx, ctx);
			},
		}),

		"mcp-list-timers": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (_routeCtx, ctx) => {
				const timers = await listTimers(ctx);
				return { count: timers.length, timers };
			},
		}),

		"mcp-create-timer": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const body = (routeCtx.input ?? {}) as Record<string, unknown>;
				const name = String(body.name || "").trim();
				const activeUrl = parseSafeRedirectUrl(body.activeUrl);
				const expiredUrl = parseSafeRedirectUrl(body.expiredUrl);
				if (!name || !activeUrl || !expiredUrl) {
					throw new Error("Invalid name, activeUrl, or expiredUrl");
				}
				const defaults = await getDefaultsFromSettings(ctx);
				const mode = body.mode === "evergreen" ? "evergreen" : "fixed";
				const id = body.id ? sanitizeId(body.id) : sanitizeId(name);
				const nowIso = new Date().toISOString();
				const existing = await ctx.kv.get<TimerRecord>(`${KV_TIMER_PREFIX}${id}`);

				let endAtIso: string | undefined;
				let durationMinutes: number | undefined;
				if (mode === "fixed") {
					const endUnix = parseDeadlineUnix(body.endAt);
					if (!endUnix) throw new Error("Fixed mode requires a valid endAt ISO timestamp or Unix seconds");
					endAtIso = new Date(endUnix * 1000).toISOString();
				} else {
					durationMinutes = Math.max(1, Math.min(525600, Math.round(Number(body.durationMinutes || 60))));
				}

				const timer: TimerRecord = {
					id,
					name,
					mode,
					...(endAtIso ? { endAt: endAtIso } : {}),
					...(durationMinutes ? { durationMinutes } : {}),
					activeUrl,
					expiredUrl,
					style: normalizeStyle(body.style, defaults.style),
					layout: normalizeLayout(body.layout, defaults.layout),
					expiredPreset: normalizeExpiredPreset(body.expiredPreset, defaults.expiredPreset),
					createdAt: existing?.createdAt || nowIso,
					updatedAt: nowIso,
				};
				await ctx.kv.set(`${KV_TIMER_PREFIX}${id}`, timer);
				const embed = await generateSignedEmbedForTimer(ctx, timer);
				return { timer, embed };
			},
		}),

		"mcp-generate-embed": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const body = (routeCtx.input ?? {}) as Record<string, unknown>;
				const timerId = String(body.timerId || "").trim();
				if (!SAFE_ID_RE.test(timerId)) {
					throw new Error("Invalid timerId");
				}
				const timer = await ctx.kv.get<TimerRecord>(`${KV_TIMER_PREFIX}${timerId}`);
				if (!timer) {
					throw new Error(`Timer "${timerId}" not found`);
				}
				return generateSignedEmbedForTimer(ctx, timer, {
					deadlineOverrideIsoOrUnix: body.deadline,
					siteOriginOverride: typeof body.siteOrigin === "string" ? body.siteOrigin : undefined,
				});
			},
		}),

		"mcp-delete-timer": pluginRoute({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			response: "json",
			handler: async (routeCtx, ctx) => {
				const body = (routeCtx.input ?? {}) as Record<string, unknown>;
				const timerId = String(body.timerId || "").trim();
				if (!SAFE_ID_RE.test(timerId)) {
					throw new Error("Invalid timerId");
				}
				const deleted = await ctx.kv.delete(`${KV_TIMER_PREFIX}${timerId}`);
				return { deleted, timerId };
			},
		}),
	},

	mcp: {
		tools: {
			list_timers: {
				description: "List all saved Countdown GIF and Evergreen timers configured on this site.",
				route: "mcp-list-timers",
				input: ListTimersInputSchema,
				destructive: false,
			},
			create_timer: {
				description:
					"Create or update a Countdown GIF timer (fixed deadline or Evergreen minutes) with active/expired 302 redirect URLs and return signed email HTML.",
				route: "mcp-create-timer",
				input: CreateTimerInputSchema,
				destructive: false,
			},
			generate_embed_html: {
				description:
					"Generate a fresh HMAC-signed GIF <img> URL and Evergreen 302 redirect URL for an existing timer.",
				route: "mcp-generate-embed",
				input: GenerateEmbedInputSchema,
				destructive: false,
			},
			delete_timer: {
				description: "Permanently delete a saved Countdown GIF timer by its id.",
				route: "mcp-delete-timer",
				input: DeleteTimerInputSchema,
				destructive: true,
			},
		},
	},
};

export default plugin;

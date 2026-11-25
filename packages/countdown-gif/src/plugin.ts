import {
	pluginResponse,
	pluginRoute,
	type PluginContext,
	type SandboxedPlugin,
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
	ctx: PluginContext,
	toast?: BlockResponse["toast"],
	selectedTimerId?: string | null,
): Promise<BlockResponse> {
	const timers = await listTimers(ctx);
	const defaults = await getDefaultsFromSettings(ctx);
	const targetPreviewId =
		selectedTimerId ?? (await ctx.kv.get<string>(KV_LAST_PREVIEW_ID_KEY)) ?? timers[0]?.id ?? null;
	const selectedTimer = targetPreviewId
		? timers.find((t) => t.id === targetPreviewId) ?? timers[0] ?? null
		: null;

	const screenBlocks: Block[] = [
		blocks.header("Countdown GIF & Evergreen Timer"),
		blocks.section(
			"Create zero-permission animated GIF89a countdown timers for newsletters and Evergreen deadline 302 redirects.",
			{
				accessory: elements.link("Settings", { kind: "plugin-settings" }, { appearance: "secondary" }),
			},
		),
		blocks.stats([
			{
				label: "Saved Timers",
				value: timers.length,
				description: "Stored privately in plugin KV",
			},
			{
				label: "Fixed Deadline",
				value: timers.filter((t) => t.mode === "fixed").length,
				description: "Shared end timestamp",
			},
			{
				label: "Evergreen",
				value: timers.filter((t) => t.mode === "evergreen").length,
				description: "Per-recipient window + 302 redirect",
			},
		]),
		blocks.divider(),
	];

	if (selectedTimer) {
		const preview = await generateSignedEmbedForTimer(ctx, selectedTimer);
		screenBlocks.push(
			blocks.banner({
				variant: "default",
				title: `Embed Ready: ${selectedTimer.name} (${selectedTimer.id})`,
				description: `Deadline preview: ${preview.deadlineIso} | Active -> ${selectedTimer.activeUrl} | Expired -> ${selectedTimer.expiredUrl}`,
			}),
			blocks.code({
				code: `<!-- Email HTML (<img src> + Evergreen 302 link) -->\n${preview.linkedHtml}\n\n# Direct GIF URL\n${preview.gifUrl}\n\n# Evergreen Redirect URL\n${preview.redirectUrl}`,
			}),
			blocks.divider(),
		);
	}

	const defaultFutureIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
	screenBlocks.push(
		blocks.header("Create or Update Timer"),
		blocks.form({
			blockId: "create_timer_form",
			fields: [
				elements.textInput("name", "Campaign Name", {
					placeholder: "Black Friday Flash Sale",
				}),
				elements.select(
					"mode",
					"Timer Mode",
					[
						{ value: "fixed", label: "Fixed Deadline (ISO / Unix)" },
						{ value: "evergreen", label: "Evergreen (Minutes from generation)" },
					],
					{ initialValue: "fixed" },
				),
				elements.textInput("endAt", "Fixed End Time (UTC ISO or Unix seconds)", {
					initialValue: defaultFutureIso,
					placeholder: "2026-12-31T23:59:59Z",
				}),
				elements.numberInput("durationMinutes", "Evergreen Duration (minutes)", {
					initialValue: 1440,
					min: 1,
					max: 525600,
				}),
				elements.textInput("activeUrl", "Active Offer URL (before deadline)", {
					placeholder: "https://example.com/offer",
				}),
				elements.textInput("expiredUrl", "Expired Redirect URL (after deadline)", {
					placeholder: "https://example.com/offer-ended",
				}),
				elements.select(
					"style",
					"Theme Style",
					[
						{ value: "dark", label: "Midnight Dark" },
						{ value: "light", label: "Minimal Light" },
						{ value: "red", label: "Urgent Red" },
						{ value: "gold", label: "VIP Gold" },
						{ value: "emerald", label: "Emerald" },
					],
					{ initialValue: defaults.style },
				),
				elements.select(
					"layout",
					"GIF Layout",
					[
						{ value: "card", label: "Card (460x104)" },
						{ value: "pill", label: "Pill (300x56)" },
					],
					{ initialValue: defaults.layout },
				),
				elements.select(
					"expiredPreset",
					"Expired Frame Text",
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
				label: "Save & Generate Signed GIF URL",
				actionId: "create_timer",
			},
		}),
		blocks.divider(),
		blocks.header("Saved Timers"),
	);

	const columns: TableColumn[] = [
		{ key: "name", label: "Name" },
		{ key: "mode", label: "Mode", format: "badge" },
		{ key: "style", label: "Style", format: "badge" },
		{ key: "target", label: "Schedule / Duration" },
		{ key: "previewBtn", label: "Embed", format: "element" },
		{ key: "deleteBtn", label: "Delete", format: "element" },
	];

	const rows = timers.map((t) => ({
		id: t.id,
		name: `${t.name} (${t.id})`,
		mode: t.mode,
		style: `${t.style}/${t.layout}`,
		target: t.mode === "fixed" ? t.endAt || "-" : `${t.durationMinutes || 60} min`,
		previewBtn: elements.button("preview_timer", "Get Embed", {
			style: "secondary",
			value: t.id,
		}),
		deleteBtn: elements.button("delete_timer", "Delete", {
			style: "danger",
			value: t.id,
			confirm: {
				title: "Delete Timer?",
				text: `Delete "${t.name}"? Existing emails linking to its id will return 404 for 302 redirects.`,
				confirm: "Delete",
				deny: "Cancel",
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
			emptyText: "No timers created yet. Use the form above to generate your first countdown GIF.",
		}),
		blocks.context("Signed with HMAC-SHA256. Zero external hosts, zero database writes, 0 capabilities required."),
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

				if (interaction.type === "form_submit" && interaction.action_id === "create_timer") {
					const vals = interaction.values ?? {};
					const name = String(vals.name || "").trim();
					const activeUrl = parseSafeRedirectUrl(vals.activeUrl);
					const expiredUrl = parseSafeRedirectUrl(vals.expiredUrl);
					if (!name) {
						return renderAdminDashboard(ctx, {
							message: "Campaign name is required.",
							type: "error",
						});
					}
					if (!activeUrl || !expiredUrl) {
						return renderAdminDashboard(ctx, {
							message: "Active Offer URL and Expired Redirect URL must be valid http(s) URLs.",
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
							return renderAdminDashboard(ctx, {
								message: "Fixed deadline must be a valid ISO timestamp or Unix seconds.",
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
						ctx,
						{ message: `Saved timer "${name}" (${id}). Signed HTML is ready above.`, type: "success" },
						id,
					);
				}

				if (interaction.type === "block_action" && interaction.action_id === "preview_timer") {
					const targetId = String(interaction.value || "").trim();
					if (targetId) await ctx.kv.set(KV_LAST_PREVIEW_ID_KEY, targetId);
					return renderAdminDashboard(ctx, undefined, targetId || null);
				}

				if (interaction.type === "block_action" && interaction.action_id === "delete_timer") {
					const targetId = String(interaction.value || "").trim();
					if (targetId && SAFE_ID_RE.test(targetId)) {
						await ctx.kv.delete(`${KV_TIMER_PREFIX}${targetId}`);
						const currentPreview = await ctx.kv.get<string>(KV_LAST_PREVIEW_ID_KEY);
						if (currentPreview === targetId) {
							await ctx.kv.delete(KV_LAST_PREVIEW_ID_KEY);
						}
						return renderAdminDashboard(ctx, {
							message: `Deleted timer "${targetId}".`,
							type: "info",
						});
					}
				}

				return renderAdminDashboard(ctx);
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

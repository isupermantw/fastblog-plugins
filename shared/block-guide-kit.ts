import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import {
	blocks,
	elements,
	type Block,
	type BlockInteraction,
	type MenuElement,
} from "@emdash-cms/blocks/server";

export const SUPPORTED_UI_LOCALES = ["zh-TW", "zh-CN", "en", "ja", "ko", "es"] as const;
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const UI_LOCALE_LABELS: Record<SupportedUiLocale, string> = {
	"zh-TW": "繁體中文 (TW)",
	"zh-CN": "简体中文 (CN)",
	en: "English",
	ja: "日本語",
	ko: "한국어",
	es: "Español",
};

const KV_UI_LOCALE = "ui:locale";
const KV_GUIDE_STEP = "ui:guide_step";
const KV_GUIDE_CHECKLIST_COLLAPSED = "ui:guide_checklist_collapsed";

export function normalizeSandboxUiLocale(raw?: string | null): SupportedUiLocale {
	const v = String(raw || "").trim().toLowerCase();
	if (!v) return "en";
	if (v === "zh-tw" || v === "zh-hk" || v === "zh-mo" || v.startsWith("zh-hant")) {
		return "zh-TW";
	}
	if (v === "zh-cn" || v === "zh-sg" || v.startsWith("zh-hans") || v === "zh") {
		return "zh-CN";
	}
	if (v.startsWith("ja")) return "ja";
	if (v.startsWith("ko")) return "ko";
	if (v.startsWith("es")) return "es";
	return "en";
}

export async function resolveSandboxUiLocale(
	routeCtx: Pick<SandboxedRouteContext, "ui"> | undefined,
	ctx: Pick<PluginContext, "kv">,
): Promise<SupportedUiLocale> {
	const saved = await ctx.kv.get<string>(KV_UI_LOCALE).catch(() => null);
	if (typeof saved === "string" && (SUPPORTED_UI_LOCALES as readonly string[]).includes(saved)) {
		return saved as SupportedUiLocale;
	}
	if (routeCtx?.ui?.locale) {
		return normalizeSandboxUiLocale(routeCtx.ui.locale);
	}
	return "en";
}

export function formatUiTemplate(
	template: string,
	vars?: Record<string, string | number>,
): string {
	if (!vars) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key) => {
		return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : full;
	});
}

export function buildLocaleSwitcherMenu(
	currentLocale: SupportedUiLocale,
	menuPrefix: string,
): MenuElement {
	return elements.menu(
		"set_ui_locale",
		`${menuPrefix}: ${UI_LOCALE_LABELS[currentLocale]}`,
		SUPPORTED_UI_LOCALES.map((loc) => ({
			label: loc === currentLocale ? `✓ ${UI_LOCALE_LABELS[loc]}` : UI_LOCALE_LABELS[loc],
			value: loc,
		})),
		{ style: "secondary" },
	);
}

export interface GuideActionResult {
	handled: boolean;
	localeChangedTo?: SupportedUiLocale;
	guideCompleted?: boolean;
}

export async function handleGuideKitAction(
	interaction: BlockInteraction | Record<string, unknown>,
	ctx: Pick<PluginContext, "kv">,
	totalSteps: number,
): Promise<GuideActionResult> {
	if (!interaction || (interaction as BlockInteraction).type !== "block_action") {
		return { handled: false };
	}
	const actionId = String((interaction as { action_id?: unknown }).action_id || "");
	const val = (interaction as { value?: unknown }).value;

	if (actionId === "set_ui_locale") {
		const next = normalizeSandboxUiLocale(typeof val === "string" ? val : String(val || "en"));
		await ctx.kv.set(KV_UI_LOCALE, next);
		return { handled: true, localeChangedTo: next };
	}
	if (actionId === "guide_start") {
		await ctx.kv.set(KV_GUIDE_STEP, 1);
		return { handled: true };
	}
	if (actionId === "guide_prev") {
		const cur = Number((await ctx.kv.get<number>(KV_GUIDE_STEP)) || 1);
		await ctx.kv.set(KV_GUIDE_STEP, Math.max(1, cur - 1));
		return { handled: true };
	}
	if (actionId === "guide_next") {
		const cur = Number((await ctx.kv.get<number>(KV_GUIDE_STEP)) || 1);
		if (cur >= totalSteps) {
			await ctx.kv.set(KV_GUIDE_STEP, 0);
			return { handled: true, guideCompleted: true };
		}
		await ctx.kv.set(KV_GUIDE_STEP, cur + 1);
		return { handled: true };
	}
	if (actionId === "guide_close") {
		await ctx.kv.set(KV_GUIDE_STEP, 0);
		return { handled: true };
	}
	if (actionId === "guide_toggle_checklist") {
		const collapsed = Boolean(await ctx.kv.get<boolean>(KV_GUIDE_CHECKLIST_COLLAPSED));
		await ctx.kv.set(KV_GUIDE_CHECKLIST_COLLAPSED, !collapsed);
		return { handled: true };
	}
	return { handled: false };
}

export async function loadGuideKitState(ctx: Pick<PluginContext, "kv">): Promise<{
	activeStep: number;
	checklistCollapsed: boolean;
}> {
	const [rawStep, rawCollapsed] = await Promise.all([
		ctx.kv.get<number>(KV_GUIDE_STEP).catch(() => 0),
		ctx.kv.get<boolean>(KV_GUIDE_CHECKLIST_COLLAPSED).catch(() => false),
	]);
	return {
		activeStep: Number.isFinite(Number(rawStep)) ? Math.max(0, Math.floor(Number(rawStep))) : 0,
		checklistCollapsed: Boolean(rawCollapsed),
	};
}

export interface GuideChecklistItem {
	done: boolean;
	label: string;
	detail: string;
}

export interface GuideStepItem {
	title: string;
	description: string;
}

export interface GuideFaqItem {
	q: string;
	a: string;
}

export interface BuildGuideKitOptions {
	activeStep: number;
	checklistCollapsed: boolean;
	checklist: GuideChecklistItem[];
	steps: GuideStepItem[];
	faq: GuideFaqItem[];
	labels: {
		checklistTitle: string;
		progressLabel: string;
		tourButtonLabel: string;
		replayButtonLabel: string;
		stepBadgePrefix: string;
		prevLabel: string;
		nextLabel: string;
		finishLabel: string;
		closeLabel: string;
		faqTitle: string;
	};
}

export function buildGuideKitBlocks(opts: BuildGuideKitOptions): Block[] {
	const out: Block[] = [];
	const totalSteps = opts.steps.length;
	const doneCount = opts.checklist.filter((c) => c.done).length;
	const totalCount = Math.max(1, opts.checklist.length);

	// 1. Active Interactive Walkthrough Banner + Navigation Buttons
	if (opts.activeStep >= 1 && opts.activeStep <= totalSteps) {
		const step = opts.steps[opts.activeStep - 1]!;
		const navElements = [];
		if (opts.activeStep > 1) {
			navElements.push(
				elements.button("guide_prev", opts.labels.prevLabel, { style: "secondary" }),
			);
		}
		navElements.push(
			elements.button(
				"guide_next",
				opts.activeStep < totalSteps ? opts.labels.nextLabel : opts.labels.finishLabel,
				{ style: "primary" },
			),
		);
		navElements.push(
			elements.button("guide_close", opts.labels.closeLabel, { style: "secondary" }),
		);

		out.push(
			blocks.banner({
				blockId: "guide_wizard_banner",
				variant: "default",
				title: `${opts.labels.stepBadgePrefix} ${opts.activeStep}/${totalSteps} — ${step.title}`,
				description: step.description,
			}),
			blocks.actions(navElements, { blockId: "guide_wizard_actions" }),
		);
	}

	// 2. Onboarding Checklist Accordion + Meter Progress
	out.push(
		blocks.accordion({
			blockId: "guide_checklist_accordion",
			label: `${opts.labels.checklistTitle} (${doneCount}/${totalCount})`,
			defaultOpen: !opts.checklistCollapsed,
			blocks: [
				blocks.meter({
					blockId: "guide_checklist_meter",
					label: opts.labels.progressLabel,
					value: doneCount,
					min: 0,
					max: totalCount,
					customValue: `${doneCount} / ${totalCount}`,
				}),
				blocks.fields(
					opts.checklist.map((item) => ({
						label: `${item.done ? "✅" : "⬜"} ${item.label}`,
						value: item.detail,
					})),
					{ blockId: "guide_checklist_fields" },
				),
				blocks.actions(
					[
						elements.button(
							"guide_start",
							opts.activeStep > 0 ? opts.labels.replayButtonLabel : opts.labels.tourButtonLabel,
							{ style: "primary" },
						),
					],
					{ blockId: "guide_checklist_actions" },
				),
			],
		}),
	);

	// 3. Collapsible FAQ / Field Explanations
	if (opts.faq.length > 0) {
		out.push(
			blocks.accordion({
				blockId: "guide_faq_accordion",
				label: opts.labels.faqTitle,
				defaultOpen: false,
				blocks: [
					blocks.fields(
						opts.faq.map((f) => ({ label: f.q, value: f.a })),
						{ blockId: "guide_faq_fields" },
					),
				],
			}),
		);
	}

	return out;
}

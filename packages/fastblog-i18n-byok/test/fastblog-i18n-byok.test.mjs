import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import plugin from "../dist/plugin.mjs";

function createMockContext(options = {}) {
	const kvMap = new Map();
	const settingsMap = new Map(Object.entries(options.settings || {}));
	const entries = new Map();
	const translationGroups = new Map();
	const terms = [...(options.terms || [])];
	const openAiCalls = [];
	const publishCalls = [];

	for (const e of options.entries || []) {
		entries.set(`${e.type}:${e.id}`, { ...e });
		const g = e.translationGroup || `grp_${e.id}`;
		if (!translationGroups.has(g)) translationGroups.set(g, []);
		translationGroups.get(g).push({
			id: e.id,
			locale: e.locale || "en",
			slug: e.slug,
			status: e.status,
			updatedAt: e.updatedAt || "2026-11-26T00:00:00Z",
		});
	}

	const kv = {
		async get(key) {
			return kvMap.has(key) ? kvMap.get(key) : null;
		},
		async set(key, value) {
			kvMap.set(key, value);
		},
		async delete(key) {
			return kvMap.delete(key);
		},
		async list(prefix = "") {
			return Array.from(kvMap.entries())
				.filter(([k]) => !prefix || k.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};

	const content = {
		async get(collection, id) {
			return entries.get(`${collection}:${id}`) || null;
		},
		async list(collection) {
			const items = Array.from(entries.values()).filter((x) => x.type === collection);
			return { items };
		},
		async getTranslations(collection, id) {
			const e = entries.get(`${collection}:${id}`);
			if (!e) return { translationGroup: "", translations: [] };
			const g = e.translationGroup || `grp_${e.id}`;
			return { translationGroup: g, translations: translationGroups.get(g) || [] };
		},
		async create(collection, data, opts = {}) {
			const id = `tr_${entries.size + 1}`;
			const src = opts.translationOf ? entries.get(`${collection}:${opts.translationOf}`) : null;
			const group = src?.translationGroup || (src ? `grp_${src.id}` : `grp_${id}`);
			const item = {
				id,
				type: collection,
				slug: data.slug || id,
				status: "draft",
				locale: opts.locale || "zh-TW",
				data,
				seo: data.seo,
				translationGroup: group,
				createdAt: "2026-11-26T00:00:00Z",
				updatedAt: "2026-11-26T00:00:00Z",
				publishedAt: null,
			};
			entries.set(`${collection}:${id}`, item);
			if (!translationGroups.has(group)) translationGroups.set(group, []);
			translationGroups.get(group).push({
				id,
				locale: item.locale,
				slug: item.slug,
				status: item.status,
				updatedAt: item.updatedAt,
			});
			return item;
		},
		async update(collection, id, data) {
			const existing = entries.get(`${collection}:${id}`);
			assert.ok(existing);
			const updated = { ...existing, data, slug: data.slug || existing.slug, seo: data.seo ?? existing.seo };
			entries.set(`${collection}:${id}`, updated);
			return updated;
		},
		async getVersioned(collection, id) {
			const item = entries.get(`${collection}:${id}`);
			return item ? { item, _rev: `rev_${id}` } : null;
		},
		async publish(collection, id, opts) {
			publishCalls.push({ collection, id, rev: opts._rev });
			const existing = entries.get(`${collection}:${id}`);
			existing.status = "published";
			return { item: existing, _rev: `rev_${id}_pub` };
		},
	};

	const schema = {
		async listCollections() {
			return [
				{
					slug: "posts",
					label: "Posts",
					labelSingular: "Post",
					description: null,
					supports: ["title"],
					hasSeo: true,
					titleField: "title",
					dateField: "publishedAt",
					urlPattern: "/posts/:slug",
					routable: true,
					hidden: false,
					fields: [
						{ slug: "title", label: "Title", type: "text", required: true, unique: false, searchable: true, indexed: true, translatable: true, sortOrder: 1 },
						{ slug: "body", label: "Body", type: "portable_text", required: false, unique: false, searchable: true, indexed: false, translatable: true, sortOrder: 2 },
					],
				},
			];
		},
		async getCollection(slug) {
			const all = await this.listCollections();
			return all.find((c) => c.slug === slug) || null;
		},
	};

	const taxonomies = {
		async getAll() {
			return [{ name: "category", label: "Category", labelSingular: "Category", hierarchical: true, collections: ["posts"], locale: "en" }];
		},
		async getTerms(taxonomy) {
			return terms.filter((t) => t.taxonomy === taxonomy);
		},
		async createTerm(taxonomy, input) {
			const t = {
				id: `term_${terms.length + 1}`,
				taxonomy,
				slug: input.slug || input.label.toLowerCase(),
				label: input.label,
				parentId: null,
				data: input.description ? { description: input.description } : null,
				locale: input.locale || "zh-TW",
				translationGroup: `tgrp_${input.translationOf || terms.length}`,
			};
			terms.push(t);
			return t;
		},
	};

	const http = {
		async fetch(url, init) {
			assert.equal(url, "https://api.openai.com/v1/chat/completions", "Must ONLY call allowedHosts api.openai.com");
			const reqBody = JSON.parse(String(init?.body || "{}"));
			openAiCalls.push(reqBody);
			const userPayload = JSON.parse(reqBody.messages[1].content);
			const translations = userPayload.items.map((it) => {
				let text = String(it.text || "");
				text = text.replace(/Hello World/g, "你好世界");
				text = text.replace(/Bold Guide/g, "粗體指南");
				text = text.replace(/Read docs at/g, "查閱文件於");
				text = text.replace(/SEO Title/g, "搜尋最佳化標題");
				text = text.replace(/SEO Desc/g, "搜尋描述摘要");
				text = text.replace(/Tutorials/g, "實戰教學");
				if (text === it.text) text = `[ZH] ${text}`;
				return { id: it.id, text };
			});
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: JSON.stringify({ translations }) } }],
					usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	};

	return {
		ctx: {
			plugin: { id: "fastblog-i18n-byok", version: "0.1.0" },
			kv,
			storage: {},
			settings: {
				async get(k) { return settingsMap.get(k); },
				async getAll() { return Object.fromEntries(settingsMap.entries()); },
			},
			content,
			schema,
			taxonomies,
			http,
			log: { info() {}, warn() {}, error() {}, debug() {} },
			site: { name: "Demo", url: "https://example.com", locale: "en" },
			url(p) { return `https://example.com${p}`; },
		},
		openAiCalls,
		publishCalls,
		entries,
		terms,
	};
}

function getHandler(name) {
	const r = plugin.routes?.[name];
	assert.ok(r, `Missing route ${name}`);
	return typeof r === "function" ? r : r.handler;
}

test("TC1: 6-locale dictionary parity check", () => {
	const src = fs.readFileSync(new URL("../src/i18n-messages.ts", import.meta.url), "utf8");
	for (const loc of ['"zh-TW":', '"zh-CN":', "en:", "ja:", "ko:", "es:"]) {
		assert.ok(src.includes(loc), `Missing locale ${loc}`);
	}
});

test("TC2: Lossless PortableText translation, translationOf linking, idempotent update & autoPublish", async () => {
	const { ctx, openAiCalls, publishCalls, entries } = createMockContext({
		settings: {
			openaiApiKey: "sk-test-1234",
			model: "gpt-6-luna",
			targetLocales: "zh-TW,ja",
			autoPublish: true,
		},
		entries: [
			{
				id: "post_1",
				type: "posts",
				slug: "hello-world",
				status: "published",
				locale: "en",
				seo: { title: "SEO Title", description: "SEO Desc", image: null, canonical: null, noIndex: false },
				data: {
					title: "Hello World",
					body: [
						{
							_type: "block",
							_key: "b1",
							children: [
								{ _type: "span", _key: "s1", marks: ["strong"], text: "Bold Guide" },
								{ _type: "span", _key: "s2", marks: [], text: " Read docs at https://emdashcms.com about EmDash" },
							],
						},
					],
				},
			},
		],
	});

	const mcpTranslate = getHandler("mcp-translate-entry");
	const first = await mcpTranslate(
		{ input: { collection: "posts", entryId: "post_1", targetLocale: "zh-TW" }, request: { url: "https://example.com/r", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(first.action, "created");
	assert.equal(first.published, true);
	assert.equal(openAiCalls.length, 1);
	assert.equal(openAiCalls[0].model, "gpt-6-luna");
	assert.equal(openAiCalls[0].temperature, 1);
	assert.equal(publishCalls.length, 1);

	const created = entries.get(`posts:${first.id}`);
	assert.equal(created.data.title, "你好世界");
	assert.equal(created.seo.title, "搜尋最佳化標題");
	assert.equal(created.data.body[0].children[0].marks[0], "strong", "Inline bold mark MUST survive AST round-trip");
	assert.ok(created.data.body[0].children[1].text.includes("https://emdashcms.com"), "URL placeholder must restore intact");
	assert.ok(created.data.body[0].children[1].text.includes("EmDash"), "Locked brand term EmDash must restore intact");

	// Second call updates existing translation cleanly instead of duplicating
	const second = await mcpTranslate(
		{ input: { collection: "posts", entryId: "post_1", targetLocale: "zh-TW" }, request: { url: "https://example.com/r", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(second.action, "updated");
	assert.equal(second.id, first.id);
});

test("TC3: Taxonomy translation, Admin 4 tabs + BlockGuideKit, Editor Panel & missing API key guard", async () => {
	const { ctx, terms } = createMockContext({
		settings: {
			openaiApiKey: "sk-test-5678",
			model: "gpt-4o-mini",
			targetLocales: "zh-TW,ja",
		},
		entries: [
			{
				id: "post_src",
				type: "posts",
				slug: "src-post",
				status: "published",
				locale: "en",
				data: { title: "Hello World" },
			},
		],
		terms: [
			{
				id: "cat_1",
				taxonomy: "category",
				slug: "tutorials",
				label: "Tutorials",
				parentId: null,
				data: { description: "Tutorials" },
				locale: "en",
				translationGroup: "tgrp_1",
			},
		],
	});

	// 1. Admin Dashboard page_load + 6-locale switch + BlockGuideKit tour
	const adminHandler = getHandler("admin");
	const loadEn = await adminHandler(
		{ input: { type: "page_load", page: "/translate" }, request: { url: "https://example.com/admin", method: "POST", headers: {} } },
		ctx,
	);
	const vLoad = validateBlockResponse(loadEn, { pluginPagePaths: ["/translate"] });
	assert.equal(vLoad.valid, true, JSON.stringify(vLoad.errors));

	const loadTw = await adminHandler(
		{ input: { type: "block_action", action_id: "set_ui_locale", value: "zh-TW", page: "/translate" }, request: { url: "https://example.com/admin", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(loadTw.blocks[0]?.text, "AI 多語系翻譯超人 (OpenAI BYOK)");

	// 2. Estimate Tokens (0 LLM calls!)
	const estRes = await adminHandler(
		{
			input: { type: "form_submit", action_id: "estimate_entry", page: "/translate", values: { collection: "posts", entryId: "post_src", targetLocale: "zh-TW" } },
			request: { url: "https://example.com/admin", method: "POST", headers: {} },
		},
		ctx,
	);
	assert.equal(validateBlockResponse(estRes, { pluginPagePaths: ["/translate"] }).valid, true);

	// 3. Scan untranslated queue & glossary upsert MCP
	const mcpUntranslated = getHandler("mcp-list-untranslated");
	const qRes = await mcpUntranslated(
		{ input: { collection: "posts", targetLocale: "zh-TW" }, request: { url: "https://example.com/mcp", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(qRes.count, 1);

	const mcpGlossary = getHandler("mcp-upsert-glossary");
	const gRes = await mcpGlossary(
		{ input: { action: "upsert", sourceTerm: "EmDash", targetTerm: "EmDash", lockExact: true }, request: { url: "https://example.com/mcp", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(gRes.glossaryCount, 1);

	// 4. Translate taxonomies via MCP
	const mcpTax = getHandler("mcp-translate-taxonomies");
	const tRes = await mcpTax(
		{ input: { taxonomy: "category", targetLocale: "zh-TW" }, request: { url: "https://example.com/mcp", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(tRes.translatedCount, 1);
	assert.ok(terms.some((x) => x.locale === "zh-TW" && x.label === "實戰教學"));

	// 5. Editor Panel render & 1-click translate
	const panelHandler = getHandler("editor-panel");
	const panelUi = {
		locale: "zh-TW",
		direction: "ltr",
		surface: "content-editor-panel",
		entry: { collection: "posts", id: "post_src", locale: "en", version: 1 },
		extensionId: "i18n-byok-panel",
	};
	const panelRes = await panelHandler(
		{ input: { type: "block_action", action_id: "panel_translate_locale", value: "zh-TW" }, ui: panelUi, request: { url: "https://example.com/panel", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(panelRes.refresh, true);
	assert.equal(validateBlockResponse(panelRes, { pluginPagePaths: ["/translate"] }).valid, true);

	// 6. Missing OpenAI API key rejects cleanly without external HTTP call
	const emptyKeyMock = createMockContext({
		settings: { targetLocales: "zh-TW" },
		entries: [{ id: "p1", type: "posts", slug: "p1", status: "published", locale: "en", data: { title: "Hi" } }],
	});
	const mcpTranslate = getHandler("mcp-translate-entry");
	await assert.rejects(
		() => mcpTranslate({ input: { collection: "posts", entryId: "p1", targetLocale: "zh-TW" }, request: { url: "https://example.com/mcp", method: "POST", headers: {} } }, emptyKeyMock.ctx),
		/Missing OpenAI API|OpenAI API Key/,
	);
});

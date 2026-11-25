import assert from "node:assert/strict";
import test from "node:test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import plugin from "../dist/plugin.mjs";

function createMockContext(initialSettings = {}) {
	const kvMap = new Map();
	let revSeq = 0;

	const kv = {
		async get(key) {
			return kvMap.has(key) ? kvMap.get(key).value : null;
		},
		async getVersioned(key) {
			return kvMap.has(key) ? kvMap.get(key) : null;
		},
		async compareAndSet(key, expectedRevision, value) {
			const existing = kvMap.get(key) || null;
			const currentRev = existing ? existing.revision : null;
			if (expectedRevision !== currentRev) {
				return { applied: false, revision: currentRev };
			}
			const revision = `rev-${++revSeq}`;
			kvMap.set(key, { value, revision });
			return { applied: true, revision };
		},
		async compareAndDelete(key, expectedRevision) {
			const existing = kvMap.get(key) || null;
			if (!existing || existing.revision !== expectedRevision) {
				return { deleted: false };
			}
			kvMap.delete(key);
			return { deleted: true };
		},
		async set(key, value) {
			kvMap.set(key, { value, revision: `rev-${++revSeq}` });
		},
		async delete(key) {
			return kvMap.delete(key);
		},
		async list(prefix = "") {
			const rows = [];
			for (const [k, entry] of kvMap.entries()) {
				if (!prefix || k.startsWith(prefix)) {
					rows.push({ key: k, value: entry.value });
				}
			}
			return rows;
		},
	};

	const settingsMap = new Map(Object.entries(initialSettings));

	return {
		plugin: { id: "countdown-gif", version: "0.1.0" },
		kv,
		storage: {},
		settings: {
			async get(key) {
				return settingsMap.get(key);
			},
			async getAll() {
				return Object.fromEntries(settingsMap.entries());
			},
		},
		log: {
			info() {},
			warn() {},
			error() {},
			debug() {},
		},
		site: {
			name: "FastBlog Demo",
			url: "https://demo.fastblog.cc",
		},
		url(path) {
			return `https://demo.fastblog.cc${path.startsWith("/") ? "" : "/"}${path}`;
		},
	};
}

function getHandler(routeName) {
	const route = plugin.routes?.[routeName];
	assert.ok(route, `Route ${routeName} should exist`);
	return typeof route === "function" ? route : route.handler;
}

test("plugin:install initializes signing secret and timer-gif rejects unsigned/tampered URLs (403)", async () => {
	const ctx = createMockContext();
	const installHook = plugin.hooks?.["plugin:install"];
	assert.equal(typeof installHook, "function");
	await installHook({ pluginId: "countdown-gif", version: "0.1.0" }, ctx);

	const secret = await ctx.kv.get("signing_secret");
	assert.equal(typeof secret, "string");
	assert.ok(secret.length >= 24);

	const timerGifHandler = getHandler("timer-gif");
	const unsignedRes = await timerGifHandler(
		{
			input: { end: String(Math.floor(Date.now() / 1000) + 600) },
			request: {
				url: "https://demo.fastblog.cc/_emdash/api/plugins/countdown-gif/timer-gif?end=1999999999",
				method: "GET",
				headers: {},
			},
		},
		ctx,
	);
	assert.equal(unsignedRes.status, 403);
});

test("Full flow: MCP CRUD -> signed GIF89a (active/expired/pill) -> Evergreen 302 -> Block Kit Admin", async () => {
	const ctx = createMockContext({
		siteOrigin: "https://shop.fastblog.cc",
		defaultStyle: "red",
	});

	const mcpCreate = getHandler("mcp-create-timer");
	const mcpList = getHandler("mcp-list-timers");
	const mcpEmbed = getHandler("mcp-generate-embed");
	const mcpDelete = getHandler("mcp-delete-timer");
	const timerGifHandler = getHandler("timer-gif");
	const goHandler = getHandler("go");
	const adminHandler = getHandler("admin");

	// 1. Create an evergreen timer via MCP
	const created = await mcpCreate(
		{
			input: {
				name: "VIP Welcome Offer",
				mode: "evergreen",
				durationMinutes: 120,
				activeUrl: "https://shop.fastblog.cc/vip-offer",
				expiredUrl: "https://shop.fastblog.cc/waitlist",
				style: "gold",
			},
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/mcp-create-timer", method: "POST", headers: {} },
		},
		ctx,
	);
	assert.equal(created.timer.id, "vip-welcome-offer");
	assert.ok(created.embed.gifUrl.startsWith("https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/timer-gif?"));
	assert.ok(created.embed.redirectUrl.startsWith("https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/go?"));
	assert.ok(created.embed.imgHtml.includes("<img src="));

	// 2. Fetch active animated GIF89a via signed timer-gif route
	const gifUrl = new URL(created.embed.gifUrl);
	const gifResp = await timerGifHandler(
		{
			input: Object.fromEntries(gifUrl.searchParams.entries()),
			request: { url: gifUrl.toString(), method: "GET", headers: {} },
		},
		ctx,
	);
	assert.equal(gifResp.__emdashPluginResponse, true);
	assert.equal(gifResp.status, 200);
	assert.equal(gifResp.body?.kind, "bytes");
	const gifBytes = gifResp.body.value;
	assert.equal(new TextDecoder("ascii").decode(gifBytes.slice(0, 6)), "GIF89a");
	assert.equal(gifBytes[gifBytes.length - 1], 0x3b);
	assert.ok(gifBytes.length > 1000 && gifBytes.length < 40 * 1024);

	// 3. Tampered GIF signature must be rejected with 403
	const tamperedGifUrl = new URL(gifUrl);
	tamperedGifUrl.searchParams.set("end", String(Math.floor(Date.now() / 1000) + 999999));
	const tamperedGifResp = await timerGifHandler(
		{
			input: Object.fromEntries(tamperedGifUrl.searchParams.entries()),
			request: { url: tamperedGifUrl.toString(), method: "GET", headers: {} },
		},
		ctx,
	);
	assert.equal(tamperedGifResp.status, 403);

	// 4. Test go 302 active redirect (future exp)
	const activeRedirectUrl = new URL(created.embed.redirectUrl);
	const activeRes = await goHandler(
		{
			input: Object.fromEntries(activeRedirectUrl.searchParams.entries()),
			request: { url: activeRedirectUrl.toString(), method: "GET", headers: {} },
		},
		ctx,
	);
	assert.equal(activeRes.status, 302);
	const activeLoc = activeRes.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
	assert.equal(activeLoc, "https://shop.fastblog.cc/vip-offer");

	// 5. Generate expired deadline embed & test expired GIF + go 302 expired redirect
	const pastIso = new Date(Date.now() - 120_000).toISOString();
	const pastEmbed = await mcpEmbed(
		{
			input: { timerId: "vip-welcome-offer", deadline: pastIso },
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/mcp-generate-embed", method: "POST", headers: {} },
		},
		ctx,
	);
	const expiredGifUrl = new URL(pastEmbed.gifUrl);
	const expiredGifResp = await timerGifHandler(
		{
			input: Object.fromEntries(expiredGifUrl.searchParams.entries()),
			request: { url: expiredGifUrl.toString(), method: "GET", headers: {} },
		},
		ctx,
	);
	assert.equal(expiredGifResp.status, 200);
	assert.equal(new TextDecoder("ascii").decode(expiredGifResp.body.value.slice(0, 6)), "GIF89a");

	const expiredRedirectUrl = new URL(pastEmbed.redirectUrl);
	const expiredRes = await goHandler(
		{
			input: Object.fromEntries(expiredRedirectUrl.searchParams.entries()),
			request: { url: expiredRedirectUrl.toString(), method: "GET", headers: {} },
		},
		ctx,
	);
	assert.equal(expiredRes.status, 302);
	const expiredLoc = expiredRes.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
	assert.equal(expiredLoc, "https://shop.fastblog.cc/waitlist");

	// 6. List timers via MCP
	const listed = await mcpList(
		{ input: {}, request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/mcp-list-timers", method: "POST", headers: {} } },
		ctx,
	);
	assert.equal(listed.count, 1);

	// 7. Admin Block Kit page_load + form_submit create + validation
	const adminResp = await adminHandler(
		{
			input: { type: "page_load", page: "/timers" },
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/admin", method: "POST", headers: {} },
		},
		ctx,
	);
	const v1 = validateBlockResponse(adminResp, { pluginPagePaths: ["/timers"] });
	assert.equal(v1.valid, true, `Block Kit validation errors: ${JSON.stringify(v1.errors)}`);

	const formResp = await adminHandler(
		{
			input: {
				type: "form_submit",
				action_id: "create_timer",
				page: "/timers",
				values: {
					name: "Pill Urgent Sale",
					mode: "fixed",
					endAt: new Date(Date.now() + 3600_000).toISOString(),
					activeUrl: "https://shop.fastblog.cc/pill",
					expiredUrl: "https://shop.fastblog.cc/closed",
					style: "red",
					layout: "pill",
					expiredPreset: "closed_zh",
				},
			},
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/admin", method: "POST", headers: {} },
		},
		ctx,
	);
	assert.equal(formResp.toast?.type, "success");
	const v2 = validateBlockResponse(formResp, { pluginPagePaths: ["/timers"] });
	assert.equal(v2.valid, true, `Form Block Kit validation errors: ${JSON.stringify(v2.errors)}`);

	// 8. Delete timers cleanly via Admin & MCP
	await adminHandler(
		{
			input: { type: "block_action", action_id: "delete_timer", value: "pill-urgent-sale", page: "/timers" },
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/admin", method: "POST", headers: {} },
		},
		ctx,
	);
	const deleted = await mcpDelete(
		{
			input: { timerId: "vip-welcome-offer" },
			request: { url: "https://shop.fastblog.cc/_emdash/api/plugins/countdown-gif/mcp-delete-timer", method: "POST", headers: {} },
		},
		ctx,
	);
	assert.equal(deleted.deleted, true);
});

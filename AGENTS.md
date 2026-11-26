# FastBlog Open-Source EmDash Sandbox Plugins (`@plugins.fastblog.cc`)

- **Publisher Identity**: `@plugins.fastblog.cc` (`did:plc:776f7xdpfb7dj5ti2l3au3ga`)
- **Registry URL**: `https://plugins.emdashcms.com/plugins/@plugins.fastblog.cc`
- **SSH Push Command on Windows**: Always use `GIT_SSH_COMMAND='"C:/Program Files/Git/usr/bin/ssh.exe" -o BatchMode=yes' git push ssh main` (and tags).
- **Packages**: Listed in `fastblog-plugins.json` and living under `packages/<slug>/`. Every new package must include full 6-locale UI (`zh-TW`, `zh-CN`, `en`, `ja`, `ko`, `es`), `BlockGuideKit` interactive onboarding, `tests/` unit checks, and pass `pnpm build && pnpm typecheck && pnpm test && pnpm validate`.

## Mandatory Flagship Auto-Sync Covenant (`https://fastblog.cc` — Rule 55)

Every time a new open-source Sandbox plugin is created or updated in this repository, you MUST automatically sync all changes to `E:\fastblog-workspace` and `https://fastblog.cc` (`blog-official`, D1 `emdash_db_official` UUID `5570a1aa-d11d-42e8-bb71-426c85d1c320`) in the same task — never wait for the user to ask:

1. **Register in `E:\fastblog-workspace\template\src\data\showcase-catalog.ts`**:
   - Add the new plugin to `SHOWCASE_PLUGINS` with complete 6-locale metadata (`zh-TW`, `zh-CN`, `en`, `ja`, `ko`, `es`), permissions, routes, highlights, MCP tool names, EmDash Registry URL, GitHub URL, and `guideTranslationGroup`.
   - Dynamic counts (`SANDBOX_PLUGIN_COUNT`, `NATIVE_PLUGIN_COUNT`, `TOTAL_PLUGIN_COUNT`) automatically recalculate across homepage, `/plugins`, comparison rows, and plan cards — verify no stale hardcoded counts exist anywhere.
2. **Write & Publish a Complete 6-Locale E-E-A-T Tutorial Article on `fastblog.cc`**:
   - Publish a detailed `zh-TW` guide (`slug: guide-<slug>`, `translation_group: tg_guide_<slug>`) on `emdash_db_official` featuring:
     - Author Byline (`FastBlog 技術架構團隊` / `tg_byline_fastblog_team` in `_emdash_bylines` + `_emdash_content_bylines`),
     - Strictly **1 Category** and **1 Tag** (`taxonomies` + `content_taxonomies`),
     - SEO **Excerpt** (`excerpt`), clickable **Table of Contents (`文章目錄`)**, deep pain-point/architecture/tutorial body, and **FAQ (`常見問答`)**.
   - Translate the article (and any new taxonomies) into all 6 locales (`zh-TW`, `zh-CN`, `en`, `ja`, `ko`, `es`) using our native **`fastblog-i18n` (`多語系翻譯超人`)** plugin.
3. **Sync `shop_products` & Deploy**:
   - Audit and update plugin counts and descriptions in `emdash_db_official` `shop_products` (e.g., `prod_fastblog_pro_annual`, `prod_fastblog_flagship_dfy`).
   - Build/test `E:\fastblog-workspace\template`, push to GitHub, deploy `blog-official` (`fastblog.cc`), and purge affected Cloudflare CDN cache keys.

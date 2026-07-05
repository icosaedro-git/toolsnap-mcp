# ToolSnap MCP — Design spec (final)

> Written by Fable 5 (Fase 21.1). The builder (Sonnet) implements this EXACTLY — no taste decisions left open. Reference composition: `assets/brand/hero-reference-desktop.jpg` / `hero-reference-mobile.png` (composition only — do NOT use these images in the site; their baked-in text has kerning issues). Blog structural reference: `web-unairodriguez/.claude/worktrees/goofy-swartz-ce4d78/src-blog/` (structure yes, colors/fonts NO).

## 1. Design tokens (CSS custom properties on `:root`)

```css
:root {
  /* color */
  --ink:        #0B0E14;  /* page background — never pure black */
  --ink-2:      #0E1219;  /* alternating section background */
  --surface:    #10151C;  /* cards */
  --surface-2:  #151B24;  /* raised cards, code blocks */
  --border:     #1D242E;
  --border-strong: #232B36;
  --head:       #F4F4F0;  /* headlines ONLY (off-white) */
  --text:       #C6CCD4;  /* body — never pure white */
  --text-soft:  #9AA3AE;
  --text-mute:  #6B7480;
  --lime:       #A3E635;  /* THE accent: CTAs, key numbers, highlights, FREE badges */
  --lime-deep:  #65A30D;  /* gradients only, never text */
  --lime-glow:  rgba(163,230,53,.14);
  --teal:       #2DD4BF;  /* secondary accent: sparingly — blog featured gradient, small details */
  --cyan-soft:  #7DD3FC;  /* inline links in body text and code strings only */
  --danger:     #F87171;

  /* type */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;      /* self-host woff2, weights 400/500/650(600)/750(700) */
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;          /* self-host woff2, weights 400/600 */

  /* shape & motion */
  --r: 8px;               /* ONE radius everywhere (cards, buttons, inputs, code) */
  --r-pill: 999px;        /* pills/badges only */
  --ease: cubic-bezier(.22,.61,.36,1);
  --dur: .28s;

  /* layout */
  --container: 1120px;    /* max-width, padding-inline 24px (16px <480px) */
  --sect-y: clamp(80px, 12vw, 150px);   /* section vertical padding desktop→mobile handled by clamp */
}
```

Rules:
- Pure white `#FFF` appears nowhere. `--head` only on h1/h2/h3 and card titles. Body text `--text`.
- `--lime` is precious: CTAs, the hero highlight word, key stats, FREE badges, hover glows. If a screen has more than ~3 lime elements visible, remove one.
- `--teal`/`--cyan-soft` are supporting cast — never on buttons.
- Backgrounds alternate `--ink` / `--ink-2` per section to create rhythm without lines.

## 2. Typography scale

- h1: `clamp(2.5rem, 6vw, 4.25rem)`, weight 700, letter-spacing `-0.03em`, line-height 1.05, color `--head`.
- h2 (section): `clamp(1.75rem, 3.5vw, 2.5rem)`, weight 650, ls `-0.02em`, lh 1.15.
- Eyebrow: `--font-mono`, `0.78rem`, weight 600, ls `.12em`, uppercase, color `--lime`; preceded by a 24px × 1px lime line (inline-block) with 10px gap.
- Body: `1.0–1.06rem`, lh 1.65, color `--text`. Section intro paragraphs max-width `640px`.
- Mono is mandatory for: numbers/stats, prices, tool names, code, endpoint URLs, dates, read-time.
- Big stats (hero strip, pricing): `--font-mono`, weight 600, `clamp(1.9rem, 3vw, 2.6rem)`, color `--lime`, `font-variant-numeric: tabular-nums`.

## 3. Core components

### Buttons
- Primary: bg `--lime`, text `#0B0E14` (weight 650), padding `16px 32px`, radius `--r`, no border. Hover: `box-shadow: 0 0 0 1px var(--lime), 0 8px 32px -8px rgba(163,230,53,.45)`, `transform: translateY(-1px)`, bg lightens to `#B5F04D`. Active: translateY(0).
- Ghost: transparent, `1px solid var(--border-strong)`, text `--head`. Hover: border-color `--lime`, text `--lime`, subtle `--lime-glow` inner glow.
- All transitions `var(--dur) var(--ease)`.

### Cards
- bg `--surface`, `1px solid var(--border)`, radius `--r`, padding `28px`.
- Hover (only where the card is a link/interactive): `translateY(-3px)`, border-color `--border-strong`, `box-shadow: 0 20px 40px -16px rgba(0,0,0,.5), 0 0 24px -12px var(--lime-glow)`.
- No tilt effects in v1.

### Badges
- `FREE`: mono 0.72rem weight 600, color `--lime`, bg `rgba(163,230,53,.08)`, `1px solid rgba(163,230,53,.25)`, radius `--r-pill`, padding `2px 10px`.
- Price badge: same shape, color `--text-soft`, border `--border-strong`, e.g. `$0.04 · $0.025 prepaid`.
- Category tag (blog): mono 0.74rem uppercase ls `.07em`, color `--lime`.

### Code blocks / snippet panels
- bg `--surface-2`, border `--border`, radius `--r`, `--font-mono` 0.9rem, padding `18px 20px`, overflow-x auto.
- Every snippet gets a copy button (top-right, ghost icon button): on click → icon swaps to check + text `Copied` in lime for 1.5s. Implement once as a small Astro component + vanilla JS.
- Inline code: bg `--surface-2`, 1px border, radius 4px, padding `1px 6px`, color `--cyan-soft`.

### Tabs (How-to-connect)
- Segmented control: container bg `--surface`, border `--border`, radius `--r`; active segment bg `--surface-2` with lime text and a 2px lime underline. Mono labels.

### Header
- Sticky, `backdrop-filter: blur(12px)`, bg `rgba(11,14,20,.8)`, bottom border `--border` (appears only after scroll > 8px, via JS class).
- Left: logo emblem 28px (`assets/brand/logo-transparent.png` scaled, or favicon-192) + wordmark `ToolSnap` (weight 650, `--head`) + `MCP` (weight 400, `--text-soft`). Center/right: nav links (`--text-soft`, hover `--head`, active `--lime`). Far right: `Connect free` primary button (compact: 10px 20px).
- Mobile (<820px): hamburger → full-screen overlay menu (bg `--ink`, links as large mono list), CTA at bottom.

### Footer
- bg `--ink-2`, top border `--border`, columns per COPY.md, links `--text-soft` hover `--head`. Endpoint URL in mono with copy button. Small print `--text-mute`.

## 4. Landing — section by section

Order: Hero → Problem → Connect → Tools → Recipes → Pricing → Trust → Final CTA. Alternate bg starting `--ink` (hero) then `--ink-2` (problem), etc. Section padding `--sect-y`.

### 4.1 Hero (the money shot)
Two-column grid (desktop ≥980px): text left (55%), living logo right (45%). Mobile: logo (smaller, 220px) above text, all centered.

- **Living logo**: `<video>` `assets/brand/logo-loop-720.webm` + `.mp4` fallback, `muted loop playsinline autoplay preload="metadata"`, `poster="logo-loop-poster.jpg"`. JS: `video.playbackRate = 0.55`. Size ~`min(38vw, 460px)` square.
  - Blend trick: the video has a near-`--ink` dark bg. Wrap in a div with `border-radius: 50%; overflow: hidden;` and apply a CSS mask: `-webkit-mask-image: radial-gradient(circle, black 58%, transparent 72%)` so edges dissolve into the page background. No visible rectangle allowed.
  - Behind it, a glow div: `background: radial-gradient(circle, var(--lime-glow), transparent 65%)`, size 130%, `animation: glowDrift 14s ease-in-out infinite alternate` (translate ±3%, scale 1→1.06, opacity .7→1).
  - `@media (prefers-reduced-motion: reduce)`: hide video, show `logo-loop-poster.jpg` (same mask), no glow animation.
- **Background texture**: full-hero SVG of 5–6 thin curved lines (stroke `#232B36`, 1px, opacity .5) converging from the left edge toward the logo — echoes the reference art. Position absolute, `pointer-events:none`, behind text. Plus a very soft radial green tint top-right: `radial-gradient(ellipse 60% 40% at 75% 20%, rgba(45,80,22,.12), transparent)`.
- Text column: eyebrow → h1 (line 2 has `Superpowers` wrapped in `<span class="lime">`) → subhead (`--text-soft`, max 520px) → CTA row (primary + ghost, 16px gap) → stat strip.
- **Stat strip**: 3 items separated by 1px vertical `--border` dividers; number (mono lime) over label (`--text-mute` 0.85rem). Margin-top 56px. Micro-caption below in `--text-mute` 0.8rem, max 560px.
- Hero min-height: `calc(100svh - 68px)` desktop, natural height mobile.

### 4.2 Problem section
Centered: eyebrow + h2 (max 720px) + body (max 640px). Below: 3 mini-cards in a row (grid 3×1, 20px gap; stack <760px). Icons: inline SVG 24px, stroke `--lime`, 1.5px — use simple geometric strokes (arrow-into-box, equals-sign, server rack). No emoji.

### 4.3 Connect section (`#connect`)
- Two big tabs (`Free — just the URL` / `Paid — credits or crypto`).
- Tab 1: main snippet (Claude Code) large; beneath, small client-switcher (mono text-links: Claude Code · Claude Desktop/claude.ai · Cursor/JSON) that swaps the snippet. Caption under panel.
- Tab 2: two cards side by side (Card A credits / Card B crypto) each with copy per COPY.md; snippet inside card A. Stack <860px.
- This section sits on `--ink-2` with a subtle top glow: `radial-gradient(ellipse 50% 30% at 50% 0%, var(--lime-glow), transparent)` at low opacity.

### 4.4 Tools overview
Eyebrow/h2/intro centered, then family grid: 4×2 (desktop), 2×4 (tablet), 1-col (mobile), 16px gap. Each family card: family name (weight 650, `--head`), count in mono (`9 tools · 8 free`), blurb (`--text-soft`, 0.92rem). Whole card links to `/tools#<family>`. CTA button (ghost) centered below.

### 4.5 Recipes
2 recipe cards side by side (stack <860px). Card: title, summary, tool chips row (mono 0.78rem; paid ones get the price badge), `Estimated cost` line (mono), `Copy prompt` ghost button + `Details →` link to `/recipes`.

### 4.6 Pricing summary
3 columns (stack <860px). Middle column (`Credits`) gets `border-color: var(--lime); box-shadow: 0 0 40px -20px var(--lime-glow)` — it's the conversion path for non-crypto humans. Big number mono. CTA below.

### 4.7 Trust strip
On `--ink-2`. h2 centered + 4 bullets in 2×2 grid (stack mobile): each = 20px lime check/shield SVG + text (`--text-soft`).

### 4.8 Final CTA band
Centered: h2, sub, then the endpoint URL as a large mono copyable pill (`--surface-2`, border, copy button), then primary button. Behind: soft radial lime glow. Generous padding (`--sect-y` × 1.2).

## 5. Inner pages

Shared: small hero (h1 + lead, padding-top 96px, padding-bottom 48px) then content. Same header/footer.

- **/tools**: sticky-top family jump-nav (horizontal scroll pills, mono). Family = h2 with anchor + tool rows: `display:grid; grid-template-columns: 220px 1fr auto;` (name mono `--head` · description `--text-soft` · badge). Row hover: bg `--surface`. Callout box: `--surface`, left border 3px lime.
- **/recipes**: recipe cards full-width, prompt inside `<details>` (summary styled as ghost button `Show full prompt`); prompt block = code block with copy button.
- **/pricing**: tables as styled cards — header row mono uppercase `--text-mute`; row borders `--border`. FAQ as `<details>` list, summary weight 650 `--head` with `+` marker rotating 45° when open.
- **/docs**: single column max-width 760px; sections numbered with mono lime `01`–`07` markers; right-side sticky mini-TOC (desktop ≥1100px only, `--text-mute` links, active in lime via IntersectionObserver).
- **/wallet-guide**: same shell as docs. Callouts: radius `--r`, bg `--surface`, left border 3px (Tip lime · Note `--cyan-soft` · Warning `--danger` · Trust `--teal`), title row with small icon + mono uppercase label.
- **/terms /privacy /refunds**: docs shell, no TOC, legal text as-is.
- **404**: centered, huge mono `404` in lime (clamp 6–10rem, opacity .9), copy + button per COPY.md.

## 6. Blog (structure cloned from web-unairodriguez, reskinned)

Clone the STRUCTURE of `src-blog/src/pages/blog/index.astro` + `[slug].astro` + content collection + RSS + JSON-LD from the reference worktree. Replace all colors/fonts with tokens above. Categories per COPY.md.

- **Card gradient box (regular cards)** — replaces the indigo `card__img`:
```css
.card__img{
  background:
    radial-gradient(ellipse 65% 50% at 84% 8%, rgba(163,230,53,0.07) 0%, transparent 58%),
    linear-gradient(135deg, rgba(163,230,53,0) 22%, rgba(163,230,53,0.08) 42%, rgba(190,242,100,0.12) 50%, rgba(163,230,53,0.07) 58%, rgba(163,230,53,0) 78%),
    linear-gradient(150deg, #0F1A0C 0%, #1E3A14 30%, #2B4A18 50%, #17300F 72%, #0B1408 100%);
}
```
  (dark metallic green with a lime sheen sweep — same 3-layer technique as the reference)
- **Featured card gradient (must read as clearly different/livelier)**:
```css
.card--featured .card__img{
  background:
    radial-gradient(ellipse 70% 55% at 80% 10%, rgba(45,212,191,0.16) 0%, transparent 60%),
    linear-gradient(145deg, #3F6212 0%, #65A30D 34%, #0D9488 68%, #0B1F1C 100%);
}
```
  (lime → teal — the equivalent of the reference's blue→magenta featured treatment)
- Card titles on the gradient: `--head`, text-shadow `0 1px 8px rgba(0,0,0,.35)`. Body panel: `background: color-mix(in srgb, var(--lime) 6%, var(--surface))`. Meta line mono. Hover: same lift as reference (translateY(-3px) + lime-tinted shadow).
- Featured logic identical to reference: `featured` flag, else most recent; featured card fills the blog hero viewport; `More articles` 2-col grid below.
- **Post page** (`[slug].astro`): centered 720px measure, h1 clamp(2–3rem), meta row (category tag · date · read time, mono), prose styles (headings `--head`, links `--cyan-soft` underline, blockquote left border lime, code per §3, images radius `--r`). Bottom: `← All articles` + RSS link.
- Keep `rss.xml` and JSON-LD (adapt name/urls to ToolSnap MCP, author `ToolSnap`).

## 7. Motion (Pass 2)

- **Scroll reveal**: single IntersectionObserver; elements with `.reveal` start `opacity:0; translateY(18px)` → `.in` transitions `0.6s var(--ease)`; stagger siblings by `transition-delay: calc(var(--i) * 60ms)` (set `--i` per child, max 5). Apply to: section headers, cards, stat items, snippet panels. Fire once (unobserve). Everything visible without JS (progressive enhancement: `.reveal` styles only under `html.js`).
- **Hero glow drift** per §4.1. Video playbackRate 0.55.
- **Hovers** per §3.
- `@media (prefers-reduced-motion: reduce)`: kill reveals (show final state), glow static, video → poster.
- NO scroll-jacking, NO parallax on text, NO animation on legal pages.

## 8. Assets & meta

- Favicons: `favicon-32.png` (icon), `favicon-180.png` (apple-touch), `favicon-192/512` + `site.webmanifest`. Replace the Worker's inline indigo SVG favicon route (assets shadow it).
- OG image: generate ONE static `og-default.png` 1200×630 — ink bg, emblem left (from `logo-transparent.png`), wordmark `ToolSnap MCP` + tagline right, thin lime line. Build it with a small script (sharp/canvas) or hand-compose; reuse hero-reference proportions. All pages use it (blog posts too, v1).
- Fonts: self-host Inter var (or 400/500/600/700 subsets) + JetBrains Mono 400/600 as woff2 in `site/public/fonts/`, `font-display: swap`, preload the two main files.
- Images: emblem PNG where needed; NEVER ship `hero-reference-*.jpg/png` to production.
- Lighthouse budget: LCP element = hero h1 (text, not video). Video `preload="metadata"` + poster keeps it cheap. Target ≥90 performance/SEO/a11y.

## 9. Accessibility

- Contrast: `--text` on `--ink` ≈ 9:1 ✓; `--text-mute` only for non-essential meta. Lime on ink ≈ 10:1 ✓. Never lime text on `--surface-2` below 0.8rem.
- Focus visible: `outline: 2px solid var(--lime); outline-offset: 2px` on all interactive elements.
- Copy buttons: `aria-label="Copy to clipboard"`, announce via `aria-live="polite"`.
- Video: `aria-hidden="true"` (decorative), real `<img>` alt on poster fallback.
- Tabs: proper `role="tablist"` keyboard support or simple buttons + `aria-selected`.

## 10. v2 backlog (do NOT build now — noted for the polish iteration)

- Scroll-scrub / parallax of the logo video.
- Per-family illustrated icons; per-post OG images.
- Interactive savings calculator (tokens in → $ saved).
- `/docs` expansion (per-tool pages), search.
- Light theme toggle (only if requested).

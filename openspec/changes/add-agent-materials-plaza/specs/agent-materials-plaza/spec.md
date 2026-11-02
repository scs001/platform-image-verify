## Purpose

The Materials Plaza is the outward understanding surface of 壹座·智能体素材广场: a static five-locale site plus machine-readable surfaces that let humans of any language background and AI agents alike understand what infrastructure the platform provides, how it is provided, and which materials exist today — all rendered from one truth, the facet market listing.

## ADDED Requirements

### Requirement: The human face is a five-locale static site with a fixed narrative structure

The plaza site SHALL be a purely static site serving five locales (zh-CN, en, es, fr, ja) with locale parity enforced by the existing locale gate. The human face SHALL present, in order: a hero stating the plaza's one-line purpose with live material counts; the five material categories (功能集, 生态技能, MCP 服务, AI 分身, 官方数据锚) as one card each with a concrete example; the supply mechanism chain in four segments (publish → obtain → run → serve) each explained from the material's perspective; a material inventory gallery with official/facade badges, category filtering, and search; and a dual audience section (human paths and AI paths) plus the five-line footer ladder with sibling-site links. No locale SHALL fall back to another locale's text on any page.

#### Scenario: Five locales render complete pages

- **WHEN** a visitor opens any plaza page in each of the five locales
- **THEN** every section renders fully in the requested locale, and the locale gate reports key parity across all five

#### Scenario: The mechanism chain explains infrastructure through materials

- **WHEN** a reader follows the supply mechanism section
- **THEN** each of the four segments states what the mechanism does for the materials (e.g. publish freezes an immutable version snapshot) rather than presenting an architecture lecture

#### Scenario: Sibling sites are linked both ways

- **WHEN** a visitor follows the footer ladder to the zhiyu or yongyi sibling site
- **THEN** those sites link back to the plaza, and the plaza links to them

### Requirement: Machine surfaces are generated from the single market truth

The plaza's machine surfaces — `llms.txt`, `llms-full.txt`, `catalog.json`, per-material Markdown pages, and `infrastructure.md` — SHALL be generated at build time by the plaza export from the market listing. No hand-maintained inventory copy SHALL exist: if a material appears in the machine surfaces, it comes from the listing; if it was unpublished, the next export drops it. `catalog.json` entries SHALL reuse the production annotation shape (`canonical.brief`, `human` in five locales, `whenToUse`, `provenance.source` + `provenance.updatedAt`) with no new vocabulary. Every human page SHALL embed JSON-LD structured data and a link to its machine twin.

#### Scenario: Catalog entries carry the annotation shape

- **WHEN** an AI agent reads `catalog.json`
- **THEN** every entry has a canonical brief, human summaries in five locales, a whenToUse hint, and provenance (source and as-of date), using the same field names as the production annotation layer

#### Scenario: Unpublish removes a material from the next export

- **WHEN** a listed pack is unpublished on the market and the export runs again
- **THEN** the material disappears from `catalog.json`, `llms.txt`, and the materials pages, while previously deployed static files keep serving until the next deploy (stale copy visibly older in its provenance date)

#### Scenario: Human pages carry machine twins

- **WHEN** a crawler or AI agent parses any plaza human page
- **THEN** it finds JSON-LD describing the page and a link to the corresponding machine-readable surface

### Requirement: The listing rule is the market's single admission rule

The plaza export SHALL admit materials through the market's one listing rule (public, non-unlisted, curated — or the operator whitelist replacing curation outright). The export SHALL NOT carry a second admission rule. A reconciliation gate SHALL compare the exported catalog's material count with the market listing API's count at export time and fail the build on any mismatch.

#### Scenario: Private and unlisted packs never appear

- **WHEN** the export runs against a market containing private and unlisted packs
- **THEN** neither appears in any machine surface or human gallery, byte-identical to what the market browse face shows

#### Scenario: Count reconciliation gate

- **WHEN** the exported catalog count differs from the market listing count at export time
- **THEN** the export fails with the two counts in the error, and no artifacts are written

### Requirement: Freshness is always visible and degrade is graceful

The inventory gallery SHALL attempt a live refresh from the market listing API on page load and SHALL silently fall back to the build-time snapshot when the API is unreachable, always labeling which it is showing ("as of <date>" for the snapshot). A page with a valid snapshot SHALL never render an empty inventory because the live fetch failed. The snapshot file SHALL be written at export time and carry its generation date for both the fallback face and audit.

#### Scenario: Live refresh succeeds

- **WHEN** the gallery loads and the market API responds
- **THEN** the inventory reflects the live listing and is not labeled as snapshot

#### Scenario: Live refresh fails to snapshot

- **WHEN** the market API is unreachable from a visitor's browser
- **THEN** the gallery renders the build-time snapshot labeled with its as-of date, and no error blocks the page

### Requirement: AI-readable discipline is gated, not aspirational

The export SHALL enforce six lint rules on every generated machine surface: each section self-contained (no cross-page or cross-section references like "see above"); full entity naming on first mention (壹座·智能体素材广场 / Yizuo Agent Materials Plaza, not "our platform"); one term per concept (素材 never mixed with 资源/内容/资产 in the same meaning); mechanisms expressed as input–action–output tables; every material page independently answerable by a context-free reader to three questions (what is this, how do I obtain it, as of when); and provenance present on every material entry. A lint failure SHALL fail the export build.

#### Scenario: Cold-read three-question assertion

- **WHEN** a material page alone is given to a reader with no other context
- **THEN** the page answers what the material is, how to obtain it (with the copy-ready command or path), and the corpus-as-of date

#### Scenario: Lint failure blocks the build

- **WHEN** a generated page contains a cross-section reference or a missing provenance field
- **THEN** the export exits non-zero naming the offending page and rule, and no artifacts are written

### Requirement: Addresses are stable across content and locale changes

Material page slugs SHALL be stable identifiers that do not change when content updates or locales are added; locale switching SHALL NOT alter material addresses. The `catalog.json` category field SHALL be a versioned closed enumeration; adding a new material species SHALL extend the enumeration with a version bump rather than overloading an existing category.

#### Scenario: Content update keeps the address

- **WHEN** a material's corpus is updated and re-exported
- **THEN** its page URL is unchanged, and prior inbound references (from AI agents or other sites) still resolve

#### Scenario: New species extends the enumeration

- **WHEN** a new material species (e.g. fleet templates) joins the plaza
- **THEN** the category enumeration gains a new value with a version bump, and no existing category absorbs it

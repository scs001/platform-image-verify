// ── 市场分类体系：线（供给域）的多语言标签 (overhaul-market-catalog-presentation P0) ──
//
// P0 范围：只给「线词」加多语言标签。归位逻辑（slug→线）与 zh 主轨线词的唯一真源
// 仍是 lib/pack-category-lines.js（env 可配、既有测试钉死）——本模块不复制那张映射表，
// 只做「zh 线词 → 规范线 slug → 各语言标签」的展示层投影。
//
// 契约（specs/pack-locale-tracks ADDED「分面标签与标签词随请求 locale 呈现」）：
//   - 服务端按请求 locale 投影标签，客户端不做二次映射；
//   - zh 主轨线词不变（它同时是分面筛选的线上身份，isLineWord/slugsForLine 按它展开）；
//   - 未映射的线词（env 覆盖出的自定义线、透传 slug）按原样呈现——不猜测、不消失；
//   - 未覆盖的语言回落 zh 主轨。
//
// 非语言品牌标记沿用 LineLadder 的既有约定（facet-shell spec：品牌字不翻译，
// 非 zh 语言用概念名）：Base / Lex / Wire / Facet / Constellation + 各语言领域词。

const LINE_SLUG_BY_ZH_WORD = {
  "壹座 · 智能体团队": "base",
  "识律 · 法律智能": "lex",
  "柏讯 · 数据与情报": "wire",
  "谦面 · 业务流": "facet",
  "萬星 · 智能体连接": "constellation",
};

const LINE_LABELS = {
  base: {
    en: "Base · Agent Teams",
    es: "Base · Equipos de agentes",
    fr: "Base · Équipes d'agents",
    ja: "Base · エージェントチーム",
  },
  lex: {
    en: "Lex · Legal Intelligence",
    es: "Lex · Inteligencia jurídica",
    fr: "Lex · Intelligence juridique",
    ja: "Lex · リーガルインテリジェンス",
  },
  wire: {
    en: "Wire · Data & Intelligence",
    es: "Wire · Datos e inteligencia",
    fr: "Wire · Données et renseignement",
    ja: "Wire · データとインテリジェンス",
  },
  facet: {
    en: "Facet · Business Flows",
    es: "Facet · Flujos de negocio",
    fr: "Facet · Flux métier",
    ja: "Facet · ビジネスフロー",
  },
  constellation: {
    en: "Constellation · Agent Connectivity",
    es: "Constellation · Conectividad de agentes",
    fr: "Constellation · Connectivité d'agents",
    ja: "Constellation · エージェント接続",
  },
};

/** zh 主轨线词在 `locale` 下的展示标签。zh（或未知 locale）回落线词本身；
 *  未映射的线词（env 自定义线、透传 slug）原样返回——present-as-is 不变。
 *  locale 容错与 lib/pack-locale.js 的 localeBlockAt 同律：带后缀的标签
 *  （en-US）先找全标签，再退主子标签（en）；两者皆未覆盖回落 zh 主轨。 */
export function lineLabelOf(lineWord, locale) {
  const word = String(lineWord ?? "");
  if (!word) return "";
  const tag = String(locale ?? "").toLowerCase();
  if (!tag || tag === "zh" || tag.startsWith("zh")) return word;
  const slug = LINE_SLUG_BY_ZH_WORD[word];
  if (!slug) return word;
  const labels = LINE_LABELS[slug];
  if (!labels) return word;
  return labels[tag] || labels[tag.split("-")[0]] || word;
}

/** 规范线 slug（base/lex/wire/facet/constellation）或 null——P1 声明式分面的地基。
 *  未映射 zh 线词返回 null（调用方按未归类处理）。 */
export function lineSlugOf(lineWord) {
  return LINE_SLUG_BY_ZH_WORD[String(lineWord ?? "")] ?? null;
}

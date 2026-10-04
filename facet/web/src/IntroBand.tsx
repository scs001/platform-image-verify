// The product intro band: static and non-dismissible, rendered on both tabs
// between the header and the tab content. Copy is fully keyed — all five
// locales carry the facetHero section (parity enforced by
// scripts/check-locales.js). The band states only verifiable facts: what the
// market does, the MCP catalog, and the published CLI command (the fact the
// packs footnote used to carry; the footnote now points at `facet help`).
import { useTranslation } from "react-i18next";

const CLI_SNIPPET = "npx @finddatatechonology/facet install <pack id>";

export function IntroBand() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
  const lineUrl = lang.startsWith("zh")
    ? "https://www.finddatatech.cloud/zh/products/facet/"
    : "https://www.finddatatech.cloud/products/facet/";

  return (
    <section
      data-testid="facet-intro-band"
      className="mb-4 rounded-lg border border-border bg-muted/40 px-5 py-4"
    >
      <h1 className="text-base font-semibold">{t("facetHero.title")}</h1>
      <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <li>{t("facetHero.factPacks")}</li>
        <li>{t("facetHero.factMcp")}</li>
        <li className="flex items-center gap-1.5">
          <span>{t("facetHero.factCli")}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{CLI_SNIPPET}</code>
        </li>
      </ul>
      <a
        className="mt-2 inline-block text-xs text-muted-foreground underline hover:text-foreground"
        href={lineUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("facetHero.lineLink")}
      </a>
    </section>
  );
}
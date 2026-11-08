// StatusSection — 设置 → 运行状态 (restructure-yizuo-ia, settings-surface).
//
// `status` (system health) and `diagnostics` (the per-turn trace list) both
// answer "what is happening right now" — they were two sibling sections, which
// made the operator scan two doors for one question. Now one section, two
// tabs: 健康 (the supervisor/resources/MCP projection) and 逐回合追踪 (the
// captured turn list).
//
// `/trace` still redirects here (the diagnostics tab); `/trace/:turnId` stays a
// top-level route because chat turn deep links land on it directly.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { DashboardPage } from "@/pages/DashboardPage";
import { TracePage } from "@/pages/TracePage";

export type StatusTab = "health" | "trace";

const TABS: { id: StatusTab; labelKey: string; testId: string }[] = [
  { id: "health", labelKey: "settings.status.tabs.health", testId: "status-tab-health" },
  { id: "trace", labelKey: "settings.status.tabs.trace", testId: "status-tab-trace" },
];

export function StatusSection({ tab = "health" }: { tab?: StatusTab } = {}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<StatusTab>(tab);

  return (
    <div className="flex flex-col" data-testid="settings-status">
      <div
        role="tablist"
        aria-label={t("settings.sections.status")}
        className="flex gap-1 border-b border-border px-6 pt-4"
        data-testid="status-tabs"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={active === entry.id}
            data-testid={entry.testId}
            data-active={active === entry.id ? "true" : "false"}
            onClick={() => setActive(entry.id)}
            className={cn(
              "-mb-px border-b-2 px-3 pb-2 text-sm",
              active === entry.id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {active === "health" && (
        <div role="tabpanel" data-testid="status-panel-health">
          <DashboardPage />
        </div>
      )}
      {active === "trace" && (
        <div role="tabpanel" data-testid="status-panel-trace">
          <TracePage />
        </div>
      )}
    </div>
  );
}

// Settings → Network search (add-websearch-settings): the relay wiring that
// backs the bundled websearch tools. URL + token (write-only; the server
// returns only presence + a 4-char hint), a connectivity test that never
// persists, and clear-to-fallback semantics (empty = back to the deployment
// env). Admin-gated server-side; the section itself is admin-visible then.
//
// Effective values resolve stored → env; the badges say which layer is live.

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fetchWebsearchConfig,
  saveWebsearchConfig,
  testWebsearchRelay,
  type WebsearchConfig,
  type WebsearchTestResult,
} from "@/lib/websearch-api";

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

function SourceBadge({ source }: { source: "stored" | "env" | null }) {
  const { t } = useTranslation();
  if (!source) return null;
  const label = source === "stored" ? t("settings.websearch.sourceStored") : t("settings.websearch.sourceEnv");
  const cls =
    source === "stored"
      ? "bg-primary/15 text-primary"
      : "bg-secondary text-secondary-foreground";
  return (
    <span data-testid={`websearch-source-${source}`} className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

export function WebSearchSection() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<WebsearchConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState(""); // write-only: empty = leave unchanged
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebsearchTestResult | null>(null);

  useEffect(() => {
    fetchWebsearchConfig()
      .then((cfg) => {
        setLoaded(cfg);
        setUrl(cfg.url);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (clearing: "url" | "token" | null = null) => {
    setStatus("saving");
    setError("");
    setTestResult(null);
    try {
      const body: Record<string, string> = {};
      if (clearing === "url") body.url = "";
      else if (clearing === "token") body.token = "";
      else {
        if (url.trim() !== (loaded?.url ?? "")) body.url = url.trim();
        if (token.trim()) body.token = token.trim();
      }
      const cfg = await saveWebsearchConfig(body);
      setLoaded(cfg);
      setUrl(cfg.url);
      setToken("");
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      setStatus("error");
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testWebsearchRelay({ url: url.trim() || undefined, token: token.trim() || undefined }));
    } catch (err) {
      setTestResult({ state: "unreachable", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const testTone: Record<WebsearchTestResult["state"], string> = {
    ok: "text-emerald-600",
    "auth-rejected": "text-destructive",
    "upstream-degraded": "text-warning",
    unreachable: "text-destructive",
    "invalid-url": "text-destructive",
  };

  return (
    <div className="flex flex-col gap-4" data-testid="settings-websearch">
      <p className="text-sm text-muted-foreground">{t("settings.websearch.subtitle")}</p>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t("settings.websearch.urlLabel")}
          <SourceBadge source={loaded?.source.url ?? null} />
        </span>
        <input
          data-testid="websearch-url"
          value={url}
          placeholder={t("settings.websearch.urlPlaceholder")}
          onChange={(e) => {
            setUrl(e.target.value);
            setStatus("idle");
            setTestResult(null);
          }}
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t("settings.websearch.tokenLabel")}
          <SourceBadge source={loaded?.source.token ?? null} />
        </span>
        <input
          data-testid="websearch-token"
          type="password"
          value={token}
          placeholder={loaded?.hasToken ? t("settings.websearch.tokenStoredPlaceholder", { hint: loaded.tokenHint ?? "" }) : t("settings.websearch.tokenPlaceholder")}
          onChange={(e) => {
            setToken(e.target.value);
            setStatus("idle");
            setTestResult(null);
          }}
          className={inputCls}
        />
        <span className="text-xs text-muted-foreground">{t("settings.websearch.tokenHint")}</span>
      </label>

      {loaded?.hasToken && (
        <div>
          <button
            data-testid="websearch-token-clear"
            onClick={() => save("token")}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {t("settings.websearch.clearToken")}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          data-testid="websearch-save"
          onClick={() => save(null)}
          disabled={status === "saving"}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {status === "saving" ? t("settings.websearch.saving") : t("settings.websearch.save")}
        </button>
        <button
          data-testid="websearch-test"
          onClick={runTest}
          disabled={testing}
          className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          {testing ? t("settings.websearch.testing") : t("settings.websearch.test")}
        </button>
        {status === "saved" && (
          <span data-testid="websearch-saved" className="text-xs text-emerald-600">
            {t("settings.websearch.saved")}
          </span>
        )}
      </div>

      {error && (
        <p data-testid="websearch-error" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {testResult && (
        <p data-testid="websearch-test-result" className={`text-xs ${testTone[testResult.state]}`}>
          {t(`settings.websearch.test.${testResult.state}`)}
          {testResult.detail ? ` — ${testResult.detail}` : ""}
        </p>
      )}

      {!loaded?.hasToken && !loaded?.url && (
        <p className="text-xs text-muted-foreground">{t("settings.websearch.unconfiguredHint")}</p>
      )}
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Globe className="h-3 w-3" />
        {t("settings.websearch.scopeHint")}
      </p>
    </div>
  );
}

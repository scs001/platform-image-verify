// 我的功集 — the facet creator console (add-facet-content-management):
// the author surface for packs published from this viewer's identity —
// list, version history, unpublish, visibility, and publish-from-manifest.
// Cell-side authoring (drafts assembled from installed content) stays a
// 壹座 surface by design; cell install stays refused (INSTALL_IS_A_BASE_
// SURFACE). Strings are bilingual inline (the McpCatalog precedent — the
// shell's five-locale parity file stays untouched by view internals).
import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type VersionRow = { version: number; publishedAt: number; authorEmail: string };

export function MineView() {
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openVersions, setOpenVersions] = useState<Record<string, VersionRow[]>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await api.listPacks({ author: "me", pageSize: 100 });
      setPacks(r.packs);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleVersions = async (id: string) => {
    if (openVersions[id]) {
      const { [id]: _drop, ...rest } = openVersions;
      setOpenVersions(rest);
      return;
    }
    try {
      const r = await api.listPackVersions(id);
      setOpenVersions((v) => ({ ...v, [id]: r.versions }));
    } catch (err) {
      setNotice(`版本历史加载失败 / version history failed: ${(err as Error).message}`);
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(`${label} 完成 / done`);
      await refresh();
    } catch (err) {
      setNotice(`${label} 失败 / failed: ${(err as Error).message}`);
    }
  };

  if (error) return <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>;
  if (!packs) return <p className="text-sm text-muted-foreground">加载中… / Loading…</p>;

  return (
    <section data-testid="facet-mine-view" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">我的功集 · My packs</h2>
        <p className="text-xs text-muted-foreground mt-1">
          管理你发布的功集：版本、上下架、可见性。安装到运行时请在壹座内完成（设置 → 功集 → 我的功能集）。
          <br />
          Manage what you publish here; installing into a runtime stays a 壹座 surface.
        </p>
      </header>

      {notice && (
        <p data-testid="facet-mine-notice" className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      {packs.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有发布的功集 / Nothing published yet — use the publish box below.</p>
      )}

      <div className="grid gap-3">
        {packs.map((p) => (
          <div key={p.id} data-testid={`facet-mine-row-${p.id}`} className="border border-border rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-medium text-foreground">{p.name}</span>
              <span className="text-xs text-muted-foreground">
                v{p.version} · {p.visibility === "private" ? "私有 private" : "公开 public"}
                {p.unlisted ? " · 已下架 unlisted" : ""}
                {p.category ? ` · ${p.category}` : ""}
              </span>
            </div>
            <p className="text-xs text-muted-foreground break-all">{p.id}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void toggleVersions(p.id)} data-testid={`facet-mine-versions-${p.id}`}>
                版本历史 / Versions
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void act(p.unlisted ? "恢复上架不可用（发布新版本即恢复）" : "下架", () =>
                    p.unlisted ? Promise.resolve() : api.unpublishPack(p.id),
                  )
                }
                disabled={p.unlisted}
              >
                下架 / Unpublish
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void act("可见性", () => api.setPackVisibility(p.id, p.visibility === "private" ? "public" : "private"))}
              >
                {p.visibility === "private" ? "转为公开 / Make public" : "转为私有 / Make private"}
              </Button>
            </div>
            {openVersions[p.id] && (
              <ul className="text-xs text-muted-foreground space-y-1 border-t border-border pt-2" data-testid={`facet-mine-versions-list-${p.id}`}>
                {openVersions[p.id].map((v) => (
                  <li key={v.version}>
                    v{v.version} · {new Date(v.publishedAt).toLocaleString()} · {v.authorEmail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <PublishFromManifest onPublished={() => void refresh()} />
    </section>
  );
}

function PublishFromManifest({ onPublished }: { onPublished: () => void }) {
  const [manifest, setManifest] = useState("");
  const [packId, setPackId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        throw new Error("不是合法 JSON / not valid JSON");
      }
      const r = await api.publishPack({ packId: packId.trim() || null, manifest: parsed as never });
      setResult(`已发布 / published: ${r.id} v${r.version}`);
      setManifest("");
      setPackId("");
      onPublished();
    } catch (err) {
      const e = err as Error & { body?: { errors?: { error: string }[] } };
      const details = e.body?.errors?.map((x) => x.error).join("；") ?? "";
      setResult(`发布失败 / failed: ${e.message}${details ? ` — ${details}` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-2" data-testid="facet-mine-publish">
      <h3 className="text-sm font-semibold">从清单发布 · Publish from manifest</h3>
      <p className="text-xs text-muted-foreground">
        粘贴或编辑功集 manifest JSON（facet-pack-builder 产物）。留空功集 id = 新功集；填已有 id = 发布新版本。
      </p>
      <Input
        value={packId}
        onChange={(e) => setPackId(e.target.value)}
        placeholder="pack id（可选 / optional，新版本时填写）"
        data-testid="facet-mine-publish-id"
      />
      <textarea
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={8}
        placeholder='{ "name": "…", "skills": [...], "mcpServers": [...], "agents": [...] }'
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        data-testid="facet-mine-publish-manifest"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !manifest.trim()} onClick={() => void submit()} data-testid="facet-mine-publish-submit">
          {busy ? "发布中… / Publishing…" : "发布 / Publish"}
        </Button>
        {result && (
          <span className="text-xs text-muted-foreground break-all" data-testid="facet-mine-publish-result">
            {result}
          </span>
        )}
      </div>
    </div>
  );
}

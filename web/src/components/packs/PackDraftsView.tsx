// PackDraftsView — the creator side (add-pack-marketplace): draft list plus
// the pack editor. Skill entries edit inline (custom-skill conventions); MCP
// entries are PICKED from the cell's registry-sourced market catalog (no
// free-form URL/command field anywhere — the v1 content boundary); agent
// entries are persona-only. Publish pushes the manifest to the gateway and
// stays editable for the next version; the first publish also records the
// pack id on the draft so later publishes append versions.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDraft, PackManifest } from "@/lib/packs-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "./Badge";

const emptyEntries = { skills: [], mcpServers: [], agents: [] };

// Client-side stable keys for editable list entries (skills/agents may share
// a name or be blank while editing; the key never leaves the editor).
let uid = 0;
const nextKey = () => `e${++uid}`;
const withKeys = <T,>(items: T[]) => items.map((v) => ({ key: nextKey(), value: v }));

export function PackDraftsView({ onPublished }: { onPublished?: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<PackDraft[]>([]);
  const [editing, setEditing] = useState<PackDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDrafts((await api.listPackDrafts()).drafts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createDraft = async () => {
    try {
      const { draft } = await api.createPackDraft({ name: t("packs.drafts.defaultName"), entries: emptyEntries });
      await refresh();
      setEditing(draft);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing) {
    return (
      <PackDraftEditor
        draft={editing}
        onClose={() => {
          setEditing(null);
          void refresh();
        }}
        onPublished={(d) => {
          setEditing(d);
          onPublished?.();
        }}
      />
    );
  }

  return (
    <section data-testid="pack-drafts-section">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.drafts.title")}</h2>
        <Button size="sm" onClick={() => void createDraft()} data-testid="pack-draft-create">
          {t("packs.drafts.create")}
        </Button>
      </div>
      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4">{error}</div>}
      {loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {!loading && drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("packs.drafts.empty")}</p>
      )}
      <div className="grid gap-3">
        {drafts.map((d) => (
          <button
            key={d.id}
            onClick={() => setEditing(d)}
            data-testid={`pack-draft-item-${d.id}`}
            className="text-left border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{d.name}</span>
              {d.publishedPackId ? (
                <Badge>{t("packs.drafts.published")}</Badge>
              ) : (
                <Badge>{t("packs.drafts.draft")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("packs.drafts.partCounts", {
                skills: d.entries.skills?.length ?? 0,
                mcp: d.entries.mcpServers?.length ?? 0,
                agents: d.entries.agents?.length ?? 0,
              })}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

function PackDraftEditor({
  draft,
  onClose,
  onPublished,
}: {
  draft: PackDraft;
  onClose: () => void;
  onPublished: (updated: PackDraft) => void;
}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [skills, setSkills] = useState(() => withKeys(draft.entries.skills ?? []));
  const [mcpPicked, setMcpPicked] = useState<string[]>((draft.entries.mcpServers ?? []).map((m) => m.registryName));
  const [agents, setAgents] = useState(() => withKeys(draft.entries.agents ?? []));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  // The picker lists registry-sourced market entries only (spec:
  // pack-authoring — no free-form endpoint or command entry exists).
  const registryMcp = (marketCatalog?.mcpServers ?? []).filter((s) => s.origin === "registry");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { draft: updated } = await api.updatePackDraft(draft.id, {
        name,
        description,
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        entries: {
          skills: skills.map((e) => e.value),
          mcpServers: mcpPicked.map((registryName) => ({ registryName })),
          agents: agents.map((e) => e.value),
        },
      });
      Object.assign(draft, updated);
      return updated;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setPublishing(true);
    setError(null);
    setPublishResult(null);
    try {
      const updated = await save();
      if (!updated) return;
      const manifest: PackManifest = {
        name: updated.name,
        description: updated.description,
        tags: updated.tags,
        skills: updated.entries.skills ?? [],
        mcpServers: updated.entries.mcpServers ?? [],
        agents: updated.entries.agents ?? [],
      };
      const r = await api.publishPack({ packId: draft.publishedPackId, manifest });
      if (!draft.publishedPackId) {
        const { draft: marked } = await api.markDraftPublished(draft.id, r.id);
        Object.assign(draft, marked);
      }
      setPublishResult(t("packs.editor.publishOk", { version: r.version }));
      onPublished({ ...draft, ...updated, publishedPackId: draft.publishedPackId ?? r.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section data-testid="pack-editor" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.editor.title")}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
            {t("packs.editor.save")}
          </Button>
          <Button size="sm" onClick={() => void publish()} disabled={publishing} data-testid="pack-draft-publish">
            {t("packs.editor.publish")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>

      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>}
      {publishResult && (
        <div className="bg-primary/10 text-primary px-4 py-3 rounded-md" data-testid="pack-publish-ok">
          {publishResult}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="pack-name">{t("packs.editor.name")}</Label>
          <Input id="pack-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pack-tags">{t("packs.editor.tags")}</Label>
          <Input
            id="pack-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("packs.editor.tagsPlaceholder")}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="pack-desc">{t("packs.editor.description")}</Label>
        <Textarea id="pack-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </div>

      {/* Skills */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.skills")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSkills([...skills, { key: nextKey(), value: { name: "", description: "", content: "" } }])}
            data-testid="pack-skill-add"
          >
            {t("packs.editor.addSkill")}
          </Button>
        </div>
        <div className="space-y-3">
          {skills.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-skill-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.name}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillName")}
                />
                <Input
                  value={entry.value.description}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, description: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillDescription")}
                />
              </div>
              <Textarea
                value={entry.value.content}
                onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, content: e.target.value } } : x)))}
                rows={6}
                placeholder={t("packs.editor.skillContent")}
                className="font-mono text-xs"
              />
              <Button size="sm" variant="ghost" onClick={() => setSkills(skills.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* MCP picker */}
      <section>
        <h3 className="font-medium text-foreground mb-2">{t("packs.editor.mcp")}</h3>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.mcpHint")}</p>
        {registryMcp.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("packs.editor.mcpEmpty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="pack-mcp-picker">
            {registryMcp.map((s) => {
              const on = mcpPicked.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => setMcpPicked(on ? mcpPicked.filter((n) => n !== s.name) : [...mcpPicked, s.name])}
                  className={`border rounded-full px-3 py-1 text-xs transition-colors ${
                    on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
                  }`}
                  data-testid={`pack-mcp-option-${s.name}`}
                >
                  {s.displayName || s.name}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Agents (persona-only) */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.agents")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAgents([...agents, { key: nextKey(), value: { id: "", name: "", persona: "" } }])}
            data-testid="pack-agent-add"
          >
            {t("packs.editor.addAgent")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.agentHint")}</p>
        <div className="space-y-3">
          {agents.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-agent-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.id}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, id: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentId")}
                />
                <Input
                  value={entry.value.name}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentName")}
                />
              </div>
              <Textarea
                value={entry.value.persona}
                onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, persona: e.target.value } } : x)))}
                rows={3}
                placeholder={t("packs.editor.agentPersona")}
              />
              <Button size="sm" variant="ghost" onClick={() => setAgents(agents.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

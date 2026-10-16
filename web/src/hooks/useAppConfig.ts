// Deployment config the web renders from: what the server/agent can do, and
// what this deployment is called. Fetched once at boot (see main.tsx) so the
// first paint already shows the configured name instead of flashing the
// localized default, and cached for every later read.
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { parseLoginHero, type LoginHeroConfig } from "@/lib/login-hero";

export interface AppConfig {
  documentsEnabled: boolean;
  // Deployment name for the assistant (branding store → ASSISTANT_NAME); null
  // = use the localized defaults.
  assistantName: string | null;
  // Deployment branding (branding store → env → null). companyName feeds the
  // login copy; brandIconUrl the login card + favicon; loginFooterText the
  // login footer; loginHero the login page hero slots (add-login-hero). Null
  // = current unbranded behavior.
  companyName: string | null;
  brandIconUrl: string | null;
  loginFooterText: string | null;
  loginHero: LoginHeroConfig | null;
  // Pack marketplace surfaces exist only on gateway-fronted deployments
  // (add-pack-marketplace, design D15): false = no pack UI anywhere.
  packMarketplace: boolean;
  // The viewer's business roles (role-system): the resolved assignment the
  // layout chain and onboarding consume. Null = no identity on the request
  // (anonymous read) or an older server without the field.
  roles: { primary: string; secondary: string[] } | null;
  // The server-resolved layout (layout-configuration): per-container ordered
  // visible slugs. Null = an older server — the web then renders the factory
  // snapshot's full set, matching the pre-change behavior.
  resolvedLayout: { nav: string[]; settings: string[]; agentsTabs: string[] } | null;
}

let config: AppConfig = { documentsEnabled: true, assistantName: null, companyName: null, brandIconUrl: null, loginFooterText: null, loginHero: null, packMarketplace: false, roles: null, resolvedLayout: null };
const listeners = new Set<() => void>();

function emit(next: AppConfig) {
  config = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppConfig(): AppConfig {
  return useSyncExternalStore(subscribe, () => config, () => config);
}

// Boot fetch. Never rejects and never blocks for long: an unreachable server (or
// a slow one) leaves the defaults in place, because a missing name must not cost
// the app its first paint.
export async function loadAppConfig(timeoutMs = 1500): Promise<AppConfig> {
  try {
    const res = await fetch("/api/config", { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const roles = body?.roles;
    const slugList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null);
    const layout = body?.resolvedLayout;
    emit({
      documentsEnabled: body?.documentsEnabled ?? true,
      assistantName: str(body?.assistantName),
      companyName: str(body?.companyName),
      brandIconUrl: str(body?.brandIconUrl),
      loginFooterText: str(body?.loginFooterText),
      loginHero: parseLoginHero(body?.loginHero),
      packMarketplace: body?.packMarketplace === true,
      roles:
        roles && typeof roles.primary === "string"
          ? { primary: roles.primary, secondary: Array.isArray(roles.secondary) ? roles.secondary.filter((s: unknown) => typeof s === "string") : [] }
          : null,
      resolvedLayout:
        layout && typeof layout === "object"
          ? {
              nav: slugList(layout.nav) ?? [],
              settings: slugList(layout.settings) ?? [],
              agentsTabs: slugList(layout.agentsTabs) ?? [],
            }
          : null,
    });
  } catch {
    /* keep defaults */
  }
  return config;
}

// The two strings every name-bearing surface interpolates: `brand` names the
// deployment (sidebar, login card, document title), `assistant` names the agent
// that answers (turn header, composer placeholder). One configured name fills
// both, and each locale keeps its own shape around it — a configured "FD" reads
// "FD" in the sidebar and "FD 助手" / "FD Assistant" above a turn, exactly as
// the default "Platform" / "Platform 助手" pair does.
export function useBranding(): { brand: string; assistant: string } {
  const { assistantName } = useAppConfig();
  const { t } = useTranslation();
  const brand = assistantName || t("assistant.brand");
  return { brand, assistant: t("assistant.name", { brand }) };
}

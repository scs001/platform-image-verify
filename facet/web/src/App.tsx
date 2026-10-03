// Facet's thin shell: a header (identity + login/logout) over the 壹座 packs
// market surface, reused verbatim. v1 scope on the facet domain: browse,
// inspect, subscribe (recorded at the market), publish via the same /api/packs
// API. Cell-side install stays a 壹座 surface — the service answers
// /api/mypacks/* with a guided 501 and the dialog shows it.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { Button } from "@/components/ui/button";

function Whoami({ onUser }: { onUser: (u: { email: string; groups: string[] } | null) => void }) {
  useEffect(() => {
    fetch("/api/whoami")
      .then((r) => r.json())
      .then((d) => onUser(d?.email ? d : null))
      .catch(() => onUser(null));
  }, [onUser]);
  return null;
}

export function App() {
  const { t } = useTranslation();
  const [user, setUser] = useState<{ email: string; groups: string[] } | null>(null);

  return (
    <div className="flex flex-col h-full min-h-screen bg-background text-foreground">
      <Whoami onUser={setUser} />
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold">谦面 Facet</span>
          <span className="text-sm text-muted-foreground">{t("packs.title", "功能集")}</span>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="text-sm text-muted-foreground">{user.email}</span>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = "/api/auth/logout")}>
                {t("auth.logout", "退出登录")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => (window.location.href = "/auth/login")}>
              {t("auth.login", "登录")}
            </Button>
          )}
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <PackMarketView onSubscribed={() => {}} />
      </main>
    </div>
  );
}

// Onboarding recipes (openspec: intent-onboarding; ADR-0027). The curated
// mapping from a business role to what a new user gets provisioned: which
// packs to install, which expert to select, which prompt source the welcome
// cards should follow, and which layout preset key the role rides.
//
// Recipes are platform-curated static data, invisible to users. They are NOT
// packs (ADR-0027): a pack is a versioned resource bundle subscribers install;
// a recipe is a first-run assembly strategy for a role — and roles are finer
// than packs (economic/financial/stock share two data packs and differ only in
// the default expert and prompts).
//
// `ready` gates the questionnaire: only roles with a complete recipe are
// offered, so a user can never pick a role that provisions nothing. Roles
// without a recipe stay assignable by admins (per role-system).

// The default expert a recipe selects: a catalog agent id (dotted, as the
// picker and the persisted preference speak it) or the built-in "local".
export interface RoleRecipe {
  /** Pack ids to install, in order. Empty = layout + expert only. */
  packs: string[];
  /** The expert to select after provisioning. */
  defaultExpert: string;
  /** Which prompt set the welcome cards follow (a pack id with client content). */
  prompts: string | null;
  /** The layout preset key this role rides (layout-configuration's space). */
  layoutPreset: string;
}

export interface RecipeCatalog {
  version: 1;
  ready: string[];
  recipes: Record<string, RoleRecipe>;
}

// v1 recipes. The pack ids are vertical-pack ids from the registry (see
// docs/vertical-packs.md); the expert ids are the pack personas the market
// publishes. A reference that resolves to nothing at provision time degrades
// to "item unavailable" rather than failing the run (design D3).
export const RECIPE_CATALOG: RecipeCatalog = {
  version: 1,
  ready: ["legal", "stock", "economic"],
  recipes: {
    legal: {
      packs: ["legal-contract"],
      defaultExpert: "legal.contract-officer",
      prompts: "legal-contract",
      layoutPreset: "simple",
    },
    stock: {
      packs: ["stock-research"],
      defaultExpert: "analysts.industry",
      prompts: "stock-research",
      layoutPreset: "simple",
    },
    economic: {
      packs: ["china-macro"],
      defaultExpert: "analysts.industry",
      prompts: "china-macro",
      layoutPreset: "simple",
    },
  },
};

export function recipeFor(role: string | null | undefined): RoleRecipe | null {
  if (!role) return null;
  return RECIPE_CATALOG.recipes[role] ?? null;
}

export function isRoleReady(role: string | null | undefined): boolean {
  return typeof role === "string" && RECIPE_CATALOG.ready.includes(role);
}

export function readyRoles(): string[] {
  return [...RECIPE_CATALOG.ready];
}

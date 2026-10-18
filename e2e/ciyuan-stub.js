// ── Fake 词元 gateway (ciyuan-account-lane e2e) ─────────────────────────────
//
// Serves exactly the three endpoints the binding flow uses, with scenarios
// settable at runtime via POST /__mode {login, keys, models} so one process
// plays the whole script (bind → wrong password → probe 401 → healed):
//
//   POST /api/v1/auth/login  {email, password} → {data:{access_token}}
//   POST /api/v1/keys        {name, group_id}  → {data:{id, key}}
//   GET  /v1/models          (Bearer)          → 200 | 401
//
// The minted key is constant so specs can assert it never shows up in the UI.
import { createServer } from "node:http";

const PORT = Number(process.env.CIYUAN_STUB_PORT || process.env.E2E_CIYUAN_PORT || 3197);
export const E2E_CIYUAN_MINTED_KEY = "sk-e2e-ciyuan-minted-key";

const state = { login: "ok", keys: "ok", models: 200 };

export function createCiyuanStub() {
  return createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      const json = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && req.url === "/__mode") {
        Object.assign(state, body ?? {});
        return json(200, { ok: true, state });
      }
      if (req.url === "/api/v1/auth/login") {
        if (state.login === "401") return json(401, { message: "invalid credentials" });
        if (state.login === "500") return json(500, { message: "boom" });
        return json(200, { code: 0, data: { access_token: "jwt-e2e-login-token", user: { email: body?.email } } });
      }
      if (req.url === "/api/v1/keys") {
        if (!String(req.headers.authorization ?? "").includes("jwt-e2e-login-token")) {
          return json(401, { message: "not logged in" });
        }
        if (state.keys === "500") return json(500, { message: "group not allowed" });
        return json(200, { code: 0, data: { id: 4242, key: E2E_CIYUAN_MINTED_KEY, name: body?.name, group_id: body?.group_id } });
      }
      if (req.url === "/v1/models") {
        if (String(req.headers.authorization ?? "") !== `Bearer ${E2E_CIYUAN_MINTED_KEY}` || state.models !== 200) {
          return json(state.models === 200 ? 401 : state.models, { error: "unauthorized" });
        }
        return json(200, { data: [] });
      }
      json(404, { error: "nope" });
    });
  });
}

// CLI mode for the e2e harness.
if (process.argv[1]?.endsWith("ciyuan-stub.js")) {
  createCiyuanStub().listen(PORT, "127.0.0.1", () => {
    console.log(`[ciyuan-stub] listening on 127.0.0.1:${PORT}`);
  });
}

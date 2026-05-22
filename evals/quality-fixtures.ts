import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AnalysisQualityProfile } from "./analysis-quality.ts";

export type SyntheticQualityFixtureProfile = Exclude<AnalysisQualityProfile, "agent-tooling">;

export interface SyntheticQualityFixture {
  profile: SyntheticQualityFixtureProfile;
  cwd: string;
  prompt: string;
}

const DEFAULT_PROMPT = "revisa este proyecto dime que hace, en profundidad";

export function createSyntheticQualityFixture(profile: SyntheticQualityFixtureProfile): SyntheticQualityFixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-chalin-quality-${profile}-`));

  switch (profile) {
    case "go-service":
      writeGoServiceFixture(cwd);
      break;
    case "frontend-app":
      writeFrontendAppFixture(cwd);
      break;
    case "monorepo":
      writeMonorepoFixture(cwd);
      break;
    default: {
      const neverProfile: never = profile;
      throw new Error(`Unsupported synthetic quality fixture profile: ${neverProfile}`);
    }
  }

  return { profile, cwd, prompt: DEFAULT_PROMPT };
}

function writeGoServiceFixture(cwd: string): void {
  write(cwd, "README.md", `# Ledger API\n\nLedger API is a small Go HTTP service for order lookup and refresh-token auth.\n\n## Runtime\n- Entry point: cmd/api/main.go\n- Routes: GET /health, POST /v1/auth/refresh, GET /v1/orders\n- Configuration: PORT, DATABASE_URL, JWT_SECRET\n- Persistence: PostgreSQL via internal/postgres and migrations/001_init.sql\n\n## Architecture\nThe service keeps business rules in internal/domain, transport concerns in internal/http, and storage adapters in internal/postgres.\n\n## Validation\nRun go test ./... before release. The most important risk is refresh-token validation and replay protection around auth/session handling.\n`);

  write(cwd, "go.mod", `module example.com/ledger-api\n\ngo 1.22\n\nrequire github.com/jackc/pgx/v5 v5.7.1\n`);

  write(cwd, "cmd/api/main.go", `package main\n\nimport (\n\t"log"\n\t"net/http"\n\t"os"\n\n\thttpapi "example.com/ledger-api/internal/http"\n)\n\nfunc main() {\n\tport := getenv("PORT", "8080")\n\t_ = os.Getenv("DATABASE_URL")\n\t_ = os.Getenv("JWT_SECRET")\n\tmux := httpapi.NewRouter()\n\tlog.Fatal(http.ListenAndServe(":"+port, mux))\n}\n\nfunc getenv(key string, fallback string) string {\n\tif value := os.Getenv(key); value != "" {\n\t\treturn value\n\t}\n\treturn fallback\n}\n`);

  write(cwd, "internal/domain/order.go", `package domain\n\ntype Order struct {\n\tID string\n\tStatus string\n}\n\ntype OrderRepository interface {\n\tList() ([]Order, error)\n}\n\ntype TokenRotator interface {\n\tRefresh(rawToken string) (string, error)\n}\n`);

  write(cwd, "internal/http/routes.go", `package http\n\nimport "net/http"\n\nfunc NewRouter() *http.ServeMux {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /health", health)\n\tmux.HandleFunc("POST /v1/auth/refresh", refreshToken)\n\tmux.HandleFunc("GET /v1/orders", listOrders)\n\treturn mux\n}\n\nfunc health(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(http.StatusNoContent)\n}\n\nfunc refreshToken(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(http.StatusOK)\n\t_, _ = w.Write([]byte(` + "`" + `{"accessToken":"rotated"}` + "`" + `))\n}\n\nfunc listOrders(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(http.StatusOK)\n\t_, _ = w.Write([]byte(` + "`" + `[]` + "`" + `))\n}\n`);

  write(cwd, "internal/http/routes_test.go", `package http\n\nimport (\n\t"net/http"\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestRefreshTokenRoute(t *testing.T) {\n\tmux := NewRouter()\n\treq := httptest.NewRequest(http.MethodPost, "/v1/auth/refresh", nil)\n\trr := httptest.NewRecorder()\n\tmux.ServeHTTP(rr, req)\n\tif rr.Code != http.StatusOK {\n\t\tt.Fatalf("refresh-token route status = %d", rr.Code)\n\t}\n}\n`);

  write(cwd, "internal/postgres/store.go", `package postgres\n\nimport "context"\n\ntype Store struct {\n\tdsn string\n}\n\nfunc NewStore(databaseURL string) *Store {\n\treturn &Store{dsn: databaseURL}\n}\n\nfunc (s *Store) Ping(ctx context.Context) error {\n\treturn nil\n}\n`);

  write(cwd, "migrations/001_init.sql", `CREATE TABLE orders (\n  id uuid PRIMARY KEY,\n  status text NOT NULL\n);\n\nCREATE TABLE refresh_tokens (\n  token_hash text PRIMARY KEY,\n  user_id uuid NOT NULL,\n  expires_at timestamptz NOT NULL,\n  revoked_at timestamptz\n);\n`);
}

function writeFrontendAppFixture(cwd: string): void {
  write(cwd, "README.md", `# Console Web\n\nConsole Web is a Vite React TypeScript application for authenticated operations dashboards.\n\n## Runtime\n- Entry points: src/main.tsx and src/App.tsx\n- Routes: /login, /dashboard, /settings\n- API client: src/lib/api.ts\n- Session state: src/features/auth/useSession.ts\n\n## Validation\nUse bun run dev locally, bun run build for production bundles, and bun run test for Vitest + React Testing Library coverage.\nThe main risk is auth/session handling around dashboard access and settings updates.\n`);

  write(cwd, "package.json", JSON.stringify({
    name: "console-web",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      test: "vitest run",
    },
    dependencies: {
      "@vitejs/plugin-react": "latest",
      vite: "latest",
      react: "latest",
      "react-dom": "latest",
      "react-router-dom": "latest",
    },
    devDependencies: {
      vitest: "latest",
      "@testing-library/react": "latest",
      "@testing-library/jest-dom": "latest",
      typescript: "latest",
    },
  }, null, 2));

  write(cwd, "src/main.tsx", `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { BrowserRouter } from "react-router-dom";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(\n  <React.StrictMode>\n    <BrowserRouter>\n      <App />\n    </BrowserRouter>\n  </React.StrictMode>,\n);\n`);

  write(cwd, "src/App.tsx", `import { Link, Route, Routes } from "react-router-dom";\nimport { useSession } from "./features/auth/useSession";\n\nexport function App() {\n  const session = useSession();\n\n  return (\n    <main>\n      <nav>\n        <Link to="/login">Login</Link>\n        <Link to="/dashboard">Dashboard</Link>\n        <Link to="/settings">Settings</Link>\n      </nav>\n      <Routes>\n        <Route path="/login" element={<h1>Login</h1>} />\n        <Route path="/dashboard" element={<h1>Dashboard {session.user?.name}</h1>} />\n        <Route path="/settings" element={<h1>Settings</h1>} />\n      </Routes>\n    </main>\n  );\n}\n`);

  write(cwd, "src/lib/api.ts", `export async function apiGet<T>(path: string): Promise<T> {\n  const response = await fetch("/api" + path, { credentials: "include" });\n  if (!response.ok) throw new Error("API request failed: " + response.status);\n  return response.json() as Promise<T>;\n}\n`);

  write(cwd, "src/features/auth/useSession.ts", `import { useMemo } from "react";\n\nexport function useSession() {\n  return useMemo(() => ({\n    user: { id: "u_123", name: "Ada" },\n    authenticated: true,\n  }), []);\n}\n`);

  write(cwd, "src/App.test.tsx", `import { render, screen } from "@testing-library/react";\nimport { MemoryRouter } from "react-router-dom";\nimport { describe, expect, it } from "vitest";\nimport { App } from "./App";\n\ndescribe("App", () => {\n  it("renders dashboard navigation", () => {\n    render(<MemoryRouter><App /></MemoryRouter>);\n    expect(screen.getByText("Dashboard")).toBeInTheDocument();\n  });\n});\n`);
}

function writeMonorepoFixture(cwd: string): void {
  write(cwd, "README.md", `# Retail Platform\n\nRetail Platform is a pnpm workspace monorepo.\n\n## Workspaces\n- apps/web: Next.js/React storefront\n- services/api: Node Fastify API service\n- packages/ui: shared design-system component library\n- packages/contracts: shared API boundary types used by both web and API\n\n## Commands\nRun pnpm test for workspace tests and pnpm build for production builds. Use pnpm --filter when working on affected packages.\n\n## Risk\nThe main integration risk is contract drift across the API boundary: shared types in packages/contracts must stay aligned with services/api responses and apps/web consumers.\n`);

  write(cwd, "pnpm-workspace.yaml", `packages:\n  - "apps/*"\n  - "services/*"\n  - "packages/*"\n`);

  write(cwd, "package.json", JSON.stringify({
    name: "retail-platform",
    private: true,
    packageManager: "pnpm@10.0.0",
    scripts: {
      build: "pnpm -r build",
      test: "pnpm -r test",
    },
  }, null, 2));

  write(cwd, "apps/web/package.json", JSON.stringify({
    name: "@retail/web",
    type: "module",
    scripts: { build: "next build", test: "vitest run" },
    dependencies: { next: "latest", react: "latest", "@retail/ui": "workspace:*", "@retail/contracts": "workspace:*" },
  }, null, 2));

  write(cwd, "apps/web/src/app/page.tsx", `import { Button } from "@retail/ui";\nimport type { Product } from "@retail/contracts";\n\nconst featured: Product = { id: "p_1", name: "Notebook" };\n\nexport default function Page() {\n  return <Button>{featured.name}</Button>;\n}\n`);

  write(cwd, "services/api/package.json", JSON.stringify({
    name: "@retail/api",
    type: "module",
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
    dependencies: { fastify: "latest", "@retail/contracts": "workspace:*" },
  }, null, 2));

  write(cwd, "services/api/src/server.ts", `import Fastify from "fastify";\nimport type { Product } from "@retail/contracts";\n\nconst app = Fastify();\n\napp.get("/health", async () => ({ ok: true }));\napp.get<{ Reply: Product[] }>("/products", async () => [{ id: "p_1", name: "Notebook" }]);\n\nexport { app };\n`);

  write(cwd, "packages/ui/package.json", JSON.stringify({
    name: "@retail/ui",
    type: "module",
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
    peerDependencies: { react: "latest" },
  }, null, 2));

  write(cwd, "packages/ui/src/Button.tsx", `import type { PropsWithChildren } from "react";\n\nexport function Button({ children }: PropsWithChildren) {\n  return <button className="rounded bg-black px-3 py-2 text-white">{children}</button>;\n}\n`);

  write(cwd, "packages/contracts/package.json", JSON.stringify({
    name: "@retail/contracts",
    type: "module",
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
  }, null, 2));

  write(cwd, "packages/contracts/src/index.ts", `export interface Product {\n  id: string;\n  name: string;\n}\n`);
}

function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.trimStart());
}

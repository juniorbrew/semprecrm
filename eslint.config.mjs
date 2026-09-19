import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // services/wa-gateway is its own package (own tsconfig, deps and
    // lint); linting it with the Next.js config produces false errors.
    "services/**",
    // PM2 process files are CommonJS by design (PM2 loads them with require()).
    "deploy/**/*.cjs",
    // Claude Code worktrees under .claude/worktrees/** are full nested
    // checkouts (their own src/, node_modules/, .next/ build cache). A
    // narrow ".next/**" above only matches the repo root, not a nested
    // copy at this depth, so a leftover worktree's build cache was
    // getting linted as if it were source — thousands of false errors
    // from generated/transpiled output. Exclude the whole directory.
    ".claude/**",
  ]),
]);

export default eslintConfig;

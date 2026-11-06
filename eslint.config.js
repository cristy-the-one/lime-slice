// Short, type-aware rule set. All three are errors: `npm run lint` and CI fail on any hit.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "crates/**", "target/**", "test-results/**", "playwright-report/**", "artifacts/**", "e2e/scratch/**", "**/*.d.ts", "**/*.mjs", "**/*.js"] },
  {
    files: ["src/**/*.ts", "mcp/**/*.ts", "e2e/**/*.ts", "tools/**/*.ts", "*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.lint.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

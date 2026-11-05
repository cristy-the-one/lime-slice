// Short, type-aware rule set, all warnings: the existing code is not held to it yet, new code can see it.
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
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

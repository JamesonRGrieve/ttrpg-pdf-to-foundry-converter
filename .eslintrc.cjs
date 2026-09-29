// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ESLint is the lighter syntactic layer here; Biome (`biome.json`) owns the
 * correctness ruleset (it passes clean). Type-aware ESLint rules are deferred
 * hardening — see docs/determinism.md / the workspace TS standard for the
 * eventual ratchet target.
 */
module.exports = {
    root: true,
    env: { node: true, es2023: true },
    parser: "@typescript-eslint/parser",
    parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    plugins: ["@typescript-eslint", "import"],
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
    rules: {
        "@typescript-eslint/no-explicit-any": "warn",
        "@typescript-eslint/no-non-null-assertion": "warn",
        "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "no-restricted-syntax": [
            "error",
            {
                selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
                message: "Avoid `as any`. Fix the type at its source.",
            },
        ],
        "no-console": ["warn", { allow: ["warn", "error"] }],
        // Text canonicalization intentionally matches exotic whitespace/dash code
        // points in regex and string literals.
        "no-irregular-whitespace": ["error", { skipRegExps: true, skipStrings: true }],
        eqeqeq: ["error", "always"],
        curly: ["error", "all"],
        "prefer-const": "error",
        "no-var": "error",
        "import/order": [
            "warn",
            {
                groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
                "newlines-between": "never",
                alphabetize: { order: "asc" },
            },
        ],
    },
    overrides: [
        {
            files: ["tests/**/*.ts", "scripts/**/*.{ts,mjs}", "fixtures/**/*.mjs", "*.config.ts", "*.cjs"],
            rules: {
                "@typescript-eslint/no-explicit-any": "off",
                "no-console": "off",
            },
        },
        {
            // CommonJS entry points (e.g. the OCR worker plugged into tesseract.js's
            // CommonJS worker runtime) must use require().
            files: ["*.cjs", "src/**/*.cjs"],
            rules: {
                "@typescript-eslint/no-require-imports": "off",
            },
        },
    ],
    ignorePatterns: [
        "dist",
        "dist-web",
        "web/public/vendor",
        "test-results",
        "playwright-report",
        ".cache",
        "node_modules",
        "fixtures/rendered",
        "golden",
        "coverage",
        "*.py",
    ],
};

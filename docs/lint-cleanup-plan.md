# Lint Cleanup Plan

Generated from `npm run lint:all:visible` during the Phase 61 hardening pass.

## Summary

- Current full-tree lint errors: `272`
- Blocking lint remains scoped to `src/execution`, `src/engine`, `src/strategy`, and `tests/engine`.
- Full-tree lint should not be promoted to blocking until the categories below are remediated and the monolith decomposition work is complete.

## Errors By Rule

| Rule | Count |
| --- | ---: |
| `@typescript-eslint/no-unnecessary-type-conversion` | 57 |
| `@typescript-eslint/array-type` | 38 |
| `@typescript-eslint/no-unnecessary-type-assertion` | 25 |
| `@typescript-eslint/no-unused-vars` | 20 |
| `@typescript-eslint/prefer-nullish-coalescing` | 17 |
| `@typescript-eslint/no-confusing-void-expression` | 14 |
| `@typescript-eslint/prefer-readonly` | 14 |
| `@typescript-eslint/require-await` | 13 |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | 13 |
| `@typescript-eslint/no-unnecessary-boolean-literal-compare` | 11 |
| `@typescript-eslint/no-unnecessary-type-parameters` | 9 |
| `@typescript-eslint/no-unsafe-argument` | 7 |
| `@typescript-eslint/no-non-null-assertion` | 6 |
| `@typescript-eslint/prefer-optional-chain` | 5 |
| `@typescript-eslint/no-unnecessary-type-arguments` | 4 |
| `@typescript-eslint/no-unsafe-assignment` | 3 |
| `@typescript-eslint/return-await` | 2 |
| `@typescript-eslint/prefer-regexp-exec` | 2 |
| `@typescript-eslint/no-redundant-type-constituents` | 2 |
| `no-useless-assignment` | 2 |
| `@typescript-eslint/consistent-type-definitions` | 2 |
| `@typescript-eslint/prefer-find` | 1 |
| `@typescript-eslint/no-misused-spread` | 1 |
| `@typescript-eslint/consistent-type-imports` | 1 |
| `@typescript-eslint/non-nullable-type-assertion-style` | 1 |
| `no-extra-boolean-cast` | 1 |
| `@typescript-eslint/no-extraneous-class` | 1 |

## Highest-Impact Files

| File | Count |
| --- | ---: |
| `src/TradingEngine.ts` | 89 |
| `src/IngestWorker.ts` | 44 |
| `src/index.ts` | 44 |
| `src/ConfigManager.ts` | 15 |
| `src/ExecutionerWorker.ts` | 13 |
| `src/agents/ProfilerAgent.ts` | 13 |
| `src/agents/OracleAgent.ts` | 8 |
| `src/MoltworkerSupervisorWorker.ts` | 7 |

## Fix Order

1. Fix concurrency and safety rules first:
   - `@typescript-eslint/use-unknown-in-catch-callback-variable`
   - `@typescript-eslint/require-await`
   - `@typescript-eslint/no-confusing-void-expression`
   - `@typescript-eslint/no-unsafe-argument`
   - `@typescript-eslint/no-unsafe-assignment`
2. Fix stale/dead-code rules:
   - `@typescript-eslint/no-unused-vars`
   - `no-useless-assignment`
   - `@typescript-eslint/no-extraneous-class`
3. Fix type-shape rules:
   - `@typescript-eslint/no-unnecessary-type-assertion`
   - `@typescript-eslint/no-unnecessary-type-parameters`
   - `@typescript-eslint/no-redundant-type-constituents`
4. Fix mechanical style rules:
   - `@typescript-eslint/no-unnecessary-type-conversion`
   - `@typescript-eslint/array-type`
   - `@typescript-eslint/prefer-nullish-coalescing`
   - `@typescript-eslint/prefer-optional-chain`

Each category should be committed separately with `npm run typecheck`, `npm run lint`, and `npm run test:engine` passing.

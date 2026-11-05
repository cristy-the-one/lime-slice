# e2e

Playwright specs, run in headless Chromium (`npm run test:smoke`, `npm run test:engine`).

`e2e/scratch/` is for throwaway probe specs: it is git-ignored and excluded from Playwright's default run (`testIgnore`
in `playwright.config.ts`, so a config of your own that sets `testIgnore` differently is needed to run one there). Move a
probe out of `scratch/` once it deserves to be a real spec. Local `e2e/zz-*` probes are git-ignored too.

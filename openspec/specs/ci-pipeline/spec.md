# ci-pipeline Specification

## Purpose
The offline continuous-integration gate: a GitHub Actions workflow that, on every pull request and push to `main`, runs lint (Biome), `web/` typecheck, unit tests, locale parity, the production web build and the offline `fast` Playwright project in order, on a toolchain-pinned runner with no secrets, paid LLM gateways or live-service reachability, so correctness regressions are caught before merge.

## Requirements

### Requirement: Continuous integration runs all offline gates on every pull request
The project SHALL provide a GitHub Actions workflow triggered on `pull_request` (any branch) and `push` to `main` that runs, in order: lint (Biome), typecheck (`web/` `tsc --noEmit`), unit tests (`test:unit`), locale parity (`check:locales`), production web build (`web:build`), and the offline E2E `fast` Playwright project. Every step MUST complete without secrets, network access to paid LLM gateways, or reachability of the deployed live service.

#### Scenario: pull request opens
- **WHEN** a pull request is opened or updated
- **THEN** the CI workflow SHALL run all six gates sequentially and report a combined status

#### Scenario: push to main
- **WHEN** a commit is pushed to `main`
- **THEN** the CI workflow SHALL run the same six gates

### Requirement: CI environment matches the toolchain constraints
The CI workflow SHALL install Node 25 and npm 11 (lockfile requirement), skip `postinstall` resource building via `PLATFORM_SKIP_WEB_BUILD=1` and `PLATFORM_SKIP_BUNDLE=1`, build `web/dist` explicitly before E2E, and install Playwright's chromium browser.

#### Scenario: clean runner checkout
- **WHEN** CI runs on a fresh GitHub-hosted runner
- **THEN** `npm ci` SHALL succeed without cloning or downloading bundled resources
- **AND** `web/dist` SHALL be built by an explicit workflow step before E2E starts

### Requirement: Type errors block the build
The `web/` package SHALL provide a `typecheck` script running `tsc --noEmit`, and CI SHALL run it as a gate independent of `vite build` (which does not typecheck). The typecheck gate SHALL pass on `main` (including `web/src/components/Composer.tsx`).

#### Scenario: type error introduced in a PR
- **WHEN** a pull request contains TypeScript that fails `tsc --noEmit`
- **THEN** the CI typecheck step SHALL fail the workflow

### Requirement: Lint gate
The project SHALL include a configured linter (Biome) with correctness rules enabled for root JavaScript and `web/` TypeScript/TSX, runnable via a single `npm run lint` script, green on `main`.

#### Scenario: lint detects a correctness issue
- **WHEN** a pull request introduces code that trips a Biome correctness rule
- **THEN** the CI lint step SHALL fail the workflow

### Requirement: Unit tests are machine-independent
All unit tests (`scripts/test-*.mjs`) SHALL resolve dependencies through repo-relative paths, with no absolute paths tied to a specific developer machine. `npm run test:unit` SHALL pass on a clean checkout on any machine.

#### Scenario: fresh clone
- **WHEN** a developer clones the repository to an arbitrary path and runs `npm run test:unit`
- **THEN** all unit tests SHALL pass without module-not-found errors

### Requirement: 非 web 客户端纳入 ubuntu 经济门

CI SHALL cover the non-web clients with offline gates that run exclusively on `ubuntu-*` runners: for the Expo mobile app (`app/`), lint → typecheck (`tsc --noEmit`) → unit tests; for the WeChat mini-program (`miniapp/`), typecheck → markdown unit tests. These gates SHALL trigger when the client or the shared core changes (`app/**`, `miniapp/**`, `packages/core/**`, or the workflow files themselves), and a failure in any of them SHALL fail the overall CI status.

#### Scenario: 共享 core 变更触发双端门禁
- **WHEN** a pull request or push to `main` touches `packages/core/**`
- **THEN** the mobile app gates (lint/typecheck/unit) and the miniapp gates (typecheck/markdown tests) SHALL run and report a combined failing status if any client gate fails

#### Scenario: 移动 app 类型错误被拦截
- **WHEN** a change introduces a TypeScript error under `app/`
- **THEN** the CI app typecheck step SHALL fail the workflow before any APK or emulator leg starts

#### Scenario: miniapp 类型错误被拦截
- **WHEN** a change introduces a TypeScript error under `miniapp/`
- **THEN** the CI miniapp typecheck step SHALL fail the workflow

### Requirement: 重腿走公开池快照通道，私有仓仅 ubuntu

Every workflow job that runs against this private repository's GitHub Actions quota SHALL use an `ubuntu-*` runner. Desktop release matrix legs (macOS ×2, Windows ×1), the Windows install smoke, and the mobile Maestro iOS/Android legs SHALL execute through the public build-pool snapshot channel: a cleaned snapshot that passes a zero-leak check (gitleaks) pushed to a side branch of the public pool repository, triggered by tag or dispatch there. The snapshot process SHALL follow a checked-in manifest that fixes which workflows are retained and which checks run before the push.

#### Scenario: 桌面版本出包
- **WHEN** a desktop release is prepared
- **THEN** its macOS/Windows build matrix SHALL run on the public pool side-branch channel, and the run URL plus artifact checksums SHALL be recorded in the maintenance log before the download page is updated

#### Scenario: 私有仓 workflow 评审
- **WHEN** a workflow file in this repository is added or modified
- **THEN** no job SHALL declare a non-ubuntu `runs-on` unless the change is accompanied by a maintenance-log entry recording the estimated monthly billed minutes and a reviewer sign-off

#### Scenario: 私有额度耗尽时重腿不断供
- **WHEN** the private monthly Actions quota is exhausted
- **THEN** desktop/mobile heavy legs SHALL still be runnable via the pool channel without waiting for the monthly reset

### Requirement: 定时档预算护栏

The private repository SHALL NOT host any scheduled (cron) CI leg on macOS or Windows runners, and any scheduled ubuntu leg SHALL have its estimated billed minutes recorded in the maintenance log. The mobile end-to-end nightly iOS leg SHALL be removed from the private schedule; equivalent coverage SHALL be provided as a manual dispatch or a pool-side schedule.

#### Scenario: 新增定时档过闸
- **WHEN** a new cron-triggered leg is proposed for a private-repo workflow
- **THEN** it SHALL be ubuntu-only and its estimated monthly billed minutes SHALL be logged before merge

#### Scenario: iOS 覆盖仍可获取
- **WHEN** a maintainer needs an iOS simulator end-to-end run
- **THEN** it SHALL be startable on demand (manual dispatch or pool-side schedule) rather than running nightly against private quota

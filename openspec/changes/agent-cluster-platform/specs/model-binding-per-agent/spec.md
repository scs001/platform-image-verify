# model-binding-per-agent Specification

## Purpose

Enables per-agent model configuration with provider routing and user override capabilities for flexible deployment.

## ADDED Requirements

### Requirement: Per-agent model binding at deploy time

When deploying a pack as an A2A service, the deploy action SHALL accept an optional `model` field per agent:

```json
{
  "agents": [
    {
      "agentId": "finance-bot",
      "model": "volces-max",
      "rhythmOverride": "0 9 * * *",
      "budgetOverride": 10
    },
    {
      "agentId": "data-analyst",
      "model": null,  // use manifest default
      "rhythmOverride": null,
      "budgetOverride": null
    }
  ]
}
```

The model validation SHALL follow these rules:
1. **Whitelist check**: The model MUST be in the agent's serving contract `modelWhitelist` (if declared)
2. **Lane check**: The model MUST be authorized on the deployer's billing key lanes
3. **Roster check**: The model MUST be available on the target runner's model roster

All three checks MUST pass; failure at any level SHALL reject the deploy with a structured error naming the failing gate and available options.

If the roster check fails (runner unreachable or no roster data):
- The gate SHALL degrade open (proceed without roster validation)
- A warning SHALL be logged but the deploy SHALL succeed
- This matches the existing scheduler health-blindness discipline

#### Scenario: Model binding accepted

- **WHEN** a deploy request specifies a valid model for an agent
- **THEN** the model is recorded in the deployment descriptor and used for all future executions

#### Scenario: Whitelist violation rejected

- **WHEN** a deploy request specifies a model not in the agent's `modelWhitelist`
- **THEN** the deploy is rejected with an error naming the whitelist and allowed models

#### Scenario: Roster unavailable degrades open

- **WHEN** the target runner's roster cannot be fetched (network issue)
- **THEN** the deploy proceeds without roster validation and logs a warning

### Requirement: Serving config supports model pinning

The serving config surface SHALL allow users to update an agent's model binding after deployment:

**PATCH /api/deployments/:deploymentId/config**
```json
{
  "agents": [
    {
      "agentId": "finance-bot",
      "model": "tencent-standard"  // change from volces-max
    }
  ]
}
```

The same three-gate validation (whitelist, lane, roster) applies to config writes on LIVE deployments. An explicit `null` value SHALL clear the pin and revert to the manifest default.

Config writes SHALL be idempotent; repeated identical updates SHALL have no side effects.

#### Scenario: Model pin updated via config

- **WHEN** a deployer patches a deployment's config with a new model
- **THEN** the model is updated and the next execution uses the new model

#### Scenario: Clear model pin

- **WHEN** a deployer sets `model: null` in a config patch
- **THEN** the agent reverts to using the manifest's declared default model

### Requirement: Runtime model override by user

During a chat session, users SHALL be able to temporarily override an agent's model:

**POST /api/sessions/:sessionId/switch-agent**
```json
{
  "agentId": "finance-bot",
  "modelOverride": "deepseek-coder"  // temporary override for this session
}
```

The override SHALL:
- Apply only to the current session
- Expire when the session ends
- Bypass the roster check (lane and whitelist still enforced)
- Be visible in the session header as "finance-bot (using deepseek-coder)"

If the override is invalid (fails whitelist or lane check):
- The request is rejected with 400
- No session state is changed

#### Scenario: Session-level model override

- **WHEN** a user switches an agent with a model override
- **THEN** subsequent prompts to that agent in this session use the overridden model

#### Scenario: Override expires on session end

- **WHEN** a user ends a session with model overrides
- **THEN** the overrides are discarded and do not persist to new sessions

### Requirement: Provider routing layer

The platform SHALL implement a provider routing layer that maps model names to provider endpoints:

```typescript
interface ProviderRoute {
  modelId: string;
  provider: "volces" | "tencent" | "openrouter" | "deepseek";
  endpoint: string;
  apiKeyEnv: string;
  fallbackProviders?: string[];  // ordered list of fallback providers
}
```

Routing decisions SHALL be made at turn time:
1. Resolve the agent's effective model (from deployment config, session override, or manifest default)
2. Look up the provider route for that model
3. If the primary provider returns an error (5xx, timeout), try the next fallback provider
4. Log the final provider used for billing attribution

Fallback routing SHALL be transparent to users; the task result SHALL include `providerUsed` metadata.

#### Scenario: Primary provider fails, fallback succeeds

- **WHEN** volces returns a 500 error for a request
- **THEN** the system automatically retries with the configured fallback provider (e.g., tencent)

#### Scenario: Billing attribution to provider

- **WHEN** a task completes via a fallback provider
- **THEN** the usage log records `providerUsed: "tencent"` instead of the originally requested `volces`

// Modified in idimsh/paseo: PC-8
//
// "Allow, don't ask again" for agents whose provider carries a Claude Code permission policy
// (`agents.providers.<id>.options.settings.permissions`). Claude Code can save a rule only into its
// own settings files, and the policy reaches it as flag settings, where an `ask` rule beats any
// `allow`. So the daemon moves the rule itself: out of `ask`, into `allow`, in the daemon config,
// and into the running sessions of that provider. Only an answer from a client session (web UI,
// CLI) does this; the MCP `respond_to_permission` tool strips the action (paseo-tools.ts).

import type { DaemonConfigStore, MutableDaemonConfigPatch } from "../daemon-config-store.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentPermissionRequest, AgentPermissionUpdate } from "./agent-sdk-types.js";

export const ALLOW_ALWAYS_ACTION_ID = "allow_always";

export type PermissionRules = Record<string, unknown> & {
  allow?: string[];
  ask?: string[];
  deny?: string[];
};

type ProviderEntries = Record<string, unknown> | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function permissionsOf(options: unknown): PermissionRules | null {
  return asRecord(asRecord(asRecord(options)?.settings)?.permissions) as PermissionRules | null;
}

/**
 * The provider entry whose options define the policy for `providerId`. An entry with its own
 * `options` replaces its parent's (provider-registry.ts, configuredProviderOptions), so the search
 * follows `extends` only through entries without options.
 */
export function findPolicyProvider(
  providers: ProviderEntries,
  providerId: string,
): { id: string; permissions: PermissionRules } | null {
  if (!providers) return null;
  const seen = new Set<string>();
  let id: string | undefined = providerId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = asRecord(providers[id]);
    if (!entry) return null;
    // The registry reads `options ?? params` (COMPAT providerParams).
    const options = entry.options ?? entry.params;
    if (options !== undefined) {
      const permissions = permissionsOf(options);
      return permissions ? { id, permissions } : null;
    }
    const parent: unknown = entry.extends;
    id = typeof parent === "string" ? parent : undefined;
  }
  return null;
}

function toolOf(rule: string): string {
  const open = rule.indexOf("(");
  return open < 0 ? rule : rule.slice(0, open);
}

function specifierOf(rule: string): string {
  const open = rule.indexOf("(");
  return open < 0 || !rule.endsWith(")") ? "" : rule.slice(open + 1, -1);
}

/** Whether `askRule`, other than `rule` itself, would still prompt for calls `rule` allows. */
function stillAsks(askRule: string, rule: string): boolean {
  if (askRule === rule) return false;
  const tool = toolOf(rule);
  if (tool.startsWith("mcp__")) {
    const server = tool.split("__").slice(0, 2).join("__");
    if (askRule === server || askRule === `${server}__*`) return true;
  }
  if (toolOf(askRule) !== tool) return false;
  // A whole-tool ask rule asks for every call; a whole-tool allow rule covers every specifier.
  if (askRule === tool || rule === tool) return true;
  // Both have specifiers: a wildcard ask pattern whose prefix covers the allowed one still asks.
  const askSpecifier = specifierOf(askRule);
  const prefix = askSpecifier.replace(/(?::\*|\*+)$/, "");
  return prefix !== askSpecifier && specifierOf(rule).startsWith(prefix);
}

/** Whether the allow rule `allowRule` covers the calls `rule` names. */
export function ruleAllows(allowRule: string, rule: string): boolean {
  if (allowRule === rule) return true;
  const tool = toolOf(rule);
  if (tool.startsWith("mcp__")) {
    const server = tool.split("__").slice(0, 2).join("__");
    if (allowRule === server || allowRule === `${server}__*`) return true;
  }
  if (toolOf(allowRule) !== tool) return false;
  if (allowRule === tool) return true;
  if (rule === tool) return false;
  const allowSpecifier = specifierOf(allowRule);
  const specifier = specifierOf(rule);
  // `cmd:*` covers `cmd` followed by a word boundary only, so `npm test:*` does not cover `npm testing`.
  if (allowSpecifier.endsWith(":*")) {
    const command = allowSpecifier.slice(0, -2);
    return (
      specifier === command ||
      specifier.startsWith(`${command} `) ||
      specifier.startsWith(`${command}:`)
    );
  }
  const prefix = allowSpecifier.replace(/\*+$/, "");
  return prefix !== allowSpecifier && specifier.startsWith(prefix);
}

export function allowRulesInPolicy(
  permissions: PermissionRules,
  rules: string[],
): { ok: true; permissions: PermissionRules } | { ok: false; reason: string } {
  const ask = permissions.ask ?? [];
  const blocking = ask.filter((askRule) => rules.some((rule) => stillAsks(askRule, rule)));
  if (blocking.length > 0) {
    const named = (list: string[]) => list.map((rule) => `"${rule}"`).join(", ");
    return {
      ok: false,
      reason: `${named(rules)} would still ask because of the ask rule(s) ${named(blocking)}; change the policy by hand`,
    };
  }
  const allow = permissions.allow ?? [];
  return {
    ok: true,
    permissions: {
      ...permissions,
      allow: [...allow, ...rules.filter((rule) => !allow.includes(rule))],
      ask: ask.filter((askRule) => !rules.includes(askRule)),
    },
  };
}

/** Claude's suggested `addRules` (allow) entries, cut down to rules for the requested tool. */
export function toolRuleSuggestions(
  request: Pick<AgentPermissionRequest, "name" | "suggestions">,
): AgentPermissionUpdate[] {
  const updates: AgentPermissionUpdate[] = [];
  for (const suggestion of request.suggestions ?? []) {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") continue;
    const rules = (Array.isArray(suggestion.rules) ? suggestion.rules : []).filter(
      (candidate) => asRecord(candidate)?.toolName === request.name,
    );
    if (rules.length > 0) updates.push({ ...suggestion, rules });
  }
  return updates;
}

/** The rules a "don't ask again" saves: Claude's suggestions for the tool, else the tool name. */
export function rulesForPermissionRequest(
  request: Pick<AgentPermissionRequest, "name" | "suggestions">,
): string[] {
  const rules = toolRuleSuggestions(request).flatMap((update) =>
    (update.rules as unknown[]).map((candidate) => {
      const content = asRecord(candidate)?.ruleContent;
      return typeof content === "string" && content ? `${request.name}(${content})` : request.name;
    }),
  );
  return rules.length > 0 ? [...new Set(rules)] : [request.name];
}

export interface AllowAlwaysPlan {
  policyId: string;
  providerId: string;
  rules: string[];
}

type PolicyAgents = Pick<AgentManager, "getAgent" | "listAgents">;

function hasOwnPermissions(agent: { config: { providerOptions?: unknown } }): boolean {
  return permissionsOf(agent.config.providerOptions) !== null;
}

/**
 * Checks, before the answer is sent, what a "don't ask again" would save. Null when the agent's
 * provider has no policy. Throws, changing nothing, when the move would not stop the prompts.
 */
export function planAllowAlways(input: {
  config: Pick<DaemonConfigStore, "get">;
  agentManager: PolicyAgents;
  agentId: string;
  requestId: string;
}): AllowAlwaysPlan | null {
  const agent = input.agentManager.getAgent(input.agentId);
  const request = agent?.pendingPermissions.get(input.requestId);
  if (!agent || !request) throw new Error(`No pending permission ${input.requestId}`);
  // An agent created with its own permission rules runs with those, not the provider's.
  if (hasOwnPermissions(agent)) {
    throw new Error("This agent has its own permission rules; change them by hand");
  }
  const providers = input.config.get().providers as ProviderEntries;
  const policy = findPolicyProvider(providers, agent.provider);
  if (!policy) return null;
  const rules = rulesForPermissionRequest(request);
  const moved = allowRulesInPolicy(policy.permissions, rules);
  if (!moved.ok) throw new Error(moved.reason);
  return { policyId: policy.id, providerId: agent.provider, rules };
}

/**
 * Writes the move into the daemon config, recomputed from the config as it stands when the write
 * runs, then applies the new policy to the running sessions that use it. Throws when the write
 * fails; a session that could not be updated is reported in the result.
 */
export async function commitAllowAlways(input: {
  config: Pick<DaemonConfigStore, "patch">;
  agentManager: PolicyAgents;
  plan: AllowAlwaysPlan;
}): Promise<{ permissions: PermissionRules; failedAgentIds: string[] }> {
  let written: { permissions: PermissionRules; providers: ProviderEntries } | null = null;
  await input.config.patch((current) => {
    const providers = current.providers as ProviderEntries;
    const policy = findPolicyProvider(providers, input.plan.providerId);
    if (policy?.id !== input.plan.policyId) throw new Error("The provider's policy moved");
    const moved = allowRulesInPolicy(policy.permissions, input.plan.rules);
    if (!moved.ok) throw new Error(moved.reason);
    const entries = { ...providers };
    const entry = asRecord(entries[policy.id]) ?? {};
    const key = entry.options === undefined && entry.params !== undefined ? "params" : "options";
    const options = asRecord(entry[key]) ?? {};
    const settings = asRecord(options.settings) ?? {};
    entries[policy.id] = {
      ...entry,
      [key]: { ...options, settings: { ...settings, permissions: moved.permissions } },
    };
    written = { permissions: moved.permissions, providers: entries };
    return { providers: entries } as MutableDaemonConfigPatch;
  });
  const result = written as { permissions: PermissionRules; providers: ProviderEntries } | null;
  if (!result) throw new Error("The policy was not written");
  const failedAgentIds: string[] = [];
  for (const running of input.agentManager.listAgents()) {
    if (findPolicyProvider(result.providers, running.provider)?.id !== input.plan.policyId)
      continue;
    if (hasOwnPermissions(running)) continue;
    try {
      await running.session?.updatePermissionPolicy?.(result.permissions);
    } catch {
      failedAgentIds.push(running.id);
    }
  }
  return { permissions: result.permissions, failedAgentIds };
}

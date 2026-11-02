// Modified in idimsh/paseo: PC-8
import { describe, expect, it, vi } from "vitest";
import {
  ALLOW_ALWAYS_ACTION_ID,
  allowRulesInPolicy,
  commitAllowAlways,
  findPolicyProvider,
  planAllowAlways,
  ruleAllows,
  rulesForPermissionRequest,
  toolRuleSuggestions,
} from "./permission-policy.js";

const SET_MODE = "mcp__paseo__set_agent_mode";
const BASH_RULE = (content: string) => ({
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: content }],
  behavior: "allow",
  destination: "localSettings",
});

describe("finding the provider entry that holds a permission policy", () => {
  it("follows extends through entries without options to the entry that defines the policy", () => {
    const providers = {
      "claude-director": { extends: "claude-base" },
      "claude-base": {
        extends: "claude",
        options: { settings: { permissions: { ask: [SET_MODE] } } },
      },
    };
    expect(findPolicyProvider(providers, "claude-director")).toEqual({
      id: "claude-base",
      permissions: { ask: [SET_MODE] },
    });
  });

  it("stops at an entry with its own options, which replace its parent's", () => {
    const providers = {
      "claude-zai": { extends: "claude", options: { extraArgs: {} } },
      claude: { options: { settings: { permissions: { ask: [SET_MODE] } } } },
    };
    expect(findPolicyProvider(providers, "claude-zai")).toBeNull();
  });

  it("finds none without a policy, without providers, or in an extends cycle", () => {
    expect(findPolicyProvider({ claude: {} }, "claude")).toBeNull();
    expect(findPolicyProvider(undefined, "claude")).toBeNull();
    expect(findPolicyProvider({ a: { extends: "b" }, b: { extends: "a" } }, "a")).toBeNull();
  });
});

describe("moving rules from ask to allow", () => {
  it("moves the rule out of ask and keeps deny and every other subkey", () => {
    expect(
      allowRulesInPolicy(
        {
          allow: ["mcp__paseo__list_hosts"],
          ask: [SET_MODE, "mcp__paseo__update_agent"],
          deny: ["Bash"],
          extra: true,
        },
        [SET_MODE],
      ),
    ).toEqual({
      ok: true,
      permissions: {
        allow: ["mcp__paseo__list_hosts", SET_MODE],
        ask: ["mcp__paseo__update_agent"],
        deny: ["Bash"],
        extra: true,
      },
    });
  });

  it("adds rules in neither list, and leaves one already allowed as it is", () => {
    expect(allowRulesInPolicy({ allow: [] }, [SET_MODE])).toEqual({
      ok: true,
      permissions: { allow: [SET_MODE], ask: [] },
    });
    expect(allowRulesInPolicy({ allow: [SET_MODE], ask: [] }, [SET_MODE])).toEqual({
      ok: true,
      permissions: { allow: [SET_MODE], ask: [] },
    });
  });

  it("refuses while a broader ask rule would still prompt", () => {
    for (const broader of ["mcp__paseo__*", "mcp__paseo"]) {
      expect(allowRulesInPolicy({ ask: [broader, SET_MODE] }, [SET_MODE])).toMatchObject({
        ok: false,
        reason: expect.stringContaining(broader),
      });
    }
    expect(allowRulesInPolicy({ ask: ["Bash"] }, ["Bash(npm test:*)"])).toMatchObject({
      ok: false,
    });
    expect(allowRulesInPolicy({ ask: ["Bash(git push:*)"] }, ["Bash"])).toMatchObject({
      ok: false,
    });
    expect(allowRulesInPolicy({ ask: ["Bash(git:*)"] }, ["Bash(git push:*)"])).toMatchObject({
      ok: false,
    });
    expect(
      allowRulesInPolicy({ ask: ["Read(./secrets/**)"] }, ["Read(./secrets/a.txt)"]),
    ).toMatchObject({ ok: false });
    expect(allowRulesInPolicy({ ask: ["Bash(git push:*)"] }, ["Bash(npm test:*)"])).toMatchObject({
      ok: true,
    });
  });
});

describe("whether an allow rule covers a call", () => {
  it("matches whole tools, MCP servers and wildcard prefixes", () => {
    expect(ruleAllows(SET_MODE, SET_MODE)).toBe(true);
    expect(ruleAllows("mcp__paseo", SET_MODE)).toBe(true);
    expect(ruleAllows("mcp__paseo__*", SET_MODE)).toBe(true);
    expect(ruleAllows("Bash", "Bash(npm test)")).toBe(true);
    expect(ruleAllows("Bash(npm test:*)", "Bash(npm test -- --watch)")).toBe(true);
    expect(ruleAllows("Bash(npm test:*)", "Bash")).toBe(false);
    expect(ruleAllows("Bash(npm test:*)", "Bash(git push)")).toBe(false);
    expect(ruleAllows("mcp__other", SET_MODE)).toBe(false);
  });
});

describe("the rules a permission request saves", () => {
  it("keeps every suggested rule for the requested tool and nothing else", () => {
    const request = {
      name: "Bash",
      suggestions: [
        BASH_RULE("npm test:*"),
        BASH_RULE("git status:*"),
        { type: "addDirectories", directories: ["../other"], destination: "localSettings" },
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    };
    expect(rulesForPermissionRequest(request)).toEqual(["Bash(npm test:*)", "Bash(git status:*)"]);
    expect(toolRuleSuggestions(request)).toEqual([
      BASH_RULE("npm test:*"),
      BASH_RULE("git status:*"),
    ]);
  });

  it("falls back to the tool name when Claude suggests no rule for it", () => {
    expect(rulesForPermissionRequest({ name: SET_MODE })).toEqual([SET_MODE]);
  });
});

describe("saving 'Allow, don't ask again'", () => {
  function setup(permissions: Record<string, unknown>) {
    let providers: Record<string, unknown> = {
      "claude-director": { extends: "claude", options: { settings: { permissions } } },
    };
    const config = {
      get: () => ({ providers }) as never,
      patch: vi.fn(async (fn: (current: never) => { providers: Record<string, unknown> }) => {
        providers = fn({ providers } as never).providers;
        return { providers } as never;
      }),
    };
    const sessionOf = () => ({ updatePermissionPolicy: vi.fn(async () => undefined) });
    const agents = [
      {
        id: "director-1",
        provider: "claude-director",
        config: {},
        session: sessionOf(),
        pendingPermissions: new Map<string, unknown>([
          ["mode", { name: SET_MODE }],
          ["update", { name: "mcp__paseo__update_agent" }],
        ]),
      },
      {
        id: "director-2",
        provider: "claude-director",
        config: {},
        session: sessionOf(),
        pendingPermissions: new Map(),
      },
      {
        id: "own-rules",
        provider: "claude-director",
        config: { providerOptions: { settings: { permissions: { ask: [] } } } },
        session: sessionOf(),
        pendingPermissions: new Map([["mode", { name: SET_MODE }]]),
      },
      {
        id: "builder",
        provider: "claude",
        config: {},
        session: sessionOf(),
        pendingPermissions: new Map(),
      },
    ];
    const agentManager = {
      getAgent: (id: string) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: () => agents,
    } as never;
    return { config, agentManager, agents, providers: () => providers };
  }

  it("plans, then writes the move and applies it to that provider's running sessions", async () => {
    const env = setup({ allow: [], ask: [SET_MODE], deny: ["Bash"] });
    const plan = planAllowAlways({ ...env, agentId: "director-1", requestId: "mode" });
    expect(plan).toEqual({
      policyId: "claude-director",
      providerId: "claude-director",
      rules: [SET_MODE],
    });
    expect(env.config.patch).not.toHaveBeenCalled();

    const result = await commitAllowAlways({ ...env, plan: plan! });

    const expected = { allow: [SET_MODE], ask: [], deny: ["Bash"] };
    expect(result).toEqual({ permissions: expected, failedAgentIds: [] });
    expect(env.providers()).toEqual({
      "claude-director": { extends: "claude", options: { settings: { permissions: expected } } },
    });
    expect(env.agents[0]!.session.updatePermissionPolicy).toHaveBeenCalledWith(expected);
    expect(env.agents[1]!.session.updatePermissionPolicy).toHaveBeenCalledWith(expected);
    expect(env.agents[2]!.session.updatePermissionPolicy).not.toHaveBeenCalled();
    expect(env.agents[3]!.session.updatePermissionPolicy).not.toHaveBeenCalled();
  });

  it("recomputes from the config at write time, so two quick answers both keep their rule", async () => {
    const env = setup({ allow: [], ask: [SET_MODE, "mcp__paseo__update_agent"] });
    const first = planAllowAlways({ ...env, agentId: "director-1", requestId: "mode" })!;
    const second = planAllowAlways({ ...env, agentId: "director-1", requestId: "update" })!;
    await commitAllowAlways({ ...env, plan: first });
    await commitAllowAlways({ ...env, plan: second });
    expect(
      (env.providers()["claude-director"] as { options: { settings: { permissions: unknown } } })
        .options.settings.permissions,
    ).toEqual({ allow: [SET_MODE, "mcp__paseo__update_agent"], ask: [] });
  });

  it("refuses before anything is written when a broader ask rule still matches", () => {
    const env = setup({ ask: ["mcp__paseo__*", SET_MODE] });
    expect(() => planAllowAlways({ ...env, agentId: "director-1", requestId: "mode" })).toThrow(
      "mcp__paseo__*",
    );
    expect(env.config.patch).not.toHaveBeenCalled();
  });

  it("refuses an agent with its own permission rules", () => {
    const env = setup({ ask: [SET_MODE] });
    expect(() => planAllowAlways({ ...env, agentId: "own-rules", requestId: "mode" })).toThrow(
      "its own permission rules",
    );
  });

  it("plans nothing for an agent whose provider has no policy", () => {
    const env = setup({ ask: [SET_MODE] });
    env.agents[0]!.provider = "claude";
    expect(planAllowAlways({ ...env, agentId: "director-1", requestId: "mode" })).toBeNull();
  });

  it("reports a running session it could not update, after writing the config", async () => {
    const env = setup({ ask: [SET_MODE] });
    env.agents[1]!.session.updatePermissionPolicy.mockRejectedValueOnce(new Error("closed"));
    const plan = planAllowAlways({ ...env, agentId: "director-1", requestId: "mode" })!;
    await expect(commitAllowAlways({ ...env, plan })).resolves.toMatchObject({
      failedAgentIds: ["director-2"],
    });
  });

  it("names the action id the provider offers", () => {
    expect(ALLOW_ALWAYS_ACTION_ID).toBe("allow_always");
  });
});

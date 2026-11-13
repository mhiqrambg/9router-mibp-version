import { describe, expect, it } from "vitest";
import { filterConnectionsForModel } from "../../src/sse/services/auth.js";

const connections = [
  { id: "flash-1", providerSpecificData: { freebuffModel: "deepseek/deepseek-v4-flash" } },
  { id: "mimo-1", providerSpecificData: { freebuffModel: "mimo/mimo-v2.5" } },
  { id: "unassigned", providerSpecificData: {} },
];

describe("Freebuff strict model assignment", () => {
  it("keeps only accounts assigned to the requested model", () => {
    const result = filterConnectionsForModel("freebuff", connections, "mimo/mimo-v2.5", {
      providerStrategies: { freebuff: { strictModelAssignment: true } },
    });

    expect(result.map((connection) => connection.id)).toEqual(["mimo-1"]);
  });

  it("excludes unassigned accounts when strict mode is enabled", () => {
    const result = filterConnectionsForModel("freebuff", connections, "deepseek/deepseek-v4-flash", {
      providerStrategies: { freebuff: { strictModelAssignment: true } },
    });

    expect(result.map((connection) => connection.id)).toEqual(["flash-1"]);
  });

  it("preserves the existing pool when strict mode is disabled", () => {
    expect(filterConnectionsForModel("freebuff", connections, "mimo/mimo-v2.5", {})).toBe(connections);
  });

  it("lets an All-models connection serve any requested model", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true } } };
    const withWildcard = [
      ...connections,
      { id: "all-1", providerSpecificData: { assignedModel: "*" } },
    ];

    expect(filterConnectionsForModel("freebuff", withWildcard, "mimo/mimo-v2.5", settings).map((c) => c.id))
      .toEqual(["mimo-1", "all-1"]);
    expect(filterConnectionsForModel("freebuff", withWildcard, "unlisted/model", settings).map((c) => c.id))
      .toEqual(["all-1"]);
  });

  it("honors the All-models sentinel for non-freebuff providers", () => {
    const result = filterConnectionsForModel("codex", [
      { id: "pinned", providerSpecificData: { assignedModel: "gpt-5" } },
      { id: "all", providerSpecificData: { assignedModel: "*" } },
      { id: "off", providerSpecificData: {} },
    ], "gpt-5-mini", { providerStrategies: { codex: { strictModelAssignment: true } } });

    expect(result.map((c) => c.id)).toEqual(["all"]);
  });

  it("does not affect other providers when their toggle is off", () => {
    expect(filterConnectionsForModel("codex", connections, "mimo/mimo-v2.5", {
      providerStrategies: {},
    })).toBe(connections);
  });
});

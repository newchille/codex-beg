import { describe, expect, it } from "vitest";
import { isAgentHostPortConflict } from "../../electron/agent-host-lifecycle.js";

describe("Agent Host lifecycle errors", () => {
  it("recognizes the fixed MCP port conflict", () => {
    expect(isAgentHostPortConflict("Error: listen EADDRINUSE: address already in use 127.0.0.1:43123")).toBe(true);
    expect(isAgentHostPortConflict("Error: listen EADDRINUSE: address already in use 127.0.0.1:43124")).toBe(false);
    expect(isAgentHostPortConflict("Agent Host exited unexpectedly")).toBe(false);
  });
});

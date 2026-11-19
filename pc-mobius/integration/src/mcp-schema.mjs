import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import contract from '../../contracts/mcp-tools.v1.json' with { type: 'json' };
import agentContract from '../../contracts/mcp-agent-tools.v1.json' with { type: 'json' };
import triageContract from '../../contracts/mcp-triage-tools.v1.json' with { type: 'json' };
export { contract as MCP_CONTRACT, agentContract as MCP_AGENT_CONTRACT, triageContract as MCP_TRIAGE_CONTRACT };

/** Tool-level review result that the agent profile returns as an MCP `isError` result with a safe reason code. */
export class McpToolReview extends Error {
  constructor(reason, message, detail = {}) { super(message); this.name = 'McpToolReview'; this.code = 'MCP_TOOL_REVIEW'; this.reason = reason; this.detail = detail; }
}
export const toolReview = (reason, message, detail) => new McpToolReview(reason, message, detail);

export function compileTools(tools) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 64) throw new Error('MCP tool catalog required');
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
  const catalog = new Map();
  for (const tool of tools) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || catalog.has(tool.name) || !tool.requiredScope
      || tool.inputSchema?.type !== 'object' || tool.outputSchema?.type !== 'object'
      || tool.inputSchema.additionalProperties !== false || tool.outputSchema.additionalProperties !== false) throw new Error('Closed MCP input/output schemas and scoped unique tools required');
    catalog.set(tool.name, { ...structuredClone(tool), input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema) });
  }
  return catalog;
}
export function validateTool(catalog, name, direction, value) {
  const tool = catalog.get(name);
  if (!tool) throw new Error('Registered MCP tool required');
  if (Buffer.byteLength(JSON.stringify(value)) > 65536 || !tool[direction](value)) throw new Error(`MCP ${direction} schema required`);
  return tool;
}
export function wireTool(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    annotations: { readOnlyHint: tool.readOnly === true, destructiveHint: tool.readOnly !== true, idempotentHint: true, openWorldHint: false } };
}

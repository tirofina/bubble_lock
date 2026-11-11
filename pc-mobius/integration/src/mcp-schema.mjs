import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import contract from '../../contracts/mcp-tools.v1.json' with { type: 'json' };
export { contract as MCP_CONTRACT };

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

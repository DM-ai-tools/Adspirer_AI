/**
 * Side-effect import to register all diagnose + execute tools.
 */
import "@/lib/tools/diagnose";
import "@/lib/tools/execute";

export { classify, assertNotBlocked, listClassifiedTools } from "./policy";
export {
  registerTool,
  getTool,
  listTools,
  requireTool,
  invokeTool,
  type ToolContext,
  type RegisteredTool,
  type ToolSafetyClass,
} from "./registry";

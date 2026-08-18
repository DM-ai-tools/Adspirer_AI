import { z } from "zod";
import type { ToolSafetyClass } from "@/types";
import { classify } from "./policy";
import { ToolClassificationError } from "@/lib/errors";

export type { ToolSafetyClass };

export type ToolContext = {
  clientId: string;
  userId: string;
  taskId?: string | null;
  conversationId?: string | null;
  correlationId?: string;
  /** When set, execute tools may run against an approved approval. */
  approvalId?: string;
};

export type RegisteredTool<TSchema extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  safety: ToolSafetyClass;
  inputSchema: TSchema;
  execute: (
    args: z.infer<TSchema>,
    ctx: ToolContext,
  ) => Promise<unknown>;
};

const registry = new Map<string, RegisteredTool>();

export function registerTool<TSchema extends z.ZodType>(
  tool: Omit<RegisteredTool<TSchema>, "safety"> & { safety?: ToolSafetyClass },
): RegisteredTool<TSchema> {
  const safety = tool.safety ?? classify(tool.name);
  if (safety === "blocked") {
    throw new ToolClassificationError(
      `Refusing to register blocked/unknown tool: ${tool.name}`,
      { toolName: tool.name },
    );
  }

  const entry: RegisteredTool<TSchema> = {
    ...tool,
    safety,
  };
  registry.set(tool.name, entry as RegisteredTool);
  return entry;
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function listTools(): RegisteredTool[] {
  return Array.from(registry.values());
}

export function requireTool(name: string): RegisteredTool {
  const tool = getTool(name);
  if (!tool) {
    throw new ToolClassificationError(`Unknown tool: ${name}`, {
      toolName: name,
    });
  }
  if (tool.safety === "blocked" || classify(name) === "blocked") {
    throw new ToolClassificationError(`Tool is blocked: ${name}`, {
      toolName: name,
    });
  }
  return tool;
}

export async function invokeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = requireTool(name);
  const parsed = tool.inputSchema.parse(rawArgs);
  return tool.execute(parsed, ctx);
}

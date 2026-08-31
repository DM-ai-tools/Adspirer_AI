import { getConfig } from "@/lib/config";

export function getMetaGraphVersion(): string {
  return getConfig().META_GRAPH_VERSION || "v23.0";
}

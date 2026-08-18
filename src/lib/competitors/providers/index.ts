import { getConfig } from "@/lib/config";
import { createMockCompetitorProviders } from "./mock";
import { SociaVaultAdIntelligenceProvider } from "./sociavault";

export function createCompetitorProviders() {
  const config = getConfig();
  const mock = createMockCompetitorProviders();

  if (config.hasSociaVault) {
    return {
      firmographic: mock.firmographic,
      traffic: mock.traffic,
      ads: new SociaVaultAdIntelligenceProvider(),
    };
  }

  return mock;
}

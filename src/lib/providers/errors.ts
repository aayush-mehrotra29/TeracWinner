export class IntegrationBlockedError extends Error {
  readonly code = "integration_blocked";

  constructor(message: string, readonly provider?: string) {
    super(message);
    this.name = "IntegrationBlockedError";
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

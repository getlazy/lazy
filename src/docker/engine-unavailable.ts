/** The engine could not answer a readiness check; no build has started. */
export class ContainerEngineUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContainerEngineUnavailableError';
  }
}

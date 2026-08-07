/** Expected control flow when a newer deployment generation takes ownership. */
export class DeploymentSupersededError extends Error {
  constructor() {
    super('Deployment generation was superseded');
    this.name = 'DeploymentSupersededError';
  }
}

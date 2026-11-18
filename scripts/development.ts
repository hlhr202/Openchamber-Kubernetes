export function requireDevelopmentContainer(): void {
  if (process.platform !== 'linux' || process.env.OPENCHAMBER_K8S_DEVELOPMENT !== '1') {
    throw new Error('Run complete engineering checks in the project Compose dev container. No tools are installed automatically.');
  }
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24.x is required.');
}

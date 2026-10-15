// Implements: SPEC-INT-014 (cached channel destinations, no attached content, CA-01), gap E-212.
export interface PublishedResource {
  readonly server: string;
  readonly uri: string;
  readonly name: string;
}
/** Connectors publish destination metadata as resources; selecting one never reads its contents. */
export function teamChannel(resource: PublishedResource): boolean {
  return resource.uri.startsWith("team-channel:");
}
export function channelDestinations(
  resources: readonly PublishedResource[],
): PublishedResource[] {
  const channels = resources.filter(
    (r) =>
      teamChannel(r) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(r.name) &&
      /^team-channel:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.uri),
  );
  const counts = new Map<string, number>();
  for (const row of channels) {
    const key = JSON.stringify([row.server, row.name]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return channels.filter(
    (row) => counts.get(JSON.stringify([row.server, row.name])) === 1,
  );
}

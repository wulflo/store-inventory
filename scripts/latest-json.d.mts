export interface LatestJsonPlatform {
  signature: string;
  url: string;
}

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, LatestJsonPlatform>;
}

export function walkFiles(dir: string): string[];
export function updaterArtifact(fileName: string): { platform: string; rank: number } | null;
export function platformFor(fileName: string): string | null;
export function buildLatestJson(options: {
  version: string;
  tag: string;
  repo: string;
  artifactsDir: string;
  notes?: string;
  pubDate?: string;
}): LatestJson;

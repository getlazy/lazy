export interface StoredImageBuildLogPage {
  lines: Array<{ seq: number; [key: string]: unknown }>;
  firstSeq: number;
  lastSeq: number;
  truncatedBefore: boolean;
}

/** Durable image-build history. Logs are retained for the newest 20 builds. */
export interface StoredImageBuild {
  id: string;
  build: Record<string, unknown>;
  logsRetained: boolean;
}

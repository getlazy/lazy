/** Durable machine recovery state; survives daemon rolls with the project store. */
export interface DiskSpaceState {
  needsGrowth: boolean;
  /** Missing on stores written before versioned growth acknowledgements. */
  growthGeneration?: number;
  /** Measured build-space pressure, retained across retries and daemon rolls. */
  buildPressure?: BuildSpacePressure;
  /** Cache used by the latest isolated successful build, not unrelated GC. */
  buildCache?: { image: string; identity: string; records: Array<{ id: string; bytes: number }> };
  lastRecovery: { at: string; freedBytes: number; reason: string; error?: string } | null;
  /** The current and previous successful build in each image family. */
  images: Array<{ id: string; name?: string; family: string; builtAt: number }>;
}

export interface BuildSpacePressure {
  /** Recorded atomically with this observation; absent in older stores. */
  growthGeneration?: number;
  image: string;
  identity: string;
  at: string;
  blocked: boolean;
  reason: 'enospc' | 'cache-evicted';
  diskBytes: number;
  requiredBytes: number;
  peakUsedBytes: number;
  consumedBytes: number;
  failedFreeBytes: number;
  cacheEvictedBytes: number;
  requiredCacheBytes: number;
  cacheLimitBytes: number | null;
  message: string;
}

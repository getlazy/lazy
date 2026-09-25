/**
 * Re-export build provenance helpers for scripts/ and tests that import this path.
 *
 * The implementation lives in src/utils/build-provenance.ts so compiled binaries
 * can bundle the formatters; scripts/build.ts and generate-version.ts keep
 * importing from here for compatibility.
 */

export {
  type BuildInfoValues,
  DEV_BUILD_INFO_VALUES,
  DEV_BUILD_INFO,
  formatBuildInfoContent,
  captureGitBuildMetadata,
  resolveBuildBranch,
  captureBuildProvenance,
  formatDisplayPath,
  formatSourceProvenanceLine,
  formatEmbeddedBuildProvenance,
} from '../src/utils/build-provenance';

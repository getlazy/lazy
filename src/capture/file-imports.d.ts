// Type declarations for Bun's { type: "file" } import attribute.
// These imports return a string path to the embedded file at runtime.

// Wildcard declaration: any file ending with "lazy-agent" resolves to a path string.
// This covers the relative import from src/capture/claude.ts.
declare module '*lazy-agent' {
  const path: string;
  export default path;
}

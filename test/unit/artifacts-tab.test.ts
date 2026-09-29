/**
 * The Artifacts tab's bytes rules, and the dashboard framing guard they sit under.
 */
import { describe, test, expect } from 'bun:test';
import { inlineImageType, artifactFileResponse } from '../../src/server/artifacts-tab';
import type { TaskArtifactContent } from '../../src/types';

function artifact(mime_type: string): TaskArtifactContent {
  return {
    id: 'a', task_id: 't', name: 'dir/x.bin', size: 1, sha256: '', mime_type, binary: true,
    origin: 'output', created_at: 0, created_by: 'agent', content_base64: 'eA==',
  };
}

describe('artifact bytes', () => {
  // INVARIANT: only an allowlisted raster type is ever served inline. The stored
  // MIME string is caller-supplied, so a denylist of one exact spelling of SVG
  // let case and parameter variants through onto the dashboard's origin.
  test('SVG and HTML in any spelling are never inline images', () => {
    for (const m of ['image/svg+xml', 'image/SVG+XML', 'image/svg+xml; charset=utf-8', 'text/html', 'image/x-anything', '']) {
      expect(inlineImageType(m)).toBeNull();
      const res = artifactFileResponse(artifact(m), false);
      expect(res.headers.get('content-disposition')).toStartWith('attachment;');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    }
  });

  test('raster images are inline under their normalized type unless a download is asked for', () => {
    expect(inlineImageType('IMAGE/PNG; foo=bar')).toBe('image/png');
    const res = artifactFileResponse(artifact('Image/PNG'), false);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toStartWith('inline;');
    expect(artifactFileResponse(artifact('image/png'), true).headers.get('content-disposition')).toStartWith('attachment;');
  });
});

// Slugs: the short part of a short link, as in http://localhost:3000/<slug>.

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/1/o/0 lookalikes
const SLUG_PATTERN = /^[A-Za-z0-9-]{3,32}$/;

/** A random slug, `length` characters from an alphabet without lookalikes. */
export function randomSlug(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let slug = '';
  for (const byte of bytes) slug += ALPHABET[byte % ALPHABET.length];
  return slug;
}

/** Whether a caller-chosen slug is acceptable: 3–32 letters, digits or dashes. */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** Custom slugs are stored lowercase so `/Docs` and `/docs` are the same link. */
export function normalizeSlug(slug: string): string {
  return slug.toLowerCase();
}

/** Whether `url` is something we are willing to redirect to. */
export function isValidTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // `new URL` throws on anything that is not a URL; that is exactly "invalid".
    return false;
  }
}

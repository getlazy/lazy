// The SQLite store. bun:sqlite is built into Bun, so there is nothing to install.

import { Database } from 'bun:sqlite';
import schema from './schema.sql' with { type: 'text' };

export interface Link {
  slug: string;
  url: string;
  createdAt: number;
}

export interface LinkPage {
  links: Link[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface LinkStats {
  slug: string;
  url: string;
  clicks: number;
  lastClickedAt: number | null;
}

interface LinkRow { slug: string; url: string; created_at: number }

export class Store {
  readonly db: Database;

  /** `path` is a file, or ':memory:' for a throwaway database (the tests use this). */
  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(schema);
  }

  /** Insert a link. Returns false when the slug is already taken. */
  createLink(slug: string, url: string, now = Date.now()): boolean {
    const result = this.db
      .query('INSERT OR IGNORE INTO links (slug, url, created_at) VALUES (?, ?, ?)')
      .run(slug, url, now);
    return result.changes === 1;
  }

  getLink(slug: string): Link | null {
    const row = this.db.query<LinkRow, [string]>('SELECT * FROM links WHERE slug = ?').get(slug);
    return row ? toLink(row) : null;
  }

  /** Newest first, `pageSize` at a time. Pages are numbered from 1. */
  listLinks(page = 1, pageSize = 20): LinkPage {
    const rows = this.db
      .query<LinkRow, [number, number]>('SELECT * FROM links ORDER BY created_at DESC, slug LIMIT ? OFFSET ?')
      .all(pageSize, (page - 1) * pageSize);
    return { links: rows.map(toLink), page, pageSize, hasMore: rows.length === pageSize };
  }

  deleteLink(slug: string): boolean {
    return this.db.query('DELETE FROM links WHERE slug = ?').run(slug).changes > 0;
  }

  recordClick(slug: string, now = Date.now()): void {
    this.db.query('INSERT INTO clicks (slug, clicked_at) VALUES (?, ?)').run(slug, now);
  }

  stats(slug: string): LinkStats | null {
    const link = this.getLink(slug);
    if (!link) return null;
    const row = this.db
      .query<{ clicks: number; last: number | null }, [string]>(
        'SELECT COUNT(*) AS clicks, MAX(clicked_at) AS last FROM clicks WHERE slug = ?',
      )
      .get(slug)!;
    return { slug, url: link.url, clicks: row.clicks, lastClickedAt: row.last };
  }

  close(): void {
    this.db.close();
  }
}

function toLink(row: LinkRow): Link {
  return { slug: row.slug, url: row.url, createdAt: row.created_at };
}

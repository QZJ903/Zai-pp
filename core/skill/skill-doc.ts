/**
 * SKILL.md 解析 —— **两个导入链共用的唯一实现**。
 *
 * Local import (folder reference) and GitHub import used to carry a verbatim copy of this
 * parser, ~100 lines each across 8 helpers. The copies drifted: the GitHub copy lacked the
 * BOM strip, the H1 fallback and the empty-string fallback, so the same file could yield
 * different names depending on which chain read it. They are one implementation now.
 *
 * Only two facts genuinely differ between the chains, and both are parameters:
 *  · the `description` fallback sentence (user-visible text, keeps each chain's wording);
 *  · anything else that needs to vary is a caller concern, not a parser concern.
 */

import { requireSkillSlug } from './slug';

export interface ParsedSkillDoc {
  name: string;
  description: string;
  body: string;
  version?: string;
  lastUpdated?: string;
}

export interface ParseSkillDocOptions {
  /**
   * Used verbatim when neither frontmatter nor body yields a description, e.g.
   * `Imported local Skill from ${path}`. Kept as a callback so each chain keeps its own
   * sentence without the parser knowing which chain is calling.
   */
  describeFallback: (path: string) => string;
}

/**
 * Parse a SKILL.md document (agentskills.io / pi-ecosystem format).
 *
 * Name resolution, in order: frontmatter `name` → first H1 → parent directory name → the
 * path with `SKILL.md` removed. The final step through `normalizeSkillName` guarantees a
 * non-empty slug, so a nameless file at the repository root still imports.
 *
 * ⚠️ The BOM strip below matters for every caller that hands over raw file bytes. Callers
 * that go through `fetch().text()` will already have lost it (the UTF-8 decoder drops a
 * leading BOM), which is why the strip is idempotent rather than load-bearing there.
 */
export function parseSkillDoc(
  raw: string,
  path: string,
  options: ParseSkillDocOptions,
): ParsedSkillDoc {
  const bomStripped = raw.replace(/^\uFEFF/, '');
  const frontmatter = bomStripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = frontmatter ? parseYamlSubset(frontmatter[1]) : {};
  const body = frontmatter ? bomStripped.slice(frontmatter[0].length).trim() : bomStripped.trim();
  const name = requireSkillSlug(
    readString(meta, 'name')
    ?? extractH1Title(body)
    ?? parentDirectory(path).split('/').pop()
    ?? path.replace(/\/?SKILL\.md$/i, ''),
  );
  const description = readString(meta, 'description')
    ?? firstParagraph(body)
    ?? options.describeFallback(path);
  const metadata = readObject(meta, 'metadata');
  const version = readString(metadata, 'version') ?? readString(meta, 'version');
  const lastUpdated = readString(metadata, 'last_updated')
    ?? readString(metadata, 'lastUpdated')
    ?? readString(meta, 'last_updated');

  return { name, description, body, version, lastUpdated };
}

function extractH1Title(body: string): string | undefined {
  const match = body.match(/^\s*#\s+(.+?)\s*$/m);
  return match ? match[1] : undefined;
}

/**
 * A deliberately small YAML subset: `key: value`, block scalars (`|`, `|-`, `>`, `>-`),
 * one level of nested keys, and quoted scalars. Anything richer is ignored, which keeps a
 * malformed frontmatter from throwing — the caller falls back to body-derived values.
 */
function parseYamlSubset(raw: string): Record<string, unknown> {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2] ?? '';
    if (value === '|' || value === '|-' || value === '>' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^\s{2,}/, ''));
      }
      result[key] = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
      continue;
    }
    if (value === '') {
      const nested: Record<string, string> = {};
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i += 1;
        const nestedMatch = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (nestedMatch) nested[nestedMatch[1]] = cleanYamlScalar(nestedMatch[2]);
      }
      result[key] = nested;
      continue;
    }
    result[key] = cleanYamlScalar(value);
  }
  return result;
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** First paragraph that is not a heading and does not open a code fence. */
function firstParagraph(body: string): string | undefined {
  const paragraph = body
    .replace(/^# .+$/m, '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0 && !part.startsWith('```'));
  return paragraph ? paragraph.slice(0, 240) : undefined;
}

/**
 * Directory portion of a Skill path, with Windows separators normalised.
 *
 * Exported because the GitHub chain also needs it to compute a resource prefix; keeping a
 * second copy here would reintroduce the very duplication this module exists to remove.
 */
export function parentDirectory(path: string): string {
  // Normalize Windows backslashes so `D:\foo\bar\SKILL.md` resolves correctly.
  // GitHub tree paths are always POSIX, so the replace is a no-op there.
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/');
}
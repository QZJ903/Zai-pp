import type { SavedItem } from './types';

export type SavedItemsExportFormat = 'markdown' | 'json';

export interface SavedItemsExportArtifact {
  format: SavedItemsExportFormat;
  filename: string;
  mimeType: string;
  content: string;
}

export function createSavedItemsMarkdownArtifact(items: readonly SavedItem[]): SavedItemsExportArtifact {
  const lines = [
    '# Zai++ Saved Items',
    '',
    `- Count: ${items.length}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
  ];
  for (const item of items) {
    lines.push(
      `## ${stripMarkdownHeading(item.title)}`,
      '',
      `- Kind: ${item.kind}`,
      `- Tags: ${item.tags.length ? item.tags.join(', ') : 'none'}`,
      `- Updated: ${new Date(item.updatedAt).toISOString()}`,
      '',
      item.content,
      '',
    );
  }

  return {
    format: 'markdown',
    filename: `zai-saved-items-${new Date().toISOString().slice(0, 10)}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n'),
  };
}

export function createSavedItemsJsonArtifact(items: readonly SavedItem[]): SavedItemsExportArtifact {
  return {
    format: 'json',
    filename: `zai-saved-items-${new Date().toISOString().slice(0, 10)}.json`,
    mimeType: 'application/json;charset=utf-8',
    content: JSON.stringify({
      schemaVersion: 'glm-pp.saved-items-export.v1',
      exportedAt: new Date().toISOString(),
      items,
    }, null, 2),
  };
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim() || 'Untitled';
}
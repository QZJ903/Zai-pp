export const SAVED_ITEMS_SCHEMA_VERSION = 1;

export type SavedItemKind = 'snippet' | 'bookmark';

export interface SavedItem {
  id: string;
  kind: SavedItemKind;
  title: string;
  content: string;
  sourceUrl?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export type SavedItemInput = Omit<SavedItem, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

export interface SavedItemsState {
  schemaVersion: typeof SAVED_ITEMS_SCHEMA_VERSION;
  items: SavedItem[];
}

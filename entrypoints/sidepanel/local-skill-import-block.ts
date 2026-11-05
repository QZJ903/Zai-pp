import type { LocalSkillImportBlock } from '../../core/types';
import type { LocaleMessageKey, MessageParams } from '../../core/i18n';

/**
 * Local-Skill import block → user-facing text.
 *
 * ⚠️ **Two call sites read the exact same `LocalSkillImportBlock`**: the per-Skill rows
 * inside the import panel, and the "update failed" branch on the Skills page. Writing
 * the `switch` twice means adding a code updates one and forgets the other — and with
 * no `default` branch that shows up as an empty instruction line, not an error.
 *
 * ⚠️ **Adding a `LocalSkillImportBlockCode`? Add a case here**; the exhaustive `switch`
 * with a declared return type is what makes `tsc` point at this file.
 */

type Translate = (key: LocaleMessageKey, params?: MessageParams) => string;

export function getImportBlockInstructions(block: LocalSkillImportBlock, t: Translate): string {
  switch (block.code) {
    case 'shell_host_update_required':
      return t('sidepanel.localSkillImport.readerActions.updateHost');
    case 'shell_reader_unavailable':
      return t('sidepanel.localSkillImport.readerActions.enableReader');
    case 'shell_discovery_failed':
      return t('sidepanel.localSkillImport.readerActions.checkConnection');
    case 'local_path_unavailable':
      return t('sidepanel.localSkillImport.readerActions.reselectPath');
  }
}

export function formatImportBlockMessage(block: LocalSkillImportBlock, t: Translate): string {
  return [
    t('sidepanel.localSkillImport.readerUnavailable'),
    getImportBlockInstructions(block, t),
    block.detail
      ? t('sidepanel.localSkillImport.readerTechnicalDetail', { detail: block.detail })
      : '',
  ].filter(Boolean).join(' ');
}

/**
 * Read a block out of an untrusted runtime response.
 *
 * ⚠️ Whitelists every code instead of accepting "an object that looks right" — the
 * value drives which instruction the UI shows, and an unknown code would leave
 * `getImportBlockInstructions` without a case to take.
 */
export function readLocalSkillImportBlock(value: unknown): LocalSkillImportBlock | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { code?: unknown; detail?: unknown };
  if (
    candidate.code !== 'shell_host_update_required' &&
    candidate.code !== 'shell_reader_unavailable' &&
    candidate.code !== 'shell_discovery_failed' &&
    candidate.code !== 'local_path_unavailable'
  ) return null;
  return {
    code: candidate.code,
    ...(typeof candidate.detail === 'string' && candidate.detail
      ? { detail: candidate.detail }
      : {}),
  };
}
import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  formatMessage,
  getLocaleArrayKeys,
  getLocaleStringKeys,
  normalizeLocalePreference,
  resolveLocalePreference,
  resolveMessage,
  translate,
} from '../core/i18n';

describe('i18n resources', () => {
  it('keeps English and Chinese string keys in parity', () => {
    expect(getLocaleStringKeys('en').sort()).toEqual(getLocaleStringKeys('zh-CN').sort());
  });

  it('keeps English and Chinese array keys in parity', () => {
    expect(getLocaleArrayKeys('en').sort()).toEqual(getLocaleArrayKeys('zh-CN').sort());
  });
});

describe('i18n translation', () => {
  it('translates typed keys by locale', () => {
    expect(translate('en', 'app.tabs.library')).toBe('Library');
    expect(translate('zh-CN', 'app.tabs.library')).toBe('资料');
  });

  it('translates sidepanel shared UI copy by locale', () => {
    expect(translate('en', 'sidepanel.memory.types.feedback')).toBe('Feedback');
    expect(translate('zh-CN', 'sidepanel.memory.types.feedback')).toBe('反馈');
    expect(translate('en', 'sidepanel.githubSkillImport.selectedSummary', {
      selected: 2,
      total: 5,
      bytes: '3 KB',
    })).toBe('Selected 2 / 5 · 3 KB');
  });

  it('translates runtime page status copy by locale without touching dynamic names', () => {
    expect(translate('en', 'sidepanel.mcpPage.summary', {
      servers: 2,
      enabled: 1,
      tools: 4,
    })).toBe('2 servers, 1 enabled, 4 auto tools');
    expect(translate('zh-CN', 'sidepanel.mcpPage.summary', {
      servers: 2,
      enabled: 1,
      tools: 4,
    })).toBe('2 个服务，1 个启用，4 个自动工具');
    expect(translate('en', 'sidepanel.mcpPage.messages.deleteConfirm', {
      name: 'Filesystem MCP',
    })).toBe('Delete MCP server "Filesystem MCP"?');
    expect(translate('zh-CN', 'sidepanel.mcpPage.messages.deleteConfirm', {
      name: 'Filesystem MCP',
    })).toBe('删除 MCP 服务「Filesystem MCP」？');
    expect(translate('en', 'sidepanel.automationPage.status.timeout')).toBe('Timed out');
    expect(translate('zh-CN', 'sidepanel.automationPage.status.timeout')).toBe('超时');
  });

  it('translates content/background injected surfaces', () => {
    // ⚠️ 样本必须取**生产在用的键** —— 原先这条用的是 `content.permission.webFetch`，
    // 而那个键只在测试里被引用（生产零引用），已随零引用清理删除。
    // 换成同段、同样带参数的生产在用键（工具面板块的标题带 `{count}`）。
    expect(translate('en', 'content.toolBlock.title', { count: 3 })).toBe('Tools called (3)');
    expect(translate('zh-CN', 'content.toolBlock.title', { count: 3 })).toBe('已调用工具（3 次）');
  });

  it('interpolates message parameters without swallowing missing placeholders', () => {
    expect(formatMessage('Hello {name}, count {count}, flag {flag}', {
      name: 'Zai++',
      count: 3,
      flag: false,
    })).toBe('Hello Zai++, count 3, flag false');

    expect(formatMessage('Hello {missing}')).toBe('Hello {missing}');
  });

  it('returns observable fallback metadata for unsupported locales', () => {
    const resolved = resolveMessage('fr-FR', 'app.tabs.library');

    expect(resolved).toEqual({
      value: '资料',
      locale: 'zh-CN',
      fallback: true,
    });
  });

  it('creates stable translators for repeated calls', () => {
    const translator = createTranslator('en');

    expect(translator.locale).toBe('en');
    expect(translator.fallback).toBe(false);
    expect(translator.t('app.tabs.library')).toBe('Library');
  });

  it('throws on missing keys instead of returning silent defaults', () => {
    expect(() => translate('en', 'missing.key' as never)).toThrow('Missing locale key "missing.key"');
  });
});

describe('i18n locale preference resolution', () => {
  it('normalizes invalid locale preferences to auto', () => {
    expect(normalizeLocalePreference('en')).toBe('en');
    expect(normalizeLocalePreference('zh-CN')).toBe('zh-CN');
    expect(normalizeLocalePreference('auto')).toBe('auto');
    expect(normalizeLocalePreference('fr-FR')).toBe('auto');
    expect(normalizeLocalePreference(null)).toBe('auto');
  });

  it('lets explicit locale preference override browser languages', () => {
    expect(resolveLocalePreference('en', ['zh-CN'])).toMatchObject({
      preference: 'en',
      locale: 'en',
      fallback: false,
    });

    expect(resolveLocalePreference('zh-CN', ['en-US'])).toMatchObject({
      preference: 'zh-CN',
      locale: 'zh-CN',
      fallback: false,
    });
  });

  it('resolves auto from browser language candidates', () => {
    expect(resolveLocalePreference('auto', ['fr-FR', 'en-US'])).toMatchObject({
      preference: 'auto',
      locale: 'en',
      fallback: false,
    });

    expect(resolveLocalePreference('auto', ['zh-Hans-CN', 'en-US'])).toMatchObject({
      preference: 'auto',
      locale: 'zh-CN',
      fallback: false,
    });
  });

  it('falls back to zh-CN when auto has no supported browser language', () => {
    expect(resolveLocalePreference('auto', ['fr-FR', 'ja-JP'])).toMatchObject({
      preference: 'auto',
      locale: 'zh-CN',
      fallback: true,
    });
  });
});

import type { LocaleMessages } from './zh-CN';
import { common } from './en/common';
import { app } from './en/app';
import { sidepanel } from './en/sidepanel';
import { content } from './en/content';
import { background } from './en/background';
import { tool } from './en/tool';
import { prompt } from './en/prompt';

export const en = {
  common,
  app,
  sidepanel,
  content,
  background,
  tool,
  prompt,
} as const satisfies LocaleMessages;

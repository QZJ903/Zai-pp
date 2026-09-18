import type { LocaleSchema } from '../types';
import { common } from './zh-CN/common';
import { app } from './zh-CN/app';
import { sidepanel } from './zh-CN/sidepanel';
import { content } from './zh-CN/content';
import { background } from './zh-CN/background';
import { tool } from './zh-CN/tool';
import { prompt } from './zh-CN/prompt';

export const zhCN = {
  common,
  app,
  sidepanel,
  content,
  background,
  tool,
  prompt,
} as const;

export type LocaleMessages = LocaleSchema<typeof zhCN>;

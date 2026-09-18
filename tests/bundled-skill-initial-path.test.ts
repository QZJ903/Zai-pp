import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllSkills,
  getSkillCollisionCandidates,
  getSkillLibrary,
} from '../core/skill/registry';

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('builtin Skill initial path', () => {
  it('loads only builtin Skills', async () => {
    const activeSkills = await getAllSkills();
    expect(activeSkills.map(({ name }) => name)).toEqual([
      'shell',
      'memory',
    ]);

    const collisionCandidates = await getSkillCollisionCandidates();
    expect(collisionCandidates.map(({ name }) => name)).toEqual(['shell', 'memory']);

    const library = await getSkillLibrary();
    expect(library.map(({ name }) => name)).toEqual([
      'shell',
      'memory',
    ]);
  });
});
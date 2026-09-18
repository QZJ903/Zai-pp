import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n';
import { parseSkillCommand } from '../skill/parser';
import { isLocalIndexInstructions, buildLocalExecutionBoundary } from '../skill/local-importer';
import { selectImplicitSkill, type LocalSkillIndex } from '../skill/local-skill-scorer';
import { absolutizeSkillReferences, joinUnderRoot } from '../skill/local-path-rewriter';
import type { Skill } from '../types';

export type AugmentationSkill =
  Pick<Skill, 'name' | 'instructions' | 'memoryEnabled'> &
  Partial<Pick<Skill, 'source' | 'description' | 'remote'>>;

export interface ResolvedSkills {
  combinedPrompt: string;
  memoryEnabled: boolean;
  skillName: string;
}

export function isLocalIndexSkill(skill: AugmentationSkill): boolean {
  return skill.remote?.provider === 'local' && isLocalIndexInstructions(skill.instructions);
}

export function composeLocalSkillPrompt(skill: AugmentationSkill): string {
  const skillDir = skill.remote?.localDirectory ?? '';
  let prompt = skill.instructions;
  if (skillDir) {
    const knownAbs = new Set<string>();
    const files = [
      ...(skill.remote?.includedFiles ?? []),
      ...(skill.remote?.scriptFiles ?? []),
      ...(skill.remote?.omittedFiles ?? []),
    ];
    for (const file of files) {
      const abs = joinUnderRoot(skillDir, file.path);
      if (abs) knownAbs.add(abs);
    }
    prompt = absolutizeSkillReferences(prompt, {
      skillDir,
      thisFileDir: skillDir,
      fileExists: (abs) => knownAbs.has(abs),
    });
    if (!prompt.includes('## Local Execution Boundary')) {
      prompt = `${prompt}\n\n---\n\n${buildLocalExecutionBoundary(skillDir)}`;
    }
  }
  return prompt;
}

export function buildLocalSkillSystemContext(
  resolved: ResolvedSkills,
  skillDir: string | undefined,
  locale: SupportedLocale,
): string {
  const skillMdPath = skillDir ? `${skillDir}/SKILL.md` : 'SKILL.md';
  const directive = translate(locale, 'prompt.localSkillActivationDirective', {
    skillName: resolved.skillName,
    skillMdPath,
  });
  return `${directive}\n\n${resolved.combinedPrompt}`;
}

export function selectImplicitLocalSkill(skills: AugmentationSkill[], query: string): AugmentationSkill | null {
  const localSkillsForProbe = skills.filter(isLocalIndexSkill);
  const candidates: LocalSkillIndex[] = localSkillsForProbe
    .map((s) => ({
      name: s.name,
      description: s.description ?? '',
      skillDir: s.remote?.localDirectory ?? '',
      instructions: s.instructions ?? '',
    }));
  const picked = selectImplicitSkill(query, candidates);
  if (!picked) return null;
  return skills.find(
    (s) => s.name === picked.name && (s.remote?.localDirectory ?? '') === picked.skillDir,
  ) ?? null;
}

export function resolveSkills(
  skills: AugmentationSkill[],
  skillName: string,
  args: string,
  locale: SupportedLocale,
): ResolvedSkills | null {
  const primarySkill = skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const primaryPrompt = composeResolvedInstructions(primarySkill);

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const userArgs = secondInvocation.args;
      const combinedInstructions = primaryPrompt + '\n\n---\n\n' + composeResolvedInstructions(secondSkill);
      return {
        combinedPrompt: userArgs
          ? wrapUserInput(combinedInstructions, userArgs, locale)
          : combinedInstructions,
        memoryEnabled: primarySkill.memoryEnabled || secondSkill.memoryEnabled,
        skillName: primarySkill.name,
      };
    }
  }

  return {
    combinedPrompt: args
      ? wrapUserInput(primaryPrompt, args, locale)
      : primaryPrompt,
    memoryEnabled: primarySkill.memoryEnabled,
    skillName: primarySkill.name,
  };
}

function composeResolvedInstructions(skill: AugmentationSkill): string {
  if (isLocalIndexSkill(skill)) return composeLocalSkillPrompt(skill);
  return skill.instructions;
}

export function wrapUserInput(
  instructions: string,
  userInput: string,
  locale: SupportedLocale,
): string {
  return translate(locale, 'prompt.skillUserInputWrapper', { instructions, userInput });
}

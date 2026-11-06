export interface RequestGenerationFence {
  begin(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

export function createRequestGenerationFence(): RequestGenerationFence {
  let currentGeneration = 0;
  return Object.freeze({
    begin() {
      currentGeneration += 1;
      return currentGeneration;
    },
    isCurrent(generation: number) {
      return generation === currentGeneration;
    },
    invalidate() {
      currentGeneration += 1;
    },
  });
}

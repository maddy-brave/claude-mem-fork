/**
 * Observation type recovery for the SDK parser.
 *
 * The observer model sometimes emits a type the mode never declared (a concept
 * keyword such as `gotcha`, or an ad-hoc label such as `finding` or
 * `milestone`), or omits the type altogether. The parser used to file the
 * first case under whatever the model wrote and the second under the first
 * declared type (`bugfix` in the bundled `code` mode), which mislabels memory
 * rows. These helpers map both cases onto a declared type when the evidence is
 * clear. They return `null` when it is not, so the caller keeps its previous
 * behavior for genuinely unknown input.
 *
 * Every result is a member of `validTypes`; nothing here invents a type the
 * active mode does not declare.
 */

/**
 * Single-word emitted-type labels and the declared type each one stands for.
 * Only labels seen in real observer output or unambiguous synonyms of a
 * declared type are listed. Anything else is left alone.
 */
const TYPE_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  // Knowledge about the existing system.
  finding: 'discovery',
  findings: 'discovery',
  gotcha: 'discovery',
  caveat: 'discovery',
  pitfall: 'discovery',
  insight: 'discovery',
  learning: 'discovery',
  lesson: 'discovery',
  fact: 'discovery',
  investigation: 'discovery',
  analysis: 'discovery',
  evidence: 'discovery',
  measurement: 'discovery',
  // Something was broken and is now fixed.
  bug: 'bugfix',
  bugs: 'bugfix',
  fix: 'bugfix',
  fixed: 'bugfix',
  fixes: 'bugfix',
  hotfix: 'bugfix',
  // Generic modification or work-completed records.
  changed: 'change',
  changes: 'change',
  update: 'change',
  updated: 'change',
  edit: 'change',
  edits: 'change',
  modification: 'change',
  implementation: 'change',
  milestone: 'change',
  progress: 'change',
  completed: 'change',
  // Design choices.
  decisions: 'decision',
  choice: 'decision',
  rationale: 'decision',
  // Restructuring.
  refactoring: 'refactor',
  cleanup: 'refactor',
  rename: 'refactor',
  // Capabilities.
  features: 'feature',
};

/**
 * Concept keywords of the bundled `code` mode and the type each one implies
 * when the model left the type out. Ordered: the first concept present wins,
 * most specific first.
 */
const CONCEPT_TYPE_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['problem-solution', 'bugfix'],
  ['trade-off', 'decision'],
  ['what-changed', 'change'],
  ['how-it-works', 'discovery'],
  ['why-it-exists', 'discovery'],
  ['gotcha', 'discovery'],
  ['pattern', 'discovery'],
];

/** Leading-verb cues on a title, for observations with no type and no concept hint. */
const TITLE_TYPE_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:fix(?:ed|es)?|resolv(?:e|ed|es)|repair(?:ed|s)?)\b/i, 'bugfix'],
  [/^(?:refactor(?:ed|s)?|renam(?:e|ed|es)|restructur(?:e|ed|es))\b/i, 'refactor'],
  [/^(?:decid(?:e|ed|es)|chose|choose|decision)\b/i, 'decision'],
  [/^(?:add(?:ed|s)?|implement(?:ed|s)?|introduc(?:e|ed|es))\b/i, 'feature'],
];

function normalizeEmittedType(emitted: string): string {
  return emitted
    .trim()
    .replace(/^[\[("'`\s]+|[\])"'`\s]+$/g, '')
    .toLowerCase();
}

function declaredIdFor(candidate: string, validTypes: readonly string[]): string | null {
  return validTypes.find(id => id.toLowerCase() === candidate) ?? null;
}

/**
 * Map an emitted type that is not an exact declared id onto a declared type.
 * Matches, in order: the id ignoring case, brackets, quotes and `-`/space
 * separators; then each word of the label against the declared ids; then each
 * word against {@link TYPE_TOKEN_ALIASES}. The first word that resolves wins.
 * Returns `null` when nothing resolves, so the caller can keep the emitted
 * value.
 */
export function resolveEmittedType(emitted: string, validTypes: readonly string[]): string | null {
  const normalized = normalizeEmittedType(emitted);
  if (normalized === '') return null;

  const whole = declaredIdFor(normalized, validTypes)
    ?? declaredIdFor(normalized.replace(/[\s-]+/g, '_'), validTypes);
  if (whole) return whole;

  const tokens = normalized.split(/[^a-z0-9]+/).filter(token => token !== '');
  for (const token of tokens) {
    const declared = declaredIdFor(token, validTypes);
    if (declared) return declared;
  }
  for (const token of tokens) {
    const alias = TYPE_TOKEN_ALIASES[token];
    if (!alias) continue;
    const declared = declaredIdFor(alias, validTypes);
    if (declared) return declared;
  }
  return null;
}

/**
 * Infer a declared type for an observation that carries none, from its
 * concepts first and its title second. Returns `null` when neither says
 * anything, so the caller can fall back to the mode default.
 */
export function inferTypeFromContent(
  content: { concepts: readonly string[]; title: string | null },
  validTypes: readonly string[],
): string | null {
  const concepts = new Set(content.concepts.map(concept => concept.trim().toLowerCase()));
  for (const [concept, type] of CONCEPT_TYPE_HINTS) {
    if (!concepts.has(concept)) continue;
    const declared = declaredIdFor(type, validTypes);
    if (declared) return declared;
  }

  const title = content.title?.trim() ?? '';
  if (title !== '') {
    for (const [pattern, type] of TITLE_TYPE_HINTS) {
      if (!pattern.test(title)) continue;
      const declared = declaredIdFor(type, validTypes);
      if (declared) return declared;
    }
  }
  return null;
}

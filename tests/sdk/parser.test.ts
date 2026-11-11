import { afterEach, beforeEach, describe, it, expect } from 'bun:test';

import { ModeManager } from '../../src/services/domain/ModeManager.js';

import { parseAgentXml } from '../../src/sdk/parser.js';

// Load the real bundled `code` mode rather than mocking ModeManager. The
// previous `mock.module(...)` replaced ModeManager process-globally and was
// never restored, so its partial stub (no `loadMode`) leaked into other test
// files in the same `bun test` run — notably the SDK integration tests, whose
// createCmemClient() calls `ModeManager.getInstance().loadMode('code')`. The
// real `code` mode is a superset of the types these tests exercise
// (bugfix / discovery / refactor), so the assertions below are unchanged.
ModeManager.getInstance().loadMode('code');

function expectObservation(raw: string) {
  const result = parseAgentXml(raw);
  if (!result.valid) throw new Error('expected valid observation, got invalid result');
  if (result.summary !== null) throw new Error('expected observation result, got a summary');
  return result.observations;
}

beforeEach(() => {
  const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
  modeManager.activeMode = {
    observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
    observation_concepts: [],
  };
});

afterEach(() => {
  const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
  modeManager.activeMode = null;
});

describe('parseAgentXml — observations', () => {
  it('treats a whitespace-padded standalone <skip_summary/> as a valid no-op with no observations', () => {
    const result = parseAgentXml('\n  <skip_summary reason="agent bookkeeping"/>  \n');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.observations).toEqual([]);
      expect(result.summary?.skipped).toBe(true);
      expect(result.summary?.skip_reason).toBe('agent bookkeeping');
    }
  });

  it('treats a fenced standalone <skip_summary/> as a valid no-op with no observations', () => {
    const result = parseAgentXml('```xml\n<skip_summary />\n```');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.observations).toEqual([]);
      expect(result.summary?.skipped).toBe(true);
    }
  });

  it('returns a populated observation when title is present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Found a bug in auth module</title>
      <narrative>The token refresh logic skips expired tokens.</narrative>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Found a bug in auth module');
    expect(result[0].type).toBe('discovery');
    expect(result[0].narrative).toBe('The token refresh logic skips expired tokens.');
  });

  it('unwraps a label-wrapped title echoed by a local observer (#3907)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>[**title**: Example observation]</title>
      <narrative>Some narrative.</narrative>
    </observation>`;

    const result = expectObservation(xml);

    expect(result[0].title).toBe('Example observation');
  });

  it('leaves bracketed and partially wrapped titles untouched (#3907)', () => {
    for (const title of ['[Example observation]', '**title**: Example', '[**title**: ]', '[**subtitle**: x]']) {
      const xml = `<observation>
        <type>discovery</type>
        <title>${title}</title>
        <narrative>Some narrative.</narrative>
      </observation>`;

      expect(expectObservation(xml)[0].title).toBe(title);
    }
  });

  it('returns a populated observation when only narrative is present (no title)', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <narrative>Patched the null pointer dereference in session handler.</narrative>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBeNull();
    expect(result[0].type).toBe('bugfix');
    expect(result[0].narrative).toBe('Patched the null pointer dereference in session handler.');
  });

  it('returns a populated observation when only facts are present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <facts><fact>File limit is hardcoded to 5</fact></facts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['File limit is hardcoded to 5']);
  });

  it('returns a populated observation when only concepts are present', () => {
    const xml = `<observation>
      <type>refactor</type>
      <concepts><concept>dependency-injection</concept></concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['dependency-injection']);
  });

  it('filters out ghost observations where all content fields are null (#1625)', () => {
    const xml = `<observation>
      <type>bugfix</type>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('filters out ghost observation with empty tags but no text content (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title></title>
      <narrative>   </narrative>
      <facts></facts>
      <concepts></concepts>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('salvages freeform prose inside a closed observation block', () => {
    const xml = `<observation>
      <type>discovery</type>
      Refactored transformer_markdown.py helpers and narrowed the shared formatting path.
      The follow-up kept the line-range handling aligned with the new helpers.
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('discovery');
    expect(result[0].title).toBe('Refactored transformer_markdown.py helpers and narrowed the shared formatting path.');
    expect(result[0].narrative).toContain('line-range handling aligned with the new helpers');
    expect(result[0].narrative).not.toContain('Refactored transformer_markdown.py helpers and narrowed the shared formatting path.');
  });

  it('keeps self-closing empty fields out of the prose salvage path', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title/>
      <narrative/>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('preserves overflow from a long first prose line in the narrative', () => {
    const longFirstLine = 'A'.repeat(140);
    const xml = `<observation>
      <type>discovery</type>
      ${longFirstLine}
      Follow-up detail stays in the narrative.
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe(`${'A'.repeat(117)}...`);
    expect(result[0].narrative).toContain('A'.repeat(23));
    expect(result[0].narrative).toContain('Follow-up detail stays in the narrative.');
  });

  it('keeps surrogate-pair characters intact when a long first prose line overflows', () => {
    const longFirstLine = `${'A'.repeat(116)}🧠${'B'.repeat(10)}`;
    const xml = `<observation>
      <type>discovery</type>
      ${longFirstLine}
      Follow-up detail stays in the narrative.
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe(`${'A'.repeat(116)}🧠...`);
    expect(result[0].title).not.toContain('�');
    expect(result[0].narrative).toContain('B'.repeat(10));
    expect(result[0].narrative).toContain('Follow-up detail stays in the narrative.');
    expect(result[0].narrative).not.toContain('�');
  });

  it('keeps grapheme clusters intact when a long first prose line overflows', () => {
    const cases = [
      { label: 'combining mark', cluster: 'e\u0301' },
      { label: 'zwj emoji', cluster: '👩‍💻' },
    ];

    for (const { label, cluster } of cases) {
      const longFirstLine = `${'A'.repeat(116)}${cluster}${'B'.repeat(10)}`;
      const xml = `<observation>
        <type>discovery</type>
        ${longFirstLine}
        Follow-up detail stays in the narrative.
      </observation>`;

      const result = expectObservation(xml);

      expect(result, label).toHaveLength(1);
      expect(result[0].title, label).toBe(`${'A'.repeat(116)}${cluster}...`);
      expect(result[0].narrative, label).toBe(`${'B'.repeat(10)}\nFollow-up detail stays in the narrative.`);
    }
  });

  it('filters out multiple ghost observations while keeping valid ones (#1625)', () => {
    const xml = `
      <observation><type>bugfix</type></observation>
      <observation>
        <type>discovery</type>
        <title>Real observation</title>
      </observation>
      <observation><type>refactor</type><title></title><narrative>  </narrative></observation>
    `;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real observation');
  });

  it('filters out observation with only a subtitle (excluded from survival criteria) (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <subtitle>Only a subtitle, no real content</subtitle>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('uses first mode type as fallback when type is missing', () => {
    const xml = `<observation>
      <title>Missing type field</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bugfix');
  });

  it('preserves a reporter-shaped unsupported observation type', () => {
    const xml = `<observation>
      <type>code</type>
      <title>Reporter-shaped unsupported type</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('code');
  });

  it('takes the re-opened type when a stray closing tag precedes it', () => {
    const xml = `<observation>
      <type>bugfix</parameter>
      <type>bugfix</type>
      <title>Stray closing tag inside type</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bugfix');
  });

  it('keeps the corrected type when the model re-opens type with a different value', () => {
    const xml = `<observation>
      <type>bugfix</reasoning_effort>
      <type>discovery</type>
      <title>Self-corrected type</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('discovery');
  });

  it('takes the restated type when the model restarts the observation mid-type', () => {
    const xml = `<observation>
      <type>refactor</reasoning_effort>
Oops, let me restate the output cleanly.

<observation>
      <type>refactor</type>
      <title>Restated observation</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('refactor');
    expect(result[0].title).toBe('Restated observation');
  });

  it('never stores markup as the type when the value itself carries a stray tag', () => {
    const xml = `<observation>
      <type>discovery</parameter></type>
      <title>Stray tag before the real close</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('discovery');
  });

  it('falls back to the first mode type when the type is only encoded whitespace', () => {
    const xml = `<observation>
      <type>&#32;</type>
      <title>Encoded whitespace type</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('bugfix');
  });

  it('returns a fail-fast result when no observation/summary blocks are present', () => {
    const result = parseAgentXml('Some text without any observations.');
    expect(result.valid).toBe(false);
  });

  it('parses files_read and files_modified arrays correctly', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>File read tracking</title>
      <files_read><file>src/utils.ts</file><file>src/parser.ts</file></files_read>
      <files_modified><file>src/utils.ts</file></files_modified>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].files_read).toEqual(['src/utils.ts', 'src/parser.ts']);
    expect(result[0].files_modified).toEqual(['src/utils.ts']);
  });
});

describe('parseAgentXml — fence tolerance (#2233 Part A)', () => {
  it('parses plain XML input correctly (no fence)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Plain XML input</title>
      <narrative>No fence wrapper present.</narrative>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Plain XML input');
  });

  it('parses fenced XML with language tag (```xml ... ```)', () => {
    const xml = '```xml\n<observation>\n  <type>discovery</type>\n  <title>Fenced with lang</title>\n  <narrative>Wrapped in xml-tagged code fence.</narrative>\n</observation>\n```';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Fenced with lang');
    expect(result.observations[0].narrative).toBe('Wrapped in xml-tagged code fence.');
  });

  it('parses fenced XML without language tag (``` ... ```)', () => {
    const xml = '```\n<observation>\n  <type>bugfix</type>\n  <title>Bare fence</title>\n  <narrative>Wrapped in language-less fence.</narrative>\n</observation>\n```';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Bare fence');
    expect(result.observations[0].narrative).toBe('Wrapped in language-less fence.');
  });

  it('does not falsely strip when XML appears mid-text without fences', () => {
    const xml = `Some intro prose.
<observation>
  <type>refactor</type>
  <title>Mid-text observation</title>
  <narrative>No fences anywhere in the input.</narrative>
</observation>
Trailing prose.`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Mid-text observation');
    expect(result.observations[0].narrative).toBe('No fences anywhere in the input.');
  });

  it('does not strip inner triple-backtick lines when payload is not a full fenced wrapper', () => {
    // Regression for CodeRabbit review on PR #2282: stripCodeFences() used to
    // greedily remove the first ``` and last ``` anywhere in the input, which
    // could mangle content that contains internal fenced examples or surrounds
    // the XML with prose. The fence-stripper must only fire when the entire
    // payload is a single fenced block.
    const xml = 'Lead-in text with ```inline``` markers.\n' +
      '<observation>\n' +
      '  <type>discovery</type>\n' +
      '  <title>Body with ``` inside narrative</title>\n' +
      '  <narrative>Snippet: ```\nfoo\n``` end of snippet.</narrative>\n' +
      '</observation>\n' +
      'Trailing ``` prose with another ``` mark.';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Body with ``` inside narrative');
    // Narrative should still contain the inner ``` markers — i.e. the
    // stripper did not eat them.
    expect(result.observations[0].narrative).toContain('```');
  });
});

describe('parseAgentXml — concept normalization (#3379)', () => {
  it('truncates a prefixed concept at the first colon', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Prefixed concept tag</title>
      <concepts><concept>gotcha: some long description</concept></concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['gotcha']);
  });

  it('leaves a bare concept unchanged', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Bare concept tag</title>
      <concepts><concept>gotcha</concept></concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['gotcha']);
  });

  it('still drops a concept equal to the observation type, bare or prefixed', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Type echoed as concept</title>
      <concepts>
        <concept>discovery</concept>
        <concept>discovery: echoed with a description</concept>
        <concept>pattern</concept>
      </concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['pattern']);
  });

  it('drops concepts that become empty after truncation', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Leading-colon concept</title>
      <concepts><concept>: only a description</concept></concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual([]);
  });
});

// #3592: the active mode's `observation_types` enum is advisory — it is rendered
// into the observer's prompt but never enforced at the parse site. These pin the
// two branches as they behave today, so that whichever way the enum is eventually
// enforced, the change is visible in the diff rather than silent.
describe('parseAgentXml — observation type against the mode enum', () => {
  it('preserves a type that is outside the enum', () => {
    const xml = `<observation>
      <type>sample-gate</type>
      <title>Type the mode never declared</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('sample-gate');
  });

  it('falls back to the first declared type when <type> is absent', () => {
    const xml = `<observation>
      <title>No type element at all</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    // Positional, not neutral: the fallback is observation_types[0], which in the
    // bundled `code` mode is `bugfix`. An untyped observation is therefore filed
    // as a bug fix rather than as unclassified.
    expect(result[0].type).toBe('bugfix');
  });

  it('follows the enum order rather than any fixed default', () => {
    const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
    modeManager.activeMode = {
      observation_types: [{ id: 'refactor' }, { id: 'bugfix' }, { id: 'discovery' }],
      observation_concepts: [],
    };

    const xml = `<observation>
      <title>No type, reordered enum</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('refactor');
  });
});

// F10 / F10b: the live observer closes `<type>` with a stray tag and never writes
// `</type>`, emits concept keywords such as `gotcha` as the type, and sometimes
// omits the type. Recovered types must always be members of the active mode.
describe('parseAgentXml — type recovery (F10, F10b)', () => {
  function useMode(ids: string[]) {
    const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
    modeManager.activeMode = {
      observation_types: ids.map(id => ({ id })),
      observation_concepts: [],
    };
  }

  const codeModeTypes = [
    'bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision',
    'security_alert', 'security_note', 'sensitive',
  ];

  it('reads the type when a stray parameter tag closes it and no </type> exists', () => {
    const xml = `<observation>
  <type>discovery</parameter>
  <title>Blob and Data Lake REST operations mapped to billing categories</title>
</observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('discovery');
  });

  it('reads the type when a stray reasoning_effort tag closes it and no </type> exists', () => {
    const xml = `<observation>
  <type>bugfix</reasoning_effort>
  <title>Stray reasoning_effort closer</title>
</observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('bugfix');
  });

  it('reads an unclosed type that runs straight into the next tag', () => {
    const xml = `<observation>
  <type>refactor
  <title>Type never closed</title>
</observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('refactor');
  });

  it('recovers the malformed type of a later observation in a multi-observation reply', () => {
    const xml = `<observation>
  <type>discovery</type>
  <title>First, well formed</title>
</observation>
<observation>
  <type>discovery</parameter>
  <title>Second, stray closer</title>
</observation>
<observation>
  <type>discovery</type>
  <title>Third, well formed</title>
</observation>`;

    const result = expectObservation(xml);

    expect(result.map(o => o.type)).toEqual(['discovery', 'discovery', 'discovery']);
  });

  it('does not treat a long unclosed run of prose as a type', () => {
    const xml = `<observation>
  <type>${'this is a whole sentence the model wrote into the type slot by mistake '.repeat(3)}
  <title>Runaway type</title>
</observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('bugfix');
  });

  it('maps the concept keyword gotcha to discovery and keeps it as a concept', () => {
    const xml = `<observation>
  <type>gotcha</type>
  <title>Rehearsal crons only fire after merge</title>
  <concepts><concept>gotcha</concept><concept>trade-off</concept></concepts>
</observation>`;

    const result = expectObservation(xml);

    expect(result[0].type).toBe('discovery');
    expect(result[0].concepts).toEqual(['gotcha', 'trade-off']);
  });

  it('maps an undeclared finding label to discovery', () => {
    const xml = `<observation>
  <type>finding</type>
  <title>Undeclared label</title>
</observation>`;

    expect(expectObservation(xml)[0].type).toBe('discovery');
  });

  it('maps milestone and what-changed to change when the mode declares change', () => {
    useMode(codeModeTypes);
    const milestone = `<observation><type>milestone</type><title>Phase closed</title></observation>`;
    const whatChanged = `<observation><type>what-changed</type><title>Edited the ledger</title></observation>`;

    expect(expectObservation(milestone)[0].type).toBe('change');
    expect(expectObservation(whatChanged)[0].type).toBe('change');
  });

  it('keeps an undeclared label when the mapped type is not in the active mode', () => {
    // The fixture mode (bugfix, discovery, refactor) has no `change`.
    const xml = `<observation><type>milestone</type><title>Phase closed</title></observation>`;

    expect(expectObservation(xml)[0].type).toBe('milestone');
  });

  it('normalizes the case of a declared type', () => {
    const xml = `<observation><type> Discovery </type><title>Cased type</title></observation>`;

    expect(expectObservation(xml)[0].type).toBe('discovery');
  });

  it('infers the type from the concepts when the type is absent', () => {
    useMode(codeModeTypes);
    const xml = `<observation>
  <title>Concept-led observation</title>
  <concepts><concept>how-it-works</concept><concept>what-changed</concept></concepts>
</observation>`;

    expect(expectObservation(xml)[0].type).toBe('change');
  });

  it('infers bugfix from problem-solution and decision from trade-off', () => {
    useMode(codeModeTypes);
    const problemSolution = `<observation><title>Concept led</title><concepts><concept>problem-solution</concept></concepts></observation>`;
    const tradeOff = `<observation><title>Concept led</title><concepts><concept>trade-off</concept></concepts></observation>`;

    expect(expectObservation(problemSolution)[0].type).toBe('bugfix');
    expect(expectObservation(tradeOff)[0].type).toBe('decision');
  });

  it('infers the type from the title when the type and concepts are absent', () => {
    useMode(codeModeTypes);
    const xml = `<observation><title>Added a retry to the spool drain</title></observation>`;

    expect(expectObservation(xml)[0].type).toBe('feature');
  });

  it('falls back to the first declared type when nothing indicates a type', () => {
    useMode(codeModeTypes);
    const xml = `<observation>
  <title>Blob and Data Lake REST operations mapped to billing categories</title>
  <facts><fact>Get Blob is a Read operation</fact></facts>
</observation>`;

    expect(expectObservation(xml)[0].type).toBe('bugfix');
  });

  it('never returns an inferred type the mode does not declare', () => {
    // Fixture mode has no `decision`, so trade-off must not produce one.
    const xml = `<observation><title>Concept led</title><concepts><concept>trade-off</concept></concepts></observation>`;

    expect(expectObservation(xml)[0].type).toBe('bugfix');
  });
});

// #4098: local models that emit capitalized XML wrapper tags (e.g. `<Concepts>`,
// `<Files_read>`) silently lose facts/concepts/files because every tag regex in
// the parser was built without the `i` flag. Each case below isolates exactly
// one regex site by capitalizing only the tag(s) that regex matches, leaving
// every other tag in the fixture at whatever casing already passes today — so
// no case can pass by riding on a different, unrelated flag.
describe('parseAgentXml — tag casing (#4098)', () => {
  it('populates all four arrays from capitalized wrapper tags only', () => {
    // Only the array-wrapper tags are capitalized. Outer <observation> and every
    // leaf (<fact>, <concept>, <file>) stay lowercase.
    const xml = `<observation><type>discovery</type><title>t</title><Facts><fact>f1</fact></Facts><narrative>n</narrative><Concepts><concept>gotcha</concept></Concepts><Files_read><file>a.ts</file></Files_read><Files_modified><file>b.ts</file></Files_modified></observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['f1']);
    expect(result[0].concepts).toEqual(['gotcha']);
    expect(result[0].files_read).toEqual(['a.ts']);
    expect(result[0].files_modified).toEqual(['b.ts']);
  });

  it('parses a capitalized <Observation> root wrapper', () => {
    // Only the outer <Observation>/</Observation> tag is capitalized. Every
    // wrapper and leaf tag inside stays lowercase (today's already-passing
    // shape), isolating the block regex distinct from root detection (which
    // already has `i` and is unchanged).
    const xml = `<Observation><type>discovery</type><title>t</title><facts><fact>f1</fact></facts><narrative>n</narrative><concepts><concept>c1</concept></concepts><files_read><file>a.ts</file></files_read><files_modified><file>b.ts</file></files_modified></Observation>`;

    const result = parseAgentXml(xml);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].facts).toEqual(['f1']);
    expect(result.observations[0].concepts).toEqual(['c1']);
    expect(result.observations[0].files_read).toEqual(['a.ts']);
    expect(result.observations[0].files_modified).toEqual(['b.ts']);
  });

  it('populates arrays from capitalized leaf element tags only', () => {
    // Outer <observation> and the array-wrapper tags stay lowercase; only the
    // leaf element tags (<Fact>, <Concept>, <File>) are capitalized.
    const xml = `<observation><type>discovery</type><title>t</title><facts><Fact>f1</Fact></facts><narrative>n</narrative><concepts><Concept>c1</Concept></concepts><files_read><File>a.ts</File></files_read><files_modified><File>b.ts</File></files_modified></observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['f1']);
    expect(result[0].concepts).toEqual(['c1']);
    expect(result[0].files_read).toEqual(['a.ts']);
    expect(result[0].files_modified).toEqual(['b.ts']);
  });

  it('parses the reporter\'s raw model output tail (#4098)', () => {
    const xml = `<observation><type>discovery</type><title>Reporter-shaped output</title><narrative>n</narrative><Concepts><concept>security_note</concept><concept>gotcha</concept></Concepts><Files_read><file>terraform/task_definition</file></Files_read><Files_modified><file>issues/418</file></Files_modified></observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['security_note', 'gotcha']);
    expect(result[0].files_read).toEqual(['terraform/task_definition']);
    expect(result[0].files_modified).toEqual(['issues/418']);
  });

  it('parses a capitalized <Summary> with mixed-case children', () => {
    // Outer <Summary> capitalized isolates the summary-block regex; <Request>
    // capitalized vs. <learned> lowercase isolates the shared extractField
    // regex used by both observation and summary fields.
    const xml = `<Summary><Request>r</Request><learned>l</learned></Summary>`;

    const result = parseAgentXml(xml);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.summary?.request).toBe('r');
    expect(result.summary?.learned).toBe('l');
  });

  it('parses a capitalized <Skip_summary> as skipped', () => {
    const xml = `<Skip_summary reason="x"/>`;

    const result = parseAgentXml(xml);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.summary?.skipped).toBe(true);
    expect(result.summary?.skip_reason).toBe('x');
  });

  it('does not leak a capitalized field\'s text into prose salvage', () => {
    // Only <Type> is capitalized; title/narrative/facts/concepts are all
    // genuinely empty, so parsing should fall into the prose-salvage path.
    // Before the fix, the salvage regex's case-sensitive alternation left
    // <Type>bugfix</Type>'s content behind for the generic tag stripper,
    // producing a spurious observation titled "bugfix". The lowercase
    // equivalent already drops this as an empty observation (see "keeps
    // self-closing empty fields out of the prose salvage path" above); the
    // capitalized form must match that behavior.
    const xml = `<observation><Type>bugfix</Type><title></title><narrative></narrative></observation>`;

    const result = parseAgentXml(xml);

    expect(result.valid).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, buildBatchedObservationPrompt, buildInitPrompt, buildContinuationPrompt } from '../../src/sdk/prompts.js';
import type { ModeConfig } from '../../src/services/domain/types.js';

// Minimal stub covering only the keys interpolated by buildInitPrompt and
// buildContinuationPrompt. Missing keys render as "undefined" in template
// literals — fine for these guard-text assertions.
const stubMode: ModeConfig = {
  name: 'test',
  description: 'test mode',
  version: '0.0.0',
  observation_types: [{ id: 'T1', label: 'T1', description: '', emoji: '', work_emoji: '' }],
  observation_concepts: [],
  prompts: {
    system_identity: 'SYSTEM_IDENTITY',
    spatial_awareness: 'SPATIAL_AWARENESS',
    observer_role: 'OBSERVER_ROLE',
    recording_focus: 'RECORDING_FOCUS',
    skip_guidance: 'SKIP_GUIDANCE',
    type_guidance: 'TYPE_GUIDANCE',
    concept_guidance: 'CONCEPT_GUIDANCE',
    field_guidance: 'FIELD_GUIDANCE',
    output_format_header: 'OUTPUT_FORMAT_HEADER',
    format_examples: 'FORMAT_EXAMPLES',
    footer: 'FOOTER',
    xml_title_placeholder: 'TITLE',
    xml_subtitle_placeholder: 'SUBTITLE',
    xml_fact_placeholder: 'FACT',
    xml_narrative_placeholder: 'NARRATIVE',
    xml_concept_placeholder: 'CONCEPT',
    xml_file_placeholder: 'FILE',
    xml_summary_request_placeholder: '',
    xml_summary_investigated_placeholder: '',
    xml_summary_learned_placeholder: '',
    xml_summary_completed_placeholder: '',
    xml_summary_next_steps_placeholder: '',
    xml_summary_notes_placeholder: '',
    header_memory_start: 'HEADER_MEMORY_START',
    header_memory_continued: 'HEADER_MEMORY_CONTINUED',
    header_summary_checkpoint: '',
    continuation_greeting: 'CONTINUATION_GREETING',
    continuation_instruction: 'CONTINUATION_INSTRUCTION',
    summary_instruction: '',
    summary_context_label: '',
    summary_format_instruction: '',
    summary_footer: '',
  },
};

describe('buildObservationPrompt', () => {
  it('instructs the observer to avoid prose skip responses', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or an empty response');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });
});

// D4 (observer batch/throttle) — coalesce N buffered tool-use events into a
// single observer turn (arm1-claude-mem-observer.md ranked fix #3). See
// ClaudeProvider.createMessageGenerator: batchSize=1 always routes through
// buildObservationPrompt (unchanged), so buildBatchedObservationPrompt only
// needs to prove correct behavior for batch.length > 1.
describe('buildBatchedObservationPrompt (D4 observer batch/throttle)', () => {
  const makeObs = (n: number) => ({
    id: n,
    tool_name: `Tool${n}`,
    tool_input: JSON.stringify({ arg: n }),
    tool_output: JSON.stringify({ result: n }),
    created_at_epoch: Date.now(),
    cwd: `/repo${n}`,
  });

  it('emits one <observed_from_primary_session> block per event', () => {
    const prompt = buildBatchedObservationPrompt([makeObs(1), makeObs(2), makeObs(3)]);

    const blockCount = (prompt.match(/<observed_from_primary_session>/g) ?? []).length;
    expect(blockCount).toBe(3);
    expect(prompt).toContain('<what_happened>Tool1</what_happened>');
    expect(prompt).toContain('<what_happened>Tool2</what_happened>');
    expect(prompt).toContain('<what_happened>Tool3</what_happened>');
  });

  it('emits the XML-only guard footer exactly once regardless of batch size', () => {
    const prompt = buildBatchedObservationPrompt([makeObs(1), makeObs(2), makeObs(3), makeObs(4)]);

    const footerCount = (prompt.match(/Non-XML text is discarded\./g) ?? []).length;
    expect(footerCount).toBe(1);
    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks');
  });

  it('notes the event count for multi-event batches, omits it for a single event', () => {
    const multi = buildBatchedObservationPrompt([makeObs(1), makeObs(2)]);
    expect(multi).toContain('The 2 tool-use events above happened in order');

    const single = buildBatchedObservationPrompt([makeObs(1)]);
    expect(single).not.toContain('tool-use events above happened in order');
  });

  it('still elides an oversized field per event (#2468 truncation applies per-event)', () => {
    const huge = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
    const obsWithHugeOutput = {
      id: 9,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file: 'big.txt' }),
      tool_output: JSON.stringify({ content: huge }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    };
    const prompt = buildBatchedObservationPrompt([makeObs(1), obsWithHugeOutput]);

    expect(prompt).toContain('<elided');
    expect(prompt).toContain('reason="oversize"');
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
  });
});

describe('buildInitPrompt XML-only guard (poison-loop fix)', () => {
  it('contains the XML-only-or-empty guard text', () => {
    const prompt = buildInitPrompt('proj', 'sess-1', 'do some work', stubMode);
    expect(prompt).toContain('Non-XML text is discarded');
    expect(prompt).toContain('empty response');
  });

  it('guard warns against prose such as "No observations to record"', () => {
    const prompt = buildInitPrompt('proj', 'sess-1', 'do some work', stubMode);
    expect(prompt).toContain('No observations to record');
  });
});

describe('buildContinuationPrompt XML-only guard (poison-loop fix)', () => {
  it('contains the XML-only-or-empty guard text', () => {
    const prompt = buildContinuationPrompt('do more work', 2, 'sess-1', stubMode);
    expect(prompt).toContain('Non-XML text is discarded');
    expect(prompt).toContain('empty response');
  });

  it('guard warns against prose such as "No observations to record"', () => {
    const prompt = buildContinuationPrompt('do more work', 2, 'sess-1', stubMode);
    expect(prompt).toContain('No observations to record');
  });
});

describe('buildObservationPrompt oversized field truncation (#2468)', () => {
  it('truncates an oversized outcome field with an elided marker, keeping head and tail', () => {
    const huge = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file: 'big.txt' }),
      tool_output: JSON.stringify({ content: huge }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('<elided');
    expect(prompt).toContain('reason="oversize"');
    // head and tail of the raw value are preserved
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
    // the oversized field is actually shrunk well below its raw 60k size
    expect(prompt.length).toBeLessThan(40_000);
  });

  it('leaves a small field untouched (no elided marker)', () => {
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // The prompt always carries a static "<elided chars=... />" instruction line,
    // so assert on the actual truncation marker (reason="oversize") instead.
    expect(prompt).not.toContain('reason="oversize"');
  });
});

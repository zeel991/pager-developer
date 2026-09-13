import { describe, expect, it } from 'vitest';
import { toBlocks, toRichText } from '../src/notion/notion-provider.js';

/**
 * A postmortem is mostly headings and lists. Notion has block types for both, and
 * a page that renders them as undifferentiated paragraphs is the difference
 * between a document a team reads and one they scroll past.
 */
describe('toBlocks', () => {
  const typesOf = (md: string) => toBlocks(md).map((b) => (b as { type: string }).type);

  it('maps heading levels to their own block types', () => {
    expect(typesOf('# One\n\n## Two\n\n### Three')).toEqual(['heading_1', 'heading_2', 'heading_3']);
  });

  it('renders a run of dashes as list items, one block each', () => {
    const blocks = toBlocks('- first\n- second\n- third');
    expect(typesOf('- first\n- second\n- third')).toEqual(
      Array(3).fill('bulleted_list_item'),
    );
    const first = blocks[0] as { bulleted_list_item: { rich_text: { text: { content: string } }[] } };
    // The marker itself is structure, not content.
    expect(first.bulleted_list_item.rich_text[0]!.text.content).toBe('first');
  });

  it('leaves prose containing a dash alone', () => {
    expect(typesOf('We saw 500s - then they stopped.')).toEqual(['paragraph']);
  });

  it('splits a block past Notion’s text limit rather than losing the tail', () => {
    const long = 'x'.repeat(2500);
    const blocks = toBlocks(long);
    expect(blocks.length).toBeGreaterThan(1);
    const joined = blocks
      .map((b) => (b as { paragraph: { rich_text: { text: { content: string } }[] } }).paragraph.rich_text[0]!.text.content)
      .join('');
    expect(joined).toBe(long);
  });

  it('drops blank stretches instead of emitting empty blocks', () => {
    expect(toBlocks('one\n\n\n\n\ntwo')).toHaveLength(2);
  });
});

/**
 * Notion renders a text node literally. The write-up contains bold verdicts, an
 * inline-code root cause and a markdown link to the pull request, so each has to
 * be built as an annotated span rather than handed over as markup.
 */
describe('toRichText', () => {
  const spans = (md: string) =>
    toRichText(md).map((s) => {
      const t = s as { text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> };
      return [t.text.content, t.annotations?.bold ? 'b' : t.annotations?.code ? 'c' : t.text.link ? t.text.link.url : ''];
    });

  it('turns ** into a bold span, not asterisks on screen', () => {
    expect(spans('**RECOVERED** — signals are back')).toEqual([
      ['RECOVERED', 'b'],
      [' — signals are back', ''],
    ]);
  });

  it('turns a markdown link into a real link', () => {
    expect(spans('See [#12](https://example.com/12) for the fix')).toEqual([
      ['See ', ''],
      ['#12', 'https://example.com/12'],
      [' for the fix', ''],
    ]);
  });

  it('marks inline code', () => {
    expect(spans('`rateFor()` returned undefined')).toEqual([
      ['rateFor()', 'c'],
      [' returned undefined', ''],
    ]);
  });

  it('leaves plain prose as a single span', () => {
    expect(spans('nothing special here')).toEqual([['nothing special here', '']]);
  });

  it('never emits an empty span', () => {
    expect(toRichText('**bold**')).toHaveLength(1);
  });
});

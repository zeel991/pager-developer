import { describe, expect, it } from 'vitest';
import { toBlocks } from '../src/notion/notion-provider.js';

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

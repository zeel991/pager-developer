import { Http } from '../http.js';
import type {
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeSearchResult,
} from '../types.js';

/**
 * Notion adapter.
 *
 * Used for runbooks and service documentation during an investigation, and for
 * writing incident postmortems afterwards.
 *
 * Notion is not a document store with a `content` field — a page is a tree of typed
 * blocks, and its title lives in a property whose *name* varies by database. Both are
 * handled here so callers deal in plain text:
 *
 *  - Reading a page means paginating its children and rendering each block. Blocks we
 *    do not render (images, embeds, databases) are reported as a placeholder line
 *    rather than dropped silently, so an investigation can tell that a runbook had
 *    content it could not read.
 *  - Notion requires an explicit API version header; omitting it fails at runtime
 *    rather than at build time.
 */

const NOTION_VERSION = '2022-06-28';

/** Notion's block content cap. Longer text must be split across blocks. */
const MAX_BLOCK_TEXT = 2000;

interface RichText {
  type?: string;
  plain_text?: string;
  text?: { content?: string };
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
  parent?: { type?: string; page_id?: string; database_id?: string };
}

function plain(rich: RichText[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
}

/**
 * A page's title lives in whichever property has type `title`. Its name is `title`
 * on a standalone page but arbitrary inside a database ("Name", "Runbook", …), so
 * the property is found by type rather than by key.
 */
export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title') return plain(prop.title);
  }
  return 'Untitled';
}

/** Render one block as a line of text. */
export function renderBlock(block: NotionBlock): string {
  const body = block[block.type] as { rich_text?: RichText[]; checked?: boolean; language?: string } | undefined;
  const text = plain(body?.rich_text);

  switch (block.type) {
    case 'paragraph':
      return text;
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${body?.checked ? 'x' : ' '}] ${text}`;
    case 'code':
      return `\`\`\`${body?.language ?? ''}\n${text}\n\`\`\``;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'divider':
      return '---';
    default:
      // Not dropped: an investigation must be able to tell that the runbook
      // contained something this adapter could not read.
      return text || `[unrendered ${block.type} block]`;
  }
}

/** Split plain text into Notion paragraph blocks, respecting the length cap. */
export function toBlocks(content: string): unknown[] {
  const blocks: unknown[] = [];
  for (const paragraph of content.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // A run of "- " lines is a list, not a paragraph that happens to contain
    // newlines. Notion has a block type for this; collapsing it into one
    // paragraph renders the whole thing as a single grey slab and loses the
    // per-item structure that made it a list in the source.
    const lines = trimmed.split('\n');
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      for (const line of lines) {
        blocks.push(
          ...chunked(line.trim().replace(/^[-*]\s+/, ''), (chunk) => ({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: toRichText(chunk) },
          })),
        );
      }
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push({
        object: 'block',
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: toRichText(heading[2]!.slice(0, MAX_BLOCK_TEXT)) },
      });
      continue;
    }

    blocks.push(
      ...chunked(trimmed, (chunk) => ({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: toRichText(chunk) },
      })),
    );
  }
  return blocks;
}

/**
 * Inline markdown to Notion rich text.
 *
 * Notion does not parse markup inside a text node: a block whose content is the
 * string "**UNVERIFIABLE**" renders with the asterisks showing, and a markdown
 * link renders as literal brackets. Both appear in the incident write-up, so the
 * emphasis and the link to the pull request have to be built as annotated spans.
 *
 * Deliberately limited to bold, inline code and links — the three the write-up
 * actually uses. A fuller markdown parser would be more surface than this needs.
 */
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

export function toRichText(text: string): unknown[] {
  const out: unknown[] = [];
  const push = (content: string, annotations?: Record<string, boolean>, link?: string) => {
    if (content === '') return;
    out.push({
      type: 'text',
      text: { content, ...(link ? { link: { url: link } } : {}) },
      ...(annotations ? { annotations } : {}),
    });
  };

  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], undefined, m[2]);
    else if (m[3] !== undefined) push(m[3], { bold: true });
    else if (m[4] !== undefined) push(m[4], { code: true });
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out.length > 0 ? out : [{ type: 'text', text: { content: text } }];
}

/** Split text that exceeds Notion's per-block limit across several blocks. */
function chunked(text: string, make: (chunk: string) => unknown): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += MAX_BLOCK_TEXT) out.push(make(text.slice(i, i + MAX_BLOCK_TEXT)));
  return out;
}

export interface NotionProviderOptions {
  baseUrl?: string;
  token?: string;
  /** Default parent for created pages, e.g. an incident postmortem database. */
  parentPageId?: string;
  parentDatabaseId?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class NotionProvider implements KnowledgeProvider {
  readonly kind = 'knowledge' as const;
  private readonly http: Http;

  constructor(private readonly opts: NotionProviderOptions) {
    this.http = new Http({
      baseUrl: opts.baseUrl ?? 'https://api.notion.com',
      headers: {
        'notion-version': NOTION_VERSION,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async search(query: string, limit = 10): Promise<KnowledgeSearchResult[]> {
    const res = await this.http.post<{ results?: NotionPage[] }>('/v1/search', {
      query,
      page_size: limit,
      filter: { property: 'object', value: 'page' },
    });
    return (res.results ?? []).slice(0, limit).map((page) => ({
      id: page.id,
      title: pageTitle(page),
      url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
      // Notion search returns no snippet, so the title is the honest excerpt.
      // Fabricating one by fetching and truncating every result would cost a
      // request per hit for a guess at relevance.
      excerpt: pageTitle(page),
    }));
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    const page = await this.http.getOptional<NotionPage>(`/v1/pages/${id}`);
    if (!page) return null;

    const lines: string[] = [];
    let cursor: string | undefined;
    // Children are paginated; a long runbook silently truncated at 100 blocks
    // would be worse than useless during an incident.
    do {
      const res = await this.http.get<{ results?: NotionBlock[]; next_cursor?: string | null; has_more?: boolean }>(
        `/v1/blocks/${id}/children`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      for (const block of res.results ?? []) lines.push(renderBlock(block));
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);

    return {
      id: page.id,
      title: pageTitle(page),
      url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
      content: lines.join('\n'),
    };
  }

  async createDocument(input: { title: string; content: string; parentId?: string }): Promise<KnowledgeDocument> {
    const parentId = input.parentId ?? this.opts.parentPageId ?? this.opts.parentDatabaseId;
    if (!parentId) {
      throw new Error(
        'NotionProvider.createDocument needs a parent: pass parentId, or configure ' +
          'parentPageId / parentDatabaseId. Notion cannot create an orphan page.',
      );
    }
    const isDatabase = Boolean(input.parentId ? false : this.opts.parentDatabaseId && !this.opts.parentPageId);

    const res = await this.http.post<NotionPage>('/v1/pages', {
      parent: isDatabase ? { database_id: parentId } : { page_id: parentId },
      properties: {
        title: { title: [{ type: 'text', text: { content: input.title } }] },
      },
      children: toBlocks(input.content),
    });

    return {
      id: res.id,
      title: input.title,
      url: res.url ?? `https://notion.so/${res.id.replace(/-/g, '')}`,
      content: input.content,
    };
  }
}

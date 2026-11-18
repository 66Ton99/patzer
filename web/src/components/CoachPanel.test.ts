import { describe, it, expect } from 'vitest';
import { parseSseBlock } from './CoachPanel';

// The panel used to append every `data:` line to the coach's text, whatever
// the event — an error message showed up as coaching, and the new `actions`
// event (JSON) would have too.

describe('parseSseBlock', () => {
  it('reads a plain text chunk and keeps its leading space', () => {
    expect(parseSseBlock('data:  knight')).toEqual({ event: 'message', data: ' knight' });
  });

  it('joins multi-line data with newlines, as the SSE spec says', () => {
    expect(parseSseBlock('data: First line.\ndata: Second line.')).toEqual({ event: 'message', data: 'First line.\nSecond line.' });
  });

  it('keeps named events apart from the text', () => {
    const actions = parseSseBlock('event: actions\ndata: [{"kind":"train"}]');
    expect(actions).toEqual({ event: 'actions', data: '[{"kind":"train"}]' });
    expect(parseSseBlock('event: error\ndata: llm_http_500').event).toBe('error');
    expect(parseSseBlock('event: done\ndata: ').event).toBe('done');
    expect(parseSseBlock('event: ping\ndata: ').event).toBe('ping');
  });
});

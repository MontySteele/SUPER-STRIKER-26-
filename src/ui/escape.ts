// Player names are user-editable (roster editor) and several UI panels build
// HTML strings — every name must pass through here before hitting innerHTML.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;'
    : c === '"' ? '&quot;' : '&#39;'
  ));
}

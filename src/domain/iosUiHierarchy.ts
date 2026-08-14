import type { UiBounds, UiElementNode, UiHierarchy } from './androidUiHierarchy';

const EMPTY_BOUNDS: UiBounds = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  centerX: 0,
  centerY: 0,
};

const CLICKABLE_TYPES = /Button|Cell|Switch|Link|Icon|Tab|Alert/u;

export function parseWdaSourceXml(xml: string, capturedAt = Date.now()): UiHierarchy {
  const body = unwrapSourceXml(xml);
  const nodes: UiElementNode[] = [];
  const stack: UiElementNode[] = [];
  let root: UiElementNode | null = null;
  const tag = /<(XCUIElementType[A-Za-z0-9]+)([^>]*?)(\/)?>|<\/XCUIElementType[A-Za-z0-9]+>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(body)) !== null) {
    const full = match[0];
    if (full.startsWith('</')) {
      stack.pop();
      continue;
    }
    const className = match[1] ?? '';
    const attrs = parseAttributes(match[2] ?? '');
    const text = firstShortLabel(attrs.name, attrs.label, attrs.value);
    const visible = attrs.visible !== 'false';
    const clickable = visible && (CLICKABLE_TYPES.test(className) || attrs.accessible === 'true');
    const node: UiElementNode = {
      id: `node-${nodes.length + 1}`,
      index: Number.parseInt(attrs.index ?? String(nodes.length), 10) || 0,
      text,
      resourceId: attrs.rawIdentifier || attrs.name || '',
      contentDesc: attrs.label || '',
      className,
      packageName: attrs.bundleId || '',
      bounds: parseFrame(attrs),
      clickable,
      enabled: attrs.enabled === undefined ? true : attrs.enabled === 'true',
      focused: attrs.focused === 'true',
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    if (visible && (text || clickable)) nodes.push(node);
    if (!full.endsWith('/>') && match[3] !== '/') stack.push(node);
  }
  nodes.sort((left, right) => popupScore(right) - popupScore(left));
  return { capturedAt, root, nodes };
}

function firstShortLabel(...values: Array<string | undefined>): string {
  const labels = values.map(value => (value ?? '').trim()).filter(Boolean);
  return labels.find(label => label.length <= 80) ?? (labels[0] ?? '').slice(0, 80);
}

function unwrapSourceXml(xml: string): string {
  const trimmed = xml.trim();
  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed) as { value?: unknown };
      if (typeof payload.value === 'string') return payload.value;
    } catch {
      // Fall through to raw XML parsing.
    }
  }
  return xml;
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attr = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(input)) !== null) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseFrame(attrs: Record<string, string>): UiBounds {
  const left = Number(attrs.x);
  const top = Number(attrs.y);
  const width = Number(attrs.width);
  const height = Number(attrs.height);
  if (![left, top, width, height].every(Number.isFinite)) return { ...EMPTY_BOUNDS };
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width: Math.max(0, width),
    height: Math.max(0, height),
    centerX: left + Math.max(0, width) / 2,
    centerY: top + Math.max(0, height) / 2,
  };
}

function popupScore(node: UiElementNode): number {
  const alertish = /Alert|Button/.test(node.className) ? 4 : 0;
  return alertish + (node.clickable ? 2 : 0) + (node.text ? 1 : 0) + (node.bounds.width > 0 ? 1 : 0);
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

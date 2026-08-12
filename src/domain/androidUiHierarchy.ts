export interface UiBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface UiElementNode {
  id: string;
  index: number;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  packageName: string;
  bounds: UiBounds;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  children: UiElementNode[];
}

export interface UiHierarchy {
  capturedAt: number;
  root: UiElementNode | null;
  nodes: UiElementNode[];
}

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

export function parseUiAutomatorXml(xml: string, capturedAt = Date.now()): UiHierarchy {
  const body = extractHierarchyXml(xml);
  const nodes: UiElementNode[] = [];
  const stack: UiElementNode[] = [];
  let root: UiElementNode | null = null;
  const nodeTag = /<node\b([^>]*?)(\/)?>|<\/node>/g;
  let match: RegExpExecArray | null;
  while ((match = nodeTag.exec(body)) !== null) {
    const full = match[0];
    if (full.startsWith('</node')) {
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(match[1] ?? '');
    const node: UiElementNode = {
      id: `node-${nodes.length + 1}`,
      index: Number.parseInt(attrs.index ?? String(nodes.length), 10) || 0,
      text: attrs.text ?? '',
      resourceId: attrs['resource-id'] ?? attrs.resourceId ?? '',
      contentDesc: attrs['content-desc'] ?? attrs.contentDescription ?? '',
      className: attrs.class ?? attrs.className ?? '',
      packageName: attrs.package ?? attrs.packageName ?? '',
      bounds: parseBounds(attrs.bounds),
      clickable: parseBoolean(attrs.clickable),
      enabled: attrs.enabled === undefined ? true : parseBoolean(attrs.enabled),
      focused: parseBoolean(attrs.focused),
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    nodes.push(node);
    if (!full.endsWith('/>') && match[2] !== '/') stack.push(node);
  }
  return { capturedAt, root, nodes };
}

export function findByText(hierarchy: UiHierarchy, text: string): UiElementNode[] {
  const needle = text.trim();
  return hierarchy.nodes.filter(node => node.text === needle);
}

export function findByResourceId(hierarchy: UiHierarchy, resourceId: string): UiElementNode[] {
  const needle = resourceId.trim();
  return hierarchy.nodes.filter(node => node.resourceId === needle || node.resourceId.endsWith(`:id/${needle}`));
}

export function findByContentDesc(hierarchy: UiHierarchy, contentDesc: string): UiElementNode[] {
  const needle = contentDesc.trim();
  return hierarchy.nodes.filter(node => node.contentDesc === needle);
}

export function extractHierarchyXml(output: string): string {
  const start = output.indexOf('<?xml');
  const hierarchyStart = output.indexOf('<hierarchy');
  const first = start >= 0 ? start : hierarchyStart;
  if (first < 0) return output.trim();
  const end = output.lastIndexOf('</hierarchy>');
  return output.slice(first, end >= first ? end + '</hierarchy>'.length : undefined).trim();
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attr = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(input)) !== null) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function parseBounds(value: string | undefined): UiBounds {
  const match = value?.match(/\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/);
  if (!match) return { ...EMPTY_BOUNDS };
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height, centerX: left + width / 2, centerY: top + height / 2 };
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true';
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* Stable entry/node IDs are identities. Numbers are a projection of current order. */
(function (root) {
  'use strict';
  const clean = value => String(value || '').replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim();
  const prefix = value => clean(value).match(/^(\d+(?:\.\d+)*)(?:\.(?=\s))?\s+/)?.[1] || '';
  const label = value => clean(value).replace(/^\d+(?:\.\d+)*(?:\.(?=\s))?\s+/, '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const stripNumber = value => clean(value).replace(/^\d+(?:\.\d+)*(?:\.(?=\s))?\s+/, '');
  function heading(line, entry) {
    const raw = String(line).trim();
    const markdown = raw.match(/^(#{1,6})\s+/);
    const text = clean(raw);
    const number = prefix(text);
    const explicitDepth = entry.numberingHeadingLevels?.[raw];
    if (!explicitDepth && number && !number.includes('.') && label(text) !== label(entry.title)) return null;
    if (!explicitDepth && !markdown && !number) return null;
    if (!/[\p{L}]/u.test(stripNumber(text)) || text.length > 180 || !markdown && /[.!?;]$/.test(text)) return null;
    return { raw, number, label: label(text), title: stripNumber(text), markdown: markdown?.[1] || '', explicitDepth };
  }
  function create({ phases, records, bindings = {}, generatedEntryIds = [] }) {
    const entryNumbers = new Map(), nodeNumbers = new Map(), headings = new Map(), issues = [];
    const active = records.filter(e => e.status !== 'Archivada' && !['Tarea', 'Fuente'].includes(e.type)
      || e.apaUnifiedBibliography === true);
    const groups = new Map();
    for (const entry of active) {
      const nodeId = bindings[entry.id] || entry.guideNodeId;
      if (!nodeId) continue;
      if (!groups.has(nodeId)) groups.set(nodeId, []);
      groups.get(nodeId).push(entry);
    }
    const assignedLabels = new Map();
    const generated = new Set(generatedEntryIds);
    const registerLabel = (text, number) => {
      const key = label(text);
      if (!key) return;
      if (!assignedLabels.has(key)) assignedLabels.set(key, new Set());
      assignedLabels.get(key).add(number);
    };
    function assignHeadings(entry, base, takeChild) {
      if (generated.has(entry.id)) return;
      const paragraphs = Array.isArray(entry.contentBlocks) && entry.contentBlocks.some(b => b.type === 'paragraph')
        ? entry.contentBlocks.filter(b => b.type === 'paragraph').map(b => b.text || '') : [entry.content || ''];
      const aliases = new Set([entry.title, entry.atlasNumberAlignmentSnapshot?.title, entry.originalSnapshot?.title]
        .map(prefix).filter(Boolean));
      const replacements = new Map(), oldNumbers = new Map(), counters = new Map();
      for (const line of paragraphs.flatMap(text => text.split(/\r?\n/))) {
        const item = heading(line, entry);
        if (!item || replacements.has(item.raw)) continue;
        let number;
        if (item.label === label(entry.title) || aliases.has(item.number)) number = base;
        else if (item.number && !item.explicitDepth) {
          const source = [...aliases].sort((a, b) => b.length - a.length)
            .find(alias => item.number.startsWith(alias + '.'));
          if (!source) { issues.push({ entryId: entry.id, heading: item.raw, reason: 'numbered-heading-without-confirmed-parent' }); continue; }
          const parts = item.number.slice(source.length + 1).split('.');
          let parent = base;
          for (let index = 0; index < parts.length; index += 1) {
            const key = `${source}.${parts.slice(0, index + 1).join('.')}`;
            if (!oldNumbers.has(key)) {
              const next = parent === base && takeChild ? takeChild() : (counters.get(parent) || 0) + 1;
              counters.set(parent, next);
              oldNumbers.set(key, `${parent}.${next}`);
            }
            parent = oldNumbers.get(key);
          }
          number = parent;
        } else {
          const depth = item.explicitDepth || Math.max(1, item.markdown.length - 1);
          let parent = base;
          for (let level = 1; level < depth; level += 1) {
            if (!counters.get(parent)) counters.set(parent, parent === base && takeChild ? takeChild() : 1);
            parent += `.${counters.get(parent)}`;
          }
          const next = parent === base && takeChild ? takeChild() : (counters.get(parent) || 0) + 1;
          counters.set(parent, next);
          number = `${parent}.${next}`;
        }
        replacements.set(item.raw, `${item.markdown ? item.markdown + ' ' : ''}${number} ${item.title}`);
        registerLabel(item.title, number);
      }
      headings.set(entry.id, replacements);
    }
    function visit(node, number) {
      nodeNumbers.set(node.id, number);
      registerLabel(node.label, number);
      const own = groups.get(node.id) || [];
      const intro = own.find(entry => label(entry.title) === label(node.label)) || (own.length === 1 ? own[0] : null);
      let slot = 0;
      for (const entry of own) {
        const entryNumber = entry === intro ? number : `${number}.${++slot}`;
        entryNumbers.set(entry.id, entryNumber);
        registerLabel(entry.title, entryNumber);
        assignHeadings(entry, entryNumber, entry === intro ? () => ++slot : null);
      }
      for (const child of node.children || []) visit(child, `${number}.${++slot}`);
    }
    for (const phase of phases) {
      if (!phase.number) continue;
      nodeNumbers.set(phase.id, phase.number);
      let slot = 0;
      for (const node of phase.nodes || []) visit(node, `${phase.number}.${++slot}`);
      for (const node of phase.entryNodes || []) visit(node, `${phase.number}.${++slot}`);
    }
    function title(entry) {
      const number = entryNumbers.get(entry.id);
      return number ? `${number} ${stripNumber(entry.title || 'Sin título')}` : entry.title || 'Sin título';
    }
    function text(entry, value) {
      const replacements = headings.get(entry.id);
      if (!replacements) return String(value || '');
      const projected = String(value || '').split(/\r?\n/).map(line => {
        const item = heading(line, entry);
        if (!item) return line;
        const known = replacements.get(item.raw);
        if (known) return known;
        const candidates = assignedLabels.get(item.label);
        if (item.number && candidates?.size === 1) return `${item.markdown ? item.markdown + ' ' : ''}${[...candidates][0]} ${item.title}`;
        return line;
      }).join('\n');
      return projected.replace(/\[\[apartado:([\w:.-]+)\]\]/g, (_match, id) => {
        const number = entryNumbers.get(id) || nodeNumbers.get(id);
        if (!number) return 'apartado no disponible';
        return entryNumbers.has(id) ? `[apartado ${number}](#entry=${encodeURIComponent(id)})` : `apartado ${number}`;
      });
    }
    return { entryNumbers, nodeNumbers, issues, title, text,
      snapshot: () => ({ version: 1, policy: 'atlas-order-derived', nodes: Object.fromEntries(nodeNumbers),
        entries: Object.fromEntries(active.filter(e => entryNumbers.has(e.id)).map(e => [e.id, {
          number: entryNumbers.get(e.id), title: title(e),
          ...(generated.has(e.id) ? { rendering: 'generated-index', content: null, paragraphs: [] }
            : { content: text(e, e.content), paragraphs: e.contentBlocks?.filter(b => b.type === 'paragraph').map(b => text(e, b.text)) || [] }),
          headingLevels: e.numberingHeadingLevels || {}
        }])), unresolvedHeadings: issues }) };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectNumbering = api;
})(typeof window === 'object' ? window : globalThis);

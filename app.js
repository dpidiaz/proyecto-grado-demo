const DB_NAME = 'proyecto-grado-cuaderno-demo-799dc3f';
const DB_VERSION = 1;
const STORE = 'entries';
const TYPES = ['Entrada', 'Nota', 'Fuente', 'Tarea', 'Decisión'];
const GITHUB_SYNC_KEY = 'proyecto-grado-demo-799dc3f-github-sync-disabled';
const ATLAS_ORDER_KEY = 'proyecto-grado-demo-799dc3f-atlas-order';
const ENTRY_RENDER_BATCH = 5;
const PGDG_PHASES = window.PROJECT_ATLAS_OUTLINE;
const EDITORIAL_SECTIONS = PGDG_PHASES.flatMap((phase) => {
  const flatten = (node) => [{ ...node, state: node.state || 'En el índice', phaseId: phase.id, phaseLabel: phase.label }, ...(node.children ?? []).flatMap(flatten)];
  return phase.nodes.flatMap(flatten);
});
const PRELIMINARY_ENTRY_NODES = new Map(PGDG_PHASES.flatMap((phase) => (phase.entryNodes ?? []).map((node) => [node.id, {
  ...node,
  phaseId: phase.id,
  phaseLabel: phase.label,
  isAtlasEntry: true
}])));
const PRELIMINARY_ENTRY_ORDER = new Map([...PRELIMINARY_ENTRY_NODES.keys()].map((id, index) => [id, index]));
const GUIDE_NODE_BY_ID = new Map(EDITORIAL_SECTIONS.map((node) => [node.id, node]));
const GUIDE_PHASE_BY_ID = new Map(PGDG_PHASES.map((phase) => [phase.id, phase]));
const CUSTOM_ATLAS_OPTION = '__create_atlas_section__';
let db;
let entries = [];
let apaCitationNavigationAudit = null;
let editorialSectionsCacheSource = null;
let editorialSectionsCache = [];
let atlasNumberingCache = null;
let atlasNumberingBuilding = false;
let listEntrySnapshot = [];
let renderedEntryCount = 0;
let entryListRenderKey = '';
let bundledContentById = new Map();
let bundledSourceOrder = new Map();
let selectedId = null;
let activeFilter = 'all';
let activeSection = null;
let showHomePage = true;
let showAtlasHome = false;
let showFigureCredits = false;
let showApaAudit = false;
let showEntryWorkspace = false;
let entryOpenedFromAtlas = false;
let searchTerm = '';
let sectionSearchTerm = '';
let atlasSearchTerm = '';
let atlasFocusEntryId = null;
let atlasFocusNeedsScroll = false;
const atlasExpandedPhases = new Set();
const atlasExpandedNodes = new Set();
let readerRailFollowScheduled = false;
let offlineMediaCacheRequested = false;
let statusFilter = 'all';
let toastTimer;
let toastObjectUrl = null;
let deferredInstallPrompt;
let pendingEntryLocationId = null;
let pendingEntryLocationTimer = null;
let atlasOrderState = readAtlasOrderState();
let atlasDragPayload = null;

function readAtlasOrderState(value = null) {
  try {
    const source = value ?? JSON.parse(localStorage.getItem(ATLAS_ORDER_KEY) || 'null');
    if (!source || typeof source !== 'object' || Array.isArray(source)) return { nodes: {}, entries: {}, deletedEntries: {}, deletedPhases: {}, updatedAt: '' };
    const cleanMap = (map) => Object.fromEntries(Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {})
      .filter(([key, ids]) => typeof key === 'string' && Array.isArray(ids) && ids.length <= 5000)
      .map(([key, ids]) => [key, [...new Set(ids.filter((id) => typeof id === 'string' && id.length <= 180))]]));
    const cleanTombstones = (map) => Object.fromEntries(Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {})
      .filter(([key, timestamp]) => typeof key === 'string' && key.length <= 180 && typeof timestamp === 'string' && timestamp.length <= 40));
    return { nodes: cleanMap(source.nodes), entries: cleanMap(source.entries), deletedEntries: cleanTombstones(source.deletedEntries), deletedPhases: cleanTombstones(source.deletedPhases), updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '' };
  } catch { return { nodes: {}, entries: {}, deletedEntries: {}, deletedPhases: {}, updatedAt: '' }; }
}

function saveAtlasOrderState({ scheduleSync = true } = {}) {
  atlasNumberingCache = null;
  atlasOrderState.updatedAt = new Date().toISOString();
  try { localStorage.setItem(ATLAS_ORDER_KEY, JSON.stringify(atlasOrderState)); } catch (error) { console.warn('No se pudo guardar el orden del Atlas:', error); }
  editorialSectionsCacheSource = null;
  if (scheduleSync) scheduleGitHubSync();
}

function mergeAtlasDeletionRecords(current, incoming) {
  const mergeLatest = (left = {}, right = {}) => Object.fromEntries([...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])]
    .map((id) => [id, (Date.parse(right?.[id] || '') || 0) > (Date.parse(left?.[id] || '') || 0) ? right[id] : left[id]]));
  return {
    ...current,
    deletedEntries: mergeLatest(current?.deletedEntries, incoming?.deletedEntries),
    deletedPhases: mergeLatest(current?.deletedPhases, incoming?.deletedPhases)
  };
}

function applySyncedAtlasOrder(value) {
  const incoming = readAtlasOrderState(value);
  const incomingIsNewer = Boolean(incoming.updatedAt) && Date.parse(incoming.updatedAt) > (Date.parse(atlasOrderState.updatedAt) || 0);
  const mergedDeletions = mergeAtlasDeletionRecords(atlasOrderState, incoming);
  const base = incomingIsNewer ? incoming : atlasOrderState;
  const next = { ...base, deletedEntries: mergedDeletions.deletedEntries, deletedPhases: mergedDeletions.deletedPhases };
  next.updatedAt = incomingIsNewer ? incoming.updatedAt : atlasOrderState.updatedAt;
  if (JSON.stringify(next) === JSON.stringify(atlasOrderState)) return false;
  atlasOrderState = next;
  atlasNumberingCache = null;
  try { localStorage.setItem(ATLAS_ORDER_KEY, JSON.stringify(atlasOrderState)); } catch (error) { console.warn('No se pudo guardar el orden sincronizado del Atlas:', error); }
  editorialSectionsCacheSource = null;
  return true;
}

function seedBundledAtlasOrder(value) {
  try {
    if (localStorage.getItem(ATLAS_ORDER_KEY)) return false;
    const seeded = readAtlasOrderState(value);
    const hasSavedOrder = Object.keys(seeded.nodes).length || Object.keys(seeded.entries).length
      || Object.keys(seeded.deletedEntries).length || Object.keys(seeded.deletedPhases).length;
    if (!hasSavedOrder) return false;
    atlasOrderState = seeded;
    localStorage.setItem(ATLAS_ORDER_KEY, JSON.stringify(atlasOrderState));
    editorialSectionsCacheSource = null;
    return true;
  } catch (error) {
    console.warn('No se pudo inicializar el orden incluido del Atlas:', error);
    return false;
  }
}

function sortAtlasItems(items, kind, parentId) {
  const saved = atlasOrderState[kind]?.[parentId];
  if (!saved?.length) return items;
  const positions = new Map(saved.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) =>
    (positions.get(a.item.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.item.id) ?? Number.MAX_SAFE_INTEGER)
    || a.index - b.index
  ).map(({ item }) => item);
}

function orderedPhases() {
  const visible = PGDG_PHASES.filter((phase) => !atlasOrderState.deletedPhases?.[phase.id]);
  const savedBookOrder = atlasOrderState.nodes?.__book__ || [];
  // Older versions stored only chapters here. Keep their traditional placement
  // until the user explicitly reorders one of the book-level groups.
  if (savedBookOrder.some((id) => id === 'preliminares' || id === 'sin-clasificar')) {
    return sortAtlasItems(visible, 'nodes', '__book__');
  }
  const preliminary = visible.filter((phase) => phase.id === 'preliminares');
  const numbered = visible.filter((phase) => phase.marker.startsWith('CAPÍTULO'));
  const orderedNumbered = sortAtlasItems(numbered, 'nodes', '__book__');
  const other = visible.filter((phase) => phase.id !== 'preliminares' && !phase.marker.startsWith('CAPÍTULO'));
  return [...preliminary, ...orderedNumbered, ...other];
}

function effectivePhase(phase) {
  if (!phase?.marker?.startsWith('CAPÍTULO')) return phase;
  const chapters = orderedPhases().filter((item) => item.marker.startsWith('CAPÍTULO'));
  const number = chapters.findIndex((item) => item.id === phase.id) + 1;
  return { ...phase, number: String(number), marker: `CAPÍTULO ${number}`, glyph: String(number).padStart(2, '0') };
}

function moveOrderedItem(kind, parentId, fromId, toId, after = false, currentIds = []) {
  if (!kind || !parentId || !fromId || !toId || fromId === toId) return false;
  const knownIds = new Set(currentIds);
  const savedIds = atlasOrderState[kind]?.[parentId] || [];
  const list = [...savedIds.filter((id) => !knownIds.size || knownIds.has(id))];
  currentIds.forEach((id) => { if (!list.includes(id)) list.push(id); });
  const fromIndex = list.indexOf(fromId);
  const targetIndex = list.indexOf(toId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  list.splice(fromIndex, 1);
  const nextTargetIndex = list.indexOf(toId);
  list.splice(nextTargetIndex + (after ? 1 : 0), 0, fromId);
  atlasOrderState[kind] = { ...(atlasOrderState[kind] || {}), [parentId]: list };
  saveAtlasOrderState();
  return true;
}

async function moveEntryToAtlasNode(entryId, targetNodeId, beforeEntryId = '', after = false) {
  const entry = entries.find((item) => item.id === entryId);
  const targetNode = getGuideNodeById(targetNodeId);
  if (!entry || !targetNode || targetNode.isPhase || targetNode.isAtlasEntry) return false;
  const sourceNode = guideNodeForEntry(entry);
  const destinationId = targetNode.id;
  const siblings = entries.filter((item) => item.id !== entryId && guideNodeForEntry(item)?.id === destinationId);
  const siblingIds = siblings.map((item) => item.id);
  const moved = beforeEntryId
    ? moveOrderedItem('entries', destinationId, entryId, beforeEntryId, after, [...siblingIds, entryId])
    : (() => {
      atlasOrderState.entries = { ...(atlasOrderState.entries || {}), [destinationId]: [...siblingIds, entryId] };
      saveAtlasOrderState();
      return true;
    })();
  if (!moved) return false;
  const now = new Date().toISOString();
  const updated = { ...entry, guideNodeId: destinationId, localEditedAt: now, updatedAt: now };
  await putEntry(updated);
  entries = entries.map((item) => item.id === entryId ? updated : item);
  if (sourceNode?.id && sourceNode.id !== destinationId) {
    atlasOrderState.entries = { ...(atlasOrderState.entries || {}) };
    if (atlasOrderState.entries[sourceNode.id]) {
      atlasOrderState.entries[sourceNode.id] = atlasOrderState.entries[sourceNode.id].filter((id) => id !== entryId);
      saveAtlasOrderState();
    }
  }
  scheduleGitHubSync();
  renderList();
  return true;
}

async function deleteAtlasEntry(entryId) {
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) return false;
  const confirmed = window.confirm(`¿Borrar la entrada “${entry.title || 'Sin título'}”? Se quitará del Atlas y de la biblioteca. Esta acción no se puede deshacer; exporta una copia antes si quieres conservar un respaldo.`);
  if (!confirmed) return false;
  const deletedAt = new Date().toISOString();
  await deleteEntriesById([entry.id]);
  atlasOrderState.deletedEntries = { ...(atlasOrderState.deletedEntries || {}), [entry.id]: deletedAt };
  atlasOrderState.entries = Object.fromEntries(Object.entries(atlasOrderState.entries || {}).map(([nodeId, ids]) => [nodeId, ids.filter((id) => id !== entry.id)]));
  saveAtlasOrderState();
  entries = entries.filter((item) => item.id !== entry.id);
  if (selectedId === entry.id) selectedId = entries[0]?.id ?? null;
  scheduleGitHubSync();
  renderList();
  showToast('Entrada borrada. El cambio se sincronizará con GitHub si está activado.');
  return true;
}

async function deleteAtlasChapter(phaseId) {
  const phase = GUIDE_PHASE_BY_ID.get(phaseId);
  if (!phase || !phase.marker.startsWith('CAPÍTULO') || atlasOrderState.deletedPhases?.[phaseId]) return false;
  const chapterEntries = entries.filter((entry) => entryMatchesSelection(entry, phaseId));
  const chapterLabel = `${phase.marker} · ${phase.label}`;
  const confirmation = window.confirm(`¿Borrar ${chapterLabel}? Se quitará su capítulo y sus apartados del Atlas. Sus ${chapterEntries.length} entradas se conservarán en “Por ubicar” para que puedas revisarlas y borrarlas individualmente si hace falta. Esta acción no se puede deshacer sin una copia anterior.`);
  if (!confirmation) return false;
  const deletedAt = new Date().toISOString();
  const preservedNodeId = `deleted-chapter-${phaseId}`;
  const updates = chapterEntries.map((entry) => ({
    ...entry,
    guideNodeId: preservedNodeId,
    customGuideNode: { id: preservedNodeId, phaseId: 'sin-clasificar', parentId: 'sin-clasificar', label: `Contenido conservado de ${phase.label}` },
    localEditedAt: deletedAt,
    updatedAt: deletedAt
  }));
  if (updates.length) await putEntriesAtomically(updates);
  entries = entries.map((entry) => updates.find((updated) => updated.id === entry.id) || entry);
  atlasOrderState.deletedPhases = { ...(atlasOrderState.deletedPhases || {}), [phaseId]: deletedAt };
  saveAtlasOrderState();
  scheduleGitHubSync();
  renderList();
  showToast(`Capítulo borrado. Se conservaron ${chapterEntries.length} entradas en “Por ubicar”.`);
  return true;
}

function registerAtlasDragEvents() {
  const dragHost = $('.main-area');
  const dragItem = (target) => target.closest('[data-atlas-drag-kind]');
  const clearDropMarks = () => {
    const grid = $('#atlas-phase-grid');
    if (!grid) return;
    grid.querySelectorAll('.is-atlas-drop-before,.is-atlas-drop-after,.is-atlas-drop-over')
      .forEach((element) => element.classList.remove('is-atlas-drop-before', 'is-atlas-drop-after', 'is-atlas-drop-over'));
  };
  const currentNodeSiblingIds = (parentId) => {
    if (parentId === '__book__') return orderedPhases().map((phase) => phase.id);
    const phase = GUIDE_PHASE_BY_ID.get(parentId);
    if (phase) return phase.entryNodes?.length
      ? atlasEntryNodesForPhase(phase).map((node) => node.id)
      : atlasNodesForPhase(phase).map((node) => node.id);
    const parent = getGuideNodeById(parentId);
    return parent?.children?.map((node) => node.id) ?? [];
  };
  dragHost.addEventListener('dragstart', (event) => {
    const item = dragItem(event.target);
    if (!item) return;
    const kind = item.dataset.atlasDragKind;
    if (!['node', 'entry', 'outline-entry-node', 'phase'].includes(kind)) return;
    atlasDragPayload = {
      kind,
      id: kind === 'entry' ? item.dataset.entryId : kind === 'phase' ? item.dataset.atlasPhaseId : item.dataset.atlasNodeId,
      parentId: item.dataset.atlasParentId
    };
    if (!atlasDragPayload.id || !atlasDragPayload.parentId) { atlasDragPayload = null; return; }
    item.classList.add('is-atlas-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', atlasDragPayload.id);
  });
  dragHost.addEventListener('dragend', (event) => {
    event.target.closest('[data-atlas-drag-kind]')?.classList.remove('is-atlas-dragging');
    atlasDragPayload = null;
    clearDropMarks();
  });
  dragHost.addEventListener('dragover', (event) => {
    if (!atlasDragPayload) return;
    const target = dragItem(event.target);
    if (!target) return;
    const targetKind = target.dataset.atlasDragKind;
    const compatible = atlasDragPayload.kind === 'phase' && targetKind === 'phase'
      || atlasDragPayload.kind === 'node' && targetKind === 'node'
      && atlasDragPayload.parentId === target.dataset.atlasParentId
      || atlasDragPayload.kind === 'outline-entry-node' && targetKind === 'outline-entry-node'
        && atlasDragPayload.parentId === target.dataset.atlasParentId
      || atlasDragPayload.kind === 'entry' && (targetKind === 'entry' || targetKind === 'node');
    if (!compatible) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const rect = target.getBoundingClientRect();
    if (targetKind === 'node' && atlasDragPayload.kind === 'entry') target.classList.add('is-atlas-drop-over');
    else target.classList.add(event.clientY >= rect.top + rect.height / 2 ? 'is-atlas-drop-after' : 'is-atlas-drop-before');
  });
  dragHost.addEventListener('drop', async (event) => {
    if (!atlasDragPayload) return;
    const target = dragItem(event.target);
    if (!target) return;
    const payload = atlasDragPayload;
    const targetKind = target.dataset.atlasDragKind;
    const targetId = targetKind === 'entry' ? target.dataset.entryId : targetKind === 'phase' ? target.dataset.atlasPhaseId : target.dataset.atlasNodeId;
    const targetParentId = target.dataset.atlasParentId;
    const after = event.clientY >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
    const compatible = payload.kind === 'phase' && targetKind === 'phase'
      || payload.kind === 'node' && targetKind === 'node' && payload.parentId === targetParentId
      || payload.kind === 'outline-entry-node' && targetKind === 'outline-entry-node' && payload.parentId === targetParentId
      || payload.kind === 'entry' && (targetKind === 'entry' || targetKind === 'node');
    if (!compatible || !targetId) return;
    event.preventDefault();
    atlasDragPayload = null;
    clearDropMarks();
    if (payload.kind === 'phase') {
      const moved = moveOrderedItem('nodes', '__book__', payload.id, targetId, after, currentNodeSiblingIds('__book__'));
      if (moved) renderList();
    } else if (payload.kind === 'node' || payload.kind === 'outline-entry-node') {
      const moved = moveOrderedItem('nodes', payload.parentId, payload.id, targetId, after, currentNodeSiblingIds(payload.parentId));
      if (moved) renderList();
    } else if (targetKind === 'entry') {
      if (payload.parentId === targetParentId) {
        const currentIds = sortAtlasItems(entries.filter((item) => guideNodeForEntry(item)?.id === targetParentId), 'entries', targetParentId).map((item) => item.id);
        if (moveOrderedItem('entries', targetParentId, payload.id, targetId, after, currentIds)) renderList();
      } else {
        await moveEntryToAtlasNode(payload.id, targetParentId, targetId, after);
      }
    } else if (targetKind === 'node') {
      await moveEntryToAtlasNode(payload.id, targetId);
    }
  });
}

const $ = (selector) => document.querySelector(selector);
let entryList = null;
let emptyState = null;
let libraryMounted = false;

function ensureLibraryMounted() {
  if (libraryMounted) return;
  $('#library-mount').replaceChildren($('#library-template').content.cloneNode(true));
  entryList = $('#entry-list');
  emptyState = $('#empty-state');
  if (!$('#clear-library-filters')) {
    const clearFilters = document.createElement('button');
    clearFilters.type = 'button';
    clearFilters.id = 'clear-library-filters';
    clearFilters.className = 'button button-primary';
    clearFilters.textContent = 'Limpiar búsqueda y filtros';
    emptyState.append(clearFilters);
    clearFilters.addEventListener('click', () => {
      clearEntryLocation();
      searchTerm = '';
      statusFilter = 'all';
      activeFilter = 'all';
      activeSection = null;
      entryOpenedFromAtlas = false;
      showHomePage = false;
      showAtlasHome = false;
      showEntryWorkspace = true;
      $('#search-input').value = '';
      $('#status-filter').value = 'all';
      renderList();
      window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
      $('#search-input').focus();
    });
  }
  libraryMounted = true;
  registerLibraryEvents();
  $('#connection-state').textContent = navigator.onLine ? 'En línea' : 'Sin red · medios offline sin verificar';
  void refreshOfflineMediaStatus();
}

async function refreshOfflineMediaStatus(registration = null) {
  const state = $('#connection-state');
  if (!state || !('serviceWorker' in navigator)) return;
  const worker = registration?.active || navigator.serviceWorker.controller;
  if (!worker) return;

  const channel = new MessageChannel();
  const timeout = window.setTimeout(() => channel.port1.close(), 3000);
  const renderStatus = (status) => {
    if (!status || !Number.isFinite(status.expected)) {
      state.textContent = navigator.onLine ? 'En línea' : 'Sin red · medios offline sin verificar';
      return;
    }
    const ready = `${status.cached}/${status.expected} medios guardados`;
    if (!navigator.onLine) {
      state.textContent = `Sin red · ${ready}`;
    } else if (status.cached === status.expected) {
      state.textContent = `En línea · ${ready}`;
    } else {
      state.textContent = `En línea · ${ready}; ${status.failures?.length || 0} pendientes`;
    }
  };
  channel.port1.onmessage = (event) => {
    window.clearTimeout(timeout);
    channel.port1.close();
    const status = event.data;
    renderStatus(status);
  };
  worker.postMessage({ type: 'GET_OFFLINE_MEDIA_STATUS' }, [channel.port2]);
}

function unmountLibrary() {
  if (!libraryMounted) return;
  $('#library-mount').replaceChildren();
  entryList = null;
  emptyState = null;
  libraryMounted = false;
  entryListRenderKey = '';
  renderedEntryCount = 0;
  listEntrySnapshot = [];
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function githubSyncEnabled() { return false; }

function syncableEntries() {
  return entries.filter((entry) => entry.localEditedAt || entry.pwaCreated);
}

function setGitHubSyncStatus(label, title = '') {
  const state = $('#save-state');
  if (!state) return;
  state.textContent = label;
  state.title = title;
}

function refreshGitHubSyncControl() {
  const button = $('#github-sync-button');
  if (!button) return;
  button.textContent = githubSyncEnabled() ? 'Pausar sincronización GitHub' : 'Activar sincronización GitHub';
  const note = $('.local-data-note p');
  if (note) {
    note.innerHTML = githubSyncEnabled()
      ? 'La sincronización está desactivada en esta versión demo.'
      : 'Las ediciones, los borrados y el orden del Atlas se guardan en este navegador. Puedes autorizar su sincronización con GitHub desde Herramientas o exportar un proyecto completo para respaldar y restaurar la biblioteca. El contenido y los medios base están incluidos en la PWA.';
  }
  if (githubSyncEnabled()) setGitHubSyncStatus('GitHub · activa', 'La sincronización está desactivada en esta versión demo.');
}

async function applySyncedEntries(remoteEntries, preferRemoteIds = new Set()) {
  const merged = new Map(entries.map((entry) => [entry.id, entry]));
  let changed = false;
  let bundledMetadataAdded = false;
  for (const remoteEntry of remoteEntries) {
    const incoming = { ...remoteEntry, type: normalizeEntryType(remoteEntry.type, 'Entrada'), syncBaseUpdatedAt: remoteEntry.updatedAt };
    const current = merged.get(incoming.id);
    const remoteTime = new Date(incoming.updatedAt || 0).valueOf();
    const localTime = new Date(current?.updatedAt || 0).valueOf();
    let selected = incoming;
    if (!current || preferRemoteIds.has(incoming.id) || remoteTime >= localTime) {
      selected = incoming;
    } else if (current.syncBaseUpdatedAt !== incoming.updatedAt) {
      selected = { ...current, syncBaseUpdatedAt: incoming.updatedAt };
    } else {
      selected = current;
    }

    const enriched = mergeBundledFigureMetadata(selected);
    const editorialFields = ['contentReviewState', 'contentReviewNote', 'guideNodeId', 'outlineScaffold', 'atlasStructuralLabel', 'bibliographicReview', 'sourceReview'];
    let editorialMetadataAdded = false;
    selected = enriched.entry;
    if (current) {
      for (const field of editorialFields) {
        if (selected[field] === undefined && current[field] !== undefined) {
          selected[field] = current[field];
          editorialMetadataAdded = true;
        }
      }
    }
    if (enriched.added || editorialMetadataAdded) {
      const now = new Date().toISOString();
      selected = {
        ...selected,
        updatedAt: now,
        localEditedAt: now,
        syncBaseUpdatedAt: incoming.updatedAt
      };
      bundledMetadataAdded = true;
    }
    merged.set(selected.id, selected);
    if (JSON.stringify(current) !== JSON.stringify(selected)) {
      await putEntry(selected);
      changed = true;
    }
  }
  if (changed) {
    entries = [...merged.values()];
    renderList();
  }
  if (bundledMetadataAdded && githubSyncEnabled()) scheduleGitHubSync();
}

function mergeBundledFigureMetadata(entry) {
  const bundled = bundledContentById.get(entry?.id);
  if (!bundled || entry.bundleFigureMetadataRevision === bundled.sourceBundleRevision) return { entry, added: false };

  let added = false;
  const mergeBlocks = (blocks, sourceBlocks, includeBundledGeneratedFigures = false) => {
    if (!Array.isArray(sourceBlocks)) return blocks;
    if (!Array.isArray(blocks) || (includeBundledGeneratedFigures && blocks.length === 0)) {
      if (entry.content === bundled.content && sourceBlocks.length) {
        added = true;
        return sourceBlocks;
      }
      if (!includeBundledGeneratedFigures) return blocks;
      blocks = entry.content?.trim() ? [{ type: 'paragraph', text: entry.content }] : [];
      if (Array.isArray(entry.sourceMedia)) {
        blocks.push(...entry.sourceMedia.filter((block) => ['figure', 'document', 'missing'].includes(block?.type)));
      }
    }
    const claimed = new Set();
    const merged = blocks.map((block) => {
      if (!block || block.type !== 'figure') return block;
      const matchIndex = sourceBlocks.findIndex((source, candidateIndex) => {
        if (claimed.has(candidateIndex) || source?.type !== 'figure') return false;
        return (block.src && source.src === block.src)
          || (block.filename && source.filename === block.filename)
          || (block.sourceObjectId && source.sourceObjectId === block.sourceObjectId);
      });
      if (matchIndex < 0) return block;
      const source = sourceBlocks[matchIndex];
      if (!source || source.type !== 'figure') return block;
      claimed.add(matchIndex);
      const sourceCitation = source.figureId ? bundled.figureCitations?.[source.figureId] : null;
      const existingCitation = source.figureId ? entry.figureCitations?.[source.figureId] : null;
      const openAiCaptionYearMatch = Boolean(block.figureId && block.figureId === source.figureId
        && sourceCitation?.creator === 'OpenAI'
        && sourceCitation?.year === '2026a'
        && sourceCitation?.workTitle === 'ChatGPT'
        && sourceCitation?.generationYear === '2026'
        && existingCitation?.sourceType === 'generated-ai'
        && existingCitation?.workTitle === 'ChatGPT'
        && existingCitation?.generationYear === '2026'
        && typeof block.caption === 'string'
        && typeof source.caption === 'string'
        && block.caption === source.caption.replace('(OpenAI, 2026a)', '(OpenAI, 2025)'));
      if (openAiCaptionYearMatch) {
        added = true;
        return { ...block, caption: source.caption };
      }
      if (block.figureId || !source.figureId) return block;
      added = true;
      return { ...block, figureId: source.figureId };
    });

    if (!includeBundledGeneratedFigures) return merged;
    const sameBlock = (left, right) => {
      if (!left || !right || left.type !== right.type) return false;
      if (left.type === 'figure') {
        return (left.figureId && right.figureId && left.figureId === right.figureId)
          || (left.src && right.src && left.src === right.src)
          || (left.filename && right.filename && left.filename === right.filename);
      }
      return left.type === 'paragraph' && String(left.text || '').trim() === String(right.text || '').trim();
    };
    const localParagraphText = merged.filter((block) => block?.type === 'paragraph')
      .map((block) => String(block.text || '').trim()).filter(Boolean).join('\n\n');
    const bundledParagraphText = sourceBlocks.filter((block) => block?.type === 'paragraph')
      .map((block) => String(block.text || '').trim()).filter(Boolean).join('\n\n');
    const missingGeneratedFigure = sourceBlocks.some((block) => block?.type === 'figure'
      && /^(generated-openai-2026:|generated-ai-assisted:)/.test(block.figureId || '')
      && !merged.some((local) => sameBlock(local, block)));
    if (missingGeneratedFigure && localParagraphText && localParagraphText === bundledParagraphText) {
      const ordered = sourceBlocks.map((sourceBlock) => {
        const local = merged.find((block) => sameBlock(block, sourceBlock));
        return local && sourceBlock.type === 'figure'
          ? { ...sourceBlock, ...local, figureId: sourceBlock.figureId || local.figureId }
          : sourceBlock;
      });
      const localExtras = merged.filter((block) => block?.type !== 'paragraph'
        && !sourceBlocks.some((sourceBlock) => sameBlock(block, sourceBlock)));
      added = true;
      return [...ordered, ...localExtras];
    }
    sourceBlocks.forEach((sourceBlock, sourceIndex) => {
      if (sourceBlock?.type !== 'figure'
        || !/^(generated-openai-2026:|generated-ai-assisted:)/.test(sourceBlock.figureId || '')) return;
      const existingIndex = merged.findIndex((block) => sameBlock(block, sourceBlock));
      if (existingIndex >= 0) {
        const existingBlock = merged[existingIndex];
        const staleGeneratedCaption = /^Imagen generada con OpenAI image generation \(OpenAI, 2026b\)\.?$/i.test(String(existingBlock.caption || ''));
        if (staleGeneratedCaption && sourceBlock.caption) {
          merged[existingIndex] = { ...existingBlock, caption: sourceBlock.caption };
          added = true;
        }
        return;
      }

      let insertAfter = -1;
      for (let prior = sourceIndex - 1; prior >= 0 && insertAfter < 0; prior -= 1) {
        for (let local = merged.length - 1; local >= 0; local -= 1) {
          if (sameBlock(merged[local], sourceBlocks[prior])) {
            insertAfter = local;
            break;
          }
        }
      }
      merged.splice(insertAfter + 1, 0, sourceBlock);
      added = true;
    });
    return merged;
  };

  const contentBlocks = mergeBlocks(entry.contentBlocks, bundled.contentBlocks, true);
  const images = mergeBlocks(entry.images, bundled.images);
  const figureCitations = { ...(bundled.figureCitations || {}), ...(entry.figureCitations || {}) };
  for (const [figureId, citation] of Object.entries(bundled.figureCitations || {})) {
    const existing = entry.figureCitations?.[figureId];
    if (existing && citation && typeof existing === 'object' && typeof citation === 'object') {
      figureCitations[figureId] = { ...citation, ...existing };
      const legacyChatGptImage = existing.sourceType === 'generated-ai'
        && existing.workTitle === 'ChatGPT'
        && existing.generationYear === '2026'
        && existing.year === '2025';
      const legacyImageGenerationTool = existing.sourceType === 'generated-ai'
        && existing.workTitle === 'OpenAI image generation'
        && citation.workTitle === 'ChatGPT Images';
      const staleAssistedDiagramNote = String(existing.creditNote || '').includes('OpenAI, 2026b')
        && String(citation.creditNote || '').includes('OpenAI, 2026a');
      const staleCampaignFigureYearSuffix = figureId === 'generated-ai-assisted:campaign-two-proposed-phases'
        && /OpenAI, 2026\)/.test(String(existing.creditNote || ''))
        && String(citation.creditNote || '').includes('OpenAI, 2026a');
      if (legacyChatGptImage || legacyImageGenerationTool || staleAssistedDiagramNote || staleCampaignFigureYearSuffix) {
        for (const key of ['year', 'workTitle', 'sourceTitle', 'url', 'aiToolDescription', 'creditNote']) {
          if (citation[key] !== undefined) figureCitations[figureId][key] = citation[key];
        }
        added = true;
      }
      for (const [key, value] of Object.entries(citation)) {
        if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
          figureCitations[figureId][key] = value;
          added = true;
        }
      }
    } else if (!existing && citation) {
      added = true;
    }
  }

  if (JSON.stringify(contentBlocks) !== JSON.stringify(entry.contentBlocks)
    || JSON.stringify(images) !== JSON.stringify(entry.images)) added = true;
  if (JSON.stringify(figureCitations) !== JSON.stringify(entry.figureCitations || {})) added = true;
  const revisionChanged = entry.bundleFigureMetadataRevision !== bundled.sourceBundleRevision;
  return {
    entry: added ? {
      ...entry,
      contentBlocks,
      images,
      figureCitations,
      bundleFigureMetadataRevision: bundled.sourceBundleRevision
    } : revisionChanged ? { ...entry, bundleFigureMetadataRevision: bundled.sourceBundleRevision } : entry,
    added,
    revisionChanged
  };
}

async function deleteEntriesById(ids = []) {
  if (!ids.length) return;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    ids.forEach((id) => store.delete(id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('No se pudieron borrar las entradas.'));
    transaction.onabort = () => reject(transaction.error || new Error('El borrado se canceló sin guardar cambios.'));
  });
}

async function applySyncedDeletions(deletedEntries = {}) {
  const ids = Object.keys(deletedEntries || {}).filter((id) => entries.some((entry) => entry.id === id));
  if (!ids.length) return false;
  await deleteEntriesById(ids);
  entries = entries.filter((entry) => !ids.includes(entry.id));
  if (ids.includes(selectedId)) selectedId = entries[0]?.id ?? null;
  return true;
}

let githubSyncTimer = null;
let githubSyncPromise = null;
let githubSyncRequestedAgain = false;

function scheduleGitHubSync() {
  if (!githubSyncEnabled()) return;
  setGitHubSyncStatus('Cambios pendientes', 'Se sincronizarán automáticamente cuando GitHub esté disponible.');
  clearTimeout(githubSyncTimer);
  githubSyncTimer = setTimeout(() => syncGitHubNow(), 900);
}

async function syncGitHubNow({ reportErrors = false } = {}) {
  if (!githubSyncEnabled()) return;
  if (githubSyncPromise) {
    githubSyncRequestedAgain = true;
    return githubSyncPromise;
  }
  githubSyncPromise = (async () => {
    setGitHubSyncStatus('Sincronizando…', 'Enviando las entradas locales modificadas a GitHub.');
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: syncableEntries(), atlasOrder: atlasOrderState })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'GitHub no pudo recibir los cambios.');
      const conflictIds = new Set((result.conflicts || []).map((item) => item.originalId));
      await applySyncedEntries(result.entries || [], conflictIds);
      const atlasOrderChanged = applySyncedAtlasOrder(result.atlasOrder);
      const deletedLocally = await applySyncedDeletions(result.atlasOrder?.deletedEntries);
      entries = await allEntries();
      if (atlasOrderChanged || deletedLocally) renderList();
      setGitHubSyncStatus('GitHub · al día', `Última sincronización: ${new Date(result.syncedAt).toLocaleString('es')}. Rama ${result.branch}.`);
      if (result.conflicts?.length) {
        showToast(`${result.conflicts.length} conflicto(s) preservado(s) como copias para revisión.`);
      }
      return result;
    } catch (error) {
      setGitHubSyncStatus('GitHub · pendiente', 'No se pudo sincronizar. Los cambios siguen guardados en este navegador y se reintentarán al volver a estar en línea.');
      if (reportErrors) showToast(error.message || 'No se pudo conectar con GitHub.');
      return null;
    } finally {
      githubSyncPromise = null;
      if (githubSyncRequestedAgain && githubSyncEnabled()) {
        githubSyncRequestedAgain = false;
        scheduleGitHubSync();
      }
    }
  })();
  return githubSyncPromise;
}

async function syncGitHubUntilIdle() {
  let result = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (githubSyncTimer) {
      clearTimeout(githubSyncTimer);
      githubSyncTimer = null;
    }
    githubSyncRequestedAgain = false;
    result = await syncGitHubNow();
    if (!result) return null;
    if (!githubSyncTimer && !githubSyncRequestedAgain && !githubSyncPromise) return result;
  }
  return null;
}

async function toggleGitHubSync() {
  if (githubSyncEnabled()) {
    if (!window.confirm('¿Pausar la sincronización automática? Las copias ya guardadas en GitHub permanecerán allí.')) return;
    localStorage.removeItem(GITHUB_SYNC_KEY);
    clearTimeout(githubSyncTimer);
    refreshGitHubSyncControl();
    setGitHubSyncStatus('Copia local', 'La sincronización automática está pausada.');
    showToast('Sincronización automática pausada.');
    return;
  }

  const accepted = window.confirm('La sincronización está desactivada en esta versión demo.');
  if (!accepted) return;
  try {
    const status = await fetch('/api/sync/status', { cache: 'no-store' });
    const details = await status.json().catch(() => ({}));
    if (!status.ok || !details.available) throw new Error(details.error || 'Abre la PWA con Abrir-Cuaderno.cmd para habilitar la conexión local con GitHub.');
    localStorage.setItem(GITHUB_SYNC_KEY, 'true');
    refreshGitHubSyncControl();
    await syncGitHubNow({ reportErrors: true });
  } catch (error) {
    setGitHubSyncStatus('Copia local', 'La sincronización aún no está autorizada.');
    showToast(error.message || 'No se pudo autorizar el acceso a GitHub.');
  }
}

function preferredScrollBehavior() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
      store.createIndex('type', 'type');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function allEntries() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putEntry(entry) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry);
    request.onsuccess = () => {
      syncEntryInMemory(entry);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function putEntriesAtomically(batch) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    batch.forEach((entry) => store.put(entry));
    transaction.oncomplete = () => {
      batch.forEach(syncEntryInMemory);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la copia completa.'));
    transaction.onabort = () => reject(transaction.error || new Error('La copia se canceló sin guardar cambios.'));
  });
}

function putEntriesAndDeleteAtomically(batch, idsToDelete = []) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    batch.forEach((entry) => store.put(entry));
    idsToDelete.forEach((id) => store.delete(id));
    transaction.oncomplete = () => {
      batch.forEach(syncEntryInMemory);
      const deletedIds = new Set(idsToDelete);
      entries = entries.filter((entry) => !deletedIds.has(entry.id));
      apaCitationNavigationAudit = null;
      invalidateFigureCreditsCache();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la reorganización del Atlas.'));
    transaction.onabort = () => reject(transaction.error || new Error('La reorganización se canceló sin guardar cambios.'));
  });
}

function compareEntriesByReadingOrder(a, b) {
  const aAssignedNode = guideNodeForEntry(a);
  const bAssignedNode = guideNodeForEntry(b);
  if (aAssignedNode?.id && aAssignedNode.id === bAssignedNode?.id) {
    const manualPositions = new Map((atlasOrderState.entries[aAssignedNode.id] || []).map((id, index) => [id, index]));
    const aPosition = manualPositions.get(a.id);
    const bPosition = manualPositions.get(b.id);
    if ((aPosition !== undefined || bPosition !== undefined) && aPosition !== bPosition)
      return (aPosition ?? Number.MAX_SAFE_INTEGER) - (bPosition ?? Number.MAX_SAFE_INTEGER);
    // Preserve the imported order until the user saves an explicit order for this node.
    if (!manualPositions.size) {
      const aNumber = a.title?.match(/^\s*(\d+(?:\.\d+)*)\b/)?.[1];
      const bNumber = b.title?.match(/^\s*(\d+(?:\.\d+)*)\b/)?.[1];
      if (aNumber && bNumber && aNumber !== bNumber) return aNumber.localeCompare(bNumber, 'es', { numeric: true });
    }
  }
  const nodeOrder = (entry) => {
    const node = guideNodeForEntry(entry);
    if (!node) return editorialSections().length;
    const preliminaryIndex = node.isAtlasEntry
      ? atlasEntryNodesForPhase(GUIDE_PHASE_BY_ID.get(node.phaseId)).findIndex((item) => item.id === node.id)
      : -1;
    if (preliminaryIndex >= 0) return (preliminaryIndex + 1) / 10;
    const sectionIndex = editorialSections().findIndex((item) => item.id === node.id);
    if (sectionIndex >= 0) return sectionIndex;
    const firstPhaseSection = editorialSections().findIndex((item) => item.phaseId === node.id);
    return firstPhaseSection >= 0 ? firstPhaseSection - 0.5 : editorialSections().length;
  };
  const sectionDifference = nodeOrder(a) - nodeOrder(b);
  if (sectionDifference) return sectionDifference;
  const aSourceOrder = bundledSourceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  const bSourceOrder = bundledSourceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
  return aSourceOrder - bSourceOrder || a.title.localeCompare(b.title, 'es', { numeric: true });
}

function filteredEntries() {
  const query = searchTerm.trim().toLocaleLowerCase('es');
  const typeByFilter = { source: 'Fuente', task: 'Tarea' };
  const result = entries.filter((entry) => {
    const isConsolidatedReferenceSource = entry.type === 'Fuente'
      && guideNodeForEntry(entry)?.id === 'pgdg-19'
      && entry.apaUnifiedBibliography !== true;
    const typeMatch = activeFilter === 'all'
      || (activeFilter === 'writing' && ['Entrada', 'Nota', 'Decisión'].includes(entry.type))
      || entry.type === typeByFilter[activeFilter];
    const text = [entry.title, entry.area, entry.content, ...(entry.tags ?? [])].join(' ').toLocaleLowerCase('es');
    const statusMatch = statusFilter === 'all' || entry.status === statusFilter;
    const consolidatedBibliographyMatch = activeFilter === 'source' || !isConsolidatedReferenceSource;
    return typeMatch && consolidatedBibliographyMatch && statusMatch
      && (!activeSection || entryMatchesSelection(entry, activeSection))
      && (!query || text.includes(query));
  });
  return result.sort(compareEntriesByReadingOrder);
}

function isAtlasBibliographyEntryVisible(entry) {
  return entry?.type !== 'Fuente' || entry.apaUnifiedBibliography === true;
}

function normalizeEditorialText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
}

function normalizeEntryType(value, fallback = 'Nota') {
  const normalized = normalizeEditorialText(value);
  if (['capitulo', 'parte', 'fase'].includes(normalized)) return 'Entrada';
  return TYPES.find((type) => normalizeEditorialText(type) === normalized) || fallback;
}

function displayEntryTitle(entry) {
  const numbered = currentAtlasNumbering();
  if (numbered && !atlasNumberingBuilding) return numbered.title(entry);
  const title = entry.title || 'Sin título';
  const node = guideNodeForEntry(entry);
  const sourceNumber = title.match(/^\s*\d+(?:\.\d+)*(?=\s|[·:–—-])/);
  if (!node?.number || !sourceNumber) return title;
  const currentNumber = sourceNumber[0].trim();
  if (currentNumber === node.number || currentNumber.startsWith(`${node.number}.`)) return title;
  const unnumberedTitle = title.slice(sourceNumber[0].length).replace(/^\s*[·:–—-]\s*/, ' ').trimStart();
  return `${node.number} ${unnumberedTitle}`;
}

function currentAtlasNumbering() {
  if (atlasNumberingBuilding || !window.ProjectNumbering) return null;
  if (atlasNumberingCache?.entries === entries && atlasNumberingCache.order === atlasOrderState.updatedAt)
    return atlasNumberingCache.model;
  atlasNumberingBuilding = true;
  try {
    const phases = orderedPhases().map(phase => ({ ...effectivePhase(phase),
      nodes: atlasNodesForPhase(phase), entryNodes: atlasEntryNodesForPhase(phase) }));
    const bindings = Object.fromEntries(entries.map(entry => [entry.id, guideNodeForEntry(entry)?.id]));
    const records = [...entries].filter(entry => !atlasOrderState.deletedEntries?.[entry.id]).sort(compareEntriesByReadingOrder)
      .map(entry => ({ ...entry, numberingHeadingLevels: entry.numberingHeadingLevels
        || bundledContentById.get(entry.id)?.numberingHeadingLevels }));
    const model = window.ProjectNumbering.create({ phases, records, bindings,
      generatedEntryIds: ['idml-r1-u4237', 'idml-r1-u5752'] });
    atlasNumberingCache = { entries, order: atlasOrderState.updatedAt, model };
    return model;
  } finally { atlasNumberingBuilding = false; }
}

function applyCurrentAtlasNumbers(nodes) {
  const model = currentAtlasNumbering();
  if (!model) return nodes;
  return nodes.map(node => ({ ...node, number: model.nodeNumbers.get(node.id) ?? node.number,
    children: applyProjectedChildren(node.children || []) }));
  function applyProjectedChildren(children) {
    return children.map(node => ({ ...node, number: model.nodeNumbers.get(node.id) ?? node.number,
      children: applyProjectedChildren(node.children || []) }));
  }
}

function customAtlasNodes() {
  const nodes = new Map();
  entries.forEach((entry) => {
    const node = entry.customGuideNode;
    if (!node?.id || !node.label || !GUIDE_PHASE_BY_ID.has(node.phaseId)) return;
    if (!nodes.has(node.id)) nodes.set(node.id, {
      id: node.id,
      label: node.label,
      number: node.number || '',
      state: 'Personalizado',
      phaseId: node.phaseId,
      phaseLabel: GUIDE_PHASE_BY_ID.get(node.phaseId).label,
      parentId: node.parentId || node.phaseId,
      detail: 'Apartado creado durante la edición de una entrada.',
      children: [],
      isCustom: true,
      sourceSectionNumber: entry.sourceSectionNumber || '',
      createdAt: entry.createdAt || ''
    });
  });
  return [...nodes.values()].sort((a, b) => {
    if (a.sourceSectionNumber && b.sourceSectionNumber) {
      return a.sourceSectionNumber.localeCompare(b.sourceSectionNumber, 'es', { numeric: true });
    }
    if (a.sourceSectionNumber) return -1;
    if (b.sourceSectionNumber) return 1;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, 'es', { numeric: true });
  });
}

function editorialSections() {
  if (editorialSectionsCacheSource === entries) return editorialSectionsCache;
  const flatten = (node) => [{ ...node, state: node.state || 'Sin entrada recuperada' }, ...(node.children ?? []).flatMap(flatten)];
  editorialSectionsCache = orderedPhases().map(effectivePhase).flatMap((phase) => [
    { ...phase, phaseId: phase.id, phaseLabel: phase.label, isPhase: true },
    ...atlasNodesForPhase(phase).flatMap(flatten)
  ]);
  editorialSectionsCacheSource = entries;
  return editorialSectionsCache;
}

function getGuideNodeById(id) {
  const phase = GUIDE_PHASE_BY_ID.get(id);
  if (phase) return { ...effectivePhase(phase), phaseId: phase.id, phaseLabel: phase.label, isPhase: true };
  const preliminary = PGDG_PHASES.find((item) => item.entryNodes?.some((node) => node.id === id));
  if (preliminary) return atlasEntryNodesForPhase(preliminary).find((node) => node.id === id) ?? PRELIMINARY_ENTRY_NODES.get(id) ?? null;
  const node = editorialSections().find((node) => node.id === id) ?? GUIDE_NODE_BY_ID.get(id) ?? null;
  const number = currentAtlasNumbering()?.nodeNumbers.get(id);
  return node && number ? { ...node, number } : node;
}

function atlasEntryNodesForPhase(phase) {
  const nodes = (phase.entryNodes ?? []).map((node) => ({
    ...node,
    phaseId: phase.id,
    phaseLabel: phase.label,
    isAtlasEntry: true
  }));
  return applyCurrentAtlasNumbers(recalibrateAtlasNumbers(sortAtlasItems(nodes, 'nodes', phase.id), phase.number, phase.id));
}

function nextAtlasNodeNumber(parentId) {
  const phase = GUIDE_PHASE_BY_ID.has(parentId) ? effectivePhase(GUIDE_PHASE_BY_ID.get(parentId)) : null;
  const parent = phase || getGuideNodeById(parentId);
  const base = parent?.number;
  if (!base) return '';
  let siblings = phase ? atlasNodesForPhase(phase) : [];
  if (!phase) {
    const phaseTree = atlasNodesForPhase(GUIDE_PHASE_BY_ID.get(parent.phaseId));
    const findParent = (nodes) => {
      for (const node of nodes) {
        if (node.id === parentId) return node;
        const nested = findParent(node.children ?? []);
        if (nested) return nested;
      }
      return null;
    };
    siblings = findParent(phaseTree)?.children ?? [];
  }
  const prefix = base + '.';
  const nextIndex = siblings.reduce((max, sibling) => {
    if (!sibling.number?.startsWith(prefix)) return max;
    const suffix = sibling.number.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return max;
    return Math.max(max, Number(suffix));
  }, 0) + 1;
  return `${base}.${nextIndex}`;
}

function atlasNodesForPhase(phase) {
  phase = effectivePhase(phase);
  const customNodes = customAtlasNodes();
  const attachCustom = (node) => ({
    ...node,
    state: node.state || 'Sin entrada recuperada',
    phaseId: phase.id,
    phaseLabel: phase.label,
    children: [
      ...sortAtlasItems([
        ...(node.children ?? []),
        ...customNodes.filter((custom) => custom.parentId === node.id)
      ], 'nodes', node.id).map(attachCustom)
    ]
  });
  const roots = sortAtlasItems([
    ...phase.nodes.map(attachCustom),
    ...customNodes.filter((node) => node.parentId === phase.id || (!node.parentId && node.phaseId === phase.id)).map(attachCustom)
  ], 'nodes', phase.id);
  const originalNumber = GUIDE_PHASE_BY_ID.get(phase.id)?.number;
  return applyCurrentAtlasNumbers(recalibrateAtlasNumbers(roots, phase.number, phase.id, phase.number !== originalNumber));
}

function recalibrateAtlasNumbers(nodes, parentNumber, parentId, inheritedReorder = false) {
  const manuallyOrdered = Array.isArray(atlasOrderState.nodes[parentId]);
  const usedPositions = new Set();
  const childrenFor = (number) => `${number}.`;
  nodes.filter((node) => !node.isCustom).forEach((node) => {
    const prefix = childrenFor(parentNumber);
    if (!node.number?.startsWith(prefix)) return;
    const suffix = node.number.slice(prefix.length);
    const position = suffix.match(/^(\d+)(?:\.|$)/)?.[1];
    if (position) usedPositions.add(Number(position));
  });

  let nextPosition = 1;
  let sequentialPosition = 0;
  return nodes.map((node) => {
    let number = node.number || '';
    if (parentNumber && (manuallyOrdered || inheritedReorder)) {
      number = `${parentNumber}.${++sequentialPosition}`;
      usedPositions.add(sequentialPosition);
    } else if (node.isCustom && parentNumber) {
      while (usedPositions.has(nextPosition)) nextPosition += 1;
      number = `${parentNumber}.${nextPosition}`;
      usedPositions.add(nextPosition);
      nextPosition += 1;
    }
    const children = recalibrateAtlasNumbers(node.children ?? [], number || parentNumber, node.id, inheritedReorder || manuallyOrdered || number !== node.number);
    return { ...node, number, children };
  });
}

function atlasLocationForEntry(entry) {
  const assignedNode = guideNodeForEntry(entry);
  if (!assignedNode) return { nodeId: null, nodeIds: [], number: '', path: 'Por clasificar' };
  const phase = GUIDE_PHASE_BY_ID.get(assignedNode.phaseId);
  if (!phase) return { nodeId: assignedNode.id, nodeIds: [assignedNode.id], number: assignedNode.number || '', path: assignedNode.label };
  const findPath = (nodes, ancestors = []) => {
    for (const node of nodes) {
      const path = [...ancestors, node];
      if (node.id === assignedNode.id) return path;
      const childPath = findPath(node.children ?? [], path);
      if (childPath) return childPath;
    }
    return null;
  };
  const nodePath = findPath(atlasNodesForPhase(phase)) ?? [assignedNode];
  const labels = [phase.label, ...nodePath.map((node) => `${node.number ? node.number + ' · ' : ''}${node.label}`)];
  return { nodeId: assignedNode.id, nodeIds: nodePath.map((node) => node.id), number: nodePath.at(-1)?.number || assignedNode.number || '', path: labels.join(' › ') };
}

function atlasEntrySearchText(entry, locationNumber = guideNodeForEntry(entry)?.number) {
  const node = guideNodeForEntry(entry);
  return normalizeEditorialText([entry.title, displayEntryTitle(entry), locationNumber, node?.number, entry.type, entry.area, entry.content, ...(entry.tags ?? [])].join(' '));
}

function guideNodeForEntry(entry) {
  const explicitlyAssignedNode = getGuideNodeById(entry.guideNodeId);
  if (explicitlyAssignedNode) return explicitlyAssignedNode;
  const title = normalizeEditorialText(entry.title);
  const preliminaryEntry = PGDG_PHASES.flatMap(atlasEntryNodesForPhase).find((node) => normalizeEditorialText(node.label) === title);
  if (preliminaryEntry) return preliminaryEntry;
  const content = normalizeEditorialText(entry.content).slice(0, 800);
  if (entry.type === 'Fuente' || /^(referencias?|listado de referencias|bibliografia)\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-19');
  if (/creditos? de figuras/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-20');
  if (/^introduccion\b/.test(title)) return getGuideNodeById('introduccion');
  if (/^(indice|indice del proyecto)\b/.test(title)) return getGuideNodeById('indice');
  if (/^(caratula|portada)\b/.test(title) || /^intervencion de diseno para mitigar/.test(title)) return getGuideNodeById('portada');
  if (/^por: josue david diaz ponce\b/.test(title)) return getGuideNodeById('portada');
  if (/^anexos$/.test(title)) return getGuideNodeById('anexos');
  if (/^canastos para organizar\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-1');
  if (/^instrumento de diagnostico de grupo objetivo\b/.test(title)) return GUIDE_NODE_BY_ID.get('annex-14');
  if (/^infografia de grupo objetivo\b/.test(title)) return GUIDE_NODE_BY_ID.get('audience-infographic');
  if (/^resultados? diagnostico de grupo objetivo\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-6-results');
  if (/^grupo objetivo$/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-6');
  if (/^el grupo objetivo\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-6');
  if (/^perfiles? del grupo objetivo\b/.test(title)) return GUIDE_NODE_BY_ID.get('audience-profiles');
  if (/^(aliado estrategico|1\. propuesta de aliados estrategicos|propuesta de aliados estrategicos)\b/.test(title)) return GUIDE_NODE_BY_ID.get('strategic-partners-proposal');
  if (/^solicitud(?:es)? de alianza estrategica\b/.test(title)) return GUIDE_NODE_BY_ID.get('strategic-partners-proposal');
  if (/^3\.1\s*sujetos de estudio/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-3-1');
  if (/^3\.2\s*objetos de estudio/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-3-2');
  if (/^3\.3\s*instrumentos/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-3-3');
  if (/^4\.1\b/.test(title) || /^clutter \(desorden/.test(title)) return GUIDE_NODE_BY_ID.get('reference-clutter');
  if (/^4\.2\b/.test(title)) return GUIDE_NODE_BY_ID.get('reference-disorganization');
  if (/^4\.3\b/.test(title)) return GUIDE_NODE_BY_ID.get('reference-wellbeing');
  if (/^4\.4\b/.test(title)) return GUIDE_NODE_BY_ID.get('reference-minimalism');
  if (/^4\.5\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-4-local');
  if (/^4\.[67]\b/.test(title)) return GUIDE_NODE_BY_ID.get('reference-subject');
  if (/^5\.1\b/.test(title)) return GUIDE_NODE_BY_ID.get('design-campaigns');
  if (/^5\.2\b/.test(title)) return GUIDE_NODE_BY_ID.get('design-websites');
  if (/^5\.3\b/.test(title)) return GUIDE_NODE_BY_ID.get('design-audiovisual');
  if (/^5\.4\b/.test(title)) return GUIDE_NODE_BY_ID.get('design-editorial');
  if (/^5\.5\b/.test(title)) return GUIDE_NODE_BY_ID.get('design-illustration');
  if (/^5\.7\s*sujeto de estudio/.test(title)) return GUIDE_NODE_BY_ID.get('design-subject');
  if (/^5\.7\s*analisis|^3\.2\.3\b|^antecedentes del extranjero/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-5-foreign');
  if (/^anexo\b.*resultados del caso del extranjero 1/.test(title)) return GUIDE_NODE_BY_ID.get('annex-11');
  if (/^anexo\b.*resultados del caso del extranjero 2/.test(title)) return GUIDE_NODE_BY_ID.get('annex-12');
  if (/^anexo\b.*resultados del caso del extranjero 3/.test(title)) return GUIDE_NODE_BY_ID.get('annex-13');
  if (/^5\.6\.1\b/.test(title)) return GUIDE_NODE_BY_ID.get('case-kondo');
  if (/^5\.6\.2\b/.test(title)) return GUIDE_NODE_BY_ID.get('case-becker');
  if (/^5\.6\.3\b/.test(title)) return GUIDE_NODE_BY_ID.get('case-sasaki');
  if (/^5\.7\s*sujeto de estudio/.test(title)) return GUIDE_NODE_BY_ID.get('design-subject');
  if (/^marco de diseno\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-5');
  if (/^marco de referencia\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-4');
  if (/^3\.2\.3\b|^5\.7\s*analisis|^antecedentes del extranjero/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-5-foreign');
  if (/observacion del objeto de estudio 1/.test(content)) return GUIDE_NODE_BY_ID.get('annex-08');
  if (/observacion del objeto de estudio 2/.test(content)) return GUIDE_NODE_BY_ID.get('annex-09');
  if (/observacion del objeto de estudio 3/.test(content)) return GUIDE_NODE_BY_ID.get('annex-10');
  if (/^(instrumento|entrevista|preguntas y respuestas)\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-21');
  if (/^anexo\b/.test(title)) return null;
  if (/^(conclusiones|conclusiones y recomendaciones|recomendaciones)\b/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-8');
  if (/^4\./.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-4');
  if (/^5\./.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-5');
  if (/^(3\.\s*metodologia|metodologia de investigacion|3\. metodologia)/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-3');
  if (/^(2\.\s*preguntas y objetivos|preguntas y objetivos|0[12]\. pregunta|0[12]\. objetivo)/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-2');
  if (/^(1\.\s*planteamiento|planteamiento y objetivos de investigacion|mencionarlo en el planteamiento)/.test(title)
    || (entry.id?.startsWith('idml-r1-') && title.startsWith('el clutter y la desorganizacion'))) return GUIDE_NODE_BY_ID.get('pgdg-1');
  if (/para el marco de diseno/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-5');
  if (/para el diagnostico/.test(title)) return GUIDE_NODE_BY_ID.get('pgdg-3');
  if (/clutter|problematica/.test(content)) return GUIDE_NODE_BY_ID.get('pgdg-1');
  return null;
}

function editorialSection(entry) {
  const node = guideNodeForEntry(entry);
  return node ? { id: node.id, phaseId: node.phaseId } : { id: 'sin-clasificar', phaseId: 'sin-clasificar' };
}

function entryMatchesSelection(entry, selectionId) {
  if (!isAtlasBibliographyEntryVisible(entry)) return false;
  const node = guideNodeForEntry(entry);
  const phase = GUIDE_PHASE_BY_ID.get(selectionId);
  if (phase?.id === 'sin-clasificar') return !node || node.phaseId === phase.id;
  return phase ? node?.phaseId === phase.id : node?.id === selectionId;
}

function sectionEntryCount(sectionId) {
  return entries.filter((entry) => entryMatchesSelection(entry, sectionId)).length;
}

function createReadingEntry(entry, { focused = false } = {}) {
  const row = document.createElement('div');
  row.className = 'atlas-entry-row';
  const button = document.createElement('button');
  button.className = 'chapter-entry atlas-entry-link' + (focused ? ' is-atlas-focused' : '');
  button.type = 'button';
  button.dataset.entryId = entry.id;
  const location = atlasLocationForEntry(entry);
  const node = guideNodeForEntry(entry);
  if (node?.isAtlasEntry) {
    button.draggable = true;
    button.dataset.atlasDragKind = 'outline-entry-node';
    button.dataset.atlasNodeId = node.id;
    button.dataset.atlasParentId = node.phaseId;
    button.title = 'Arrastra para cambiar la posición en el Atlas';
  } else if (node) {
    button.draggable = true;
    button.dataset.atlasDragKind = 'entry';
    button.dataset.atlasParentId = node.id;
    button.title = 'Arrastra para reordenar o cambiar de apartado';
  }
  const title = displayEntryTitle(entry);
  const numberPrefix = node?.isAtlasEntry && node.number ? `${node.number} ` : '';
  const atlasTitle = numberPrefix && title.startsWith(numberPrefix) ? title.slice(numberPrefix.length) : title;
  const entryContext = [entry.type.toLocaleUpperCase('es'), entry.area?.replace(/^Origen IDML · Story /, 'ORIGEN IDML · ')].filter(Boolean).join(' · ');
  const isOutlineScaffold = entry.outlineScaffold === true;
  button.classList.toggle('is-outline-scaffold', isOutlineScaffold);
  if (isOutlineScaffold) button.classList.add('has-atlas-marker');
  button.setAttribute('aria-label', `${location.number ? `Apartado ${location.number}` : 'Sin apartado'}: ${atlasTitle}. ${entryContext}${isOutlineScaffold ? '. Marcador estructural; contenido académico pendiente.' : ''}${focused ? '. Entrada actual' : ''}. Abrir en Entradas.`);
  button.innerHTML = `<span class="chapter-entry-kind">${escapeHTML(entryContext)}</span><span class="atlas-entry-location">${location.number ? escapeHTML(location.number) : '—'}</span><strong>${escapeHTML(atlasTitle)}</strong>${isOutlineScaffold ? '<span class="atlas-entry-marker" aria-label="Marcador estructural sin texto">MARCADOR</span>' : ''}<span class="chapter-entry-open" aria-hidden="true">→</span>`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'atlas-delete-entry';
  remove.dataset.deleteEntry = entry.id;
  remove.setAttribute('aria-label', `Borrar entrada: ${atlasTitle}`);
  remove.title = 'Borrar entrada';
  remove.textContent = '×';
  row.append(button, remove);
  return row;
}

function updateViewHeading() {
  if (!$('#view-title')) {
    const accessiblePageTitle = $('#app-page-title');
    accessiblePageTitle.textContent = showHomePage ? 'Proyecto de grado' : showAtlasHome ? 'Atlas del proyecto' : showApaAudit ? 'Cotejo de citas APA 7' : showEntryWorkspace ? 'Lectura de entradas del proyecto' : 'Proyecto de grado';
    accessiblePageTitle.hidden = !(showHomePage || showAtlasHome || showEntryWorkspace || showFigureCredits || showApaAudit);
    return;
  }
  const section = editorialSections().find((item) => item.id === activeSection);
  const phase = effectivePhase(GUIDE_PHASE_BY_ID.get(activeSection));
  const activeLabel = section?.label ?? phase?.label;
  $('#view-kicker').textContent = showHomePage ? 'INICIO · PROYECTO DE GRADO' : showAtlasHome ? 'ATLAS · ESTRUCTURA INDB' : showFigureCredits ? 'CIERRE DOCUMENTAL · PGDG 2026' : showApaAudit ? 'COTEJO DOCUMENTAL · APA 7' : activeLabel ? 'RECORRIDO · ' + activeLabel.toLocaleUpperCase('es') : 'LECTURA DEL PROYECTO';
  $('#view-title').textContent = showHomePage ? 'Inicio' : showAtlasHome ? 'Atlas del proyecto' : showFigureCredits ? 'Créditos de figuras' : showApaAudit ? 'Cotejo de citas APA 7' : activeLabel ?? (activeFilter === 'source' ? 'Fuentes APA 7' : activeFilter === 'task' ? 'Coordinación' : activeFilter === 'writing' ? 'Notas y decisiones' : 'Todas las entradas');
  const accessiblePageTitle = $('#app-page-title');
  accessiblePageTitle.textContent = showHomePage ? 'Proyecto de grado' : showAtlasHome ? 'Atlas del proyecto' : showEntryWorkspace ? 'Lectura de entradas del proyecto' : $('#view-title').textContent;
  accessiblePageTitle.hidden = !(showHomePage || showAtlasHome || showEntryWorkspace || showFigureCredits || showApaAudit);
  $('#view-description').textContent = showHomePage ? 'Visión general y accesos al material del proyecto.' : showAtlasHome ? 'Navega el orden definitivo de los documentos del libro de InDesign.' : showFigureCredits ? 'Listado generado desde los metadatos de las imágenes añadidas a las copias locales. Revisa cada fuente, permiso y formato antes de entregar.' : showApaAudit ? 'Cotejo preliminar de las citas detectadas y el inventario histórico de referencias.' : section?.detail ?? section?.description ?? (activeFilter === 'all'
    ? 'Lectura editorial continua: recorre las entradas en orden y sigue bajando para cargar más.'
    : activeFilter === 'source' ? 'Referencias y fuentes relacionadas con el contenido del proyecto.'
      : activeFilter === 'task' ? 'Pendientes para recuperar, verificar y completar el proyecto.'
        : 'Apuntes y decisiones transversales del proyecto.');
}

function renderAtlasOverview() {
  const atlasMount = $('#atlas-view-mount');
  const homeVisible = showHomePage && !activeSection;
  const headingMount = $('#view-heading-mount');
  const headingShouldMount = !homeVisible && !showEntryWorkspace && !showFigureCredits && !showApaAudit;
  if (headingShouldMount && !$('.page-heading')) {
    headingMount.replaceChildren($('#view-heading-template').content.cloneNode(true));
  } else if (!headingShouldMount && headingMount.childElementCount) {
    headingMount.replaceChildren();
  }
  const atlasShouldMount = !showHomePage && showAtlasHome && activeFilter === 'all' && !searchTerm.trim();
  if (atlasShouldMount && !$('#atlas-overview')) {
    atlasMount.replaceChildren($('#atlas-overview-template').content.cloneNode(true));
    $('#library-home').addEventListener('click', () => {
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      showEntryWorkspace = true;
      activeSection = null;
      activeFilter = 'all';
      renderList();
    });
    $('#atlas-search').addEventListener('input', (event) => {
      atlasSearchTerm = event.target.value;
      atlasFocusEntryId = null;
      renderList();
    });
  } else if (!atlasShouldMount && atlasMount.childElementCount) {
    atlasMount.replaceChildren();
  }
  const visible = !homeVisible && showAtlasHome && activeFilter === 'all' && !searchTerm.trim();
  const section = !homeVisible && !visible && activeSection && activeFilter === 'all' && !showEntryWorkspace && !searchTerm.trim();
  $('#home-page').hidden = !homeVisible;
  $('#section-detail').hidden = !section;
  const creditsVisible = showFigureCredits;
  const creditsPage = $('#figure-credits-page');
  if (creditsPage) creditsPage.hidden = !creditsVisible;
  const apaAuditPage = $('#apa-audit-page');
  if (apaAuditPage) apaAuditPage.hidden = !showApaAudit;
  const workspaceGrid = $('.workspace-grid');
  if (workspaceGrid) workspaceGrid.hidden = homeVisible || visible || section || creditsVisible || showApaAudit;
  const pageFooter = $('.page-footer');
  if (pageFooter) pageFooter.hidden = homeVisible || visible || section || creditsVisible || showApaAudit;
  const pageHeading = $('.page-heading');
  if (pageHeading) pageHeading.hidden = homeVisible || showEntryWorkspace || creditsVisible || showApaAudit;
  document.querySelector('.workspace').classList.toggle('is-atlas', homeVisible || visible || section);
  document.querySelector('.app-shell').classList.toggle('is-atlas', homeVisible || visible || section);
  const backButton = $('#back-to-section');
  if (backButton) {
    backButton.hidden = !showEntryWorkspace || !entryOpenedFromAtlas;
    backButton.textContent = entryOpenedFromAtlas ? '← Volver al atlas' : '← Volver a la sección';
  }
  document.querySelectorAll('#nav-list [data-filter]').forEach((button) => {
    const activeView = showHomePage ? 'home' : showAtlasHome ? 'atlas' : showFigureCredits ? 'figure-credits' : showApaAudit ? 'apa-audit' : activeFilter;
    button.classList.toggle('is-active', button.dataset.filter === activeView);
  });
  if (homeVisible) {
    return;
  }
  if (!visible) {
    if (section) renderSectionDetail();
    return;
  }
  const countNodes = (nodes) => nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0);
  const phases = orderedPhases().map(effectivePhase);
  const outlineCount = phases.reduce((total, phase) => total + countNodes(atlasNodesForPhase(phase)), 0);
  const activePhaseCount = phases.filter((phase) => phase.id !== 'sin-clasificar' && entries.some((entry) => entryMatchesSelection(entry, phase.id))).length;
  $('#atlas-summary').innerHTML = '<span><strong>' + entries.length + '</strong> entradas en biblioteca</span><span><strong>' + outlineCount + '</strong> apartados en el índice</span><span><strong>' + activePhaseCount + '</strong> fases con material</span>';
  const query = normalizeEditorialText(atlasSearchTerm.trim());
  const host = $('#atlas-phase-grid');
  const resultHost = $('#atlas-search-results');
  host.replaceChildren();
  const locationCache = new Map();
  const locationForEntry = (entry) => {
    if (!locationCache.has(entry.id)) locationCache.set(entry.id, atlasLocationForEntry(entry));
    return locationCache.get(entry.id);
  };
  const queryMatches = (entry) => !query || atlasEntrySearchText(entry, locationForEntry(entry).number).includes(query);
  const matchingEntries = entries.filter(queryMatches).sort(compareEntriesByReadingOrder);
  const matchCount = matchingEntries.length;
  resultHost.hidden = !query;
  resultHost.replaceChildren();
  if (query) {
    const heading = document.createElement('div');
    heading.className = 'atlas-search-results-heading';
    heading.innerHTML = `<strong>Coincidencias en las entradas</strong><span>${matchCount ? `${matchCount} ${matchCount === 1 ? 'resultado' : 'resultados'} · desplázate para verlos` : 'Sin resultados'}</span>`;
    resultHost.append(heading);
    if (matchCount) {
      const list = document.createElement('div');
      list.className = 'atlas-search-result-list';
      matchingEntries.forEach((entry) => {
        const location = locationForEntry(entry);
        const result = document.createElement('button');
        result.className = 'atlas-search-result';
        result.type = 'button';
        result.dataset.atlasFocusEntry = entry.id;
        result.innerHTML = `<span class="atlas-search-result-number">${location.number ? escapeHTML(location.number) : '—'}</span><span class="atlas-search-result-copy"><strong>${escapeHTML(displayEntryTitle(entry))}</strong><small>${escapeHTML(location.path)} · ${escapeHTML(entry.type)}</small></span><span class="atlas-search-result-arrow" aria-hidden="true">↗</span>`;
        list.append(result);
      });
      resultHost.append(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'atlas-search-empty';
      empty.textContent = 'No hay entradas que coincidan. Prueba con otro número, título o término.';
      resultHost.append(empty);
    }
  }
  phases.forEach((phase) => {
    const phaseEntries = entries.filter((entry) => entryMatchesSelection(entry, phase.id));
    const phaseMatches = query ? phaseEntries.filter(queryMatches) : phaseEntries;
    if (query && phaseMatches.length === 0) return;
    const flattenNodes = (nodes) => nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
    const phaseNodes = flattenNodes(atlasNodesForPhase(phase));
    const populatedNodes = new Set(phaseEntries.flatMap((entry) => locationForEntry(entry).nodeIds));
    const pendingCount = phaseNodes.filter((node) => !populatedNodes.has(node.id) && (node.state === 'Pendiente' || node.state === 'No mapeada' || node.state === 'Importación incompleta' || node.state === 'Sin entrada recuperada')).length;
    const needsClassification = phase.id === 'sin-clasificar' && phaseEntries.length > 0;
    const card = document.createElement('details');
    card.className = 'atlas-phase-disclosure';
    const phaseShell = document.createElement('div');
    phaseShell.className = 'atlas-phase-shell';
    card.open = Boolean(query) || atlasExpandedPhases.has(phase.id);
    card.addEventListener('toggle', () => {
      if (query) return;
      if (card.open) atlasExpandedPhases.add(phase.id);
      else atlasExpandedPhases.delete(phase.id);
    });
    const cardSummary = document.createElement('summary');
    cardSummary.className = 'atlas-card';
    if (phase.id === 'preliminares' || phase.id === 'sin-clasificar' || phase.marker.startsWith('CAPÍTULO')) {
      cardSummary.draggable = true;
      cardSummary.dataset.atlasDragKind = 'phase';
      cardSummary.dataset.atlasPhaseId = phase.id;
      cardSummary.dataset.atlasParentId = '__book__';
      cardSummary.title = 'Arrastra para cambiar la posición de este bloque del libro';
    }
    cardSummary.setAttribute('aria-label', query
      ? `${phase.label}, ${phaseMatches.length} de ${phaseEntries.length} entradas coinciden`
      : `${phase.label}, ${phaseEntries.length} entradas`);
    const state = needsClassification ? 'Por clasificar' : pendingCount ? `${pendingCount} apartados sin entrada` : phaseEntries.length ? 'Material localizado' : 'Sin entradas recuperadas';
    const entryCountLabel = query
      ? `${phaseMatches.length} de ${phaseEntries.length} entradas coinciden`
      : `${phaseEntries.length} entradas`;
    cardSummary.innerHTML = `<span class="atlas-card-index">${escapeHTML(phase.marker)}</span><span class="atlas-card-glyph" aria-hidden="true">${escapeHTML(phase.glyph)}</span><span class="atlas-card-copy"><h3>${escapeHTML(phase.label)}</h3><p>${escapeHTML(phase.description)}</p></span><span class="atlas-card-bottom"><span>${phaseNodes.length} apartados · ${entryCountLabel}</span><span class="atlas-card-state${pendingCount || needsClassification ? ' is-pending' : ''}">${escapeHTML(state)}</span></span><span class="atlas-card-arrow" aria-hidden="true">→</span>`;
    card.append(cardSummary);
    if (phase.marker.startsWith('CAPÍTULO')) {
      const removeChapter = document.createElement('button');
      removeChapter.type = 'button';
      removeChapter.className = 'atlas-delete-phase';
      removeChapter.dataset.deletePhase = phase.id;
      removeChapter.setAttribute('aria-label', `Borrar capítulo: ${phase.label}`);
      removeChapter.title = 'Borrar capítulo';
      removeChapter.textContent = 'Borrar';
      phaseShell.append(removeChapter);
    }
    const outline = document.createElement('div');
    outline.className = 'atlas-inline-outline';
    const focusEntry = atlasFocusEntryId ? entries.find((entry) => entry.id === atlasFocusEntryId) : null;
    const focusNode = focusEntry ? guideNodeForEntry(focusEntry) : null;
    const focusPath = new Set();
    if (focusNode) {
      const findFocusPath = (nodes, ancestors = []) => {
        for (const node of nodes) {
          const path = [...ancestors, node.id];
          if (node.id === focusNode.id) {
            path.forEach((id) => focusPath.add(id));
            return true;
          }
          if (findFocusPath(node.children ?? [], path)) return true;
        }
        return false;
      };
      findFocusPath(atlasNodesForPhase(phase));
    }
    phaseEntries.filter((entry) => guideNodeForEntry(entry)?.isAtlasEntry && queryMatches(entry))
      .sort((a, b) => guideNodeForEntry(a).number.localeCompare(guideNodeForEntry(b).number, 'es', { numeric: true }))
      .forEach((entry) => {
        outline.append(createReadingEntry(entry, { focused: entry.id === atlasFocusEntryId }));
      });
    atlasNodesForPhase(phase).forEach((node) => renderOutlineNode(outline, node, query, {
      focusPath,
      focusEntryId: atlasFocusEntryId,
      locationForEntry,
    }));
    const unassignedEntries = phaseEntries.filter((entry) => !guideNodeForEntry(entry));
    if (unassignedEntries.length) {
      const unassigned = document.createElement('details');
      unassigned.className = 'atlas-subchapter atlas-unassigned-entries';
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="chapter-marker">SIN APARTADO</span><strong>Entradas sin ubicación asignada</strong><span class="chapter-count">${unassignedEntries.length}</span><span class="chapter-chevron" aria-hidden="true">⌄</span>`;
      unassigned.append(summary);
      const body = document.createElement('div');
      body.className = 'chapter-entries outline-node-body';
      unassignedEntries.filter(queryMatches).forEach((entry) => body.append(createReadingEntry(entry, { focused: entry.id === atlasFocusEntryId })));
      unassigned.append(body);
      outline.append(unassigned);
    }
    card.append(outline);
    phaseShell.append(card);
    host.append(phaseShell);
  });
  $('#atlas-result-count').textContent = query
    ? matchCount === 0
      ? '0 entradas coinciden. Borra la búsqueda para ver todos los apartados.'
      : `${matchCount} ${matchCount === 1 ? 'entrada coincide' : 'entradas coinciden'}`
    : '';
  if (atlasFocusNeedsScroll && atlasFocusEntryId) {
    atlasFocusNeedsScroll = false;
    requestAnimationFrame(() => host.querySelector('.atlas-entry-link.is-atlas-focused')?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' }));
  }
}

function setAtlasDisclosureState(open) {
  document.querySelectorAll('#chapter-list details').forEach((section) => {
    section.open = open;
  });
}

function updateReaderSequenceRail(activeId = selectedId) {
  const rail = $('#reader-sequence-rail');
  if (!rail || !libraryMounted || !showEntryWorkspace) return;
  const activeEntry = listEntrySnapshot.find((entry) => entry.id === activeId) ?? listEntrySnapshot[0];
  const activeNode = activeEntry ? guideNodeForEntry(activeEntry) : null;
  const railEntries = activeNode
    ? listEntrySnapshot.filter((entry) => guideNodeForEntry(entry)?.id === activeNode.id)
    : activeSection ? listEntrySnapshot : [];
  rail.hidden = !railEntries.length;
  rail.closest('.library-feed-page')?.classList.toggle('has-sequence-rail', railEntries.length > 0);
  if (!railEntries.length) return;
  const phaseGroups = $('#reader-phase-groups');
  const chapterTrees = orderedPhases().map(effectivePhase).map((phase) => ({ phase, nodes: [...atlasEntryNodesForPhase(phase), ...atlasNodesForPhase(phase)] }))
    .filter(({ phase, nodes }) => phase.id !== 'sin-clasificar' && nodes.length);
  const nodeSignature = (node) => `${node.id}:${node.number}:${listEntrySnapshot.filter((entry) => guideNodeForEntry(entry)?.id === node.id).length}[${(node.children ?? []).map(nodeSignature).join(',')}]`;
  const phaseGroupsKey = chapterTrees.map(({ phase, nodes }) => `${phase.id}:${nodes.map(nodeSignature).join('|')}`).join('||');
  if (phaseGroups.dataset.optionsKey !== phaseGroupsKey) {
    phaseGroups.replaceChildren();
    const appendChapterNode = (node, host) => {
      const item = document.createElement('div');
      item.className = 'reader-outline-item';
      item.dataset.guideNodeId = node.id;
      const row = document.createElement('div');
      row.className = 'reader-outline-row';
      const nodeEntries = listEntrySnapshot.filter((entry) => guideNodeForEntry(entry)?.id === node.id);
      const button = document.createElement('button');
      button.className = 'reader-phase-chapter';
      button.type = 'button';
      button.dataset.guideNodeId = node.id;
      button.disabled = !nodeEntries.length;
      button.setAttribute('aria-current', node.id === activeNode?.id ? 'page' : 'false');
      button.innerHTML = `<span class="reader-phase-chapter-number">${escapeHTML(node.number || '·')}</span><span class="reader-phase-chapter-label">${escapeHTML(node.label)}</span><small>${nodeEntries.length}</small>`;
      row.append(button);
      item.append(row);
      if (node.children?.length) {
        const toggle = document.createElement('button');
        toggle.className = 'reader-outline-toggle';
        toggle.type = 'button';
        toggle.dataset.toggleOutlineNode = node.id;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', `Desplegar apartados de ${node.number ? node.number + ' ' : ''}${node.label}`);
        toggle.textContent = '⌄';
        row.append(toggle);
        const children = document.createElement('div');
        children.className = 'reader-outline-children';
        children.hidden = true;
        node.children.forEach((child) => appendChapterNode(child, children));
        item.append(children);
      }
      host.append(item);
    };
    chapterTrees.forEach(({ phase, nodes }) => {
      const group = document.createElement('details');
      group.className = 'reader-phase-group';
      group.dataset.phaseId = phase.id;
      const summary = document.createElement('summary');
      const marker = phase.number ? `${phase.number} ·` : 'FASE';
      summary.innerHTML = `<span class="reader-phase-marker">${escapeHTML(marker)}</span><strong>${escapeHTML(phase.label)}</strong><small>${nodes.length}</small>`;
      const list = document.createElement('nav');
      list.className = 'reader-phase-chapters';
      list.setAttribute('aria-label', `Jerarquía de apartados de ${phase.label}`);
      nodes.forEach((node) => appendChapterNode(node, list));
      group.append(summary, list);
      phaseGroups.append(group);
    });
    phaseGroups.dataset.optionsKey = phaseGroupsKey;
    phaseGroups.dataset.activePhaseId = '';
  }
  const activePath = new Set();
  const findActivePath = (nodes, ancestors = []) => {
    for (const node of nodes) {
      const path = [...ancestors, node.id];
      if (node.id === activeNode?.id) {
        path.forEach((id) => activePath.add(id));
        return true;
      }
      if (findActivePath(node.children ?? [], path)) return true;
    }
    return false;
  };
  chapterTrees.forEach(({ nodes }) => findActivePath(nodes));
  phaseGroups.querySelectorAll('.reader-phase-chapter').forEach((button) => {
    const current = button.dataset.guideNodeId === activeNode?.id;
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    const item = button.closest('.reader-outline-item');
    const children = item?.querySelector(':scope > .reader-outline-children');
    const toggle = item?.querySelector(':scope > .reader-outline-row > .reader-outline-toggle');
    if (children && toggle && activePath.has(button.dataset.guideNodeId)) {
      children.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', `Cerrar apartados de ${button.querySelector('.reader-phase-chapter-label')?.textContent || 'este apartado'}`);
    }
  });
  const activePhaseId = activeNode?.phaseId ?? '';
  if (phaseGroups.dataset.activePhaseId !== activePhaseId) {
    phaseGroups.dataset.activePhaseId = activePhaseId;
    phaseGroups.querySelectorAll('.reader-phase-group').forEach((group) => {
      group.open = group.dataset.phaseId === activePhaseId;
    });
  }
  if (!readerRailFollowScheduled) {
    readerRailFollowScheduled = true;
    requestAnimationFrame(() => {
      readerRailFollowScheduled = false;
      if (!phaseGroups.isConnected) return;
      const currentChapter = phaseGroups.querySelector('.reader-phase-chapter[aria-current="page"]');
      if (!currentChapter || !phaseGroups.clientHeight) return;
      const menuRect = phaseGroups.getBoundingClientRect();
      const chapterRect = currentChapter.getBoundingClientRect();
      const visibleTop = menuRect.top + phaseGroups.clientTop;
      const visibleHeight = phaseGroups.clientHeight;
      const visibleCenter = visibleTop + visibleHeight / 2;
      const chapterCenter = chapterRect.top + chapterRect.height / 2;
      const scrollDelta = chapterCenter - visibleCenter;
      if (Math.abs(scrollDelta) > 2) phaseGroups.scrollTop += scrollDelta;
    });
  }
  const groupId = activeNode?.id ?? activeSection ?? 'all';
  if (rail.dataset.groupId !== groupId) {
    rail.dataset.groupId = groupId;
    const title = $('#reader-sequence-title');
    title.textContent = activeNode?.label ?? GUIDE_PHASE_BY_ID.get(activeSection)?.label ?? 'Entradas del proyecto';
    const navs = [$('#reader-sequence-links'), $('#reader-mobile-sequence-links')].filter(Boolean);
    navs.forEach((nav) => nav.replaceChildren());
    railEntries.forEach((entry) => {
      navs.forEach((nav) => {
        const item = document.createElement('a');
        item.className = 'reader-sequence-link';
        item.href = `#entry=${encodeURIComponent(entry.id)}`;
        item.dataset.entryId = entry.id;
        item.innerHTML = `<span class="reader-sequence-number">${String(railEntries.indexOf(entry) + 1).padStart(4, '0')}</span><span class="reader-sequence-label">${escapeHTML(displayEntryTitle(entry))}</span>`;
        nav.append(item);
      });
    });
  }
  const activeIndex = railEntries.findIndex((entry) => entry.id === activeId);
  $('#reader-sequence-progress').textContent = activeIndex >= 0 ? `Entrada ${activeIndex + 1} de ${railEntries.length}` : `${railEntries.length} entradas`;
  const mobileIndex = $('#reader-mobile-entry-index');
  if (mobileIndex) {
    const compact = window.matchMedia('(max-width: 760px)').matches;
    if (mobileIndex.dataset.layout !== String(compact)) {
      mobileIndex.dataset.layout = String(compact);
      mobileIndex.open = !compact;
    }
    $('#reader-mobile-current-entry').textContent = activeEntry ? displayEntryTitle(activeEntry) : 'Entrada actual';
    $('#reader-mobile-entry-progress').textContent = activeIndex >= 0 ? `Entrada ${activeIndex + 1} de ${railEntries.length}` : `${railEntries.length} entradas`;
  }
  rail.querySelectorAll('.reader-sequence-link').forEach((link) => {
    const current = link.dataset.entryId === activeId;
    link.classList.toggle('is-active', current);
    if (current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

function syncReaderSequenceFromViewport() {
  if (!libraryMounted || !showEntryWorkspace || !listEntrySnapshot.length) return;
  const candidates = [...entryList.querySelectorAll('.feed-entry')];
  const active = candidates.find((article) => {
    const rect = article.getBoundingClientRect();
    return rect.top <= window.innerHeight * 0.42 && rect.bottom > window.innerHeight * 0.25;
  }) ?? candidates.find((article) => article.getBoundingClientRect().top > 0);
  if (active?.dataset.entryId) {
    updateReaderSequenceRail(active.dataset.entryId);
    if (pendingEntryLocationId) {
      if (active.dataset.entryId !== pendingEntryLocationId) return;
      pendingEntryLocationId = null;
      clearTimeout(pendingEntryLocationTimer);
    }
    if (pendingFigureLocation && active.dataset.entryId !== pendingFigureLocation.entryId) pendingFigureLocation = null;
    if (pendingTocLocation && active.dataset.entryId !== pendingTocLocation.entryId) pendingTocLocation = null;
    setEntryLocation(active.dataset.entryId, 'replace');
  }
}

function setEntryLocation(
  id,
  mode = 'replace',
  figureKey = pendingFigureLocation?.entryId === id ? pendingFigureLocation.figureKey : null,
  figureIndexKey = pendingFigureIndexLocation?.entryId === id ? pendingFigureIndexLocation.figureKey : null,
  apaTargetId = pendingApaNavigationTarget?.entryId === id ? pendingApaNavigationTarget.targetId : null,
  tocTargetId = pendingTocLocation?.entryId === id ? pendingTocLocation.targetId : null
) {
  if (!id || !globalThis.history?.[`${mode}State`]) return;
  const hash = `#entry=${encodeURIComponent(id)}${figureKey ? `&figure=${encodeURIComponent(figureKey)}` : ''}${figureIndexKey ? `&figure-index=${encodeURIComponent(figureIndexKey)}` : ''}${apaTargetId ? `&apa-target=${encodeURIComponent(apaTargetId)}` : ''}${tocTargetId ? `&toc-target=${encodeURIComponent(tocTargetId)}` : ''}`;
  if (location.hash === hash) return;
  history[`${mode}State`]({ ...(history.state ?? {}), entryId: id }, '', `${location.pathname}${location.search}${hash}`);
}

function clearEntryLocation(mode = 'replace') {
  pendingFigureLocation = null;
  pendingFigureIndexLocation = null;
  pendingApaNavigationTarget = null;
  pendingTocLocation = null;
  if (!location.hash.startsWith('#entry=') || !globalThis.history?.[`${mode}State`]) return;
  history[`${mode}State`]({ ...(history.state ?? {}), entryId: null }, '', `${location.pathname}${location.search}`);
}

function entryIdFromLocation() {
  if (!location.hash.startsWith('#entry=')) return null;
  return new URLSearchParams(location.hash.slice(1)).get('entry');
}

let pendingFigureLocation = null;
let pendingFigureIndexLocation = null;
let pendingApaNavigationTarget = null;
let pendingTocLocation = null;

function figureLocationFromHash() {
  if (!location.hash.startsWith('#entry=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const entryId = params.get('entry');
  const figureKey = params.get('figure');
  return entryId && figureKey ? { entryId, figureKey } : null;
}

function figureIndexLocationFromHash() {
  if (!location.hash.startsWith('#entry=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const entryId = params.get('entry');
  const figureKey = params.get('figure-index');
  return entryId && figureKey ? { entryId, figureKey } : null;
}

function apaNavigationTargetFromHash() {
  if (!location.hash.startsWith('#entry=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const entryId = params.get('entry');
  const targetId = params.get('apa-target');
  return entryId && targetId ? { entryId, targetId } : null;
}

function tocNavigationTargetFromHash() {
  if (!location.hash.startsWith('#entry=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const entryId = params.get('entry');
  const targetId = params.get('toc-target');
  return entryId && targetId ? { entryId, targetId } : null;
}

function figureIndexItemId(figureKey) {
  return `reader-figure-index-${encodeURIComponent(figureKey)}`;
}

function setFigureIndexLocation(entryId, figureKey, mode = 'push') {
  pendingFigureLocation = null;
  pendingFigureIndexLocation = { entryId, figureKey };
  setEntryLocation(entryId, mode, null, figureKey);
}

function setApaNavigationLocation(entryId, targetId, mode = 'push') {
  pendingFigureLocation = null;
  pendingFigureIndexLocation = null;
  pendingApaNavigationTarget = { entryId, targetId };
  setEntryLocation(entryId, mode, null, null, targetId);
  showEntryById(entryId);
}

function contentsIndexItemId(targetId) {
  return `reader-contents-index-${encodeURIComponent(targetId)}`;
}

function setContentsIndexLocation(entryId, targetId, mode = 'push') {
  pendingFigureLocation = null;
  pendingFigureIndexLocation = null;
  pendingApaNavigationTarget = null;
  pendingTocLocation = { entryId, targetId };
  setEntryLocation(entryId, mode, null, null, null, targetId);
  showEntryById(entryId);
}

function scrollToContentsIndexLocation(locationTarget = pendingTocLocation) {
  if (!locationTarget || locationTarget.entryId !== 'idml-r1-u4237') return false;
  const item = document.getElementById(contentsIndexItemId(locationTarget.targetId));
  const link = item?.querySelector('.reader-contents-index-link');
  if (!item || !link) return false;
  item.scrollIntoView({ behavior: 'auto', block: 'center' });
  link.focus({ preventScroll: true });
  item.classList.add('is-location-target');
  window.setTimeout(() => item.classList.remove('is-location-target'), 1800);
  return true;
}

function scheduleContentsIndexScroll(locationTarget, attempts = 24) {
  let remaining = attempts;
  const attempt = () => {
    if (pendingTocLocation?.entryId !== locationTarget.entryId
      || pendingTocLocation?.targetId !== locationTarget.targetId) return;
    if (scrollToContentsIndexLocation(locationTarget) || remaining <= 0) return;
    remaining -= 1;
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
}

function scrollToApaNavigationTarget(locationTarget = pendingApaNavigationTarget) {
  if (!locationTarget) return false;
  const target = document.getElementById(locationTarget.targetId);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'auto', block: 'center' });
  target.focus?.({ preventScroll: true });
  target.classList.add('is-apa-location-target');
  window.setTimeout(() => target.classList.remove('is-apa-location-target'), 1800);
  return true;
}

function scheduleApaNavigationScroll(locationTarget, attempts = 24) {
  let remaining = attempts;
  const attempt = () => {
    if (pendingApaNavigationTarget?.entryId !== locationTarget.entryId
      || pendingApaNavigationTarget?.targetId !== locationTarget.targetId) return;
    if (scrollToApaNavigationTarget(locationTarget) || remaining <= 0) return;
    remaining -= 1;
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
}

function scrollToFigureIndexLocation(locationTarget = pendingFigureIndexLocation) {
  if (!locationTarget || locationTarget.entryId !== 'idml-r1-u5752') return false;
  const item = document.getElementById(figureIndexItemId(locationTarget.figureKey));
  const link = item?.querySelector('.reader-figure-index-link');
  if (!item || !link) return false;
  item.scrollIntoView({ behavior: 'auto', block: 'center' });
  link.focus({ preventScroll: true });
  item.classList.add('is-location-target');
  window.setTimeout(() => item.classList.remove('is-location-target'), 1800);
  return true;
}

function scheduleFigureIndexScroll(locationTarget, attempts = 24) {
  let remaining = attempts;
  const attempt = () => {
    if (pendingFigureIndexLocation?.entryId !== locationTarget.entryId
      || pendingFigureIndexLocation?.figureKey !== locationTarget.figureKey) return;
    if (scrollToFigureIndexLocation(locationTarget) || remaining <= 0) return;
    remaining -= 1;
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
}

function appendFigureIndexReturn(figure, image, figureKey, figureNumber = null) {
  if (!figureKey) {
    figure.append(image);
    return;
  }
  const link = document.createElement('a');
  link.className = 'reader-figure-index-return-image';
  link.href = `#entry=idml-r1-u5752&figure-index=${encodeURIComponent(figureKey)}`;
  link.setAttribute('aria-label', `Volver al listado automático desde la Figura ${figureNumber || ''}`.trim());
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setFigureIndexLocation('idml-r1-u5752', figureKey);
    showEntryById('idml-r1-u5752');
  });
  link.append(image);
  figure.append(link);
}

function appendFigureIndexReturnCaption(caption, figureKey) {
  if (!figureKey || !caption) return;
  const returnLink = document.createElement('a');
  returnLink.className = 'reader-figure-index-return-link';
  returnLink.href = `#entry=idml-r1-u5752&figure-index=${encodeURIComponent(figureKey)}`;
  returnLink.textContent = '↩ Volver al listado automático de figuras';
  returnLink.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setFigureIndexLocation('idml-r1-u5752', figureKey);
    showEntryById('idml-r1-u5752');
  });
  caption.append(returnLink);
}

function scrollToFigureLocation(locationTarget = pendingFigureLocation) {
  if (!locationTarget) return false;
  const figure = [...document.querySelectorAll('.reader-figure[data-entry-id][data-figure-key]')]
    .find((item) => item.dataset.entryId === locationTarget.entryId && item.dataset.figureKey === locationTarget.figureKey);
  if (!figure) return false;
  const alignFigure = () => {
    const top = Math.max(0, window.scrollY + figure.getBoundingClientRect().top - Math.max(120, Math.round(window.innerHeight * 0.2)));
    window.scrollTo({ top, behavior: 'auto' });
  };
  const image = figure.querySelector('img');
  if (image && !image.complete) {
    // Enter the viewport to trigger lazy loading, then realign after intrinsic image
    // dimensions are known so the destination does not drift while the page settles.
    alignFigure();
    image.addEventListener('load', alignFigure, { once: true });
    image.addEventListener('error', alignFigure, { once: true });
  } else {
    alignFigure();
  }
  return true;
}

function scheduleFigureLocationScroll(locationTarget, attempts = 24) {
  let remaining = attempts;
  const attempt = () => {
    if (pendingFigureLocation?.entryId !== locationTarget.entryId
      || pendingFigureLocation?.figureKey !== locationTarget.figureKey) return;
    if (scrollToFigureLocation(locationTarget) || remaining <= 0) return;
    remaining -= 1;
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
}

function showEntryById(id, { historyMode = null, scroll = true, openedFromAtlas = false } = {}) {
  if (!entries.some((entry) => entry.id === id)) return false;
  entryOpenedFromAtlas = openedFromAtlas;
  activeSection = null;
  activeFilter = 'all';
  statusFilter = 'all';
  searchTerm = '';
  showHomePage = false;
  showAtlasHome = false;
  showFigureCredits = false;
  showApaAudit = false;
  showEntryWorkspace = true;
  selectedId = id;
  pendingEntryLocationId = id;
  clearTimeout(pendingEntryLocationTimer);
  pendingEntryLocationTimer = setTimeout(() => { pendingEntryLocationId = null; }, 3000);
  if (historyMode) setEntryLocation(id, historyMode);
  if ($('#search-input')) $('#search-input').value = '';
  if ($('#status-filter')) $('#status-filter').value = 'all';
  renderList();
  const targetIndex = listEntrySnapshot.findIndex((entry) => entry.id === id);
  while (targetIndex >= renderedEntryCount && renderedEntryCount < listEntrySnapshot.length) appendEntryBatch();
  const figureTarget = pendingFigureLocation?.entryId === id ? { ...pendingFigureLocation } : null;
  if (figureTarget) scheduleFigureLocationScroll(figureTarget);
  const figureIndexTarget = pendingFigureIndexLocation?.entryId === id ? { ...pendingFigureIndexLocation } : null;
  if (figureIndexTarget) scheduleFigureIndexScroll(figureIndexTarget);
  const apaTarget = pendingApaNavigationTarget?.entryId === id ? { ...pendingApaNavigationTarget } : null;
  if (apaTarget) scheduleApaNavigationScroll(apaTarget);
  const tocTarget = pendingTocLocation?.entryId === id ? { ...pendingTocLocation } : null;
  if (tocTarget && id === 'idml-r1-u4237') scheduleContentsIndexScroll(tocTarget);
  if (scroll && targetIndex >= 0) {
    const scrollTargetIntoView = () => {
      if (figureTarget && scrollToFigureLocation(figureTarget)) return;
      if (figureIndexTarget && scrollToFigureIndexLocation(figureIndexTarget)) return;
      if (apaTarget && scrollToApaNavigationTarget(apaTarget)) return;
      if (tocTarget && scrollToContentsIndexLocation(tocTarget)) return;
      const target = document.getElementById(`entry-reader-${targetIndex + 1}`);
      if (!target) return;
      const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top - 150);
      window.scrollTo({ top, behavior: 'auto' });
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollTargetIntoView));
    window.setTimeout(scrollTargetIntoView, 120);
  }
  return true;
}

function restoreEntryFromLocation() {
  const id = entryIdFromLocation();
  if (!id) return false;
  if (!entries.some((entry) => entry.id === id)) {
    clearEntryLocation();
    showToast('No se encontró esa entrada en este navegador.');
    return false;
  }
  pendingFigureLocation = figureLocationFromHash();
  pendingFigureIndexLocation = figureIndexLocationFromHash();
  pendingApaNavigationTarget = apaNavigationTargetFromHash();
  pendingTocLocation = tocNavigationTargetFromHash();
  return showEntryById(id);
}

function restoreHomeFromLocation() {
  activeSection = null;
  entryOpenedFromAtlas = false;
  activeFilter = 'all';
  searchTerm = '';
  statusFilter = 'all';
  showHomePage = true;
  showAtlasHome = false;
  showFigureCredits = false;
  showApaAudit = false;
  showEntryWorkspace = false;
  renderList();
  window.scrollTo(0, 0);
}

function readerMatchesEntryLocation(id) {
  if (!id || !libraryMounted || !showEntryWorkspace) return false;
  const articles = [...entryList.querySelectorAll('.feed-entry')];
  const viewportEntry = articles.find((article) => {
    const rect = article.getBoundingClientRect();
    return rect.top <= window.innerHeight * 0.42 && rect.bottom > window.innerHeight * 0.25;
  }) ?? articles.find((article) => article.getBoundingClientRect().top > 0);
  if (viewportEntry?.dataset.entryId !== id) return false;
  const entry = entries.find((item) => item.id === id);
  if (!entry) return false;
  const expectedNodeId = guideNodeForEntry(entry)?.id ?? '';
  const activeNodeId = $('#reader-phase-groups .reader-phase-chapter[aria-current="page"]')?.dataset.guideNodeId ?? '';
  return activeNodeId === expectedNodeId;
}

function reconcileRestoredReaderLocation(force = false) {
  const id = entryIdFromLocation();
  if (!id || !entries.length) return;
  if (force || !readerMatchesEntryLocation(id)) restoreEntryFromLocation();
}

function renderOutlineNode(host, node, query = '', { focusPath = new Set(), focusEntryId = null, locationForEntry = atlasLocationForEntry, parentId = node.phaseId } = {}) {
  const queryMatches = (entry) => !query || atlasEntrySearchText(entry, locationForEntry(entry).number).includes(query);
  const nodeEntries = sortAtlasItems(entries.filter((entry) => isAtlasBibliographyEntryVisible(entry) && guideNodeForEntry(entry)?.id === node.id && queryMatches(entry)), 'entries', node.id);
  const childHasMatch = (child) => entries.some((entry) => isAtlasBibliographyEntryVisible(entry) && guideNodeForEntry(entry)?.id === child.id && queryMatches(entry))
    || (child.children ?? []).some(childHasMatch);
  if (query && !nodeEntries.length && !(node.children ?? []).some(childHasMatch)) return;
  const details = document.createElement('details');
  const containsFocus = focusPath.has(node.id);
  details.className = 'atlas-subchapter' + (node.state === 'Pendiente' ? ' is-pending' : '') + (containsFocus ? ' contains-atlas-focus' : '');
  details.dataset.atlasNodeId = node.id;
  details.dataset.atlasParentId = parentId || '';
  details.open = Boolean(query) || containsFocus || atlasExpandedNodes.has(node.id);
  details.addEventListener('toggle', () => {
    if (details.open) atlasExpandedNodes.add(node.id);
    else atlasExpandedNodes.delete(node.id);
  });
  const summary = document.createElement('summary');
  summary.draggable = true;
  summary.dataset.atlasDragKind = 'node';
  summary.dataset.atlasNodeId = node.id;
  summary.dataset.atlasParentId = parentId || '';
  summary.title = 'Arrastra para cambiar la posición de este apartado';
  const marker = node.number ? 'APARTADO ' + node.number : node.isCustom ? 'APARTADO NUEVO' : 'SIN NUMERACIÓN';
  const countNodeEntries = (current) => entries.filter((entry) => isAtlasBibliographyEntryVisible(entry) && guideNodeForEntry(entry)?.id === current.id && queryMatches(entry)).length
    + (current.children ?? []).reduce((total, child) => total + countNodeEntries(child), 0);
  const nestedEntryCount = Math.max(0, countNodeEntries(node) - nodeEntries.length);
  const ownLabel = `${nodeEntries.length} ${nodeEntries.length === 1 ? 'entrada aquí' : 'entradas aquí'}`;
  const nestedLabel = nestedEntryCount ? ` · ${nestedEntryCount} en subapartados` : '';
  summary.innerHTML = '<span class="chapter-marker">' + escapeHTML(marker) + '</span><strong>' + escapeHTML(node.label) + '</strong><span class="chapter-count">' + escapeHTML(ownLabel + nestedLabel) + '</span><span class="chapter-chevron" aria-hidden="true">⌄</span>';
  details.append(summary);
  const body = document.createElement('div');
  body.className = 'chapter-entries outline-node-body';
  if (node.detail) {
    const note = document.createElement('p');
    note.className = 'outline-node-note';
    note.textContent = node.detail;
    body.append(note);
  }
  nodeEntries.forEach((entry) => body.append(createReadingEntry(entry, { focused: entry.id === focusEntryId })));
  (node.children ?? []).forEach((child) => renderOutlineNode(body, child, query, { focusPath, focusEntryId, locationForEntry, parentId: node.id }));
  if (!nodeEntries.length && !(node.children ?? []).length) {
    const state = document.createElement('p');
    state.className = 'outline-node-state' + (node.state === 'Pendiente' ? ' is-pending' : '');
    state.textContent = node.state === 'Pendiente' ? 'Pendiente de desarrollar según la guía.' : node.detail || 'No hay una entrada recuperada asignada a este apartado.';
    body.append(state);
  }
  details.append(body);
  host.append(details);
}

function renderSectionDetail() {
  const phase = effectivePhase(GUIDE_PHASE_BY_ID.get(activeSection));
  const selectedNode = getGuideNodeById(activeSection);
  if (!phase && !selectedNode) return;
  const selectedNodes = phase ? atlasNodesForPhase(phase) : [selectedNode];
  const focusedEntry = atlasFocusEntryId ? entries.find((entry) => entry.id === atlasFocusEntryId) : null;
  const focusedNodeId = focusedEntry ? guideNodeForEntry(focusedEntry)?.id : null;
  const focusPath = new Set();
  const collectFocusPath = (nodes, ancestors = []) => {
    for (const node of nodes) {
      const path = [...ancestors, node.id];
      if (node.id === focusedNodeId) {
        path.forEach((id) => focusPath.add(id));
        return true;
      }
      if (collectFocusPath(node.children ?? [], path)) return true;
    }
    return false;
  };
  if (phase) collectFocusPath(selectedNodes);
  const selectionLabel = phase?.label ?? (selectedNode.number ? selectedNode.number + ' · ' : '') + selectedNode.label;
  const query = normalizeEditorialText(sectionSearchTerm.trim());
  const locationCache = new Map();
  const locationForEntry = (entry) => {
    if (!locationCache.has(entry.id)) locationCache.set(entry.id, atlasLocationForEntry(entry));
    return locationCache.get(entry.id);
  };
  const sectionEntries = entries.filter((entry) => entryMatchesSelection(entry, activeSection))
    .filter((entry) => !query || atlasEntrySearchText(entry, locationForEntry(entry).number).includes(query));
  $('#section-kicker').textContent = phase ? phase.marker : 'APARTADO ' + (selectedNode.number || '');
  $('#section-title').textContent = selectionLabel;
  $('#section-breadcrumb').textContent = selectionLabel;
  $('#section-description').textContent = phase?.description ?? selectedNode.detail ?? 'Apartado del índice definitivo del INDB.';
  $('#section-entry-total').textContent = sectionEntries.length;
  $('#atlas-clear-focus').hidden = !focusedEntry;
  const host = $('#chapter-list');
  host.replaceChildren();
  if (phase?.id === 'sin-clasificar') {
    sectionEntries.forEach((entry) => host.append(createReadingEntry(entry, { focused: entry.id === atlasFocusEntryId })));
  } else {
    if (phase) sectionEntries.filter((entry) => guideNodeForEntry(entry)?.id === phase.id || guideNodeForEntry(entry)?.isAtlasEntry).forEach((entry) => host.append(createReadingEntry(entry, { focused: entry.id === atlasFocusEntryId })));
    selectedNodes.forEach((node) => renderOutlineNode(host, node, query, { focusPath, focusEntryId: atlasFocusEntryId, locationForEntry }));
  }
  if (!host.childElementCount) host.innerHTML = '<div class="chapter-empty">' + (query ? 'No hay entradas que coincidan con esta búsqueda.' : 'No hay entradas recuperadas para esta vista.') + '</div>';
  if (focusedEntry && atlasFocusNeedsScroll) {
    atlasFocusNeedsScroll = false;
    requestAnimationFrame(() => host.querySelector('.atlas-entry-link.is-atlas-focused')?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' }));
  }
}
function escapeHTML(text = '') {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function relativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const days = Math.floor((Date.now() - date.valueOf()) / 86400000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(date);
}

function createEntryListItem(entry, index, total) {
  const article = document.createElement('article');
  article.className = 'feed-entry';
  if (entry.apaUnifiedBibliography === true) article.classList.add('is-apa-unified-bibliography');
  article.id = `entry-reader-${index + 1}`;
  article.dataset.type = entry.type;
  article.dataset.entryId = entry.id;
  article.setAttribute('aria-labelledby', `entry-reader-title-${index + 1}`);
  const title = document.createElement('h2');
  title.className = 'feed-entry-title';
  title.id = `entry-reader-title-${index + 1}`;
  title.textContent = displayEntryTitle(entry);
  const body = document.createElement('div');
  body.className = 'reader-content feed-entry-content';
  const readerMain = document.createElement('div');
  readerMain.className = 'feed-entry-main';
  const atlasPath = atlasLocationForEntry(entry).path;
  const sourceTrace = entry.area ? `<span>·</span><span>${escapeHTML(entry.area)}</span>` : '';
  const outlineMarker = entry.outlineScaffold === true
    ? '<span class="outline-scaffold-badge">Marcador estructural · contenido pendiente</span>' : '';
  article.innerHTML = `<nav class="feed-entry-crumbs" aria-label="Ubicación de la entrada"><span>Biblioteca</span><span aria-hidden="true">›</span><span>${escapeHTML(atlasPath)}</span><button class="feed-entry-atlas-link" type="button" data-atlas-locate="${escapeHTML(entry.id)}">Ubicar en Atlas ↗</button><span class="feed-entry-position">${index + 1} / ${total}</span></nav><header class="feed-entry-header"><div class="entry-meta"><i class="entry-kind-dot"></i><span>${escapeHTML(entry.type.toLocaleUpperCase('es'))}</span>${sourceTrace}${outlineMarker}${entry.localEditedAt ? '<span class="local-edit-mark">Copia editada</span>' : ''}</div><div class="feed-entry-state"><span class="status-pill" data-status="${escapeHTML(entry.status)}">${escapeHTML(entry.status)}</span><span class="entry-date">${relativeDate(entry.updatedAt)}</span><button class="button button-quiet feed-entry-edit" type="button" data-edit-entry="${escapeHTML(entry.id)}">Editar</button></div></header>`;
  readerMain.append(title, body);
  const readerGrid = document.createElement('div');
  readerGrid.className = 'feed-entry-reader-grid';
  readerGrid.append(readerMain);
  article.append(readerGrid);
  renderEntryContent(entry, body);
  const contentsReturn = contentsIndexReturnForEntry(entry);
  if (contentsReturn) {
    const returnLink = document.createElement('a');
    returnLink.className = 'reader-contents-index-return-link';
    returnLink.href = `#entry=idml-r1-u4237&toc-target=${encodeURIComponent(contentsReturn.targetId)}`;
    returnLink.textContent = `↩ Índice de contenidos · ${contentsReturn.label}`;
    returnLink.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setContentsIndexLocation('idml-r1-u4237', contentsReturn.targetId);
    });
    body.prepend(returnLink);
  }
  const headings = [...body.querySelectorAll('.reader-subheading')];
  if (headings.length) {
    readerGrid.classList.add('has-outline');
    const aside = document.createElement('aside');
    aside.className = 'feed-entry-outline';
    const label = document.createElement('div');
    label.className = 'reader-panel-label';
    label.textContent = 'En esta entrada';
    const outline = document.createElement('nav');
    outline.className = 'entry-outline';
    outline.setAttribute('aria-label', 'Secciones de esta entrada');
    headings.forEach((heading, headingIndex) => {
      heading.id = `entry-reader-${index + 1}-section-${headingIndex + 1}`;
      const link = document.createElement('a');
      link.className = 'entry-outline-link';
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      outline.append(link);
    });
    aside.append(label, outline);
    readerGrid.append(aside);
  }
  return article;
}

function appendEntryBatch(targetCount = renderedEntryCount + ENTRY_RENDER_BATCH) {
  const nextCount = Math.min(targetCount, listEntrySnapshot.length);
  const fragment = document.createDocumentFragment();
  for (let index = renderedEntryCount; index < nextCount; index += 1) {
    const entry = listEntrySnapshot[index];
    const node = guideNodeForEntry(entry);
    const previousNode = index > 0 ? guideNodeForEntry(listEntrySnapshot[index - 1]) : null;
    const phase = node ? GUIDE_PHASE_BY_ID.get(node.phaseId) : null;
    const previousPhase = previousNode ? GUIDE_PHASE_BY_ID.get(previousNode.phaseId) : null;
    if (phase && phase.id !== previousPhase?.id) {
      const divider = document.createElement('header');
      divider.className = 'feed-chapter-divider';
      divider.setAttribute('aria-label', `${phase.marker} · ${phase.label}`);
      divider.innerHTML = `<span>${escapeHTML(phase.marker)}</span><h2>${escapeHTML(phase.label)}</h2><small>CONTENEDOR · LECTURA CONTINUA</small>`;
      fragment.append(divider);
    }
    fragment.append(createEntryListItem(listEntrySnapshot[index], index, listEntrySnapshot.length));
  }
  entryList.append(fragment);
  renderedEntryCount = nextCount;
  updateEntryListCount();
  updateReaderSequenceRail();
  fillEntryViewport();
}

let viewportFillScheduled = false;
function fillEntryViewport() {
  if (viewportFillScheduled || !libraryMounted || !showEntryWorkspace) return;
  viewportFillScheduled = true;
  requestAnimationFrame(() => {
    viewportFillScheduled = false;
    const closeToViewportEnd = document.documentElement.scrollHeight <= window.scrollY + window.innerHeight + 180;
    if (closeToViewportEnd && renderedEntryCount < listEntrySnapshot.length) appendEntryBatch();
  });
}

function updateEntryListCount() {
  const total = listEntrySnapshot.length;
  const displayed = Math.min(renderedEntryCount, total);
  $('#visible-count').textContent = displayed < total
    ? `Mostrando ${displayed} de ${total} entradas · continúa bajando para leer las siguientes`
    : `${total} ${total === 1 ? 'entrada' : 'entradas'}`;
}

function renderList() {
  if (showEntryWorkspace) ensureLibraryMounted();
  else unmountLibrary();
  // Solo ordena la secuencia completa mientras la biblioteca está montada.
  // Las vistas de créditos no necesitan ese costo para actualizar su interfaz.
  const visible = libraryMounted ? filteredEntries() : [];
  if (libraryMounted) {
    const key = JSON.stringify([
      activeFilter, activeSection, statusFilter, searchTerm.trim(),
      atlasOrderState.updatedAt,
      visible.map((entry) => `${entry.id}:${entry.updatedAt}`).join('|')
    ]);
    if (key !== entryListRenderKey) {
      entryListRenderKey = key;
      listEntrySnapshot = visible;
      renderedEntryCount = 0;
      entryList.replaceChildren();
      entryList.scrollTop = 0;
      window.scrollTo(0, 0);
    } else {
      listEntrySnapshot = visible;
    }
    if (renderedEntryCount === 0 && listEntrySnapshot.length) appendEntryBatch(ENTRY_RENDER_BATCH);
    entryList.setAttribute('aria-busy', 'false');
    emptyState.hidden = visible.length > 0;
    entryList.hidden = visible.length === 0;
    updateEntryListCount();
    updateReaderSequenceRail();
    fillEntryViewport();
  }
  $('#count-all').textContent = entries.length;
  $('#count-writing').textContent = entries.filter((entry) => ['Entrada', 'Nota', 'Decisión'].includes(entry.type)).length;
  $('#count-source').textContent = entries.filter((entry) => entry.type === 'Fuente').length;
  $('#count-task').textContent = entries.filter((entry) => entry.type === 'Tarea').length;
  const figureCount = collectFigureCredits().length;
  const creditCount = $('#count-figure-credits');
  if (creditCount) creditCount.textContent = String(figureCount);
  renderAtlasOverview();
  updateViewHeading();
  if (showFigureCredits) renderFigureCredits();
  if (showApaAudit) renderApaAudit();
}

let apaAuditDataPromise;
function loadApaAuditData() {
  if (!apaAuditDataPromise) apaAuditDataPromise = fetch('./importaciones/auditoria-apa-pdf-octubre-2026.json')
    .then((response) => { if (!response.ok) throw new Error('No se pudo abrir el cotejo APA guardado en esta PWA.'); return response.json(); });
  return apaAuditDataPromise;
}

let apaReviewRegisterPromise;
function loadApaReviewRegister() {
  if (!apaReviewRegisterPromise) apaReviewRegisterPromise = fetch('./importaciones/apa-review-register-2026-10-18.json')
    .then((response) => { if (!response.ok) throw new Error('No se pudo abrir el registro APA incluido en esta PWA.'); return response.json(); });
  return apaReviewRegisterPromise;
}

function renderApaReviewRegister(host, register) {
  host.replaceChildren();
  const countLabel = $('#apa-review-case-count');
  if (countLabel) countLabel.textContent = `(${register.cases?.length || 0} casos)`;
  for (const item of register.cases || []) {
    const card = document.createElement('details');
    card.className = 'apa-audit-card apa-review-case';
    card.dataset.reviewCaseId = item.id;
    const summary = document.createElement('summary');
    summary.textContent = `${item.id} · ${item.priority} · ${item.issue}`;
    card.append(summary);
    for (const [label, value] of [
      ['Estado registrado', item.recordedStatus], ['Ubicación anotada', item.sourceLocation],
      ['Propuesta registrada', item.proposedCorrection], ['Evidencia anotada', item.evidence], ['Dependencia pendiente', item.dependency]
    ]) {
      if (!value) continue;
      const field = document.createElement('span');
      field.textContent = `${label}: ${value}`;
      card.append(field);
    }
    host.append(card);
  }
}

function renderApaAuditRows(host, rows, formatter, emptyText) {
  host.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement('p');
    empty.className = 'figure-credits-empty';
    empty.textContent = emptyText;
    host.append(empty);
    return;
  }
  rows.forEach((row) => {
    const card = document.createElement('article');
    card.className = 'apa-audit-card';
    const title = document.createElement('strong');
    title.textContent = formatter.title(row);
    const detail = document.createElement('span');
    detail.textContent = formatter.detail(row);
    card.append(title, detail);
    if (formatter.references) {
      const referenceMatch = document.createElement('span');
      referenceMatch.className = 'apa-audit-reference-match';
      referenceMatch.textContent = formatter.references(row);
      card.append(referenceMatch);
    }
    host.append(card);
  });
}

function normalizeApaAuditText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function normalizeApaAuditAuthor(value) {
  return normalizeApaAuditText(String(value || '').replace(/\s+y\s+/gi, ' & '));
}

function apaNavigationKey(value) {
  let hash = 2166136261;
  for (const character of normalizeApaAuditText(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function currentApaCitationNavigationAudit() {
  if (!apaCitationNavigationAudit) apaCitationNavigationAudit = collectCurrentPwaCitationAudit(entries);
  return apaCitationNavigationAudit;
}

function citationReferenceMatches(text, audit) {
  const matches = [];
  const rowsByKey = new Map(audit.citations.map((row) => [`${normalizeApaAuditAuthor(row.author)}|${String(row.year).toLocaleLowerCase()}`, row]));
  const push = (start, end, year, author) => {
    const row = rowsByKey.get(`${normalizeApaAuditAuthor(author)}|${String(year).toLocaleLowerCase()}`);
    if (row?.referenceMatches.length !== 1) return;
    const reference = row.referenceMatches[0];
    if (start < 0 || end <= start || matches.some((item) => start < item.end && end > item.start)) return;
    matches.push({ start, end, reference });
  };
  const parenthetical = /\(([^()\n]{1,220})\)/g;
  for (const group of text.matchAll(parenthetical)) {
    for (const partMatch of group[1].matchAll(/[^;]+/g)) {
      const part = partMatch[0];
      const partOffset = group.index + 1 + partMatch.index;
      const yearMatch = part.match(/(?<![\p{L}\p{N}])((?:19|20)\d{2}[a-z]?|s\.\s*f\.(?:-[a-z]?)?|n\.\s*d\.(?:-[a-z]?)?)(?![\p{L}\p{N}])/iu);
      if (!yearMatch) continue;
      const author = part.slice(0, yearMatch.index).replace(/[\s,;:]+$/g, '').trim();
      const year = yearMatch[1];
      if (author) push(partOffset, partOffset + yearMatch.index + year.length, year, author);
    }
  }
  const narrative = /([\p{Lu}][\p{L}\p{M}'’.-]*(?:[^\S\r\n]+[\p{Lu}][\p{L}\p{M}'’.-]+){0,3}(?:[^\S\r\n]+et[^\S\r\n]+al\.?|[^\S\r\n]+(?:y|&)[^\S\r\n]*[\p{Lu}][\p{L}\p{M}'’.-]+(?:[^\S\r\n]+[\p{Lu}][\p{L}\p{M}'’.-]+)?)?)[^\S\r\n]+\(((?:19|20)\d{2}[a-z]?|s\.\s*f\.(?:-[a-z]?)?|n\.\s*d\.(?:-[a-z]?)?)(?:,\s*p{1,2}\.?\s*\d+(?:[-–]\d+)?)?\)/gu;
  for (const match of text.matchAll(narrative)) push(match.index, match.index + match[0].length, match[2], match[1]);
  return matches.sort((left, right) => left.start - right.start);
}

function apaReferenceTargetId(reference) {
  return `apa-reference-${apaNavigationKey(reference.normalizedText || reference.text)}`;
}

function apaCitationTargetId(reference, entryId) {
  return `apa-citation-${apaNavigationKey(reference.normalizedText || reference.text)}-${apaNavigationKey(entryId)}`;
}

function linkifyApaCitations(entry, host) {
  if (!['Entrada', 'Nota'].includes(entry.type) || entry.status === 'Archivada' || entry.apaCitationAuditExclusion) return;
  const audit = currentApaCitationNavigationAudit();
  const referenceId = 'pwa-apa7-unified-bibliography-2026-10-21';
  const assignedBacklinkIds = new Set();
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || node.parentElement?.closest('a,button,code,pre,figcaption,.reader-figure,.reader-figure-index')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const text = node.nodeValue;
    const matches = citationReferenceMatches(text, audit);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const targetId = apaReferenceTargetId(match.reference);
      const citationTargetId = apaCitationTargetId(match.reference, entry.id);
      if (match.start > offset) fragment.append(document.createTextNode(text.slice(offset, match.start)));
      const link = document.createElement('a');
      link.className = 'apa-citation-reference-link';
      link.href = `#entry=${encodeURIComponent(referenceId)}&apa-target=${encodeURIComponent(targetId)}`;
      link.dataset.apaReferenceKey = targetId;
      if (!assignedBacklinkIds.has(citationTargetId)) {
        link.id = citationTargetId;
        assignedBacklinkIds.add(citationTargetId);
      }
      link.textContent = text.slice(match.start, match.end);
      link.setAttribute('aria-label', `Abrir referencia APA: ${match.reference.text}`);
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setApaNavigationLocation(referenceId, targetId);
      });
      fragment.append(link);
      offset = match.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
}

function addCitationBacklinksToUnifiedReferences(host) {
  const audit = currentApaCitationNavigationAudit();
  const paragraphs = [...host.querySelectorAll('p.reader-paragraph, p')];
  const canonicalEntries = audit.references.map((reference) => ({ reference, targetId: apaReferenceTargetId(reference) }));
  for (const paragraph of paragraphs) {
    if (paragraph.closest('.apa-reference-citation-backlinks')) continue;
    const normalized = normalizeApaAuditText(paragraph.textContent);
    const canonical = canonicalEntries.find(({ reference }) => normalized === reference.normalizedText);
    if (!canonical) continue;
    paragraph.id = canonical.targetId;
    paragraph.tabIndex = -1;
    const citedLocations = new Map();
    for (const row of audit.citations) {
      if (!row.referenceMatches.some((match) => match.normalizedText === canonical.reference.normalizedText)) continue;
      for (const location of row.locations) citedLocations.set(location.entryId, location);
    }
    const backlinks = document.createElement('span');
    backlinks.className = 'apa-reference-citation-backlinks';
    if (!citedLocations.size) {
      backlinks.classList.add('is-unmatched');
      backlinks.textContent = 'Sin cita autor-año detectada automáticamente · revisar antes de retirar';
      paragraph.append(backlinks);
      continue;
    }
    const label = document.createElement('span');
    label.textContent = 'Citas detectadas en: ';
    backlinks.append(label);
    [...citedLocations.values()].forEach((location, index) => {
      if (index) backlinks.append(document.createTextNode(' · '));
      const citationTargetId = apaCitationTargetId(canonical.reference, location.entryId);
      const link = document.createElement('a');
      link.href = `#entry=${encodeURIComponent(location.entryId)}&apa-target=${encodeURIComponent(citationTargetId)}`;
      link.textContent = location.title;
      link.setAttribute('aria-label', `Volver a una cita de esta referencia en ${location.title}`);
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setApaNavigationLocation(location.entryId, citationTargetId);
      });
      backlinks.append(link);
    });
    paragraph.append(backlinks);
  }
}

function parseApaAuditReferenceLine(value) {
  const cleanLine = String(value || '').trim().replace(/^[•*–-]\s*/, '');
  const match = cleanLine.match(/^(.+?)\s+\(((?:19|20)\d{2}[a-z]?(?:,\s+[^)]+)?|s\.\s*f\.(?:-[a-z])?|n\.\s*d\.(?:-[a-z])?)\)\.\s+(.+)$/i);
  if (!match) return null;
  const year = match[2].match(/^((?:19|20)\d{2}[a-z]?)/i)?.[1] || match[2];
  return { author: match[1], year, text: cleanLine };
}

function collectCurrentPwaCitationAudit(currentEntries = entries) {
  const referenceMap = new Map();
  const excludedReferenceTexts = new Set(currentEntries.flatMap((entry) =>
    entry.apaFerrariReferenceReconciliationSnapshot?.removedFromConsolidatedList || [])
    .map(normalizeApaAuditText));
  for (const exclusion of currentEntries.flatMap((entry) => entry.apaCitationAuditVariantExclusions || [])) {
    if (typeof exclusion?.sourceText === 'string' && exclusion.sourceText.trim()) {
      excludedReferenceTexts.add(normalizeApaAuditText(exclusion.sourceText));
    }
  }
  const sourceEntries = currentEntries.filter((item) => item.type === 'Fuente' && item.apaUnifiedBibliography !== true
    && !['excluded-unverified-uncited', 'excluded-confirmed-uncited', 'excluded-duplicate-transcription', 'excluded-superseded-transcription', 'excluded-unverified-source'].includes(item.apaReferenceRecord?.bibliographyDisposition))
    .sort((left, right) => Number(Boolean(right.apaReferenceRecord)) - Number(Boolean(left.apaReferenceRecord)));
  const addReference = (entry, author, year, text, relatedFigureIds = []) => {
    if (excludedReferenceTexts.has(normalizeApaAuditText(text))) return;
    const canonicalAuthor = String(author).replace(/\s*\[[A-Z]{2,12}\]\.?$/, '').trim();
    const key = `${normalizeApaAuditText(canonicalAuthor)}|${String(year).toLocaleLowerCase()}`;
    const normalizedText = normalizeApaAuditText(text);
    const existing = referenceMap.get(key) || [];
    const duplicate = existing.find((item) => item.normalizedText === normalizedText)
      || [...referenceMap.values()].flat().find((item) => item.normalizedText === normalizedText);
    if (duplicate) {
      if (!duplicate.sourceEntryIds.includes(entry.id)) duplicate.sourceEntryIds.push(entry.id);
      if (!duplicate.sourceTitles.includes(entry.title)) duplicate.sourceTitles.push(entry.title);
      duplicate.relatedFigureIds = [...new Set([...(duplicate.relatedFigureIds || []), ...relatedFigureIds])];
      return;
    }
    const reference = { author, year: String(year), text, title: entry.title, entryId: entry.id, key,
      normalizedText, sourceEntryIds: [entry.id], sourceTitles: [entry.title], relatedFigureIds: [...new Set(relatedFigureIds)] };
    existing.push(reference);
    referenceMap.set(key, existing);
  };
  for (const entry of sourceEntries) {
    const record = entry.apaReferenceRecord;
    if (!record || typeof record.author !== 'string' || typeof record.year !== 'string'
      || typeof record.sourceText !== 'string' || !record.sourceText) continue;
    addReference(entry, record.author, record.year, record.sourceText, record.relatedFigureIds || []);
  }
  for (const entry of sourceEntries) {
    const sourceText = [entry.content, ...(entry.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text)].join('\n');
    let imageReferencesSection = false;
    for (const sourceLine of sourceText.split(/\r?\n/)) {
      if (entry.referenceListSnapshot && /^referencias de im[aá]genes\s*$/i.test(sourceLine.trim())) imageReferencesSection = true;
      if (imageReferencesSection) continue;
      const line = sourceLine;
      const cleanLine = line.trim().replace(/^[•*–-]\s*/, '');
      if ((entry.apaExcludedReferenceLines || []).includes(cleanLine)) continue;
      const referenceLine = parseApaAuditReferenceLine(cleanLine);
      if (!referenceLine) continue;
      addReference(entry, referenceLine.author, referenceLine.year, referenceLine.text);
    }
  }
  const references = [...referenceMap.values()].flat();
  const eligibleEntries = currentEntries.filter((entry) => ['Entrada', 'Nota'].includes(entry.type)
    && entry.status !== 'Archivada' && !entry.apaCitationAuditExclusion);
  const citationYearMatches = (referenceYear, citationYear) => {
    const normalizeCitationDate = (value) => /^(?:s\.\s*f\.|n\.\s*d\.)$/i.test(String(value).trim())
      ? 'no-date' : String(value).toLocaleLowerCase();
    const referenceValue = normalizeCitationDate(referenceYear);
    const citationValue = normalizeCitationDate(citationYear);
    if (referenceValue === citationValue) return true;
    if (citationValue === 'no-date' && /^(?:s\.\s*f\.|n\.\s*d\.)-[a-z]$/i.test(referenceValue)) return true;
    return /^(?:19|20)\d{2}$/.test(citationValue) && new RegExp(`^${citationValue}[a-z]$`).test(referenceValue);
  };
  const authorEditDistance = (left, right) => {
    if (Math.abs(left.length - right.length) > 1) return 2;
    let i = 0; let j = 0; let edits = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { i += 1; j += 1; continue; }
      edits += 1;
      if (edits > 1) return edits;
      if (left.length > right.length) i += 1;
      else if (right.length > left.length) j += 1;
      else { i += 1; j += 1; }
    }
    if (i < left.length || j < right.length) edits += 1;
    return edits;
  };
  const expandedOrganizationReferences = new Map();
  const explicitOrganizationReferences = new Map();
  for (const entry of sourceEntries) {
    const record = entry.apaReferenceRecord;
    if (typeof record?.authorAbbreviation !== 'string' || !record.authorAbbreviation.trim()) continue;
    const key = `${normalizeApaAuditText(record.authorAbbreviation)}|${String(record.year).toLocaleLowerCase()}`;
    const reference = references.find((candidate) => candidate.entryId === entry.id);
    if (!reference) continue;
    const aliases = explicitOrganizationReferences.get(key) || [];
    if (!aliases.some((candidate) => candidate.entryId === entry.id)) aliases.push(reference);
    explicitOrganizationReferences.set(key, aliases);
  }
  const organizationExpansion = /([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}'’.-]+){1,8})\s+\(([A-Z]{2,12}),?\s*((?:19|20)\d{2}[a-z]?)\)/gu;
  for (const entry of eligibleEntries) {
    const blocks = (entry.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text).filter(Boolean);
    const text = blocks.length ? blocks.join('\n') : (entry.content || '');
    for (const match of text.matchAll(organizationExpansion)) {
      const fullName = match[1].replace(/^(?:(?:seg[uú]n|de acuerdo con|tal como señala|como señala|el|la|los|las)\s+)+/i, '');
      const fullNameNormalized = normalizeApaAuditText(fullName);
      const key = `${normalizeApaAuditText(match[2])}|${match[3].toLocaleLowerCase()}`;
      const candidates = references.filter((reference) => citationYearMatches(reference.year, match[3])
        && fullNameNormalized.endsWith(normalizeApaAuditText(reference.author.replace(/\s*\[[A-Z]{2,12}\]\.?$/, ''))));
      if (!candidates.length) continue;
      const existing = expandedOrganizationReferences.get(key) || [];
      for (const candidate of candidates) if (!existing.some((item) => item.entryId === candidate.entryId && item.text === candidate.text)) existing.push(candidate);
      expandedOrganizationReferences.set(key, existing);
    }
  }
  const citations = new Map();
  let referenceLinesExcludedFromCitationScan = 0;
  const interviewSources = currentEntries.filter((entry) => entry.type === 'Nota'
    && /\bentrevista\b/i.test(entry.title) && !/\binstrumento\b/i.test(entry.title));
  const addCitation = (author, year, entry, form, context = '', secondaryDetails = null) => {
    const cleanAuthor = String(author || '').replace(/^(?:seg[uú]n|de acuerdo con|como (?:señala|señalan|indica|indican)|tal como (?:señala|indica)|conforme a)\s+/i, '')
      .replace(/\bet\s+al\.?/gi, '').replace(/(?:\s+y|[\s,;&])+$/g, '').trim();
    if (!cleanAuthor || cleanAuthor.length > 120) return;
    const key = `${normalizeApaAuditAuthor(cleanAuthor)}|${year.toLocaleLowerCase()}`;
    const personalCommunicationReview = /comunicaci[oó]n\s+personal/i.test(cleanAuthor);
    const row = citations.get(key) || {
      author: cleanAuthor, year, occurrences: 0, locations: [], forms: new Set(),
      referenceMatches: [], nearReferenceMatches: [], personalCommunicationReview
    };
    row.occurrences += 1;
    row.forms.add(form);
    if (personalCommunicationReview) {
      row.personalCommunicationContexts ||= [];
      const normalizedContext = normalizeApaAuditText(context);
      if (normalizedContext && !row.personalCommunicationContexts.includes(normalizedContext)) row.personalCommunicationContexts.push(normalizedContext);
    }
    if (!row.locations.some((location) => location.entryId === entry.id)) row.locations.push({ entryId: entry.id, title: entry.title });
    if (!row.referenceMatches.length) {
      const acronym = cleanAuthor.match(/\(([A-Z]{2,12})\s*$/)?.[1]
        || cleanAuthor.match(/\[([A-Z]{2,12})\]\s*$/)?.[1];
      const authorWithoutAcronym = cleanAuthor.replace(/\s+(?:\([A-Z]{2,12}\s*|\[[A-Z]{2,12}\]\s*)$/, '').trim();
      const citeFirst = normalizeApaAuditText(authorWithoutAcronym.split(/[,;&]|\s+y\s+/)[0].replace(/^(?:(?:el|la|los|las)\s+)/i, ''));
      row.referenceMatches = references.filter((reference) => {
        if (!citationYearMatches(reference.year, year)) return false;
        const authorText = normalizeApaAuditText(reference.author);
        const authorFirst = normalizeApaAuditText(reference.author.split(',')[0]);
        const citationWords = citeFirst.split(' ').filter(Boolean);
        const referenceInitials = reference.author.split(',').slice(1).join(' ').match(/\b[\p{L}]/gu) || [];
        const reversedNameMatch = citationWords.length === 2
          && citationWords[0].length === 1
          && citationWords[1] === authorFirst
          && referenceInitials.some((initial) => normalizeApaAuditText(initial) === citationWords[0]);
        const referenceAcronym = reference.author.match(/\[([A-Z]{2,12})\]/)?.[1];
        return citeFirst === authorFirst || citeFirst === authorText || reversedNameMatch
          || (referenceAcronym && normalizeApaAuditText(referenceAcronym) === citeFirst);
      });
      const citationAcronyms = [acronym, /^[A-Z]{2,12}$/.test(cleanAuthor) ? cleanAuthor : null].filter(Boolean);
      for (const citationAcronym of citationAcronyms) {
        const aliasKey = `${normalizeApaAuditText(citationAcronym)}|${year.toLocaleLowerCase()}`;
        const aliases = [
          ...(expandedOrganizationReferences.get(aliasKey) || []),
          ...(explicitOrganizationReferences.get(aliasKey) || [])
        ];
        for (const alias of aliases) if (!row.referenceMatches.some((item) => item.entryId === alias.entryId && item.text === alias.text)) row.referenceMatches.push(alias);
      }
      if (!row.referenceMatches.length) {
        const secondaryCitation = (entry.apaSecondarySourceCitations || []).find((item) =>
          normalizeApaAuditText(item.originalAuthor) === citeFirst
          && citationYearMatches(item.originalYear, year)
          && secondaryDetails
          && normalizeApaAuditText(String(item.secondaryAuthor || '').replace(/\s*&\s*/g, ' y '))
            === normalizeApaAuditText(String(secondaryDetails.author || '').replace(/\s*&\s*/g, ' y '))
          && citationYearMatches(item.secondaryYear, secondaryDetails.year));
        const secondaryReference = secondaryCitation
          ? references.find((reference) => reference.entryId === secondaryCitation.secondarySourceEntryId) : null;
        if (secondaryReference) {
          row.referenceMatches.push(secondaryReference);
          row.secondarySourceCitations ||= [];
          const link = {
            originalAuthor: secondaryCitation.originalAuthor,
            originalYear: secondaryCitation.originalYear,
            secondarySourceEntryId: secondaryCitation.secondarySourceEntryId,
            secondaryAuthor: secondaryCitation.secondaryAuthor,
            secondaryYear: secondaryCitation.secondaryYear
          };
          if (!row.secondarySourceCitations.some((item) => item.secondarySourceEntryId === link.secondarySourceEntryId
            && item.originalAuthor === link.originalAuthor && item.originalYear === link.originalYear)) {
            row.secondarySourceCitations.push(link);
          }
        }
      }
      if (!row.referenceMatches.length) {
        const citedSurname = normalizeApaAuditText(authorWithoutAcronym.split(/[,;&]|\s+y\s+/)[0]).split(' ')[0];
        if (citedSurname.length >= 5 && !/^(?:comunicacion|personal|la|el|los|las)$/.test(citedSurname)) {
          const nearCandidates = references.filter((reference) => {
            if (!citationYearMatches(reference.year, year)) return false;
            const referenceSurname = normalizeApaAuditText(reference.author.split(',')[0]).split(' ')[0];
            return referenceSurname.length >= 5 && authorEditDistance(citedSurname, referenceSurname) === 1;
          });
          const uniqueCandidates = [...new Map(nearCandidates.map((reference) => [reference.key, reference])).values()];
          row.nearReferenceMatches = uniqueCandidates;
        }
      }
    }
    citations.set(key, row);
  };
  for (const entry of eligibleEntries) {
    const blockText = (entry.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text).filter(Boolean);
    const fullText = blockText.length ? blockText.join('\n') : (entry.content || '');
    const citationLines = fullText.split(/\r?\n/).filter((line) => {
      if (!parseApaAuditReferenceLine(line)) return true;
      referenceLinesExcludedFromCitationScan += 1;
      return false;
    });
    const text = citationLines.join('\n');
    const secondaryNarrative = /([\p{Lu}][\p{L}\p{M}'’.-]*(?:[^\S\r\n]+et[^\S\r\n]+al\.?)?)[^\S\r\n]+\(((?:19|20)\d{2}[a-z]?),\s*como\s+se\s+cit[oó]\s+en\s+([\p{Lu}][\p{L}\p{M}'’.-]*(?:[^\S\r\n]+(?:y|&)[^\S\r\n]*[\p{Lu}][\p{L}\p{M}'’.-]+)?),\s*((?:19|20)\d{2}[a-z]?)\)/giu;
    for (const match of text.matchAll(secondaryNarrative)) {
      addCitation(match[1], match[2], entry, 'narrativa secundaria', '', { author: match[3], year: match[4] });
    }
    const parenthetical = /\(([^()\n]{1,220})\)/g;
    for (const group of text.matchAll(parenthetical)) {
      for (const part of group[1].split(/\s*;\s*/)) {
        const yearMatch = part.match(/(?<![\p{L}\p{N}])((?:19|20)\d{2}[a-z]?|s\.\s*f\.(?:-[a-z])?|n\.\s*d\.(?:-[a-z])?)(?![\p{L}\p{N}])/iu);
        if (!yearMatch) continue;
        const author = part.slice(0, yearMatch.index).replace(/[\s,;:]+$/g, '').trim();
        if (author && !/^(?:p{1,2}\.?\s*)?\d+$/i.test(author)) {
          const precedingContext = text.slice(Math.max(0, group.index - 220), group.index);
          addCitation(author, yearMatch[1], entry, 'parentética', precedingContext);
        }
      }
    }
    const narrative = /([\p{Lu}][\p{L}\p{M}'’.-]*(?:[^\S\r\n]+[\p{Lu}][\p{L}\p{M}'’.-]+){0,3}(?:[^\S\r\n]+et[^\S\r\n]+al\.?|[^\S\r\n]+(?:y|&)[^\S\r\n]*[\p{Lu}][\p{L}\p{M}'’.-]+(?:[^\S\r\n]+[\p{Lu}][\p{L}\p{M}'’.-]+)?)?)[^\S\r\n]+\(((?:19|20)\d{2}[a-z]?|s\.\s*f\.(?:-[a-z])?|n\.\s*d\.(?:-[a-z])?)(?:,\s*p{1,2}\.?\s*\d+(?:[-–]\d+)?)?\)/gu;
    for (const match of text.matchAll(narrative)) addCitation(match[1], match[2], entry, 'narrativa');
  }
  const rows = [...citations.values()].sort((a, b) => b.occurrences - a.occurrences || a.author.localeCompare(b.author, 'es'));
  for (const row of rows.filter((item) => item.personalCommunicationReview)) {
    const contexts = normalizeApaAuditText((row.personalCommunicationContexts || []).join(' '));
    row.interviewSourceCandidates = interviewSources.filter((source) => {
      const name = normalizeApaAuditText(source.title).split(' ').slice(-2).join(' ');
      return name.length > 4 && contexts.includes(name);
    }).map((source) => ({ entryId: source.id, title: source.title }));
  }
  return {
    references: [...references].sort((a, b) => a.author.localeCompare(b.author, 'es', { sensitivity: 'base' })
      || a.year.localeCompare(b.year, 'es', { numeric: true })
      || a.text.localeCompare(b.text, 'es', { sensitivity: 'base' })),
    citations: rows,
    referenceCount: references.length,
    citationCount: rows.length,
    mentionCount: rows.reduce((sum, row) => sum + row.occurrences, 0),
    matchedCount: rows.filter((row) => row.referenceMatches.length).length,
    unmatchedCount: rows.filter((row) => !row.referenceMatches.length && !row.personalCommunicationReview).length,
    personalCommunicationCount: rows.filter((row) => row.personalCommunicationReview).length,
    personalCommunicationMentionCount: rows.filter((row) => row.personalCommunicationReview).reduce((sum, row) => sum + row.occurrences, 0),
    referenceLinesExcludedFromCitationScan,
    excludedEntryIds: currentEntries.filter((entry) => entry.apaCitationAuditExclusion).map((entry) => entry.id)
  };
}

function renderCurrentPwaApaAudit() {
  const audit = collectCurrentPwaCitationAudit(entries);
  const summary = $('#current-apa-audit-summary');
  if (summary) {
    summary.replaceChildren();
    [
      ['Menciones candidatas', audit.mentionCount],
      ['Pares autor-año', audit.citationCount],
      ['Con posible fuente en la PWA', audit.matchedCount],
      ['Sin candidata exacta ni excepción', audit.unmatchedCount],
      ['Comunicación personal: revisar categoría', audit.personalCommunicationCount],
      ['Líneas de referencia excluidas del detector de citas', audit.referenceLinesExcludedFromCitationScan]
    ].forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'apa-audit-metric';
      const strong = document.createElement('strong'); strong.textContent = String(value);
      const span = document.createElement('span'); span.textContent = label;
      card.append(strong, span); summary.append(card);
    });
  }
  const referenceHost = $('#current-apa-audit-references');
  if (referenceHost) {
    referenceHost.replaceChildren();
    if (!audit.references.length) {
      const empty = document.createElement('p'); empty.className = 'figure-credits-empty';
      empty.textContent = 'No hay fichas de referencia candidatas en la PWA.';
      referenceHost.append(empty);
    } else {
      const countsByAuthorYear = new Map();
      audit.references.forEach((reference) => {
        const key = `${normalizeApaAuditText(reference.author)}|${reference.year.toLocaleLowerCase()}`;
        countsByAuthorYear.set(key, (countsByAuthorYear.get(key) || 0) + 1);
      });
      const list = document.createElement('ol');
      list.className = 'apa-unified-reference-items';
      audit.references.forEach((reference) => {
        const matchedCitations = audit.citations.filter((row) => row.referenceMatches.some((match) =>
          match.key === reference.key && match.normalizedText === reference.normalizedText));
        const item = document.createElement('li');
        item.className = 'apa-unified-reference-item';
        const citation = document.createElement('span');
        citation.className = 'apa-unified-reference-text';
        appendInlineText(citation, reference.text);
        const status = document.createElement('small');
        const authorYearKey = `${normalizeApaAuditText(reference.author)}|${reference.year.toLocaleLowerCase()}`;
        const variants = countsByAuthorYear.get(authorYearKey) || 1;
        const figureCreditCount = reference.relatedFigureIds?.length || 0;
        const figureCreditStatus = figureCreditCount
          ? `Crédito de figura vinculado a ${figureCreditCount} figura(s) · comprobar que la nota coincida con esta referencia`
          : '';
        status.textContent = matchedCitations.length
          ? `${matchedCitations.length} cita(s) autor-año candidata(s)${figureCreditStatus ? ` · ${figureCreditStatus}` : ''}`
          : figureCreditStatus || 'Sin cita autor-año detectada · revisar antes de retirar';
        if (variants > 1) status.textContent += ` · ${variants} fuentes del mismo autor y año: verificar si son obras distintas o duplicados`;
        const sourceLinks = document.createElement('span');
        sourceLinks.className = 'apa-unified-reference-sources';
        (reference.sourceEntryIds || [reference.entryId]).forEach((sourceEntryId, sourceIndex) => {
          const sourceLink = document.createElement('a');
          sourceLink.href = `#entry=${encodeURIComponent(sourceEntryId)}`;
          sourceLink.textContent = (reference.sourceEntryIds?.length || 1) > 1 ? `Ficha de origen ${sourceIndex + 1}` : 'Ficha en la PWA';
          sourceLink.setAttribute('aria-label', `Abrir ficha de referencia: ${reference.sourceTitles?.[sourceIndex] || reference.title}`);
          sourceLinks.append(sourceLink);
        });
        item.append(citation, status, sourceLinks);
        list.append(item);
      });
      referenceHost.append(list);
    }
  }
  const host = $('#current-apa-audit-citations');
  if (!host) return;
  host.replaceChildren();
  if (!audit.citations.length) {
    const empty = document.createElement('p'); empty.className = 'figure-credits-empty';
    empty.textContent = 'No se detectaron citas autor-año en las entradas activas de la biblioteca.';
    host.append(empty); return;
  }
  audit.citations.forEach((row) => {
    const card = document.createElement('article'); card.className = 'apa-audit-card';
    const title = document.createElement('strong'); title.textContent = `${row.author} (${row.year})`;
    const detail = document.createElement('span');
    detail.textContent = `${row.occurrences} mención(es) · ${row.personalCommunicationReview ? 'caso APA especial; determinar si es comunicación no recuperable o dato de entrevista propia' : row.referenceMatches.length > 1 ? 'varias referencias posibles; confirmar cuál se usó' : row.referenceMatches.length ? 'posible referencia encontrada en la PWA' : row.nearReferenceMatches?.length > 1 ? 'sin coincidencia exacta; revisar varias candidatas aproximadas' : row.nearReferenceMatches?.length ? 'sin coincidencia exacta; revisar posible errata' : 'sin referencia candidata detectada en la PWA'}`;
    card.append(title, detail);
    if (row.referenceMatches.length) {
      const references = document.createElement('span'); references.className = 'apa-audit-reference-match';
      references.textContent = row.referenceMatches.map((reference) => reference.text).join(' / ');
      card.append(references);
    } else if (row.nearReferenceMatches?.length) {
      const references = document.createElement('span'); references.className = 'apa-audit-reference-match';
      references.textContent = `${row.nearReferenceMatches.length > 1 ? 'Posibles erratas de autor (coincidencias aproximadas; hay varias fuentes posibles y requiere adjudicación manual)' : 'Posible errata de autor (coincidencia aproximada; requiere confirmación)'}: ${row.nearReferenceMatches.map((reference) => reference.text).join(' / ')}`;
      card.append(references);
    }
    if (row.personalCommunicationReview) {
      const note = document.createElement('span'); note.className = 'apa-audit-reference-match';
      note.textContent = 'Revisión: una comunicación no recuperable no va en la lista APA; una entrevista a participantes de esta investigación se presenta como dato de investigación. Comprobar el Anexo, la recuperabilidad y el nombre y fecha antes de clasificar.';
      card.append(note);
      if (row.interviewSourceCandidates?.length) {
        const interviewNote = document.createElement('span'); interviewNote.className = 'apa-audit-reference-match';
        interviewNote.append(document.createTextNode('Posibles registros internos de entrevista (cotejar; no son referencias APA ni confirman el respaldo): '));
        row.interviewSourceCandidates.forEach((candidate, index) => {
          if (index) interviewNote.append(document.createTextNode(' · '));
          const link = document.createElement('a'); link.href = `#entry=${encodeURIComponent(candidate.entryId)}`;
          link.textContent = candidate.title; interviewNote.append(link);
        });
        card.append(interviewNote);
      }
    }
    const links = document.createElement('span'); links.className = 'apa-audit-reference-match';
    row.locations.forEach((location, index) => {
      if (index) links.append(document.createTextNode(' · '));
      const link = document.createElement('a'); link.href = `#entry=${encodeURIComponent(location.entryId)}`;
      link.textContent = `Entrada: ${location.title}`; links.append(link);
    });
    row.referenceMatches.forEach((reference) => {
      const separator = document.createTextNode(' · '); links.append(separator);
      const link = document.createElement('a'); link.href = `#entry=${encodeURIComponent(reference.entryId)}`;
      link.textContent = `Fuente: ${reference.title}`; links.append(link);
    });
    row.nearReferenceMatches?.forEach((reference, index) => {
      const separator = document.createTextNode(' · '); links.append(separator);
      const link = document.createElement('a'); link.href = `#entry=${encodeURIComponent(reference.entryId)}`;
      link.textContent = `Candidata aproximada${row.nearReferenceMatches.length > 1 ? ` ${index + 1}` : ''}: ${reference.title}`; links.append(link);
    });
    card.append(links); host.append(card);
  });
}

async function renderHistoricalApaSnapshot() {
  const details = $('#apa-historical-snapshot');
  if (!details?.open || details.dataset.loaded === 'true' || details.dataset.loaded === 'loading') return;
  details.dataset.loaded = 'loading';
  try {
    const data = await loadApaAuditData();
    const summary = $('#apa-audit-summary');
    summary.replaceChildren();
    const metrics = [
      ['PDF', `${data.source.pages} páginas`],
      ['Menciones candidatas', data.summary.parentheticalYearCandidates],
      ['Candidatos autor-año', data.summary.uniqueParsedAuthorYears],
      ['Referencias históricas a revisar', data.summary.possibleUncitedHistoricalReferences]
    ];
    metrics.forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'apa-audit-metric';
      const strong = document.createElement('strong');
      strong.textContent = String(value);
      const span = document.createElement('span');
      span.textContent = label;
      card.append(strong, span);
      summary.append(card);
    });
    $('#apa-audit-source').textContent = `${data.source.label} · ${data.source.pages} páginas · SHA-256 ${data.source.sha256}`;
    const citations = [...(data.citations || [])].sort((a, b) => Number(b.occurrences) - Number(a.occurrences) || a.candidate_citation.localeCompare(b.candidate_citation, 'es'));
    renderApaAuditRows($('#apa-audit-citations'), citations, {
      title: (row) => row.candidate_citation,
      detail: (row) => `${row.occurrences} mención(es) · páginas ${row.pages || 'pendientes'} · ${row.historical_reference_matches ? `${row.historical_reference_matches} posible(s) coincidencia(s) en la lista histórica` : 'sin coincidencia automática en la lista histórica'}`,
      references: (row) => row.candidate_reference_titles
        ? `Referencia histórica candidata: ${row.candidate_reference_titles.split(' || ').join(' / ')}`
        : 'No se encontró coincidencia en el inventario histórico disponible.'
    }, 'No hay coincidencias autor-año para mostrar.');
    const references = data.historicalReferences || [];
    renderApaAuditRows($('#apa-audit-references'), references.filter((row) => !Number(row.mentions_detected)), {
      title: (row) => row.historical_reference,
      detail: (row) => `Inventario IDML histórico · ${row.preliminary_status}`
    }, 'No hay referencias candidatas en esta lista.');
    renderApaAuditRows($('#apa-audit-occurrences-list'), data.occurrences || [], {
      title: (row) => `p. ${row.page} · ${row.raw_candidate}`,
      detail: (row) => `${row.candidate_author_years || row.candidate_class} · ${row.decision}`
    }, 'No se encontraron menciones.');
    $('#apa-audit-limitations').textContent = data.limitations.join(' ');
    details.dataset.loaded = 'true';
  } catch (error) {
    apaAuditDataPromise = null;
    const host = $('#apa-audit-summary');
    host.replaceChildren();
    const message = document.createElement('p');
    message.className = 'figure-credits-empty';
    message.textContent = `${error.message} El control APA actual sigue funcionando; el archivo histórico puede consultarse cuando esté disponible.`;
    host.append(message);
    details.dataset.loaded = '';
  }
}

async function renderApaAudit() {
  const page = $('#apa-audit-page');
  if (!page || page.hidden) return;
  renderCurrentPwaApaAudit();
  if (page.dataset.loaded === 'true' || page.dataset.loaded === 'loading') return;
  page.dataset.loaded = 'loading';
  try {
    const reviewRegister = await loadApaReviewRegister();
    if (!showApaAudit || page.hidden) { page.dataset.loaded = ''; return; }
    const reviewRegisterSource = $('#apa-review-register-source');
    if (reviewRegisterSource) reviewRegisterSource.textContent = `${reviewRegister.cases.length} casos · ${reviewRegister.provenance.artifact} · SHA-256 ${reviewRegister.provenance.sha256}`;
    renderApaReviewRegister($('#apa-review-cases'), reviewRegister);
    page.dataset.loaded = 'true';
  } catch (error) {
    apaReviewRegisterPromise = null;
    page.dataset.loaded = '';
    const host = $('#apa-review-cases');
    host.replaceChildren();
    const message = document.createElement('p');
    message.className = 'figure-credits-empty';
    message.textContent = `No se pudo abrir el registro manual incluido en esta PWA: ${error.message}`;
    host.append(message);
  }
}

function currentEntry() {
  return entries.find((entry) => entry.id === selectedId);
}

function selectEntry(id) {
  if (!libraryMounted) return;
  selectedId = id;
  const entry = currentEntry();
  if (!entry) return;
  $('#editor-kind-label').textContent = entry.type.toLocaleUpperCase('es');
  $('#reader-title').textContent = displayEntryTitle(entry);
  $('#reader-meta').textContent = [entry.type, entry.area, entry.status].filter(Boolean).join(' · ');
  renderEntryContent(entry);
  $('#updated-label').textContent = `Actualizada ${relativeDate(entry.updatedAt)}`;
  $('#entry-save-state').textContent = 'Lectura';
  const words = entry.content?.trim().match(/\S+/gu)?.length ?? 0;
  $('#word-count').textContent = `${words} ${words === 1 ? 'palabra' : 'palabras'}`;
  renderList();
}

function appendInlineText(parent, value) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(?<!\*)\*[^*]+\*(?!\*))/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset) parent.append(document.createTextNode(value.slice(offset, start)));
    const token = match[0];
    const code = token.startsWith('`');
    const strong = token.startsWith('**') || token.startsWith('__');
    const wrapper = document.createElement(code ? 'code' : strong ? 'strong' : 'em');
    wrapper.textContent = token.slice(strong ? 2 : 1, strong ? -2 : -1);
    parent.append(wrapper);
    offset = start + token.length;
  }
  if (offset < value.length) parent.append(document.createTextNode(value.slice(offset)));
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line) || /^\s*\+[\-+:|\s]+\+\s*$/.test(line);
}

function renderFormattedText(value, host, context = {}) {
  const lines = String(value ?? '').replace(/\r/g, '').split('\n');
  const followingParagraphs = (fromIndex) => {
    const result = [];
    for (let cursor = fromIndex + 1; cursor < lines.length && result.length < 2; cursor += 1) {
      const next = lines[cursor].trim();
      if (next) result.push(next);
    }
    for (const next of context.nextParagraphs || []) {
      if (result.length >= 2) break;
      if (next?.trim()) result.push(next.trim());
    }
    return result;
  };
  const isShortHeading = (text) => text.length >= 4 && text.length <= 95
    && !/[.!?;:]$/.test(text)
    && !/^(?:#{1,6}\s|[-*+]\s)/i.test(text)
    && !/\b\d\s*\/\s*\d\b/.test(text);
  const shouldPromoteToHeading = (text, next) => {
    if (!text || !next.length) return false;
    if (context.figureCreditRecords && /^Figura\s*#?\s*\d+\./i.test(text)) return false;
    const plainText = (value) => value.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim()
      .toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ');
    if ([context.entryTitle, context.entryOriginalTitle].filter(Boolean)
      .some((title) => plainText(text) === plainText(title))) return false;
    if (/^[a-z][.)]\s*\S.{1,100}$/i.test(text)) {
      return next.some((candidate) => candidate.length >= 80);
    }
    if (!isShortHeading(text)) return false;
    return next[0].length >= 120
      || (isShortHeading(next[0]) && next[1]?.length >= 120)
      || (/^#{1,6}\s/.test(next[0]) && next[0].length > text.length);
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }

    const boldLead = line.match(/^\*\*(.+?)\*\*:?$/);
    const colonLead = line.match(/^(.{2,100}):$/);
    const standaloneLabel = (boldLead?.[1] || colonLead?.[1])?.replace(/:$/, '');
    if (standaloneLabel) {
      const paragraph = document.createElement('p');
      paragraph.className = 'reader-paragraph';
      const strong = document.createElement('strong');
      strong.textContent = `${standaloneLabel}:`;
      paragraph.append(strong);
      host.append(paragraph);
      index += 1;
      continue;
    }

    if (context.autoHeadings !== false && shouldPromoteToHeading(line, followingParagraphs(index))) {
      const heading = document.createElement('h4');
      heading.className = 'reader-subheading';
      appendInlineText(heading, line);
      host.append(heading);
      index += 1;
      continue;
    }

    if (isTableLine(lines[index])) {
      const rows = [];
      while (index < lines.length) {
        if (!lines[index].trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          if (next < lines.length && isTableLine(lines[next])) { index = next; continue; }
          break;
        }
        if (!isTableLine(lines[index])) break;
        const row = lines[index].trim();
        if (!/^\+[\-+:|\s]+\+$/.test(row)) {
          const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
          if (cells.some(Boolean)) rows.push(cells);
        }
        index += 1;
      }
      if (rows.length) {
        const table = document.createElement('table');
        table.className = 'reader-table';
        const head = document.createElement('thead');
        const headerRow = document.createElement('tr');
        rows[0].forEach((cell) => { const th = document.createElement('th'); appendInlineText(th, cell); headerRow.append(th); });
        head.append(headerRow);
        table.append(head);
        if (rows.length > 1) {
          const body = document.createElement('tbody');
          rows.slice(1).forEach((cells) => {
            const row = document.createElement('tr');
            cells.forEach((cell) => { const td = document.createElement('td'); appendInlineText(td, cell); row.append(td); });
            body.append(row);
          });
          table.append(body);
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'reader-table-scroll';
        wrapper.append(table);
        host.append(wrapper);
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
      element.className = 'reader-subheading';
      appendInlineText(element, heading[2]);
      host.append(element);
      index += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line)) { const divider = document.createElement('hr'); host.append(divider); index += 1; continue; }
    const firstListType = /^\d+[.)]\s+/.test(line) ? 'ordered'
      : /^[a-z][.)]\s+/i.test(line) ? 'alpha'
        : /^[-*+]\s+/.test(line) ? 'unordered' : null;
    if (firstListType) {
      const list = document.createElement(firstListType === 'unordered' ? 'ul' : 'ol');
      if (firstListType === 'alpha') list.type = 'a';
      list.className = 'reader-list';
      const matchesListType = (candidate) => firstListType === 'ordered' ? /^\s*\d+[.)]\s+/.test(candidate)
        : firstListType === 'alpha' ? /^\s*[a-z][.)]\s+/i.test(candidate)
          : /^\s*[-*+]\s+/.test(candidate);
      while (index < lines.length) {
        if (!lines[index].trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          if (next >= lines.length || !matchesListType(lines[next])) break;
          index = next;
        }
        if (!matchesListType(lines[index])) break;
        const item = document.createElement('li');
        appendInlineText(item, lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i, ''));
        list.append(item);
        index += 1;
      }
      host.append(list);
      continue;
    }

    const paragraph = document.createElement('p');
    paragraph.className = 'reader-paragraph';
    const figureCredit = context.figureCreditRecords
      ? line.match(/^(Figura\s*#?\s*(\d+)\.\s*)(.*?)(?:\t+(\d+))?$/)
      : null;
    const explicitFigureTarget = figureCredit
      ? context.figureCreditTargetOverrides?.[figureCredit[2]]
      : null;
    const figureRecord = figureCredit
      ? resolveFigureCreditTarget(explicitFigureTarget, context.figureCreditRecords)
        || findFigureCreditRecordByTitle(figureCredit[3], context.figureCreditRecords)
      : null;
    if (figureRecord) {
      const link = document.createElement('a');
      link.className = 'reader-figure-credit-target';
      link.href = figureRecord.figureKey
        ? `#entry=${encodeURIComponent(figureRecord.entry.id)}&figure=${encodeURIComponent(figureRecord.figureKey)}`
        : `#entry=${encodeURIComponent(figureRecord.entry.id)}`;
      if (figureRecord.figureKey) {
        link.dataset.figureEntryId = figureRecord.entry.id;
        link.dataset.figureKey = figureRecord.figureKey;
      }
      link.setAttribute('aria-label', `Abrir Figura ${figureCredit[2]}: ${figureCredit[3]} en su entrada`);
      appendInlineText(link, `${figureCredit[1]}${figureCredit[3]}`);
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        pendingFigureLocation = figureRecord.figureKey
          ? { entryId: figureRecord.entry.id, figureKey: figureRecord.figureKey }
          : null;
        setEntryLocation(figureRecord.entry.id, 'push', figureRecord.figureKey || '');
        showEntryById(figureRecord.entry.id);
      });
      paragraph.append(link);
      if (figureCredit[4]) paragraph.append(document.createTextNode(`\t${figureCredit[4]}`));
    } else {
      appendInlineText(paragraph, line);
      const unresolvedTarget = figureCredit
        ? context.figureCreditTargetsPending?.[figureCredit[2]]
        : null;
      if (unresolvedTarget) {
        const pendingNote = document.createElement('span');
        pendingNote.className = 'reader-figure-credit-pending';
        pendingNote.textContent = ' · Destino pendiente en la PWA';
        pendingNote.title = unresolvedTarget.reason || 'No se ha confirmado la ubicación de esta figura en la PWA.';
        paragraph.append(pendingNote);
      }
    }
    host.append(paragraph);
    index += 1;
  }
}

function recoveredFigureKey(entryId, collection, index, block) {
  return block.figureId || `recovered:${entryId}:${collection}:${index}:${block.filename || 'figura'}`;
}

function normalizeFigureCreditTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function resolveFigureCreditTarget(target, records) {
  if (!target?.entryId || !Array.isArray(records)) return null;
  const figureRecord = target.figureKey
    ? records.find((record) => record.entry.id === target.entryId && record.figureKey === target.figureKey)
    : null;
  if (figureRecord) return figureRecord;
  if (target.figureKey) return null;
  const entry = entries.find((candidate) => candidate.id === target.entryId);
  return entry ? { entry, figureKey: '' } : null;
}

function findFigureCreditRecordByTitle(sourceTitle, records) {
  if (!Array.isArray(records)) return null;
  const title = normalizeFigureCreditTitle(sourceTitle);
  if (!title) return null;
  const matches = records.filter((record) => {
    const candidates = [
      record.citation?.figureTitle,
      record.image?.caption,
      record.image?.filename,
      record.image?.alt
    ].map(normalizeFigureCreditTitle).filter(Boolean);
    return candidates.includes(title);
  });
  return matches.length === 1 ? matches[0] : null;
}

function invalidateFigureCreditsCache() {
  figureCreditsCache = { entries: null, orderVersion: '', records: [] };
}

function syncEntryInMemory(entry) {
  const index = entries.findIndex((current) => current.id === entry.id);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  // Entry edits and insertions can change both reading order and every
  // derived number, even when the entries array keeps the same identity.
  atlasNumberingCache = null;
  apaCitationNavigationAudit = null;
  invalidateFigureCreditsCache();
}

function collectFigureCredits(includeExcluded = false) {
  if (figureCreditsCache.entries !== entries || figureCreditsCache.orderVersion !== atlasOrderState.updatedAt) {
    const orderedEntries = [...entries].sort(compareEntriesByReadingOrder);
    const records = [];
    orderedEntries.forEach((entry) => {
      const bundled = bundledContentById.get(entry.id);
      const sourceBlocks = Array.isArray(bundled?.contentBlocks) ? bundled.contentBlocks : [];
      const sourceMatches = bundled && entry.content === bundled.content;
      const localBlocks = Array.isArray(entry.contentBlocks) ? entry.contentBlocks : null;
      const snapshotBlocks = Array.isArray(entry.originalSnapshot?.contentBlocks) ? entry.originalSnapshot.contentBlocks : null;
      const blocks = entry.localEditedAt && localBlocks
        ? localBlocks
        : sourceMatches && sourceBlocks.length ? sourceBlocks : localBlocks || snapshotBlocks;
      const sourceMedia = blocks?.some((block) => ['figure', 'document', 'missing'].includes(block.type))
        ? []
        : (entry.sourceMedia?.length ? entry.sourceMedia : (sourceMatches ? [] : sourceBlocks.filter((block) => ['figure', 'document', 'missing'].includes(block.type))));
      (blocks || []).forEach((block, index) => {
        if (block.type !== 'figure' || typeof block.src !== 'string') return;
        const figureKey = recoveredFigureKey(entry.id, 'blocks', index, block);
        records.push({ entry, image: block, figureKey, recovered: true, citation: entry.figureCitations?.[figureKey] || block.citation || {} });
      });
      sourceMedia.forEach((block, index) => {
        if (block.type !== 'figure' || typeof block.src !== 'string') return;
        const figureKey = recoveredFigureKey(entry.id, 'media', index, block);
        records.push({ entry, image: block, figureKey, recovered: true, citation: entry.figureCitations?.[figureKey] || block.citation || {} });
      });
      (Array.isArray(entry.images) ? entry.images : []).forEach((image) => {
        records.push({ entry, image, figureKey: image.id || `added:${entry.id}:${records.length}`, recovered: false, citation: image.citation || {} });
      });
    });
    figureCreditsCache = {
      entries,
      orderVersion: atlasOrderState.updatedAt,
      records: records.map((record, index) => ({ ...record, figureNumber: index + 1 }))
    };
  }
  const records = figureCreditsCache.records;
  return includeExcluded ? records : records.filter(({ citation }) => citation.includeInCredits !== false);
}

let figureCreditsCache = { entries: null, orderVersion: '', records: [] };

function figureSourceSummary(citation) {
  if (citation.sourceType === 'generated-ai') return `Generada con IA · ${[citation.sourceTitle || citation.publisher, citation.generationYear || citation.year].filter(Boolean).join(' · ') || 'datos por completar'}`;
  if (citation.sourceType === 'original') return 'Imagen de creación propia';
  if (citation.sourceType === 'personal-communication') return [citation.provider ? `Proporcionada por ${citation.provider}` : 'Fotografía proporcionada por persona no identificada', citation.year && citation.year !== 's. f.' ? `comunicación personal · ${citation.year}` : 'comunicación personal · fecha no indicada'].join(' · ');
  return [citation.creator, citation.year, citation.sourceTitle || citation.publisher, citation.doi || citation.url]
    .filter(Boolean).join('. ') || 'Fuente pendiente de identificar';
}

function figureReviewState(citation) {
  if (!citation.sourceType || citation.sourceType === 'unknown') return 'Procedencia pendiente';
  if (citation.sourceType === 'personal-communication') {
    if (citation.permissionStatus !== 'granted') return 'Revisar derechos';
    return citation.provider ? 'Permiso registrado · falta verificar autoría fotográfica' : 'Falta identificar a quien proporcionó la imagen';
  }
  if (citation.sourceType === 'generated-ai' && !(citation.sourceTitle && citation.generationYear)) return 'Falta identificar la herramienta y el año de generación';
  if (citation.sourceType !== 'original' && !(citation.creator && citation.workTitle && (citation.url || citation.doi || citation.sourceTitle))) return 'Faltan datos de fuente';
  if (citation.sourceType !== 'original' && ['unknown', 'requested', 'not-granted'].includes(citation.permissionStatus || 'unknown') && !citation.license) return 'Revisar derechos';
  return 'Borrador · requiere revisión';
}

function figureReferenceDraft({ citation }) {
  if (citation.sourceType === 'original') return 'Imagen de creación propia: normalmente no genera una referencia externa; confirma el criterio institucional.';
  if (citation.sourceType === 'personal-communication') return 'No se agrega a Referencias: comunicación personal no recuperable. Mantén la atribución y el permiso en la nota de figura.';
  const missing = [];
  if (!citation.creator) missing.push('autor/entidad');
  if (!citation.year) missing.push('año');
  if (!citation.workTitle) missing.push('título de la obra');
  if (!(citation.url || citation.doi || citation.sourceTitle)) missing.push('fuente localizable o DOI/URL');
  if (missing.length) return `Pendiente: completar ${missing.join(', ')}. No se genera una referencia completa con datos incompletos.`;
  const year = citation.year === 's. f.' || citation.year.toLowerCase() === 'n.d.' ? citation.year : citation.year;
  const mediumLabels = { image: 'Imagen', photograph: 'Fotografía', illustration: 'Ilustración', map: 'Mapa', screenshot: 'Captura de pantalla', infographic: 'Infografía', artwork: 'Obra de arte', video: 'Video', other: 'Recurso visual' };
  const isBook = citation.sourceType === 'book';
  const isWebpage = citation.medium === 'webpage';
  const title = citation.workTitle ? citation.sourceType === 'generated-ai' || isBook || isWebpage ? citation.workTitle : `${citation.workTitle} [${mediumLabels[citation.medium] || 'Imagen'}]` : '';
  const date = citation.date || year;
  const description = citation.sourceType === 'generated-ai' ? ` [${citation.aiToolDescription || 'Herramienta de generación de imágenes con IA'}]` : '';
  const publisherName = citation.sourceTitle || citation.publisher || '';
  const publisher = citation.sourceType === 'generated-ai' || publisherName.trim().toLocaleLowerCase('es') === String(citation.creator || '').trim().toLocaleLowerCase('es')
    ? ''
    : publisherName;
  return `${citation.creator}. (${date}). ${title}${description}. ${publisher}${citation.doi || citation.url ? `. ${citation.doi || citation.url}` : ''}`.replace(/\.\s*\./g, '.').trim();
}

function figureCreditNoteDraft(citation) {
  if (citation.sourceType === 'original') return 'Nota. Imagen de elaboración propia.';
  if (citation.creditNote) return citation.creditNote;
  if (citation.sourceType === 'personal-communication') {
    const date = citation.year && citation.year !== 's. f.' ? ` (comunicación personal, ${citation.year})` : ' (comunicación personal, s. f.)';
    return citation.provider
      ? `Nota. Fotografía proporcionada por ${citation.provider}${date}${citation.permissionStatus === 'granted' ? '; utilizada con autorización.' : '.'}`
      : 'Pendiente: identificar a quien proporcionó la fotografía y confirmar el permiso de uso.';
  }
  if (citation.sourceType === 'generated-ai') {
    if (!(citation.sourceTitle && citation.generationYear)) return 'Pendiente: registrar la herramienta de IA y el año de generación antes de redactar la nota.';
    const referenceDate = citation.creator && citation.year ? ` (${citation.creator}, ${citation.year})` : citation.creator ? ` (${citation.creator})` : '';
    const generatedDate = citation.year && citation.generationYear !== citation.year ? `, en ${citation.generationYear}` : '';
    const incomplete = !(citation.creator && citation.year && citation.workTitle && (citation.url || citation.doi || citation.sourceTitle));
    return `Nota. Imagen generada con ${citation.sourceTitle}${referenceDate}${generatedDate}.${incomplete ? ' [Referencia APA pendiente de completar]' : ''}`;
  }
  const missing = [];
  if (!citation.workTitle) missing.push('título de la obra');
  if (!citation.creator) missing.push('autor o entidad');
  if (!citation.year) missing.push('año');
  if (!(citation.sourceTitle || citation.publisher || citation.url || citation.doi)) missing.push('fuente');
  if (missing.length) return `Pendiente: completar ${missing.join(', ')} antes de redactar la nota.`;
  const action = citation.sourceType === 'adapted' ? 'Adaptada' : 'Reproducida';
  const source = [citation.sourceTitle || citation.publisher, citation.doi || citation.url].filter(Boolean).join(', ');
  const parts = [`Nota. ${action} de «${citation.workTitle}», por ${citation.creator} (${citation.year})${source ? `, ${source}` : ''}`];
  if (citation.copyrightYear || citation.rightsHolder) parts.push(`Copyright ${citation.copyrightYear || citation.year} por ${citation.rightsHolder || citation.creator}`);
  if (citation.license) parts.push(`Licencia: ${citation.license}${citation.licenseUrl ? ` (${citation.licenseUrl})` : ''}`);
  if (citation.permissionStatus === 'granted') parts.push('Uso autorizado según el permiso registrado');
  if (citation.adaptation) parts.push(`Cambios: ${citation.adaptation}`);
  return `${parts.join('. ')}. [Borrador: revisar el crédito y las condiciones de uso antes de entregar]`;
}

function appendApaFigureReference(item, record, reference) {
  const citation = record?.citation || {};
  if (citation.sourceType === 'personal-communication' || citation.sourceType === 'original'
    || !citation.creator || !citation.year || !citation.workTitle || !(citation.url || citation.doi || citation.sourceTitle || citation.publisher)) {
    item.textContent = reference;
    return;
  }
  const title = document.createElement('em');
  title.textContent = citation.workTitle;
  const descriptions = { image: 'Imagen', photograph: 'Fotografía', illustration: 'Ilustración', map: 'Mapa', screenshot: 'Captura de pantalla', infographic: 'Infografía', artwork: 'Obra de arte', video: 'Video', other: 'Recurso visual' };
  const isGenerated = citation.sourceType === 'generated-ai';
  const isBook = citation.sourceType === 'book';
  const hasDescription = isGenerated || (!isBook && citation.medium !== 'webpage');
  const description = isGenerated ? (citation.aiToolDescription || 'Herramienta de generación de imágenes con IA') : descriptions[citation.medium] || 'Recurso visual';
  const publisherName = citation.sourceTitle || citation.publisher || '';
  const publisher = isGenerated || publisherName.trim().toLocaleLowerCase('es') === String(citation.creator).trim().toLocaleLowerCase('es') ? '' : publisherName;
  item.append(`${citation.creator}. (${citation.date || citation.year}). `, title);
  if (hasDescription) item.append(` [${description}]`);
  item.append('.');
  if (publisher) item.append(` ${publisher}`);
  if (citation.doi || citation.url) item.append(`. ${citation.doi || citation.url}`);
}

function appendReaderFigureNotes(caption, blockCaption, citation = {}) {
  const textValue = (value) => String(value || '').trim().replace(/^nota\.\s*/i, '').trim();
  const description = textValue(blockCaption);
  const credit = String(citation.creditNote || '').trim();
  const generatedImageCaption = /^imagen generada con .+/i.test(description);
  const generatedImageCredit = /^nota\.\s*imagen generada con .+|^imagen generada con .+/i.test(credit);
  if (description && !(generatedImageCaption && generatedImageCredit)) {
    const note = document.createElement('span');
    note.textContent = `Nota. ${description}`;
    caption.append(note);
  }
  if (!credit || textValue(credit) === description) return;
  const sourceNote = document.createElement('span');
  sourceNote.className = 'reader-figure-credit-note';
  sourceNote.textContent = credit;
  caption.append(sourceNote);
}

function collectUnlinkedFigureReferenceCandidates(sourceEntries = entries) {
  const source = sourceEntries.find((entry) => entry.id === 'idml-r1-u1ed5' && entry.referenceListSnapshot === true);
  if (!source || typeof source.content !== 'string') return [];
  const lines = source.content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^referencias de im[aá]genes\s*$/i.test(line.trim()));
  if (headingIndex < 0) return [];
  return lines.slice(headingIndex + 1).flatMap((text, index) => {
    const candidate = text.trim();
    if (!candidate || !/(?:https?:\/\/|\b(?:19|20)\d{2}\b|\bs\.\s*f\.)/i.test(candidate)) return [];
    return [{ sourceEntryId: source.id, sourceLine: headingIndex + index + 2, text: candidate }];
  });
}

function renderUnlinkedFigureReferenceCandidates(host) {
  const candidates = collectUnlinkedFigureReferenceCandidates();
  if (!host || !candidates.length) return candidates;
  const section = document.createElement('section');
  section.className = 'figure-reference-candidates';
  const heading = document.createElement('h3');
  heading.textContent = 'Referencias de imágenes por vincular';
  const help = document.createElement('p');
  help.textContent = 'Candidatas recuperadas de la lista interna. No están asociadas a una figura concreta y no confirman autoría, licencia ni permiso.';
  const sourceLink = document.createElement('a');
  sourceLink.href = `#entry=${encodeURIComponent(candidates[0].sourceEntryId)}`;
  sourceLink.textContent = 'Abrir la lista de referencias de origen';
  const list = document.createElement('ol');
  list.className = 'figure-reference-list';
  candidates.forEach((candidate) => {
    const item = document.createElement('li');
    item.textContent = `${candidate.text} · Lista interna, línea ${candidate.sourceLine}`;
    list.append(item);
  });
  section.append(heading, help, sourceLink, list);
  host.append(section);
  return candidates;
}

function renderFigureCredits() {
  const host = $('#figure-credits-list');
  const referenceHost = $('#figure-reference-drafts');
  if (!host || !referenceHost) return;
  const records = collectFigureCredits();
  host.replaceChildren();
  referenceHost.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'figure-credits-empty';
    empty.textContent = 'No hay figuras seleccionadas para aparecer en el listado. Abre una entrada en modo Editar para ajustar la inclusión de sus imágenes.';
    host.append(empty);
  }
  records.forEach(({ entry, image, citation, figureNumber, figureKey }) => {
    const card = document.createElement('article');
    card.className = 'figure-credit-card';
    const heading = document.createElement('div');
    heading.className = 'figure-credit-title';
    const target = document.createElement('a');
    target.className = 'figure-credit-target';
    target.href = `#entry=${encodeURIComponent(entry.id)}&figure=${encodeURIComponent(figureKey)}`;
    target.dataset.figureEntryId = entry.id;
    target.dataset.figureKey = figureKey;
    target.setAttribute('aria-label', `Abrir Figura ${figureNumber}: ${citation.figureTitle || image.filename || 'Título pendiente'} en su entrada`);
    const figureLabel = document.createElement('span');
    figureLabel.textContent = `Figura ${figureNumber}`;
    const title = document.createElement('strong');
    title.textContent = citation.figureTitle || image.filename || 'Título pendiente';
    target.append(figureLabel, title);
    target.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pendingFigureLocation = { entryId: entry.id, figureKey };
      setEntryLocation(entry.id, 'push', figureKey);
      showEntryById(entry.id);
    });
    heading.append(target);
    const location = document.createElement('p');
    location.textContent = `Entrada: ${entry.title}`;
    const source = document.createElement('p');
    source.textContent = `Fuente: ${figureSourceSummary(citation)}`;
    const state = document.createElement('span');
    state.className = 'figure-credit-status';
    state.textContent = figureReviewState(citation);
    const rights = document.createElement('p');
    const rightsParts = [citation.rightsHolder ? `titular: ${citation.rightsHolder}` : '', citation.copyrightYear ? `copyright ${citation.copyrightYear}` : '', citation.license ? `licencia: ${citation.license}` : '']
      .filter(Boolean);
    rightsParts.push(citation.permissionStatus === 'granted' ? 'permiso concedido' : citation.permissionStatus === 'not-required' ? 'indicado como no requerido' : 'permiso pendiente de revisar');
    if (citation.permissionEvidence) rightsParts.push(`evidencia: ${citation.permissionEvidence}`);
    if (citation.licenseUrl) rightsParts.push(`condiciones: ${citation.licenseUrl}`);
    rights.textContent = `Derechos: ${rightsParts.join(' · ')}`;
    const note = document.createElement('p');
    note.className = 'figure-credit-note';
    note.textContent = citation.adaptation ? `Adaptación: ${citation.adaptation}` : citation.sourceType === 'adapted' ? 'Falta describir los cambios realizados.' : '';
    const descriptiveNote = document.createElement('p');
    descriptiveNote.className = 'figure-credit-note';
    descriptiveNote.textContent = image.caption ? `Nota bajo la figura: ${image.caption}` : '';
    const creditDraft = document.createElement('p');
    creditDraft.className = 'figure-credit-note';
    creditDraft.textContent = `Borrador de nota de crédito: ${figureCreditNoteDraft(citation)}`;
    card.append(heading, location, source, rights, state);
    if (descriptiveNote.textContent) card.append(descriptiveNote);
    card.append(creditDraft);
    if (note.textContent) card.append(note);
    host.append(card);
  });
  const referenceRecords = records.filter(({ citation }) => citation.includeInReferences !== false);
  if (referenceRecords.length) {
    const heading = document.createElement('h3');
    heading.textContent = 'Borradores para revisar en Referencias APA 7';
    const help = document.createElement('p');
    help.textContent = 'Se construyen solo con los datos ingresados. Verifica el tipo de fuente y el ejemplo APA aplicable antes de incorporarlos a la bibliografía.';
    const list = document.createElement('ol');
    list.className = 'figure-reference-list';
    const uniqueReferences = new Map();
    referenceRecords.forEach((record) => {
      const reference = figureReferenceDraft(record);
      const key = reference.startsWith('Pendiente:') ? `${record.entry.id}:${record.figureKey}` : reference;
      if (!uniqueReferences.has(key)) uniqueReferences.set(key, { record, reference });
    });
    uniqueReferences.forEach(({ record, reference }) => {
      const item = document.createElement('li');
      if (reference.startsWith('Pendiente:')) item.textContent = `${record.entry.title} · Figura ${record.figureNumber}: ${reference}`;
      else appendApaFigureReference(item, record, reference);
      list.append(item);
    });
    referenceHost.append(heading, help, list);
  }
  renderUnlinkedFigureReferenceCandidates(referenceHost);
}

function figureCreditsPlainText() {
  const records = collectFigureCredits();
  const candidates = collectUnlinkedFigureReferenceCandidates();
  return [
    'CRÉDITOS DE FIGURAS',
    ...records.map(({ entry, image, citation, figureNumber }) => [
      `Figura ${figureNumber}. ${citation.figureTitle || image.filename || 'Título pendiente'}.`,
      `Entrada: ${entry.title}.`,
      `Fuente: ${figureSourceSummary(citation)}.`,
      `Derechos: ${citation.permissionStatus === 'granted' ? 'permiso concedido' : citation.permissionStatus === 'not-required' ? 'indicado como no requerido' : citation.license ? `licencia ${citation.license}` : 'pendientes de revisar'}.`,
      `Borrador de nota de crédito: ${figureCreditNoteDraft(citation)}`,
      image.caption ? `Nota bajo la figura: ${image.caption}.` : '',
      citation.adaptation ? `Adaptación: ${citation.adaptation}.` : '',
      `Estado: ${figureReviewState(citation)}.`
    ].filter(Boolean).join('\n')),
    ...(candidates.length ? [
      'REFERENCIAS DE IMÁGENES POR VINCULAR',
      'Candidatas de la lista interna; no están asociadas a una figura concreta y no confirman autoría, licencia ni permiso.',
      ...candidates.map((candidate) => `${candidate.text} [Lista interna, línea ${candidate.sourceLine}]`)
    ] : [])
  ].join('\n\n');
}

function renderFigureCreditIndex(host) {
  const records = collectFigureCredits(true);
  const heading = document.createElement('h3');
  heading.className = 'reader-subheading';
  heading.textContent = 'Listado automático de figuras';
  const intro = document.createElement('p');
  intro.className = 'reader-paragraph figure-index-intro';
  intro.textContent = `Índice generado desde las ${records.length} figuras guardadas en la PWA. Los números siguen el orden actual del Atlas y cada título abre la figura en su entrada.`;
  const list = document.createElement('ol');
  list.className = 'reader-figure-index';
  records.forEach(({ entry, image, citation, figureNumber, figureKey }) => {
    const item = document.createElement('li');
    item.id = figureIndexItemId(figureKey);
    const link = document.createElement('a');
    link.className = 'reader-figure-index-link';
    link.href = `#entry=${encodeURIComponent(entry.id)}&figure=${encodeURIComponent(figureKey)}`;
    link.dataset.figureEntryId = entry.id;
    link.dataset.figureKey = figureKey;
    const title = citation.figureTitle || image.caption || image.filename || image.alt || 'Título pendiente';
    link.setAttribute('aria-label', `Abrir Figura ${figureNumber}: ${title} en ${entry.title}`);
    const label = document.createElement('span');
    label.className = 'reader-figure-index-number';
    label.textContent = String(figureNumber).padStart(2, '0');
    const titleNode = document.createElement('span');
    titleNode.className = 'reader-figure-index-title';
    titleNode.textContent = title.replace(/\.[a-z0-9]{2,5}$/i, '');
    const location = document.createElement('span');
    location.className = 'reader-figure-index-location';
    location.textContent = entry.title;
    link.append(label, titleNode, location);
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pendingFigureLocation = { entryId: entry.id, figureKey };
      setEntryLocation(entry.id, 'push', figureKey);
      showEntryById(entry.id);
    });
    item.append(link);
    list.append(item);
  });
  host.append(heading, intro, list);
}

function contentsIndexTargetLabel(targetId) {
  if (targetId?.startsWith('phase:')) {
    const phase = orderedPhases().find((item) => item.id === targetId.slice('phase:'.length));
    return phase ? `${phase.number ? `${phase.number} · ` : ''}${phase.label}` : '';
  }
  if (targetId?.startsWith('node:')) {
    const node = getGuideNodeById(targetId.slice('node:'.length));
    return node ? `${node.number ? `${node.number} · ` : ''}${node.label}` : '';
  }
  return '';
}

function contentsIndexHasTarget(targetId) {
  if (targetId?.startsWith('phase:')) {
    const phaseId = targetId.slice('phase:'.length);
    return !['preliminares', 'sin-clasificar'].includes(phaseId)
      && orderedPhases().some((phase) => phase.id === phaseId);
  }
  if (!targetId?.startsWith('node:')) return false;
  const nodeId = targetId.slice('node:'.length);
  const preliminary = orderedPhases().find((phase) => phase.id === 'preliminares');
  if (preliminary && atlasEntryNodesForPhase(preliminary).some((node) => node.id === nodeId
    && ['resumen', 'introduccion'].includes(normalizeEditorialText(node.label)))) return true;
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
  return orderedPhases()
    .filter((phase) => !['preliminares', 'sin-clasificar'].includes(phase.id))
    .some((phase) => flatten(atlasNodesForPhase(phase)).some((node) => node.id === nodeId));
}

function contentsIndexReturnForEntry(entry) {
  if (!entry || entry.id === 'idml-r1-u4237') return null;
  const openedFromIndex = pendingTocLocation?.entryId === entry.id;
  const targetId = openedFromIndex
    ? pendingTocLocation.targetId
    : (() => {
        const node = guideNodeForEntry(entry);
        if (!node) return null;
        return node.isPhase ? `phase:${node.id}` : `node:${node.id}`;
      })();
  if (!contentsIndexHasTarget(targetId)) return null;
  const indexEntry = contentsIndexEntryForTarget(targetId);
  if (indexEntry?.id !== entry.id) return null;
  const label = contentsIndexTargetLabel(targetId);
  return targetId && label ? { targetId, label } : null;
}

function contentsIndexEntryForTarget(targetId) {
  if (targetId?.startsWith('phase:')) {
    const phaseId = targetId.slice('phase:'.length);
    return entries
      .filter((entry) => entry.id !== 'idml-r1-u4237' && isAtlasBibliographyEntryVisible(entry))
      .filter((entry) => guideNodeForEntry(entry)?.phaseId === phaseId)
      .sort(compareEntriesByReadingOrder)[0] || null;
  }
  if (!targetId?.startsWith('node:')) return null;
  const node = getGuideNodeById(targetId.slice('node:'.length));
  if (!node) return null;
  const phaseId = node.phaseId || orderedPhases().find((phase) => atlasNodesForPhase(phase).some((candidate) => candidate.id === node.id))?.id;
  return contentsIndexEntryForNode(node, phaseId);
}

function contentsIndexEntryForNode(node, phaseId) {
  const nodeIds = new Set();
  const collect = (current) => {
    nodeIds.add(current.id);
    (current.children ?? []).forEach(collect);
  };
  collect(node);
  const candidates = entries
    .filter((entry) => entry.id !== 'idml-r1-u4237' && isAtlasBibliographyEntryVisible(entry))
    .filter((entry) => {
      const assigned = guideNodeForEntry(entry);
      return assigned?.phaseId === phaseId && nodeIds.has(assigned.id);
    })
    .sort(compareEntriesByReadingOrder);
  return candidates.find((entry) => guideNodeForEntry(entry)?.id === node.id) || candidates[0] || null;
}

function renderContentsIndex(host) {
  const heading = document.createElement('h3');
  heading.className = 'reader-subheading';
  heading.textContent = 'Listado automático de contenidos';
  const intro = document.createElement('p');
  intro.className = 'reader-paragraph figure-index-intro';
  intro.textContent = 'Se genera desde el Atlas: conserva su orden y numeración vigentes. Cada apartado abre su contenido y ofrece un enlace de regreso a esta misma ubicación. La paginación impresa no aplica a la lectura en la PWA.';
  const list = document.createElement('ol');
  list.className = 'reader-contents-index';

  const appendRow = (parent, { targetId, number = '', label, entry = null, kind = 'node' }) => {
    const item = document.createElement('li');
    item.id = contentsIndexItemId(targetId);
    item.className = `reader-contents-index-item is-${kind}`;
    const accessibleLabel = `${number ? `${number} ` : ''}${label}`;
    if (entry) {
      const link = document.createElement('a');
      link.className = 'reader-contents-index-link';
      link.href = `#entry=${encodeURIComponent(entry.id)}&toc-target=${encodeURIComponent(targetId)}`;
      link.setAttribute('aria-label', `Abrir ${accessibleLabel}`);
      const numberNode = document.createElement('span');
      numberNode.className = 'reader-contents-index-number';
      numberNode.textContent = number;
      const titleNode = document.createElement('span');
      titleNode.className = 'reader-contents-index-title';
      titleNode.textContent = label;
      link.append(numberNode, titleNode);
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setContentsIndexLocation(entry.id, targetId);
      });
      item.append(link);
    } else {
      const row = document.createElement('div');
      row.className = 'reader-contents-index-unavailable';
      const numberNode = document.createElement('span');
      numberNode.className = 'reader-contents-index-number';
      numberNode.textContent = number;
      const titleNode = document.createElement('span');
      titleNode.className = 'reader-contents-index-title';
      titleNode.textContent = label;
      const state = document.createElement('span');
      state.className = 'reader-contents-index-state';
      state.textContent = 'Contenido pendiente';
      row.append(numberNode, titleNode, state);
      item.append(row);
    }
    parent.append(item);
    return item;
  };

  const visibleEntries = entries.filter((entry) => entry.id !== 'idml-r1-u4237' && isAtlasBibliographyEntryVisible(entry));
  const preliminary = orderedPhases().find((phase) => phase.id === 'preliminares');
  if (preliminary) {
    const preliminaryRows = atlasEntryNodesForPhase(preliminary)
      .filter((node) => ['resumen', 'introduccion'].includes(normalizeEditorialText(node.label)));
    preliminaryRows.forEach((node) => {
      const entry = visibleEntries.find((candidate) => guideNodeForEntry(candidate)?.id === node.id) || null;
      appendRow(list, {
        targetId: `node:${node.id}`,
        number: node.number,
        label: node.label,
        entry,
        kind: 'preliminary'
      });
    });
  }

  orderedPhases().filter((phase) => phase.id !== 'preliminares' && phase.id !== 'sin-clasificar').forEach((phase) => {
    const phaseTargetId = `phase:${phase.id}`;
    const phaseEntry = visibleEntries
      .filter((entry) => guideNodeForEntry(entry)?.phaseId === phase.id)
      .sort(compareEntriesByReadingOrder)[0] || null;
    const phaseItem = appendRow(list, {
      targetId: phaseTargetId,
      number: phase.number || '',
      label: phase.label,
      entry: phaseEntry,
      kind: 'phase'
    });
    const nested = document.createElement('ol');
    nested.className = 'reader-contents-index-children';
    const appendNode = (node, parent) => {
      const targetId = `node:${node.id}`;
      const entry = contentsIndexEntryForNode(node, phase.id);
      const item = appendRow(parent, { targetId, number: node.number || '', label: node.label, entry });
      if (node.children?.length) {
        const children = document.createElement('ol');
        children.className = 'reader-contents-index-children';
        node.children.forEach((child) => appendNode(child, children));
        item.append(children);
      }
    };
    atlasNodesForPhase(phase).forEach((node) => appendNode(node, nested));
    if (nested.childElementCount) phaseItem.append(nested);
  });

  host.append(heading, intro, list);
}

function exportFigureCredits() {
  const blob = new Blob([figureCreditsPlainText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `creditos-de-figuras-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function readerContentBlocksForEntry(entry) {
  const bundled = bundledContentById.get(entry.id);
  const sourceBlocks = Array.isArray(bundled?.contentBlocks) ? bundled.contentBlocks : [];
  const sourceMatches = bundled && entry.content === bundled.content;
  const localBlocks = Array.isArray(entry.contentBlocks) ? entry.contentBlocks : null;
  return entry.localEditedAt && localBlocks
    ? localBlocks
    : sourceMatches && sourceBlocks.length ? sourceBlocks : localBlocks;
}

function renderEntryContent(entry, host = $('#reader-content')) {
  host.replaceChildren();
  if (entry.id === 'idml-r1-u4237') {
    renderContentsIndex(host);
    return;
  }
  if (entry.id === 'idml-r1-u5752') {
    renderFigureCreditIndex(host);
    return;
  }
  if (entry.apaUnifiedBibliography === true && entry.contentReviewNote) {
    const notice = document.createElement('p');
    notice.className = 'apa-unified-list-notice';
    notice.textContent = entry.contentReviewNote;
    host.append(notice);
  }
  const bundled = bundledContentById.get(entry.id);
  const sourceBlocks = Array.isArray(bundled?.contentBlocks) ? bundled.contentBlocks : [];
  const sourceMatches = bundled && entry.content === bundled.content;
  const blocks = readerContentBlocksForEntry(entry);
  const projectNumberedText = value => currentAtlasNumbering()?.text(entry, value) ?? String(value || '');
  const autoHeadingContext = {
    autoHeadings: entry.type !== 'Fuente' && !entry.outlineScaffold,
    entryTitle: displayEntryTitle(entry),
    entryOriginalTitle: entry.title,
    figureCreditRecords: entry.id === 'idml-r1-u5752'
      ? collectFigureCredits(true)
      : null,
    figureCreditTargetOverrides: entry.id === 'idml-r1-u5752'
      ? bundledContentById.get(entry.id)?.figureCreditTargetOverrides || {}
      : {},
    figureCreditTargetsPending: entry.id === 'idml-r1-u5752'
      ? bundledContentById.get(entry.id)?.figureCreditTargetsPending || {}
      : {}
  };
  if (!blocks?.length) {
    const content = projectNumberedText(entry.content?.trim() || '');
    renderFormattedText(content || entry.contentReviewNote || 'El contenido académico de esta entrada está pendiente de incorporar y verificar dentro de la PWA.', host, autoHeadingContext);
    if (entry.contentReviewState === 'pending' && content && content === entry.title?.trim() && entry.contentReviewNote) {
      renderFormattedText(entry.contentReviewNote, host, autoHeadingContext);
    }
  } else {
    blocks.forEach((block, blockIndex) => {
      if (block.type === 'paragraph') {
        const nextParagraphs = blocks.slice(blockIndex + 1)
          .filter((nextBlock) => nextBlock.type === 'paragraph')
          .slice(0, 2)
          .map((nextBlock) => projectNumberedText(nextBlock.text || ''));
        renderFormattedText(projectNumberedText(block.text || ''), host, { ...autoHeadingContext, nextParagraphs });
      } else if (block.type === 'figure') {
        const figureKey = recoveredFigureKey(entry.id, 'blocks', blockIndex, block);
        const figureCitation = entry.figureCitations?.[figureKey] || block.citation || {};
        const figureRecord = collectFigureCredits(true).find((record) => record.figureKey === figureKey);
        const figure = document.createElement('figure');
        figure.className = 'reader-figure';
        figure.dataset.entryId = entry.id;
        figure.dataset.figureKey = figureKey;
        const image = document.createElement('img');
        image.src = block.src;
        image.alt = block.alt || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => {
          image.hidden = true;
          figure.classList.add('is-unavailable');
          figure.textContent = `No se pudo cargar la imagen ${block.filename || ''}`;
        }, { once: true });
        appendFigureIndexReturn(figure, image, figureKey, figureRecord?.figureNumber);
        if (block.caption || figureCitation.figureTitle || figureRecord) {
          const caption = document.createElement('figcaption');
          if (figureRecord) {
            const label = document.createElement('span');
            label.className = 'reader-figure-number';
            label.textContent = `Figura ${figureRecord.figureNumber}`;
            caption.append(label);
          }
          if (figureCitation.figureTitle) {
            const figureTitle = document.createElement('em');
            figureTitle.textContent = figureCitation.figureTitle;
            caption.append(figureTitle);
          }
          appendReaderFigureNotes(caption, block.caption, figureCitation);
          appendFigureIndexReturnCaption(caption, figureKey);
          figure.append(caption);
        }
        host.append(figure);
      } else if (block.type === 'document') {
        const link = document.createElement('a');
        link.className = 'reader-document-link';
        link.href = block.src;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `Abrir documento vinculado · ${block.filename || 'PDF'}`;
        host.append(link);
      } else if (block.type === 'missing') {
        const note = document.createElement('p');
        note.className = 'reader-media-note';
        note.textContent = `Recurso visual no recuperado: ${block.filename || 'archivo sin nombre'}`;
        host.append(note);
      }
    });
  }
  const localHasMedia = blocks?.some((block) => ['figure', 'document', 'missing'].includes(block.type));
  const sourceMedia = localHasMedia ? [] : (entry.sourceMedia?.length
    ? entry.sourceMedia
    : (sourceMatches ? [] : sourceBlocks.filter((block) => ['figure', 'document', 'missing'].includes(block.type))));
  sourceMedia.forEach((block, mediaIndex) => {
    if (block.type === 'document') {
      const link = document.createElement('a');
      link.className = 'reader-document-link';
      link.href = block.src;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = `Abrir documento vinculado · ${block.filename || 'PDF'}`;
      host.append(link);
      return;
    }
    if (block.type !== 'figure') return;
    const figureKey = recoveredFigureKey(entry.id, 'media', mediaIndex, block);
    const figureCitation = entry.figureCitations?.[figureKey] || block.citation || {};
    const figureRecord = collectFigureCredits(true).find((record) => record.figureKey === figureKey);
    const figure = document.createElement('figure');
    figure.className = 'reader-figure reader-figure-appendix';
    figure.dataset.entryId = entry.id;
    figure.dataset.figureKey = figureKey;
    const image = document.createElement('img');
    image.src = block.src;
    image.alt = block.alt || '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.hidden = true;
      figure.classList.add('is-unavailable');
      figure.prepend(document.createTextNode(`No se pudo cargar la imagen ${block.filename || ''}`));
    }, { once: true });
    appendFigureIndexReturn(figure, image, figureKey, figureRecord?.figureNumber);
    if (block.caption || figureCitation.figureTitle || figureRecord) {
      const caption = document.createElement('figcaption');
      if (figureRecord) {
        const label = document.createElement('span');
        label.className = 'reader-figure-number';
        label.textContent = `Figura ${figureRecord.figureNumber}`;
        caption.append(label);
      }
      if (figureCitation.figureTitle) {
        const figureTitle = document.createElement('em');
        figureTitle.textContent = figureCitation.figureTitle;
        caption.append(figureTitle);
      }
      appendReaderFigureNotes(caption, block.caption, figureCitation);
      appendFigureIndexReturnCaption(caption, figureKey);
      figure.append(caption);
    }
    host.append(figure);
  });
  (Array.isArray(entry.images) ? entry.images : []).forEach((item) => {
    if (typeof item.src !== 'string' || !item.src.startsWith('data:image/')) return;
    const figureRecord = collectFigureCredits(true).find((record) => record.image === item || (record.image.id && record.image.id === item.id));
    const figure = document.createElement('figure');
    figure.className = 'reader-figure reader-figure-added';
    figure.dataset.entryId = entry.id;
    figure.dataset.figureKey = figureRecord?.figureKey || item.id || '';
    const image = document.createElement('img');
    image.src = item.src;
    image.alt = item.alt || '';
    image.loading = 'lazy';
    image.decoding = 'async';
    const figureKey = figureRecord?.figureKey || item.id || '';
    appendFigureIndexReturn(figure, image, figureKey, figureRecord?.figureNumber);
    if (item.citation?.figureTitle || item.caption || figureRecord) {
      const caption = document.createElement('figcaption');
      if (figureRecord) {
        const label = document.createElement('span');
        label.className = 'reader-figure-number';
        label.textContent = `Figura ${figureRecord.figureNumber}`;
        caption.append(label);
      }
      if (item.citation?.figureTitle) {
        const title = document.createElement('em');
        title.textContent = item.citation.figureTitle;
        caption.append(title);
      }
      if (item.caption) {
        const note = document.createElement('span');
        note.textContent = `Nota. ${item.caption}`;
        caption.append(note);
      }
      appendFigureIndexReturnCaption(caption, figureKey);
      figure.append(caption);
    }
    host.append(figure);
  });
  for (const [review, className] of [[entry.bibliographicReview, 'bibliographic-review-note'], [entry.sourceReview, 'source-review-note']]) {
    if (!review) continue;
    const card = document.createElement('aside');
    card.className = className;
    const heading = document.createElement('strong');
    heading.textContent = review.heading || 'Revisión bibliográfica';
    card.append(heading);
    for (const item of review.notes || []) {
      const paragraph = document.createElement('p');
      paragraph.textContent = item;
      card.append(paragraph);
    }
    for (const source of review.sources || []) {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = source.label;
      card.append(link);
    }
    host.append(card);
  }
  if (entry.resolvedOutlineScaffold?.status === 'content-present-in-pwa-review-still-open') {
    const card = document.createElement('aside');
    card.className = 'source-review-note';
    const heading = document.createElement('strong');
    heading.textContent = 'Marcador estructural resuelto';
    const note = document.createElement('p');
    note.textContent = entry.resolvedOutlineScaffold.readerNotice
      || 'Este apartado ya conserva contenido en la PWA. El texto sigue en revisión.';
    card.append(heading, note);
    host.append(card);
  }
  if (entry.annexContentEvidenceAudit?.reviewStatus === 'same-node-candidate-not-confirmed') {
    const card = document.createElement('aside');
    card.className = 'source-review-note';
    const heading = document.createElement('strong');
    heading.textContent = 'Candidato relacionado; correspondencia sin confirmar';
    const note = document.createElement('p');
    note.textContent = entry.annexContentEvidenceAudit.finding || entry.contentReviewNote;
    card.append(heading, note);
    host.append(card);
  }
  const pdfAttachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  if (pdfAttachments.length) {
    const section = document.createElement('section');
    section.className = 'reader-pdf-attachments';
    const heading = document.createElement('h3');
    heading.textContent = pdfAttachments.length === 1 ? 'Documento adjunto' : 'Documentos adjuntos';
    section.append(heading);
    pdfAttachments.forEach((attachment) => {
      if (!attachment || typeof attachment.src !== 'string') return;
      const card = document.createElement('article');
      card.className = 'reader-pdf-card';
      const title = document.createElement('h4');
      title.textContent = attachment.title || attachment.filename || 'Documento PDF';
      card.append(title, createPdfPreview(attachment), createPdfOpenLink(attachment));
      section.append(card);
    });
    host.append(section);
  }
  if (entry.apaUnifiedBibliography === true || entry.id === 'pwa-apa7-unified-bibliography-2026-10-21') {
    addCitationBacklinksToUnifiedReferences(host);
  } else {
    linkifyApaCitations(entry, host);
  }
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(file);
  });
}

function readPdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el PDF.'));
    reader.readAsDataURL(file);
  });
}

function createPdfPreview(attachment, className = 'reader-pdf-preview') {
  const preview = document.createElement('iframe');
  preview.className = className;
  preview.src = attachment.src;
  preview.title = `Vista previa del PDF: ${attachment.title || attachment.filename || 'documento'}`;
  preview.loading = 'lazy';
  preview.setAttribute('aria-label', preview.title);
  preview.addEventListener('error', () => {
    preview.hidden = true;
  }, { once: true });
  return preview;
}

function createPdfOpenLink(attachment) {
  const link = document.createElement('a');
  link.className = 'reader-pdf-open';
  link.href = attachment.src;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.download = attachment.filename || 'documento.pdf';
  link.textContent = `Abrir o descargar · ${attachment.filename || 'PDF'}`;
  return link;
}

function createCitationEditor(citation, onChange = () => {}) {
  Object.assign(citation, { sourceType: 'unknown', permissionStatus: 'unknown', includeInCredits: true, includeInReferences: true, ...citation });
  const details = document.createElement('details');
  details.className = 'entry-edit-citation-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Procedencia, APA y permisos';
  const grid = document.createElement('div');
  grid.className = 'entry-edit-citation-grid';
  const checkboxes = {};
  const textField = (key, labelText, placeholder = '', type = 'text') => {
    const label = document.createElement('label');
    label.className = 'entry-edit-citation-field';
    const labelName = document.createElement('span');
    labelName.textContent = labelText;
    const input = document.createElement('input');
    input.type = type;
    input.maxLength = 1000;
    input.placeholder = placeholder;
    input.value = citation[key] || '';
    input.setAttribute('aria-label', labelText);
    input.addEventListener('input', () => { citation[key] = input.value; onChange(); });
    label.append(labelName, input);
    return label;
  };
  const selectField = (key, labelText, options) => {
    const label = document.createElement('label');
    label.className = 'entry-edit-citation-field';
    const labelName = document.createElement('span');
    labelName.textContent = labelText;
    const select = document.createElement('select');
    select.setAttribute('aria-label', labelText);
    options.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    select.value = citation[key] || options[0][0];
    select.addEventListener('change', () => {
      citation[key] = select.value;
      if (key === 'sourceType') {
        const ownWork = select.value === 'original';
        if (ownWork) citation.permissionStatus = 'not-required';
        else if (citation.permissionStatus === 'not-required') citation.permissionStatus = 'unknown';
        if (checkboxes.includeInReferences) {
          checkboxes.includeInReferences.checked = !ownWork;
          citation.includeInReferences = !ownWork;
        }
      }
      onChange();
    });
    label.append(labelName, select);
    return label;
  };
  const checkField = (key, labelText) => {
    const label = document.createElement('label');
    label.className = 'entry-edit-citation-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = citation[key] !== false;
    checkboxes[key] = input;
    input.addEventListener('change', () => { citation[key] = input.checked; onChange(); });
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    return label;
  };
  grid.append(
    selectField('sourceType', 'Procedencia', [
      ['unknown', 'Por identificar'], ['original', 'Creación propia'], ['reproduced', 'Reproducida'],
      ['adapted', 'Adaptada'], ['stock', 'Banco de imágenes'], ['participant', 'Aportada por participante'],
      ['webpage', 'Página web'], ['book', 'Libro'], ['personal-communication', 'Comunicación personal'], ['generated-ai', 'Generada con IA']
    ]),
    textField('creator', 'Autor, creador o entidad', 'Nombre o institución'),
    textField('year', 'Año de creación/publicación', 'Año o s. f.'),
    textField('date', 'Fecha APA completa', 'p. ej., 2025, August 1; s. f.'),
    textField('generationYear', 'Año de generación con IA', 'Año en que se generó'),
    textField('workTitle', 'Título de la obra', 'Título original de la imagen'),
    selectField('medium', 'Tipo de recurso', [
      ['image', 'Imagen'], ['photograph', 'Fotografía'], ['illustration', 'Ilustración'], ['map', 'Mapa'],
      ['screenshot', 'Captura de pantalla'], ['infographic', 'Infografía'], ['artwork', 'Obra de arte'],
      ['webpage', 'Página web'], ['book', 'Libro'], ['other', 'Otro']
    ]),
    textField('sourceTitle', 'Sitio, libro, revista o colección', 'Nombre de la fuente'),
    textField('publisher', 'Editorial, institución o plataforma', 'Si corresponde'),
    textField('locator', 'Página, número de figura o catálogo', 'Dato localizador'),
    textField('doi', 'DOI', 'https://doi.org/…', 'url'),
    textField('url', 'URL de la fuente', 'Enlace directo y estable', 'url'),
    textField('rightsHolder', 'Titular de derechos', 'Persona o entidad'),
    textField('copyrightYear', 'Año de copyright', 'Si aparece en la fuente'),
    textField('license', 'Licencia', 'p. ej., CC BY 4.0'),
    textField('licenseUrl', 'Enlace a la licencia', 'URL de condiciones', 'url'),
    selectField('permissionStatus', 'Permiso de uso', [
      ['unknown', 'Pendiente de revisar'], ['not-required', 'No requerido / uso propio'], ['requested', 'Solicitado'],
      ['granted', 'Concedido'], ['not-granted', 'No concedido']
    ]),
    textField('permissionEvidence', 'Registro o evidencia del permiso', 'Referencia, correo o ubicación del comprobante'),
    textField('adaptation', 'Cambios realizados', 'Indica si se recortó, editó o adaptó')
  );
  const checks = document.createElement('div');
  checks.className = 'entry-edit-citation-checks';
  checks.append(checkField('includeInCredits', 'Incluir en Créditos de figuras / anexos'), checkField('includeInReferences', 'Incluir fuente en el borrador de referencias APA'));
  details.append(summary, grid, checks);
  return details;
}

function createEntryEditor(entry, onCancel) {
  const isNewEntry = Boolean(entry.isNewDraft);
  const form = document.createElement('form');
  form.className = 'entry-edit-form';
  const note = document.createElement('p');
  note.className = 'entry-edit-note';
  note.textContent = isNewEntry
    ? 'Esta entrada se guardará como contenido local en este navegador. Los documentos originales permanecen intactos; usa Exportar copia para respaldarla.'
    : 'Editas una copia local de esta entrada. El IDML, PDF e INDD originales no se modifican. Los cambios quedan en este navegador; usa Exportar copia para respaldarlos.';

  const titleLabel = document.createElement('label');
  titleLabel.className = 'entry-edit-field';
  titleLabel.textContent = 'Título';
  const title = document.createElement('input');
  title.type = 'text';
  title.maxLength = 180;
  title.required = true;
  title.value = displayEntryTitle(entry);
  titleLabel.append(title);
  const numberingHelp = document.createElement('small');
  numberingHelp.textContent = 'La numeración se ajusta al orden del Atlas. Puedes escribir el título y los subtítulos sin números; usa los formatos de título del editor.';
  titleLabel.append(numberingHelp);

  let entryType = null;
  let guideNode = null;
  let existingGuideNode = null;
  let tags = null;
  let customNodeName = null;
  let customNodeParent = null;
  let customNodeNumber = null;
  if (isNewEntry) {
    const metadataFields = document.createElement('div');
    metadataFields.className = 'new-entry-fields';
    const typeLabel = document.createElement('label');
    typeLabel.className = 'entry-edit-field';
    typeLabel.textContent = 'Tipo de entrada';
    entryType = document.createElement('select');
    entryType.setAttribute('aria-label', 'Tipo de entrada');
    TYPES.forEach((type) => entryType.add(new Option(type, type)));
    entryType.value = normalizeEntryType(entry.type, 'Entrada');
    typeLabel.append(entryType);

    const nodeLabel = document.createElement('label');
    nodeLabel.className = 'entry-edit-field';
    nodeLabel.textContent = 'Apartado del Atlas';
    guideNode = document.createElement('select');
    guideNode.setAttribute('aria-label', 'Apartado del Atlas');
    guideNode.add(new Option('Por clasificar', ''));
    editorialSections().forEach((node) => {
      const optionLabel = node.isPhase ? `${node.number ? node.number + ' · ' : ''}${node.label}` : [node.phaseLabel, node.number, node.label].filter(Boolean).join(' · ');
      guideNode.add(new Option(optionLabel, node.id));
    });
    guideNode.add(new Option('＋ Crear un apartado nuevo…', CUSTOM_ATLAS_OPTION));
    guideNode.value = entry.guideNodeId || '';
    nodeLabel.append(guideNode);

    const customNodeFields = document.createElement('div');
    customNodeFields.className = 'entry-edit-custom-atlas';
    customNodeFields.hidden = true;
    const customNodeHelp = document.createElement('p');
    customNodeHelp.textContent = 'El apartado se añadirá al Atlas cuando guardes esta entrada y quedará disponible para reutilizarlo.';
    const customNameLabel = document.createElement('label');
    customNameLabel.className = 'entry-edit-field';
    customNameLabel.textContent = 'Nombre del apartado nuevo';
    customNodeName = document.createElement('input');
    customNodeName.type = 'text';
    customNodeName.maxLength = 120;
    customNodeName.placeholder = 'p. ej., Instrumentos de validación';
    customNodeName.required = true;
    customNameLabel.append(customNodeName);
    const customNumberLabel = document.createElement('label');
    customNumberLabel.className = 'entry-edit-field';
    customNumberLabel.textContent = 'Número previsto (automático)';
    customNodeNumber = document.createElement('input');
    customNodeNumber.type = 'text';
    customNodeNumber.readOnly = true;
    customNodeNumber.maxLength = 24;
    customNodeNumber.placeholder = 'Se propone automáticamente';
    customNumberLabel.append(customNodeNumber);
    const customPhaseLabel = document.createElement('label');
    customPhaseLabel.className = 'entry-edit-field';
    customPhaseLabel.textContent = 'Anidar dentro de';
    customNodeParent = document.createElement('select');
    customNodeParent.setAttribute('aria-label', 'Apartado superior del apartado nuevo');
    editorialSections().forEach((node) => {
      const optionLabel = node.isPhase ? `${node.number ? node.number + ' · ' : ''}${node.label}` : `${node.number} · ${node.label}`;
      customNodeParent.add(new Option(optionLabel, node.id));
    });
    customPhaseLabel.append(customNodeParent);
    customNodeFields.append(customNodeHelp, customNameLabel, customPhaseLabel, customNumberLabel);
    const syncCustomNodeFields = () => {
      const creating = guideNode.value === CUSTOM_ATLAS_OPTION;
      customNodeFields.hidden = !creating;
      customNodeName.required = creating;
      if (creating) {
        customNodeParent.value = guideNode.dataset.previousSelection || 'investigacion';
        customNodeNumber.value = nextAtlasNodeNumber(customNodeParent.value);
      } else {
        guideNode.dataset.previousSelection = guideNode.value;
      }
    };
    customNodeParent.addEventListener('change', () => {
      customNodeNumber.value = nextAtlasNodeNumber(customNodeParent.value);
    });
    guideNode.addEventListener('change', syncCustomNodeFields);
    guideNode.dataset.previousSelection = guideNode.value;

    const tagsLabel = document.createElement('label');
    tagsLabel.className = 'entry-edit-field';
    tagsLabel.textContent = 'Etiquetas (separadas por comas)';
    tags = document.createElement('input');
    tags.type = 'text';
    tags.maxLength = 500;
    tags.placeholder = 'p. ej., diagnóstico, propuesta';
    tags.value = (entry.tags || []).join(', ');
    tagsLabel.append(tags);
    metadataFields.append(typeLabel, nodeLabel, tagsLabel, customNodeFields);
    form.append(note, metadataFields, titleLabel);
  } else {
    const locationLabel = document.createElement('label');
    locationLabel.className = 'entry-edit-field';
    locationLabel.textContent = 'Ubicación en el Atlas';
    existingGuideNode = document.createElement('select');
    existingGuideNode.setAttribute('aria-label', 'Ubicación de la entrada en el Atlas');
    existingGuideNode.add(new Option('Por ubicar', ''));
    editorialSections().forEach((node) => {
      const optionLabel = node.isPhase ? `${node.number ? node.number + ' · ' : ''}${node.label}` : [node.phaseLabel, node.number, node.label].filter(Boolean).join(' · ');
      existingGuideNode.add(new Option(optionLabel, node.id));
    });
    existingGuideNode.value = guideNodeForEntry(entry)?.id || '';
    locationLabel.append(existingGuideNode);
    form.append(note, titleLabel, locationLabel);
  }

  const contentLabel = document.createElement('div');
  contentLabel.className = 'entry-edit-field';
  const contentLabelTitle = document.createElement('strong');
  contentLabelTitle.textContent = 'Texto de la entrada';
  contentLabel.append(contentLabelTitle);
  const formattingHelp = document.createElement('small');
  formattingHelp.className = 'entry-edit-help';
  formattingHelp.textContent = 'La numeración estructural se calcula según el orden actual del Atlas. Selecciona un fragmento para aplicar negrita, cursiva o un nivel de título.';
  const content = document.createElement('textarea');
  content.rows = 18;
  const projectNumberedEditorText = (value) => currentAtlasNumbering()?.text(entry, value) ?? String(value || '');
  const readerBlocks = readerContentBlocksForEntry(entry);
  const flattenedReaderContent = Array.isArray(readerBlocks) && readerBlocks.length
    && readerBlocks.every((block) => block.type === 'paragraph')
    ? readerBlocks.map((block) => block.text || '').join('\n\n')
    : null;
  const editorBaselineContent = flattenedReaderContent ?? entry.content ?? '';
  content.value = projectNumberedEditorText(editorBaselineContent);
  content.setAttribute('aria-label', 'Texto de la entrada');
  let restoreOriginalText = false;
  content.addEventListener('input', () => { restoreOriginalText = false; });
  contentLabel.append(content, formattingHelp);

  const bundled = bundledContentById.get(entry.id);
  const originalBlocks = Array.isArray(entry.contentBlocks)
    ? entry.contentBlocks
    : (Array.isArray(entry.originalSnapshot?.contentBlocks) ? entry.originalSnapshot.contentBlocks : (Array.isArray(bundled?.contentBlocks) ? bundled.contentBlocks : []));
  const structuredEditor = originalBlocks.some((block) => block.type === 'figure' && typeof block.src === 'string')
    && originalBlocks.some((block) => block.type === 'paragraph')
    && (!entry.localEditedAt || Array.isArray(entry.contentBlocks));
  let editorBlocks = originalBlocks.map((block) => block.type === 'paragraph'
    ? { ...block, text: projectNumberedEditorText(block.text) }
    : { ...block });
  let draftFigureCitations = Object.fromEntries(Object.entries(entry.figureCitations || {}).map(([key, citation]) => [key, { ...citation }]));
  const draftSourceMedia = (Array.isArray(entry.sourceMedia) ? entry.sourceMedia : []).map((block) => ({ ...block }));
  const structuredSection = document.createElement('section');
  structuredSection.className = 'entry-edit-block-editor';
  const structuredHeading = document.createElement('h3');
  structuredHeading.textContent = 'Texto e imágenes de la entrada';
  const structuredHelp = document.createElement('p');
  structuredHelp.textContent = 'Selecciona el texto y aplica negrita, cursiva, etiqueta o niveles de título desde la barra de formato. Reemplaza cada imagen desde su tarjeta y usa «Mover imagen» para cambiarla de posición.';
  const structuredList = document.createElement('div');
  structuredList.className = 'entry-edit-rich-document';
  structuredList.contentEditable = 'true';
  structuredList.setAttribute('role', 'textbox');
  structuredList.setAttribute('aria-label', 'Texto e imágenes de la entrada');
  structuredList.setAttribute('aria-multiline', 'true');
  structuredList.spellcheck = true;
  const formattingToolbar = document.createElement('div');
  formattingToolbar.className = 'entry-format-toolbar';
  formattingToolbar.setAttribute('role', 'toolbar');
  formattingToolbar.setAttribute('aria-label', 'Formato del texto');
  const selectedEditor = () => structuredEditor ? structuredList : content;
  const applyMarkdownFormat = (format) => {
    const editor = selectedEditor();
    editor.focus();
    if (editor === content) {
      const start = content.selectionStart;
      const end = content.selectionEnd;
      const selected = content.value.slice(start, end);
      const lineStart = content.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const nextBreak = content.value.indexOf('\n', end);
      const lineEnd = nextBreak < 0 ? content.value.length : nextBreak;
      let replacement = '';
      let selectionStart = start;
      let selectionEnd = start;
      if (format === 'bold') {
        const alreadyWrapped = selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4;
        const wrappedAround = content.value.slice(Math.max(0, start - 2), start) === '**'
          && content.value.slice(end, end + 2) === '**';
        if (alreadyWrapped) {
          const unwrapped = selected.slice(2, -2);
          content.setRangeText(unwrapped, start, end, 'select');
          selectionStart = start;
          selectionEnd = start + unwrapped.length;
        } else if (wrappedAround) {
          const unwrapped = content.value.slice(start, end);
          content.setRangeText(unwrapped, start - 2, end + 2, 'select');
          selectionStart = start - 2;
          selectionEnd = selectionStart + unwrapped.length;
        } else {
          const text = selected || 'Texto';
          const value = `**${text}**`;
          content.setRangeText(value, start, end, 'select');
          selectionStart = start + 2;
          selectionEnd = start + value.length - 2;
        }
      } else if (format === 'italic') {
        const alreadyWrapped = selected.startsWith('*') && selected.endsWith('*') && !selected.startsWith('**') && selected.length >= 3;
        const wrappedAround = content.value.slice(Math.max(0, start - 1), start) === '*'
          && content.value.slice(end, end + 1) === '*'
          && content.value.slice(Math.max(0, start - 2), start) !== '**'
          && content.value.slice(end, end + 2) !== '**';
        if (alreadyWrapped) {
          const unwrapped = selected.slice(1, -1);
          content.setRangeText(unwrapped, start, end, 'select');
          selectionStart = start;
          selectionEnd = start + unwrapped.length;
        } else if (wrappedAround) {
          const unwrapped = content.value.slice(start, end);
          content.setRangeText(unwrapped, start - 1, end + 1, 'select');
          selectionStart = start - 1;
          selectionEnd = selectionStart + unwrapped.length;
        } else {
          const text = selected || 'Texto';
          const value = `*${text}*`;
          content.setRangeText(value, start, end, 'select');
          selectionStart = start + 1;
          selectionEnd = start + value.length - 1;
        }
      } else if (format === 'label') {
        const entireLabel = selected.match(/^\*\*(.+):\*\*$/);
        const selectionInsideLabel = content.value.slice(Math.max(0, start - 2), start) === '**'
          && content.value.slice(end, end + 2) === '**' && selected.endsWith(':');
        if (entireLabel) {
          const text = entireLabel[1];
          content.setRangeText(text, start, end, 'select');
          selectionStart = start;
          selectionEnd = start + text.length;
        } else if (selectionInsideLabel) {
          const text = selected.slice(0, -1);
          content.setRangeText(text, start - 2, end + 2, 'select');
          selectionStart = start - 2;
          selectionEnd = selectionStart + text.length;
        } else {
          const text = (selected || 'Rótulo').replace(/:$/, '');
          const value = `**${text}:**`;
          content.setRangeText(value, start, end, 'select');
          selectionStart = start + 2;
          selectionEnd = start + value.length - 2;
        }
      } else {
        const prefix = format === 'title' ? '## ' : format === 'subtitle' ? '### ' : '';
        const lines = content.value.slice(lineStart, lineEnd).split('\n');
        const targetHeading = prefix;
        const headingPrefixes = lines.map((line) => line.match(/^(#{1,6})\s+/)?.[0] || '');
        const removeHeading = format === 'normal' || (prefix && headingPrefixes.every((heading) => heading.trim() === targetHeading.trim()));
        replacement = lines.map((line) => `${removeHeading ? '' : prefix}${line.replace(/^(?:#{1,6}\s+)?/, '')}`).join('\n');
        content.setRangeText(replacement, lineStart, lineEnd, 'select');
        selectionStart = lineStart;
        selectionEnd = lineStart + replacement.length;
      }
      content.focus();
      content.setSelectionRange(selectionStart, selectionEnd);
      restoreOriginalText = false;
      return;
    }
    if (format === 'bold') document.execCommand('bold');
    else if (format === 'italic') document.execCommand('italic');
    else if (format === 'title' || format === 'subtitle' || format === 'normal') {
      const anchorNode = window.getSelection()?.anchorNode;
      const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
      const selectedBlock = anchorElement?.closest('h3,h4');
      const targetTag = format === 'title' ? 'H3' : format === 'subtitle' ? 'H4' : 'P';
      const targetAlreadyApplied = format === 'normal' ? !selectedBlock : selectedBlock?.tagName === targetTag;
      document.execCommand('formatBlock', false, targetAlreadyApplied ? 'p' : targetTag.toLowerCase());
    }
    else if (format === 'label') {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (text) {
        const labelAlreadyApplied = document.queryCommandState('bold') && text.endsWith(':');
        if (labelAlreadyApplied) {
          const range = selection.getRangeAt(0);
          range.setStart(range.endContainer, Math.max(0, range.endOffset - 1));
          range.deleteContents();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('bold');
        } else {
          if (!document.queryCommandState('bold')) document.execCommand('bold');
          const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
          if (range && !text.endsWith(':')) {
            range.collapse(false);
            range.insertNode(document.createTextNode(':'));
          }
        }
      } else {
        document.execCommand('insertHTML', false, '<strong>Rótulo:</strong>');
      }
    }
    restoreOriginalText = false;
  };
  [
    ['bold', 'Negrita', 'B'], ['italic', 'Cursiva', 'I'], ['label', 'Etiqueta en negrita', 'Rótulo'],
    ['title', 'Título', 'Título'], ['subtitle', 'Subtítulo', 'Subtítulo'], ['normal', 'Texto normal', 'Normal']
  ].forEach(([format, label, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-quiet';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => applyMarkdownFormat(format));
    formattingToolbar.append(button);
  });
  contentLabel.insertBefore(formattingToolbar, content);
  let draggedFigureKey = null;
  const editorParagraphSegments = (text) => {
    const segments = [];
    let tableLines = [];
    const flushTable = () => {
      if (tableLines.length) segments.push(tableLines.join('\n'));
      tableLines = [];
    };
    String(text || '').split(/\r?\n/).forEach((line) => {
      if (/^\s*\|/.test(line)) {
        tableLines.push(line);
        return;
      }
      flushTable();
      if (line.trim()) segments.push(line);
    });
    flushTable();
    return segments.length ? segments : [''];
  };
  const markEditorParagraphs = () => {
    [...structuredList.children].forEach((node) => {
      if (node.dataset.editorBlockType !== 'figure' && node.dataset.editorBlockType !== 'document') {
        node.dataset.editorBlockType = 'paragraph';
      }
    });
  };
  structuredList.addEventListener('input', () => {
    markEditorParagraphs();
    restoreOriginalText = false;
  });
  let activePointerId = null;
  let pointerOrigin = null;
  let pointerDragStarted = false;
  const clearFigureDropState = () => {
    draggedFigureKey = null;
    activePointerId = null;
    pointerOrigin = null;
    pointerDragStarted = false;
    structuredList.classList.remove('is-drag-over');
    structuredList.querySelectorAll('.is-drop-target, .is-moving').forEach((node) => {
      node.classList.remove('is-drop-target', 'is-moving');
    });
  };
  const findEditorFigure = (key) => structuredList.querySelector(
    `[data-editor-block-type="figure"][data-source-block-index="${CSS.escape(key)}"]`
  );
  const moveFigureToPoint = (figure, x, y) => {
    const target = document.elementFromPoint(x, y)?.closest('[data-editor-block-type="paragraph"]');
    if (!target || !structuredList.contains(target) || target === figure || figure.contains(target)) return false;
    const bounds = target.getBoundingClientRect();
    const insertBefore = y < bounds.top + bounds.height / 2;
    if (insertBefore) target.before(figure);
    else target.after(figure);
    markEditorParagraphs();
    restoreOriginalText = false;
    return true;
  };
  structuredList.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.entry-edit-figure-drag-handle');
    if (!handle || event.button !== 0) return;
    const figure = handle.closest('[data-editor-block-type="figure"]');
    if (!figure) return;
    draggedFigureKey = figure.dataset.sourceBlockIndex;
    activePointerId = event.pointerId;
    pointerOrigin = { x: event.clientX, y: event.clientY };
    pointerDragStarted = false;
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  structuredList.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId || draggedFigureKey === null || !pointerOrigin) return;
    if (!pointerDragStarted && Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) < 6) return;
    pointerDragStarted = true;
    event.preventDefault();
    structuredList.classList.add('is-drag-over');
    findEditorFigure(draggedFigureKey)?.classList.add('is-moving');
    structuredList.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-editor-block-type="paragraph"]');
    if (target && !findEditorFigure(draggedFigureKey)?.contains(target)) target.classList.add('is-drop-target');
  });
  structuredList.addEventListener('pointerup', (event) => {
    if (event.pointerId !== activePointerId || draggedFigureKey === null) return;
    if (pointerDragStarted) {
      const figure = findEditorFigure(draggedFigureKey);
      if (figure) moveFigureToPoint(figure, event.clientX, event.clientY);
    }
    clearFigureDropState();
  });
  structuredList.addEventListener('pointercancel', (event) => {
    if (event.pointerId === activePointerId) clearFigureDropState();
  });
  const renderStructuredBlocks = () => {
    structuredList.replaceChildren();
    let figureNumber = 0;
    let lastParagraph = null;
    editorBlocks.forEach((block, blockIndex) => {
      if (block.type === 'paragraph') {
        editorParagraphSegments(block.text).forEach((segment) => {
          const paragraph = document.createElement('p');
          paragraph.className = 'entry-edit-document-paragraph';
          paragraph.dataset.editorBlockType = 'paragraph';
          paragraph.dataset.sourceBlockIndex = String(blockIndex);
          const headingLine = segment.trim().match(/^(#{1,2})\s+(.+)$/);
          const heading = segment.trim().match(/^\*\*(.+?)\*\*:?$/);
          if (headingLine) {
            const title = document.createElement(headingLine[1].length === 1 ? 'h3' : 'h4');
            title.dataset.editorBlockType = 'paragraph';
            title.dataset.sourceBlockIndex = String(blockIndex);
            appendInlineText(title, headingLine[2]);
            structuredList.append(title);
            lastParagraph = title;
          } else if (heading) {
            const strong = document.createElement('strong');
            strong.textContent = `${heading[1].replace(/:$/, '')}:`;
            paragraph.append(strong);
          } else {
            paragraph.textContent = segment;
          }
          structuredList.append(paragraph);
          lastParagraph = paragraph;
        });
      } else if (block.type === 'figure') {
        figureNumber += 1;
        const figureKey = recoveredFigureKey(entry.id, 'blocks', blockIndex, block);
        block.figureId = figureKey;
        const figureCitation = draftFigureCitations[figureKey] || { ...(block.citation || {}) };
        draftFigureCitations[figureKey] = figureCitation;
        const figure = document.createElement('figure');
        figure.className = 'entry-edit-inline-figure';
        figure.contentEditable = 'false';
        figure.dataset.editorBlockType = 'figure';
        figure.dataset.sourceBlockIndex = String(blockIndex);
        figure.title = 'Arrastra esta figura y suéltala sobre un párrafo';
        let image = null;
        if (typeof block.src === 'string' && block.src) {
          image = document.createElement('img');
          image.src = block.src;
          image.alt = block.alt || '';
          image.loading = 'lazy';
          image.decoding = 'async';
          figure.append(image);
        }
        const caption = document.createElement('figcaption');
        const filename = document.createElement('strong');
        filename.textContent = block.filename || `Figura recuperada ${figureNumber}`;
        const replaceButton = document.createElement('button');
        replaceButton.type = 'button';
        replaceButton.className = 'entry-edit-figure-replace-button';
        replaceButton.textContent = 'Reemplazar imagen';
        replaceButton.setAttribute('aria-label', `Reemplazar imagen ${filename.textContent}`);
        const replaceInput = document.createElement('input');
        replaceInput.type = 'file';
        replaceInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
        replaceInput.hidden = true;
        replaceButton.addEventListener('click', () => replaceInput.click());
        replaceInput.addEventListener('change', async () => {
          const file = replaceInput.files?.[0];
          replaceInput.value = '';
          if (!file) return;
          if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
            showToast(`Formato no permitido: ${file.name}`);
            return;
          }
          if (file.size > 4 * 1024 * 1024) {
            showToast(`${file.name} supera el límite de 4 MB.`);
            return;
          }
          try {
            const src = await readImageFile(file);
            editorBlocks[blockIndex].src = src;
            editorBlocks[blockIndex].filename = file.name;
            if (image) {
              image.src = src;
              image.alt = editorBlocks[blockIndex].alt || '';
            } else {
              image = document.createElement('img');
              image.src = src;
              image.alt = editorBlocks[blockIndex].alt || '';
              image.loading = 'lazy';
              image.decoding = 'async';
              figure.prepend(image);
            }
            filename.textContent = file.name;
            replaceButton.setAttribute('aria-label', `Reemplazar imagen ${file.name}`);
            restoreOriginalText = false;
          } catch (error) {
            showToast(error.message || 'No se pudo leer la imagen.');
          }
        });
        const dragHandle = document.createElement('button');
        dragHandle.type = 'button';
        dragHandle.className = 'entry-edit-figure-drag-handle';
        dragHandle.textContent = '⠿ Mover imagen';
        dragHandle.setAttribute('aria-label', `Mover la imagen ${filename.textContent}`);
        const moveFigureWithKeyboard = (direction) => {
          let sibling = direction < 0 ? figure.previousElementSibling : figure.nextElementSibling;
          while (sibling && sibling.dataset.editorBlockType !== 'paragraph') {
            sibling = direction < 0 ? sibling.previousElementSibling : sibling.nextElementSibling;
          }
          if (!sibling) return;
          if (direction < 0) sibling.before(figure);
          else sibling.after(figure);
          markEditorParagraphs();
          restoreOriginalText = false;
          figure.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest' });
        };
        const moveBefore = document.createElement('button');
        moveBefore.type = 'button';
        moveBefore.className = 'entry-edit-figure-move-button';
        moveBefore.textContent = 'Antes del párrafo anterior';
        moveBefore.setAttribute('aria-label', `Mover ${filename.textContent} antes del párrafo anterior`);
        moveBefore.addEventListener('click', () => moveFigureWithKeyboard(-1));
        const moveAfter = document.createElement('button');
        moveAfter.type = 'button';
        moveAfter.className = 'entry-edit-figure-move-button';
        moveAfter.textContent = 'Después del párrafo siguiente';
        moveAfter.setAttribute('aria-label', `Mover ${filename.textContent} después del párrafo siguiente`);
        moveAfter.addEventListener('click', () => moveFigureWithKeyboard(1));
        moveBefore.disabled = !editorBlocks.slice(0, blockIndex).some((item) => item.type === 'paragraph');
        moveAfter.disabled = !editorBlocks.slice(blockIndex + 1).some((item) => item.type === 'paragraph');
        const captionField = document.createElement('input');
        captionField.type = 'text';
        captionField.className = 'entry-edit-inline-caption';
        captionField.maxLength = 500;
        captionField.value = block.caption || '';
        captionField.placeholder = 'Escribe el texto debajo de la imagen';
        captionField.setAttribute('aria-label', `Pie de figura de ${filename.textContent}`);
        captionField.addEventListener('input', () => {
          editorBlocks[blockIndex].caption = captionField.value;
          restoreOriginalText = false;
        });
        const location = document.createElement('small');
        location.textContent = 'Pie editable · arrastra la imagen o usa los controles de párrafo';
        const citationEditor = createCitationEditor(figureCitation, () => { restoreOriginalText = false; });
        caption.append(filename, replaceButton, replaceInput, dragHandle, moveBefore, moveAfter, captionField, location, citationEditor);
        figure.append(caption);
        structuredList.append(figure);
        lastParagraph = null;
      } else if (block.type === 'document') {
        const documentNote = document.createElement('p');
        documentNote.className = 'entry-edit-inline-document';
        documentNote.contentEditable = 'false';
        documentNote.dataset.editorBlockType = 'document';
        documentNote.dataset.sourceBlockIndex = String(blockIndex);
        documentNote.textContent = block.title || block.text || 'Material complementario en esta posición.';
        structuredList.append(documentNote);
        lastParagraph = null;
      }
    });
  };
  const sourceFigures = originalBlocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ block }) => block.type === 'figure' && typeof block.src === 'string');
  if (structuredEditor) {
    contentLabel.hidden = true;
    structuredSection.append(structuredHeading, structuredHelp, formattingToolbar, structuredList);
    renderStructuredBlocks();
    form.append(structuredSection);
  } else {
    form.append(contentLabel);
  }

  const sourceImageSection = document.createElement('section');
  sourceImageSection.className = 'entry-edit-images entry-edit-source-images';
  const sourceImageHeading = document.createElement('h3');
  sourceImageHeading.textContent = 'Imágenes recuperadas en esta entrada';
  const sourceImageHelp = document.createElement('p');
  sourceImageHelp.textContent = 'Completa aquí la fuente y los derechos de cada figura recuperada. La ubicación ayuda a identificarla dentro de la entrada.';
  const sourceImageList = document.createElement('div');
  sourceImageList.className = 'entry-edit-image-list';
  if (sourceFigures.length) {
    sourceFigures.forEach(({ block, blockIndex }, figureIndex) => {
      const editableBlock = editorBlocks[blockIndex] || block;
      const figureKey = recoveredFigureKey(entry.id, 'blocks', blockIndex, editableBlock);
      editableBlock.figureId = figureKey;
      const figureCitation = draftFigureCitations[figureKey] || { ...(block.citation || {}) };
      draftFigureCitations[figureKey] = figureCitation;
      const before = originalBlocks.slice(0, blockIndex).filter((item) => item.type === 'paragraph');
      const after = originalBlocks.slice(blockIndex + 1).filter((item) => item.type === 'paragraph');
      const snippet = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 110);
      const beforeText = snippet(before.at(-1)?.text);
      const afterText = snippet(after[0]?.text);
      const position = document.createElement('p');
      position.className = 'entry-edit-image-position';
      position.textContent = `Figura ${figureIndex + 1} de ${sourceFigures.length} · bloque ${blockIndex + 1} de ${originalBlocks.length}`
        + (beforeText && afterText ? ` · entre «${beforeText}${before.at(-1)?.text?.length > 110 ? '…' : ''}» y «${afterText}${after[0]?.text?.length > 110 ? '…' : ''}»`
          : beforeText ? ` · después de «${beforeText}${before.at(-1)?.text?.length > 110 ? '…' : ''}»`
            : afterText ? ` · antes de «${afterText}${after[0]?.text?.length > 110 ? '…' : ''}»` : ' · al inicio de la entrada');
      const card = document.createElement('div');
      card.className = 'entry-edit-source-image-card';
      const preview = document.createElement('img');
      preview.src = block.src;
      preview.alt = block.alt || '';
      preview.loading = 'lazy';
      preview.decoding = 'async';
      preview.addEventListener('error', () => {
        preview.hidden = true;
        const unavailable = document.createElement('span');
        unavailable.className = 'entry-edit-image-unavailable';
        unavailable.textContent = 'Vista previa no disponible en este navegador.';
        card.prepend(unavailable);
      }, { once: true });
      const details = document.createElement('div');
      details.className = 'entry-edit-source-image-details';
      const filename = document.createElement('strong');
      filename.textContent = block.filename || 'Figura recuperada';
      const caption = document.createElement('span');
      caption.textContent = block.caption || block.alt || 'Sin pie de figura en la extracción.';
      details.append(filename, caption, position, createCitationEditor(figureCitation, () => { restoreOriginalText = false; }));
      card.append(preview, details);
      sourceImageList.append(card);
    });
  } else {
    const sourceMediaFigures = draftSourceMedia
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.type === 'figure' && typeof block.src === 'string');
    sourceMediaFigures.forEach(({ block, index }) => {
      const figureKey = recoveredFigureKey(entry.id, 'media', index, block);
      block.figureId = figureKey;
      const figureCitation = draftFigureCitations[figureKey] || { ...(block.citation || {}) };
      draftFigureCitations[figureKey] = figureCitation;
      const card = document.createElement('div');
      card.className = 'entry-edit-source-image-card';
      const preview = document.createElement('img');
      preview.src = block.src;
      preview.alt = block.alt || '';
      const details = document.createElement('div');
      details.className = 'entry-edit-source-image-details';
      const filename = document.createElement('strong');
      filename.textContent = block.filename || `Figura recuperada ${index + 1}`;
      const position = document.createElement('p');
      position.className = 'entry-edit-image-position';
      position.textContent = 'Ubicación original: el paquete de esta entrada no conserva el orden exacto de la figura.';
      details.append(filename, position, createCitationEditor(figureCitation, () => { restoreOriginalText = false; }));
      card.append(preview, details);
      sourceImageList.append(card);
    });
    if (!sourceMediaFigures.length) {
      const empty = document.createElement('p');
      empty.className = 'entry-edit-image-empty';
      empty.textContent = 'No se recuperaron figuras para esta entrada.';
      sourceImageList.append(empty);
    }
  }
  sourceImageSection.append(sourceImageHeading, sourceImageHelp, sourceImageList);
  if (!structuredEditor) form.append(sourceImageSection);

  let draftImages = (Array.isArray(entry.images) ? entry.images : []).map((image) => ({ ...image }));
  const imageSection = document.createElement('section');
  imageSection.className = 'entry-edit-images entry-edit-added-images';
  const imageHeading = document.createElement('h3');
  imageHeading.textContent = 'Imágenes agregadas en esta copia';
  const imageHelp = document.createElement('p');
  imageHelp.textContent = 'JPG, PNG, WebP o GIF; máximo 4 MB cada una. Completa el título, la nota y la accesibilidad; abre «Procedencia, APA y permisos» para registrar fuente y derechos.';
  const imageTools = document.createElement('div');
  imageTools.className = 'entry-edit-image-tools';
  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  imageInput.multiple = true;
  imageInput.hidden = true;
  const addImage = document.createElement('button');
  addImage.className = 'button button-outline';
  addImage.type = 'button';
  addImage.textContent = 'Agregar imágenes';
  imageTools.append(addImage, imageInput);
  const imageList = document.createElement('div');
  imageList.className = 'entry-edit-image-list';
  imageSection.append(imageHeading, imageHelp, imageTools, imageList);
  form.append(imageSection);

  const renderDraftImages = () => {
    imageList.replaceChildren();
    draftImages.forEach((image, index) => {
      const citation = { sourceType: 'unknown', permissionStatus: 'unknown', includeInCredits: true, includeInReferences: true, ...(image.citation || {}) };
      draftImages[index].citation = citation;
      const card = document.createElement('div');
      card.className = 'entry-edit-image-card';
      const preview = document.createElement('img');
      preview.src = image.src;
      preview.alt = image.alt || '';
      const fields = document.createElement('div');
      fields.className = 'entry-edit-image-fields';
      const alt = document.createElement('input');
      alt.type = 'text';
      alt.maxLength = 240;
      alt.placeholder = 'Qué muestra la imagen (accesibilidad)';
      alt.setAttribute('aria-label', 'Texto alternativo de la imagen');
      alt.value = image.alt || '';
      alt.addEventListener('input', () => { draftImages[index].alt = alt.value; preview.alt = alt.value; });
      const figureTitle = document.createElement('input');
      figureTitle.type = 'text';
      figureTitle.maxLength = 240;
      figureTitle.placeholder = 'Título de figura (APA)';
      figureTitle.setAttribute('aria-label', 'Título de figura');
      figureTitle.value = citation.figureTitle || '';
      figureTitle.addEventListener('input', () => { draftImages[index].citation.figureTitle = figureTitle.value; });
      const caption = document.createElement('input');
      caption.type = 'text';
      caption.maxLength = 400;
      caption.placeholder = 'Nota o descripción bajo la figura (opcional)';
      caption.setAttribute('aria-label', 'Nota o descripción bajo la figura');
      caption.value = image.caption || '';
      caption.addEventListener('input', () => { draftImages[index].caption = caption.value; });
      fields.append(alt, figureTitle, caption);

      const metadata = document.createElement('details');
      metadata.className = 'entry-edit-citation-details';
      const metadataSummary = document.createElement('summary');
      metadataSummary.textContent = 'Procedencia, APA y permisos';
      const metadataGrid = document.createElement('div');
      metadataGrid.className = 'entry-edit-citation-grid';
      const setCitationValue = (key, value) => { draftImages[index].citation[key] = value; };
      const citationCheckboxes = {};
      const textField = (key, labelText, placeholder = '', type = 'text') => {
        const label = document.createElement('label');
        label.className = 'entry-edit-citation-field';
        const labelName = document.createElement('span');
        labelName.textContent = labelText;
        const input = document.createElement('input');
        input.type = type;
        input.maxLength = 1000;
        input.placeholder = placeholder;
        input.value = citation[key] || '';
        input.setAttribute('aria-label', labelText);
        input.addEventListener('input', () => setCitationValue(key, input.value));
        label.append(labelName, input);
        return label;
      };
      const selectField = (key, labelText, options) => {
        const label = document.createElement('label');
        label.className = 'entry-edit-citation-field';
        const labelName = document.createElement('span');
        labelName.textContent = labelText;
        const select = document.createElement('select');
        select.setAttribute('aria-label', labelText);
        options.forEach(([value, text]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          select.append(option);
        });
        select.value = citation[key] || options[0][0];
        select.addEventListener('change', () => {
          setCitationValue(key, select.value);
          if (key === 'sourceType') {
            const ownWork = select.value === 'original';
            if (ownWork) draftImages[index].citation.permissionStatus = 'not-required';
            else if (draftImages[index].citation.permissionStatus === 'not-required') draftImages[index].citation.permissionStatus = 'unknown';
            if (citationCheckboxes.includeInReferences) {
              citationCheckboxes.includeInReferences.checked = !ownWork;
              setCitationValue('includeInReferences', !ownWork);
            }
          }
        });
        label.append(labelName, select);
        return label;
      };
      const checkField = (key, labelText) => {
        const label = document.createElement('label');
        label.className = 'entry-edit-citation-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = citation[key] !== false;
        citationCheckboxes[key] = input;
        input.addEventListener('change', () => setCitationValue(key, input.checked));
        const text = document.createElement('span');
        text.textContent = labelText;
        label.append(input, text);
        return label;
      };
      metadataGrid.append(
        selectField('sourceType', 'Procedencia', [
          ['unknown', 'Por identificar'], ['original', 'Creación propia'], ['reproduced', 'Reproducida'],
          ['adapted', 'Adaptada'], ['stock', 'Banco de imágenes'], ['participant', 'Aportada por participante'], ['generated-ai', 'Generada con IA']
        ]),
        textField('creator', 'Autor, creador o entidad', 'Nombre o institución'),
        textField('year', 'Año de creación/publicación', 'Año o s. f.'),
        textField('generationYear', 'Año de generación con IA', 'Año en que se generó'),
        textField('workTitle', 'Título de la obra', 'Título original de la imagen'),
        selectField('medium', 'Tipo de recurso', [
          ['image', 'Imagen'], ['photograph', 'Fotografía'], ['illustration', 'Ilustración'], ['map', 'Mapa'],
          ['screenshot', 'Captura de pantalla'], ['infographic', 'Infografía'], ['artwork', 'Obra de arte'],
          ['webpage', 'Página web'], ['book', 'Libro'], ['other', 'Otro']
        ]),
        textField('sourceTitle', 'Sitio, libro, revista o colección', 'Nombre de la fuente'),
        textField('publisher', 'Editorial, institución o plataforma', 'Si corresponde'),
        textField('locator', 'Página, número de figura o catálogo', 'Dato localizador'),
        textField('doi', 'DOI', 'https://doi.org/…', 'url'),
        textField('url', 'URL de la fuente', 'Enlace directo y estable', 'url'),
        textField('rightsHolder', 'Titular de derechos', 'Persona o entidad'),
        textField('copyrightYear', 'Año de copyright', 'Si aparece en la fuente'),
        textField('license', 'Licencia', 'p. ej., CC BY 4.0'),
        textField('licenseUrl', 'Enlace a la licencia', 'URL de condiciones', 'url'),
        selectField('permissionStatus', 'Permiso de uso', [
          ['unknown', 'Pendiente de revisar'], ['not-required', 'No requerido / uso propio'], ['requested', 'Solicitado'],
          ['granted', 'Concedido'], ['not-granted', 'No concedido']
        ]),
        textField('permissionEvidence', 'Registro o evidencia del permiso', 'Referencia, correo o ubicación del comprobante'),
        textField('adaptation', 'Cambios realizados', 'Indica si se recortó, editó o adaptó')
      );
      const checklist = document.createElement('div');
      checklist.className = 'entry-edit-citation-checks';
      checklist.append(checkField('includeInCredits', 'Incluir en Créditos de figuras / anexos'), checkField('includeInReferences', 'Incluir fuente en el borrador de referencias APA'));
      metadata.append(metadataSummary, metadataGrid, checklist);
      fields.append(metadata);
      const remove = document.createElement('button');
      remove.className = 'button button-quiet entry-edit-image-remove';
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', () => { draftImages.splice(index, 1); renderDraftImages(); });
      card.append(preview, fields, remove);
      imageList.append(card);
    });
    if (!draftImages.length) {
      const empty = document.createElement('p');
      empty.className = 'entry-edit-image-empty';
      empty.textContent = 'Aún no hay imágenes agregadas.';
      imageList.append(empty);
    }
  };
  renderDraftImages();
  addImage.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const files = [...(imageInput.files || [])];
    imageInput.value = '';
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { showToast(`Formato no permitido: ${file.name}`); continue; }
      if (file.size > 4 * 1024 * 1024) { showToast(`${file.name} supera el límite de 4 MB.`); continue; }
      if (draftImages.length >= 8) { showToast('Cada entrada admite hasta 8 imágenes agregadas.'); break; }
      try {
        draftImages.push({ id: makeId(), src: await readImageFile(file), filename: file.name, alt: '', caption: '', citation: {
          sourceType: 'unknown', medium: 'image', permissionStatus: 'unknown', includeInCredits: true, includeInReferences: true
        } });
      } catch (error) { showToast(error.message); }
    }
    renderDraftImages();
  });

  let draftAttachments = (Array.isArray(entry.attachments) ? entry.attachments : []).map((attachment) => ({ ...attachment }));
  const pdfSection = document.createElement('section');
  pdfSection.className = 'entry-edit-images entry-edit-pdf-attachments';
  const pdfHeading = document.createElement('h3');
  pdfHeading.textContent = 'PDF adjuntos';
  const pdfHelp = document.createElement('p');
  pdfHelp.textContent = 'Agrega hasta 4 PDF: máximo 8 MB por archivo y 12 MB en total por entrada. Se guardan en esta copia local, aparecen al final de la entrada y se muestran aquí página por página.';
  const pdfTools = document.createElement('div');
  pdfTools.className = 'entry-edit-image-tools';
  const pdfInput = document.createElement('input');
  pdfInput.type = 'file';
  pdfInput.accept = 'application/pdf,.pdf';
  pdfInput.multiple = true;
  pdfInput.hidden = true;
  const addPdf = document.createElement('button');
  addPdf.className = 'button button-outline';
  addPdf.type = 'button';
  addPdf.textContent = 'Adjuntar PDF';
  const pdfList = document.createElement('div');
  pdfList.className = 'entry-edit-pdf-list';
  pdfTools.append(addPdf, pdfInput);
  pdfSection.append(pdfHeading, pdfHelp, pdfTools, pdfList);
  form.append(pdfSection);

  const renderDraftAttachments = () => {
    pdfList.replaceChildren();
    draftAttachments.forEach((attachment, index) => {
      const card = document.createElement('article');
      card.className = 'entry-edit-pdf-card';
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 180;
      title.value = attachment.title || attachment.filename || '';
      title.placeholder = 'Título del documento';
      title.setAttribute('aria-label', 'Título del PDF adjunto');
      title.addEventListener('input', () => { draftAttachments[index].title = title.value; });
      card.append(title, createPdfPreview(attachment, 'entry-edit-pdf-preview'));
      const footer = document.createElement('div');
      footer.className = 'entry-edit-pdf-footer';
      const filename = document.createElement('span');
      filename.textContent = attachment.filename || 'documento.pdf';
      const remove = document.createElement('button');
      remove.className = 'button button-quiet';
      remove.type = 'button';
      remove.textContent = 'Quitar PDF';
      remove.addEventListener('click', () => {
        draftAttachments.splice(index, 1);
        renderDraftAttachments();
      });
      footer.append(filename, remove);
      card.append(footer);
      pdfList.append(card);
    });
    if (!draftAttachments.length) {
      const empty = document.createElement('p');
      empty.className = 'entry-edit-image-empty';
      empty.textContent = 'Aún no hay PDF adjuntos.';
      pdfList.append(empty);
    }
    addPdf.disabled = draftAttachments.length >= 4;
  };
  renderDraftAttachments();
  addPdf.addEventListener('click', () => pdfInput.click());
  pdfInput.addEventListener('change', async () => {
    const files = [...(pdfInput.files || [])];
    pdfInput.value = '';
    for (const file of files) {
      if (draftAttachments.length >= 4) { showToast('Cada entrada admite hasta 4 PDF adjuntos.'); break; }
      if (file.size > 8 * 1024 * 1024) { showToast(`${file.name} supera el límite de 8 MB.`); continue; }
      const currentPdfBytes = draftAttachments.reduce((total, attachment) => {
        const payload = attachment.src?.split(',')[1] || '';
        return total + Math.floor(payload.length * 3 / 4);
      }, 0);
      if (currentPdfBytes + file.size > 12 * 1024 * 1024) {
        showToast('Los PDF de una entrada no pueden superar 12 MB en conjunto.');
        continue;
      }
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        showToast(`Selecciona un archivo PDF: ${file.name}`);
        continue;
      }
      try {
        if (await file.slice(0, 5).text() !== '%PDF-') {
          showToast(`${file.name} no parece ser un PDF válido.`);
          continue;
        }
        const src = await readPdfFile(file);
        draftAttachments.push({ id: makeId(), filename: file.name, title: file.name.replace(/\.pdf$/i, ''), src });
      } catch (error) {
        showToast(error.message || 'No se pudo leer el PDF.');
      }
    }
    renderDraftAttachments();
  });

  const actions = document.createElement('div');
  actions.className = 'entry-edit-actions';
  const save = document.createElement('button');
  save.className = 'button button-primary';
  save.type = 'submit';
  save.textContent = isNewEntry ? 'Crear entrada' : 'Guardar copia';
  const cancel = document.createElement('button');
  cancel.className = 'button button-quiet';
  cancel.type = 'button';
  cancel.textContent = 'Cancelar';
  cancel.addEventListener('click', onCancel);
  actions.append(save, cancel);

  if (entry.originalSnapshot) {
    const restore = document.createElement('button');
    restore.className = 'button button-quiet entry-edit-restore';
    restore.type = 'button';
    restore.textContent = 'Restaurar texto recuperado';
    restore.addEventListener('click', () => {
      title.value = entry.originalSnapshot.title || '';
      content.value = entry.originalSnapshot.content || '';
      if (structuredEditor) {
        const restoredBlocks = Array.isArray(entry.originalSnapshot.contentBlocks)
          ? entry.originalSnapshot.contentBlocks
          : originalBlocks;
        editorBlocks = restoredBlocks.map((block) => ({ ...block }));
        renderStructuredBlocks();
      }
      restoreOriginalText = true;
      showToast('Se restauró el texto de la versión recuperada. Guarda para aplicar el cambio local.');
    });
    actions.append(restore);
  }
  form.append(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (guideNode?.value === CUSTOM_ATLAS_OPTION && !customNodeName.value.trim()) {
      customNodeName.focus();
      showToast('Escribe un nombre para el apartado nuevo.');
      return;
    }
    const now = new Date().toISOString();
    const originalSnapshot = isNewEntry ? null : entry.originalSnapshot || {
      title: entry.title,
      content: editorBaselineContent,
      contentBlocks: Array.isArray(entry.contentBlocks)
        ? entry.contentBlocks
        : editorBaselineContent !== (entry.content || '') && Array.isArray(readerBlocks) ? readerBlocks : null
    };
    const savedBlocks = structuredEditor
      ? (() => {
        const result = [];
        const pushText = (value, sourceNode) => {
          const text = String(value || '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
          if (!text.trim()) return;
          const sourceIndex = Number(sourceNode?.dataset?.sourceBlockIndex);
          const sourceBlock = Number.isInteger(sourceIndex) ? editorBlocks[sourceIndex] : null;
          result.push({ ...(sourceBlock?.type === 'paragraph' ? sourceBlock : {}), type: 'paragraph', text });
        };
        const visit = (node, textParts, sourceNode) => {
          if (node.nodeType === Node.TEXT_NODE) {
            textParts.push(node.nodeValue || '');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.tagName === 'H3' || node.tagName === 'H4') {
            textParts.push(node.tagName === 'H3' ? '## ' : '### ');
            [...node.childNodes].forEach((child) => visit(child, textParts, sourceNode));
            return;
          }
          if (node.tagName === 'EM' || node.tagName === 'I') {
            textParts.push('*');
            [...node.childNodes].forEach((child) => visit(child, textParts, sourceNode));
            textParts.push('*');
            return;
          }
          if (node.tagName === 'STRONG') {
            textParts.push('**');
            [...node.childNodes].forEach((child) => visit(child, textParts, sourceNode));
            textParts.push('**');
            return;
          }
          if (node.dataset.editorBlockType === 'figure') {
            pushText(textParts.join(''), sourceNode);
            textParts.length = 0;
            const sourceIndex = Number(node.dataset.sourceBlockIndex);
            const sourceBlock = Number.isInteger(sourceIndex) ? editorBlocks[sourceIndex] : null;
            if (sourceBlock) result.push({ ...sourceBlock });
            return;
          }
          if (node.dataset.editorBlockType === 'document') {
            pushText(textParts.join(''), sourceNode);
            textParts.length = 0;
            const sourceIndex = Number(node.dataset.sourceBlockIndex);
            const sourceBlock = Number.isInteger(sourceIndex) ? editorBlocks[sourceIndex] : null;
            if (sourceBlock) result.push({ ...sourceBlock });
            return;
          }
          if (node.tagName === 'BR') {
            textParts.push('\n');
            return;
          }
          const isNestedBlock = node !== sourceNode && ['P', 'DIV', 'LI'].includes(node.tagName);
          if (isNestedBlock) {
            pushText(textParts.join(''), sourceNode);
            textParts.length = 0;
          }
          [...node.childNodes].forEach((child) => visit(child, textParts, sourceNode));
          if (isNestedBlock) {
            pushText(textParts.join(''), sourceNode);
            textParts.length = 0;
          }
        };
        [...structuredList.children].forEach((node) => {
          const textParts = [];
          visit(node, textParts, node);
          pushText(textParts.join(''), node);
        });
        return result;
      })()
      : null;
    const savedContent = structuredEditor
      ? savedBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text || '').join('\n\n')
      : content.value;
    const createsCustomNode = guideNode?.value === CUSTOM_ATLAS_OPTION;
    const selectedLocationId = createsCustomNode ? null : guideNode?.value ?? existingGuideNode?.value ?? null;
    const selectedCustomNode = createsCustomNode
      ? {
        id: 'custom-atlas-' + makeId(),
        label: customNodeName.value.trim(),
        phaseId: getGuideNodeById(customNodeParent.value)?.phaseId || customNodeParent.value,
        parentId: customNodeParent.value,
        number: customNodeNumber.value.trim() || nextAtlasNodeNumber(customNodeParent.value)
      }
      : customAtlasNodes().find((node) => node.id === selectedLocationId);
    const updated = {
      ...entry,
      title: title.value.trim(),
      type: entryType?.value || entry.type,
      guideNodeId: createsCustomNode ? selectedCustomNode.id : selectedLocationId || null,
      customGuideNode: selectedCustomNode ? {
        id: selectedCustomNode.id,
        label: selectedCustomNode.label,
        phaseId: selectedCustomNode.phaseId,
        parentId: selectedCustomNode.parentId || selectedCustomNode.phaseId,
        number: selectedCustomNode.number || ''
      } : null,
      tags: tags ? tags.value.split(',').map((tag) => tag.trim()).filter(Boolean) : entry.tags,
      content: savedContent,
      contentBlocks: structuredEditor
        ? savedBlocks
        : restoreOriginalText
        ? (Array.isArray(originalSnapshot.contentBlocks) ? originalSnapshot.contentBlocks : null)
        : (content.value === entry.content ? entry.contentBlocks : null),
      figureCitations: draftFigureCitations,
      sourceMedia: draftSourceMedia,
      images: draftImages,
      attachments: draftAttachments,
      originalSnapshot,
      localEditedAt: now,
      updatedAt: now
    };
    delete updated.isNewDraft;
    save.disabled = true;
    save.textContent = isNewEntry ? 'Creando…' : 'Guardando…';
    try {
      await putEntry(updated);
      entries = isNewEntry
        ? [...entries, updated]
        : entries.map((item) => item.id === updated.id ? updated : item);
      if (isNewEntry && updated.guideNodeId) {
        // Freeze the current sibling order when the first local entry is added
        // to a node, then place the new record after it. This prevents its
        // unnumbered title from being alphabetized into the middle of the list.
        const siblingIds = entries
          .filter((item) => item.id !== updated.id && guideNodeForEntry(item)?.id === updated.guideNodeId)
          .sort(compareEntriesByReadingOrder)
          .map((item) => item.id);
        atlasOrderState.entries = {
          ...(atlasOrderState.entries || {}),
          [updated.guideNodeId]: [...siblingIds, updated.id]
        };
        saveAtlasOrderState();
      }
      if (isNewEntry) {
        const mount = $('#new-entry-mount');
        mount.hidden = true;
        mount.replaceChildren();
      }
      scheduleGitHubSync();
      renderList();
      const targetIndex = listEntrySnapshot.findIndex((item) => item.id === updated.id);
      while (targetIndex >= renderedEntryCount && renderedEntryCount < listEntrySnapshot.length) appendEntryBatch();
      requestAnimationFrame(() => entryList.querySelector(`.feed-entry[data-entry-id="${CSS.escape(updated.id)}"]`)?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' }));
      showToast(isNewEntry ? 'Entrada creada y guardada en este navegador.' : 'Copia local guardada. El original sigue intacto.');
    } catch (error) {
      save.disabled = false;
      save.textContent = isNewEntry ? 'Crear entrada' : 'Guardar copia';
      showStorageError(error);
    }
  });
  return form;
}

function openEntryEditor(article, entry) {
  const index = listEntrySnapshot.findIndex((item) => item.id === entry.id);
  const editor = createEntryEditor(entry, () => {
    article.replaceWith(createEntryListItem(entry, Math.max(0, index), listEntrySnapshot.length));
  });
  article.querySelector('.feed-entry-reader-grid')?.replaceWith(editor);
}

function startNewEntry() {
  const existingMount = $('#new-entry-mount');
  if (!existingMount.hidden && existingMount.firstElementChild) {
    existingMount.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    existingMount.querySelector('input')?.focus({ preventScroll: true });
    return;
  }
  clearEntryLocation();
  searchTerm = '';
  statusFilter = 'all';
  activeFilter = 'all';
  activeSection = null;
  sectionSearchTerm = '';
  entryOpenedFromAtlas = false;
  showHomePage = false;
  showAtlasHome = false;
  showFigureCredits = false;
  showApaAudit = false;
  showEntryWorkspace = true;
  renderList();
  $('#search-input').value = '';
  $('#status-filter').value = 'all';

  const now = new Date().toISOString();
  const entry = {
    id: makeId(), title: '', type: 'Entrada', status: 'Borrador', area: '', tags: [], content: '',
    guideNodeId: null, contentBlocks: null, sourceMedia: [], images: [], attachments: [], figureCitations: {},
    createdAt: now, updatedAt: now, originalSnapshot: null, isNewDraft: true, pwaCreated: true
  };
  const mount = $('#new-entry-mount');
  mount.replaceChildren(createEntryEditor(entry, () => {
    mount.hidden = true;
    mount.replaceChildren();
    $('#new-entry-button').focus();
  }));
  mount.hidden = false;
  requestAnimationFrame(() => {
    mount.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    mount.querySelector('input')?.focus({ preventScroll: true });
  });
}

function openEntryFromAtlas(id) {
  showEntryById(id, { historyMode: 'push', openedFromAtlas: true });
}

function showAtlasAtEntry(id) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  const node = guideNodeForEntry(entry);
  clearEntryLocation();
  selectedId = id;
  atlasFocusEntryId = id;
  atlasFocusNeedsScroll = true;
  atlasSearchTerm = '';
  sectionSearchTerm = '';
  activeSection = null;
  activeFilter = 'all';
  showHomePage = false;
  showAtlasHome = true;
  showFigureCredits = false;
  showApaAudit = false;
  showEntryWorkspace = false;
  entryOpenedFromAtlas = false;
  atlasExpandedPhases.add(node?.phaseId ?? 'sin-clasificar');
  window.scrollTo({ top: 0, behavior: 'auto' });
  renderList();
}

function showToast(message) {
  const toast = $('#toast');
  if (toastObjectUrl) URL.revokeObjectURL(toastObjectUrl);
  toastObjectUrl = null;
  toast.classList.remove('has-action');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

async function forceRefreshApplication() {
  const button = $('#force-refresh-button');
  if ($('.entry-edit-form')) {
    showToast('Guarda o cancela la edición antes de actualizar.');
    return;
  }
  if (!navigator.onLine) {
    showToast('Conéctate a internet para obtener la última versión.');
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const registrations = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names
        .filter((name) => name.startsWith('cuaderno-grado-') && name !== 'cuaderno-grado-media-v1')
        .map((name) => caches.delete(name)));
    }
    const refreshedUrl = new URL(location.href);
    refreshedUrl.searchParams.set('cache-refresh', String(Date.now()));
    location.replace(refreshedUrl.href);
  } catch (error) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    showToast('No se pudo renovar la caché. Intenta recargar la página.');
  }
}

function showDownloadToast(message, blob, filename) {
  const toast = $('#toast');
  if (toastObjectUrl) URL.revokeObjectURL(toastObjectUrl);
  clearTimeout(toastTimer);
  const url = URL.createObjectURL(blob);
  toastObjectUrl = url;
  toast.replaceChildren(document.createTextNode(`${message} `));
  const link = document.createElement('a');
  link.className = 'toast-download-link';
  link.href = url;
  link.download = filename;
  link.textContent = 'Descargar ZIP';
  toast.append(link);
  toast.classList.add('is-visible', 'has-action');
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible', 'has-action');
    toast.replaceChildren();
    if (toastObjectUrl === url) toastObjectUrl = null;
    URL.revokeObjectURL(url);
  }, 60_000);
}

function showStorageError(error) {
  console.error('No se pudo guardar la entrada localmente:', error);
  $('#entry-save-state').textContent = 'No se pudo guardar';
  $('#save-state').textContent = 'Error de almacenamiento';
  showToast('No se pudo guardar en este navegador. Exporta una copia del texto.');
}

async function describeBrowserStorage() {
  const status = $('#save-state');
  if (!status || !navigator.storage) return;
  try {
    const persistencePromise = typeof navigator.storage.persisted === 'function'
      ? navigator.storage.persisted().catch(() => false)
      : Promise.resolve(false);
    const [estimate, persistent] = await Promise.all([
      navigator.storage.estimate().catch(() => null),
      persistencePromise
    ]);
    if (!githubSyncEnabled()) status.textContent = 'Copia local';
    if (estimate?.quota) {
      const usedMb = Math.round((estimate.usage ?? 0) / 1024 / 1024);
      const quotaMb = Math.round(estimate.quota / 1024 / 1024);
      status.title = `${persistent ? 'Almacenamiento persistente' : 'Almacenamiento del navegador, sujeto a sus políticas'} · ${usedMb} de ${quotaMb} MB usados. Exporta copias JSON para respaldar tus cambios.`;
    } else {
      status.title = 'Los cambios editados viven en este navegador. Exporta copias JSON para respaldarlos.';
    }
  } catch (error) {
    status.title = 'Los cambios editados viven en este navegador. Exporta copias JSON para respaldarlos.';
  }
}

function closeNavigation() {
  const desktop = window.matchMedia('(min-width: 761px)').matches;
  const sidebar = document.querySelector('.sidebar');
  const workspace = document.querySelector('.workspace');
  const restoreFocus = sidebar.contains(document.activeElement);
  sidebar.inert = true;
  sidebar.setAttribute('aria-hidden', 'true');
  if (desktop) {
    workspace.classList.add('sidebar-collapsed');
    sidebar.classList.add('is-open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
    $('#menu-toggle').setAttribute('aria-label', 'Mostrar menú');
    $('#menu-toggle').textContent = '☰';
    $('#nav-scrim').hidden = true;
    if (restoreFocus) $('#menu-toggle').focus();
    return;
  }
  sidebar.classList.remove('is-open');
  $('#nav-scrim').hidden = true;
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
  $('#menu-toggle').setAttribute('aria-label', 'Mostrar menú');
  $('#menu-toggle').textContent = '☰';
  if (restoreFocus) $('#menu-toggle').focus();
}

function setTheme(theme, persist = true) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const toggle = $('#theme-toggle');
  const isDark = next === 'dark';
  toggle.setAttribute('aria-pressed', String(isDark));
  toggle.setAttribute('aria-label', isDark ? 'Activar tema claro' : 'Activar tema oscuro');
  toggle.querySelector('.theme-toggle-label').textContent = isDark ? 'Tema claro' : 'Tema oscuro';
  toggle.querySelector('[aria-hidden="true"]').textContent = isDark ? '☼' : '◐';
  if (persist) {
    try { localStorage.setItem('proyecto-grado-demo-799dc3f-theme', next); } catch (error) { console.warn('No se pudo recordar el tema:', error); }
  }
}

function exportBackup() {
  const backup = { format: 'proyecto-grado-pwa', version: 1, exportedAt: new Date().toISOString(), atlasOrder: atlasOrderState,
    computedNumbering: currentAtlasNumbering()?.snapshot(), entries: entriesWithNumberingBindings() };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `proyecto-grado-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Copia JSON exportada. Guárdala junto con tus respaldos.');
}

function entriesWithNumberingBindings() {
  return entries.map(entry => ({ ...entry, numberingHeadingLevels: entry.numberingHeadingLevels
    || bundledContentById.get(entry.id)?.numberingHeadingLevels }));
}

const HISTORICAL_PWA_BACKUP_PATH = './importaciones/respaldo-local-pre-unificacion-2026-10-18.json';

async function downloadHistoricalPwaBackup() {
  const button = $('#download-historical-backup-button');
  button.disabled = true;
  try {
    const response = await fetch(HISTORICAL_PWA_BACKUP_PATH);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'proyecto-grado-respaldo-PRE-UNIFICACION-INDICE-2026-10-18.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Respaldo histórico descargado. Contiene 202 entradas y no reemplaza el bundle vigente.');
  } catch (error) {
    showToast('No se pudo descargar el respaldo histórico incluido en esta copia.');
    console.error('No se pudo descargar el respaldo histórico:', error);
  } finally {
    button.disabled = false;
  }
}

const PROJECT_PACKAGE_APP_FILES = [
  './index.html', './styles.css', './atlas-outline.js', './numbering.js', './app.js', './sw.js', './manifest.webmanifest',
  './favicon.svg', './icon-192.png', './icon-512.png', './README.md',
  './offline-media-manifest.json', './importaciones/contenido-proyecto-autosuficiente-v3.json',
  './importaciones/contenido-idml-para-importar.json', './importaciones/correcciones-apa-028-001.json', './importaciones/auditoria-apa-pdf-octubre-2026.json',
  './importaciones/apa-review-register-2026-10-18.json', './importaciones/registro-imagenes-generadas-2026.json',
  './importaciones/auditoria-figuras-apa-2026-10-20.json', './importaciones/auditoria-referencias-apa7-pwa-2026-10-21.json',
  './importaciones/registro-revision-academica-apa-2026-10-21.json', HISTORICAL_PWA_BACKUP_PATH
];

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipUint16(view, offset, value) { view.setUint16(offset, value, true); }
function zipUint32(view, offset, value) { view.setUint32(offset, value, true); }

function buildStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    if (bytes.byteLength > 0xffffffff || localOffset > 0xffffffff) throw new Error('El paquete supera el límite ZIP de 4 GB.');
    const crc = zipCrc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    zipUint32(localView, 0, 0x04034b50); zipUint16(localView, 4, 20); zipUint16(localView, 6, 0x0800);
    zipUint16(localView, 8, 0); zipUint16(localView, 12, 0x21); zipUint32(localView, 14, crc); zipUint32(localView, 18, bytes.length);
    zipUint32(localView, 22, bytes.length); zipUint16(localView, 26, name.length); zipUint16(localView, 28, 0);
    local.set(name, 30);
    localParts.push(local, bytes);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    zipUint32(centralView, 0, 0x02014b50); zipUint16(centralView, 4, 20); zipUint16(centralView, 6, 20);
    zipUint16(centralView, 8, 0x0800); zipUint16(centralView, 10, 0); zipUint16(centralView, 14, 0x21); zipUint32(centralView, 16, crc);
    zipUint32(centralView, 20, bytes.length); zipUint32(centralView, 24, bytes.length);
    zipUint16(centralView, 28, name.length); zipUint32(centralView, 42, localOffset); central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + bytes.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  if (files.length > 0xffff || localOffset + centralSize > 0xffffffff) throw new Error('El paquete supera el límite ZIP clásico.');
  const ending = new Uint8Array(22);
  const endingView = new DataView(ending.buffer);
  zipUint32(endingView, 0, 0x06054b50); zipUint16(endingView, 8, files.length);
  zipUint16(endingView, 10, files.length); zipUint32(endingView, 12, centralSize); zipUint32(endingView, 16, localOffset);
  return new Blob([...localParts, ...centralParts, ending], { type: 'application/zip' });
}

async function exportFullProjectPackage() {
  const button = $('#export-project-button');
  button.disabled = true;
  try {
    showToast('Preparando el proyecto completo; puede tardar un poco…');
    let syncResult = null;
    let syncWarning = '';
    if (githubSyncEnabled()) {
      showToast('Sincronizando la biblioteca antes de crear el paquete…');
      syncResult = await syncGitHubUntilIdle();
      if (!syncResult) {
        syncWarning = 'GitHub no respondió. El respaldo incluye el estado guardado en este navegador; los cambios que solo existan en GitHub no están incluidos.';
      }
    }
    entries = await allEntries();
    const manifestResponse = await fetch('./offline-media-manifest.json');
    if (!manifestResponse.ok) throw new Error('No se pudo leer el inventario de medios incluidos.');
    const mediaManifest = await manifestResponse.json();
    const paths = [...new Set([
      ...PROJECT_PACKAGE_APP_FILES,
      ...(Array.isArray(mediaManifest) ? mediaManifest.map((item) => item.url).filter((path) => typeof path === 'string') : [])
    ])];
    const files = [];
    const textEncoder = new TextEncoder();
    const packagePrefix = 'Clutter-PWA/';
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index];
      const response = await fetch(path);
      if (!response.ok) throw new Error(`No se pudo incluir el archivo ${path} (${response.status}).`);
      const relativePath = path.replace(/^\.\//, '');
      files.push({ name: `${packagePrefix}${relativePath}`, bytes: new Uint8Array(await response.arrayBuffer()) });
      if (index % 8 === 0) showToast(`Empaquetando recursos ${index + 1} de ${paths.length}…`);
    }
    const backup = {
      format: 'proyecto-grado-pwa', version: 2, exportedAt: new Date().toISOString(),
      snapshot: syncResult
        ? { scope: 'browser-and-github', syncState: 'synced', branch: syncResult.branch, syncedAt: syncResult.syncedAt }
        : {
          scope: 'current-browser',
          syncState: syncWarning ? 'github-unavailable' : 'local-only',
          ...(syncWarning ? { warning: syncWarning } : {})
        },
      atlasOrder: atlasOrderState, computedNumbering: currentAtlasNumbering()?.snapshot(), entries: entriesWithNumberingBindings()
    };
    const backupBytes = textEncoder.encode(JSON.stringify(backup));
    files.push({ name: `${packagePrefix}restauracion/respaldo-actual.json`, bytes: backupBytes });
    const inventory = await Promise.all(files.map(async (file) => ({
      path: file.name.slice(packagePrefix.length),
      bytes: file.bytes.length,
      sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    })));
    const packageManifest = {
      format: 'clutter-pwa-full-project', version: 2, createdAt: new Date().toISOString(),
      snapshot: backup.snapshot,
      restore: 'Esta exportación conserva la biblioteca y los medios del estado actual. Para trasladar tus ediciones locales a otro perfil, exporta una copia JSON desde la app e impórtala allí.',
      fileCount: inventory.length, totalBytes: inventory.reduce((sum, file) => sum + file.bytes, 0), files: inventory
    };
    const packageManifestBytes = textEncoder.encode(JSON.stringify(packageManifest, null, 2));
    const packageManifestHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', packageManifestBytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    files.push({ name: `${packagePrefix}manifest-paquete.json`, bytes: packageManifestBytes });
    files.push({ name: `${packagePrefix}manifest-paquete.sha256`, bytes: textEncoder.encode(`${packageManifestHash}  manifest-paquete.json\n`) });
    const blob = buildStoredZip(files);
    const filename = `Clutter-proyecto-completo-${new Date().toISOString().slice(0, 10)}.zip`;
    showDownloadToast(syncWarning
      ? `Paquete local listo (${(blob.size / (1024 * 1024)).toFixed(1)} MB). ${syncWarning}`
      : `Paquete completo listo: ${files.length} archivos y ${(blob.size / (1024 * 1024)).toFixed(1)} MB.`, blob, filename);
  } catch (error) {
    showToast(error.message || 'No se pudo crear el paquete completo.');
  } finally {
    button.disabled = false;
  }
}

function isSafeImportedResource(value, allowImageData = true) {
  if (typeof value !== 'string' || !value || value.length > 12 * 1024 * 1024) return false;
  if (allowImageData && /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+=*$/i.test(value)) return true;
  if (allowImageData && /^data:application\/pdf;base64,[a-z0-9+/]+=*$/i.test(value)) return true;
  if (!value.startsWith('./media/')) return false;
  try {
    const resolved = new URL(value, location.href);
    const mediaRoot = new URL('./media/', location.href);
    return resolved.origin === location.origin && resolved.pathname.startsWith(mediaRoot.pathname)
      && resolved.pathname.length > mediaRoot.pathname.length;
  } catch (error) {
    return false;
  }
}

function validateImportedEntry(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.id !== 'string' || !source.id || source.id.length > 180
    || typeof source.title !== 'string' || source.title.length > 180
    || typeof source.content !== 'string' || source.content.length > 5_000_000
    || (source.area !== undefined && (typeof source.area !== 'string' || source.area.length > 1000))) {
    throw new Error('La copia contiene una entrada con campos inválidos. No se guardó nada.');
  }
  const validateCitation = (citation) => {
    if (citation === undefined) return true;
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return false;
    const textFields = ['figureTitle', 'sourceType', 'creator', 'year', 'date', 'generationYear', 'workTitle', 'medium', 'sourceTitle', 'publisher', 'locator', 'doi', 'url', 'rightsHolder', 'copyrightYear', 'license', 'licenseUrl', 'permissionStatus', 'permissionEvidence', 'adaptation', 'creditNote', 'provider', 'photographer', 'imageCredit', 'reviewReason', 'aiToolDescription', 'attributionEvidence'];
    if (!textFields.every((key) => citation[key] === undefined || (typeof citation[key] === 'string' && citation[key].length <= 1000))) return false;
    if (citation.sourceType !== undefined && !['unknown', 'original', 'reproduced', 'adapted', 'stock', 'participant', 'webpage', 'book', 'personal-communication', 'generated-ai'].includes(citation.sourceType)) return false;
    if (citation.medium !== undefined && !['image', 'photograph', 'illustration', 'map', 'screenshot', 'infographic', 'artwork', 'webpage', 'book', 'other'].includes(citation.medium)) return false;
    if (citation.permissionStatus !== undefined && !['unknown', 'not-required', 'requested', 'granted', 'not-granted'].includes(citation.permissionStatus)) return false;
    return ['includeInCredits', 'includeInReferences'].every((key) => citation[key] === undefined || typeof citation[key] === 'boolean');
  };
  const validateMediaBlock = (block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)
      || !['paragraph', 'figure', 'document', 'missing'].includes(block.type)) return false;
    if (block.type === 'paragraph') return typeof block.text === 'string' && block.text.length <= 5_000_000;
    if (block.type === 'missing') return typeof block.filename === 'string';
    if (!isSafeImportedResource(block.src)) return false;
    return ['filename', 'alt', 'caption', 'title', 'text', 'figureId'].every((key) => block[key] === undefined || typeof block[key] === 'string')
      && validateCitation(block.citation);
  };
  for (const key of ['contentBlocks', 'sourceMedia']) {
    if (source[key] !== undefined && source[key] !== null
      && (!Array.isArray(source[key]) || source[key].length > 500 || !source[key].every(validateMediaBlock))) {
      throw new Error(`La copia contiene recursos inválidos en ${key}. No se guardó nada.`);
    }
  }
  const snapshot = source.originalSnapshot;
  if (snapshot !== undefined && snapshot !== null) {
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)
      || (snapshot.contentBlocks !== undefined && snapshot.contentBlocks !== null && (!Array.isArray(snapshot.contentBlocks)
        || snapshot.contentBlocks.length > 500 || !snapshot.contentBlocks.every(validateMediaBlock)))) {
      throw new Error('La copia contiene una versión original inválida. No se guardó nada.');
    }
  }
  if (source.figureCitations !== undefined && (!source.figureCitations || typeof source.figureCitations !== 'object'
    || Array.isArray(source.figureCitations) || Object.keys(source.figureCitations).length > 500
    || !Object.entries(source.figureCitations).every(([key, citation]) => key.length <= 500 && validateCitation(citation)))) {
    throw new Error('La copia contiene metadatos de procedencia inválidos. No se guardó nada.');
  }
  if (source.images !== undefined && (!Array.isArray(source.images) || source.images.length > 8
    || !source.images.every((image) => image && typeof image === 'object' && isSafeImportedResource(image.src)
      && ['filename', 'alt', 'caption', 'id', 'figureId'].every((key) => image[key] === undefined || typeof image[key] === 'string')
      && validateCitation(image.citation)))) {
    throw new Error('La copia contiene imágenes inválidas. No se guardó nada.');
  }
  if (source.attachments !== undefined && (!Array.isArray(source.attachments) || source.attachments.length > 4
    || !source.attachments.every((attachment) => attachment && typeof attachment === 'object'
      && typeof attachment.filename === 'string' && attachment.filename.length <= 240
      && (attachment.title === undefined || (typeof attachment.title === 'string' && attachment.title.length <= 180))
      && (attachment.id === undefined || typeof attachment.id === 'string')
      && isSafeImportedResource(attachment.src)))) {
    throw new Error('La copia contiene PDF adjuntos inválidos. No se guardó nada.');
  }
  if ((source.attachments || []).reduce((total, attachment) => total + Math.floor((attachment.src.split(',')[1] || '').length * 3 / 4), 0) > 12 * 1024 * 1024) {
    throw new Error('Los PDF adjuntos de una entrada superan el límite de 12 MB. No se guardó nada.');
  }
}

function mergeImportedImagesPreservingCitation(existingImages, incomingImages) {
  const previousById = new Map((Array.isArray(existingImages) ? existingImages : []).filter((image) => image?.id).map((image) => [image.id, image]));
  return (Array.isArray(incomingImages) ? incomingImages : []).map((image) => {
    const previous = image?.id ? previousById.get(image.id) : null;
    if (!previous) return image;
    return {
      ...previous,
      ...image,
      citation: image.citation ? { ...(previous.citation || {}), ...image.citation } : previous.citation
    };
  });
}

async function importBackup(file) {
  try {
    if (file.size > 300 * 1024 * 1024) throw new Error('La copia supera el límite de 300 MB. No se guardó nada.');
    const data = JSON.parse(await file.text());
    if (data.format === 'proyecto-grado-pwa-content-patches') {
      await importContentPatchPackage(data);
      return;
    }
    if (data.format !== 'proyecto-grado-pwa' || !Array.isArray(data.entries) || data.entries.length > 5000) throw new Error('Formato de copia no reconocido o demasiado grande.');
    data.entries.forEach(validateImportedEntry);
    const backupAtlasOrder = readAtlasOrderState(data.atlasOrder);
    const mergedBackupAtlasOrder = mergeAtlasDeletionRecords(atlasOrderState, backupAtlasOrder);
    const hasSavedAtlasOrder = (value) => ['nodes', 'entries', 'deletedEntries', 'deletedPhases']
      .some((key) => Object.keys(value[key] || {}).length > 0);
    const atlasOrderIsNewer = (Boolean(backupAtlasOrder.updatedAt)
      && Date.parse(backupAtlasOrder.updatedAt) > (Date.parse(atlasOrderState.updatedAt) || 0))
      || (!hasSavedAtlasOrder(atlasOrderState) && hasSavedAtlasOrder(backupAtlasOrder));
    const hasNewDeletionRecords = JSON.stringify(mergedBackupAtlasOrder.deletedEntries) !== JSON.stringify(atlasOrderState.deletedEntries)
      || JSON.stringify(mergedBackupAtlasOrder.deletedPhases) !== JSON.stringify(atlasOrderState.deletedPhases);
    if (new Set(data.entries.map((entry) => entry.id)).size !== data.entries.length) throw new Error('La copia contiene IDs duplicados. No se guardó nada.');
    const existingById = new Map(entries.map((entry) => [entry.id, entry]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    const batch = [];
    for (const source of data.entries) {
      if (mergedBackupAtlasOrder.deletedEntries[source.id]) continue;
      const existing = existingById.get(source.id);
      if (!existing) {
        const entry = {
          ...source,
          id: source.id,
          title: source.title,
          type: normalizeEntryType(source.type),
          status: ['Borrador', 'En revisión', 'Verificada', 'Archivada'].includes(source.status) ? source.status : 'Borrador',
          tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string').slice(0, 30) : [],
          contentBlocks: Array.isArray(source.contentBlocks) ? source.contentBlocks : null,
          sourceMedia: Array.isArray(source.sourceMedia) ? source.sourceMedia : [],
          images: Array.isArray(source.images) ? source.images : [],
          attachments: Array.isArray(source.attachments) ? source.attachments : [],
          figureCitations: source.figureCitations && typeof source.figureCitations === 'object' ? source.figureCitations : {},
          originalSnapshot: source.originalSnapshot && typeof source.originalSnapshot === 'object' ? source.originalSnapshot : null,
          localEditedAt: typeof source.localEditedAt === 'string' ? source.localEditedAt : null,
          createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
          updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString()
        };
        batch.push(entry);
        existingById.set(entry.id, entry);
        added += 1;
        continue;
      }
      const sameContent = JSON.stringify(existing) === JSON.stringify(source);
      if (sameContent) { unchanged += 1; continue; }
      const sourceTime = Date.parse(source.updatedAt || '') || 0;
      const existingTime = Date.parse(existing.updatedAt || '') || 0;
      if (sourceTime > existingTime) {
        const replacement = {
          ...source,
          type: normalizeEntryType(source.type, existing.type),
          status: ['Borrador', 'En revisión', 'Verificada', 'Archivada'].includes(source.status) ? source.status : existing.status,
          tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string').slice(0, 30) : [],
          contentBlocks: source.contentBlocks === undefined
            ? (existing.contentBlocks ?? null)
            : (Array.isArray(source.contentBlocks) ? source.contentBlocks : null),
          sourceMedia: source.sourceMedia === undefined
            ? (existing.sourceMedia || [])
            : (Array.isArray(source.sourceMedia) ? source.sourceMedia : []),
          images: source.images === undefined
            ? (existing.images || [])
            : mergeImportedImagesPreservingCitation(existing.images, source.images),
          attachments: source.attachments === undefined
            ? (existing.attachments || [])
            : (Array.isArray(source.attachments) ? source.attachments : []),
          figureCitations: { ...(existing.figureCitations || {}), ...(source.figureCitations || {}) },
          originalSnapshot: source.originalSnapshot && typeof source.originalSnapshot === 'object' ? source.originalSnapshot : existing.originalSnapshot ?? null
        };
        batch.push(replacement);
        existingById.set(replacement.id, replacement);
        updated += 1;
      } else {
        conflicts += 1;
      }
    }
    if (added + updated) {
      const confirmed = window.confirm(`La copia contiene ${added} entradas nuevas y ${updated} versiones más recientes. ${conflicts} conflictos conservan la versión local por ser igual o más nueva. ¿Guardar los cambios válidos en una sola operación?`);
      if (!confirmed) return;
      await putEntriesAtomically(batch);
    }
    if (atlasOrderIsNewer || hasNewDeletionRecords) {
      atlasOrderState = atlasOrderIsNewer
        ? { ...backupAtlasOrder, deletedEntries: mergedBackupAtlasOrder.deletedEntries, deletedPhases: mergedBackupAtlasOrder.deletedPhases }
        : mergedBackupAtlasOrder;
      try { localStorage.setItem(ATLAS_ORDER_KEY, JSON.stringify(atlasOrderState)); } catch (error) { console.warn('No se pudo guardar el orden importado del Atlas:', error); }
      editorialSectionsCacheSource = null;
      await applySyncedDeletions(atlasOrderState.deletedEntries);
    }
    entries = await allEntries();
    if (added || updated) {
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      showEntryWorkspace = true;
      activeSection = null;
      activeFilter = 'all';
    }
    renderList();
    if (added || updated) selectEntry(entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0].id);
    if (added || updated || atlasOrderIsNewer || hasNewDeletionRecords) scheduleGitHubSync();
    showToast(`Copia combinada: ${added} nuevas, ${updated} actualizadas, ${unchanged} iguales, ${conflicts} conflictos conservados localmente.`);
  } catch (error) {
    showToast(error.message || 'No se pudo leer esa copia.');
  }
}

async function sha256HexUtf8(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
    throw new Error('Este navegador no permite verificar la firma SHA-256 del paquete. No se guardó nada.');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importContentPatchPackage(data) {
  if (data.version !== 1 || !Array.isArray(data.patches) || !data.patches.length || data.patches.length > 100) {
    throw new Error('El paquete de correcciones no tiene un formato válido. No se guardó nada.');
  }

  const seen = new Set();
  const currentById = new Map(entries.map((entry) => [entry.id, entry]));
  const prepared = [];
  let alreadyApplied = 0;
  let conflicts = 0;

  for (const patch of data.patches) {
    if (!patch || patch.operation !== 'replace-exact-substring' || typeof patch.entryId !== 'string'
      || patch.field !== 'content' || typeof patch.oldValue !== 'string' || !patch.oldValue
      || typeof patch.proposedValue !== 'string' || !patch.proposedValue
      || patch.expectedContentBlocks !== null
      || !/^[a-f0-9]{64}$/i.test(patch.oldValueSha256Utf8 || '')
      || !/^[a-f0-9]{64}$/i.test(patch.proposedValueSha256Utf8 || '')) {
      throw new Error('El paquete contiene una corrección incompleta o no compatible. No se guardó nada.');
    }
    const key = `${patch.entryId}\u0000${patch.field}`;
    if (seen.has(key)) throw new Error('El paquete repite el mismo destino. No se guardó nada.');
    seen.add(key);

    const [actualOldHash, actualProposedHash] = await Promise.all([
      sha256HexUtf8(patch.oldValue),
      sha256HexUtf8(patch.proposedValue)
    ]);
    if (actualOldHash !== patch.oldValueSha256Utf8.toLowerCase()
      || actualProposedHash !== patch.proposedValueSha256Utf8.toLowerCase()) {
      throw new Error('El paquete no coincide con sus hashes de verificación. No se guardó nada.');
    }

    const entry = currentById.get(patch.entryId);
    if (!entry) { conflicts += 1; continue; }
    const content = entry.content;
    const oldOccurrencesInProposal = patch.proposedValue.split(patch.oldValue).length - 1;
    const oldOccurrencesInEntry = typeof content === 'string' ? content.split(patch.oldValue).length - 1 : -1;
    if (typeof content === 'string' && content.includes(patch.proposedValue)
      && oldOccurrencesInEntry === oldOccurrencesInProposal) {
      alreadyApplied += 1;
      continue;
    }
    const first = typeof content === 'string' ? content.indexOf(patch.oldValue) : -1;
    if (entry.contentBlocks != null || first < 0 || content.indexOf(patch.oldValue, first + patch.oldValue.length) >= 0) {
      conflicts += 1;
      continue;
    }

    prepared.push({ entry, patch, first });
  }

  if (!prepared.length) {
    showToast(`Paquete revisado: 0 aplicadas, ${alreadyApplied} ya aplicadas, ${conflicts} conflictos sin cambios.`);
    return;
  }

  const ids = prepared.map(({ patch }) => patch.entryId).join(', ');
  const confirmed = window.confirm(
    `El paquete «${data.title || data.taskId || 'Correcciones APA'}» propone ${prepared.length} corrección(es) exactas para ${ids}. `
    + `${alreadyApplied} ya están aplicadas y ${conflicts} no coinciden con el texto esperado. `
    + 'Se conservarán los demás campos, medios y ediciones locales. '
    + (githubSyncEnabled() ? 'La PWA sincronizará las correcciones con GitHub después de guardarlas. ' : 'La copia quedará guardada localmente. ')
    + '¿Aplicar las correcciones compatibles?'
  );
  if (!confirmed) return;

  const now = new Date().toISOString();
  const batch = prepared.map(({ entry, patch, first }) => ({
    ...entry,
    content: `${entry.content.slice(0, first)}${patch.proposedValue}${entry.content.slice(first + patch.oldValue.length)}`,
    originalSnapshot: entry.originalSnapshot || {
      title: entry.title,
      content: entry.content,
      contentBlocks: entry.contentBlocks ?? null
    },
    localEditedAt: now,
    updatedAt: now
  }));
  await putEntriesAtomically(batch);
  entries = await allEntries();
  renderList();
  if (selectedId && batch.some((entry) => entry.id === selectedId)) selectEntry(selectedId);
  if (githubSyncEnabled()) scheduleGitHubSync();
  showToast(`Paquete revisado: ${batch.length} aplicadas, ${alreadyApplied} ya aplicadas, ${conflicts} conflictos sin cambios.`);
}

async function reviewBundledContentCorrections() {
  try {
    const response = await fetch('./importaciones/correcciones-apa-028-001.json');
    if (!response.ok) throw new Error('No se pudo cargar la corrección incluida en la PWA.');
    await importContentPatchPackage(await response.json());
  } catch (error) {
    showToast(error.message || 'No se pudo revisar la corrección incluida.');
  }
}

async function migrateFacultyGuidelineSiteAudit(sourceEntries, knownEntries) {
  const migrationId = 'faculty-guideline-current-site-check-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'pwa-faculty-guideline-status-2026-10-20'
    && entry.institutionalGuidelineSiteAuditMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.institutionalGuidelineSiteAuditSnapshot;
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  if (!incoming || !existing || !snapshot || existing.institutionalGuidelineSiteAuditMigration === migrationId
    || existing.content !== snapshot.content
    || stable(existing.sourceReview || null) !== stable(snapshot.sourceReview || null)
    || existing.status !== snapshot.status || existing.updatedAt !== snapshot.updatedAt) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    sourceReview: incoming.sourceReview,
    institutionalGuidelineSiteAudit: incoming.institutionalGuidelineSiteAudit,
    institutionalGuidelineSiteAuditSnapshot: {
      title: existing.title,
      content: existing.content,
      sourceReview: existing.sourceReview || null,
      status: existing.status,
      updatedAt: existing.updatedAt,
      capturedAt: new Date().toISOString()
    },
    institutionalGuidelineSiteAuditMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateTemporalDisorderConceptLabel(sourceEntries, knownEntries) {
  const migrationId = 'renumber-temporal-disorder-concept-label-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-clutter-source-4-1-6'
    && entry.conceptLabelCorrectionMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.conceptLabelCorrectionSnapshot;
  if (!incoming || !existing || !snapshot || existing.conceptLabelCorrectionMigration === migrationId
    || existing.content !== snapshot.content || existing.status !== snapshot.status
    || !incoming.content.includes('g. El desorden temporal')
    || incoming.content.includes('f. El desorden temporal')) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    conceptLabelCorrectionSnapshot: {
      content: existing.content,
      status: existing.status,
      updatedAt: existing.updatedAt,
      localEditedAt: existing.localEditedAt || null,
      capturedAt: new Date().toISOString()
    },
    conceptLabelCorrectionMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateAssociatedConceptsTolinApaCorrection(sourceEntries, knownEntries) {
  const migrationId = 'apa-associated-concepts-tolin-reference-correction-and-review-2026-10-22-v1';
  const entryId = 'atlas-clutter-source-4-1-6';
  const oldCitation = 'Tolin (2011), por su parte, aborda la adquisición compulsiva, el guardado y el trastorno de acumulación';
  const newCitation = 'Tolin et al. (2007), por su parte, abordan la adquisición compulsiva, el guardado y el trastorno de acumulación';
  const oldReference = 'Tolin, D. F. (2011). *Buried in treasures: Help for compulsive acquiring, saving, and hoarding*. Oxford University Press.';
  const newReference = 'Tolin, D. F., Frost, R. O., & Steketee, G. (2007). *Buried in treasures: Help for compulsive acquiring, saving, and hoarding*. Oxford University Press.';
  const incomingEntry = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaAcademicContentReview?.migrationId === migrationId);
  const existingEntry = incomingEntry && knownEntries.get(entryId);
  const snapshot = incomingEntry?.apaAssociatedConceptsSnapshot;
  const incomingBibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const incomingTolinRecord = sourceEntries.find((entry) => entry?.id === 'apa-ref-bccd69aa186bfb8c9f89');
  if (!incomingEntry || !existingEntry || !snapshot || !incomingBibliography || !incomingTolinRecord
    || existingEntry.apaAssociatedConceptsCorrectionAppliedMigration === migrationId) return 0;

  const updates = [];
  const entryContent = String(existingEntry.content || '');
  if (entryContent.includes(oldCitation)) {
    const contentMatchesBundleSnapshot = entryContent === snapshot.priorContent;
    const contentBlocks = Array.isArray(existingEntry.contentBlocks)
      ? existingEntry.contentBlocks.map((block) => typeof block?.text === 'string' && block.text.includes(oldCitation)
        ? { ...block, text: block.text.replace(oldCitation, newCitation) } : block)
      : existingEntry.contentBlocks;
    const updatedEntry = {
      ...existingEntry,
      content: entryContent.replace(oldCitation, newCitation),
      ...(Array.isArray(contentBlocks) ? { contentBlocks } : {}),
      apaAssociatedConceptsCorrectionAppliedMigration: migrationId,
      apaAssociatedConceptsCorrectionSnapshot: {
        priorContent: entryContent,
        priorContentBlocks: existingEntry.contentBlocks || null,
        sourceSnapshotSha256: snapshot.priorContentSha256,
        capturedAt: new Date().toISOString()
      },
      ...(contentMatchesBundleSnapshot && incomingEntry.apaAcademicContentReview
        ? { apaAcademicContentReview: incomingEntry.apaAcademicContentReview } : {}),
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    updates.push(updatedEntry);
  }

  const bibliographyId = incomingBibliography.id;
  const existingBibliography = knownEntries.get(bibliographyId);
  if (existingBibliography?.content?.includes(oldReference)) {
    updates.push({
      ...existingBibliography,
      content: existingBibliography.content.replace(oldReference, newReference),
      apaAssociatedConceptsCorrectionAppliedMigration: migrationId,
      apaAssociatedConceptsCorrectionSnapshot: {
        priorReference: oldReference,
        capturedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  const existingTolinRecord = knownEntries.get(incomingTolinRecord.id);
  const oldTolinRecordText = 'Tolin, D. F. (2011). Buried in treasures: Help for compulsive acquiring, saving, and hoarding. Oxford University Press.';
  if (existingTolinRecord?.content?.includes(oldTolinRecordText)) {
    const plainNewReference = 'Tolin, D. F., Frost, R. O., & Steketee, G. (2007). Buried in treasures: Help for compulsive acquiring, saving, and hoarding. Oxford University Press.';
    const updatedContent = existingTolinRecord.content.replace(oldTolinRecordText, plainNewReference);
    updates.push({
      ...existingTolinRecord,
      title: existingTolinRecord.title === 'Tolin, D. F (2011)' ? 'Tolin, D. F., Frost, R. O., & Steketee, G. (2007)' : existingTolinRecord.title,
      content: updatedContent,
      apaAssociatedConceptsCorrectionAppliedMigration: migrationId,
      apaAssociatedConceptsCorrectionSnapshot: {
        priorTitle: existingTolinRecord.title,
        priorContent: existingTolinRecord.content,
        capturedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function migrateForeignAntecedentsApaScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-foreign-antecedents-and-instrument-scope-review-2026-10-22-v1';
  const incomingEntry = sourceEntries.find((entry) => entry?.id === 'idml-r1-u2a0d'
    && entry.apaAcademicContentReview?.migrationId === migrationId);
  const incomingReference = sourceEntries.find((entry) => entry?.id === 'apa-ref-f35ff066c94b2f68d19d'
    && entry.apaKondo2022TitleCorrectionMigration === migrationId);
  const incomingBibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaKondo2022TitleCorrectionSnapshot?.migrationId === migrationId);
  const incomingLegacyCards = sourceEntries.filter((entry) => entry?.type === 'Fuente'
    && entry.apaKondo2022TitleCorrectionMigration === migrationId);
  if (!incomingEntry || !incomingReference || !incomingBibliography || !incomingLegacyCards.length) return 0;

  const updates = [];
  const existingEntry = knownEntries.get(incomingEntry.id);
  const snapshot = incomingEntry.apaAcademicContentReviewSnapshot;
  if (existingEntry && snapshot?.priorContent && existingEntry.content === snapshot.priorContent
    && existingEntry.apaForeignAntecedentsReviewApplied !== migrationId) {
    updates.push({
      ...existingEntry,
      content: incomingEntry.content,
      contentReviewState: incomingEntry.contentReviewState,
      contentReviewNote: incomingEntry.contentReviewNote,
      apaAcademicContentReview: incomingEntry.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: {
        ...snapshot,
        capturedAt: new Date().toISOString(),
        localPriorContentSha256: snapshot.priorContentSha256
      },
      apaForeignAntecedentsReviewApplied: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  const existingReference = knownEntries.get(incomingReference.id);
  const oldReference = 'Kondo, M. (2022). Kurashi at home: How to organize your space and achieve your ideal life. Ten Speed Press.';
  const newReference = 'Kondo, M. (2022). *Marie Kondo’s kurashi at home: How to organize your space and achieve your ideal life*. Ten Speed Press.';
  if (existingReference?.content?.includes(oldReference)
    && existingReference.apaKondo2022TitleCorrectionMigration !== migrationId) {
    updates.push({
      ...existingReference,
      title: incomingReference.title,
      content: existingReference.content.replace(oldReference, newReference),
      apaReferenceRecord: incomingReference.apaReferenceRecord,
      contentReviewNote: incomingReference.contentReviewNote,
      apaKondo2022TitleCorrectionMigration: migrationId,
      apaKondo2022TitleCorrectionSnapshot: {
        priorTitle: existingReference.title,
        priorContent: existingReference.content,
        priorApaReferenceRecord: existingReference.apaReferenceRecord || null,
        capturedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  const existingBibliography = knownEntries.get(incomingBibliography.id);
  const oldBibliographyLine = 'Kondo, M. (2022). *Kurashi at home: How to organize your space and achieve your ideal life*. Ten Speed Press.';
  const newBibliographyLine = 'Kondo, M. (2022). *Marie Kondo’s kurashi at home: How to organize your space and achieve your ideal life*. Ten Speed Press.';
  if (existingBibliography?.content?.includes(oldBibliographyLine)
    && existingBibliography.apaKondo2022TitleCorrectionApplied !== migrationId) {
    updates.push({
      ...existingBibliography,
      content: existingBibliography.content.replace(oldBibliographyLine, newBibliographyLine),
      apaKondo2022TitleCorrectionApplied: migrationId,
      apaKondo2022TitleCorrectionSnapshot: {
        priorParagraph: oldBibliographyLine,
        capturedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  const oldLegacyReference = 'Kondo, M. (2022). Kurashi at home: How to organize your space and achieve your ideal life. Ten Speed Press.';
  for (const incomingLegacyCard of incomingLegacyCards) {
    const existingLegacyCard = knownEntries.get(incomingLegacyCard.id);
    if (existingLegacyCard?.content?.includes(oldLegacyReference)
      && existingLegacyCard.apaKondo2022TitleCorrectionApplied !== migrationId) {
      updates.push({
        ...existingLegacyCard,
        content: existingLegacyCard.content.replace(oldLegacyReference, newReference),
        apaKondo2022TitleCorrectionApplied: migrationId,
        apaKondo2022TitleCorrectionSnapshot: {
          priorContent: existingLegacyCard.content,
          capturedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString(),
        localEditedAt: new Date().toISOString()
      });
    }
  }

  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function migrateDesignEditorial144ApaReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-design-editorial-local-results-unicef-source-scope-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-editorial'
    && entry.apaAcademicContentReview?.migrationId === migrationId
    && entry.apaDesignEditorialReviewMigration?.migrationId === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  if (!incoming || !existing || existing.apaDesignEditorialReviewApplied === migrationId) return 0;
  const replacements = incoming.apaDesignEditorialReviewMigration;
  if (!Array.isArray(replacements?.oldParagraphs) || replacements.oldParagraphs.length !== 2
    || !Array.isArray(replacements.newParagraphs) || replacements.newParagraphs.length !== 2) return 0;
  const originalContent = String(existing.content || '');
  if (replacements.oldParagraphs.some((paragraph) => originalContent.split(paragraph).length !== 2)) return 0;
  const originalBlocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
  if (replacements.oldParagraphs.some((paragraph) => originalBlocks.filter((block) => block?.type === 'paragraph' && block.text === paragraph).length !== 1)) return 0;

  let content = originalContent;
  for (let index = 0; index < replacements.oldParagraphs.length; index += 1) {
    content = content.replace(replacements.oldParagraphs[index], replacements.newParagraphs[index]);
  }
  const updated = {
    ...existing,
    content,
    contentBlocks: originalBlocks.map((block) => {
      if (block?.type !== 'paragraph') return block;
      const index = replacements.oldParagraphs.indexOf(block.text);
      return index < 0 ? block : { ...block, text: replacements.newParagraphs[index] };
    }),
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAcademicContentReviewSnapshot: {
      ...incoming.apaAcademicContentReviewSnapshot,
      priorContent: originalContent,
      priorContentBlocks: originalBlocks,
      capturedAt: new Date().toISOString()
    },
    apaDesignEditorialReviewApplied: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateFrost1995ReferenceAtlasPlacement(sourceEntries, knownEntries) {
  const entryId = 'apa-ref-frost-hartl-christian-williams-1995';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId && entry.guideNodeId === 'pgdg-19');
  const existing = incoming && knownEntries.get(entryId);
  if (!incoming || !existing || existing.guideNodeId === 'pgdg-19') return 0;
  const updated = {
    ...existing,
    guideNodeId: 'pgdg-19',
    atlasPlacementReconciliation: 'atlas-placement-reconciliation-frost-1995-reference-v1',
    atlasPlacementRationale: 'Registro de fuente APA ubicado en 4.1 Referencias; su área de origen indica Referencias · apartado 4.1.',
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateConceptFigures4116(sourceEntries, knownEntries) {
  const migrationId = 'add-concept-figures-4-1-6-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-clutter-source-4-1-6'
    && entry.conceptFiguresMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.conceptFiguresSnapshot;
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  if (!incoming || !existing || !snapshot || existing.conceptFiguresMigration === migrationId
    || existing.content !== incoming.content || existing.status !== snapshot.status
    || stable(existing.contentBlocks || []) !== stable(snapshot.contentBlocks || [])
    || stable(existing.figureCitations || {}) !== stable(snapshot.figureCitations || {})) return 0;
  const updated = {
    ...existing,
    contentBlocks: incoming.contentBlocks,
    figureCitations: incoming.figureCitations,
    conceptFiguresSnapshot: {
      contentBlocks: existing.contentBlocks || [],
      figureCitations: existing.figureCitations || {},
      status: existing.status,
      contentReviewState: existing.contentReviewState || null,
      capturedAt: new Date().toISOString()
    },
    conceptFiguresMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateContentIllustrationsDesignAudience(sourceEntries, knownEntries) {
  const migrationId = 'add-illustrations-design-audience-2026-10-21-v1';
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let applied = 0;
  for (const incoming of sourceEntries.filter((entry) => entry?.contentFiguresMigration === migrationId)) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.contentFiguresSnapshot;
    if (!existing || !snapshot || snapshot.createdEntry || existing.contentFiguresMigration === migrationId
      || existing.content !== incoming.content || existing.status !== snapshot.status
      || stable(existing.contentBlocks ?? null) !== stable(snapshot.contentBlocks ?? null)
      || stable(existing.figureCitations || {}) !== stable(snapshot.figureCitations || {})) continue;
    const updated = {
      ...existing,
      contentBlocks: incoming.contentBlocks,
      figureCitations: incoming.figureCitations,
      contentFiguresSnapshot: {
        contentBlocks: existing.contentBlocks ?? null,
        figureCitations: existing.figureCitations || {},
        status: existing.status,
        contentReviewState: existing.contentReviewState || null,
        contentReviewNote: existing.contentReviewNote || null,
        localEditedAt: existing.localEditedAt || null,
        capturedAt: new Date().toISOString()
      },
      contentFiguresMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    applied += 1;
  }
  return applied;
}

async function migrateAudiencePsychopedagogicFigureRefresh(sourceEntries, knownEntries) {
  const migrationId = 'replace-figure-95-psychopedagogic-v2-2026-10-21';
  const entryId = 'atlas-outline-audience-psychopedagogic';
  const figureId = 'generated-openai-2026:atlas-outline-audience-psychopedagogic:audience-psychopedagogic';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.figureRefreshMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.figureRefreshSnapshot;
  const incomingFigure = incoming?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  if (!existing || !snapshot || existing.figureRefreshMigration === migrationId
    || !incomingFigure || snapshot.figureId !== figureId) return 0;

  let replaced = false;
  const replaceIfUnchanged = (blocks) => {
    if (!Array.isArray(blocks)) return blocks;
    return blocks.map((block) => {
      if (block?.type !== 'figure' || block.figureId !== figureId || block.src !== snapshot.asset) return block;
      replaced = true;
      return {
        ...block,
        src: incomingFigure.src,
        alt: block.alt === snapshot.alt ? incomingFigure.alt : block.alt,
        caption: block.caption === snapshot.caption || block.caption === undefined
          ? incomingFigure.caption : block.caption,
        figureRefreshMigration: migrationId
      };
    });
  };
  const contentBlocks = replaceIfUnchanged(existing.contentBlocks);
  const sourceMedia = replaceIfUnchanged(existing.sourceMedia);
  const images = replaceIfUnchanged(existing.images);
  if (!replaced) return 0;

  const updated = {
    ...existing,
    contentBlocks,
    sourceMedia,
    images,
    figureRefreshMigration: migrationId,
    figureRefreshSnapshot: { figureId, asset: snapshot.asset, alt: snapshot.alt, capturedAt: new Date().toISOString() },
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateAudienceInfographicFigureRefresh(sourceEntries, knownEntries) {
  const migrationId = 'replace-figure-96-audience-infographic-v2-2026-10-21';
  const entryId = 'idml-r1-u6227';
  const figureId = 'recovered:idml-r1-u6227:blocks:0:infografía-Grupo-objetivo.jpg';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.figureRefreshMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.figureRefreshSnapshot;
  const incomingFigure = incoming?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  const localFigure = existing?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  const localCitation = existing?.figureCitations?.[figureId] || localFigure?.citation || {};
  const citationNeedsRefresh = localCitation.sourceTitle === 'ChatGPT'
    || String(localCitation.creditNote || '').includes('OpenAI, 2026)');
  if (existing?.figureRefreshMigration === migrationId && incomingFigure
    && localFigure?.src === incomingFigure.src
    && citationNeedsRefresh) {
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      contentBlocks: existing.contentBlocks.map((block) => block?.figureId === figureId
        ? { ...block, citation: incomingFigure.citation, caption: incomingFigure.caption } : block),
      figureCitations: { ...(existing.figureCitations || {}), [figureId]: incomingFigure.citation },
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(entryId, updated);
    return 1;
  }
  if (!existing || !snapshot || existing.figureRefreshMigration === migrationId
    || !incomingFigure || snapshot.block?.figureId !== figureId
    || existing.content !== snapshot.content || existing.status !== snapshot.status
    || localFigure?.src !== snapshot.block.src || localFigure.src !== './media/d0e7e68750c597708e8e.jpg') return 0;

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    title: existing.title === snapshot.title ? incoming.title : existing.title,
    type: existing.type === snapshot.type ? incoming.type : existing.type,
    status: existing.status === snapshot.status ? incoming.status : existing.status,
    area: existing.area === snapshot.area ? incoming.area : existing.area,
    content: existing.content === snapshot.content ? incoming.content : existing.content,
    guideNodeId: existing.guideNodeId === snapshot.guideNodeId ? incoming.guideNodeId : existing.guideNodeId,
    customGuideNode: incoming.customGuideNode,
    contentBlocks: existing.contentBlocks.map((block) => block?.type === 'figure' && block.figureId === figureId
      && block.src === snapshot.block.src ? { ...block, ...incomingFigure } : block),
    figureCitations: { ...(existing.figureCitations || {}), [figureId]: incoming.figureCitations?.[figureId] || incomingFigure.citation },
    figureRefreshMigration: migrationId,
    figureRefreshSnapshot: { migrationId, figureId, asset: snapshot.block.src, capturedAt: now },
    figureRefreshNewAsset: incoming.figureRefreshNewAsset,
    figureRefreshNewAlt: incoming.figureRefreshNewAlt,
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    localEditedAt: now,
    updatedAt: now
  };
  if (existing.atlasPlacementReconciliation === snapshot.atlasPlacementReconciliation) delete updated.atlasPlacementReconciliation;
  if (existing.atlasPlacementRationale === snapshot.atlasPlacementRationale) delete updated.atlasPlacementRationale;
  if (existing.atlasPreviousStatus === snapshot.atlasPreviousStatus) delete updated.atlasPreviousStatus;
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateAudienceInfographicPhotoLed(sourceEntries, knownEntries) {
  const migrationId = 'replace-figure-96-audience-infographic-photo-led-v3-2026-10-21';
  const priorMigrationId = 'replace-figure-96-audience-infographic-v2-2026-10-21';
  const entryId = 'idml-r1-u6227';
  const figureId = 'recovered:idml-r1-u6227:blocks:0:infografía-Grupo-objetivo.jpg';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId && entry.figureRefreshMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const incomingFigure = incoming?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  const localFigure = existing?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  if (!incoming || !existing || !incomingFigure || existing.figureRefreshMigration === migrationId
    || existing.figureRefreshMigration !== priorMigrationId
    || localFigure?.src !== './media/figura-96-grupo-objetivo-v2.svg') return 0;

  const now = new Date().toISOString();
  const previousRevision = incoming.figureRefreshPreviousRevision || {};
  const updated = {
    ...existing,
    content: existing.content === previousRevision.content ? incoming.content : existing.content,
    contentBlocks: existing.contentBlocks.map((block) => block?.figureId === figureId
      ? { ...block, ...incomingFigure } : block),
    figureCitations: { ...(existing.figureCitations || {}), [figureId]: incoming.figureCitations?.[figureId] || incomingFigure.citation },
    figureRefreshMigration: migrationId,
    figureRefreshMigrationHistory: [...new Set([...(existing.figureRefreshMigrationHistory || []), priorMigrationId, migrationId])],
    figureRefreshPreviousRevision: previousRevision,
    figureRefreshNewAsset: incoming.figureRefreshNewAsset,
    figureRefreshNewAlt: incoming.figureRefreshNewAlt,
    figureRefreshNewBaseAsset: incoming.figureRefreshNewBaseAsset,
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateAudienceInfographicDataDense(sourceEntries, knownEntries) {
  const migrationId = 'replace-figure-96-audience-infographic-datadense-v4-2026-10-21';
  const priorMigrationIds = [
    'replace-figure-96-audience-infographic-v2-2026-10-21',
    'replace-figure-96-audience-infographic-photo-led-v3-2026-10-21'
  ];
  const entryId = 'idml-r1-u6227';
  const figureId = 'recovered:idml-r1-u6227:blocks:0:infografía-Grupo-objetivo.jpg';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId && entry.figureRefreshMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const incomingFigure = incoming?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  const localFigure = existing?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  if (!incoming || !existing || !incomingFigure || existing.figureRefreshMigration === migrationId
    || !priorMigrationIds.includes(existing.figureRefreshMigration)
    || !['./media/figura-96-grupo-objetivo-v2.svg', './media/figura-96-grupo-objetivo-v3.svg'].includes(localFigure?.src)) return 0;

  const now = new Date().toISOString();
  const previousRevision = incoming.figureRefreshPreviousRevision || {};
  const updated = {
    ...existing,
    content: existing.content === previousRevision.content ? incoming.content : existing.content,
    contentBlocks: existing.contentBlocks.map((block) => block?.figureId === figureId
      ? { ...block, ...incomingFigure } : block),
    figureCitations: { ...(existing.figureCitations || {}), [figureId]: incoming.figureCitations?.[figureId] || incomingFigure.citation },
    figureRefreshMigration: migrationId,
    figureRefreshMigrationHistory: [...new Set([...(existing.figureRefreshMigrationHistory || []), ...priorMigrationIds, migrationId])],
    figureRefreshPreviousRevision: previousRevision,
    figureRefreshRevisionSnapshots: incoming.figureRefreshRevisionSnapshots || existing.figureRefreshRevisionSnapshots || [],
    figureRefreshNewAsset: incoming.figureRefreshNewAsset,
    figureRefreshNewAlt: incoming.figureRefreshNewAlt,
    figureRefreshNewBaseAsset: incoming.figureRefreshNewBaseAsset,
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateAudienceInfographicChatGPTV5(sourceEntries, knownEntries) {
  const migrationId = 'replace-figure-96-chatgpt-infographic-v5-2026-10-21';
  const entryId = 'idml-r1-u6227';
  const figureId = 'recovered:idml-r1-u6227:blocks:0:infografía-Grupo-objetivo.jpg';
  const priorAssets = [
    './media/figura-96-grupo-objetivo-v2.svg',
    './media/figura-96-grupo-objetivo-v3.svg',
    './media/figura-96-grupo-objetivo-v4.svg'
  ];
  const incoming = sourceEntries.find((entry) => entry?.id === entryId && entry.figureRefreshMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const incomingFigure = incoming?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  const localFigure = existing?.contentBlocks?.find((block) => block?.type === 'figure' && block.figureId === figureId);
  if (!incoming || !existing || !incomingFigure || existing.figureRefreshMigration === migrationId
    || !localFigure || (!priorAssets.includes(localFigure.src) && localFigure.src !== incomingFigure.src)) return 0;

  const now = new Date().toISOString();
  const priorRevision = {
    migrationId: existing.figureRefreshMigration || 'unversioned',
    asset: localFigure.src,
    alt: localFigure.alt || null,
    caption: localFigure.caption || null,
    citation: existing.figureCitations?.[figureId] || localFigure.citation || null
  };
  const revisions = [...(existing.figureRefreshRevisionSnapshots || [])];
  if (!revisions.some((revision) => revision.migrationId === priorRevision.migrationId)) revisions.push(priorRevision);
  const updated = {
    ...existing,
    contentBlocks: existing.contentBlocks.map((block) => block?.figureId === figureId
      ? { ...block, ...incomingFigure } : block),
    figureCitations: { ...(existing.figureCitations || {}), [figureId]: incoming.figureCitations?.[figureId] || incomingFigure.citation },
    figureRefreshMigration: migrationId,
    figureRefreshMigrationHistory: [...new Set([...(existing.figureRefreshMigrationHistory || []), priorRevision.migrationId, migrationId])],
    figureRefreshPreviousRevision: priorRevision,
    figureRefreshRevisionSnapshots: revisions,
    figureRefreshNewAsset: incoming.figureRefreshNewAsset,
    figureRefreshNewAlt: incoming.figureRefreshNewAlt,
    figureRefreshNewBaseAsset: null,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function mergeBundledProjectContent() {
  try {
  const response = await fetch('./importaciones/contenido-proyecto-autosuficiente-v3.json?v=apa-dime-atlas-numbering-2026-10-22-v1');
    if (!response.ok) return 0;
    const payload = await response.json();
    if (payload.format !== 'proyecto-grado-pwa' || !Array.isArray(payload.entries)) return 0;
    const sourceRevision = typeof payload.dataRevision === 'string' ? payload.dataRevision : `bundle-v${payload.version || 1}`;
    if (payload.atlasOrder) seedBundledAtlasOrder(payload.atlasOrder);
    const sourceEntries = payload.entries
      .filter((entry) => entry && typeof entry.id === 'string' && !atlasOrderState.deletedEntries?.[entry.id])
      .map((entry) => ({ ...entry, type: normalizeEntryType(entry.type), sourceBundleRevision: sourceRevision }));
    bundledContentById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    atlasNumberingCache = null;
    bundledSourceOrder = new Map(sourceEntries.map((entry, index) => [entry.id, index]));
    const knownEntries = new Map((await allEntries()).map((entry) => [entry.id, entry]));
    let added = 0;
    let enriched = 0;
    enriched += await migrateFrost1995ReferenceAtlasPlacement(sourceEntries, knownEntries);
    enriched += await migrateCampaigns141Review(sourceEntries, knownEntries);
    enriched += await migrateLocalDimeAcademicReview(sourceEntries, knownEntries);
    enriched += await migrateDimeCanonicalAtlasNumbering(sourceEntries, knownEntries);
    enriched += await migrateLocalCampaignAtlasNumbers(sourceEntries, knownEntries);
    enriched += await migrateCampaignFigureCreditNotes(sourceEntries, knownEntries);
    enriched += await migrateCampaigns141AudienceReview(sourceEntries, knownEntries);
    enriched += await migrateCampaigns141AudienceRange(sourceEntries, knownEntries);
    enriched += await migrateCampaignFigureCreditSuffix(sourceEntries, knownEntries);
    enriched += await migrateCampaignConceptIllustrations(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkBundleRecords(sourceEntries, knownEntries);
    enriched += await migrateDesignCasesSubject146147Review(sourceEntries, knownEntries);
    enriched += await migrateDesignSubjectInterviewEvidenceAudit(sourceEntries, knownEntries);
    enriched += await migrateDesignSubjectPhotoPermissionReview(sourceEntries, knownEntries);
    enriched += await migrateDesignSubjectPhotoAttributionReview(sourceEntries, knownEntries);
    enriched += await migrateDesignIllustrationCitationReview(sourceEntries, knownEntries);
    enriched += await migrateDesignIllustration145Review(sourceEntries, knownEntries);
    enriched += await migrateDesignIllustrationSurveyResultReview(sourceEntries, knownEntries);
    enriched += await migrateDesignWebsites142Review(sourceEntries, knownEntries);
    enriched += await migrateDesignWebsitesApaReview(sourceEntries, knownEntries);
    enriched += await migrateDesignAudiovisual143Review(sourceEntries, knownEntries);
    enriched += await migrateDesignAudiovisualApaReview(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkContinuation142143146153(sourceEntries, knownEntries);
    enriched += await migrateMayerCopyrightDateReview(sourceEntries, knownEntries);
    enriched += await migrateChaykaApa004Review(sourceEntries, knownEntries);
    enriched += await migrateIcdApa005AmbiguityReview(sourceEntries, knownEntries);
    enriched += await migrateNimhApa006UnsupportedCitation(sourceEntries, knownEntries);
    enriched += await migrateUrlVracApa009CitationLocators(sourceEntries, knownEntries);
    enriched += await migratePinskyApa010IdentityReview(sourceEntries, knownEntries);
    enriched += await migratePinskyApa010CanonicalReference(sourceEntries, knownEntries);
    enriched += await migrateFerrariRosterApa011Review(sourceEntries, knownEntries);
    enriched += await migrateFerrariApa011DoiResolution(sourceEntries, knownEntries);
    enriched += await migrateBeckerApa001Reference(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkCitationSourceLinks(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkSasakiParentCitationLinks(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkApaSourceTitleFormatting(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkCitationSourceAudits(sourceEntries, knownEntries);
    enriched += await migrateDesignEditorial144Review(sourceEntries, knownEntries);
    enriched += await migrateDesignFrameworkNumbering(sourceEntries, knownEntries);
    enriched += await migrateFacultyGuidelineSiteAudit(sourceEntries, knownEntries);
    enriched += await migrateTemporalDisorderConceptLabel(sourceEntries, knownEntries);
    enriched += await migrateAssociatedConceptsTolinApaCorrection(sourceEntries, knownEntries);
    enriched += await migrateForeignAntecedentsApaScopeReview(sourceEntries, knownEntries);
    enriched += await migrateDesignEditorial144ApaReview(sourceEntries, knownEntries);
    enriched += await migrateConceptFigures4116(sourceEntries, knownEntries);
    enriched += await migrateContentIllustrationsDesignAudience(sourceEntries, knownEntries);
    enriched += await migrateAudiencePsychopedagogicFigureRefresh(sourceEntries, knownEntries);
    enriched += await migrateAudienceInfographicFigureRefresh(sourceEntries, knownEntries);
    enriched += await migrateAudienceInfographicPhotoLed(sourceEntries, knownEntries);
    enriched += await migrateAudienceInfographicDataDense(sourceEntries, knownEntries);
    enriched += await migrateAudienceInfographicChatGPTV5(sourceEntries, knownEntries);
    enriched += await migrateApaCitationAuditCorrections(sourceEntries, knownEntries);
    enriched += await migrateApaBecker2024InTextCitation(sourceEntries, knownEntries);
    enriched += await migrateApaUncitedChionForcevilleReferences(sourceEntries, knownEntries);
    enriched += await migrateApaConfirmedUncitedReferences(sourceEntries, knownEntries);
    enriched += await migrateApaHistoricalImageCreditLines(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliography(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyReviewNote(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyCanonicalDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyVerifiedDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyReconcileList(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyForcevilleDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyOpenAIDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyVerifiedVariantDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyVerifiedMetadataDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyBecker2024DateDedup(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyBecker2018EditorVariant(sourceEntries, knownEntries);
    enriched += await migrateApaBeckerOrganizationAlphabeticalOrder(sourceEntries, knownEntries);
    enriched += await migrateApaBeckerFamilyOrder(sourceEntries, knownEntries);
    enriched += await migrateApaFerrariReferenceReconciliation(sourceEntries, knownEntries);
    enriched += await migrateApaCitationAuditVerifiedVariants(sourceEntries, knownEntries);
    enriched += await migrateOpenAiFigureToolReferenceDescriptor(sourceEntries, knownEntries);
    enriched += await migrateOpenAiFigureCitationMetadata2026a(sourceEntries, knownEntries);
    enriched += await migrateApaOpenAi2025SupersededFigureReference(sourceEntries, knownEntries);
    enriched += await migrateApaWcag22CanonicalReference(sourceEntries, knownEntries);
    enriched += await migrateApaAkimova2020CitationReconciliation(sourceEntries, knownEntries);
    enriched += await migrateApaAkimova2020AuthorDateFormat(sourceEntries, knownEntries);
    enriched += await migrateApaResearchParticipantAttributions(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyAlphabeticalAudit(sourceEntries, knownEntries);
    enriched += await migrateApaReferenceListOrderCorrection(sourceEntries, knownEntries);
    enriched += await migrateApaUnifiedBibliographyRuntimeReconciliation(sourceEntries, knownEntries);
    enriched += await migrateApaWho2022ReferenceTitle(sourceEntries, knownEntries);
    enriched += await migrateApaBarkley2015ChapterReference(sourceEntries, knownEntries);
    enriched += await migrateApaFactorsRiskRuntimeReview(sourceEntries, knownEntries);
    enriched += await migrateApaFactorsRiskHeadingReview(sourceEntries, knownEntries);
    enriched += await migrateApaAcademicContentLabelReview(sourceEntries, knownEntries);
    enriched += await migrateApaAcademicContentReviewMetadata(sourceEntries, knownEntries);
    enriched += await migrateApaProblemStatementAcademicReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterOverviewAcademicReview(sourceEntries, knownEntries);
    enriched += await migrateApaInstitutionalResponseContentReview(sourceEntries, knownEntries);
    enriched += await migrateApaEmpowermentAgencyContentReview(sourceEntries, knownEntries);
    enriched += await migrateApaCommunityPeerSupportContentReview(sourceEntries, knownEntries);
    enriched += await migrateApaSchoreUncitedReferenceExclusion(sourceEntries, knownEntries);
    enriched += await migrateApaGolemanUncitedReferenceExclusion(sourceEntries, knownEntries);
    enriched += await migrateApaMinimalismBeckerDefinitionReview(sourceEntries, knownEntries);
    enriched += await migrateApaDesignEmotionalLiteracyReview(sourceEntries, knownEntries);
    enriched += await migrateApaEducationalMinimalismReview(sourceEntries, knownEntries);
    enriched += await migrateApaVisualCommunicationHabitsReview(sourceEntries, knownEntries);
    enriched += await migrateApaEmotionalMinimalismSectionReview(sourceEntries, knownEntries);
    enriched += await migrateApaVisualEmotionalLiteracyScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudiencePsychopedagogicProfileReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudiencePsychographicProfileReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceDemographicGeographicProfileReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceInDepthInterviewScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceParticipantObservationScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceTargetDefinitionScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceEmpathyMapSourceScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceJourneyMapEvidenceScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaBecomingMinimalistAcademicReview(sourceEntries, knownEntries);
    enriched += await migrateApaKondoBeckerSasakiComparisonReview(sourceEntries, knownEntries);
    enriched += await migrateApaConclusionsEvidenceReview(sourceEntries, knownEntries);
    enriched += await migrateSurveyResultsEvidenceCorrection(sourceEntries, knownEntries);
    enriched += await migrateApaAudienceBuyerPersonaReview(sourceEntries, knownEntries);
    enriched += await migrateApaBecker2016OrphanExclusion(sourceEntries, knownEntries);
    enriched += await migrateApaSpradleyParticipantObservationReferenceReview(sourceEntries, knownEntries);
    enriched += await migrateApaMcAlaryPracticalPerspectiveCitation(sourceEntries, knownEntries);
    enriched += await migrateApaIcdSourceReconciliation(sourceEntries, knownEntries);
    enriched += await migrateApaIcdExcludedSourceDisposition(sourceEntries, knownEntries);
    enriched += await migrateApaReferencePresentationAndNoDateDisambiguation(sourceEntries, knownEntries);
    enriched += await migrateApaReferencePresentationAndNoDateDisambiguation(sourceEntries, knownEntries);
    enriched += await migrateApaInstitutionalEvidenceReview(sourceEntries, knownEntries);
    enriched += await migrateApaGuatemalaContextReview(sourceEntries, knownEntries);
    enriched += await migrateApaGuatemalaHousingScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaGuatemalaCitationYears(sourceEntries, knownEntries);
    enriched += await migrateApaGuatemalaMspasSourceReview(sourceEntries, knownEntries);
    enriched += await migrateApaIne2024SameAuthorBibliographyNote(sourceEntries, knownEntries);
    enriched += await migrateApaSocialNormsResearchQuestions(sourceEntries, knownEntries);
    enriched += await migrateApaClutterClaimReview(sourceEntries, knownEntries);
    enriched += await migrateApaCultureConsumptionRuntimeReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterDefinitionReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterMentalHealthRuntimeReview(sourceEntries, knownEntries);
    enriched += await migrateApaOtherAreasContentReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterTypologyScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaEmotionalClutterReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterTypologyOverview(sourceEntries, knownEntries);
    enriched += await migrateApaSweetenSampleCorrection(sourceEntries, knownEntries);
    enriched += await migrateApaWalshSelfHelpScope(sourceEntries, knownEntries);
    enriched += await migrateApaClutterDecisionProcessesReview(sourceEntries, knownEntries);
    enriched += await migrateApaTemporalDisorderReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterConceptsReview(sourceEntries, knownEntries);
    enriched += await migrateApaPhysicalEffectsReview(sourceEntries, knownEntries);
    enriched += await migrateApaCommunityEffectsReview(sourceEntries, knownEntries);
    enriched += await migrateApaCommunityEffectsSourceCitationReview(sourceEntries, knownEntries);
    enriched += await migrateApaPreventionReviewAndReferenceExclusion(sourceEntries, knownEntries);
    enriched += await migrateApaGuatemalaStudentDiagnosisScopeReview(sourceEntries, knownEntries);
    enriched += await migrateApaUniversityClutterDimensionsReview(sourceEntries, knownEntries);
    enriched += await migrateApaGeneralEffectsReview(sourceEntries, knownEntries);
    enriched += await migrateApaOriginReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterInterventionReview(sourceEntries, knownEntries);
    enriched += await migrateApa41WellbeingDimensionsReview(sourceEntries, knownEntries);
    enriched += await migrateApa41Ods3Citation(sourceEntries, knownEntries);
    enriched += await migrateApaFocusGroupAcademicReview(sourceEntries, knownEntries);
    enriched += await migrateApaAspirationalClutterReview(sourceEntries, knownEntries);
    enriched += await migrateApaDigitalClutterContentReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterTypologyOverviewReview(sourceEntries, knownEntries);
    enriched += await migrateApaClutterSomedayOperationalDefinitionReview(sourceEntries, knownEntries);
    enriched += await migrateApaPhysicalClutterSecondaryCitationReview(sourceEntries, knownEntries);
    enriched += await migrateApaSwansonPatelWhitePaperReferenceFormat(sourceEntries, knownEntries);
    enriched += await migrateApaEmotionalClutterFrostAbstractReview(sourceEntries, knownEntries);
    enriched += await migrateApaOriginClutterContextSourcesReview(sourceEntries, knownEntries);
    enriched += await migrateApaEffectsOverviewReview(sourceEntries, knownEntries);
    enriched += await migrateApaRosterSecondaryCitationReview(sourceEntries, knownEntries);
    for (const entry of sourceEntries) {
      if (!entry || typeof entry.id !== 'string') continue;
      const existing = knownEntries.get(entry.id);
      if (existing) {
        if (existing.localEditedAt) {
          const figureMerge = mergeBundledFigureMetadata(existing);
          const migratedMetadata = {};
          if (entry.referenceListSnapshot === true && existing.referenceListSnapshot !== true) {
            migratedMetadata.referenceListSnapshot = true;
          }
          if (entry.bibliographicReview && !existing.bibliographicReview) {
            migratedMetadata.bibliographicReview = entry.bibliographicReview;
          }
          if (entry.sourceReview && !existing.sourceReview) {
            migratedMetadata.sourceReview = entry.sourceReview;
          }
          if (entry.apaCitationAuditExclusion && !existing.apaCitationAuditExclusion) {
            migratedMetadata.apaCitationAuditExclusion = entry.apaCitationAuditExclusion;
          }
          if (Array.isArray(entry.apaExcludedReferenceLines)
            && JSON.stringify(existing.apaExcludedReferenceLines || []) !== JSON.stringify(entry.apaExcludedReferenceLines)) {
            migratedMetadata.apaExcludedReferenceLines = [...new Set([
              ...(existing.apaExcludedReferenceLines || []),
              ...entry.apaExcludedReferenceLines
            ])];
          }
          for (const field of ['outlineScaffold', 'contentReviewState', 'contentReviewNote', 'atlasStructuralLabel']) {
            if (entry[field] !== undefined && existing[field] === undefined) migratedMetadata[field] = entry[field];
          }
          if (entry.atlasPlacementReconciliation
            && existing.atlasPlacementReconciliation !== entry.atlasPlacementReconciliation) {
            const priorManagedPlacement = typeof existing.atlasPlacementReconciliation === 'string'
              && existing.atlasPlacementReconciliation.startsWith('atlas-placement-reconciliation-');
            if ((!existing.guideNodeId || priorManagedPlacement)
              && !existing.customGuideNode && entry.guideNodeId) {
              migratedMetadata.guideNodeId = entry.guideNodeId;
            }
            if (entry.status === 'Archivada' && existing.status === entry.atlasPreviousStatus
              && existing.content === entry.content) {
              migratedMetadata.status = 'Archivada';
              migratedMetadata.atlasPreviousStatus = entry.atlasPreviousStatus;
            }
            migratedMetadata.atlasPlacementReconciliation = entry.atlasPlacementReconciliation;
            migratedMetadata.atlasPlacementRationale = entry.atlasPlacementRationale;
            migratedMetadata.localEditedAt = new Date().toISOString();
            migratedMetadata.updatedAt = migratedMetadata.localEditedAt;
          }
          if (Object.keys(migratedMetadata).length || figureMerge.added || figureMerge.revisionChanged) {
            const updated = {
              ...figureMerge.entry,
              ...migratedMetadata,
              ...(figureMerge.added ? {
                localEditedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              } : {})
            };
            await putEntry(updated);
            knownEntries.set(entry.id, updated);
            enriched += 1;
          }
          continue;
        }
        if (existing.sourceBundleRevision !== sourceRevision) {
          const updated = {
            ...existing,
            ...entry,
            createdAt: existing.createdAt || entry.createdAt,
            images: entry.images?.length ? entry.images : (existing.images || []),
            attachments: entry.attachments?.length ? entry.attachments : (existing.attachments || [])
          };
          await putEntry(updated);
          knownEntries.set(entry.id, updated);
          enriched += 1;
          continue;
        }
        const sourceBlocks = Array.isArray(entry.contentBlocks) ? entry.contentBlocks : [];
        if (sourceBlocks.length && existing.content === entry.content
          && JSON.stringify(existing.contentBlocks ?? []) !== JSON.stringify(sourceBlocks)) {
          const updated = { ...existing, contentBlocks: sourceBlocks };
          await putEntry(updated);
          knownEntries.set(entry.id, updated);
          enriched += 1;
        } else if (sourceBlocks.length && existing.content !== entry.content && !existing.sourceMedia?.length) {
          const media = sourceBlocks.filter((block) => block.type === 'figure' || block.type === 'document' || block.type === 'missing');
          if (media.length) {
            const updated = { ...existing, sourceMedia: media };
            await putEntry(updated);
            knownEntries.set(entry.id, updated);
            enriched += 1;
          }
        }
        continue;
      }
      await putEntry(entry);
      knownEntries.set(entry.id, entry);
      added += 1;
    }
    enriched += await resolvePresentOutlineScaffoldMarkers(sourceEntries, knownEntries);
    enriched += await migrateAnnexMarkerCandidateReviews(sourceEntries, knownEntries);
    return { added, enriched };
  } catch (error) {
    console.warn('No se pudo integrar el contenido inicial del IDML:', error);
    return 0;
  }
}

async function migrateApaUnifiedBibliography(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-sort-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaUnifiedBibliographyMigrationSnapshot;
  if (!existing || !snapshot || existing.apaUnifiedBibliographyMigrationApplied === migrationId) return 0;
  if (existing.title !== snapshot.title || existing.content !== snapshot.content) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    title: incoming.title,
    content: incoming.content,
    apaUnifiedBibliographyMigrationApplied: migrationId,
    localEditedAt: now,
    updatedAt: now
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaWho2022ReferenceTitle(sourceEntries, knownEntries) {
  const migrationId = 'apa-who-2022-executive-summary-title-2026-10-21-v1';
  const incomingBibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaWho2022ReferenceCorrection?.migrationId === migrationId);
  const incomingReference = sourceEntries.find((entry) => entry?.id === 'apa-ref-audit-oms-2022'
    && entry.apaWho2022ReferenceCorrection?.migrationId === migrationId);
  if (!incomingBibliography || !incomingReference) return 0;
  const oldReference = incomingBibliography.apaWho2022ReferenceCorrection.previousReference;
  const newReference = incomingBibliography.apaWho2022ReferenceCorrection.correctedReference;
  const bibliography = knownEntries.get(incomingBibliography.id);
  const reference = knownEntries.get(incomingReference.id);
  if (!bibliography || !reference
    || bibliography.apaWho2022ReferenceCorrectionApplied === migrationId
    || reference.apaWho2022ReferenceCorrectionApplied === migrationId) return 0;
  const paragraphs = String(bibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const oldCount = paragraphs.filter((paragraph) => paragraph === oldReference).length;
  const newCount = paragraphs.filter((paragraph) => paragraph === newReference).length;
  if (oldCount !== 1 || newCount !== 0 || String(reference.content || '').trim() !== oldReference) return 0;

  const now = new Date().toISOString();
  const correctedBibliography = {
    ...bibliography,
    content: paragraphs.map((paragraph) => paragraph === oldReference ? newReference : paragraph).join('\n\n'),
    apaWho2022ReferenceCorrectionSnapshot: { migrationId, priorContent: bibliography.content, capturedAt: now },
    apaWho2022ReferenceCorrectionApplied: migrationId,
    sourceBundleRevision: incomingBibliography.dataRevision,
    updatedAt: now,
    localEditedAt: now
  };
  const correctedReference = {
    ...reference,
    content: newReference,
    apaReferenceRecord: incomingReference.apaReferenceRecord,
    apaWho2022ReferenceCorrectionSnapshot: { migrationId, priorContent: reference.content, capturedAt: now },
    apaWho2022ReferenceCorrectionApplied: migrationId,
    sourceBundleRevision: incomingReference.dataRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntriesAtomically([correctedBibliography, correctedReference]);
  knownEntries.set(correctedBibliography.id, correctedBibliography);
  knownEntries.set(correctedReference.id, correctedReference);
  return 2;
}

async function migrateApaBarkley2015ChapterReference(sourceEntries, knownEntries) {
  const migrationId = 'apa-barkley-2015-chapter-16-reference-2026-10-21-v1';
  const incomingBibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaBarkley2015ChapterCorrection?.migrationId === migrationId);
  const incomingReference = sourceEntries.find((entry) => entry?.id === 'apa-ref-0f598f8709153d65d2d9'
    && entry.apaBarkley2015ChapterCorrection?.migrationId === migrationId);
  if (!incomingBibliography || !incomingReference) return 0;
  const oldReference = incomingBibliography.apaBarkley2015ChapterCorrection.previousReference;
  const oldSourceText = incomingBibliography.apaBarkley2015ChapterCorrection.previousSourceText;
  const newReference = incomingBibliography.apaBarkley2015ChapterCorrection.correctedReference;
  const newSourceText = incomingBibliography.apaBarkley2015ChapterCorrection.correctedSourceText;
  const bibliography = knownEntries.get(incomingBibliography.id);
  const reference = knownEntries.get(incomingReference.id);
  if (!bibliography || !reference
    || bibliography.apaBarkley2015ChapterCorrectionApplied === migrationId
    || reference.apaBarkley2015ChapterCorrectionApplied === migrationId) return 0;
  const paragraphs = String(bibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.filter((paragraph) => paragraph === oldReference).length !== 1
    || paragraphs.includes(newReference)
    || String(reference.content || '').trim() !== oldSourceText) return 0;

  const now = new Date().toISOString();
  const correctedBibliography = {
    ...bibliography,
    content: paragraphs.map((paragraph) => paragraph === oldReference ? newReference : paragraph).join('\n\n'),
    apaBarkley2015ChapterCorrectionSnapshot: { migrationId, priorContent: bibliography.content, capturedAt: now },
    apaBarkley2015ChapterCorrectionApplied: migrationId,
    sourceBundleRevision: incomingBibliography.dataRevision,
    updatedAt: now,
    localEditedAt: now
  };
  const correctedReference = {
    ...reference,
    content: newSourceText,
    apaReferenceRecord: incomingReference.apaReferenceRecord,
    apaBarkley2015ChapterCorrectionSnapshot: { migrationId, priorContent: reference.content, capturedAt: now },
    apaBarkley2015ChapterCorrectionApplied: migrationId,
    sourceBundleRevision: incomingReference.dataRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntriesAtomically([correctedBibliography, correctedReference]);
  knownEntries.set(correctedBibliography.id, correctedBibliography);
  knownEntries.set(correctedReference.id, correctedReference);
  return 2;
}

async function migrateApaFactorsRiskRuntimeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-factors-risk-runtime-review-2026-10-21-v1';
  let updatedCount = 0;
  const replaceUnique = (value, replacements) => {
    let next = String(value || '');
    let changed = false;
    for (const replacement of replacements) {
      if (!replacement?.oldText || !replacement?.newText) continue;
      const oldCount = next.split(replacement.oldText).length - 1;
      const newCount = next.split(replacement.newText).length - 1;
      if (oldCount === 0 && newCount === 1) continue;
      if (oldCount !== 1 || newCount !== 0) return null;
      next = next.replace(replacement.oldText, replacement.newText);
      changed = true;
    }
    return { value: next, changed };
  };

  for (const incoming of sourceEntries) {
    const plan = incoming?.apaFactorsRiskRuntimeReview;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaFactorsRiskRuntimeReviewApplied === migrationId) continue;
    const contentResult = replaceUnique(existing.content, plan.contentReplacements || []);
    if (!contentResult) continue;

    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const nextBlocks = [];
      let valid = true;
      for (const block of existing.contentBlocks) {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') {
          nextBlocks.push(block);
          continue;
        }
        const result = replaceUnique(block.text, plan.blockReplacements || plan.contentReplacements || []);
        if (!result) { valid = false; break; }
        nextBlocks.push(result.changed ? { ...block, text: result.value } : block);
        blocksChanged ||= result.changed;
      }
      if (!valid) continue;
      const requiredTargets = (plan.blockReplacements || plan.contentReplacements || []).filter((replacement) => replacement?.newText);
      const paragraphs = nextBlocks.filter((block) => block?.type === 'paragraph').map((block) => block.text).join('\n\n');
      if (requiredTargets.some((replacement) => paragraphs.split(replacement.newText).length - 1 !== 1)) continue;
      contentBlocks = nextBlocks;
    }

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaFactorsRiskRuntimeReviewSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        capturedAt: now
      },
      apaFactorsRiskRuntimeReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaFactorsRiskHeadingReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-factors-risk-scope-barkley-review-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaFactorsRiskRuntimeHeadingReview?.migrationId === migrationId);
  if (!incoming) return 0;
  const plan = incoming.apaFactorsRiskRuntimeHeadingReview;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaFactorsRiskRuntimeHeadingReviewApplied === migrationId
    || existing.title !== plan.priorTitle
    || existing.customGuideNode?.label !== plan.priorGuideLabel
    || existing.contentBlocks?.[0]?.text !== plan.priorHeading) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    title: plan.title,
    contentBlocks: existing.contentBlocks.map((block, index) => index === 0 ? { ...block, text: plan.heading } : block),
    customGuideNode: { ...existing.customGuideNode, label: plan.guideLabel },
    apaFactorsRiskRuntimeHeadingReviewSnapshot: {
      migrationId,
      priorTitle: existing.title,
      priorHeading: existing.contentBlocks[0].text,
      priorGuideLabel: existing.customGuideNode.label,
      capturedAt: now
    },
    apaFactorsRiskRuntimeHeadingReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaClutterOverviewAcademicReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterOverviewAcademicReviewMigration;
    if (!plan?.migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaClutterOverviewAcademicReviewApplied === plan.migrationId
      || !existing.content || typeof globalThis.crypto?.subtle?.digest !== 'function') continue;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(existing.content));
    const priorHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (priorHash !== plan.priorContentSha256) continue;
    const figureIds = (existing.contentBlocks || []).filter((block) => block?.type === 'figure').map((block) => block.figureId);
    if (JSON.stringify(figureIds) !== JSON.stringify(plan.preservedFigureIds || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: incoming.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: incoming.apaAcademicContentReviewSnapshot,
      apaClutterOverviewAcademicReviewApplied: plan.migrationId,
      apaClutterOverviewAcademicReviewRuntimeSnapshot: {
        migrationId: plan.migrationId,
        priorContentSha256: priorHash,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaProblemStatementAcademicReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaProblemStatementAcademicReviewMigration;
    if (!plan?.migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaProblemStatementAcademicReviewApplied === plan.migrationId
      || !existing.content || typeof globalThis.crypto?.subtle?.digest !== 'function') continue;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(existing.content));
    const priorHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (priorHash !== plan.priorContentSha256) continue;
    const figureIds = (existing.contentBlocks || []).filter((block) => block?.type === 'figure').map((block) => block.figureId);
    if (JSON.stringify(figureIds) !== JSON.stringify(plan.preservedFigureIds || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: incoming.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: incoming.apaAcademicContentReviewSnapshot,
      apaProblemStatementAcademicReviewApplied: plan.migrationId,
      apaProblemStatementAcademicReviewRuntimeSnapshot: {
        migrationId: plan.migrationId,
        priorContentSha256: priorHash,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAcademicContentReviewMetadata(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    if (!review?.migrationId || incoming.contentReviewState !== 'reviewed') continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaAcademicContentReviewRuntimeApplied === review.migrationId
      || existing.content !== incoming.content) continue;
    const now = new Date().toISOString();
    const titleCorrection = review.titleCorrection;
    const applyTitleCorrection = titleCorrection && existing.title === titleCorrection.from
      && incoming.title === titleCorrection.to;
    const updated = {
      ...existing,
      ...(applyTitleCorrection ? { title: titleCorrection.to } : {}),
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: incoming.apaAcademicContentReviewSnapshot || existing.apaAcademicContentReviewSnapshot,
      apaAcademicContentReviewRuntimeSnapshot: {
        migrationId: review.migrationId,
        priorContentReviewState: existing.contentReviewState || null,
        ...(applyTitleCorrection ? { priorTitle: existing.title } : {}),
        capturedAt: now
      },
      apaAcademicContentReviewRuntimeApplied: review.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAcademicContentLabelReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaAcademicLabelRuntimeReview;
    if (!plan?.migrationId || incoming.apaAcademicContentReview?.migrationId !== plan.migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaAcademicContentLabelRuntimeApplied === plan.migrationId
      || existing.title !== plan.priorTitle
      || existing.customGuideNode?.label !== plan.priorGuideLabel
      || existing.contentBlocks?.[0]?.text !== plan.priorHeading
      || existing.content !== plan.priorContent) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      title: plan.title,
      content: plan.content,
      contentBlocks: existing.contentBlocks.map((block, index) => index === 0 ? { ...block, text: plan.heading } : block),
      customGuideNode: { ...existing.customGuideNode, label: plan.guideLabel },
      apaAcademicContentLabelRuntimeSnapshot: {
        migrationId: plan.migrationId,
        priorTitle: existing.title,
        priorContent: existing.content,
        priorHeading: existing.contentBlocks[0].text,
        priorGuideLabel: existing.customGuideNode.label,
        capturedAt: now
      },
      apaAcademicContentLabelRuntimeApplied: plan.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaUnifiedBibliographyReviewNote(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-review-note-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyMigrationId === 'apa-unified-bibliography-sort-2026-10-21-v1');
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const previousNote = 'Lista única de 141 referencias candidatas, ordenada alfabéticamente a partir de la información guardada en la PWA. El cotejo automático reúne 143 registros candidatos y detecta 134 textos bibliográficos únicos; conserva además 7 referencias candidatas de créditos de imágenes y 3 referencias detectadas en fichas que faltaban en la lista consolidada anterior. Los registros originales permanecen disponibles en sus fichas de origen. Hay citas sin correspondencia automática y variantes autor-año que requieren revisión; por eso esta lista es una consolidación de trabajo, no una bibliografía final aprobada.';
  if (!existing || existing.apaUnifiedBibliographyReviewNoteMigrationApplied === migrationId
    || existing.contentReviewNote !== previousNote) return 0;
  const updated = {
    ...existing,
    contentReviewNote: incoming.contentReviewNote,
    apaUnifiedBibliographyReviewNoteMigrationApplied: migrationId,
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyCanonicalDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-canonical-mayer-2021-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaUnifiedBibliographyDedupSnapshot;
  if (!existing || !snapshot || existing.apaUnifiedBibliographyDedupMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshotParagraphs = splitParagraphs(snapshot.content);
  const targetParagraphs = splitParagraphs(incoming.content);
  const obsoleteParagraphs = snapshotParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph));
  const canonicalParagraph = targetParagraphs.find((paragraph) => /Mayer, R\. E\. \(2021\)/.test(paragraph)
    && /10\.1017\/9781316941355/.test(paragraph));
  if (obsoleteParagraphs.length !== 1 || !canonicalParagraph || !existing.content.includes(canonicalParagraph)) return 0;
  const existingParagraphs = splitParagraphs(existing.content);
  if (!existingParagraphs.includes(obsoleteParagraphs[0])) return 0;
  const updatedContent = existingParagraphs.filter((paragraph, index) => !(paragraph === obsoleteParagraphs[0]
    && existingParagraphs.indexOf(paragraph) === index)).join('\n\n');
  const updated = {
    ...existing,
    content: updatedContent,
    ...(existing.contentReviewNote === snapshot.contentReviewNote ? { contentReviewNote: incoming.contentReviewNote } : {}),
    apaUnifiedBibliographyDedupMigrationApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyVerifiedDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-verified-dedup-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyVerifiedDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaUnifiedBibliographyVerifiedDedupMigrationSnapshot;
  if (!existing || !snapshot || existing.apaUnifiedBibliographyVerifiedDedupMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshotParagraphs = splitParagraphs(snapshot.content);
  const targetParagraphs = splitParagraphs(incoming.content);
  const obsoleteParagraphs = snapshotParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph));
  const requiredCanonicalParagraphs = Array.isArray(incoming.apaUnifiedBibliographyVerifiedDedupCanonicalParagraphs)
    ? incoming.apaUnifiedBibliographyVerifiedDedupCanonicalParagraphs : [];
  const missingCanonicals = requiredCanonicalParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph) || !existing.content.includes(paragraph));
  if (obsoleteParagraphs.length < 8 || obsoleteParagraphs.length > 9
    || requiredCanonicalParagraphs.length !== obsoleteParagraphs.length || missingCanonicals.length) return 0;
  const existingParagraphs = splitParagraphs(existing.content);
  const missingObsolete = obsoleteParagraphs.filter((paragraph) => !existingParagraphs.includes(paragraph));
  if (missingObsolete.length) return 0;
  const obsoleteSet = new Set(obsoleteParagraphs);
  const updated = {
    ...existing,
    content: existingParagraphs.filter((paragraph) => !obsoleteSet.has(paragraph)).join('\n\n'),
    ...(existing.contentReviewNote === snapshot.contentReviewNote ? { contentReviewNote: incoming.contentReviewNote } : {}),
    apaUnifiedBibliographyVerifiedDedupMigrationApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyReconcileList(sourceEntries, knownEntries) {
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyVerifiedDedupMigrationId
    === 'apa-unified-bibliography-verified-dedup-2026-10-21-v1');
  if (!incoming) return 0;
  const migrationId = incoming.apaUnifiedBibliographyReconcileListMigrationId || 'apa-unified-bibliography-reconcile-list-2026-10-21-v1';
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaUnifiedBibliographyReconcileListMigrationApplied === migrationId
    || existing.apaUnifiedBibliographyVerifiedDedupMigrationApplied !== incoming.apaUnifiedBibliographyVerifiedDedupMigrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const targetParagraphs = splitParagraphs(incoming.content);
  const existingParagraphs = splitParagraphs(existing.content);
  const expectedParagraphCount = migrationId.endsWith('-v3') ? 141 : (migrationId.endsWith('-v2') ? 142 : 141);
  if (targetParagraphs.length !== expectedParagraphCount) return 0;
  const targetSet = new Set(targetParagraphs);
  const additions = targetParagraphs.filter((paragraph) => !existingParagraphs.includes(paragraph));
  const combined = [...new Set([...existingParagraphs, ...targetParagraphs])];
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: false });
  combined.sort((a, b) => collator.compare(a, b));
  const updated = {
    ...existing,
    content: combined.join('\n\n'),
    apaUnifiedBibliographyReconcileListMigrationApplied: migrationId,
    apaUnifiedBibliographyReconcileListParagraphsAdded: additions.length,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyForcevilleDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-forceville-dedup-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyForcevilleDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaUnifiedBibliographyForcevilleDedupSnapshot;
  const canonical = incoming.apaUnifiedBibliographyForcevilleDedupCanonicalParagraph;
  if (!existing || !snapshot || !canonical || existing.apaUnifiedBibliographyForcevilleDedupMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshotParagraphs = splitParagraphs(snapshot.content);
  const targetParagraphs = splitParagraphs(incoming.content);
  const obsoleteParagraphs = snapshotParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph));
  if (obsoleteParagraphs.length !== 1 || !obsoleteParagraphs[0].startsWith('Forceville, C. (2008). Metaphor in pictures and multimodal representations.')
    || !targetParagraphs.includes(canonical) || !existing.content.includes(canonical)) return 0;
  const existingParagraphs = splitParagraphs(existing.content);
  if (existingParagraphs.includes(obsoleteParagraphs[0])) {
    const updated = {
      ...existing,
      content: existingParagraphs.filter((paragraph) => paragraph !== obsoleteParagraphs[0]).join('\n\n'),
      apaUnifiedBibliographyForcevilleDedupMigrationApplied: migrationId,
      localEditedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    return 1;
  }
  if (existingParagraphs.length !== targetParagraphs.length || !existingParagraphs.every((paragraph) => targetParagraphs.includes(paragraph))) return 0;
  const updated = { ...existing, apaUnifiedBibliographyForcevilleDedupMigrationApplied: migrationId, updatedAt: new Date().toISOString() };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyOpenAIDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-openai-descriptor-dedup-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyOpenAIDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaUnifiedBibliographyOpenAIDedupSnapshot;
  const canonical = incoming.apaUnifiedBibliographyOpenAIDedupCanonicalParagraph;
  if (!existing || !snapshot || !canonical || existing.apaUnifiedBibliographyOpenAIDedupMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshotParagraphs = splitParagraphs(snapshot.content);
  const targetParagraphs = splitParagraphs(incoming.content);
  const obsoleteParagraphs = snapshotParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph));
  if (obsoleteParagraphs.length !== 1
    || obsoleteParagraphs[0] !== 'OpenAI. (2026a). *ChatGPT* [Asistente de inteligencia artificial generativa]. https://chatgpt.com/'
    || canonical !== 'OpenAI. (2026a). *ChatGPT* [Large language model]. https://chatgpt.com/'
    || !targetParagraphs.includes(canonical) || !existing.content.includes(canonical)) return 0;
  const existingParagraphs = splitParagraphs(existing.content);
  if (existingParagraphs.includes(obsoleteParagraphs[0])) {
    const updated = {
      ...existing,
      content: existingParagraphs.filter((paragraph) => paragraph !== obsoleteParagraphs[0]).join('\n\n'),
      apaUnifiedBibliographyOpenAIDedupMigrationApplied: migrationId,
      localEditedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    return 1;
  }
  if (existingParagraphs.length !== targetParagraphs.length || !existingParagraphs.every((paragraph) => targetParagraphs.includes(paragraph))) return 0;
  const updated = { ...existing, apaUnifiedBibliographyOpenAIDedupMigrationApplied: migrationId, updatedAt: new Date().toISOString() };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyVerifiedVariantDedup(sourceEntries, knownEntries) {
  const migrations = [
    {
      id: 'apa-unified-bibliography-chion-2019-second-edition-dedup-2026-10-21-v1',
      field: 'apaUnifiedBibliographyChion2019DedupMigrationId',
      snapshotField: 'apaUnifiedBibliographyChion2019DedupSnapshot',
      canonicalField: 'apaUnifiedBibliographyChion2019DedupCanonicalParagraph',
      appliedField: 'apaUnifiedBibliographyChion2019DedupMigrationApplied',
      obsolete: 'Chion, M. (2019). Audio-vision: Sound on screen (Updated ed.). Columbia University Press.',
      canonical: 'Chion, M. (2019). *Audio-vision: Sound on screen* (C. Gorbman, Ed. & Trans.; 2nd ed.). Columbia University Press.'
    },
    {
      id: 'apa-unified-bibliography-chayka-2024-edition-dedup-2026-10-21-v1',
      field: 'apaUnifiedBibliographyChayka2024DedupMigrationId',
      snapshotField: 'apaUnifiedBibliographyChayka2024DedupSnapshot',
      canonicalField: 'apaUnifiedBibliographyChayka2024DedupCanonicalParagraph',
      appliedField: 'apaUnifiedBibliographyChayka2024DedupMigrationApplied',
      obsolete: 'Chayka, K. (2024). The longing for less: Living with minimalism. Bloomsbury Publishing.',
      canonical: 'Chayka, K. (2024). *The longing for less: What’s missing from minimalism*. Bloomsbury Publishing.'
    }
  ];
  let updatedCount = 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  for (const migration of migrations) {
    const incoming = sourceEntries.find((entry) => entry?.[migration.field] === migration.id);
    if (!incoming) continue;
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming[migration.snapshotField];
    const canonical = incoming[migration.canonicalField];
    if (!existing || !snapshot || canonical !== migration.canonical || existing[migration.appliedField] === migration.id) continue;
    const snapshotParagraphs = splitParagraphs(snapshot.content);
    const targetParagraphs = splitParagraphs(incoming.content);
    if (!snapshotParagraphs.includes(migration.obsolete) || targetParagraphs.includes(migration.obsolete)
      || !targetParagraphs.includes(canonical) || !existing.content.includes(canonical)) continue;
    const existingParagraphs = splitParagraphs(existing.content);
    if (existingParagraphs.includes(migration.obsolete)) {
      const updated = {
        ...existing,
        content: existingParagraphs.filter((paragraph) => paragraph !== migration.obsolete).join('\n\n'),
        [migration.appliedField]: migration.id,
        localEditedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putEntry(updated);
      knownEntries.set(incoming.id, updated);
      updatedCount += 1;
      continue;
    }
    if (existingParagraphs.length !== targetParagraphs.length || !existingParagraphs.every((paragraph) => targetParagraphs.includes(paragraph))) continue;
    const updated = { ...existing, [migration.appliedField]: migration.id, updatedAt: new Date().toISOString() };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaUnifiedBibliographyVerifiedMetadataDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-lee-kotler-pinsky-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyVerifiedMetadataDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaUnifiedBibliographyVerifiedMetadataDedupMigrationSnapshot;
  const requiredCanonicals = incoming.apaUnifiedBibliographyVerifiedMetadataDedupCanonicalParagraphs;
  if (!existing || !snapshot || !Array.isArray(requiredCanonicals)
    || existing.apaUnifiedBibliographyVerifiedMetadataDedupMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshotParagraphs = splitParagraphs(snapshot.content);
  const targetParagraphs = splitParagraphs(incoming.content);
  const obsoleteParagraphs = snapshotParagraphs.filter((paragraph) => !targetParagraphs.includes(paragraph));
  const existingParagraphs = splitParagraphs(existing.content);
  const missingObsolete = obsoleteParagraphs.filter((paragraph) => !existingParagraphs.includes(paragraph));
  if (obsoleteParagraphs.length !== 3 || missingObsolete.length
    || requiredCanonicals.length !== 2
    || requiredCanonicals.some((paragraph) => !targetParagraphs.includes(paragraph))) return 0;
  const updatedParagraphs = existingParagraphs.filter((paragraph) => !obsoleteParagraphs.includes(paragraph));
  for (const paragraph of requiredCanonicals) {
    if (!updatedParagraphs.includes(paragraph)) updatedParagraphs.push(paragraph);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: false });
  updatedParagraphs.sort((a, b) => collator.compare(a, b));
  const updated = {
    ...existing,
    content: updatedParagraphs.join('\n\n'),
    ...(existing.contentReviewNote === snapshot.contentReviewNote ? { contentReviewNote: incoming.contentReviewNote } : {}),
    apaUnifiedBibliographyVerifiedMetadataDedupMigrationApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyBecker2024DateDedup(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-becker-2024-date-dedup-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaUnifiedBibliographyBecker2024DateDedupMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaUnifiedBibliographyBecker2024DateDedupApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const normalizeReference = (paragraph) => String(paragraph || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en');
  const targetParagraphs = splitParagraphs(incoming.content);
  const existingParagraphs = splitParagraphs(existing.content);
  const obsoleteMatches = (paragraph) => {
    const normalized = normalizeReference(paragraph);
    return normalized.includes('becker, j. (s. f.). what is minimalism? becoming minimalist.')
      && normalized.endsWith('https://www.becomingminimalist.com/what-is-minimalism/');
  };
  const canonicalMatches = (paragraph) => {
    const normalized = normalizeReference(paragraph);
    return normalized.includes('becker, j. (2024, 13 de mayo). what is minimalism? becoming minimalist.')
      && normalized.endsWith('https://www.becomingminimalist.com/what-is-minimalism/');
  };
  if (targetParagraphs.some(obsoleteMatches) || !targetParagraphs.some(canonicalMatches)
    || !existingParagraphs.some(obsoleteMatches) || !existingParagraphs.some(canonicalMatches)) return 0;
  const updated = {
    ...existing,
    content: existingParagraphs.filter((paragraph) => !obsoleteMatches(paragraph)).join('\n\n'),
    apaUnifiedBibliographyBecker2024DateDedupApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyBecker2018EditorVariant(sourceEntries, knownEntries) {
  const migrationId = 'apa-becker-2018-remove-false-editor-variant-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.becker2018ApaReconciliationMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.becker2018ApaReconciliationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const normalizeReference = (paragraph) => String(paragraph || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en');
  const obsolete = 'Becker, J. (2018). *The minimalist home: A room-by-room guide to a decluttered, refocused life* (E. Stanford, Ed.). WaterBrook.';
  const canonical = 'Becker, J. (2018). *The minimalist home: A room-by-room guide to a decluttered, refocused life*. WaterBrook.';
  const obsoleteKey = normalizeReference(obsolete);
  const canonicalKey = normalizeReference(canonical);
  const targetParagraphs = splitParagraphs(incoming.content);
  const existingParagraphs = splitParagraphs(existing.content);
  const count = (items, key) => items.filter((paragraph) => normalizeReference(paragraph) === key).length;
  if (count(targetParagraphs, obsoleteKey) !== 0 || count(targetParagraphs, canonicalKey) !== 1
    || count(existingParagraphs, obsoleteKey) !== 1 || count(existingParagraphs, canonicalKey) !== 1) return 0;
  const updated = {
    ...existing,
    content: existingParagraphs.filter((paragraph) => normalizeReference(paragraph) !== obsoleteKey).join('\n\n'),
    becker2018ApaReconciliationApplied: migrationId,
    becker2018ApaReconciliationSnapshot: incoming.becker2018ApaReconciliationSnapshot,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaBeckerOrganizationAlphabeticalOrder(sourceEntries, knownEntries) {
  const migrationId = 'apa-becker-organization-alpha-order-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaBeckerAlphabeticalOrderMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaBeckerAlphabeticalOrderMigrationApplied === migrationId) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const expectedBefore = 'Becker Method. (s. f.). *Becker Method: Transforming spaces, enriching lives*. https://beckermethodcertified.com/';
  const expectedAfter = 'Becker, J. (2016). The more of less: Finding the life you want under everything you own. WaterBrook Press.';
  const targetParagraphs = splitParagraphs(incoming.content);
  const existingParagraphs = splitParagraphs(existing.content);
  if (targetParagraphs.indexOf(expectedAfter) < 0 || targetParagraphs.indexOf(expectedBefore) < 0
    || targetParagraphs.indexOf(expectedAfter) > targetParagraphs.indexOf(expectedBefore)) return 0;
  const beforeIndex = existingParagraphs.indexOf(expectedBefore);
  const afterIndex = existingParagraphs.indexOf(expectedAfter);
  if (beforeIndex < 0 || afterIndex < 0 || afterIndex < beforeIndex) return 0;
  const keep = existingParagraphs.filter((paragraph) => paragraph !== expectedBefore && paragraph !== expectedAfter);
  keep.splice(beforeIndex, 0, expectedAfter, expectedBefore);
  const updated = {
    ...existing,
    content: keep.join('\n\n'),
    apaBeckerAlphabeticalOrderMigrationApplied: migrationId,
    apaBeckerAlphabeticalOrderMigrationSnapshot: incoming.apaBeckerAlphabeticalOrderMigrationSnapshot,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaBeckerFamilyOrder(sourceEntries, knownEntries) {
  const migrationId = 'apa-becker-family-contiguous-order-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaBeckerFamilyOrderMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const personalReferences = [
    'Becker, J. (2016). The more of less: Finding the life you want under everything you own. WaterBrook Press.',
    'Becker, J. (2018). *The minimalist home: A room-by-room guide to a decluttered, refocused life*. WaterBrook.',
    'Becker, J. (2022). Things that matter: Overcoming distraction to pursue a more meaningful life. WaterBrook.',
    'Becker, J. (2024, 13 de mayo). *What is minimalism?* Becoming Minimalist. https://www.becomingminimalist.com/what-is-minimalism/',
    'Becker, J. (s. f.). *Media kit*. Becoming Minimalist. https://www.becomingminimalist.com/media-kit/'
  ];
  const organization = 'Becker Method. (s. f.). *Becker Method: Transforming spaces, enriching lives*. https://beckermethodcertified.com/';
  const orderedReferences = [...personalReferences, organization];
  const target = splitParagraphs(incoming.content);
  const current = splitParagraphs(existing.content);
  const containsExactlyOnce = (items) => orderedReferences.every((paragraph) => items.filter((item) => item === paragraph).length === 1);
  if (!containsExactlyOnce(target) || !containsExactlyOnce(current)) return 0;
  const currentPositions = orderedReferences.map((paragraph) => current.indexOf(paragraph));
  if (existing.apaBeckerFamilyOrderMigrationApplied === migrationId
    && currentPositions.every((position, index) => index === 0 || position === currentPositions[index - 1] + 1)) return 0;
  const start = Math.min(...currentPositions);
  const updatedParagraphs = current.filter((paragraph) => !orderedReferences.includes(paragraph));
  updatedParagraphs.splice(Math.min(start, updatedParagraphs.length), 0, ...orderedReferences);
  const updated = {
    ...existing,
    content: updatedParagraphs.join('\n\n'),
    apaBeckerFamilyOrderMigrationApplied: migrationId,
    apaBeckerFamilyOrderMigrationSnapshot: incoming.apaBeckerFamilyOrderMigrationSnapshot,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyAlphabeticalAudit(sourceEntries, knownEntries) {
  const incoming = sourceEntries.find((entry) => entry?.apaReferenceAlphabeticalAuditMigrationId
    === 'apa-reference-alphabetical-audit-2026-10-21-v1');
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const groups = incoming.apaReferenceAlphabeticalAuditGroups;
  if (!existing || !Array.isArray(groups) || existing.apaReferenceAlphabeticalAuditMigrationApplied
    === incoming.apaReferenceAlphabeticalAuditMigrationId) return 0;

  const paragraphs = String(existing.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim());
  const snapshots = [];
  let changed = false;
  for (const group of groups) {
    const before = group.paragraphs;
    const order = group.correctOrder;
    if (!Array.isArray(before) || !Array.isArray(order) || before.length !== order.length
      || new Set(before).size !== before.length || new Set(order).size !== order.length
      || before.some((paragraph) => !order.includes(paragraph))) continue;
    const positions = before.map((paragraph) => paragraphs.indexOf(paragraph));
    if (positions.some((position) => position < 0)
      || positions.some((position, index) => paragraphs.lastIndexOf(before[index]) !== position)) continue;
    const start = Math.min(...positions);
    const end = Math.max(...positions);
    if (end - start + 1 !== before.length) continue;
    const current = paragraphs.slice(start, end + 1);
    if (current.some((paragraph) => !before.includes(paragraph))) continue;
    snapshots.push({ id: group.id, priorOrder: current, correctedOrder: order });
    if (current.every((paragraph, index) => paragraph === order[index])) continue;
    paragraphs.splice(start, current.length, ...order);
    changed = true;
  }
  if (!snapshots.length) return 0;
  const noteSnapshot = incoming.apaReferenceAlphabeticalAuditSnapshot?.contentReviewNote;
  const updated = {
    ...existing,
    content: paragraphs.join('\n\n'),
    ...(noteSnapshot && existing.contentReviewNote === noteSnapshot
      ? { contentReviewNote: incoming.contentReviewNote }
      : {}),
    apaReferenceAlphabeticalAuditMigrationSnapshot: {
      groups: snapshots,
      contentReviewNote: existing.contentReviewNote || null,
      capturedAt: new Date().toISOString()
    },
    apaReferenceAlphabeticalAuditMigrationApplied: incoming.apaReferenceAlphabeticalAuditMigrationId,
    updatedAt: new Date().toISOString(),
    ...(changed ? { localEditedAt: new Date().toISOString() } : {})
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return changed || existing.apaReferenceAlphabeticalAuditMigrationApplied !== incoming.apaReferenceAlphabeticalAuditMigrationId ? 1 : 0;
}

async function migrateApaReferenceListOrderCorrection(sourceEntries, knownEntries) {
  const incoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaReferenceOrderCorrectionMigrationId === 'apa-reference-list-order-correction-2026-10-21-v2');
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const groups = incoming.apaReferenceOrderCorrectionGroups;
  if (!existing || !Array.isArray(groups)
    || existing.apaReferenceOrderCorrectionMigrationApplied === incoming.apaReferenceOrderCorrectionMigrationId) return 0;

  const paragraphs = String(existing.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snapshots = [];
  let changed = false;
  for (const group of groups) {
    const before = group.priorOrder;
    const order = group.correctOrder;
    if (!Array.isArray(before) || !Array.isArray(order) || before.length !== order.length
      || new Set(before).size !== before.length || new Set(order).size !== order.length
      || before.some((paragraph) => !order.includes(paragraph))) continue;
    const positions = before.map((paragraph) => paragraphs.indexOf(paragraph));
    if (positions.some((position) => position < 0)
      || positions.some((position, index) => paragraphs.lastIndexOf(before[index]) !== position)) continue;
    const start = Math.min(...positions);
    const end = Math.max(...positions);
    if (end - start + 1 !== before.length) continue;
    const current = paragraphs.slice(start, end + 1);
    if (current.some((paragraph) => !before.includes(paragraph))) continue;
    snapshots.push({ id: group.id, priorOrder: current, correctedOrder: order });
    if (current.every((paragraph, index) => paragraph === order[index])) continue;
    paragraphs.splice(start, current.length, ...order);
    changed = true;
  }
  if (!snapshots.length) return 0;

  const updated = {
    ...existing,
    content: paragraphs.join('\n\n'),
    ...(existing.contentReviewNote === incoming.apaReferenceOrderCorrectionSnapshot?.previousContentReviewNote
      ? { contentReviewNote: incoming.contentReviewNote }
      : {}),
    apaReferenceOrderCorrectionMigrationSnapshot: {
      migrationId: incoming.apaReferenceOrderCorrectionMigrationId,
      priorGroups: snapshots,
      conflictsSkipped: groups.filter((group) => !snapshots.some((snapshot) => snapshot.id === group.id)).map((group) => group.id),
      capturedAt: new Date().toISOString()
    },
    apaReferenceOrderCorrectionMigrationApplied: incoming.apaReferenceOrderCorrectionMigrationId,
    sourceBundleRevision: incoming.dataRevision,
    updatedAt: new Date().toISOString(),
    ...(changed ? { localEditedAt: new Date().toISOString() } : {})
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaUnifiedBibliographyRuntimeReconciliation(sourceEntries, knownEntries) {
  const migrationId = 'apa-unified-bibliography-runtime-reconciliation-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaReferenceListRuntimeReconciliation?.migrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const plan = incoming.apaReferenceListRuntimeReconciliation;
  if (!existing || !Array.isArray(plan.expectedMissing) || !Array.isArray(plan.expectedExtra)
    || existing.apaReferenceListRuntimeReconciliationApplied === migrationId) return 0;

  const normalize = (value) => String(value || '').replace(/\*/g, '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('es');
  const split = (value) => String(value || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const current = split(existing.content);
  const target = split(incoming.content);
  const currentNormalized = current.map(normalize);
  const targetNormalized = target.map(normalize);
  if (!current.length || !target.length || new Set(currentNormalized).size !== currentNormalized.length
    || new Set(targetNormalized).size !== targetNormalized.length) return 0;

  const missing = target.filter((paragraph, index) => !currentNormalized.includes(targetNormalized[index]));
  const extra = current.filter((paragraph, index) => !targetNormalized.includes(currentNormalized[index]));
  const sameSet = (actual, expected) => actual.length === expected.length
    && actual.map(normalize).sort().every((value, index) => value === expected.map(normalize).sort()[index]);
  if (!sameSet(missing, plan.expectedMissing) || !sameSet(extra, plan.expectedExtra)) return 0;

  const priorNotice = plan.previousContentReviewNote;
  const updated = {
    ...existing,
    content: incoming.content,
    ...(existing.contentReviewNote === priorNotice ? { contentReviewNote: incoming.contentReviewNote } : {}),
    apaReferenceListRuntimeReconciliationSnapshot: {
      migrationId,
      priorContent: existing.content,
      priorContentReviewNote: existing.contentReviewNote || null,
      missingRowsRestored: missing,
      staleRowsRemovedFromActiveList: extra,
      preservedSourceEvidence: plan.preservedSourceEvidence,
      capturedAt: new Date().toISOString()
    },
    apaReferenceListRuntimeReconciliationApplied: migrationId,
    sourceBundleRevision: incoming.dataRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaIcdSourceReconciliation(sourceEntries, knownEntries) {
  const migrationId = 'apa-icd-source-reconciliation-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    if (!incoming || incoming.apaIcdCitationCorrectionMigration !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaIcdCitationCorrectionApplied === migrationId) continue;
    const snapshot = incoming.apaIcdCitationCorrectionSnapshot;
    if (snapshot && existing.content !== snapshot.priorContent) continue;
    if (snapshot?.priorContentBlocks
      && JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks)) continue;

    const updated = {
      ...existing,
      ...(snapshot ? {
        content: incoming.content,
        ...(snapshot.priorContentReviewNote ? { contentReviewNote: incoming.contentReviewNote } : {}),
        ...(Array.isArray(incoming.contentBlocks) ? { contentBlocks: incoming.contentBlocks } : {}),
        apaIcdCitationCorrectionSnapshot: {
          migrationId,
          priorContent: existing.content,
          priorContentReviewNote: existing.contentReviewNote || null,
          priorContentBlocks: existing.contentBlocks || null,
          changedAt: new Date().toISOString()
        },
        apaIcdCitationCorrectionApplied: migrationId
      } : {}),
      ...(incoming.apaReferenceRecord?.bibliographyDisposition === 'excluded-unverified-source' ? {
        apaReferenceRecord: {
          ...existing.apaReferenceRecord,
          bibliographyDisposition: 'excluded-unverified-source',
          dispositionReason: incoming.apaReferenceRecord.dispositionReason
        },
        apaCitationAuditExclusion: incoming.apaCitationAuditExclusion
      } : {}),
      ...(typeof incoming.apaReferenceRecord?.authorAbbreviation === 'string' ? {
        apaReferenceRecord: {
          ...existing.apaReferenceRecord,
          authorAbbreviation: incoming.apaReferenceRecord.authorAbbreviation
        }
      } : {}),
      sourceBundleRevision: incoming.dataRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaIcdExcludedSourceDisposition(sourceEntries, knownEntries) {
  const migrationId = 'apa-icd-excluded-source-runtime-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    if (incoming?.apaIcdExcludedSourceRuntimeMigrationId !== migrationId) continue;
    const exclusion = incoming.apaCitationAuditExclusion;
    const sourceText = exclusion?.sourceTextPreserved;
    const existing = knownEntries.get(incoming.id);
    const currentRecord = existing?.apaReferenceRecord;
    const targetRecord = incoming.apaReferenceRecord;
    if (!existing || exclusion?.status !== 'excluded-unverified-source'
      || !sourceText || sourceText !== targetRecord?.sourceText
      || currentRecord?.sourceText !== sourceText
      || existing.apaIcdExcludedSourceRuntimeMigrationApplied === migrationId) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      apaReferenceRecord: {
        ...currentRecord,
        bibliographyDisposition: 'excluded-unverified-source',
        dispositionReason: targetRecord.dispositionReason
      },
      apaCitationAuditExclusion: exclusion,
      apaIcdExcludedSourceRuntimeMigrationSnapshot: {
        migrationId,
        previousReferenceRecord: currentRecord,
        previousExclusion: existing.apaCitationAuditExclusion || null,
        sourceTextPreserved: existing.content === sourceText,
        capturedAt: now
      },
      apaIcdExcludedSourceRuntimeMigrationApplied: migrationId,
      localEditedAt: now,
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaReferencePresentationAndNoDateDisambiguation(sourceEntries, knownEntries) {
  const migrationId = 'apa-reference-presentation-and-no-date-disambiguation-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaReferencePresentationMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaReferencePresentationMigrationApplied === migrationId) continue;
    let content = String(existing.content || '');
    let contentChanged = false;
    const appliedTextReplacements = [];
    for (const replacement of plan.replacements || []) {
      if (!replacement?.oldText || !replacement?.newText) continue;
      if (content.includes(replacement.newText)) continue;
      if (!content.includes(replacement.oldText)) continue;
      content = content.split(replacement.oldText).join(replacement.newText);
      contentChanged = true;
      appliedTextReplacements.push(replacement.oldText);
    }
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(contentBlocks) && Array.isArray(incoming.contentBlocks)) {
      contentBlocks = contentBlocks.map((block, index) => {
        if (block.type !== 'paragraph' || typeof block.text !== 'string') return block;
        let text = block.text;
        for (const replacement of plan.replacements || []) {
          if (replacement?.oldText && replacement?.newText && text.includes(replacement.oldText)) {
            text = text.split(replacement.oldText).join(replacement.newText);
          }
        }
        if (text === block.text) return block;
        blocksChanged = true;
        return { ...block, text };
      });
    }
    const oldSourceText = plan.expectedPriorReferenceSourceText;
    const incomingRecord = incoming.apaReferenceRecord;
    const existingRecord = existing.apaReferenceRecord;
    const canUpdateReferenceRecord = incomingRecord && existingRecord
      && (existingRecord.sourceText === oldSourceText || existingRecord.sourceText === incomingRecord.sourceText);
    const canUpdateTitle = typeof plan.expectedPriorTitle === 'string'
      && (existing.title === plan.expectedPriorTitle || existing.title === incoming.title);
    const recordChanged = Boolean(canUpdateReferenceRecord && existingRecord.sourceText !== incomingRecord.sourceText);
    const titleChanged = Boolean(canUpdateTitle && existing.title !== incoming.title);
    const priorExcludedLines = existing.apaExcludedReferenceLines || [];
    const excludedAdditions = (plan.excludeReferenceLines || []).filter((line) => line && !priorExcludedLines.includes(line));
    const excludedLinesChanged = excludedAdditions.length > 0;
    const alreadyApplied = existing.apaReferencePresentationMigrationApplied === migrationId;
    if (!contentChanged && !blocksChanged && !recordChanged && !titleChanged && !excludedLinesChanged && alreadyApplied) continue;
    const updated = {
      ...existing,
      ...(contentChanged ? { content } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      ...(recordChanged ? { apaReferenceRecord: incomingRecord } : {}),
      ...(titleChanged ? { title: incoming.title } : {}),
      ...(excludedLinesChanged ? { apaExcludedReferenceLines: [...priorExcludedLines, ...excludedAdditions] } : {}),
      apaReferencePresentationMigrationSnapshot: {
        migrationId,
        priorContent: contentChanged ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        priorApaReferenceRecord: recordChanged ? existingRecord : null,
        priorTitle: titleChanged ? existing.title : null,
        priorExcludedReferenceLines: excludedLinesChanged ? priorExcludedLines : null,
        appliedTextReplacements,
        capturedAt: new Date().toISOString()
      },
      apaReferencePresentationMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      ...((contentChanged || blocksChanged || recordChanged || titleChanged || excludedLinesChanged)
        ? { localEditedAt: new Date().toISOString() } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaInstitutionalEvidenceReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-institutional-evidence-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaInstitutionalEvidenceReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaInstitutionalEvidenceReviewMigrationApplied === migrationId) continue;

    const replacements = Array.isArray(plan.replacements) ? plan.replacements : [];
    const replaceUnique = (value) => {
      let next = String(value || '');
      let changed = false;
      for (const replacement of replacements) {
        if (!replacement?.oldText || !replacement?.newText) continue;
        const oldCount = next.split(replacement.oldText).length - 1;
        const newCount = next.split(replacement.newText).length - 1;
        if (newCount === 1 && oldCount === 0) continue;
        if (oldCount === 0) continue;
        if (oldCount !== 1 || newCount !== 0) return null;
        next = next.replace(replacement.oldText, replacement.newText);
        changed = true;
      }
      return { value: next, changed };
    };

    const contentResult = replaceUnique(existing.content);
    if (!contentResult) continue;
    if (replacements.some((replacement) => contentResult.value.split(replacement.newText).length - 1 !== 1)) continue;
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks) && Array.isArray(incoming.contentBlocks)) {
      const nextBlocks = [];
      let valid = true;
      for (const block of existing.contentBlocks) {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') {
          nextBlocks.push(block);
          continue;
        }
        const result = replaceUnique(block.text);
        if (!result) { valid = false; break; }
        nextBlocks.push(result.changed ? { ...block, text: result.value } : block);
        blocksChanged ||= result.changed;
      }
      if (!valid) continue;
      contentBlocks = nextBlocks;
    }

    const recordPlan = plan.referenceRecord;
    const currentRecord = existing.apaReferenceRecord;
    let apaReferenceRecord = currentRecord;
    if (recordPlan && currentRecord) {
      if (currentRecord.sourceText !== recordPlan.expectedSourceText
        && currentRecord.sourceText !== recordPlan.nextSourceText) continue;
      apaReferenceRecord = {
        ...currentRecord,
        ...recordPlan.nextRecord,
        sourceText: recordPlan.nextSourceText
      };
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      ...(apaReferenceRecord !== currentRecord ? { apaReferenceRecord } : {}),
      apaInstitutionalEvidenceReviewMigrationSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        priorApaReferenceRecord: apaReferenceRecord !== currentRecord ? currentRecord : null,
        replacements: replacements.filter((replacement) => existing.content?.includes(replacement.oldText)),
        capturedAt: now
      },
      apaInstitutionalEvidenceReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.dataRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged || apaReferenceRecord !== currentRecord)
        ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGuatemalaContextReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-guatemala-context-claims-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGuatemalaContextReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaGuatemalaContextReviewMigrationApplied === migrationId) continue;
    const replacements = Array.isArray(plan.replacements) ? plan.replacements : [];
    const replaceUnique = (value) => {
      let next = String(value || '');
      let changed = false;
      for (const { oldText, newText } of replacements) {
        const oldCount = next.split(oldText).length - 1;
        const newCount = next.split(newText).length - 1;
        if (oldCount === 0 && newCount <= 1) continue;
        if (oldCount !== 1 || newCount !== 0) return null;
        next = next.replace(oldText, newText);
        changed = true;
      }
      return { value: next, changed };
    };
    const contentResult = replaceUnique(existing.content);
    if (!contentResult || replacements.some(({ newText }) => contentResult.value.split(newText).length - 1 !== 1)) continue;
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const nextBlocks = [];
      let valid = true;
      for (const block of existing.contentBlocks) {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') { nextBlocks.push(block); continue; }
        let nextText = block.text;
        let blockChanged = false;
        for (const { oldText, newText } of replacements) {
          const oldCount = nextText.split(oldText).length - 1;
          const newCount = nextText.split(newText).length - 1;
          if (oldCount === 0 && newCount <= 1) continue;
          if (oldCount !== 1 || newCount !== 0) { valid = false; break; }
          nextText = nextText.replace(oldText, newText);
          blockChanged = true;
        }
        if (!valid) break;
        nextBlocks.push(blockChanged ? { ...block, text: nextText } : block);
        blocksChanged ||= blockChanged;
      }
      if (!valid) continue;
      if (replacements.some(({ newText }) => nextBlocks.reduce((count, block) =>
        count + (block?.type === 'paragraph' && typeof block.text === 'string' ? block.text.split(newText).length - 1 : 0), 0) !== 1)) continue;
      contentBlocks = nextBlocks;
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaGuatemalaContextReviewMigrationSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        replacements: replacements.filter(({ oldText }) => existing.content?.includes(oldText)),
        capturedAt: now
      },
      apaGuatemalaContextReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.dataRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGuatemalaMspasSourceReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGuatemalaMspasRuntimeReviewPlan;
    if (!plan?.migrationId || !plan.oldParagraph || !plan.newParagraph) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaGuatemalaMspasSourceReviewRuntimeApplied === plan.migrationId
      || existing.content !== plan.priorContent
      || existing.contentBlocks?.filter((block) => block?.type === 'figure' && block.figureId === plan.figureId).length !== 1) continue;
    const occurrences = (value, needle) => String(value || '').split(needle).length - 1;
    if (occurrences(existing.content, plan.oldParagraph) !== 1) continue;
    let blockMatches = 0;
    const contentBlocks = existing.contentBlocks.map((block) => {
      if (block?.type !== 'paragraph' || typeof block.text !== 'string') return block;
      const hits = occurrences(block.text, plan.oldParagraph);
      if (!hits) return block;
      blockMatches += hits;
      return { ...block, text: block.text.replace(plan.oldParagraph, plan.newParagraph) };
    });
    if (blockMatches !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: existing.content.replace(plan.oldParagraph, plan.newParagraph),
      contentBlocks,
      contentReviewState: incoming.contentReviewState === 'reviewed' ? 'reviewed' : existing.contentReviewState,
      apaAcademicContentReview: incoming.apaAcademicContentReview || existing.apaAcademicContentReview,
      apaAcademicContentReviewRuntimeSnapshot: {
        migrationId: plan.migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaGuatemalaMspasSourceReview: incoming.apaGuatemalaMspasSourceReview,
      apaGuatemalaMspasSourceReviewSnapshot: incoming.apaGuatemalaMspasSourceReviewSnapshot,
      apaGuatemalaMspasSourceReviewRuntimeApplied: plan.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;

    const bibliography = knownEntries.get(plan.bibliographyEntryId);
    const referenceText = String(plan.referenceText || '').trim();
    if (bibliography && referenceText && !String(bibliography.content || '').includes(referenceText)) {
      const paragraphs = String(bibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
      const insertionIndex = paragraphs.findIndex((paragraph) => paragraph.startsWith('Marcotte, E.'));
      if (insertionIndex >= 0) {
        const bibliographyNow = new Date().toISOString();
        const updatedBibliography = {
          ...bibliography,
          content: [...paragraphs.slice(0, insertionIndex), referenceText, ...paragraphs.slice(insertionIndex)].join('\n\n'),
          apaGuatemalaMspasBibliographyRuntimeSnapshot: {
            migrationId: plan.migrationId,
            priorContent: bibliography.content,
            capturedAt: bibliographyNow
          },
          apaGuatemalaMspasBibliographyRuntimeApplied: plan.migrationId,
          sourceBundleRevision: incoming.sourceBundleRevision || bibliography.sourceBundleRevision,
          updatedAt: bibliographyNow,
          localEditedAt: bibliographyNow
        };
        await putEntry(updatedBibliography);
        knownEntries.set(updatedBibliography.id, updatedBibliography);
        updatedCount += 1;
      }
    }
  }
  return updatedCount;
}

async function migrateApaEffectsOverviewReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaEffectsOverviewRuntimeReviewPlan;
    if (!plan?.migrationId || !plan.priorContent || !plan.content) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaEffectsOverviewReviewRuntimeApplied === plan.migrationId
      || existing.content !== plan.priorContent
      || existing.contentBlocks?.filter((block) => block?.type === 'figure' && block.figureId === plan.figureId).length !== 1) continue;
    const priorParagraphs = plan.priorContent.split(/\r?\n\s*\r?\n/);
    const nextParagraphs = plan.content.split(/\r?\n\s*\r?\n/);
    if (priorParagraphs.length !== nextParagraphs.length) continue;
    const replacements = priorParagraphs.flatMap((text, index) => text === nextParagraphs[index]
      ? [] : [{ oldText: text, newText: nextParagraphs[index] }]);
    if (replacements.length !== 1) continue;
    const replacement = replacements[0];
    let blockMatches = 0;
    const contentBlocks = existing.contentBlocks.map((block) => {
      if (block?.type !== 'paragraph' || block.text !== replacement.oldText) return block;
      blockMatches += 1;
      return { ...block, text: replacement.newText };
    });
    if (blockMatches !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: plan.content,
      contentBlocks,
      contentReviewState: incoming.contentReviewState === 'reviewed' ? 'reviewed' : existing.contentReviewState,
      apaAcademicContentReview: incoming.apaAcademicContentReview || existing.apaAcademicContentReview,
      apaEffectsOverviewReview: incoming.apaEffectsOverviewReview,
      apaEffectsOverviewReviewRuntimeSnapshot: {
        migrationId: plan.migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaEffectsOverviewReviewRuntimeApplied: plan.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaRosterSecondaryCitationReview(sourceEntries, knownEntries) {
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaRosterSecondaryCitationRuntimePlan;
    if (!plan?.migrationId || !plan.oldText || !plan.newText || !plan.priorContent) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaRosterSecondaryCitationRuntimeApplied === plan.migrationId
      || existing.content !== plan.priorContent) continue;
    const occurrences = (value) => String(value || '').split(plan.oldText).length - 1;
    if (occurrences(existing.content) !== 1) continue;
    let blockMatches = 0;
    const contentBlocks = existing.contentBlocks.map((block) => {
      if (block?.type !== 'paragraph' || typeof block.text !== 'string') return block;
      const hits = occurrences(block.text);
      if (!hits) return block;
      blockMatches += hits;
      return { ...block, text: block.text.replace(plan.oldText, plan.newText) };
    });
    if (blockMatches !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: existing.content.replace(plan.oldText, plan.newText),
      contentBlocks,
      contentReviewState: incoming.contentReviewState === 'reviewed' ? 'reviewed' : existing.contentReviewState,
      apaAcademicContentReview: incoming.apaAcademicContentReview || existing.apaAcademicContentReview,
      apaEffectsOverviewReview: incoming.apaEffectsOverviewReview || existing.apaEffectsOverviewReview,
      apaRosterSecondaryCitationReview: incoming.apaRosterSecondaryCitationReview,
      apaRosterSecondaryCitationSnapshot: incoming.apaRosterSecondaryCitationSnapshot,
      apaRosterSecondaryCitationRuntimeApplied: plan.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGuatemalaCitationYears(sourceEntries, knownEntries) {
  const migrationId = 'apa-guatemala-ine-2024ab-citations-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGuatemalaCitationYearMigration;
    const existing = knownEntries.get(incoming?.id);
    if (!plan || plan.migrationId !== migrationId || !existing
      || existing.apaGuatemalaCitationYearMigrationApplied === migrationId) continue;
    const applyReplacements = (value) => {
      let next = String(value || '');
      let changed = false;
      for (const { oldText, newText } of plan.replacements || []) {
        const oldCount = next.split(oldText).length - 1;
        const newCount = next.split(newText).length - 1;
        if (oldCount === 0 && newCount <= 1) continue;
        if (oldCount !== 1 || newCount !== 0) return null;
        next = next.replace(oldText, newText);
        changed = true;
      }
      return { value: next, changed };
    };
    const contentResult = applyReplacements(existing.content);
    if (!contentResult) continue;
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      let valid = true;
      contentBlocks = existing.contentBlocks.map((block) => {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') return block;
        const result = applyReplacements(block.text);
        if (!result) { valid = false; return block; }
        blocksChanged ||= result.changed;
        return result.changed ? { ...block, text: result.value } : block;
      });
      if (!valid) continue;
      const paragraphText = contentBlocks.filter((block) => block?.type === 'paragraph').map((block) => block.text).join('\n');
      if ((plan.replacements || []).some(({ newText }) => paragraphText.split(newText).length !== 2)) continue;
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaGuatemalaCitationYearMigrationSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        replacements: plan.replacements || [],
        capturedAt: now
      },
      apaGuatemalaCitationYearMigrationApplied: migrationId,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGuatemalaHousingScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-guatemala-housing-scope-review-2026-10-21-v2-ine-apa-2024ab';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGuatemalaHousingScopeReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaGuatemalaHousingScopeReviewMigrationApplied === migrationId) continue;
    const replacements = Array.isArray(plan.replacements) ? plan.replacements : [];
    const applyReplacements = (value) => {
      let next = String(value || '');
      let changed = false;
      for (const { oldText, newText } of replacements) {
        const oldCount = next.split(oldText).length - 1;
        const newCount = next.split(newText).length - 1;
        if (oldCount === 0 && newCount === 0) continue;
        if (oldCount === 0 && newCount === 1) continue;
        if (oldCount !== 1 || newCount !== 0) return null;
        next = next.replace(oldText, newText);
        changed = true;
      }
      return { value: next, changed };
    };
    const contentResult = applyReplacements(existing.content);
    if (!contentResult || replacements.some(({ newText }) => contentResult.value.split(newText).length - 1 !== 1)) continue;
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const nextBlocks = [];
      let valid = true;
      for (const block of existing.contentBlocks) {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') { nextBlocks.push(block); continue; }
        const result = applyReplacements(block.text);
        if (!result) { valid = false; break; }
        nextBlocks.push(result.changed ? { ...block, text: result.value } : block);
        blocksChanged ||= result.changed;
      }
      if (!valid || replacements.some(({ newText }) => nextBlocks.reduce((count, block) =>
        count + (block?.type === 'paragraph' && typeof block.text === 'string' ? block.text.split(newText).length - 1 : 0), 0) !== 1)) continue;
      contentBlocks = nextBlocks;
    }
    const bibliography = knownEntries.get(plan.unifiedBibliographyEntryId);
    if (!bibliography) continue;
    const bibliographyResult = applyReplacementsToText(bibliography.content, plan.bibliographyReplacements || []);
    if (!bibliographyResult) continue;
    const bibliographyReviewNoteResult = applyReplacementsToText(
      bibliography.contentReviewNote,
      plan.bibliographyReviewNoteReplacements || []
    );
    if (!bibliographyReviewNoteResult) continue;
    const sourceReference = knownEntries.get(plan.existingReferenceEntryId);
    if (!sourceReference) continue;
    const sourceReferenceResult = applyReplacementsToText(sourceReference.content, plan.sourceReferenceReplacements || []);
    if (!sourceReferenceResult) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaGuatemalaHousingScopeReviewMigrationSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        capturedAt: now
      },
      apaGuatemalaHousingScopeReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.dataRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;

    if (bibliographyResult.changed) {
      const bibliographyUpdated = {
        ...bibliography,
        content: bibliographyResult.value,
        ...(bibliographyReviewNoteResult.changed ? { contentReviewNote: bibliographyReviewNoteResult.value } : {}),
        apaGuatemalaHousingReferenceMigrationSnapshot: {
          migrationId,
          priorContent: bibliography.content,
          priorContentReviewNote: bibliographyReviewNoteResult.changed ? bibliography.contentReviewNote : null,
          capturedAt: now
        },
        apaGuatemalaHousingReferenceMigrationApplied: migrationId,
        sourceBundleRevision: incoming.dataRevision || bibliography.sourceBundleRevision,
        updatedAt: now,
        localEditedAt: now
      };
      await putEntry(bibliographyUpdated);
      knownEntries.set(bibliographyUpdated.id, bibliographyUpdated);
      updatedCount += 1;
    }
    if (sourceReferenceResult.changed || sourceReference.apaGuatemalaHousingReferenceMigrationApplied !== migrationId) {
      const sourceReferenceUpdated = {
        ...sourceReference,
        ...(sourceReferenceResult.changed ? { content: sourceReferenceResult.value } : {}),
        title: plan.sourceReferenceUpdate.title,
        apaReferenceRecord: {
          ...sourceReference.apaReferenceRecord,
          year: plan.sourceReferenceUpdate.year,
          sourceText: plan.sourceReferenceUpdate.sourceText,
          verifiedSource: plan.sourceReferenceUpdate.verifiedSource,
          canonicalizationSnapshot: sourceReference.apaReferenceRecord?.canonicalizationSnapshot || {
            sourceText: sourceReference.apaReferenceRecord?.sourceText || null,
            year: sourceReference.apaReferenceRecord?.year || null,
            capturedAt: now
          },
          canonicalizationRationale: plan.sourceReferenceUpdate.canonicalizationRationale
        },
        apaGuatemalaHousingReferenceMigrationApplied: migrationId,
        sourceBundleRevision: incoming.dataRevision || sourceReference.sourceBundleRevision,
        updatedAt: now,
        localEditedAt: now
      };
      await putEntry(sourceReferenceUpdated);
      knownEntries.set(sourceReferenceUpdated.id, sourceReferenceUpdated);
      updatedCount += 1;
    }
  }
  return updatedCount;
}

async function migrateApaIne2024SameAuthorBibliographyNote(sourceEntries, knownEntries) {
  const migrationId = 'apa-ine-2024ab-bibliography-note-2026-10-21-v1';
  const incomingPlan = sourceEntries.find((entry) =>
    entry?.apaGuatemalaHousingScopeReviewMigration?.migrationId
      === 'apa-guatemala-housing-scope-review-2026-10-21-v2-ine-apa-2024ab'
  )?.apaGuatemalaHousingScopeReviewMigration;
  if (!incomingPlan?.bibliographyReviewNoteReplacements?.length) return 0;
  const bibliography = knownEntries.get(incomingPlan.unifiedBibliographyEntryId);
  if (!bibliography || bibliography.apaIne2024SameAuthorBibliographyNoteMigrationApplied === migrationId) return 0;
  const replacement = incomingPlan.bibliographyReviewNoteReplacements[0];
  if (bibliography.contentReviewNote === replacement.newText) return 0;
  if (bibliography.contentReviewNote !== replacement.oldText) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...bibliography,
    contentReviewNote: replacement.newText,
    apaIne2024SameAuthorBibliographyNoteMigrationApplied: migrationId,
    apaIne2024SameAuthorBibliographyNoteSnapshot: {
      priorContentReviewNote: bibliography.contentReviewNote,
      capturedAt: now
    },
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

function applyReplacementsToText(value, replacements) {
  let next = String(value || '');
  let changed = false;
  for (const { oldText, newText } of replacements) {
    const oldCount = next.split(oldText).length - 1;
    const newCount = next.split(newText).length - 1;
    if (oldCount === 0 && newCount === 0) continue;
    if (oldCount === 0 && newCount === 1) continue;
    if (oldCount !== 1 || newCount !== 0) return null;
    next = next.replace(oldText, newText);
    changed = true;
  }
  return { value: next, changed };
}

async function migrateApaClutterClaimReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-claims-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  const replaceUnique = (value, replacements) => {
    let next = String(value || '');
    let changed = false;
    for (const replacement of replacements) {
      if (!replacement?.oldText || !replacement?.newText) continue;
      const oldCount = next.split(replacement.oldText).length - 1;
      const newCount = next.split(replacement.newText).length - 1;
      if (oldCount === 0 && newCount === 1) continue;
      if (oldCount !== 1 || newCount !== 0) return null;
      next = next.replace(replacement.oldText, replacement.newText);
      changed = true;
    }
    return { value: next, changed };
  };

  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterClaimReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaClutterClaimReviewMigrationApplied === migrationId) continue;

    const contentReplacements = Array.isArray(plan.contentReplacements) ? plan.contentReplacements : [];
    const blockReplacements = Array.isArray(plan.blockReplacements) ? plan.blockReplacements : contentReplacements;
    const contentResult = replaceUnique(existing.content, contentReplacements);
    if (!contentResult) continue;

    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const nextBlocks = [];
      let valid = true;
      for (const block of existing.contentBlocks) {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') {
          nextBlocks.push(block);
          continue;
        }
        const result = replaceUnique(block.text, blockReplacements);
        if (!result) { valid = false; break; }
        nextBlocks.push(result.changed ? { ...block, text: result.value } : block);
        blocksChanged ||= result.changed;
      }
      if (!valid) continue;
      const requiredTargets = blockReplacements.filter((replacement) => replacement?.newText);
      const allParagraphs = nextBlocks.filter((block) => block?.type === 'paragraph')
        .map((block) => block.text).join('\n\n');
      if (requiredTargets.some((replacement) => allParagraphs.split(replacement.newText).length - 1 !== 1)) continue;
      contentBlocks = nextBlocks;
    }

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaClutterClaimReviewMigrationSnapshot: {
        migrationId,
        priorContent: contentResult.changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        contentReplacements: contentReplacements.filter((replacement) => existing.content?.includes(replacement.oldText)),
        blockReplacements: blockReplacements.filter((replacement) =>
          existing.contentBlocks?.some((block) => block?.type === 'paragraph' && block.text?.includes(replacement.oldText))),
        capturedAt: now
      },
      apaClutterClaimReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentResult.changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaCultureConsumptionRuntimeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-culture-consumption-runtime-review-pwa-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaCultureConsumptionRuntimeReview;
    if (!plan || plan.migrationId !== migrationId || incoming.id !== 'atlas-clutter-source-4-1-2-2') continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== 'Cultura de consumo y modernidad líquida'
      || existing.area !== 'Origen IDML · Story u2b63'
      || existing.apaCultureConsumptionRuntimeReviewApplied === migrationId) continue;
    const oldParagraphs = Array.isArray(plan.oldParagraphs) ? plan.oldParagraphs : [];
    const newParagraphs = Array.isArray(plan.newParagraphs) ? plan.newParagraphs : [];
    if (oldParagraphs.length !== 2 || newParagraphs.length !== 2) continue;
    const blocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
    const paragraphIndexes = oldParagraphs.map((oldText) => {
      const matches = [];
      blocks.forEach((block, index) => {
        if (block?.type === 'paragraph' && normalize(block.text) === normalize(oldText)) matches.push(index);
      });
      return matches.length === 1 ? matches[0] : -1;
    });
    if (paragraphIndexes.some((index) => index < 0) || new Set(paragraphIndexes).size !== 2) continue;
    const nextBlocks = blocks.map((block, index) => {
      const replacementIndex = paragraphIndexes.indexOf(index);
      return replacementIndex < 0 ? block : { ...block, text: newParagraphs[replacementIndex] };
    });
    let nextContent = String(existing.content || '');
    for (let i = 0; i < oldParagraphs.length; i += 1) {
      const oldText = oldParagraphs[i];
      if (normalize(nextContent).split(normalize(oldText)).length - 1 !== 1) { nextContent = ''; break; }
      const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      nextContent = nextContent.replace(new RegExp(escaped), newParagraphs[i]);
    }
    if (!nextContent) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: nextContent,
      contentBlocks: nextBlocks,
      apaCultureConsumptionRuntimeReviewSnapshot: {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaCultureConsumptionRuntimeReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterDefinitionReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-definition-review-pwa-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterDefinitionReview;
    if (!plan || plan.migrationId !== migrationId || incoming.id !== 'idml-r1-u2b63') continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== '4.1 Clutter (Desorden por acumulación)'
      || existing.area !== 'Origen IDML · Story u2b63'
      || existing.apaClutterDefinitionReviewApplied === migrationId) continue;
    const replacements = Array.isArray(plan.replacements) ? plan.replacements : [];
    if (replacements.length !== 2 || !Array.isArray(existing.contentBlocks)) continue;
    let nextContent = String(existing.content || '');
    const nextBlocks = existing.contentBlocks.map((block) => ({ ...block }));
    let valid = true;
    for (const { oldText, newText } of replacements) {
      if (!oldText || !newText || normalize(nextContent).split(normalize(oldText)).length - 1 !== 1) { valid = false; break; }
      const contentPattern = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      nextContent = nextContent.replace(new RegExp(contentPattern), newText);
      const matches = [];
      nextBlocks.forEach((block, index) => {
        if (block?.type === 'paragraph' && normalize(block.text).split(normalize(oldText)).length - 1 === 1) matches.push(index);
      });
      if (matches.length !== 1) { valid = false; break; }
      const block = nextBlocks[matches[0]];
      const blockPattern = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      block.text = block.text.replace(new RegExp(blockPattern), newText);
    }
    if (!valid) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: nextContent,
      contentBlocks: nextBlocks,
      apaClutterDefinitionReviewSnapshot: {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaClutterDefinitionReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApa41WellbeingDimensionsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-4-1-wellbeing-dimensions-review-pwa-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apa41WellbeingDimensionsReview;
    if (!plan || plan.migrationId !== migrationId || !/^atlas-clutter-source-4-1-4-[1-5]$/.test(incoming.id)) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apa41WellbeingDimensionsReviewApplied === migrationId) continue;
    const oldText = String(plan.oldText || '');
    const newText = String(plan.newText || '');
    if (!oldText || !newText || normalize(existing.content) !== normalize(oldText)) continue;
    const paragraphIndexes = [];
    (existing.contentBlocks || []).forEach((block, index) => {
      if (block?.type === 'paragraph' && normalize(block.text) === normalize(oldText)) paragraphIndexes.push(index);
    });
    if (paragraphIndexes.length !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: newText,
      contentBlocks: existing.contentBlocks.map((block, index) => index === paragraphIndexes[0]
        ? { ...block, text: newText } : block),
      apa41WellbeingDimensionsReviewSnapshot: {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apa41WellbeingDimensionsReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApa41Ods3Citation(sourceEntries, knownEntries) {
  const migrationId = 'apa-41-ods3-citation-and-reference-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apa41Ods3CitationMigration?.migrationId === migrationId);
  if (!incoming) return 0;
  const plan = incoming.apa41Ods3CitationMigration;
  const entry = knownEntries.get(incoming.id);
  const references = knownEntries.get(plan.referenceEntryId);
  if (!entry || !references || entry.apa41Ods3CitationMigrationApplied === migrationId) return 0;
  const oldText = String(plan.oldParagraph || '');
  const newText = String(plan.newParagraph || '');
  const reference = String(plan.reference || '');
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oldText || !newText || !reference || normalize(entry.content).split(normalize(oldText)).length !== 2) return 0;
  const oldBlockIndexes = (entry.contentBlocks || []).map((block, index) =>
    block?.type === 'paragraph' && normalize(block.text) === normalize(oldText) ? index : -1).filter((index) => index >= 0);
  if (oldBlockIndexes.length !== 1) return 0;
  const referenceParagraphs = String(references.content || '').split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean);
  const normalizedReference = normalize(reference).toLocaleLowerCase('en');
  const sameSource = referenceParagraphs.filter((item) => normalize(item).toLocaleLowerCase('en').includes('goal 3: ensure healthy lives and promote well-being for all at all ages'));
  if (sameSource.length > 1 || (sameSource.length === 1 && normalize(sameSource[0]).toLocaleLowerCase('en') !== normalizedReference)) return 0;
  const updatedContent = String(entry.content).replace(oldText, newText);
  const updatedBlocks = entry.contentBlocks.map((block, index) => index === oldBlockIndexes[0] ? { ...block, text: newText } : block);
  const nextReferenceParagraphs = sameSource.length ? referenceParagraphs : [...referenceParagraphs, reference];
  if (!sameSource.length) {
    const sortKey = (value) => value.replace(/^\*+/, '').trim();
    nextReferenceParagraphs.sort((a, b) => new Intl.Collator('en', { sensitivity: 'base' }).compare(sortKey(a), sortKey(b)));
  }
  const now = new Date().toISOString();
  const updatedEntry = {
    ...entry,
    content: updatedContent,
    contentBlocks: updatedBlocks,
    apa41Ods3CitationSnapshot: { migrationId, priorContent: entry.content, priorContentBlocks: entry.contentBlocks, capturedAt: now },
    apa41Ods3CitationMigrationApplied: migrationId,
    updatedAt: now,
    localEditedAt: now
  };
  const updatedReferences = {
    ...references,
    content: nextReferenceParagraphs.join('\n\n'),
    apa41Ods3ReferenceSnapshot: sameSource.length ? references.apa41Ods3ReferenceSnapshot : { migrationId, priorContent: references.content, capturedAt: now },
    apa41Ods3CitationMigrationApplied: migrationId,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntriesAtomically([updatedEntry, updatedReferences]);
  knownEntries.set(updatedEntry.id, updatedEntry);
  knownEntries.set(updatedReferences.id, updatedReferences);
  return 2;
}

async function migrateApaFocusGroupAcademicReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-focus-group-source-scope-review-2026-10-21-v1';
  const incomingEntry = sourceEntries.find((entry) => entry?.apaFocusGroupAcademicReviewMigration?.migrationId === migrationId);
  const incomingReference = sourceEntries.find((entry) => entry?.apaFocusGroupReferenceReviewMigration?.migrationId === migrationId);
  if (!incomingEntry || !incomingReference) return 0;
  const plan = incomingEntry.apaFocusGroupAcademicReviewMigration;
  const entry = knownEntries.get(incomingEntry.id);
  const reference = knownEntries.get(incomingReference.id);
  if (!entry || !reference) return 0;
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const previousContent = String(plan.previousContent || '');
  const oldParagraph = String(plan.oldParagraph || '');
  const newContent = String(plan.newContent || '');
  const newParagraph = String(plan.newParagraph || '');
  const entryAlreadyApplied = entry.apaFocusGroupAcademicReviewApplied === migrationId;
  const needsEntryChange = !entryAlreadyApplied;
  const entryContentMatches = normalize(entry.content) === normalize(previousContent);
  const paragraphIndexes = (entry.contentBlocks || []).map((block, index) =>
    block?.type === 'paragraph' && normalize(block.text) === normalize(oldParagraph) ? index : -1).filter((index) => index >= 0);
  if (needsEntryChange && (!entryContentMatches || paragraphIndexes.length !== 1 || !newContent || !newParagraph)) return 0;

  const referencePlan = incomingReference.apaFocusGroupReferenceReviewMigration;
  const referenceAlreadyApplied = reference.apaFocusGroupReferenceReviewApplied === migrationId;
  const referenceSourceMatches = reference.apaReferenceRecord?.sourceText === referencePlan.expectedSourceText
    || reference.apaReferenceRecord?.sourceText === referencePlan.nextReferenceRecord?.sourceText;
  if (!referenceAlreadyApplied && (!referenceSourceMatches || !referencePlan.nextReferenceRecord)) return 0;

  const now = new Date().toISOString();
  const updates = [];
  if (needsEntryChange) {
    const updated = {
      ...entry,
      content: newContent,
      contentBlocks: entry.contentBlocks.map((block, index) => index === paragraphIndexes[0] ? { ...block, text: newParagraph } : block),
      contentReviewState: incomingEntry.contentReviewState,
      contentReviewNote: incomingEntry.contentReviewNote,
      apaFocusGroupAcademicReviewSnapshot: {
        migrationId,
        priorContent: entry.content,
        priorContentBlocks: entry.contentBlocks,
        priorContentReviewState: entry.contentReviewState || null,
        priorContentReviewNote: entry.contentReviewNote || null,
        capturedAt: now
      },
      apaFocusGroupAcademicReviewApplied: migrationId,
      sourceBundleRevision: incomingEntry.sourceBundleRevision || entry.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    updates.push(updated);
  }
  if (!referenceAlreadyApplied) {
    const updated = {
      ...reference,
      content: incomingReference.content,
      apaReferenceRecord: incomingReference.apaReferenceRecord,
      contentReviewNote: incomingReference.contentReviewNote,
      apaFocusGroupReferenceReviewSnapshot: {
        migrationId,
        priorContent: reference.content,
        priorApaReferenceRecord: reference.apaReferenceRecord,
        priorContentReviewNote: reference.contentReviewNote || null,
        capturedAt: now
      },
      apaFocusGroupReferenceReviewApplied: migrationId,
      sourceBundleRevision: incomingReference.sourceBundleRevision || reference.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    updates.push(updated);
  }
  if (!updates.length) return 0;
  await putEntriesAtomically(updates);
  for (const updated of updates) knownEntries.set(updated.id, updated);
  return updates.length;
}

async function migrateApaAspirationalClutterReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-aspirational-clutter-scope-and-walsh-reference-2026-10-21-v1';
  const incomingEntry = sourceEntries.find((item) => item?.apaAspirationalClutterReviewMigration?.migrationId === migrationId);
  const incomingReference = sourceEntries.find((item) => item?.apaAspirationalClutterReferenceSnapshot?.migrationId === migrationId);
  if (!incomingEntry || !incomingReference) return 0;

  const entry = knownEntries.get(incomingEntry.id);
  const reference = knownEntries.get(incomingReference.id);
  const migration = incomingEntry.apaAspirationalClutterReviewMigration;
  if (!entry || !reference || !migration.nextContent || !migration.previousContent) return 0;
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  const entryAlreadyApplied = entry.apaAspirationalClutterReviewApplied === migrationId;
  const previousBody = migration.previousContent.split(/\n\n/).slice(1).join('\n\n');
  const nextBody = migration.nextContent.split(/\n\n/).slice(1).join('\n\n');
  const blockIndexes = (entry.contentBlocks || []).map((block, index) =>
    block?.type === 'paragraph' && normalize(block.text) === normalize(previousBody) ? index : -1).filter((index) => index >= 0);
  const entryMatches = normalize(entry.content) === normalize(migration.previousContent);
  if (!entryAlreadyApplied && (!entryMatches || blockIndexes.length !== 1 || !nextBody)) return 0;

  const referenceAlreadyApplied = reference.apaAspirationalClutterReferenceApplied === migrationId;
  const expectedReference = 'Walsh, P. (2007). It’s all too much: An easy plan for living a richer life with less stuff. Free Press.';
  const nextReference = incomingReference.content;
  if (!referenceAlreadyApplied && (reference.content !== expectedReference || !nextReference)) return 0;

  const updates = [];
  const now = new Date().toISOString();
  if (!entryAlreadyApplied) {
    updates.push({
      ...entry,
      content: migration.nextContent,
      contentBlocks: entry.contentBlocks.map((block, index) => index === blockIndexes[0] ? { ...block, text: nextBody } : block),
      contentReviewState: incomingEntry.contentReviewState,
      apaAspirationalClutterReview: incomingEntry.apaAspirationalClutterReview,
      apaAspirationalClutterReviewSnapshot: entry.apaAspirationalClutterReviewSnapshot || {
        migrationId,
        priorContent: entry.content,
        priorContentBlocks: entry.contentBlocks,
        priorContentReviewState: entry.contentReviewState || null,
        capturedAt: now
      },
      apaAspirationalClutterReviewApplied: migrationId,
      sourceBundleRevision: incomingEntry.sourceBundleRevision || entry.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    });
  }
  if (!referenceAlreadyApplied) {
    updates.push({
      ...reference,
      content: nextReference,
      apaReferenceRecord: incomingReference.apaReferenceRecord,
      contentReviewNote: incomingReference.contentReviewNote,
      status: incomingReference.status,
      apaAspirationalClutterReferenceSnapshot: incomingReference.apaAspirationalClutterReferenceSnapshot,
      apaAspirationalClutterReferenceApplied: migrationId,
      sourceBundleRevision: incomingReference.sourceBundleRevision || reference.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    });
  }
  if (!updates.length) return 0;
  await putEntriesAtomically(updates);
  for (const updated of updates) knownEntries.set(updated.id, updated);
  return updates.length;
}

async function migrateApaDigitalClutterContentReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-digital-clutter-sweeten-2018-content-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    if (review?.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaAcademicContentReviewApplied === migrationId
      || existing.content !== incoming.content) continue;
    const updated = {
      ...existing,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaInstitutionalResponseContentReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-institutional-response-url-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-2-3'
      || existing.title !== incoming.title
      || existing.apaInstitutionalResponseReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaInstitutionalResponseReview: incoming.apaInstitutionalResponseReview,
      apaInstitutionalResponseReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaEmpowermentAgencyContentReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-empowerment-agency-clutter-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-3-1'
      || existing.title !== incoming.title
      || existing.apaEmpowermentAgencyReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaEmpowermentAgencyReview: incoming.apaEmpowermentAgencyReview,
      apaEmpowermentAgencyReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaCommunityPeerSupportContentReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-community-peer-support-clutter-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-3-2'
      || existing.title !== incoming.title
      || existing.apaCommunityPeerSupportReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaCommunityPeerSupportReview: incoming.apaCommunityPeerSupportReview,
      apaCommunityPeerSupportReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaSchoreUncitedReferenceExclusion(sourceEntries, knownEntries) {
  const migrationId = 'apa-schore-2003-exclude-uncited-reference-2026-10-21-v1';
  const incomingBibliography = sourceEntries.find((entry) => entry.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const incomingSource = sourceEntries.find((entry) => entry.id === 'apa-ref-audit-schore-2003');
  const snapshot = incomingBibliography?.apaSchoreUncitedExclusionSnapshot;
  if (!incomingBibliography?.apaSchoreUncitedExclusion || incomingBibliography.apaSchoreUncitedExclusion.migrationId !== migrationId
    || !snapshot || incomingSource?.bibliographyDisposition?.migrationId !== migrationId) return 0;
  let updatedCount = 0;
  const bibliography = knownEntries.get(incomingBibliography.id);
  if (bibliography && bibliography.apaSchoreUncitedExclusionApplied !== migrationId
    && bibliography.content === snapshot.priorContent) {
    const updatedBibliography = {
      ...bibliography,
      content: incomingBibliography.content,
      apaSchoreUncitedExclusion: incomingBibliography.apaSchoreUncitedExclusion,
      apaSchoreUncitedExclusionSnapshot: snapshot,
      apaSchoreUncitedExclusionApplied: migrationId,
      updatedAt: new Date().toISOString()
    };
    await putEntry(updatedBibliography);
    knownEntries.set(updatedBibliography.id, updatedBibliography);
    updatedCount += 1;
  }
  const existingSource = knownEntries.get(incomingSource.id);
  if (existingSource && existingSource.apaSchoreReferenceExclusionApplied !== migrationId
    && existingSource.status === 'Activa') {
    const updatedSource = {
      ...existingSource,
      status: 'Archivada',
      area: incomingSource.area,
      tags: incomingSource.tags,
      bibliographyDisposition: incomingSource.bibliographyDisposition,
      apaSchoreReferenceExclusionSnapshot: incomingSource.apaSchoreReferenceExclusionSnapshot,
      apaSchoreReferenceExclusionApplied: migrationId,
      updatedAt: new Date().toISOString()
    };
    await putEntry(updatedSource);
    knownEntries.set(updatedSource.id, updatedSource);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGolemanUncitedReferenceExclusion(sourceEntries, knownEntries) {
  const migrationId = 'apa-goleman-1995-exclude-uncited-reference-2026-10-21-v1';
  const incomingBibliography = sourceEntries.find((entry) => entry.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const incomingSource = sourceEntries.find((entry) => entry.id === 'apa-ref-audit-goleman-1995');
  const snapshot = incomingBibliography?.apaGolemanUncitedExclusionSnapshot;
  if (incomingBibliography?.apaGolemanUncitedExclusion?.migrationId !== migrationId
    || !snapshot || incomingSource?.bibliographyDisposition?.migrationId !== migrationId) return 0;
  let updatedCount = 0;
  const bibliography = knownEntries.get(incomingBibliography.id);
  if (bibliography && bibliography.apaGolemanUncitedExclusionApplied !== migrationId
    && bibliography.content === snapshot.priorContent) {
    const updatedBibliography = {
      ...bibliography,
      content: incomingBibliography.content,
      apaGolemanUncitedExclusion: incomingBibliography.apaGolemanUncitedExclusion,
      apaGolemanUncitedExclusionSnapshot: snapshot,
      apaGolemanUncitedExclusionApplied: migrationId,
      updatedAt: new Date().toISOString()
    };
    await putEntry(updatedBibliography);
    knownEntries.set(updatedBibliography.id, updatedBibliography);
    updatedCount += 1;
  }
  const existingSource = knownEntries.get(incomingSource.id);
  if (existingSource && existingSource.apaGolemanReferenceExclusionApplied !== migrationId
    && existingSource.status === 'Activa') {
    const updatedSource = {
      ...existingSource,
      status: 'Archivada',
      area: incomingSource.area,
      tags: incomingSource.tags,
      bibliographyDisposition: incomingSource.bibliographyDisposition,
      apaGolemanReferenceExclusionSnapshot: incomingSource.apaGolemanReferenceExclusionSnapshot,
      apaGolemanReferenceExclusionApplied: migrationId,
      updatedAt: new Date().toISOString()
    };
    await putEntry(updatedSource);
    knownEntries.set(updatedSource.id, updatedSource);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaMinimalismBeckerDefinitionReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-minimalism-becker-definition-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-3-3'
      || existing.title !== incoming.title
      || existing.apaMinimalismBeckerDefinitionReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaMinimalismBeckerDefinitionReview: incoming.apaMinimalismBeckerDefinitionReview,
      apaMinimalismBeckerDefinitionReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaDesignEmotionalLiteracyReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-design-emotional-literacy-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-4-1'
      || existing.title !== snapshot.priorTitle
      || existing.apaDesignEmotionalLiteracyReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaDesignEmotionalLiteracyReview: incoming.apaDesignEmotionalLiteracyReview,
      apaDesignEmotionalLiteracyReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaEducationalMinimalismReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-educational-minimalism-wellbeing-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-4-2'
      || existing.title !== snapshot.priorTitle
      || existing.apaEducationalMinimalismReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaEducationalMinimalismReview: incoming.apaEducationalMinimalismReview,
      apaEducationalMinimalismReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaVisualCommunicationHabitsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-visual-communication-habits-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.id !== 'atlas-clutter-source-4-4-3'
      || existing.title !== snapshot.priorTitle
      || existing.customGuideNode?.label !== snapshot.priorGuideLabel
      || existing.apaVisualCommunicationHabitsReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      title: incoming.title,
      customGuideNode: incoming.customGuideNode,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaVisualCommunicationHabitsReview: incoming.apaVisualCommunicationHabitsReview,
      apaVisualCommunicationHabitsReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaEmotionalMinimalismSectionReview(sourceEntries, knownEntries) {
  const targetIds = new Set([
    'atlas-clutter-source-4-5',
    'atlas-clutter-source-4-5-1',
    'atlas-clutter-source-4-5-2',
    'atlas-clutter-source-4-5-3',
    'atlas-clutter-source-4-5-4'
  ]);
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (!targetIds.has(incoming.id) || !review?.migrationId?.startsWith('apa-4-5') || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing
      || existing.title !== snapshot.priorTitle
      || existing.customGuideNode?.label !== snapshot.priorGuideLabel
      || existing.apaEmotionalMinimalismReviewApplied === review.migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      title: incoming.title,
      customGuideNode: incoming.customGuideNode,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaEmotionalMinimalismReview: incoming.apaEmotionalMinimalismReview,
      apaEmotionalMinimalismReviewApplied: review.migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaVisualEmotionalLiteracyScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-visual-emotional-literacy-scope-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry.id === 'atlas-outline-reference-minimalism');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  if (review?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing
    || existing.title !== snapshot.priorTitle
    || existing.apaVisualEmotionalLiteracyReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: incoming.contentBlocks,
    contentReviewState: 'reviewed',
    apaAcademicContentReview: review,
    apaAcademicContentReviewSnapshot: snapshot,
    apaVisualEmotionalLiteracyReview: incoming.apaVisualEmotionalLiteracyReview,
    apaVisualEmotionalLiteracyReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaAudiencePsychopedagogicProfileReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-psychopedagogic-profile-review-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-psychopedagogic');
  const review = incoming?.apaAcademicContentReview;
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const bibliographyIncoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaPsychopedagogicProfileReview?.migrationId === migrationId);
  if (review?.migrationId !== migrationId || !snapshot || !bibliographyIncoming) return 0;
  let updatedCount = 0;
  const existing = knownEntries.get(incoming.id);
  const localParagraphIndexes = (existing?.contentBlocks || []).flatMap((block, index) => block?.type === 'paragraph' ? [index] : []);
  const incomingParagraphs = (incoming.contentBlocks || []).filter((block) => block?.type === 'paragraph');
  const mergedContentBlocks = localParagraphIndexes.length > 0 && incomingParagraphs.length > 0
    ? existing.contentBlocks.map((block, index) => {
      if (block?.type !== 'paragraph') return block;
      return index === localParagraphIndexes[0] ? incomingParagraphs[0] : null;
    }).filter(Boolean)
    : null;
  if (existing && existing.title === snapshot.priorTitle
    && existing.apaAudiencePsychopedagogicReviewApplied !== migrationId
    && existing.content === snapshot.priorContent
    && mergedContentBlocks) {
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: mergedContentBlocks,
      contentReviewState: 'reviewed',
      contentReviewNote: incoming.contentReviewNote,
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaAudiencePsychopedagogicReview: incoming.apaAudiencePsychopedagogicReview,
      apaAudiencePsychopedagogicReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }

  const bibliography = knownEntries.get(bibliographyIncoming.id);
  const bibliographyPlan = bibliographyIncoming.apaPsychopedagogicProfileReview;
  if (bibliography && bibliography.title === bibliographyIncoming.title
    && bibliography.apaPsychopedagogicProfileReviewApplied !== migrationId
    && bibliography.content === bibliographyPlan.priorContent) {
    const now = new Date().toISOString();
    const updated = {
      ...bibliography,
      content: bibliographyPlan.nextContent,
      apaPsychopedagogicProfileReview: bibliographyPlan,
      apaPsychopedagogicProfileReviewSnapshot: bibliographyIncoming.apaPsychopedagogicProfileReviewSnapshot,
      apaPsychopedagogicProfileReviewApplied: migrationId,
      sourceBundleRevision: bibliographyIncoming.sourceBundleRevision || bibliography.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }

  const referenceIds = bibliographyPlan.addedReferences || [];
  for (const referenceId of referenceIds) {
    const source = sourceEntries.find((entry) => entry?.id === referenceId);
    const reference = knownEntries.get(referenceId);
    if (!source) continue;
    if (reference) {
      if (!reference.localEditedAt && reference.content === source.content
        && reference.apaReferenceRecord?.author !== source.apaReferenceRecord?.author) {
        const now = new Date().toISOString();
        const updated = {
          ...reference,
          apaReferenceRecord: source.apaReferenceRecord,
          contentReviewNote: source.contentReviewNote,
          updatedAt: now,
          localEditedAt: now
        };
        await putEntry(updated);
        knownEntries.set(updated.id, updated);
        updatedCount += 1;
      }
      continue;
    }
    const now = new Date().toISOString();
    const added = { ...source, createdAt: now, updatedAt: now, localEditedAt: now };
    await putEntry(added);
    knownEntries.set(added.id, added);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAudiencePsychographicProfileReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-psychographic-profile-review-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-psychographic');
  const review = incoming?.apaAcademicContentReview;
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  if (review?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  const localParagraphIndexes = (existing?.contentBlocks || [])
    .flatMap((block, index) => block?.type === 'paragraph' ? [index] : []);
  const incomingParagraph = (incoming.contentBlocks || []).find((block) => block?.type === 'paragraph');
  if (!existing || existing.title !== snapshot.priorTitle
    || existing.apaAudiencePsychographicReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || localParagraphIndexes.length === 0 || !incomingParagraph) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: existing.contentBlocks
      .map((block, index) => block?.type === 'paragraph'
        ? (index === localParagraphIndexes[0] ? incomingParagraph : null)
        : block)
      .filter(Boolean),
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: review,
    apaAcademicContentReviewSnapshot: snapshot,
    apaAudiencePsychographicReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaAudienceDemographicGeographicProfileReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-demographic-geographic-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    const incomingParagraph = (incoming.contentBlocks || []).find((block) => block?.type === 'paragraph');
    const localParagraphIndexes = (existing?.contentBlocks || [])
      .flatMap((block, index) => block?.type === 'paragraph' ? [index] : []);
    if (!existing || existing.title !== snapshot.priorTitle
      || existing.apaAudienceDemographicGeographicReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || localParagraphIndexes.length === 0 || !incomingParagraph) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: existing.contentBlocks
        .map((block, index) => block?.type === 'paragraph'
          ? (index === localParagraphIndexes[0] ? incomingParagraph : null)
          : block)
        .filter(Boolean),
      contentReviewState: 'reviewed',
      contentReviewNote: incoming.contentReviewNote,
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaAudienceDemographicGeographicReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAudienceInDepthInterviewScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-in-depth-interview-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-interview');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  if (review?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  const incomingParagraph = (incoming.contentBlocks || []).find((block) => block?.type === 'paragraph');
  const localParagraphIndexes = (existing?.contentBlocks || [])
    .flatMap((block, index) => block?.type === 'paragraph' ? [index] : []);
  if (!existing || existing.title !== snapshot.priorTitle
    || existing.apaAudienceInDepthInterviewReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || localParagraphIndexes.length === 0 || !incomingParagraph) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: existing.contentBlocks
      .map((block, index) => block?.type === 'paragraph'
        ? (index === localParagraphIndexes[0] ? incomingParagraph : null)
        : block)
      .filter(Boolean),
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: review,
    apaAcademicContentReviewSnapshot: snapshot,
    apaAudienceInDepthInterviewReview: incoming.apaAudienceInDepthInterviewReview,
    apaAudienceInDepthInterviewReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaAudienceParticipantObservationScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-participant-observation-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-observation');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  if (review?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  const incomingParagraph = (incoming.contentBlocks || []).find((block) => block?.type === 'paragraph');
  const localParagraphIndexes = (existing?.contentBlocks || [])
    .flatMap((block, index) => block?.type === 'paragraph' ? [index] : []);
  if (!existing || existing.title !== snapshot.priorTitle
    || existing.apaAudienceParticipantObservationReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || localParagraphIndexes.length === 0 || !incomingParagraph) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: existing.contentBlocks
      .map((block, index) => block?.type === 'paragraph'
        ? (index === localParagraphIndexes[0] ? incomingParagraph : null)
        : block)
      .filter(Boolean),
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: review,
    apaAcademicContentReviewSnapshot: snapshot,
    apaAudienceParticipantObservationReview: incoming.apaAudienceParticipantObservationReview,
    apaAudienceParticipantObservationReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaAudienceTargetDefinitionScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-target-definition-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u6188');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  if (review?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.title !== snapshot.priorTitle
    || existing.apaAudienceTargetDefinitionScopeReviewApplied === migrationId
    || existing.content !== snapshot.priorContent) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: review,
    apaAcademicContentReviewSnapshot: snapshot,
    apaAudienceTargetDefinitionScopeReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaAudienceEmpathyMapSourceScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-empathy-map-source-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-empathy');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  let applied = 0;
  if (review?.migrationId === migrationId && snapshot) {
    const existing = knownEntries.get(incoming.id);
    const oldParagraph = 'El mapa de empatía es un recurso colaborativo para organizar lo que se conoce —y lo que aún se necesita investigar— sobre una persona en un contexto concreto. La versión descrita por XPLANE agrupa aspectos de experiencia como pensar y sentir, ver, oír, decir y hacer, además de dificultades y beneficios; su propósito es construir una comprensión compartida, no adivinar estados internos (Gray et al., 2010; Gray, s. f.).';
    const incomingParagraph = (incoming.contentBlocks || []).find((block) => block?.type === 'paragraph' && block.text === incoming.content.split('\n\n')[1]);
    if (existing && existing.title === snapshot.priorTitle
      && existing.apaAudienceEmpathyMapReviewApplied !== migrationId
      && existing.content === snapshot.priorContent
      && (existing.contentBlocks || []).some((block) => block?.type === 'paragraph' && block.text === oldParagraph)
      && incomingParagraph) {
      const now = new Date().toISOString();
      const updated = {
        ...existing,
        content: incoming.content,
        contentBlocks: existing.contentBlocks.map((block) => block?.type === 'paragraph' && block.text === oldParagraph ? incomingParagraph : block),
        contentReviewState: 'reviewed',
        contentReviewNote: incoming.contentReviewNote,
        apaAcademicContentReview: review,
        apaAcademicContentReviewSnapshot: snapshot,
        apaAudienceEmpathyMapReview: incoming.apaAudienceEmpathyMapReview,
        apaAudienceEmpathyMapReviewApplied: migrationId,
        sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
        updatedAt: now,
        localEditedAt: now
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      applied += 1;
    }
  }

  const bibliographyIncoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const bibliographyExisting = bibliographyIncoming && knownEntries.get(bibliographyIncoming.id);
  const oldReference = 'Gray, D. (s. f.). *Empathy map*. Gamestorming. https://gamestorming.com/empathy-map/';
  if (bibliographyIncoming?.apaAudienceEmpathyMapReviewSnapshot?.migrationId === migrationId
    && bibliographyExisting && bibliographyExisting.apaAudienceEmpathyMapReviewApplied !== migrationId
    && bibliographyExisting.content.includes(oldReference)) {
    const newReference = 'Gray, D. (2017). *Empathy map canvas* [PDF]. XPLANE. https://gamestorming.com/wp-content/uploads/2017/07/Empathy-Map-Canvas-006.pdf';
    const now = new Date().toISOString();
    const updated = {
      ...bibliographyExisting,
      content: bibliographyExisting.content.replace(oldReference, newReference),
      apaAudienceEmpathyMapReviewApplied: migrationId,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    applied += 1;
  }
  return applied;
}

async function migrateApaAudienceJourneyMapEvidenceScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-journey-map-evidence-scope-review-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-journey');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const review = incoming?.apaAcademicContentReview;
  let applied = 0;
  if (review?.migrationId === migrationId && snapshot?.priorContentBlocks?.length) {
    const existing = knownEntries.get(incoming.id);
    const figureId = 'generated-openai-2026:atlas-outline-audience-journey:1-5-3-3';
    const priorParagraphs = snapshot.priorContentBlocks.filter((block) => block?.type === 'paragraph');
    const incomingParagraphs = (incoming.contentBlocks || []).filter((block) => block?.type === 'paragraph');
    if (existing && existing.title === snapshot.priorTitle
      && existing.apaAudienceJourneyMapReviewApplied !== migrationId
      && existing.content === snapshot.priorContent
      && (existing.contentBlocks || []).some((block) => block?.type === 'figure' && block.figureId === figureId)
      && priorParagraphs.length === incomingParagraphs.length) {
      let paragraphIndex = 0;
      const updatedBlocks = existing.contentBlocks.map((block) => {
        if (block?.type !== 'paragraph') return block;
        const priorBlock = priorParagraphs[paragraphIndex];
        const incomingBlock = incomingParagraphs[paragraphIndex];
        paragraphIndex += 1;
        return block.text === priorBlock?.text ? incomingBlock : block;
      });
      if (updatedBlocks.filter((block) => block?.type === 'paragraph')
        .every((block, index) => block.text === incomingParagraphs[index]?.text)) {
        const now = new Date().toISOString();
        const updated = {
          ...existing,
          content: incoming.content,
          contentBlocks: updatedBlocks,
          contentReviewState: 'reviewed',
          contentReviewNote: incoming.contentReviewNote,
          apaAcademicContentReview: review,
          apaAcademicContentReviewSnapshot: snapshot,
          apaAudienceJourneyMapReview: incoming.apaAudienceJourneyMapReview,
          apaAudienceJourneyMapReviewApplied: migrationId,
          sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
          updatedAt: now,
          localEditedAt: now
        };
        await putEntry(updated);
        knownEntries.set(updated.id, updated);
        applied += 1;
      }
    }
  }

  const bibliographyIncoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const bibliographySnapshot = bibliographyIncoming?.apaAudienceJourneyMapReviewSnapshot;
  const bibliographyExisting = bibliographyIncoming && knownEntries.get(bibliographyIncoming.id);
  const oldReference = 'Kalbach, J. (2020). *Mapping experiences: A complete guide to creating value through journeys, blueprints, and diagrams* (2nd ed.). O’Reilly Media.';
  const kaplan2019Reference = 'Kaplan, K. (2019, February 10). *How to conduct research for customer-journey mapping*. Nielsen Norman Group. https://www.nngroup.com/articles/research-journey-mapping/';
  const newReference = 'Kaplan, K. (2023, January 8). *How practitioners create journey maps: Typical uses, roles, and methods*. Nielsen Norman Group. https://www.nngroup.com/articles/journey-mapping-how/';
  if (bibliographySnapshot?.migrationId === migrationId && bibliographyExisting
    && bibliographyExisting.apaAudienceJourneyMapReviewApplied !== migrationId
    && bibliographyExisting.content.includes(oldReference)
    && bibliographyExisting.content.includes(kaplan2019Reference)
    && !bibliographyExisting.content.includes(newReference)) {
    const now = new Date().toISOString();
    const withoutOldReference = bibliographyExisting.content.replace(`${oldReference}\n\n`, '');
    const updated = {
      ...bibliographyExisting,
      content: withoutOldReference.replace(`${kaplan2019Reference}\n\n`, `${kaplan2019Reference}\n\n${newReference}\n\n`),
      apaAudienceJourneyMapReviewApplied: migrationId,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    applied += 1;
  }
  return applied;
}

async function migrateApaBecomingMinimalistAcademicReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-becoming-minimalist-source-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3cd5');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const figureId = 'generated-openai-2026:idml-r1-u3cd5';
  if (incoming?.apaAcademicContentReview?.migrationId !== migrationId || snapshot?.migrationId !== migrationId) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaBecomingMinimalistReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || !(existing.contentBlocks || []).some((block) => block?.type === 'figure' && block.figureId === figureId)) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAcademicContentReviewSnapshot: snapshot,
    apaBecomingMinimalistReview: incoming.apaBecomingMinimalistReview,
    apaBecomingMinimalistReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaKondoBeckerSasakiComparisonReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-kondo-becker-sasaki-comparative-claims-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3dcd');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const expectedFigureIds = [
    'generated-openai-2026:idml-r1-u3dcd:1-4-6',
    'generated-ai-assisted:comparison-minimalist-methods'
  ];
  if (incoming?.apaAcademicContentReview?.migrationId !== migrationId || snapshot?.migrationId !== migrationId) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaKondoBeckerSasakiComparisonReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])
    || expectedFigureIds.some((figureId) => !(existing.contentBlocks || []).some((block) => block?.type === 'figure' && block.figureId === figureId))) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAcademicContentReviewSnapshot: snapshot,
    apaKondoBeckerSasakiComparisonReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaConclusionsEvidenceReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-conclusions-survey-data-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u678c');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  if (incoming?.apaAcademicContentReview?.migrationId !== migrationId || snapshot?.migrationId !== migrationId) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaConclusionsEvidenceReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentReviewState: 'reviewed',
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAcademicContentReviewSnapshot: snapshot,
    apaConclusionsEvidenceReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateSurveyResultsEvidenceCorrection(sourceEntries, knownEntries) {
  const migrationId = 'survey-results-candidate-provenance-correction-2026-10-22-v1';
  const targetIds = [
    'idml-r1-u62b1', 'idml-r1-u678c',
    'atlas-outline-audience-demographic', 'atlas-outline-audience-geographic',
    'atlas-outline-audience-psychographic', 'atlas-outline-audience-psychopedagogic',
    'atlas-outline-audience-empathy', 'atlas-outline-audience-persona',
    'atlas-outline-audience-journey', 'atlas-outline-design-audiovisual',
    'atlas-outline-design-editorial', 'atlas-outline-design-websites',
    'idml-r1-u252a', 'idml-r1-u6188'
  ];
  let updatedCount = 0;
  for (const id of targetIds) {
    const incoming = sourceEntries.find((entry) => entry?.id === id);
    const snapshot = incoming?.apaSurveyEvidenceRelianceSnapshot;
    if (incoming?.apaSurveyEvidenceRelianceReviewApplied !== migrationId
      || incoming?.apaSurveyEvidenceRelianceReview?.migrationId !== migrationId
      || snapshot?.migrationId !== migrationId) continue;
    const existing = knownEntries.get(id);
    if (!existing || existing.apaSurveyEvidenceRelianceReviewApplied === migrationId
      || existing.content !== snapshot.content
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.contentBlocks || [])) continue;
    const priorFigureIds = snapshot.preservedFigureIds || [];
    const localFigureIds = (existing.contentBlocks || []).filter((block) => block?.type === 'figure').map((block) => block.figureId);
    if (JSON.stringify(localFigureIds) !== JSON.stringify(priorFigureIds)) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks || existing.contentBlocks,
      contentReviewState: 'evidence-recovery-required',
      contentReviewNote: incoming.contentReviewNote,
      apaAcademicContentReview: incoming.apaAcademicContentReview || existing.apaAcademicContentReview,
      apaSurveyEvidenceRelianceReview: incoming.apaSurveyEvidenceRelianceReview,
      apaSurveyEvidenceRelianceSnapshot: snapshot,
      apaSurveyEvidenceRelianceReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAudienceBuyerPersonaReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-buyer-persona-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-audience-persona');
  const snapshot = incoming?.apaAcademicContentReviewSnapshot;
  const figureId = 'generated-openai-2026:atlas-outline-audience-persona:1-5-3-2';
  if (incoming?.apaAcademicContentReview?.migrationId !== migrationId || snapshot?.migrationId !== migrationId) return 0;
  const existing = knownEntries.get(incoming.id);
  const priorParagraphs = (snapshot.priorContentBlocks || []).filter((block) => block?.type === 'paragraph');
  const incomingParagraphs = (incoming.contentBlocks || []).filter((block) => block?.type === 'paragraph');
  if (!existing || existing.apaBuyerPersonaReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || !(existing.contentBlocks || []).some((block) => block?.type === 'figure' && block.figureId === figureId)
    || priorParagraphs.length !== incomingParagraphs.length) return 0;
  let paragraphIndex = 0;
  const updatedBlocks = existing.contentBlocks.map((block) => {
    if (block?.type !== 'paragraph') return block;
    const oldBlock = priorParagraphs[paragraphIndex];
    const newBlock = incomingParagraphs[paragraphIndex];
    paragraphIndex += 1;
    return block.text === oldBlock?.text ? newBlock : block;
  });
  if (!updatedBlocks.filter((block) => block?.type === 'paragraph')
    .every((block, index) => block.text === incomingParagraphs[index]?.text)) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: updatedBlocks,
    contentReviewState: 'reviewed',
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAcademicContentReviewSnapshot: snapshot,
    apaBuyerPersonaReview: incoming.apaBuyerPersonaReview,
    apaBuyerPersonaReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaBecker2016OrphanExclusion(sourceEntries, knownEntries) {
  const migrationId = 'apa-becker-2016-confirmed-orphan-exclusion-2026-10-22-v1';
  const bibliographyIncoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const sourceIncoming = sourceEntries.find((entry) => entry?.id === 'apa-ref-9ae15c2e033945fa1a46');
  const snapshot = bibliographyIncoming?.apaBecker2016OrphanExclusionSnapshot;
  const reference = snapshot?.referenceText;
  if (snapshot?.migrationId !== migrationId || bibliographyIncoming?.apaBecker2016OrphanExclusion?.migrationId !== migrationId
    || sourceIncoming?.bibliographyDisposition?.migrationId !== migrationId) return 0;
  let applied = 0;
  const bibliographyExisting = knownEntries.get(bibliographyIncoming.id);
  if (bibliographyExisting && bibliographyExisting.apaBecker2016OrphanExclusionApplied !== migrationId
    && bibliographyExisting.content === snapshot.priorBibliography && bibliographyExisting.content.includes(reference)) {
    const now = new Date().toISOString();
    const updated = {
      ...bibliographyExisting,
      content: bibliographyExisting.content.split(/\r?\n/).filter((paragraph) => paragraph.trim() !== reference).join('\n').replace(/\n{3,}/g, '\n\n'),
      apaBecker2016OrphanExclusion: bibliographyIncoming.apaBecker2016OrphanExclusion,
      apaBecker2016OrphanExclusionSnapshot: snapshot,
      apaBecker2016OrphanExclusionApplied: migrationId,
      sourceBundleRevision: bibliographyIncoming.sourceBundleRevision || bibliographyExisting.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    applied += 1;
  }

  const sourceExisting = knownEntries.get(sourceIncoming.id);
  const sourceSnapshot = sourceIncoming.apaBecker2016OrphanExclusionSnapshot;
  if (sourceExisting && sourceSnapshot?.migrationId === migrationId
    && sourceExisting.apaBecker2016OrphanExclusionApplied !== migrationId
    && sourceExisting.status === sourceSnapshot.priorStatus
    && sourceExisting.apaReferenceRecord?.sourceText === sourceIncoming.apaReferenceRecord?.sourceText) {
    const now = new Date().toISOString();
    const updated = {
      ...sourceExisting,
      status: 'Archivada',
      area: sourceIncoming.area,
      tags: [...new Set([...(sourceExisting.tags || []), 'excluida de la lista activa', 'procedencia preservada'])],
      bibliographyDisposition: sourceIncoming.bibliographyDisposition,
      apaBecker2016OrphanExclusionSnapshot: sourceSnapshot,
      apaBecker2016OrphanExclusionApplied: migrationId,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    applied += 1;
  }
  return applied;
}

async function migrateApaSpradleyParticipantObservationReferenceReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-audience-participant-observation-scope-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'apa-ref-7b65c2c96c890128bc15');
  const snapshot = incoming?.apaReferenceReviewSnapshot;
  if (snapshot?.migrationId !== migrationId || !incoming?.apaReferenceRecord) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.apaSpradleyParticipantObservationReviewApplied === migrationId
    || existing.content !== snapshot.priorContent
    || existing.apaReferenceRecord?.sourceText !== snapshot.priorApaReferenceRecord?.sourceText) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    apaReferenceRecord: incoming.apaReferenceRecord,
    contentReviewNote: incoming.contentReviewNote,
    apaReferenceReviewSnapshot: snapshot,
    apaSpradleyParticipantObservationReviewApplied: migrationId,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaMcAlaryPracticalPerspectiveCitation(sourceEntries, knownEntries) {
  const migrationId = 'apa-mcalary-practical-perspective-reference-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry.id === 'atlas-clutter-source-4-5-3');
  const snapshot = incoming?.apaMcalaryPracticalReferenceSnapshot;
  if (incoming?.apaMcalaryPracticalReference?.migrationId !== migrationId || !snapshot) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.title !== incoming.title
    || existing.apaMcalaryPracticalReferenceApplied === migrationId
    || existing.content !== snapshot.priorContent
    || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: incoming.contentBlocks,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaMcalaryPracticalReference: incoming.apaMcalaryPracticalReference,
    apaMcalaryPracticalReferenceSnapshot: snapshot,
    apaMcalaryPracticalReferenceApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaClutterTypologyOverviewReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-typology-overview-structure-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    if (review?.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaAcademicContentReviewApplied === migrationId
      || existing.content !== incoming.content) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: existing.apaAcademicContentReviewSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks || [],
        priorContentReviewState: existing.contentReviewState || null,
        capturedAt: now
      },
      apaAcademicContentReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterSomedayOperationalDefinitionReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-someday-operational-definition-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    if (review?.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaAcademicContentReviewApplied === migrationId
      || existing.content !== incoming.content) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: existing.apaAcademicContentReviewSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks || [],
        priorContentReviewState: existing.contentReviewState || null,
        capturedAt: now
      },
      apaAcademicContentReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaPhysicalClutterSecondaryCitationReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-physical-clutter-secondary-citation-roster-2016-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaPhysicalClutterSecondaryCitationReview;
    const snapshot = incoming?.apaPhysicalClutterSecondaryCitationReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaPhysicalClutterSecondaryCitationReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaSecondarySourceCitations: incoming.apaSecondarySourceCitations,
      apaPhysicalClutterSecondaryCitationReview: review,
      apaPhysicalClutterSecondaryCitationReviewSnapshot: snapshot,
      apaPhysicalClutterSecondaryCitationReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaSwansonPatelWhitePaperReferenceFormat(sourceEntries, knownEntries) {
  const migrationId = 'apa-swanson-patel-white-paper-reference-format-2026-10-21-v1';
  const sourceIncoming = sourceEntries.find((entry) => entry?.apaWhitePaperReferenceFormat?.migrationId === migrationId);
  const bibliographyIncoming = sourceEntries.find((entry) => entry?.apaWhitePaperReferenceFormatMigrationId === migrationId);
  if (!sourceIncoming || !bibliographyIncoming) return 0;
  let updatedCount = 0;
  const sourceExisting = knownEntries.get(sourceIncoming.id);
  const sourceSnapshot = sourceIncoming.apaWhitePaperReferenceFormatSnapshot;
  if (sourceExisting && sourceSnapshot && sourceExisting.apaWhitePaperReferenceFormatApplied !== migrationId
    && sourceExisting.content === sourceSnapshot.content
    && JSON.stringify(sourceExisting.apaReferenceRecord || null) === JSON.stringify(sourceSnapshot.apaReferenceRecord || null)) {
    const now = new Date().toISOString();
    const updated = {
      ...sourceExisting,
      content: sourceIncoming.content,
      apaReferenceRecord: sourceIncoming.apaReferenceRecord,
      apaWhitePaperReferenceFormat: sourceIncoming.apaWhitePaperReferenceFormat,
      apaWhitePaperReferenceFormatSnapshot: sourceSnapshot,
      apaWhitePaperReferenceFormatApplied: migrationId,
      sourceBundleRevision: sourceIncoming.sourceBundleRevision || sourceExisting.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  const bibliographyExisting = knownEntries.get(bibliographyIncoming.id);
  const bibliographySnapshot = bibliographyIncoming.apaWhitePaperReferenceFormatSnapshot;
  if (bibliographyExisting && bibliographySnapshot && bibliographyExisting.apaWhitePaperReferenceFormatApplied !== migrationId
    && bibliographyExisting.content === bibliographySnapshot.content) {
    const now = new Date().toISOString();
    const updated = {
      ...bibliographyExisting,
      content: bibliographyIncoming.content,
      apaWhitePaperReferenceFormatMigrationId: migrationId,
      apaWhitePaperReferenceFormatSnapshot: bibliographySnapshot,
      apaWhitePaperReferenceFormatApplied: migrationId,
      sourceBundleRevision: bibliographyIncoming.sourceBundleRevision || bibliographyExisting.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaEmotionalClutterFrostAbstractReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-emotional-clutter-frost-abstract-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const review = incoming?.apaAcademicContentReview;
    const snapshot = incoming?.apaAcademicContentReviewSnapshot;
    if (review?.migrationId !== migrationId || !snapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaEmotionalClutterReviewMigrationApplied !== incoming.apaEmotionalClutterReviewMigration?.migrationId
      || existing.apaAcademicContentReviewApplied === migrationId
      || existing.content !== snapshot.priorContent
      || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: review,
      apaAcademicContentReviewSnapshot: snapshot,
      apaEmotionalClutterReviewMigrationApplied: incoming.apaEmotionalClutterReviewMigrationApplied,
      apaAcademicContentReviewApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaOriginClutterContextSourcesReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-origin-clutter-context-sources-bauman-chayka-becker-2026-10-21-v1';
  const incomingEntry = sourceEntries.find((entry) => entry?.apaOriginProblemReviewMigrationId === migrationId
    && entry.apaAcademicContentReview?.migrationId === migrationId);
  if (!incomingEntry) return 0;
  let updatedCount = 0;
  const existingEntry = knownEntries.get(incomingEntry.id);
  const entrySnapshot = incomingEntry.apaAcademicContentReviewSnapshot;
  if (existingEntry && entrySnapshot && existingEntry.title === incomingEntry.title
    && existingEntry.apaOriginProblemReviewMigrationApplied !== migrationId
    && existingEntry.content === entrySnapshot.content
    && JSON.stringify(existingEntry.contentBlocks || []) === JSON.stringify(entrySnapshot.contentBlocks || [])) {
    const now = new Date().toISOString();
    const updated = {
      ...existingEntry,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: incomingEntry.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: entrySnapshot,
      apaOriginProblemReviewMigrationId: migrationId,
      apaOriginProblemReviewMigrationApplied: migrationId,
      sourceBundleRevision: incomingEntry.sourceBundleRevision || existingEntry.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  for (const incoming of sourceEntries.filter((item) => item?.apaOriginProblemReferenceMigrationId === migrationId)) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaOriginProblemReferenceSnapshot;
    if (!existing || !snapshot || existing.apaOriginProblemReferenceApplied === migrationId
      || existing.content !== snapshot.content
      || JSON.stringify(existing.apaReferenceRecord || null) !== JSON.stringify(snapshot.apaReferenceRecord || null)
      || existing.status !== snapshot.status) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      status: incoming.status,
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      apaOriginProblemReferenceSnapshot: snapshot,
      apaOriginProblemReferenceMigrationId: migrationId,
      apaOriginProblemReferenceApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaSocialNormsResearchQuestions(sourceEntries, knownEntries) {
  const migrationId = 'apa-social-norms-research-questions-pwa-2026-10-21-v2';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaSocialNormsResearchQuestionsMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaSocialNormsResearchQuestionsMigrationApplied === migrationId) continue;
    const oldBodies = [plan.oldBody, ...(Array.isArray(plan.oldBodyAlternates) ? plan.oldBodyAlternates : [])]
      .map(normalize).filter(Boolean);
    const contentBodyMatches = oldBodies.filter((body) => normalize(existing.content).endsWith(body));
    if (contentBodyMatches.length !== 1) continue;

    let matchedRun = null;
    const blocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
    for (let start = 0; start < blocks.length; start += 1) {
      if (blocks[start]?.type !== 'paragraph') continue;
      let joined = '';
      for (let end = start; end < blocks.length && blocks[end]?.type === 'paragraph'; end += 1) {
        joined += `${joined ? ' ' : ''}${blocks[end].text || ''}`;
        if (normalize(joined) === contentBodyMatches[0]) {
          matchedRun = { start, end };
          break;
        }
        if (normalize(joined).length > contentBodyMatches[0].length + 16) break;
      }
      if (matchedRun) break;
    }
    if (Array.isArray(existing.contentBlocks) && !matchedRun) continue;

    const paragraphs = Array.isArray(plan.newBodyBlocks)
      ? plan.newBodyBlocks.map((text) => String(text || '').trim()).filter(Boolean)
      : [];
    if (!paragraphs.length) continue;
    const heading = String(existing.content || '').split(/\r?\n/, 1)[0] || plan.headingText || incoming.title;
    const now = new Date().toISOString();
    const template = matchedRun ? blocks[matchedRun.start] : null;
    const updated = {
      ...existing,
      content: `${heading}\n\n${paragraphs.join('\n\n')}`,
      ...(Array.isArray(existing.contentBlocks) ? {
        contentBlocks: [
          ...blocks.slice(0, matchedRun.start),
          ...paragraphs.map((text) => ({ ...template, text })),
          ...blocks.slice(matchedRun.end + 1)
        ]
      } : {}),
      apaSocialNormsResearchQuestionsMigrationSnapshot: existing.apaSocialNormsResearchQuestionsMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaSocialNormsResearchQuestionsMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterMentalHealthRuntimeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-mental-health-runtime-review-pwa-2026-10-21-v1';
  const entryId = 'atlas-clutter-source-4-1-3-2';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaClutterMentalHealthRuntimeReviewMigration?.migrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const plan = incoming?.apaClutterMentalHealthRuntimeReviewMigration;
  if (!existing || !plan || existing.apaClutterMentalHealthRuntimeReviewApplied === migrationId) return 0;

  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const priorText = normalize(plan.oldBlockText);
  const currentContent = normalize(existing.content);
  const currentBlocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
  const paragraphRanges = [];
  for (let start = 0; start < currentBlocks.length; start += 1) {
    if (currentBlocks[start]?.type !== 'paragraph') continue;
    let joined = '';
    for (let end = start; end < currentBlocks.length && currentBlocks[end]?.type === 'paragraph'; end += 1) {
      joined += `${joined ? ' ' : ''}${currentBlocks[end].text || ''}`;
      if (normalize(joined) === priorText) paragraphRanges.push({ start, end });
      if (normalize(joined).length > priorText.length + 16) break;
    }
  }
  if (currentContent !== normalize(plan.oldText) || paragraphRanges.length !== 1) return 0;

  const { start, end } = paragraphRanges[0];
  const replacementParagraphs = Array.isArray(plan.newBlockTexts)
    ? plan.newBlockTexts.map((text) => String(text || '').trim()).filter(Boolean)
    : [];
  if (!replacementParagraphs.length) return 0;
  const { id: _templateId, ...template } = currentBlocks[start];
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: plan.newText,
    contentBlocks: [
      ...currentBlocks.slice(0, start),
      ...replacementParagraphs.map((text, index) => ({ ...(index ? template : currentBlocks[start]), text })),
      ...currentBlocks.slice(end + 1)
    ],
    apaClutterMentalHealthRuntimeReviewSnapshot: existing.apaClutterMentalHealthRuntimeReviewSnapshot || {
      migrationId,
      priorContent: existing.content,
      priorContentBlocks: existing.contentBlocks,
      capturedAt: now
    },
    apaClutterMentalHealthRuntimeReviewApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateApaOtherAreasContentReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-other-areas-claims-scope-review-2026-10-21-v1';
  const entryId = 'atlas-clutter-source-4-1-3-4';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaOtherAreasReviewMigration?.migrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const plan = incoming?.apaOtherAreasReviewMigration;
  if (!existing || !plan || existing.apaOtherAreasReviewMigrationApplied === migrationId) return 0;
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const current = normalize(existing.content);
  if (current !== normalize(plan.oldContent) && current !== normalize(plan.newContent)) return 0;
  const figureIds = (Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [])
    .filter((block) => block?.type === 'figure').map((block) => block.figureId);
  if (JSON.stringify(figureIds) !== JSON.stringify(plan.figureIds)) return 0;
  let contentBlocks = existing.contentBlocks;
  if (current === normalize(plan.oldContent) && Array.isArray(contentBlocks)) {
    let headingMatches = 0;
    let introMatches = 0;
    contentBlocks = contentBlocks.map((block) => {
      if (block?.type !== 'paragraph' || typeof block.text !== 'string') return block;
      headingMatches += block.text.split(plan.oldHeading).length - 1;
      introMatches += block.text.split(plan.oldIntro).length - 1;
      return { ...block, text: block.text.replace(plan.oldHeading, plan.newHeading).replace(plan.oldIntro, plan.newIntro) };
    });
    if (headingMatches !== 1 || introMatches !== 1) return 0;
  }
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: plan.newContent,
    contentBlocks,
    contentReviewState: 'reviewed',
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaOtherAreasReviewSnapshot: existing.apaOtherAreasReviewSnapshot || {
      migrationId,
      priorContent: existing.content,
      priorContentBlocks: existing.contentBlocks,
      capturedAt: now
    },
    apaOtherAreasReviewMigrationApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateApaClutterTypologyScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-typology-scope-review-pwa-2026-10-21-v2';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterTypologyScopeMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    let existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title) {
      const candidates = [...knownEntries.values()].filter((entry) => entry?.title === incoming.title
        && normalize(entry.content) === normalize(plan.oldContent));
      if (candidates.length !== 1) continue;
      existing = candidates[0];
    }
    if (!existing || existing.apaClutterTypologyScopeMigrationApplied === migrationId
      || normalize(existing.content) !== normalize(plan.oldContent)
      || !Array.isArray(existing.contentBlocks)) continue;
    const matches = existing.contentBlocks.map((block, index) => ({ block, index }))
      .filter(({ block }) => block?.type === 'paragraph' && normalize(block.text) === normalize(plan.oldBody));
    if (matches.length !== 1) continue;
    const now = new Date().toISOString();
    const { block, index } = matches[0];
    const updated = {
      ...existing,
      content: plan.newContent,
      contentBlocks: existing.contentBlocks.map((item, itemIndex) => itemIndex === index ? { ...block, text: plan.newBody } : item),
      apaClutterTypologyScopeMigrationSnapshot: existing.apaClutterTypologyScopeMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaClutterTypologyScopeMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(existing.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaEmotionalClutterReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-emotional-clutter-review-pwa-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaEmotionalClutterReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const candidates = [...knownEntries.values()].filter((entry) => entry?.title === incoming.title
      && Array.isArray(entry.contentBlocks)
      && entry.contentBlocks.filter((block) => block?.type === 'paragraph' && normalize(block.text) === normalize(plan.oldBody)).length === 1);
    let existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title || !candidates.includes(existing)) {
      if (candidates.length !== 1) continue;
      existing = candidates[0];
    }
    if (existing.apaEmotionalClutterReviewMigrationApplied === migrationId) continue;
    const matches = existing.contentBlocks.map((block, index) => ({ block, index }))
      .filter(({ block }) => block?.type === 'paragraph' && normalize(block.text) === normalize(plan.oldBody));
    if (matches.length !== 1) continue;
    const oldPattern = new RegExp(plan.oldBody.trim().split(/\s+/).map(escapeRegExp).join('\\s+'));
    const content = String(existing.content || '');
    const contentMatches = content.match(new RegExp(oldPattern.source, 'g')) || [];
    if (contentMatches.length !== 1) continue;
    const now = new Date().toISOString();
    const { block, index } = matches[0];
    const updated = {
      ...existing,
      content: content.replace(oldPattern, plan.newBody),
      contentBlocks: existing.contentBlocks.map((item, itemIndex) => itemIndex === index ? { ...block, text: plan.newBody } : item),
      apaEmotionalClutterReviewMigrationSnapshot: existing.apaEmotionalClutterReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaEmotionalClutterReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaSweetenSampleCorrection(sourceEntries, knownEntries) {
  const migrationId = 'apa-sweeten-2018-sample-n-46-correction-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaSweetenSampleCorrectionMigration?.migrationId === migrationId);
  if (!incoming) return 0;
  const plan = incoming.apaSweetenSampleCorrectionMigration;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.title !== incoming.title || existing.apaSweetenSampleCorrectionApplied === migrationId) return 0;
  const oldText = String(plan.oldText || '');
  const newText = String(plan.newText || '');
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oldText || !newText || normalize(existing.content).split(normalize(oldText)).length !== 2) return 0;
  const blockIndexes = (existing.contentBlocks || []).map((block, index) =>
    block?.type === 'paragraph' && normalize(block.text).includes(normalize(oldText)) ? index : -1).filter((index) => index >= 0);
  if (blockIndexes.length !== 1) return 0;
  const updatedContent = String(existing.content).replace(oldText, newText);
  const updatedBlocks = existing.contentBlocks.map((block, index) => index === blockIndexes[0]
    ? { ...block, text: String(block.text).replace(oldText, newText) } : block);
  if (normalize(updatedContent) === normalize(existing.content)
    || !updatedBlocks[blockIndexes[0]].text.includes('46 personas adultas')) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: updatedContent,
    contentBlocks: updatedBlocks,
    apaSweetenSampleCorrectionSnapshot: {
      migrationId,
      priorContent: existing.content,
      priorContentBlocks: existing.contentBlocks,
      capturedAt: now
    },
    apaSweetenSampleCorrectionApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaWalshSelfHelpScope(sourceEntries, knownEntries) {
  const migrationId = 'apa-walsh-2007-self-help-scope-4-1-1-2-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaWalshSelfHelpScopeMigration?.migrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing || existing.title !== incoming.title || existing.apaWalshSelfHelpScopeApplied === migrationId) return 0;
  const plan = incoming.apaWalshSelfHelpScopeMigration;
  const oldText = String(plan.oldText || '');
  const newText = String(plan.newText || '');
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oldText || !newText || normalize(existing.content).split(normalize(oldText)).length !== 2) return 0;
  const blockIndexes = (existing.contentBlocks || []).map((block, index) =>
    block?.type === 'paragraph' && normalize(block.text).includes(normalize(oldText)) ? index : -1).filter((index) => index >= 0);
  if (blockIndexes.length !== 1) return 0;
  const updatedContent = String(existing.content).replace(oldText, newText);
  const updatedBlocks = existing.contentBlocks.map((block, index) => index === blockIndexes[0]
    ? { ...block, text: String(block.text).replace(oldText, newText) } : block);
  if (normalize(updatedContent) === normalize(existing.content)) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: updatedContent,
    contentBlocks: updatedBlocks,
    apaWalshSelfHelpScopeSnapshot: { migrationId, priorContent: existing.content, priorContentBlocks: existing.contentBlocks, capturedAt: now },
    apaWalshSelfHelpScopeApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaClutterTypologyOverview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-typology-overview-review-pwa-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterTypologyOverviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaClutterTypologyOverviewMigrationApplied === migrationId
      || normalize(existing.content) !== normalize(plan.oldContent)
      || !Array.isArray(existing.contentBlocks)) continue;
    const matches = existing.contentBlocks.map((block, index) => ({ block, index }))
      .filter(({ block }) => block?.type === 'paragraph' && normalize(block.text) === normalize(plan.oldContent));
    if (matches.length !== 1) continue;
    const now = new Date().toISOString();
    const { block, index } = matches[0];
    const updated = {
      ...existing,
      content: plan.newContent,
      contentBlocks: existing.contentBlocks.map((item, itemIndex) => itemIndex === index ? { ...block, text: plan.newContent } : item),
      apaClutterTypologyOverviewMigrationSnapshot: existing.apaClutterTypologyOverviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaClutterTypologyOverviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterDecisionProcessesReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-decision-processes-review-pwa-2026-10-21-v4';
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterDecisionProcessesMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.title !== incoming.title
      || existing.apaClutterDecisionProcessesMigrationApplied === migrationId) continue;
    const paragraphRuns = [];
    const existingBlocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
    const oldBodies = [plan.oldBody, ...(Array.isArray(plan.oldBodyAlternates) ? plan.oldBodyAlternates : [])]
      .map(normalize).filter(Boolean);
    for (let start = 0; start < existingBlocks.length; start += 1) {
      if (existingBlocks[start]?.type !== 'paragraph') continue;
      let joined = '';
      for (let end = start; end < existingBlocks.length && existingBlocks[end]?.type === 'paragraph'; end += 1) {
        joined += `${joined ? ' ' : ''}${existingBlocks[end].text || ''}`;
        if (oldBodies.includes(normalize(joined))) paragraphRuns.push({ start, end });
        if (oldBodies.every((oldBody) => normalize(joined).length > oldBody.length + 16)) break;
      }
    }
    let matchedRun = paragraphRuns.length === 1 ? paragraphRuns[0] : null;
    const currentContent = normalize(existing.content);
    const contentBodyMatches = oldBodies.filter((body) => currentContent.endsWith(body));
    if (!matchedRun && contentBodyMatches.length === 1 && Array.isArray(existing.contentBlocks)) {
      for (let start = 0; start < existingBlocks.length; start += 1) {
        if (existingBlocks[start]?.type !== 'paragraph') continue;
        let joined = '';
        for (let end = start; end < existingBlocks.length && existingBlocks[end]?.type === 'paragraph'; end += 1) {
          joined += `${joined ? ' ' : ''}${existingBlocks[end].text || ''}`;
          if (normalize(joined) === contentBodyMatches[0]) {
            matchedRun = { start, end };
            break;
          }
          if (normalize(joined).length > contentBodyMatches[0].length + 16) break;
        }
        if (matchedRun) break;
      }
    }
    if (!matchedRun && contentBodyMatches.length !== 1) continue;
    if (Array.isArray(existing.contentBlocks) && !matchedRun) continue;
    const start = matchedRun?.start ?? -1;
    const end = matchedRun?.end ?? -1;
    const template = start >= 0 ? existing.contentBlocks[start] : null;
    const now = new Date().toISOString();
    const newBlocks = Array.isArray(plan.newBodyBlocks)
      ? plan.newBodyBlocks.map((text) => String(text || '').trim()).filter(Boolean)
      : [];
    if (!newBlocks.length) continue;
    const heading = String(existing.content || '').split(/\r?\n/, 1)[0] || plan.headingText || incoming.title;
    const nextContent = `${heading}\n\n${newBlocks.join('\n\n')}`;
    const updated = {
      ...existing,
      content: nextContent,
      ...(Array.isArray(existing.contentBlocks) ? {
        contentBlocks: [
          ...existingBlocks.slice(0, start),
          ...newBlocks.map((text) => ({ ...template, text })),
          ...existingBlocks.slice(end + 1)
        ]
      } : {}),
      apaClutterDecisionProcessesMigrationSnapshot: existing.apaClutterDecisionProcessesMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaClutterDecisionProcessesMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaTemporalDisorderReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-temporal-disorder-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaTemporalDisorderReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaTemporalDisorderReviewMigrationApplied === migrationId) continue;

    const headingText = 'g. El desorden temporal';
    const bodyStart = plan.bodyStart;
    const bodyText = plan.newBody;
    const currentContent = String(existing.content || '');
    const bodyStartIndex = currentContent.lastIndexOf(bodyStart);
    const alreadyCurrent = currentContent.includes(bodyText) && currentContent.includes(headingText);
    if (!alreadyCurrent && (bodyStartIndex < 0 || currentContent.indexOf(bodyStart) !== bodyStartIndex)) continue;

    let nextContent = currentContent;
    let contentChanged = false;
    if (!alreadyCurrent) {
      const sectionStart = Math.max(currentContent.lastIndexOf('f. El desorden temporal', bodyStartIndex), currentContent.lastIndexOf(headingText, bodyStartIndex));
      if (sectionStart < 0 || currentContent.slice(sectionStart, bodyStartIndex).replace(/f\. El desorden temporal|g\. El desorden temporal|\s/g, '')) continue;
      const lineStart = currentContent.lastIndexOf('\n', sectionStart - 1) + 1;
      nextContent = `${currentContent.slice(0, lineStart)}${headingText}\n\n${bodyText}`;
      contentChanged = nextContent !== currentContent;
    }

    let nextBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const headingIndex = existing.contentBlocks.findIndex((block) => block?.type === 'paragraph'
        && ['f. El desorden temporal', headingText].includes(block.text?.trim()));
      const bodyIndex = headingIndex + 1;
      if (headingIndex < 0 || !existing.contentBlocks[bodyIndex]?.text?.startsWith(bodyStart)) continue;
      const trailingBlocks = existing.contentBlocks.slice(bodyIndex);
      if (trailingBlocks.some((block) => block?.type !== 'paragraph')) continue;
      const alreadyCurrentBlock = trailingBlocks.length === 1 && trailingBlocks[0].text === bodyText;
      if (!alreadyCurrentBlock) {
        nextBlocks = [
          ...existing.contentBlocks.slice(0, headingIndex),
          { ...existing.contentBlocks[headingIndex], text: headingText },
          { ...existing.contentBlocks[bodyIndex], text: bodyText }
        ];
        blocksChanged = true;
      }
    }
    if (!contentChanged && !blocksChanged && !alreadyCurrent) continue;

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentChanged ? { content: nextContent } : {}),
      ...(blocksChanged ? { contentBlocks: nextBlocks } : {}),
      apaTemporalDisorderReviewMigrationSnapshot: {
        migrationId,
        priorContent: contentChanged ? existing.content : null,
        priorContentBlocks: blocksChanged ? existing.contentBlocks : null,
        capturedAt: now
      },
      apaTemporalDisorderReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((contentChanged || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterConceptsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-concepts-review-pwa-2026-10-21-v2';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterConceptsReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaClutterConceptsReviewMigrationApplied === migrationId) continue;
    const replaceMatchingParagraphs = (value, replacements) => {
      let next = String(value || '');
      let changed = false;
      const unmatched = [];
      for (const [index, replacement] of replacements.entries()) {
        const oldCount = next.split(replacement.oldText).length - 1;
        const newCount = next.split(replacement.newText).length - 1;
        if (oldCount === 0 && newCount === 1) continue;
        if (oldCount === 1 && newCount === 0) {
          next = next.replace(replacement.oldText, replacement.newText);
          changed = true;
          continue;
        }
        if (oldCount === 0 && newCount === 0 && replacement.oldPrefix) {
          const prefixAt = next.indexOf(replacement.oldPrefix);
          const lastPrefixAt = next.lastIndexOf(replacement.oldPrefix);
          const prefixEnd = prefixAt < 0 ? -1 : next.indexOf('\n\n', prefixAt);
          const startsParagraph = prefixAt === 0 || next.slice(prefixAt - 2, prefixAt) === '\n\n';
          if (prefixAt >= 0 && prefixAt === lastPrefixAt && startsParagraph && prefixEnd > prefixAt) {
            next = `${next.slice(0, prefixAt)}${replacement.newText}${next.slice(prefixEnd)}`;
            changed = true;
            continue;
          }
        }
        if (oldCount !== 0 || newCount !== 1) unmatched.push(index);
      }
      return { value: next, changed, unmatched };
    };
    const contentResult = replaceMatchingParagraphs(existing.content, plan.replacements);
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    const unmatchedBlockIndexes = [];
    if (Array.isArray(existing.contentBlocks)) {
      const nextBlocks = [...existing.contentBlocks];
      for (const [replacementIndex, replacement] of plan.replacements.entries()) {
        const oldMatches = nextBlocks.map((block, index) => ({ block, index }))
          .filter(({ block }) => block?.type === 'paragraph' && block.text === replacement.oldText);
        const newMatches = nextBlocks.filter((block) => block?.type === 'paragraph' && block.text === replacement.newText);
        if (oldMatches.length === 0 && newMatches.length === 1) continue;
        let match = oldMatches.length === 1 && newMatches.length === 0 ? oldMatches[0] : null;
        if (!match && oldMatches.length === 0 && newMatches.length === 0 && replacement.oldPrefix) {
          const prefixMatches = nextBlocks.map((block, index) => ({ block, index }))
            .filter(({ block }) => block?.type === 'paragraph' && block.text?.startsWith(replacement.oldPrefix));
          if (prefixMatches.length === 1) match = prefixMatches[0];
        }
        if (!match) { unmatchedBlockIndexes.push(replacementIndex); continue; }
        const { block, index } = match;
        nextBlocks[index] = { ...block, text: replacement.newText };
        blocksChanged = true;
      }
      contentBlocks = nextBlocks;
    }
    if (!contentResult.changed && !blocksChanged && (contentResult.unmatched.length || unmatchedBlockIndexes.length)) continue;
    const fullyMatched = contentResult.unmatched.length === 0 && unmatchedBlockIndexes.length === 0;
    if (!contentResult.changed && !blocksChanged && fullyMatched) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(contentResult.changed ? { content: contentResult.value } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaClutterConceptsReviewMigrationSnapshot: existing.apaClutterConceptsReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      ...(fullyMatched ? { apaClutterConceptsReviewMigrationApplied: migrationId } : { apaClutterConceptsReviewMigrationPending: { migrationId, contentIndexes: contentResult.unmatched, blockIndexes: unmatchedBlockIndexes, retriedAt: now } }),
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaPhysicalEffectsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-physical-effects-claim-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaPhysicalEffectsReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaPhysicalEffectsReviewMigrationApplied === migrationId) continue;

    const oldText = plan.oldText;
    const newText = plan.newText;
    const currentContent = String(existing.content || '');
    const oldCount = currentContent.split(oldText).length - 1;
    const newCount = currentContent.split(newText).length - 1;
    const alreadyCurrent = oldCount === 0 && newCount === 1;
    if (!alreadyCurrent && (oldCount !== 1 || newCount !== 0)) continue;
    const nextContent = alreadyCurrent ? currentContent : currentContent.replace(oldText, newText);

    let nextBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const oldMatches = existing.contentBlocks.filter((block) => block?.type === 'paragraph' && block.text === oldText);
      const newMatches = existing.contentBlocks.filter((block) => block?.type === 'paragraph' && block.text === newText);
      if (!(oldMatches.length === 1 && newMatches.length === 0) && !(oldMatches.length === 0 && newMatches.length === 1)) continue;
      if (oldMatches.length === 1) {
        nextBlocks = existing.contentBlocks.map((block) => block?.type === 'paragraph' && block.text === oldText
          ? { ...block, text: newText } : block);
        blocksChanged = true;
      }
    }
    if (alreadyCurrent && !blocksChanged) {
      const now = new Date().toISOString();
      const updated = { ...existing, apaPhysicalEffectsReviewMigrationApplied: migrationId, updatedAt: now };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updatedCount += 1;
      continue;
    }

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: nextContent,
      ...(blocksChanged ? { contentBlocks: nextBlocks } : {}),
      apaPhysicalEffectsReviewMigrationSnapshot: existing.apaPhysicalEffectsReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaPhysicalEffectsReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaCommunityEffectsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-community-effects-claim-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaCommunityEffectsReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaCommunityEffectsReviewMigrationApplied === migrationId) continue;
    const oldText = plan.oldText;
    const newText = plan.newText;
    const currentContent = String(existing.content || '');
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const paragraphPattern = (value) => String(value || '').trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const findTextMatches = (haystack, needle) => [...String(haystack || '').matchAll(new RegExp(paragraphPattern(needle), 'g'))];
    const oldMatchesInContent = findTextMatches(currentContent, oldText);
    const newMatchesInContent = findTextMatches(currentContent, newText);
    const alreadyCurrent = oldMatchesInContent.length === 0 && newMatchesInContent.length === 1;
    if (!alreadyCurrent && (oldMatchesInContent.length !== 1 || newMatchesInContent.length !== 0)) continue;
    const nextContent = alreadyCurrent ? currentContent : currentContent.replace(new RegExp(paragraphPattern(oldText)), newText);
    let nextBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const blocks = existing.contentBlocks;
      const findBlockRanges = (target) => {
        const ranges = [];
        for (let start = 0; start < blocks.length; start += 1) {
          if (blocks[start]?.type !== 'paragraph') continue;
          let joined = '';
          for (let end = start; end < blocks.length && blocks[end]?.type === 'paragraph'; end += 1) {
            joined += `${joined ? '\n\n' : ''}${blocks[end].text || ''}`;
            if (normalize(joined) === normalize(target)) ranges.push({ start, end });
            if (normalize(joined).length > normalize(target).length + 8) break;
          }
        }
        return ranges;
      };
      const oldRanges = findBlockRanges(oldText);
      const newRanges = findBlockRanges(newText);
      if (!(oldRanges.length === 1 && newRanges.length === 0) && !(oldRanges.length === 0 && newRanges.length === 1)) continue;
      if (oldRanges.length === 1) {
        const { start, end } = oldRanges[0];
        const paragraphTexts = newText.split(/\n\s*\n/).filter(Boolean);
        const template = blocks[start];
        const { id: _templateId, ...templateWithoutId } = template;
        nextBlocks = [...blocks.slice(0, start), ...paragraphTexts.map((text, index) => ({ ...(index ? templateWithoutId : template), text })), ...blocks.slice(end + 1)];
        blocksChanged = true;
      }
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(nextContent !== currentContent ? { content: nextContent } : {}),
      ...(blocksChanged ? { contentBlocks: nextBlocks } : {}),
      apaCommunityEffectsReviewMigrationSnapshot: existing.apaCommunityEffectsReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaCommunityEffectsReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((nextContent !== currentContent || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaCommunityEffectsSourceCitationReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-community-effects-agn-secondary-source-2026-10-21-v1';
  const entryId = 'atlas-clutter-source-4-1-3-3';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaCommunityEffectsSourceCitationMigration?.migrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const plan = incoming?.apaCommunityEffectsSourceCitationMigration;
  if (!existing || !plan || existing.apaCommunityEffectsSourceCitationMigrationApplied === migrationId) return 0;
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const current = normalize(existing.content);
  if (current !== normalize(plan.oldContent) && current !== normalize(plan.newContent)) return 0;
  const figureIds = (Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [])
    .filter((block) => block?.type === 'figure').map((block) => block.figureId);
  if (JSON.stringify(figureIds) !== JSON.stringify(plan.figureIds)) return 0;
  let contentBlocks = existing.contentBlocks;
  if (current === normalize(plan.oldContent) && Array.isArray(contentBlocks)) {
    const matches = contentBlocks.reduce((count, block) => count + (block?.type === 'paragraph'
      && String(block.text || '').split(plan.oldClause).length - 1), 0);
    if (matches !== 1) return 0;
    contentBlocks = contentBlocks.map((block) => block?.type === 'paragraph'
      && String(block.text || '').includes(plan.oldClause) ? { ...block, text: block.text.replace(plan.oldClause, plan.newClause) } : block);
  }
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: plan.newContent,
    contentBlocks,
    contentReviewState: 'reviewed',
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaCommunityEffectsSourceCitationSnapshot: existing.apaCommunityEffectsSourceCitationSnapshot || {
      migrationId,
      priorContent: existing.content,
      priorContentBlocks: existing.contentBlocks,
      capturedAt: now
    },
    apaCommunityEffectsSourceCitationMigrationApplied: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  const referenceId = 'apa-ref-04af6eab9d6f0d93987b';
  const incomingReference = sourceEntries.find((entry) => entry?.id === referenceId);
  const reference = knownEntries.get(referenceId);
  if (reference && incomingReference?.apaReferenceRecord?.usage?.some((usage) => usage.entryId === entryId)) {
    const usage = Array.isArray(reference.apaReferenceRecord?.usage) ? reference.apaReferenceRecord.usage : [];
    if (!usage.some((item) => item.entryId === entryId)) {
      const updatedReference = {
        ...reference,
        apaReferenceRecord: { ...reference.apaReferenceRecord, usage: [...usage, ...incomingReference.apaReferenceRecord.usage.filter((item) => item.entryId === entryId)] },
        sourceBundleRevision: incomingReference.sourceBundleRevision || reference.sourceBundleRevision,
        updatedAt: now
      };
      await putEntry(updatedReference);
      knownEntries.set(referenceId, updatedReference);
    }
  }
  return 1;
}

async function migrateApaPreventionReviewAndReferenceExclusion(sourceEntries, knownEntries) {
  let updatedCount = 0;
  const preventionId = 'atlas-clutter-source-4-1-5-a';
  const preventionIncoming = sourceEntries.find((entry) => entry?.id === preventionId
    && entry.apaPreventionSourceCitationMigration?.migrationId === 'apa-prevention-source-attribution-review-2026-10-21-v1');
  const preventionPlan = preventionIncoming?.apaPreventionSourceCitationMigration;
  const preventionExisting = preventionIncoming && knownEntries.get(preventionId);
  if (preventionExisting && preventionPlan
    && preventionExisting.apaPreventionSourceCitationMigrationApplied !== preventionPlan.migrationId) {
    const oldCount = String(preventionExisting.content || '').split(preventionPlan.oldClause).length - 1;
    const newCount = String(preventionExisting.content || '').split(preventionPlan.newClause).length - 1;
    const figures = (Array.isArray(preventionExisting.contentBlocks) ? preventionExisting.contentBlocks : [])
      .filter((block) => block?.type === 'figure').map((block) => block.figureId);
    const blockOldCount = (preventionExisting.contentBlocks || []).reduce((total, block) => total
      + (block?.type === 'paragraph' ? String(block.text || '').split(preventionPlan.oldClause).length - 1 : 0), 0);
    const blockNewCount = (preventionExisting.contentBlocks || []).reduce((total, block) => total
      + (block?.type === 'paragraph' ? String(block.text || '').split(preventionPlan.newClause).length - 1 : 0), 0);
    if (((oldCount === 1 && newCount === 0 && blockOldCount === 1 && blockNewCount === 0)
      || (oldCount === 0 && newCount === 1 && blockOldCount === 0 && blockNewCount === 1))
      && JSON.stringify(figures) === JSON.stringify(preventionPlan.figureIds)) {
      const now = new Date().toISOString();
      const content = oldCount ? preventionExisting.content.replace(preventionPlan.oldClause, preventionPlan.newClause) : preventionExisting.content;
      const contentBlocks = oldCount ? preventionExisting.contentBlocks.map((block) => block?.type === 'paragraph'
        && String(block.text || '').includes(preventionPlan.oldClause)
        ? { ...block, text: block.text.replace(preventionPlan.oldClause, preventionPlan.newClause) } : block) : preventionExisting.contentBlocks;
      const updated = {
        ...preventionExisting,
        content,
        contentBlocks,
        contentReviewState: 'reviewed',
        apaAcademicContentReview: preventionIncoming.apaAcademicContentReview,
        apaAcademicContentReviewSnapshot: preventionExisting.apaAcademicContentReviewSnapshot
          || preventionIncoming.apaAcademicContentReviewSnapshot || {
            migrationId: preventionPlan.migrationId,
            priorContent: preventionExisting.content,
            priorContentBlocks: preventionExisting.contentBlocks,
            capturedAt: now
          },
        apaPreventionSourceCitationMigrationSnapshot: preventionExisting.apaPreventionSourceCitationMigrationSnapshot || {
          migrationId: preventionPlan.migrationId,
          priorContent: preventionExisting.content,
          priorContentBlocks: preventionExisting.contentBlocks,
          capturedAt: now
        },
        apaPreventionSourceCitationMigrationApplied: preventionPlan.migrationId,
        sourceBundleRevision: preventionIncoming.sourceBundleRevision || preventionExisting.sourceBundleRevision,
        updatedAt: now,
        localEditedAt: now
      };
      await putEntry(updated);
      knownEntries.set(preventionId, updated);
      updatedCount += 1;
    }
  }

  const bibliographyIncoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaUnifiedBibliographyUnusedMspasMigration?.migrationId === 'apa-exclude-uncited-mspas-primary-record-2026-10-21-v1');
  const bibliographyPlan = bibliographyIncoming?.apaUnifiedBibliographyUnusedMspasMigration;
  const bibliographyExisting = bibliographyIncoming && knownEntries.get(bibliographyIncoming.id);
  const hasOtherMspasCitation = [...knownEntries.values()].some((entry) => ['Entrada', 'Nota'].includes(entry.type)
    && entry.id !== preventionId && entry.id !== bibliographyIncoming?.id && entry.status !== 'Archivada'
    && /\((?:MSPAS|Ministerio de Salud Pública y Asistencia Social),\s*2023\)/.test(String(entry.content || '')));
  if (bibliographyExisting && bibliographyPlan && !hasOtherMspasCitation
    && bibliographyExisting.apaUnifiedBibliographyUnusedMspasMigrationApplied !== bibliographyPlan.migrationId) {
    const rowCount = String(bibliographyExisting.content || '').split(bibliographyPlan.removedRow).length - 1;
    if (rowCount === 1) {
      const now = new Date().toISOString();
      const paragraphs = String(bibliographyExisting.content || '').split(/\r?\n\s*\r?\n/).map((row) => row.trim()).filter(Boolean);
      const updated = {
        ...bibliographyExisting,
        content: paragraphs.filter((row) => row !== bibliographyPlan.removedRow).join('\n\n'),
        ...(bibliographyExisting.contentReviewNote === bibliographyPlan.priorContentReviewNote
          ? { contentReviewNote: bibliographyPlan.newContentReviewNote } : {}),
        apaUnifiedBibliographyUnusedMspasMigrationSnapshot: bibliographyExisting.apaUnifiedBibliographyUnusedMspasMigrationSnapshot || {
          migrationId: bibliographyPlan.migrationId,
          priorContent: bibliographyExisting.content,
          priorContentReviewNote: bibliographyExisting.contentReviewNote || null,
          capturedAt: now
        },
        apaUnifiedBibliographyUnusedMspasMigrationApplied: bibliographyPlan.migrationId,
        sourceBundleRevision: bibliographyIncoming.sourceBundleRevision || bibliographyExisting.sourceBundleRevision,
        updatedAt: now,
        localEditedAt: now
      };
      await putEntry(updated);
      knownEntries.set(bibliographyIncoming.id, updated);
      updatedCount += 1;
    }
  }

  for (const referenceId of ['apa-ref-44890b5a2aee460051c6', 'apa-ref-04af6eab9d6f0d93987b']) {
    const incomingReference = sourceEntries.find((entry) => entry?.id === referenceId);
    const existingReference = knownEntries.get(referenceId);
    if (!incomingReference?.apaReferenceRecord || !existingReference) continue;
    const now = new Date().toISOString();
    const existingUsage = Array.isArray(existingReference.apaReferenceRecord?.usage) ? existingReference.apaReferenceRecord.usage : [];
    const incomingUsage = Array.isArray(incomingReference.apaReferenceRecord.usage) ? incomingReference.apaReferenceRecord.usage : [];
    const usage = [...existingUsage];
    for (const item of incomingUsage) {
      if (!usage.some((existing) => existing.entryId === item.entryId)) usage.push(item);
    }
    const mergedRecord = { ...existingReference.apaReferenceRecord, ...incomingReference.apaReferenceRecord, usage };
    if (JSON.stringify(mergedRecord) === JSON.stringify(existingReference.apaReferenceRecord)) continue;
    const updatedReference = {
      ...existingReference,
      apaReferenceRecord: mergedRecord,
      sourceBundleRevision: incomingReference.sourceBundleRevision || existingReference.sourceBundleRevision,
      updatedAt: now
    };
    await putEntry(updatedReference);
    knownEntries.set(referenceId, updatedReference);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGeneralEffectsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-general-effects-4-1-3-review-2026-10-21-v1';
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGeneralEffectsReviewMigration;
    const existing = knownEntries.get(incoming?.id);
    if (!plan || plan.migrationId !== migrationId || !existing
      || existing.apaGeneralEffectsReviewMigrationApplied === migrationId) continue;
    const current = String(existing.content || '');
    const oldMatches = current.split(plan.oldText).length - 1;
    const newMatches = current.split(plan.newText).length - 1;
    if (!((oldMatches === 1 && newMatches === 0) || (oldMatches === 0 && newMatches === 1))) continue;
    let contentBlocks = existing.contentBlocks;
    let blocksChanged = false;
    if (Array.isArray(existing.contentBlocks)) {
      const blocks = existing.contentBlocks;
      const findRanges = (target) => {
        const matches = [];
        for (let start = 0; start < blocks.length; start += 1) {
          if (blocks[start]?.type !== 'paragraph') continue;
          let joined = '';
          for (let end = start; end < blocks.length && blocks[end]?.type === 'paragraph'; end += 1) {
            joined += `${joined ? '\n\n' : ''}${blocks[end].text || ''}`;
            if (normalize(joined) === normalize(target)) matches.push({ start, end });
            if (normalize(joined).length > normalize(target).length + 8) break;
          }
        }
        return matches;
      };
      const oldRanges = findRanges(plan.oldText);
      const newRanges = findRanges(plan.newText);
      if (!((oldRanges.length === 1 && newRanges.length === 0) || (oldRanges.length === 0 && newRanges.length === 1))) continue;
      if (oldRanges.length === 1) {
        const { start, end } = oldRanges[0];
        const template = blocks[start];
        const { id: _templateId, ...templateWithoutId } = template;
        contentBlocks = [...blocks.slice(0, start), { ...templateWithoutId, text: plan.newText }, ...blocks.slice(end + 1)];
        blocksChanged = true;
      }
    }
    const updated = {
      ...existing,
      ...(oldMatches ? { content: current.replace(plan.oldText, plan.newText) } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      apaGeneralEffectsReviewMigrationSnapshot: existing.apaGeneralEffectsReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: new Date().toISOString()
      },
      apaGeneralEffectsReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      ...((oldMatches || blocksChanged) ? { localEditedAt: new Date().toISOString() } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaClutterInterventionReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-prevention-environment-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaClutterPreventionEnvironmentReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaClutterPreventionEnvironmentReviewApplied === migrationId
      || typeof existing.content !== 'string' || existing.content.split(plan.oldText).length !== 2) continue;
    const matching = (existing.contentBlocks || []).filter((block) => block?.type === 'paragraph' && block.text === plan.oldText);
    if (matching.length !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: existing.content.replace(plan.oldText, plan.newText),
      contentBlocks: existing.contentBlocks.map((block) => block?.type === 'paragraph' && block.text === plan.oldText ? { ...block, text: plan.newText } : block),
      apaClutterPreventionEnvironmentReviewSnapshot: existing.apaClutterPreventionEnvironmentReviewSnapshot || { migrationId, priorContent: existing.content, priorContentBlocks: existing.contentBlocks, capturedAt: now },
      apaClutterPreventionEnvironmentReviewApplied: migrationId,
      apaClutterPreventionEnvironmentReview: incoming.apaClutterPreventionEnvironmentReview,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaGuatemalaStudentDiagnosisScopeReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-guatemala-student-diagnosis-scope-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaGuatemalaStudentDiagnosisScopeMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaGuatemalaStudentDiagnosisScopeApplied === migrationId
      || typeof existing.content !== 'string') continue;
    let content = existing.content;
    let changed = false;
    for (const { oldText, newText } of plan.replacements || []) {
      const oldCount = content.split(oldText).length - 1;
      const newCount = content.split(newText).length - 1;
      if (oldCount === 0 && newCount === 1) continue;
      if (oldCount !== 1 || newCount !== 0) { changed = false; content = null; break; }
      content = content.replace(oldText, newText);
      changed = true;
    }
    if (content === null) continue;
    const priorBlocks = existing.contentBlocks;
    let contentBlocks = priorBlocks;
    let blocksChanged = false;
    if (Array.isArray(priorBlocks)) {
      const paragraphBlocks = priorBlocks.filter((block) => block?.type === 'paragraph' && typeof block.text === 'string');
      let valid = true;
      contentBlocks = priorBlocks.map((block) => {
        if (block?.type !== 'paragraph' || typeof block.text !== 'string') return block;
        let text = block.text;
        let blockChanged = false;
        for (const { oldText, newText } of plan.replacements || []) {
          const oldCount = text.split(oldText).length - 1;
          const newCount = text.split(newText).length - 1;
          if (oldCount === 0 && newCount <= 1) continue;
          if (oldCount !== 1 || newCount !== 0) { valid = false; break; }
          text = text.replace(oldText, newText);
          blockChanged = true;
        }
        blocksChanged ||= blockChanged;
        return blockChanged ? { ...block, text } : block;
      });
      if (!valid) continue;
      for (const { newText } of plan.replacements || []) {
        const targetCount = contentBlocks.filter((block) => block?.type === 'paragraph' && block.text?.includes(newText)).length;
        if ((paragraphBlocks.length && targetCount !== 1) || (!paragraphBlocks.length && targetCount !== 0)) { valid = false; break; }
      }
      if (!valid) continue;
    }
    if ((plan.replacements || []).some(({ newText }) => content.split(newText).length - 1 !== 1)) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...(changed ? { content } : {}),
      ...(blocksChanged ? { contentBlocks } : {}),
      contentReviewState: 'reviewed',
      apaAcademicContentReview: incoming.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: incoming.apaAcademicContentReviewSnapshot || existing.apaAcademicContentReviewSnapshot,
      apaGuatemalaStudentDiagnosisScopeSnapshot: existing.apaGuatemalaStudentDiagnosisScopeSnapshot || {
        migrationId,
        priorContent: changed ? existing.content : null,
        priorContentBlocks: blocksChanged ? priorBlocks : null,
        capturedAt: now
      },
      apaGuatemalaStudentDiagnosisScopeApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      ...((changed || blocksChanged) ? { localEditedAt: now } : {})
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaUniversityClutterDimensionsReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-university-dimensions-review-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaUniversityClutterDimensionsMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaUniversityClutterDimensionsApplied === migrationId
      || existing.title !== plan.priorTitle
      || existing.customGuideNode?.label !== plan.priorGuideLabel
      || existing.content !== plan.priorContent) continue;
    const currentFigures = (existing.contentBlocks || []).filter((block) => block?.type === 'figure').map((block) => block.figureId);
    if (JSON.stringify(currentFigures) !== JSON.stringify(plan.figureIds)) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      title: plan.title,
      customGuideNode: { ...existing.customGuideNode, label: plan.guideLabel },
      content: plan.content,
      contentReviewState: 'reviewed',
      apaAcademicContentReview: incoming.apaAcademicContentReview,
      apaAcademicContentReviewSnapshot: incoming.apaAcademicContentReviewSnapshot || existing.apaAcademicContentReviewSnapshot,
      apaUniversityClutterDimensionsSnapshot: existing.apaUniversityClutterDimensionsSnapshot || {
        migrationId,
        priorTitle: existing.title,
        priorGuideLabel: existing.customGuideNode?.label,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaUniversityClutterDimensionsApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaOriginReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-clutter-origin-claim-review-pwa-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming?.apaOriginReviewMigration;
    if (!plan || plan.migrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaOriginReviewMigrationApplied === migrationId) continue;
    if (existing.content !== plan.oldText) continue;
    const oldParagraphs = (existing.contentBlocks || []).filter((block) => block?.type === 'paragraph' && block.text === plan.oldText);
    if (oldParagraphs.length !== 1) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: plan.newText,
      contentBlocks: existing.contentBlocks.map((block) => block?.type === 'paragraph' && block.text === plan.oldText
        ? { ...block, text: plan.newText } : block),
      apaOriginReviewMigrationSnapshot: existing.apaOriginReviewMigrationSnapshot || {
        migrationId,
        priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks,
        capturedAt: now
      },
      apaOriginReviewMigrationApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaFerrariReferenceReconciliation(sourceEntries, knownEntries) {
  const migrationId = 'apa-ferrari-2018-reference-reconciliation-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.apaFerrariReferenceReconciliationMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const canonical = 'Ferrari, J. R., & Roster, C. A. (2018). Delaying disposing: Examining the relationship between procrastination and clutter across generations. *Current Psychology, 37*(2), 426–431. https://doi.org/10.1007/s12144-017-9679-4';
  const excluded = [
    'Ferrari, J. R., & Roster, C. A. (2018). Delaying, cluttering, and hoarding: How each behavior affects the quality of life. Current Psychology, 37(2), 1–7. https://doi.org/10.1007/s12144-017-9680-y',
    'Ferrari, J. R., & Roster, C. A. (2018). Delaying disposing of possessions: Examining “regular” and “hoarder” types. Current Psychology, 37(2), 414–421. https://doi.org/10.1007/s12144-016-9528-3'
  ];
  const target = splitParagraphs(incoming.content);
  const current = splitParagraphs(existing.content);
  if (target.filter((paragraph) => paragraph === canonical).length !== 1
    || excluded.some((paragraph) => target.includes(paragraph))
    || current.filter((paragraph) => paragraph === canonical).length !== 1) return 0;
  if (existing.apaFerrariReferenceReconciliationApplied === migrationId
    && excluded.every((paragraph) => !current.includes(paragraph))) return 0;
  const updatedParagraphs = current.filter((paragraph) => !excluded.includes(paragraph));
  const updated = {
    ...existing,
    content: updatedParagraphs.join('\n\n'),
    apaFerrariReferenceReconciliationApplied: migrationId,
    apaFerrariReferenceReconciliationSnapshot: incoming.apaFerrariReferenceReconciliationSnapshot,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaCitationAuditVerifiedVariants(sourceEntries, knownEntries) {
  const migrationId = 'apa-audit-verified-reference-variants-2026-10-21-v2';
  const entryId = 'pwa-apa7-unified-bibliography-2026-10-21';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaCitationAuditVariantMigrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.apaCitationAuditVariantMigrationSnapshot;
  if (!incoming || !existing || !snapshot || existing.apaCitationAuditVariantMigrationApplied === migrationId
    || existing.content !== snapshot.content) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    contentReviewNote: incoming.contentReviewNote,
    apaCitationAuditVariantExclusions: incoming.apaCitationAuditVariantExclusions,
    apaCitationAuditVariantMigrationSnapshot: {
      content: existing.content,
      contentReviewNote: existing.contentReviewNote,
      capturedAt: new Date().toISOString()
    },
    apaCitationAuditVariantMigrationApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateOpenAiFigureToolReferenceDescriptor(sourceEntries, knownEntries) {
  const migrationId = 'apa-openai-2026a-tool-reference-descriptor-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'apa-figure-ref-1f16707a299d9a62'
    && entry.apaOpenAiToolReferenceMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const snapshot = incoming.apaOpenAiToolReferenceMigrationSnapshot;
  if (!existing || !snapshot || existing.apaOpenAiToolReferenceMigrationApplied === migrationId
    || existing.content !== snapshot.content
    || existing.apaReferenceRecord?.sourceText !== snapshot.apaReferenceRecord?.sourceText) return 0;

  const updated = {
    ...existing,
    content: incoming.content,
    apaReferenceRecord: incoming.apaReferenceRecord,
    contentReviewNote: incoming.contentReviewNote,
    apaOpenAiToolReferenceMigrationSnapshot: {
      content: existing.content,
      apaReferenceRecord: existing.apaReferenceRecord,
      contentReviewNote: existing.contentReviewNote || null,
      capturedAt: new Date().toISOString()
    },
    apaOpenAiToolReferenceMigrationApplied: migrationId,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateOpenAiFigureCitationMetadata2026a(sourceEntries, knownEntries) {
  const migrationId = 'apa-openai-figure-citation-metadata-align-2026a-2026-10-21-v1';
  let migrated = 0;
  for (const incoming of sourceEntries) {
    if (incoming?.apaOpenAi2026aFigureCitationMigrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const snapshots = incoming.apaOpenAi2026aFigureCitationMigrationSnapshot;
    const changes = incoming.apaOpenAi2026aFigureCitationMigrationChanges;
    if (!existing || !Array.isArray(snapshots) || !Array.isArray(changes)
      || existing.apaOpenAi2026aFigureCitationMigrationApplied === migrationId
      || snapshots.length !== changes.length || !snapshots.length) continue;
    const figureCitations = { ...(existing.figureCitations || {}) };
    const valid = snapshots.every((snapshot) => {
      const current = figureCitations[snapshot.figureId];
      const change = changes.find((candidate) => candidate.figureId === snapshot.figureId);
      return current && change && current.year === snapshot.year
        && (current.aiToolDescription || null) === snapshot.aiToolDescription
        && current.creditNote?.includes('(OpenAI, 2026a)')
        && change.current.year === '2026a';
    });
    if (!valid) continue;
    for (const snapshot of snapshots) {
      figureCitations[snapshot.figureId] = { ...figureCitations[snapshot.figureId], year: '2026a' };
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      figureCitations,
      apaOpenAi2026aFigureCitationMigrationSnapshot: snapshots,
      apaOpenAi2026aFigureCitationMigrationApplied: migrationId,
      localEditedAt: now,
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    migrated += snapshots.length;
  }
  return migrated;
}

async function migrateApaOpenAi2025SupersededFigureReference(sourceEntries, knownEntries) {
  const migrationId = 'apa-openai-2025-figure-reference-superseded-by-2026a-2026-10-21-v1';
  const entryId = 'apa-figure-ref-f9b112d9a363202c';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaOpenAi2025SupersessionMigrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.apaOpenAi2025SupersessionMigrationSnapshot;
  const oldSourceText = 'OpenAI. (2025). *ChatGPT* [Asistente de inteligencia artificial generativa]. https://chatgpt.com/';
  if (!incoming || !existing || !snapshot || existing.apaOpenAi2025SupersessionMigrationApplied === migrationId
    || existing.apaReferenceRecord?.author !== 'OpenAI' || existing.apaReferenceRecord?.year !== '2025'
    || existing.apaReferenceRecord?.sourceText !== oldSourceText) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    apaReferenceRecord: {
      ...existing.apaReferenceRecord,
      bibliographyDisposition: 'excluded-superseded-transcription',
      supersededByReferenceEntryId: 'apa-figure-ref-1f16707a299d9a62',
      dispositionReason: 'Las figuras vinculadas fueron generadas por el usuario en 2026. La candidata activa correspondiente es OpenAI (2026a); se excluye el año 2025 transcrito anteriormente sin eliminar esta ficha ni su procedencia.'
    },
    apaExcludedReferenceLines: [...new Set([...(existing.apaExcludedReferenceLines || []), oldSourceText])],
    apaOpenAi2025SupersessionMigrationSnapshot: {
      migrationId,
      title: existing.title,
      content: existing.content,
      apaReferenceRecord: existing.apaReferenceRecord,
      apaExcludedReferenceLines: existing.apaExcludedReferenceLines || [],
      contentReviewNote: existing.contentReviewNote || null,
      capturedAt: now
    },
    apaOpenAi2025SupersessionMigrationApplied: migrationId,
    contentReviewNote: [existing.contentReviewNote, incoming.contentReviewNote].filter(Boolean).join('\n\n'),
    localEditedAt: now,
    updatedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateApaWcag22CanonicalReference(sourceEntries, knownEntries) {
  const migrationId = 'apa-wcag22-2023-canonical-reference-2026-10-21-v2';
  const incoming = sourceEntries.find((entry) => entry?.apaWcag22CanonicalMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  if (!existing) return 0;
  const splitParagraphs = (content) => String(content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const canonical = 'World Wide Web Consortium. (2023, October 5). *Web content accessibility guidelines (WCAG) 2.2*. https://www.w3.org/TR/2023/REC-WCAG22-20231005/';
  const obsolete = [
    'W3C. (2023). Web content accessibility guidelines (WCAG) 2.2. World Wide Web Consortium.',
    'World Wide Web Consortium. (2024, December 12). *Web content accessibility guidelines (WCAG) 2.2*. https://www.w3.org/TR/WCAG22/'
  ];
  const target = splitParagraphs(incoming.content);
  const current = splitParagraphs(existing.content);
  if (target.filter((paragraph) => paragraph === canonical).length !== 1
    || obsolete.some((paragraph) => target.includes(paragraph))
    || current.filter((paragraph) => paragraph === canonical).length !== 1
    || obsolete.some((paragraph) => current.filter((item) => item === paragraph).length > 1)) return 0;
  if (existing.apaWcag22CanonicalMigrationApplied === migrationId && !obsolete.some((paragraph) => current.includes(paragraph))) return 0;
  const updated = {
    ...existing,
    content: current.filter((paragraph) => !obsolete.includes(paragraph)).join('\n\n'),
    apaWcag22CanonicalMigrationApplied: migrationId,
    apaWcag22CanonicalMigrationSnapshot: incoming.apaWcag22CanonicalMigrationSnapshot,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateApaAkimova2020CitationReconciliation(sourceEntries, knownEntries) {
  const migrationId = 'apa-akimova-2020-citation-reconciliation-2026-10-21-v1';
  let updatedCount = 0;
  const citation = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-illustration'
    && entry.apaAkimova2020MigrationId === migrationId);
  const citationEntry = citation && knownEntries.get(citation.id);
  const citationSnapshot = citation?.apaAkimova2020MigrationSnapshot;
  if (citationEntry && citationSnapshot && citationEntry.apaAkimova2020MigrationApplied !== migrationId
    && citationEntry.title === citationSnapshot.title) {
    const oldSentence = 'La ilustración editorial puede acompañar un texto y ayudar a expresar su idea y tono (Akimova, 2020).';
    const newSentence = 'La ilustración editorial puede acompañar un texto y ayudar a expresar su idea y tono (E. Akimova, 2020).';
    const contentMatches = String(citationEntry.content || '').split(oldSentence).length - 1;
    const blockMatches = (citationEntry.contentBlocks || []).reduce((count, block) => count
      + (block.type === 'paragraph' && typeof block.text === 'string' ? block.text.split(oldSentence).length - 1 : 0), 0);
    if (contentMatches === 1 && blockMatches === 1) {
      const updated = {
        ...citationEntry,
        content: citationEntry.content.replace(oldSentence, newSentence),
        contentBlocks: citationEntry.contentBlocks.map((block) => block.type === 'paragraph' && typeof block.text === 'string'
          ? { ...block, text: block.text.replace(oldSentence, newSentence) } : block),
        apaAkimova2020MigrationSnapshot: { ...citationSnapshot, appliedAt: new Date().toISOString() },
        apaAkimova2020MigrationApplied: migrationId,
        localEditedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updatedCount += 1;
    }
  }

  const bibliography = sourceEntries.find((entry) => entry?.apaAkimova2020BibliographyMigrationId === migrationId);
  const existingBibliography = bibliography && knownEntries.get(bibliography.id);
  const bibliographySnapshot = bibliography?.apaAkimova2020BibliographyMigrationSnapshot;
  const excludedParagraph = 'Akimova, A. (2020). Fundamentals of illustration. ArtPress.';
  if (existingBibliography && bibliographySnapshot && existingBibliography.apaAkimova2020BibliographyMigrationApplied !== migrationId
    && bibliographySnapshot.content?.split(/\r?\n\s*\r?\n/).includes(excludedParagraph)
    && !bibliography.content?.split(/\r?\n\s*\r?\n/).includes(excludedParagraph)) {
    const paragraphs = String(existingBibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    if (paragraphs.includes(excludedParagraph)) {
      const updated = {
        ...existingBibliography,
        content: paragraphs.filter((paragraph) => paragraph !== excludedParagraph).join('\n\n'),
        apaAkimova2020BibliographyMigrationApplied: migrationId,
        localEditedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updatedCount += 1;
    }
  }

  const sourceRecord = sourceEntries.find((entry) => entry?.id === 'apa-ref-a3243abe0484f459bc66'
    && entry.apaAkimova2020SourceMigrationId === migrationId);
  const existingSourceRecord = sourceRecord && knownEntries.get(sourceRecord.id);
  const sourceSnapshot = sourceRecord?.apaAkimova2020SourceMigrationSnapshot;
  if (existingSourceRecord && sourceSnapshot && existingSourceRecord.apaAkimova2020SourceMigrationApplied !== migrationId
    && existingSourceRecord.apaReferenceRecord?.sourceText === sourceSnapshot.apaReferenceRecord?.sourceText
    && !existingSourceRecord.apaReferenceRecord?.bibliographyDisposition) {
    const updated = {
      ...existingSourceRecord,
      apaReferenceRecord: sourceRecord.apaReferenceRecord,
      contentReviewNote: sourceRecord.contentReviewNote,
      apaAkimova2020SourceMigrationSnapshot: { ...sourceSnapshot, appliedAt: new Date().toISOString() },
      apaAkimova2020SourceMigrationApplied: migrationId,
      localEditedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaAkimova2020AuthorDateFormat(sourceEntries, knownEntries) {
  const migrationId = 'apa-akimova-2020-author-date-surname-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-illustration'
    && entry.apaAkimovaAuthorDateMigrationId === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const oldCitation = '(E. Akimova, 2020)';
  const newCitation = '(Akimova, 2020)';
  if (!incoming || !existing || existing.apaAkimovaAuthorDateMigrationApplied === migrationId
    || existing.title !== incoming.title) return 0;

  const content = String(existing.content || '');
  const blocks = (existing.contentBlocks || []).map((block) => ({ ...block }));
  const contentMatches = content.split(oldCitation).length - 1;
  const blockMatches = blocks.reduce((count, block) => count
    + (block.type === 'paragraph' && typeof block.text === 'string' ? block.text.split(oldCitation).length - 1 : 0), 0);
  if (contentMatches !== 1 || blockMatches !== 1) return 0;

  const updated = {
    ...existing,
    content: content.replace(oldCitation, newCitation),
    contentBlocks: blocks.map((block) => block.type === 'paragraph' && typeof block.text === 'string'
      ? { ...block, text: block.text.replace(oldCitation, newCitation) } : block),
    apaAkimovaAuthorDateSnapshot: {
      title: existing.title,
      priorContent: content,
      priorContentBlocks: existing.contentBlocks,
      correctedFrom: oldCitation,
      correctedTo: newCitation,
      capturedAt: new Date().toISOString()
    },
    apaAkimovaAuthorDateMigrationApplied: migrationId,
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    contentReviewNote: incoming.contentReviewNote,
    sourceBundleRevision: incoming.sourceBundleRevision,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaResearchParticipantAttributions(sourceEntries, knownEntries) {
  const migrationId = 'apa-research-participant-attributions-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    if (!incoming || incoming.apaResearchParticipantMigrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaResearchParticipantMigrationSnapshot;
    const replacements = incoming.apaResearchParticipantTextReplacements;
    if (!existing || !snapshot || !Array.isArray(replacements) || !replacements.length
      || existing.apaResearchParticipantMigrationApplied === migrationId || existing.title !== snapshot.title) continue;
    let content = String(existing.content || '');
    const contentBlocks = (existing.contentBlocks || []).map((block) => ({ ...block }));
    let applicable = true;
    for (const replacement of replacements) {
      if (typeof replacement.from !== 'string' || typeof replacement.to !== 'string' || !replacement.from) {
        applicable = false;
        break;
      }
      const contentMatches = content.split(replacement.from).length - 1;
      const blockMatches = contentBlocks.reduce((count, block) => count
        + (typeof block.text === 'string' ? block.text.split(replacement.from).length - 1 : 0), 0);
      if (contentMatches !== 1 || blockMatches !== 1) {
        applicable = false;
        break;
      }
      content = content.replace(replacement.from, replacement.to);
      const targetBlock = contentBlocks.find((block) => typeof block.text === 'string' && block.text.includes(replacement.from));
      targetBlock.text = targetBlock.text.replace(replacement.from, replacement.to);
    }
    if (!applicable) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content,
      contentBlocks,
      contentReviewNote: incoming.contentReviewNote,
      apaResearchParticipantMigrationApplied: migrationId,
      localEditedAt: now,
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateApaBecker2024InTextCitation(sourceEntries, knownEntries) {
  const migrationId = 'apa-becker-2024-intext-citation-date-2026-10-21-v1';
  const entryId = 'idml-r1-u3dcd';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaBecker2024InTextCitationMigrationId === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.apaBecker2024InTextCitationMigrationSnapshot;
  const before = snapshot?.paragraphBefore;
  const after = snapshot?.paragraphAfter;
  if (!incoming || !existing || !snapshot || existing.apaBecker2024InTextCitationMigrationApplied === migrationId
    || !before || !after) return 0;
  const content = String(existing.content || '');
  const blocks = Array.isArray(existing.contentBlocks) ? existing.contentBlocks : [];
  const paragraphBlocks = blocks.filter((block) => block?.type === 'paragraph');
  if (content.split(before).length - 1 !== 1
    || paragraphBlocks.filter((block) => block.text === before).length !== 1) return 0;
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: content.replace(before, after),
    contentBlocks: blocks.map((block) => block?.type === 'paragraph' && block.text === before
      ? { ...block, text: after } : block),
    apaBecker2024InTextCitationMigrationSnapshot: {
      migrationId,
      paragraphBefore: before,
      contentBefore: content,
      contentBlocksBefore: blocks,
      sourceReferenceEntryId: snapshot.sourceReferenceEntryId,
      canonicalReferenceEntryId: snapshot.canonicalReferenceEntryId,
      rationale: snapshot.rationale,
      capturedAt: now
    },
    apaBecker2024InTextCitationMigrationApplied: migrationId,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateApaUncitedChionForcevilleReferences(sourceEntries, knownEntries) {
  const migrationId = 'apa-remove-uncited-chion-forceville-references-2026-10-21-v1';
  const targets = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaUncitedChionForcevilleMigrationId === migrationId);
  let updates = 0;
  if (!targets) return updates;

  const bibliography = knownEntries.get(targets.id);
  const obsolete = Array.isArray(targets.apaUncitedChionForcevilleMigrationTargets)
    ? targets.apaUncitedChionForcevilleMigrationTargets : [];
  if (bibliography && obsolete.length && bibliography.apaUncitedChionForcevilleMigrationApplied !== migrationId) {
    const paragraphs = String(bibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const counts = obsolete.map((target) => paragraphs.filter((paragraph) => paragraph === target).length);
    if (counts.every((count) => count <= 1) && counts.some(Boolean)) {
      const removedReferences = obsolete.filter((target, index) => counts[index] === 1);
      const now = new Date().toISOString();
      const updated = {
        ...bibliography,
        content: paragraphs.filter((paragraph) => !removedReferences.includes(paragraph)).join('\n\n'),
        apaUncitedChionForcevilleMigrationApplied: migrationId,
        apaUncitedChionForcevilleMigrationSnapshot: {
          migrationId,
          removedReferences,
          contentBefore: bibliography.content,
          capturedAt: now,
          rationale: targets.apaUncitedChionForcevilleMigrationRationale
        },
        localEditedAt: now,
        updatedAt: now
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updates += 1;
    }
  }

  for (const incoming of sourceEntries.filter((entry) => entry?.apaUncitedChionForcevilleSourceDispositionMigrationId === migrationId)) {
    const existing = knownEntries.get(incoming.id);
    const previousRecord = incoming.apaUncitedChionForcevilleSourceDispositionSnapshot;
    if (!existing || !previousRecord || existing.apaReferenceRecord?.bibliographyDisposition === 'excluded-unverified-uncited') continue;
    const currentRecord = existing.apaReferenceRecord;
    if (currentRecord?.author !== previousRecord.author || currentRecord?.year !== previousRecord.year
      || currentRecord?.sourceText !== previousRecord.sourceText) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      apaReferenceRecord: {
        ...currentRecord,
        ...incoming.apaReferenceRecord,
        sourceText: currentRecord.sourceText
      },
      apaUncitedChionForcevilleSourceDispositionSnapshot: currentRecord,
      apaUncitedChionForcevilleSourceDispositionMigrationApplied: migrationId,
      contentReviewNote: incoming.contentReviewNote,
      updatedAt: now,
      localEditedAt: now
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }

  for (const incoming of sourceEntries.filter((entry) => entry?.apaUncitedChionForcevilleSourceListMigrationId === migrationId)) {
    const existing = knownEntries.get(incoming.id);
    if (!existing) continue;
    const excluded = Array.isArray(incoming.apaExcludedReferenceLines) ? incoming.apaExcludedReferenceLines : [];
    const mergedExcluded = [...new Set([...(existing.apaExcludedReferenceLines || []), ...excluded])];
    const updated = {
      ...existing,
      apaExcludedReferenceLines: mergedExcluded,
      apaUncitedChionForcevilleSourceListMigrationId: migrationId,
      apaUncitedChionForcevilleSourceListReview: incoming.apaUncitedChionForcevilleSourceListReview,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    if (JSON.stringify(existing.apaExcludedReferenceLines || []) === JSON.stringify(mergedExcluded)
      && existing.apaUncitedChionForcevilleSourceListMigrationId === migrationId) continue;
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateApaConfirmedUncitedReferences(sourceEntries, knownEntries) {
  const migrationId = 'apa-confirmed-uncited-reference-reconciliation-2026-10-21-v1';
  const incomingBibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaConfirmedUncitedReferencesMigrationId === migrationId);
  let updates = 0;
  if (!incomingBibliography) return updates;

  const bibliography = knownEntries.get(incomingBibliography.id);
  const removedReferences = incomingBibliography.apaConfirmedUncitedReferencesSnapshot?.removedReferences || [];
  if (bibliography && removedReferences.length && bibliography.apaConfirmedUncitedReferencesMigrationApplied !== migrationId) {
    const normalize = normalizeApaAuditText;
    const removedTexts = new Set(removedReferences.map((reference) => normalize(reference.reference)));
    const paragraphs = String(bibliography.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const counts = [...removedTexts].map((text) => paragraphs.filter((paragraph) => normalize(paragraph) === text).length);
    if (counts.every((count) => count === 1)) {
      const contentBefore = bibliography.content;
      const updated = {
        ...bibliography,
        content: paragraphs.filter((paragraph) => !removedTexts.has(normalize(paragraph))).join('\n\n'),
        apaConfirmedUncitedReferencesMigrationApplied: migrationId,
        apaConfirmedUncitedReferencesMigrationSnapshot: {
          migrationId,
          contentBefore,
          removedReferences,
          rationale: incomingBibliography.apaConfirmedUncitedReferencesSnapshot.rationale,
          capturedAt: new Date().toISOString()
        },
        contentReviewNote: incomingBibliography.contentReviewNote,
        localEditedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updates += 1;
    }
  }

  for (const incoming of sourceEntries.filter((entry) => entry?.apaConfirmedUncitedReferencesMigrationId === migrationId
    && entry.id !== incomingBibliography.id)) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaConfirmedUncitedReferencesSnapshot;
    if (!existing || !snapshot || existing.apaConfirmedUncitedReferencesMigrationApplied === migrationId) continue;
    const priorRecord = snapshot.previousReferenceRecord;
    const currentRecord = existing.apaReferenceRecord;
    if (!currentRecord || currentRecord.author !== priorRecord.author || currentRecord.year !== priorRecord.year
      || currentRecord.sourceText !== priorRecord.sourceText) continue;
    const reason = incoming.apaReferenceRecord?.exclusionReason || '';
    const notes = String(existing.contentReviewNote || '').trim();
    const updated = {
      ...existing,
      apaReferenceRecord: {
        ...currentRecord,
        bibliographyDisposition: incoming.apaReferenceRecord.bibliographyDisposition,
        exclusionReason: reason,
        reviewedAt: incoming.apaReferenceRecord.reviewedAt
      },
      apaConfirmedUncitedReferencesSnapshot: {
        ...snapshot,
        previousReferenceRecord: currentRecord,
        sourceContentPreserved: existing.content === incoming.content
      },
      apaConfirmedUncitedReferencesMigrationApplied: migrationId,
      contentReviewNote: notes && notes !== snapshot.previousContentReviewNote ? notes : reason,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }

  for (const incoming of sourceEntries.filter((entry) => entry?.apaConfirmedUncitedReferencesLineSnapshot?.migrationId === migrationId)) {
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.apaConfirmedUncitedReferencesLinesMigrationApplied === migrationId) continue;
    const addedLines = incoming.apaConfirmedUncitedReferencesLineSnapshot.addedExcludedLines || [];
    const excludedLines = [...new Set([...(existing.apaExcludedReferenceLines || []), ...addedLines])];
    const updated = {
      ...existing,
      apaExcludedReferenceLines: excludedLines,
      apaConfirmedUncitedReferencesLinesMigrationApplied: migrationId,
      apaConfirmedUncitedReferencesLineSnapshot: incoming.apaConfirmedUncitedReferencesLineSnapshot,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    if (JSON.stringify(existing.apaExcludedReferenceLines || []) === JSON.stringify(excludedLines)) {
      updated.apaConfirmedUncitedReferencesLinesMigrationApplied = migrationId;
    }
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateApaHistoricalImageCreditLines(sourceEntries, knownEntries) {
  const migrationId = 'apa-remove-historical-image-credit-lines-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21'
    && entry.apaHistoricalImageCreditLinesMigrationId === migrationId);
  if (!incoming) return 0;
  const existing = knownEntries.get(incoming.id);
  const excluded = incoming.apaHistoricalImageCreditLinesSnapshot?.excludedParagraphs || [];
  if (!existing || !excluded.length || existing.apaHistoricalImageCreditLinesMigrationApplied === migrationId) return 0;
  const paragraphs = String(existing.content || '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const normalize = normalizeApaAuditText;
  const excludedTexts = new Set(excluded.map(normalize));
  const counts = [...excludedTexts].map((text) => paragraphs.filter((paragraph) => normalize(paragraph) === text).length);
  if (!counts.every((count) => count === 1)) return 0;
  const updated = {
    ...existing,
    content: paragraphs.filter((paragraph) => !excludedTexts.has(normalize(paragraph))).join('\n\n'),
    apaHistoricalImageCreditLinesMigrationApplied: migrationId,
    apaHistoricalImageCreditLinesRuntimeSnapshot: {
      migrationId,
      contentBefore: existing.content,
      excludedParagraphs: excluded,
      sourceTranscriptionPreserved: true,
      capturedAt: new Date().toISOString()
    },
    contentReviewNote: incoming.contentReviewNote,
    localEditedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateApaCitationAuditCorrections(sourceEntries, knownEntries) {
  const migrationId = 'apa-citation-reference-reconciliation-2026-10-21-v1';
  let updatedCount = 0;
  for (const incoming of sourceEntries) {
    if (!incoming || incoming.apaCitationAuditMigrationId !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaCitationAuditMigrationSnapshot;
    if (!existing || !snapshot || existing.apaCitationAuditMigrationApplied === migrationId) continue;
    if (existing.title !== snapshot.title || existing.content !== snapshot.content) continue;
    if (Array.isArray(snapshot.contentBlocks)
      && JSON.stringify(existing.contentBlocks ?? []) !== JSON.stringify(snapshot.contentBlocks)) continue;
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      content: incoming.content,
      ...(Array.isArray(incoming.contentBlocks) ? { contentBlocks: incoming.contentBlocks } : {}),
      apaCitationAuditMigrationApplied: migrationId,
      localEditedAt: now,
      updatedAt: now
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateCampaigns141Review(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-editorial-review-2026-10-20-v1';
  const updates = [];
  for (const incoming of sourceEntries) {
    if (!incoming || (incoming.campaignReviewMigration !== migrationId
      && incoming.apaReviewMigration !== migrationId)) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing) continue;
    const isCampaign = incoming.id === 'idml-r1-u3f97';
    if (isCampaign) {
      if (existing.campaignReviewMigration === migrationId) continue;
      const snapshot = incoming.campaignReviewSnapshot;
      if (!snapshot || existing.title !== snapshot.title || existing.content !== snapshot.content) continue;
      const expectedParagraphs = (snapshot.contentBlocks || [])
        .filter((block) => block.type === 'paragraph').map((block) => block.text);
      const existingParagraphs = (existing.contentBlocks || [])
        .filter((block) => block.type === 'paragraph').map((block) => block.text);
      if (existingParagraphs.length && JSON.stringify(existingParagraphs) !== JSON.stringify(expectedParagraphs)) continue;
      const localFigures = (existing.contentBlocks || []).filter((block) => block.type === 'figure');
      const localById = new Map(localFigures.filter((block) => block.figureId).map((block) => [block.figureId, block]));
      const contentBlocks = (incoming.contentBlocks || []).map((block) => {
        if (block.type !== 'figure') return block;
        const local = localById.get(block.figureId);
        return local ? { ...block, ...local } : block;
      });
      updates.push({
        ...existing,
        title: incoming.title,
        content: incoming.content,
        contentBlocks,
        figureCitations: { ...(incoming.figureCitations || {}), ...(existing.figureCitations || {}) },
        campaignReviewSnapshot: incoming.campaignReviewSnapshot,
        campaignReviewMigration: migrationId,
        contentReviewState: incoming.contentReviewState,
        contentReviewNote: incoming.contentReviewNote,
        sourceBundleRevision: incoming.sourceBundleRevision,
        updatedAt: new Date().toISOString(),
        localEditedAt: new Date().toISOString()
      });
      continue;
    }
    if (existing.apaReviewMigration === migrationId) continue;
    const snapshot = incoming.apaReviewMigrationSnapshot;
    if (!snapshot || existing.title !== snapshot.title || existing.content !== snapshot.content) continue;
    updates.push({
      ...existing,
      title: incoming.title,
      content: incoming.content,
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      apaReviewMigrationSnapshot: incoming.apaReviewMigrationSnapshot,
      apaReviewMigration: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }
  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function migrateLocalDimeAcademicReview(sourceEntries, knownEntries) {
  const migrationId = 'apa-local-communication-dime-review-2026-10-22-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u2d9f'
    && entry.apaLocalDimeReviewSnapshot?.migrationId === migrationId);
  if (!incoming) return 0;
  const snapshot = incoming.apaLocalDimeReviewSnapshot;
  let updatedCount = 0;
  const existing = knownEntries.get(incoming.id);
  if (existing && existing.apaLocalDimeReviewRuntimeApplied !== migrationId
    && existing.title === snapshot.title && existing.content === snapshot.content
    && JSON.stringify(existing.contentBlocks || []) === JSON.stringify(snapshot.contentBlocks || [])
    && JSON.stringify(existing.figureCitations || {}) === JSON.stringify(snapshot.figureCitations || {})
    && JSON.stringify((existing.contentBlocks || []).filter((block) => block.type === 'figure').map((block) => block.figureId))
      === JSON.stringify(snapshot.figureIds || [])) {
    const localFigures = new Map((existing.contentBlocks || []).filter((block) => block.type === 'figure')
      .map((block) => [block.figureId, block]));
    const contentBlocks = (incoming.contentBlocks || []).map((block) => {
      if (block.type !== 'figure') return block;
      const local = localFigures.get(block.figureId);
      return local ? { ...block, src: local.src || block.src, filename: local.filename || block.filename,
        citation: { ...(local.citation || {}), ...(block.citation || {}) } } : block;
    });
    const figureCitations = { ...(existing.figureCitations || {}), ...(incoming.figureCitations || {}) };
    for (const [figureId, citation] of Object.entries(existing.figureCitations || {})) {
      if (citation.permissionStatus && citation.permissionStatus !== 'unknown' && figureCitations[figureId]) {
        figureCitations[figureId].permissionStatus = citation.permissionStatus;
      }
    }
    const updated = {
      ...existing,
      title: incoming.title,
      content: incoming.content,
      contentBlocks,
      figureCitations,
      contentReviewState: 'reviewed',
      contentReviewNote: incoming.contentReviewNote,
      apaAcademicContentReview: incoming.apaAcademicContentReview,
      apaLocalDimeReviewRuntimeSnapshot: {
        migrationId, priorTitle: existing.title, priorContent: existing.content,
        priorContentBlocks: existing.contentBlocks, priorFigureCitations: existing.figureCitations,
        capturedAt: new Date().toISOString()
      },
      apaLocalDimeReviewRuntimeApplied: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }

  const reference = sourceEntries.find((entry) => entry?.id === 'apa-figure-ref-f20dca47eba1f6cf');
  const localReference = reference && knownEntries.get(reference.id);
  if (reference && localReference && localReference.apaLocalDimeReviewRuntimeApplied !== migrationId
    && localReference.title === snapshot.refTitle && localReference.content === snapshot.refContent
    && localReference.apaReferenceRecord?.year === 2022
    && String(localReference.apaReferenceRecord?.sourceText || '').includes('2022, 9 de agosto')) {
    const updated = { ...localReference, title: reference.title, content: reference.content,
      apaReferenceRecord: reference.apaReferenceRecord,
      apaLocalDimeReviewRuntimeSnapshot: { title: localReference.title, content: localReference.content, capturedAt: new Date().toISOString() },
      apaLocalDimeReviewRuntimeApplied: migrationId, sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(), localEditedAt: new Date().toISOString() };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }

  const bibliography = sourceEntries.find((entry) => entry?.id === 'pwa-apa7-unified-bibliography-2026-10-21');
  const localBibliography = bibliography && knownEntries.get(bibliography.id);
  if (bibliography && localBibliography && localBibliography.apaLocalDimeReviewRuntimeApplied !== migrationId
    && localBibliography.content === snapshot.bibliographyContent) {
    const updated = { ...localBibliography, content: bibliography.content,
      apaLocalDimeReviewRuntimeSnapshot: { content: localBibliography.content, capturedAt: new Date().toISOString() },
      apaLocalDimeReviewRuntimeApplied: migrationId, sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(), localEditedAt: new Date().toISOString() };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updatedCount += 1;
  }
  return updatedCount;
}

async function migrateDimeCanonicalAtlasNumbering(sourceEntries, knownEntries) {
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u2d9f'
    && entry.apaDimeCanonicalNumbering?.migrationId === 'apa-local-dime-canonical-atlas-numbering-2026-10-22-v1');
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.apaDimeCanonicalNumberingSnapshot;
  if (!incoming || !existing || !snapshot || existing.apaDimeCanonicalNumberingRuntimeApplied === snapshot.migrationId
    || (existing.title !== incoming.title && existing.title !== incoming.apaLocalDimeReviewSnapshot?.title)
    || existing.content !== snapshot.priorContent
    || JSON.stringify(existing.contentBlocks || []) !== JSON.stringify(snapshot.priorContentBlocks || [])
    || JSON.stringify((existing.contentBlocks || []).filter((block) => block.type === 'figure').map((block) => block.figureId))
      !== JSON.stringify(snapshot.figureIds || [])) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: incoming.contentBlocks,
    apaDimeCanonicalNumbering: incoming.apaDimeCanonicalNumbering,
    apaDimeCanonicalNumberingRuntimeSnapshot: {
      migrationId: snapshot.migrationId,
      priorContent: existing.content,
      priorContentBlocks: existing.contentBlocks,
      capturedAt: new Date().toISOString()
    },
    apaDimeCanonicalNumberingRuntimeApplied: snapshot.migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision || existing.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateLocalCampaignAtlasNumbers(sourceEntries, knownEntries) {
  let count = 0;
  for (const incoming of sourceEntries) {
    const plan = incoming.atlasNumberAlignment;
    if (plan?.migrationId !== 'atlas-local-campaign-numbers-2026-10-22-v1') continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.atlasNumberAlignmentApplied === plan.migrationId) continue;
    const escapedNumber = plan.from.replaceAll('.', '\\.');
    const numberPattern = new RegExp(`^${escapedNumber}(?=\\.|[ \\t])`, 'gm');
    const align = value => String(value || '').replace(numberPattern, plan.to);
    const updated = { ...existing, title: align(existing.title), content: align(existing.content),
      contentBlocks: existing.contentBlocks?.map(block => block.type === 'paragraph' ? { ...block, text: align(block.text) } : block),
      atlasNumberAlignment: plan, atlasNumberAlignmentApplied: plan.migrationId,
      atlasNumberAlignmentRuntimeSnapshot: { title: existing.title, content: existing.content, contentBlocks: existing.contentBlocks, capturedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(), localEditedAt: new Date().toISOString() };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    count += 1;
  }
  return count;
}

async function migrateCampaignFigureCreditNotes(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-figure-credit-note-2026-10-20-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3f97'
    && entry.campaignFigureCaptionMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  if (!incoming || !existing || existing.campaignFigureCaptionMigration === migrationId) return 0;
  const snapshotFigure = incoming.campaignReviewSnapshot?.contentBlocks
    ?.find((block) => block.type === 'figure' && block.figureId === 'generated-ai-assisted:campaign-two-proposed-phases');
  const incomingFigure = incoming.contentBlocks?.find((block) => block.type === 'figure'
    && block.figureId === 'generated-ai-assisted:campaign-two-proposed-phases');
  if (!snapshotFigure || !incomingFigure) return 0;
  let captionChanged = false;
  const contentBlocks = (existing.contentBlocks || []).map((block) => {
    if (block.type !== 'figure' || block.figureId !== incomingFigure.figureId) return block;
    if (block.caption === snapshotFigure.caption) {
      captionChanged = block.caption !== incomingFigure.caption;
      return { ...block, caption: incomingFigure.caption };
    }
    return block;
  });
  if (!captionChanged) {
    existing.campaignFigureCaptionMigration = migrationId;
    await putEntry(existing);
    knownEntries.set(existing.id, existing);
    return 0;
  }
  const updated = {
    ...existing,
    contentBlocks,
    campaignFigureCaptionMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateCampaigns141AudienceReview(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-audience-alignment-2026-10-20-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3f97'
    && entry.campaignAudienceReviewMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.campaignAudienceReviewSnapshot;
  if (!incoming || !existing || existing.campaignAudienceReviewMigration === migrationId
    || !snapshot || existing.title !== incoming.title || existing.content !== snapshot.content) return 0;
  const expectedParagraphs = (snapshot.contentBlocks || [])
    .filter((block) => block.type === 'paragraph').map((block) => block.text);
  const existingParagraphs = (existing.contentBlocks || [])
    .filter((block) => block.type === 'paragraph').map((block) => block.text);
  if (existingParagraphs.length && JSON.stringify(existingParagraphs) !== JSON.stringify(expectedParagraphs)) return 0;
  const localFigures = (existing.contentBlocks || []).filter((block) => block.type === 'figure');
  const localById = new Map(localFigures.filter((block) => block.figureId).map((block) => [block.figureId, block]));
  const contentBlocks = (incoming.contentBlocks || []).map((block) => {
    if (block.type !== 'figure') return block;
    const local = localById.get(block.figureId);
    return local ? { ...block, ...local } : block;
  });
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks,
    campaignAudienceReviewSnapshot: incoming.campaignAudienceReviewSnapshot,
    campaignAudienceReviewMigration: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateCampaigns141AudienceRange(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-audience-range-18-30-2026-10-20-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3f97'
    && entry.campaignAudienceRangeMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.campaignAudienceRangeSnapshot;
  if (!incoming || !existing || existing.campaignAudienceRangeMigration === migrationId
    || !snapshot || existing.title !== incoming.title || existing.content !== snapshot.content) return 0;
  const expectedParagraphs = (snapshot.contentBlocks || [])
    .filter((block) => block.type === 'paragraph').map((block) => block.text);
  const existingParagraphs = (existing.contentBlocks || [])
    .filter((block) => block.type === 'paragraph').map((block) => block.text);
  if (existingParagraphs.length && JSON.stringify(existingParagraphs) !== JSON.stringify(expectedParagraphs)) return 0;
  const localFigures = (existing.contentBlocks || []).filter((block) => block.type === 'figure');
  const localById = new Map(localFigures.filter((block) => block.figureId).map((block) => [block.figureId, block]));
  const contentBlocks = (incoming.contentBlocks || []).map((block) => {
    if (block.type !== 'figure') return block;
    const local = localById.get(block.figureId);
    return local ? { ...block, ...local } : block;
  });
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks,
    campaignAudienceRangeSnapshot: incoming.campaignAudienceRangeSnapshot,
    campaignAudienceRangeMigration: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateCampaignFigureCreditSuffix(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-figure-credit-suffix-2026-10-20-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3f97'
    && entry.campaignFigureCreditSuffixMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  if (!incoming || !existing || existing.campaignFigureCreditSuffixMigration === migrationId) return 0;
  const figureId = 'generated-ai-assisted:campaign-two-proposed-phases';
  const incomingCitation = incoming.figureCitations?.[figureId];
  const existingCitation = existing.figureCitations?.[figureId];
  const priorCredit = String(existingCitation?.creditNote || '');
  const expectedPriorCredit = String(incomingCitation?.creditNote || '').replace('(OpenAI, 2026a)', '(OpenAI, 2026)');
  if (!incomingCitation || !existingCitation || priorCredit !== expectedPriorCredit) {
    existing.campaignFigureCreditSuffixMigration = migrationId;
    await putEntry(existing);
    knownEntries.set(existing.id, existing);
    return 0;
  }
  const updated = {
    ...existing,
    figureCitations: {
      ...(existing.figureCitations || {}),
      [figureId]: { ...existingCitation, creditNote: incomingCitation.creditNote, year: incomingCitation.year }
    },
    campaignFigureCreditSuffixMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateCampaignConceptIllustrations(sourceEntries, knownEntries) {
  const migrationId = 'campaigns-1-4-1-concept-illustrations-v4-2026-10-21';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3f97'
    && entry.campaignConceptIllustrationsMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  if (!incoming || !existing || existing.campaignConceptIllustrationsMigration === migrationId) return 0;
  const incomingParagraphs = (incoming.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text);
  const existingParagraphs = (existing.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text);
  if (JSON.stringify(incomingParagraphs) !== JSON.stringify(existingParagraphs)) return 0;
  const localFigures = new Map((existing.contentBlocks || [])
    .filter((block) => block.type === 'figure' && block.figureId).map((block) => [block.figureId, block]));
  const contentBlocks = incoming.contentBlocks.map((block) => {
    if (block.type !== 'figure') return block;
    const local = localFigures.get(block.figureId);
    return local ? { ...block, ...local, src: block.src, filename: block.filename, alt: block.alt } : block;
  });
  const updated = {
    ...existing,
    contentBlocks,
    figureCitations: { ...(existing.figureCitations || {}), ...(incoming.figureCitations || {}) },
    campaignConceptIllustrationsMigration: migrationId,
    campaignConceptIllustrationsSource: incoming.campaignConceptIllustrationsSource,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateDesignCasesSubject146147Review(sourceEntries, knownEntries) {
  const migrationId = 'design-cases-subject-146-147-source-and-interview-review-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.design146147ReviewMigration === migrationId && entry.design146147ReviewSnapshot);
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.design146147ReviewSnapshot;
    if (!existing || existing.design146147ReviewMigration === migrationId) continue;
    const localBlocks = existing.contentBlocks || [];
    const localParagraphs = localBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text);
    const snapshotParagraphs = (snapshot.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text);
    const textMatchesSnapshot = existing.title === snapshot.title && existing.content === snapshot.content
      && localParagraphs.length === snapshotParagraphs.length
      && localParagraphs.every((text, index) => text === snapshotParagraphs[index]);
    if (!textMatchesSnapshot) continue;

    const localFigures = localBlocks.filter((block) => block.type === 'figure');
    const figuresById = new Map(localFigures.filter((figure) => figure.figureId).map((figure) => [figure.figureId, figure]));
    const retainedIds = new Set();
    const contentBlocks = (incoming.contentBlocks || []).map((block) => {
      if (block.type !== 'figure') return block;
      const local = figuresById.get(block.figureId);
      if (!local) return block;
      retainedIds.add(local.figureId);
      return {
        ...local,
        ...(block.provenanceReview ? { provenanceReview: block.provenanceReview } : {}),
        ...(block.permissionReview ? { permissionReview: block.permissionReview } : {})
      };
    });
    contentBlocks.push(...localFigures.filter((figure) => figure.figureId && !retainedIds.has(figure.figureId)));
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks,
      contentReviewState: incoming.contentReviewState,
      contentReviewNote: incoming.contentReviewNote,
      design146147Evidence: incoming.design146147Evidence,
      design146147ReviewSnapshot: {
        title: existing.title,
        content: existing.content,
        contentBlocks: localBlocks,
        migratedAt: new Date().toISOString()
      },
      design146147ReviewMigration: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateDesignSubjectInterviewEvidenceAudit(sourceEntries, knownEntries) {
  const migrationId = 'design-subject-interview-evidence-audit-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3a09'
    && entry.designSubjectInterviewAuditMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.designSubjectInterviewAuditSnapshot;
  const previousParagraph = snapshot?.previousParagraph;
  const updatedParagraph = incoming?.designSubjectInterviewAudit?.summaryParagraph;
  if (!existing || !snapshot || !previousParagraph || !updatedParagraph
    || existing.designSubjectInterviewAuditMigration === migrationId
    || !existing.content?.includes(previousParagraph)
    || existing.content.split(previousParagraph).length !== 2) return 0;

  const contentBlocks = Array.isArray(existing.contentBlocks)
    ? existing.contentBlocks.map((block) => block?.type === 'paragraph' && block.text === previousParagraph
      ? { ...block, text: updatedParagraph } : block)
    : existing.contentBlocks;
  const updated = {
    ...existing,
    content: existing.content.replace(previousParagraph, updatedParagraph),
    ...(Array.isArray(existing.contentBlocks) ? { contentBlocks } : {}),
    designSubjectInterviewAudit: incoming.designSubjectInterviewAudit,
    designSubjectInterviewAuditSnapshot: {
      previousParagraph,
      previousAudit: existing.designSubjectInterviewAudit || null,
      capturedAt: new Date().toISOString()
    },
    designSubjectInterviewAuditMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(incoming.id, updated);
  return 1;
}

async function migrateDesignSubjectPhotoPermissionReview(sourceEntries, knownEntries) {
  const migrationId = 'design-subject-photo-permission-evidence-2026-10-21-v1';
  const figureId = 'recovered:idml-r1-u3a09:blocks:2:Sujeto de estudio 3 Johnatan Aceituno.jpg';
  const bundled = sourceEntries.find((entry) => entry?.id === 'idml-r1-u3a09');
  const sourceCitation = bundled?.figureCitations?.[figureId];
  const existing = knownEntries.get('idml-r1-u3a09');
  const localCitation = existing?.figureCitations?.[figureId];
  if (!existing || !sourceCitation || !localCitation || existing.designSubjectPhotoPermissionMigration === migrationId) return 0;
  const priorEvidence = 'La leyenda incorporada en la entrada indica que la imagen fue proporcionada por el Lic. Johnatan Aceituno y utilizada con su consentimiento; no identifica a quien tomó la fotografía.';
  if (localCitation.permissionStatus !== 'granted' || localCitation.permissionEvidence !== priorEvidence) return 0;

  const permissionEvidence = 'El pie original afirma que la imagen se utilizó con consentimiento, pero no se localizó una constancia independiente en la PWA. No tratar la autorización o las condiciones de reproducción como verificadas.';
  const creditNote = 'Nota. Fotografía atribuida a Johnatan Aceituno (comunicación personal, 2025); el pie original afirma que se utilizó con consentimiento, pero no se localizó constancia en la PWA. Autoría fotográfica no identificada.';
  const contentBlocks = (existing.contentBlocks || []).map((block) => block?.type === 'figure' && block.figureId === figureId
    ? {
      ...block,
      alt: 'Fotografía atribuida a Johnatan Aceituno (2025); constancia de consentimiento no localizada en la PWA.',
      caption: 'Fotografía atribuida a Johnatan Aceituno (2025). La leyenda original afirma que se utilizó con consentimiento; constancia no localizada en la PWA.',
      permissionReview: { state: 'consent-claimed-in-original-caption-but-evidence-not-located', evidenceLocated: false, reviewNote: 'Confirmar consentimiento y condiciones de reproducción antes de difundir o exportar la imagen.' }
    }
    : block);
  const updated = {
    ...existing,
    contentBlocks,
    figureCitations: {
      ...existing.figureCitations,
      [figureId]: {
        ...localCitation,
        permissionStatus: 'unknown',
        permissionEvidence,
        figureTitle: 'Fotografía atribuida a Johnatan Aceituno (2025); consentimiento pendiente de verificación.',
        creditNote
      }
    },
    designSubjectPhotoPermissionSnapshot: {
      permissionStatus: localCitation.permissionStatus,
      permissionEvidence: localCitation.permissionEvidence,
      figureTitle: localCitation.figureTitle,
      creditNote: localCitation.creditNote,
      contentBlocks: (existing.contentBlocks || []).filter((block) => block?.type === 'figure' && block.figureId === figureId),
      capturedAt: new Date().toISOString()
    },
    designSubjectPhotoPermissionMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateDesignSubjectPhotoAttributionReview(sourceEntries, knownEntries) {
  const migrationId = 'design-subject-photo-attribution-date-apa-review-2026-10-21-v1';
  const entryId = 'idml-r1-u3a09';
  const figureId = 'recovered:idml-r1-u3a09:blocks:2:Sujeto de estudio 3 Johnatan Aceituno.jpg';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.designSubjectPhotoAttributionReviewMigration === migrationId);
  const existing = incoming && knownEntries.get(entryId);
  const snapshot = incoming?.designSubjectPhotoAttributionReviewSnapshot;
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const localCitation = existing?.figureCitations?.[figureId];
  const bundledCitation = snapshot?.citation;
  if (!existing || !snapshot || !localCitation || !bundledCitation
    || existing.designSubjectPhotoAttributionReviewMigration === migrationId
    || existing.title !== snapshot.title || existing.content !== snapshot.content
    || JSON.stringify(normalize(localCitation)) !== JSON.stringify(normalize(bundledCitation))) return 0;
  const beforeBlock = snapshot.contentBlocks?.find((block) => block?.figureId === figureId);
  const localBlock = existing.contentBlocks?.find((block) => block?.figureId === figureId);
  const sourceBlock = incoming.contentBlocks?.find((block) => block?.figureId === figureId);
  if (!beforeBlock || !localBlock || !sourceBlock
    || localBlock.caption !== beforeBlock.caption || localBlock.alt !== beforeBlock.alt) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: existing.contentBlocks.map((block) => block?.figureId === figureId ? {
      ...block,
      alt: sourceBlock.alt,
      caption: sourceBlock.caption,
      permissionReview: sourceBlock.permissionReview
    } : block),
    figureCitations: { ...existing.figureCitations, [figureId]: incoming.figureCitations[figureId] },
    designSubjectPhotoAttributionReviewSnapshot: {
      title: existing.title,
      content: existing.content,
      citation: localCitation,
      contentBlocks: [localBlock],
      capturedAt: new Date().toISOString()
    },
    designSubjectPhotoAttributionReviewMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateDesignFrameworkBundleRecords(sourceEntries, knownEntries) {
  const migrationId = 'pwa-design-framework-sections-2026-10-20-v1';
  const bundled = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  const sourceId = 'idml-r1-u3f97';
  const source = bundled.get(sourceId);
  if (!source?.originalSnapshot?.content || !Array.isArray(source.originalSnapshot.contentBlocks)) return 0;
  const legacyMarker = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const ids = [sourceId, 'atlas-outline-design-websites', 'atlas-outline-design-audiovisual', 'atlas-outline-design-editorial', 'atlas-outline-design-illustration'];
  const updates = [];
  for (const id of ids) {
    const incoming = bundled.get(id);
    const existing = knownEntries.get(id);
    if (!incoming || !existing || existing.designFrameworkSplitMigration === migrationId) continue;
    if (id === sourceId) {
      const matchesArchivedContent = existing.content === source.originalSnapshot.content
        && JSON.stringify(existing.contentBlocks ?? []) === JSON.stringify(source.originalSnapshot.contentBlocks);
      if (!matchesArchivedContent) continue;
      updates.push({
        ...existing,
        content: incoming.content,
        contentBlocks: incoming.contentBlocks,
        originalSnapshot: source.originalSnapshot,
        sourceBundleRevision: incoming.sourceBundleRevision,
        designFrameworkSplitMigration: migrationId,
        updatedAt: new Date().toISOString(),
        localEditedAt: new Date().toISOString()
      });
      continue;
    }
    const hasOnlyUneditedScaffold = existing.content === legacyMarker
      && (!Array.isArray(existing.contentBlocks) || existing.contentBlocks.length === 0);
    if (!hasOnlyUneditedScaffold) continue;
    updates.push({
      ...existing,
      content: incoming.content,
      contentBlocks: incoming.contentBlocks,
      outlineScaffold: false,
      status: incoming.status,
      area: incoming.area,
      contentReviewState: incoming.contentReviewState,
      contentReviewNote: incoming.contentReviewNote,
      sourceBundleRevision: incoming.sourceBundleRevision,
      designFrameworkSplitMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
    delete updates[updates.length - 1].atlasStructuralLabel;
  }
  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function migrateDesignIllustrationCitationReview(sourceEntries, knownEntries) {
  const migrationId = 'design-illustration-citation-review-2026-10-20-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-illustration');
  const existing = knownEntries.get('atlas-outline-design-illustration');
  const snapshot = incoming?.designIllustrationCitationReviewSnapshot;
  if (!incoming || !existing || !snapshot || incoming.designIllustrationCitationReviewMigration !== migrationId
    || existing.designIllustrationCitationReviewMigration === migrationId) return 0;

  // Apply only when the local text still matches the captured pre-review version.
  // Preserve figure/media metadata and skip any entry edited by the user.
  if (existing.title !== incoming.title || existing.content !== snapshot.content
    || JSON.stringify(existing.contentBlocks ?? []) !== JSON.stringify(snapshot.contentBlocks ?? [])) return 0;

  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks: (existing.contentBlocks || []).map((block, index) => {
      const reviewedBlock = incoming.contentBlocks?.[index];
      return block.type === 'paragraph' && reviewedBlock?.type === 'paragraph'
        ? { ...block, text: reviewedBlock.text }
        : block;
    }),
    contentReviewState: 'pending',
    contentReviewNote: incoming.contentReviewNote,
    designIllustrationCitationReviewSnapshot: {
      content: existing.content,
      contentBlocks: existing.contentBlocks,
      migratedAt: new Date().toISOString()
    },
    designIllustrationCitationReviewMigration: migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateDesignIllustration145Review(sourceEntries, knownEntries) {
  const migrationId = 'design-illustration-145-local-evidence-review-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-illustration'
    && entry.designIllustrationReviewMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.designIllustrationReviewSnapshot;
  let updates = 0;

  if (incoming && existing && snapshot && existing.designIllustrationReviewMigration !== migrationId) {
    const localBlocks = existing.contentBlocks || [];
    const snapshotParagraphs = (snapshot.contentBlocks || []).filter((block) => block.type === 'paragraph').map((block) => block.text);
    const localParagraphs = localBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text);
    const legacyScaffold = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
    const matchesUntouchedScaffold = existing.outlineScaffold === true && existing.content === legacyScaffold
      && localBlocks.every((block) => block.type === 'paragraph' || block.type === 'figure')
      && (localParagraphs.join('\n\n') === legacyScaffold || localBlocks.every((block) => block.type === 'figure'));
    const structureIsCompatible = localBlocks.every((block) => block.type === 'paragraph' || block.type === 'figure')
      && snapshotParagraphs.length === localParagraphs.length
      && snapshotParagraphs.every((text, index) => text === localParagraphs[index]);

    // Match unchanged text while retaining locally edited figures and any extra local figures.
    if (existing.title === snapshot.title && ((existing.content === snapshot.content && structureIsCompatible) || matchesUntouchedScaffold)) {
      const localFiguresById = new Map(localBlocks.filter((block) => block.type === 'figure' && block.figureId)
        .map((block) => [block.figureId, block]));
      const retainedFigureIds = new Set();
      const contentBlocks = (incoming.contentBlocks || []).map((block) => {
        if (block.type !== 'figure') return block;
        const local = localFiguresById.get(block.figureId);
        if (!local) return block;
        retainedFigureIds.add(local.figureId);
        return { ...block, ...local };
      });
      contentBlocks.push(...localBlocks.filter((block) => block.type === 'figure' && block.figureId
        && !retainedFigureIds.has(block.figureId)));
      const updated = {
        ...existing,
        content: incoming.content,
        contentBlocks,
        contentReviewState: incoming.contentReviewState,
        contentReviewNote: incoming.contentReviewNote,
        outlineScaffold: false,
        tags: incoming.tags,
        designIllustrationReviewSnapshot: {
          title: existing.title,
          content: existing.content,
          contentBlocks: existing.contentBlocks,
          migratedAt: new Date().toISOString()
        },
        designIllustrationReviewMigration: migrationId,
        designIllustrationReviewEvidence: incoming.designIllustrationReviewEvidence,
        sourceBundleRevision: incoming.sourceBundleRevision,
        updatedAt: new Date().toISOString(),
        localEditedAt: new Date().toISOString()
      };
      await putEntry(updated);
      knownEntries.set(updated.id, updated);
      updates += 1;
    }
  }

  for (const source of sourceEntries.filter((entry) => entry?.designIllustrationReferenceReviewMigration === migrationId)) {
    const existingReference = knownEntries.get(source.id);
    const referenceSnapshot = source.designIllustrationReferenceSnapshot;
    if (!existingReference || !referenceSnapshot || existingReference.designIllustrationReferenceReviewMigration === migrationId
      || existingReference.title !== referenceSnapshot.title || existingReference.content !== referenceSnapshot.content
      || JSON.stringify(existingReference.apaReferenceRecord || null) !== JSON.stringify(referenceSnapshot.apaReferenceRecord || null)) continue;
    const updatedReference = {
      ...existingReference,
      apaReferenceRecord: source.apaReferenceRecord,
      contentReviewNote: source.contentReviewNote,
      designIllustrationReferenceSnapshot: {
        title: existingReference.title,
        content: existingReference.content,
        apaReferenceRecord: existingReference.apaReferenceRecord,
        contentReviewNote: existingReference.contentReviewNote,
        migratedAt: new Date().toISOString()
      },
      designIllustrationReferenceReviewMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updatedReference);
    knownEntries.set(updatedReference.id, updatedReference);
    updates += 1;
  }
  return updates;
}

async function migrateDesignIllustrationSurveyResultReview(sourceEntries, knownEntries) {
  const migrationId = 'design-illustration-local-visual-preference-2026-10-21-v1';
  const incoming = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-illustration'
    && entry.designIllustrationSurveyResultMigration === migrationId);
  const existing = incoming && knownEntries.get(incoming.id);
  const snapshot = incoming?.designIllustrationSurveyResultSnapshot;
  if (!incoming || !existing || !snapshot || existing.designIllustrationSurveyResultMigration === migrationId
    || existing.title !== snapshot.title || existing.content !== snapshot.content) return 0;
  const localBlocks = existing.contentBlocks || [];
  const snapshotParagraphs = (snapshot.contentBlocks || []).filter((block) => block?.type === 'paragraph').map((block) => block.text);
  const localParagraphs = localBlocks.filter((block) => block?.type === 'paragraph').map((block) => block.text);
  if (snapshotParagraphs.length !== localParagraphs.length
    || snapshotParagraphs.some((text, index) => text !== localParagraphs[index])) return 0;
  const localFigures = new Map(localBlocks.filter((block) => block?.type === 'figure' && block.figureId)
    .map((block) => [block.figureId, block]));
  const retainedFigureIds = new Set();
  const contentBlocks = (incoming.contentBlocks || []).map((block) => {
    if (block?.type !== 'figure') return block;
    const local = localFigures.get(block.figureId);
    if (!local) return block;
    retainedFigureIds.add(block.figureId);
    return { ...block, ...local };
  });
  contentBlocks.push(...localBlocks.filter((block) => block?.type === 'figure' && block.figureId
    && !retainedFigureIds.has(block.figureId)));
  const updated = {
    ...existing,
    content: incoming.content,
    contentBlocks,
    contentReviewNote: incoming.contentReviewNote,
    designIllustrationReviewEvidence: incoming.designIllustrationReviewEvidence,
    designIllustrationSurveyResultSnapshot: {
      title: existing.title,
      content: existing.content,
      contentBlocks: localBlocks,
      designIllustrationReviewEvidence: existing.designIllustrationReviewEvidence,
      capturedAt: new Date().toISOString()
    },
    designIllustrationSurveyResultMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(updated.id, updated);
  return 1;
}

async function migrateDesignEditorial144Review(sourceEntries, knownEntries) {
  const migrationId = 'design-editorial-144-local-evidence-review-2026-10-21-v1';
  const incomingEntry = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-editorial'
    && entry.designEditorialReviewMigration === migrationId);
  const existingEntry = incomingEntry && knownEntries.get(incomingEntry.id);
  const snapshot = incomingEntry?.designEditorialReviewSnapshot;
  let updates = 0;
  if (incomingEntry && existingEntry && existingEntry.designEditorialReviewMigration !== migrationId) {
    const legacyScaffold = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
    const localBlocks = existingEntry.contentBlocks || [];
    const localParagraphText = localBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text).join('\n\n');
    const matchesSnapshot = snapshot && existingEntry.content === snapshot.content
      && JSON.stringify(localBlocks) === JSON.stringify(snapshot.contentBlocks || []);
    const matchesUntouchedScaffold = existingEntry.outlineScaffold === true
      && existingEntry.content === legacyScaffold
      && (localParagraphText === legacyScaffold || localBlocks.every((block) => block.type === 'figure'))
      && localBlocks.every((block) => block.type === 'figure' || block.type === 'paragraph');
    if (matchesSnapshot || matchesUntouchedScaffold) {
      const localFiguresById = new Map(localBlocks.filter((block) => block.type === 'figure' && block.figureId)
        .map((block) => [block.figureId, block]));
      const retainedFigureIds = new Set();
      const contentBlocks = (incomingEntry.contentBlocks || []).map((block) => {
        if (block.type !== 'figure') return block;
        const local = localFiguresById.get(block.figureId);
        if (!local) return block;
        retainedFigureIds.add(local.figureId);
        return { ...block, ...local };
      });
      contentBlocks.push(...localBlocks.filter((block) => block.type === 'figure' && block.figureId
        && !retainedFigureIds.has(block.figureId)));
      const updatedEntry = {
        ...existingEntry,
        content: incomingEntry.content,
        contentBlocks,
        outlineScaffold: false,
        tags: [...new Set([...(existingEntry.tags || []).filter((tag) => tag !== 'pendiente de contenido'), 'contenido revisado'])],
        status: incomingEntry.status || existingEntry.status,
        contentReviewState: incomingEntry.contentReviewState,
        contentReviewNote: incomingEntry.contentReviewNote,
        designEditorialReviewSnapshot: {
          title: existingEntry.title,
          content: existingEntry.content,
          contentBlocks: localBlocks,
          migratedAt: new Date().toISOString()
        },
        designEditorialReviewEvidence: incomingEntry.designEditorialReviewEvidence,
        designEditorialReviewMigration: migrationId,
        sourceBundleRevision: incomingEntry.sourceBundleRevision,
        updatedAt: new Date().toISOString(),
        localEditedAt: new Date().toISOString()
      };
      delete updatedEntry.atlasStructuralLabel;
      await putEntry(updatedEntry);
      knownEntries.set(updatedEntry.id, updatedEntry);
      updates += 1;
    }
  }

  for (const incoming of sourceEntries) {
    if (incoming?.designEditorialReferenceReviewMigration !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const referenceSnapshot = incoming.designEditorialReferenceSnapshot;
    if (!existing || !referenceSnapshot || existing.designEditorialReferenceReviewMigration === migrationId
      || existing.title !== referenceSnapshot.title || existing.content !== referenceSnapshot.content
      || JSON.stringify(existing.apaReferenceRecord ?? null) !== JSON.stringify(referenceSnapshot.apaReferenceRecord ?? null)) continue;
    const updatedReference = {
      ...existing,
      title: incoming.title,
      content: incoming.content,
      url: incoming.url,
      tags: [...new Set([...(existing.tags || []), 'referencia web primaria', 'cita usada en 1.4.4'])],
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      designEditorialReferenceSnapshot: {
        title: existing.title,
        content: existing.content,
        tags: existing.tags,
        apaReferenceRecord: existing.apaReferenceRecord,
        capturedAt: new Date().toISOString()
      },
      designEditorialReferenceReviewMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updatedReference);
    knownEntries.set(updatedReference.id, updatedReference);
    updates += 1;
  }
  return updates;
}

async function migrateDesignAudiovisual143Review(sourceEntries, knownEntries) {
  const migrationId = 'design-audiovisual-143-evidence-review-2026-10-21-v1';
  const incomingEntry = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-audiovisual'
    && entry.designAudiovisualReviewMigration === migrationId);
  const existingEntry = incomingEntry && knownEntries.get(incomingEntry.id);
  const snapshot = incomingEntry?.designAudiovisualReviewSnapshot;
  if (!incomingEntry || !existingEntry || existingEntry.designAudiovisualReviewMigration === migrationId) return 0;

  const legacyScaffold = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const localBlocks = existingEntry.contentBlocks || [];
  const localParagraphText = localBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text).join('\n\n');
  const matchesSnapshot = snapshot && existingEntry.content === snapshot.content
    && JSON.stringify(localBlocks) === JSON.stringify(snapshot.contentBlocks || []);
  const matchesUntouchedScaffold = existingEntry.outlineScaffold === true
    && existingEntry.content === legacyScaffold
    && (localParagraphText === legacyScaffold || localBlocks.every((block) => block.type === 'figure'))
    && localBlocks.every((block) => block.type === 'figure' || block.type === 'paragraph');
  if (!matchesSnapshot && !matchesUntouchedScaffold) return 0;

  const localFiguresById = new Map(localBlocks.filter((block) => block.type === 'figure' && block.figureId)
    .map((block) => [block.figureId, block]));
  const retainedFigureIds = new Set();
  const contentBlocks = (incomingEntry.contentBlocks || []).map((block) => {
    if (block.type !== 'figure') return block;
    const local = localFiguresById.get(block.figureId);
    if (!local) return block;
    retainedFigureIds.add(local.figureId);
    return { ...block, ...local };
  });
  contentBlocks.push(...localBlocks.filter((block) => block.type === 'figure' && block.figureId
    && !retainedFigureIds.has(block.figureId)));

  const updatedEntry = {
    ...existingEntry,
    content: incomingEntry.content,
    contentBlocks,
    outlineScaffold: false,
    tags: [...new Set([...(existingEntry.tags || []).filter((tag) => tag !== 'pendiente de contenido'), 'contenido revisado'])],
    status: incomingEntry.status || existingEntry.status,
    contentReviewState: incomingEntry.contentReviewState,
    contentReviewNote: incomingEntry.contentReviewNote,
    designAudiovisualReviewSnapshot: {
      title: existingEntry.title,
      content: existingEntry.content,
      contentBlocks: localBlocks,
      migratedAt: new Date().toISOString()
    },
    designAudiovisualReviewEvidence: incomingEntry.designAudiovisualReviewEvidence,
    designAudiovisualReviewMigration: migrationId,
    sourceBundleRevision: incomingEntry.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  delete updatedEntry.atlasStructuralLabel;
  await putEntry(updatedEntry);
  knownEntries.set(updatedEntry.id, updatedEntry);

  let referenceUpdates = 0;
  for (const incoming of sourceEntries) {
    if (incoming?.designAudiovisualReferenceReviewMigration !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const referenceSnapshot = incoming.designAudiovisualReferenceSnapshot;
    if (!existing || !referenceSnapshot || existing.designAudiovisualReferenceReviewMigration === migrationId
      || existing.title !== referenceSnapshot.title || existing.content !== referenceSnapshot.content
      || JSON.stringify(existing.apaReferenceRecord ?? null) !== JSON.stringify(referenceSnapshot.apaReferenceRecord ?? null)) continue;
    const updatedReference = {
      ...existing,
      title: incoming.title,
      content: incoming.content,
      url: incoming.url,
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      designAudiovisualReferenceSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        capturedAt: new Date().toISOString()
      },
      designAudiovisualReferenceReviewMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updatedReference);
    knownEntries.set(updatedReference.id, updatedReference);
    referenceUpdates += 1;
  }
  return 1 + referenceUpdates;
}

async function migrateDesignAudiovisualApaReview(sourceEntries, knownEntries) {
  const entryId = 'atlas-outline-design-audiovisual';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaAudiovisualContentReviewMigration?.migrationId === 'apa-audiovisual-143-claim-scope-wcag-review-2026-10-22-v2');
  const existing = incoming && knownEntries.get(entryId);
  const plan = incoming?.apaAudiovisualContentReviewMigration;
  if (!existing || !plan || existing.apaAudiovisualContentReviewApplied === plan.migrationId
    || !Array.isArray(plan.oldParagraphs) || !Array.isArray(plan.previousNewParagraphs) || !Array.isArray(plan.newParagraphs)
    || plan.oldParagraphs.length !== plan.newParagraphs.length
    || plan.previousNewParagraphs.length !== plan.newParagraphs.length) return 0;

  const content = String(existing.content || '');
  const blocks = existing.contentBlocks || [];
  const sourceParagraphs = [plan.oldParagraphs, plan.previousNewParagraphs].find((paragraphSet) => paragraphSet.every((paragraph) =>
    content.split(paragraph).length === 2
      && blocks.filter((block) => block.type === 'paragraph' && block.text === paragraph).length === 1));
  if (!sourceParagraphs) return 0;

  const priorContent = existing.content;
  const priorBlocks = blocks;
  const nextContent = sourceParagraphs.reduce((value, paragraph, index) => value.replace(paragraph, plan.newParagraphs[index]), content);
  const replacements = new Map(sourceParagraphs.map((paragraph, index) => [paragraph, plan.newParagraphs[index]]));
  const nextBlocks = blocks.map((block) => block.type === 'paragraph' && replacements.has(block.text)
    ? { ...block, text: replacements.get(block.text) }
    : block);
  const now = new Date().toISOString();
  const updated = {
    ...existing,
    content: nextContent,
    contentBlocks: nextBlocks,
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReviewSnapshot: {
      migrationId: plan.migrationId,
      priorContent,
      priorContentBlocks: priorBlocks,
      priorContentReviewState: existing.contentReviewState || null,
      priorContentReviewNote: existing.contentReviewNote || null,
      sourceBundlePriorContentSha256: plan.priorContentSha256,
      capturedAt: now
    },
    apaAudiovisualCorrectionSnapshot: {
      migrationId: plan.migrationId,
      priorContent,
      priorContentBlocks: priorBlocks,
      capturedAt: now
    },
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaAudiovisualContentReviewApplied: plan.migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateMayerCopyrightDateReview(sourceEntries, knownEntries) {
  const migrationId = 'mayer-2021-copyright-date-apa-review-2026-10-21-v1';
  const id = 'apa-ref-51ce80639e39b32e5eb5';
  const incoming = sourceEntries.find((entry) => entry?.id === id && entry.mayerCopyrightReviewMigration === migrationId);
  const existing = incoming && knownEntries.get(id);
  const priorProvenance = 'La ficha editorial confirma autor, título y tercera edición. Las páginas actuales de Cambridge presentan fechas editoriales distintas (2020 en ficha de producto y copyright/publicación 2021 en el preliminar); conservar 2021 según el registro actualmente citado y cotejar el ejemplar usado por el autor antes de cerrar APA.';
  if (!incoming || !existing || existing.mayerCopyrightReviewMigration === migrationId
    || existing.content !== incoming.content || existing.title !== incoming.title
    || existing.apaReferenceRecord?.provenance !== priorProvenance) return 0;
  const updated = {
    ...existing,
    apaReferenceRecord: incoming.apaReferenceRecord,
    contentReviewNote: incoming.contentReviewNote,
    mayerCopyrightReviewSnapshot: {
      title: existing.title,
      content: existing.content,
      apaReferenceRecord: existing.apaReferenceRecord,
      contentReviewNote: existing.contentReviewNote,
      capturedAt: new Date().toISOString()
    },
    mayerCopyrightReviewMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(id, updated);
  return 1;
}

async function migrateChaykaApa004Review(sourceEntries, knownEntries) {
  const migrationId = 'chayka-apa-004-edition-metadata-2026-10-21-v1';
  const id = 'apa-ref-adb92abef601625d6ba2';
  const incoming = sourceEntries.find((entry) => entry?.id === id && entry.chaykaApa004Migration === migrationId);
  const existing = incoming && knownEntries.get(id);
  const oldReference = {
    author: 'Chayka, K',
    year: '2024',
    sourceText: 'Chayka, K. (2024). The longing for less: Living with minimalism. Bloomsbury Publishing.',
    verificationState: 'not-verified',
    provenance: 'verbatim-transcription-from-pwa-reference-list',
    sourceLocations: [
      { sourceEntryId: 'idml-r1-u1ed5', line: 25, sourceContentSha256: '5f442fe10c219f6b3e952ec74ba95a7fc660b0569c55d901aea8e69e77437722' },
      { sourceEntryId: 'idml-r1-u1283', line: 5, sourceContentSha256: 'caef1cdd21096769d33619668b049a0fd7b05903467ccd6667eaab6b302caeb0' }
    ]
  };
  const normalize = (value) => JSON.stringify(value, (key, child) => child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map((field) => [field, child[field]])) : child);
  if (!incoming || !existing || existing.chaykaApa004Migration === migrationId
    || existing.title !== 'Chayka, K (2024)'
    || existing.content !== oldReference.sourceText
    || normalize(existing.apaReferenceRecord) !== normalize(oldReference)) return 0;
  const updated = {
    ...existing,
    title: incoming.title,
    content: incoming.content,
    apaReferenceRecord: incoming.apaReferenceRecord,
    contentReviewNote: incoming.contentReviewNote,
    bibliographicReview: incoming.bibliographicReview,
    relatedEntryIds: incoming.relatedEntryIds,
    chaykaApa004Snapshot: {
      title: existing.title,
      content: existing.content,
      apaReferenceRecord: existing.apaReferenceRecord,
      contentReviewNote: existing.contentReviewNote,
      capturedAt: new Date().toISOString()
    },
    chaykaApa004Migration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(id, updated);
  return 1;
}

async function migrateIcdApa005AmbiguityReview(sourceEntries, knownEntries) {
  const migrationId = 'icd-apa-005-same-author-year-ambiguity-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apaCitationAmbiguityReviewMigration === migrationId);
  const normalize = (value) => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(normalize) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
    : value;
  const same = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apaCitationAmbiguityReviewSnapshot;
    if (!existing || !snapshot || existing.apaCitationAmbiguityReviewMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || !same(existing.apaReferenceRecord, snapshot.apaReferenceRecord)
      || !same(existing.sourceReview || null, snapshot.sourceReview || null)) continue;
    const updated = {
      ...existing,
      sourceReview: incoming.sourceReview,
      apaCitationAmbiguityReview: incoming.apaCitationAmbiguityReview,
      apaCitationAmbiguityReviewSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        sourceReview: existing.sourceReview || null,
        capturedAt: new Date().toISOString()
      },
      apaCitationAmbiguityReviewMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateNimhApa006UnsupportedCitation(sourceEntries, knownEntries) {
  const migrationId = 'nimh-apa-006-unsupported-citation-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apa006Migration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa006Snapshot;
    if (!existing || !snapshot || existing.apa006Migration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || stable(existing.sourceReview || null) !== stable(snapshot.sourceReview || null)
      || stable(existing.contentReviewNote || null) !== stable(snapshot.contentReviewNote || null)) continue;
    const updated = {
      ...existing,
      sourceReview: incoming.sourceReview,
      apa006Snapshot: {
        title: existing.title,
        content: existing.content,
        sourceReview: existing.sourceReview || null,
        contentReviewNote: existing.contentReviewNote || null,
        capturedAt: new Date().toISOString()
      },
      apa006Migration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateUrlVracApa009CitationLocators(sourceEntries, knownEntries) {
  const migrationId = 'url-vrac-apa-009-reference-and-locators-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apa009CitationMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa009CitationSnapshot;
    if (!existing || !snapshot || existing.apa009CitationMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || stable(existing.sourceReview || null) !== stable(snapshot.sourceReview || null)
      || stable(existing.contentReviewNote || null) !== stable(snapshot.contentReviewNote || null)) continue;
    const updated = {
      ...existing,
      content: incoming.content,
      apa009CitationSnapshot: {
        title: existing.title,
        content: existing.content,
        contentReviewNote: existing.contentReviewNote || null,
        sourceReview: existing.sourceReview || null,
        capturedAt: new Date().toISOString()
      },
      apa009CitationMigration: migrationId,
      apa009ReferenceId: incoming.apa009ReferenceId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migratePinskyApa010IdentityReview(sourceEntries, knownEntries) {
  const migrationId = 'pinsky-apa-010-author-and-edition-review-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apa010Migration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa010Snapshot;
    if (!existing || !snapshot || existing.apa010Migration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || stable(existing.apaReferenceRecord) !== stable(snapshot.apaReferenceRecord)
      || stable(existing.sourceReview || null) !== stable(snapshot.sourceReview || null)) continue;
    const updated = {
      ...existing,
      sourceReview: incoming.sourceReview,
      apa010Review: incoming.apa010Review,
      apa010Snapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        sourceReview: existing.sourceReview || null,
        capturedAt: new Date().toISOString()
      },
      apa010Migration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migratePinskyApa010CanonicalReference(sourceEntries, knownEntries) {
  const migrationId = 'pinsky-apa-010-canonical-edition-2006-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apa010CanonicalMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa010CanonicalSnapshot;
    if (!existing || !snapshot || existing.apa010CanonicalMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || stable(existing.apaReferenceRecord || null) !== stable(snapshot.apaReferenceRecord || null)) continue;
    const updated = {
      ...existing,
      title: incoming.title,
      content: incoming.content,
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      sourceReview: incoming.sourceReview,
      apa010Review: incoming.apa010Review,
      apa010CanonicalSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord || null,
        capturedAt: new Date().toISOString()
      },
      apa010CanonicalMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  const excludedLineTargets = sourceEntries.filter((entry) => entry?.apa010CanonicalExcludedLineMigration === migrationId);
  for (const incoming of excludedLineTargets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa010CanonicalExcludedLineSnapshot;
    const expectedLines = snapshot?.apaExcludedReferenceLines || [];
    const existingLines = existing?.apaExcludedReferenceLines || [];
    if (!existing || !snapshot || existing.apa010CanonicalExcludedLineMigration === migrationId
      || typeof incoming.apa010CanonicalExcludedReferenceLine !== 'string'
      || !String(existing.content || '').split(/\r?\n/).includes(incoming.apa010CanonicalExcludedReferenceLine)) continue;
    const updated = {
      ...existing,
      apaExcludedReferenceLines: [...new Set([...existingLines, ...expectedLines, incoming.apa010CanonicalExcludedReferenceLine])],
      apa010CanonicalExcludedLineSnapshot: {
        title: existing.title,
        content: existing.content,
        apaExcludedReferenceLines: existingLines,
        capturedAt: new Date().toISOString()
      },
      apa010CanonicalExcludedLineMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateFerrariRosterApa011Review(sourceEntries, knownEntries) {
  const migrationId = 'ferrari-roster-apa-011-publisher-metadata-and-scope-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.apa011Migration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const stable = (value) => JSON.stringify(normalize(value));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.apa011Snapshot;
    if (!existing || !snapshot || existing.apa011Migration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || stable(existing.sourceReview || null) !== stable(snapshot.sourceReview || null)
      || (existing.type === 'Fuente' && stable(existing.apaReferenceRecord) !== stable(snapshot.apaReferenceRecord))) continue;
    const updated = {
      ...existing,
      title: incoming.title,
      content: incoming.content,
      ...(existing.type === 'Fuente' ? {
        sourceReview: incoming.sourceReview,
        apaReferenceRecord: incoming.apaReferenceRecord
      } : {}),
      apa011Snapshot: {
        title: existing.title,
        content: existing.content,
        sourceReview: existing.sourceReview || null,
        apaReferenceRecord: existing.apaReferenceRecord || null,
        contentReviewNote: existing.contentReviewNote || null,
        capturedAt: new Date().toISOString()
      },
      apa011Migration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateFerrariApa011DoiResolution(sourceEntries, knownEntries) {
  const migrationId = 'ferrari-apa-011-crossref-doi-404-evidence-2026-10-21-v1';
  const id = 'apa-ref-672a60d8714c223a4ead';
  const incoming = sourceEntries.find((entry) => entry?.id === id
    && entry.apa011DoiResolutionMigration === migrationId);
  const existing = incoming && knownEntries.get(id);
  const snapshot = incoming?.apa011DoiResolutionSnapshot;
  if (!incoming || !existing || !snapshot || existing.apa011DoiResolutionMigration === migrationId
    || existing.content !== snapshot.content
    || existing.apa011Migration !== snapshot.apa011Migration
    || JSON.stringify(existing.sourceReview || null) !== JSON.stringify(snapshot.sourceReview || null)
    || JSON.stringify(existing.apaReferenceRecord || null) !== JSON.stringify(snapshot.apaReferenceRecord || null)) return 0;
  const updated = {
    ...existing,
    sourceReview: incoming.sourceReview,
    apaReferenceRecord: incoming.apaReferenceRecord,
    apa011DoiResolutionSnapshot: {
      content: existing.content,
      apa011Migration: existing.apa011Migration,
      sourceReview: existing.sourceReview || null,
      apaReferenceRecord: existing.apaReferenceRecord || null,
      capturedAt: new Date().toISOString()
    },
    apa011DoiResolutionMigration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(id, updated);
  return 1;
}

async function migrateBeckerApa001Reference(sourceEntries, knownEntries) {
  const migrationId = 'becker-minimalist-home-apa-001-reference-2026-10-21-v1';
  const id = 'idml-r1-u1ed5';
  const incoming = sourceEntries.find((entry) => entry?.id === id && entry.apa001Migration === migrationId);
  const existing = incoming && knownEntries.get(id);
  const snapshot = incoming?.apa001Snapshot;
  const sourceId = 'apa-ref-becker-2018-minimalist-home';
  if (!incoming || !existing || !snapshot || existing.apa001Migration === migrationId
    || existing.content !== snapshot.content
    || !incoming.content.includes('Becker, J. (2018). *The minimalist home: A room-by-room guide to a decluttered, refocused life* (E. Stanford, Ed.). WaterBrook.')) return 0;
  const updated = {
    ...existing,
    content: incoming.content,
    relatedEntryIds: [...new Set([...(existing.relatedEntryIds || []), sourceId])],
    apa001ReferenceId: sourceId,
    apa001Snapshot: {
      content: existing.content,
      relatedEntryIds: existing.relatedEntryIds || [],
      capturedAt: new Date().toISOString()
    },
    apa001Migration: migrationId,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(id, updated);
  return 1;
}

async function migrateDesignFrameworkCitationSourceLinks(sourceEntries, knownEntries) {
  const migrationId = 'design-framework-citation-source-links-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.designFrameworkCitationLinkMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  let updates = 0;
  for (const incoming of targets) {
    const id = incoming.id;
    const existing = knownEntries.get(id);
    const snapshot = incoming.designFrameworkCitationLinkSnapshot;
    const sourceRecord = incoming.apaReferenceRecord;
    const localRecord = existing?.apaReferenceRecord;
    if (!existing || !sourceRecord || !snapshot || existing.designFrameworkCitationLinkMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || JSON.stringify(normalize(localRecord)) !== JSON.stringify(normalize(snapshot.apaReferenceRecord))) continue;
    const updated = {
      ...existing,
      apaReferenceRecord: sourceRecord,
      designFrameworkCitationLinkSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: localRecord,
        capturedAt: new Date().toISOString()
      },
      designFrameworkCitationLinkMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateDesignFrameworkSasakiParentCitationLinks(sourceEntries, knownEntries) {
  const migrationId = 'design-framework-sasaki-parent-citation-links-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.designFrameworkSasakiParentLinkMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.designFrameworkSasakiParentLinkSnapshot;
    if (!existing || !snapshot || existing.designFrameworkSasakiParentLinkMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || JSON.stringify(normalize(existing.apaReferenceRecord)) !== JSON.stringify(normalize(snapshot.apaReferenceRecord))) continue;
    const updated = {
      ...existing,
      apaReferenceRecord: incoming.apaReferenceRecord,
      designFrameworkSasakiParentLinkSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        capturedAt: new Date().toISOString()
      },
      designFrameworkSasakiParentLinkMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateDesignFrameworkApaSourceTitleFormatting(sourceEntries, knownEntries) {
  const migrationId = 'design-framework-apa-source-title-formatting-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.designFrameworkApaFormattingMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.designFrameworkApaFormattingSnapshot;
    if (!existing || !snapshot || existing.designFrameworkApaFormattingMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || JSON.stringify(normalize(existing.apaReferenceRecord)) !== JSON.stringify(normalize(snapshot.apaReferenceRecord))) continue;
    const updated = {
      ...existing,
      content: incoming.content,
      apaReferenceRecord: incoming.apaReferenceRecord,
      designFrameworkApaFormattingSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        capturedAt: new Date().toISOString()
      },
      designFrameworkApaFormattingMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateDesignFrameworkCitationSourceAudits(sourceEntries, knownEntries) {
  const migrationId = 'design-framework-source-citation-audit-2026-10-21-v1';
  const targets = sourceEntries.filter((entry) => entry?.designFrameworkCitationSourceAuditMigration === migrationId);
  const normalize = (value) => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const same = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  let updates = 0;
  for (const incoming of targets) {
    const existing = knownEntries.get(incoming.id);
    const snapshot = incoming.designFrameworkCitationSourceAuditSnapshot;
    if (!existing || !snapshot || existing.designFrameworkCitationSourceAuditMigration === migrationId
      || existing.title !== snapshot.title || existing.content !== snapshot.content
      || !same(existing.apaReferenceRecord, snapshot.apaReferenceRecord)
      || !same(existing.designFrameworkCitationSourceAudit || null, snapshot.priorAudit || null)) continue;
    const updated = {
      ...existing,
      designFrameworkCitationSourceAudit: incoming.designFrameworkCitationSourceAudit,
      designFrameworkCitationSourceAuditSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        priorAudit: existing.designFrameworkCitationSourceAudit || null,
        capturedAt: new Date().toISOString()
      },
      designFrameworkCitationSourceAuditMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(incoming.id, updated);
    updates += 1;
  }
  return updates;
}

async function migrateDesignFrameworkContinuation142143146153(sourceEntries, knownEntries) {
  const migrationId = 'design-framework-142-143-146-audience-maps-2026-10-21-v1';
  let updates = 0;
  for (const incoming of sourceEntries) {
    if (incoming?.designContinuationMigration !== migrationId || !incoming.designContinuationSnapshot) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.designContinuationMigration === migrationId) continue;
    const snapshot = incoming.designContinuationSnapshot;
    const contentMatches = existing.title === snapshot.title && existing.content === snapshot.content;
    if (!contentMatches) continue;

    const localFigures = (existing.contentBlocks || []).filter((block) => block.type === 'figure');
    const localFiguresById = new Map(localFigures.filter((figure) => figure.figureId).map((figure) => [figure.figureId, figure]));
    const retainedIds = new Set();
    const contentBlocks = (incoming.contentBlocks || []).map((block) => {
      if (block.type !== 'figure') return block;
      const local = block.figureId ? localFiguresById.get(block.figureId) : null;
      if (!local) return block;
      retainedIds.add(local.figureId);
      return { ...block, ...local };
    });
    contentBlocks.push(...localFigures.filter((figure) => figure.figureId && !retainedIds.has(figure.figureId)));
    const updated = {
      ...existing,
      content: incoming.content,
      contentBlocks,
      figureCitations: { ...(existing.figureCitations || {}), ...(incoming.figureCitations || {}) },
      contentReviewState: incoming.contentReviewState || 'reviewed',
      contentReviewNote: incoming.contentReviewNote,
      outlineScaffold: false,
      tags: [...new Set([...(existing.tags || []).filter((tag) => tag !== 'pendiente de contenido'), ...(incoming.tags || [])])],
      status: incoming.status || existing.status,
      designContinuationSnapshot: {
        title: existing.title,
        content: existing.content,
        contentBlocks: existing.contentBlocks || [],
        migratedAt: new Date().toISOString()
      },
      designContinuationMigration: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updated);
    knownEntries.set(updated.id, updated);
    updates += 1;
  }

  const incomingReferences = sourceEntries.find((entry) => entry?.id === 'idml-r1-u1283'
    && entry.designContinuationReferencesMigration === migrationId);
  const existingReferences = incomingReferences && knownEntries.get(incomingReferences.id);
  const referenceSnapshot = incomingReferences?.designContinuationReferencesSnapshot;
  if (existingReferences && referenceSnapshot && existingReferences.designContinuationReferencesMigration !== migrationId
    && existingReferences.title === referenceSnapshot.title && existingReferences.content === referenceSnapshot.content) {
    const updatedReferences = {
      ...existingReferences,
      content: incomingReferences.content,
      designContinuationReferencesSnapshot: { title: existingReferences.title, content: existingReferences.content, migratedAt: new Date().toISOString() },
      designContinuationReferencesMigration: migrationId,
      sourceBundleRevision: incomingReferences.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    };
    await putEntry(updatedReferences);
    knownEntries.set(updatedReferences.id, updatedReferences);
    updates += 1;
  }
  return updates;
}

async function migrateDesignWebsites142Review(sourceEntries, knownEntries) {
  const migrationId = 'design-websites-142-citation-and-local-evidence-review-2026-10-21-v1';
  const updates = [];
  const incomingEntry = sourceEntries.find((entry) => entry?.id === 'atlas-outline-design-websites'
    && entry.designWebsitesReviewMigration === migrationId);
  const existingEntry = incomingEntry && knownEntries.get(incomingEntry.id);
  const snapshot = incomingEntry?.designWebsitesReviewSnapshot;
  const legacyScaffold = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const scaffoldBlocks = existingEntry?.contentBlocks || [];
  const scaffoldParagraphText = scaffoldBlocks.filter((block) => block.type === 'paragraph').map((block) => block.text).join('\n\n');
  const matchesReviewSnapshot = existingEntry && snapshot
    && existingEntry.title === snapshot.title && existingEntry.content === snapshot.content
    && JSON.stringify(existingEntry.contentBlocks ?? []) === JSON.stringify(snapshot.contentBlocks ?? []);
  const matchesUntouchedScaffold = existingEntry?.outlineScaffold === true
    && existingEntry.content === legacyScaffold && scaffoldParagraphText === legacyScaffold
    && scaffoldBlocks.every((block) => block.type === 'figure' || block.type === 'paragraph');
  if (existingEntry && incomingEntry && (matchesReviewSnapshot || matchesUntouchedScaffold)
    && existingEntry.designWebsitesReviewMigration !== migrationId) {
    let paragraphIndex = 0;
    const reviewedParagraphs = (incomingEntry.contentBlocks || []).filter((block) => block.type === 'paragraph');
    let contentBlocks;
    if (matchesUntouchedScaffold) {
      const localFiguresById = new Map((existingEntry.contentBlocks || [])
        .filter((block) => block.figureId).map((block) => [block.figureId, block]));
      const includedLocalFigureIds = new Set();
      contentBlocks = (incomingEntry.contentBlocks || []).map((block) => {
        if (block.type !== 'figure') return block;
        const local = localFiguresById.get(block.figureId);
        if (!local) return block;
        includedLocalFigureIds.add(local.figureId);
        return { ...block, ...local };
      });
      contentBlocks.push(...(existingEntry.contentBlocks || [])
        .filter((block) => block.type === 'figure' && block.figureId && !includedLocalFigureIds.has(block.figureId)));
    } else {
      contentBlocks = (existingEntry.contentBlocks || []).map((block) => {
        if (block.type !== 'paragraph') return block;
        const reviewed = reviewedParagraphs[paragraphIndex++];
        return reviewed ? { ...block, text: reviewed.text } : block;
      });
    }
    updates.push({
      ...existingEntry,
      content: incomingEntry.content,
      contentBlocks,
      outlineScaffold: false,
      tags: [...new Set([...(existingEntry.tags || []).filter((tag) => tag !== 'pendiente de contenido'), 'contenido revisado'])],
      status: incomingEntry.status || existingEntry.status,
      contentReviewState: incomingEntry.contentReviewState,
      contentReviewNote: incomingEntry.contentReviewNote,
      designWebsitesReviewEvidence: incomingEntry.designWebsitesReviewEvidence,
      designWebsitesReviewSnapshot: {
        title: existingEntry.title,
        content: existingEntry.content,
        contentBlocks: existingEntry.contentBlocks,
        capturedAt: new Date().toISOString()
      },
      designWebsitesReviewMigration: migrationId,
      sourceBundleRevision: incomingEntry.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
    delete updates[updates.length - 1].atlasStructuralLabel;
  }

  for (const incoming of sourceEntries) {
    if (incoming?.designWebsitesReferenceReviewMigration !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    const referenceSnapshot = incoming.designWebsitesReferenceReviewSnapshot;
    if (!existing || !referenceSnapshot || existing.designWebsitesReferenceReviewMigration === migrationId
      || existing.title !== referenceSnapshot.title || existing.content !== referenceSnapshot.content
      || JSON.stringify(existing.apaReferenceRecord ?? null) !== JSON.stringify(referenceSnapshot.apaReferenceRecord ?? null)) continue;
    updates.push({
      ...existing,
      title: incoming.title,
      content: incoming.content,
      apaReferenceRecord: incoming.apaReferenceRecord,
      contentReviewNote: incoming.contentReviewNote,
      designWebsitesReferenceReviewSnapshot: {
        title: existing.title,
        content: existing.content,
        apaReferenceRecord: existing.apaReferenceRecord,
        capturedAt: new Date().toISOString()
      },
      designWebsitesReferenceReviewMigration: migrationId,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }

  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function migrateDesignWebsitesApaReview(sourceEntries, knownEntries) {
  const entryId = 'atlas-outline-design-websites';
  const incoming = sourceEntries.find((entry) => entry?.id === entryId
    && entry.apaWebsitesReviewMigration?.migrationId === 'apa-design-websites-142-survey-and-source-scope-review-2026-10-22-v1');
  const existing = incoming && knownEntries.get(entryId);
  const plan = incoming?.apaWebsitesReviewMigration;
  if (!existing || !plan || existing.apaWebsitesReviewApplied === plan.migrationId
    || !Array.isArray(plan.oldParagraphs) || !Array.isArray(plan.newParagraphs)
    || plan.oldParagraphs.length !== plan.newParagraphs.length) return 0;
  const content = String(existing.content || '');
  const blocks = existing.contentBlocks || [];
  const paragraphsMatch = plan.oldParagraphs.every((paragraph) => content.split(paragraph).length === 2
    && blocks.filter((block) => block.type === 'paragraph' && block.text.includes(paragraph)).length === 1);
  if (!paragraphsMatch) return 0;

  const priorContent = existing.content;
  const priorBlocks = blocks;
  const replacements = new Map(plan.oldParagraphs.map((paragraph, index) => [paragraph, plan.newParagraphs[index]]));
  const updated = {
    ...existing,
    content: plan.oldParagraphs.reduce((value, paragraph, index) => value.replace(paragraph, plan.newParagraphs[index]), content),
    contentBlocks: blocks.map((block) => {
      if (block.type !== 'paragraph') return block;
      for (const [oldText, newText] of replacements) if (block.text.includes(oldText)) return { ...block, text: block.text.replace(oldText, newText) };
      return block;
    }),
    contentReviewState: incoming.contentReviewState,
    contentReviewNote: incoming.contentReviewNote,
    apaAcademicContentReviewSnapshot: {
      migrationId: plan.migrationId,
      priorContent,
      priorContentBlocks: priorBlocks,
      priorContentReviewState: existing.contentReviewState || null,
      priorContentReviewNote: existing.contentReviewNote || null,
      sourceBundlePriorContentSha256: plan.priorContentSha256,
      capturedAt: new Date().toISOString()
    },
    apaAcademicContentReview: incoming.apaAcademicContentReview,
    apaWebsitesReviewApplied: plan.migrationId,
    sourceBundleRevision: incoming.sourceBundleRevision,
    updatedAt: new Date().toISOString(),
    localEditedAt: new Date().toISOString()
  };
  await putEntry(updated);
  knownEntries.set(entryId, updated);
  return 1;
}

async function migrateDesignFrameworkNumbering(sourceEntries, knownEntries) {
  const migrationId = 'pwa-atlas-position-numbers-design-framework-2026-10-20-v1';
  const updates = [];
  for (const incoming of sourceEntries) {
    const snapshot = incoming?.atlasNumberingSnapshot;
    if (!snapshot || incoming.atlasNumberingMigration !== migrationId) continue;
    const existing = knownEntries.get(incoming.id);
    if (!existing || existing.atlasNumberingMigration === migrationId) continue;
    // Only reconcile unchanged text/title. Preserve local figure blocks and any
    // other metadata so this one-time hierarchy migration cannot erase edits.
    if (existing.title !== snapshot.title || existing.content !== snapshot.content) continue;
    const numberingSnapshot = {
      title: existing.title,
      content: existing.content,
      contentBlocks: Array.isArray(existing.contentBlocks) ? existing.contentBlocks : null
    };
    const incomingParagraphs = new Map((incoming.contentBlocks || [])
      .filter((block) => block.type === 'paragraph')
      .map((block, index) => [index, block.text]));
    let paragraphIndex = 0;
    const contentBlocks = (existing.contentBlocks || []).map((block) => {
      if (block.type !== 'paragraph') return block;
      const sourceText = incomingParagraphs.get(paragraphIndex++);
      // Text only changes where the source's paragraph is still identical;
      // locally edited paragraphs remain intact.
      const snapshotBlock = (snapshot.contentBlocks || []).filter((item) => item.type === 'paragraph')[paragraphIndex - 1];
      const isUnchangedParagraph = sourceText !== undefined && block.text === snapshotBlock?.text;
      return isUnchangedParagraph ? { ...block, text: sourceText } : block;
    });
    updates.push({
      ...existing,
      title: incoming.title,
      content: incoming.content,
      contentBlocks,
      atlasNumberingSnapshot: numberingSnapshot,
      atlasNumberingMigration: migrationId,
      sourceBundleRevision: incoming.sourceBundleRevision,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }
  if (updates.length) {
    await putEntriesAtomically(updates);
    updates.forEach((entry) => knownEntries.set(entry.id, entry));
  }
  return updates.length;
}

async function applyVerifiedSpellingCorrections() {
  const migrationId = 'verified-spanish-spelling-2026-10-18-v2';
  const targets = new Set(['idml-r1-u2495', 'idml-r1-u247e', 'idml-r1-u2a2c', 'atlas-clutter-source-4-1-2-2']);
  const replacements = [
    [/\bjovenes estudiantes\b/giu, 'jóvenes estudiantes'],
    [/\bcarácterísticas\b/giu, 'características'],
    [/\bpara el diagnostico\b/giu, 'para el diagnóstico'],
    [/\blegitimiza\b/giu, 'legitima']
  ];
  const replaceText = (value) => replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  const correctBlocks = (blocks) => blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const corrected = { ...block };
    const textFields = block.type === 'paragraph' ? ['text']
      : block.type === 'figure' ? ['caption', 'alt']
        : block.type === 'document' ? ['title', 'text'] : [];
    textFields.forEach((field) => {
      if (typeof corrected[field] === 'string') corrected[field] = replaceText(corrected[field]);
    });
    return corrected;
  });

  const now = new Date().toISOString();
  const updates = [];
  for (const entry of await allEntries()) {
    if (!targets.has(entry.id) || entry.spellingCorrectionMigration === migrationId) continue;
    const corrected = { ...entry };
    ['title', 'content'].forEach((field) => {
      if (typeof corrected[field] === 'string') corrected[field] = replaceText(corrected[field]);
    });
    if (Array.isArray(corrected.contentBlocks)) corrected.contentBlocks = correctBlocks(corrected.contentBlocks);
    const changed = JSON.stringify(corrected) !== JSON.stringify(entry);
    corrected.spellingCorrectionMigration = migrationId;
    if (changed) {
      corrected.localEditedAt = now;
      corrected.updatedAt = now;
    }
    updates.push(corrected);
  }
  if (!updates.length) return 0;
  await putEntriesAtomically(updates);
  const correctedCount = updates.filter((entry) => entry.localEditedAt === now).length;
  if (correctedCount && githubSyncEnabled()) scheduleGitHubSync();
  if (correctedCount) console.info(`Se aplicaron correcciones ortográficas puntuales en ${correctedCount} entradas locales.`);
  return correctedCount;
}

async function applyVerifiedFigureCaptionCorrections() {
  const migrationId = 'verified-figure-caption-spelling-2026-10-18-v1';
  const replacements = [
    ['incolucrados', 'involucrados'],
    ['desanimo', 'desánimo']
  ];
  const now = new Date().toISOString();
  const updates = [];
  for (const entry of await allEntries()) {
    if (entry.figureCaptionCorrectionMigration === migrationId) continue;
    let changed = false;
    const correctFigureBlocks = (blocks) => blocks.map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'figure') return block;
      const corrected = { ...block };
      for (const field of ['caption', 'alt']) {
        if (typeof corrected[field] !== 'string') continue;
        for (const [misspelling, correction] of replacements) {
          const value = corrected[field].replaceAll(misspelling, correction);
          if (value !== corrected[field]) changed = true;
          corrected[field] = value;
        }
      }
      return corrected;
    });
    const corrected = { ...entry };
    for (const field of ['contentBlocks', 'sourceMedia']) {
      if (Array.isArray(entry[field])) corrected[field] = correctFigureBlocks(entry[field]);
    }
    if (!changed) continue;
    corrected.figureCaptionCorrectionMigration = migrationId;
    corrected.localEditedAt = now;
    corrected.updatedAt = now;
    updates.push(corrected);
  }
  if (!updates.length) return 0;
  await putEntriesAtomically(updates);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se corrigieron pies de figura en ${updates.length} entradas locales.`);
  return updates.length;
}

async function splitResearchQuestionsAndObjectives() {
  const migrationId = 'verified-research-question-objective-hierarchy-2026-10-19-v1';
  const specs = [
    { id: 'idml-r1-u2495', number: '01', story: 'u2495', questionNode: 'research-questions', objectiveId: 'atlas-research-objective-01' },
    { id: 'idml-r1-u247e', number: '02', story: 'u247e', questionNode: 'research-questions', objectiveId: 'atlas-research-objective-02' }
  ];
  const currentEntries = await allEntries();
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const now = new Date().toISOString();
  const updates = [];
  const objectiveEntries = [];

  for (const spec of specs) {
    const source = currentById.get(spec.id);
    if (!source) return false;
    const backup = source.researchSectionSplitBackup;
    const originalContent = typeof backup?.content === 'string' ? backup.content : source.content;
    const paired = originalContent.match(/^\s*(\d{2})\.\s*Pregunta:\s*\n+([\s\S]*?)\n+\s*\1\.\s*Objetivo:\s*\n+([\s\S]+?)\s*$/u);
    const questionOnly = source.researchSectionSplitMigration === migrationId
      && new RegExp(`^\\s*${spec.number}\\.\\s*Pregunta:`, 'u').test(source.content || '');
    if ((!paired || paired[1] !== spec.number) && !questionOnly) {
      console.warn(`Se conserva intacta ${spec.id}: no coincide con la estructura verificada de pregunta y objetivo.`);
      return false;
    }

    const questionText = paired
      ? `${spec.number}. Pregunta:\n\n${paired[2].trim()}`
      : source.content;
    const objectiveText = paired
      ? `${spec.number}. Objetivo:\n\n${paired[3].trim()}`
      : backup?.objectiveContent;
    const existingObjective = currentById.get(spec.objectiveId);
    if (!objectiveText && !existingObjective) return false;

    if (source.researchSectionSplitMigration !== migrationId
      || source.content !== questionText
      || source.guideNodeId !== spec.questionNode) {
      updates.push({
        ...source,
        title: `${spec.number}. Pregunta:`,
        content: questionText,
        guideNodeId: spec.questionNode,
        customGuideNode: null,
        researchSectionSplitBackup: backup || {
          title: source.title,
          area: source.area,
          tags: source.tags || [],
          content: source.content,
          guideNodeId: source.guideNodeId || null,
          questionContent: questionText,
          objectiveContent: objectiveText
        },
        researchSectionSplitMigration: migrationId,
        localEditedAt: now,
        updatedAt: now
      });
    }

    if (!existingObjective && objectiveText) {
      objectiveEntries.push({
        id: spec.objectiveId,
        title: `${spec.number}. Objetivo:`,
        type: 'Entrada',
        status: source.status || 'En revisión',
        area: `Origen IDML · Story ${spec.story} · PDF de octubre, p. 25`,
        tags: [...new Set([...(source.tags || []), 'objetivo de investigación'])],
        content: objectiveText,
        guideNodeId: 'research-objectives',
        customGuideNode: null,
        contentBlocks: null,
        sourceMedia: [],
        images: [],
        attachments: [],
        figureCitations: {},
        originalSnapshot: null,
        pwaCreated: true,
        outlineScaffold: false,
        researchSectionSplitMigration: migrationId,
        createdAt: source.createdAt || now,
        updatedAt: now,
        localEditedAt: now
      });
    }
  }

  const scaffoldIds = ['atlas-outline-research-questions', 'atlas-outline-research-objectives'];
  const idsToDelete = scaffoldIds.filter((id) => {
    const entry = currentById.get(id);
    return entry?.outlineScaffold === true
      && entry.content === 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  });
  const batch = [...updates, ...objectiveEntries];
  const nextQuestionOrder = ['idml-r1-u2495', 'idml-r1-u247e', ...(atlasOrderState.entries['research-questions'] || [])
    .filter((id) => !['idml-r1-u2495', 'idml-r1-u247e'].includes(id))];
  const nextObjectiveOrder = ['atlas-research-objective-01', 'atlas-research-objective-02', ...(atlasOrderState.entries['research-objectives'] || [])
    .filter((id) => !['atlas-research-objective-01', 'atlas-research-objective-02'].includes(id))];
  const orderChanged = JSON.stringify(nextQuestionOrder) !== JSON.stringify(atlasOrderState.entries['research-questions'] || [])
    || JSON.stringify(nextObjectiveOrder) !== JSON.stringify(atlasOrderState.entries['research-objectives'] || []);
  const tombstonesChanged = idsToDelete.some((id) => !atlasOrderState.deletedEntries?.[id]);
  if (!batch.length && !idsToDelete.length && !orderChanged && !tombstonesChanged) return false;

  await putEntriesAndDeleteAtomically(batch, idsToDelete);
  atlasOrderState.entries = {
    ...(atlasOrderState.entries || {}),
    'research-questions': nextQuestionOrder,
    'research-objectives': nextObjectiveOrder
  };
  if (idsToDelete.length) {
    atlasOrderState.deletedEntries = { ...(atlasOrderState.deletedEntries || {}) };
    idsToDelete.forEach((id) => { atlasOrderState.deletedEntries[id] ||= now; });
    atlasOrderState.entries = Object.fromEntries(Object.entries(atlasOrderState.entries)
      .map(([nodeId, ids]) => [nodeId, ids.filter((id) => !idsToDelete.includes(id))]));
  }
  if (batch.length || idsToDelete.length || orderChanged || tombstonesChanged) saveAtlasOrderState({ scheduleSync: false });
  entries = await allEntries();
  if (batch.length || idsToDelete.length || orderChanged || tombstonesChanged) {
    console.info(`Se organizaron preguntas y objetivos de investigación: ${updates.length} entradas actualizadas, ${objectiveEntries.length} objetivos incorporados y ${idsToDelete.length} marcadores vacíos retirados.`);
    if (githubSyncEnabled()) scheduleGitHubSync();
  }
  return true;
}

async function ensureAtlasSectionEntries() {
  const existingEntries = await allEntries();
  const createdAt = new Date().toISOString();
  const created = [];
  for (const node of editorialSections()) {
    if (atlasOrderState.deletedEntries?.[`atlas-outline-${node.id}`]) continue;
    if (node.isPhase || existingEntries.some((entry) => guideNodeForEntry(entry)?.id === node.id)) continue;
    const entry = {
      id: `atlas-outline-${node.id}`,
      title: node.number ? `${node.number} · ${node.label}` : node.label,
      type: 'Nota',
      status: 'Borrador',
      area: 'Estructura Atlas',
      tags: ['estructura', 'pendiente de contenido'],
      content: `Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.`,
      guideNodeId: node.id,
      customGuideNode: null,
      contentReviewState: 'pending',
      contentReviewNote: 'Contenido académico pendiente de incorporar y verificar dentro de la PWA.',
      contentBlocks: null,
      sourceMedia: [],
      images: [],
      attachments: [],
      figureCitations: {},
      originalSnapshot: null,
      pwaCreated: true,
      outlineScaffold: true,
      createdAt,
      updatedAt: createdAt
    };
    await putEntry(entry);
    existingEntries.push(entry);
    created.push(entry);
  }
  return created.length;
}

async function splitGroupObjectiveSourceEntry() {
  const migrationId = 'atlas-group-objective-source-split-v1';
  const sourceId = 'idml-r1-u61b7';
  const scaffoldText = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const current = await allEntries();
  const source = current.find((entry) => entry.id === sourceId);
  if (!source || source.groupObjectiveContentSplitMigration === migrationId) return false;
  const bundledSource = bundledContentById?.get(sourceId);
  if (!bundledSource || source.content !== bundledSource.content || source.area !== 'Origen IDML · Story u61b7') return false;

  const lines = String(source.content || '').split(/\r?\n/);
  const normalizeHeading = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const headings = [
    'Técnicas de investigación', 'Focus group', 'Entrevista en profundidad', 'Observación participativa',
    'PERFILES DEL GRUPO OBJETIVO', 'Perfil psicográfico', 'Perfil demográfico', 'Perfil geográfico', 'Perfil psicopedagógico'
  ];
  const headingIndexes = headings.map((heading) => {
    const matches = lines.flatMap((line, index) => normalizeHeading(line) === normalizeHeading(heading) ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
  if (headingIndexes.some((index) => index < 0)
    || headingIndexes.some((index, position) => position > 0 && index <= headingIndexes[position - 1])) return false;

  const contentBetween = (headingPosition) => lines.slice(headingIndexes[headingPosition] + 1,
    headingIndexes[headingPosition + 1] ?? lines.length).join('\n').trim();
  const specs = [
    { id: 'idml-r1-u6188', guideNodeId: 'pgdg-6', content: lines.slice(0, headingIndexes[0]).join('\n').trim(), sourceHeading: null },
    { id: 'atlas-outline-audience-methodology', guideNodeId: 'audience-methodology', content: lines[headingIndexes[0]].trim(), sourceHeading: headings[0] },
    { id: 'atlas-outline-audience-focus-group', guideNodeId: 'audience-focus-group', content: contentBetween(1), sourceHeading: headings[1] },
    { id: 'atlas-outline-audience-interview', guideNodeId: 'audience-interview', content: contentBetween(2), sourceHeading: headings[2] },
    { id: 'atlas-outline-audience-observation', guideNodeId: 'audience-observation', content: contentBetween(3), sourceHeading: headings[3] },
    { id: 'atlas-outline-audience-profiles', guideNodeId: 'audience-profiles', content: lines[headingIndexes[4]].trim(), sourceHeading: headings[4] },
    { id: 'atlas-outline-audience-psychographic', guideNodeId: 'audience-psychographic', content: contentBetween(5), sourceHeading: headings[5] },
    { id: 'atlas-outline-audience-demographic', guideNodeId: 'audience-demographic', content: contentBetween(6), sourceHeading: headings[6] },
    { id: 'atlas-outline-audience-geographic', guideNodeId: 'audience-geographic', content: contentBetween(7), sourceHeading: headings[7] },
    { id: 'atlas-outline-audience-psychopedagogic', guideNodeId: 'audience-psychopedagogic', content: contentBetween(8), sourceHeading: headings[8] }
  ];
  if (specs.some((spec) => !spec.content)) return false;

  const now = new Date().toISOString();
  const updates = [];
  for (const spec of specs) {
    const node = getGuideNodeById(spec.guideNodeId);
    if (!node) return false;
    let target = current.find((entry) => entry.id === spec.id);
    if (!target) {
      const hasOtherAssignedEntry = current.some((entry) => entry.id !== sourceId
        && entry.status !== 'Archivada' && guideNodeForEntry(entry)?.id === spec.guideNodeId);
      if (hasOtherAssignedEntry) return false;
      target = {
        id: spec.id,
        title: `${node.number ? `${node.number} · ` : ''}${node.label}`,
        type: 'Entrada',
        status: 'Borrador',
        area: 'Estructura Atlas',
        tags: ['estructura', 'pendiente de contenido'],
        content: scaffoldText,
        guideNodeId: spec.guideNodeId,
        customGuideNode: null,
        contentBlocks: null,
        sourceMedia: [],
        images: [],
        attachments: [],
        figureCitations: {},
        originalSnapshot: null,
        pwaCreated: true,
        outlineScaffold: true,
        contentReviewState: 'pending',
        contentReviewNote: 'Contenido académico pendiente de incorporar y verificar dentro de la PWA.',
        createdAt: now,
        updatedAt: now
      };
    }
    const expectedTitle = `${node.number ? `${node.number} · ` : ''}${node.label}`;
    const isKnownGroupObjectiveHeading = spec.id === 'idml-r1-u6188'
      && target.title === 'GRUPO OBJETIVO' && target.content === 'GRUPO OBJETIVO'
      && target.area === 'Origen IDML · Story u6188' && target.type === 'Entrada'
      && !(Array.isArray(target.contentBlocks) && target.contentBlocks.length)
      && !(target.images || []).length && !(target.attachments || []).length && !(target.sourceMedia || []).length;
    if (target.groupObjectiveContentSplitMigration !== migrationId
      && ((!isKnownGroupObjectiveHeading && (target.title !== expectedTitle || target.status !== 'Borrador'
        || target.outlineScaffold !== true || target.content !== scaffoldText))
        || (target.guideNodeId !== spec.guideNodeId && !isKnownGroupObjectiveHeading)
        || (Array.isArray(target.contentBlocks) && target.contentBlocks.length)
        || (target.images || []).length || (target.attachments || []).length || (target.sourceMedia || []).length)) return false;
    const targetFields = { ...target };
    delete targetFields.contentReviewState;
    delete targetFields.contentReviewNote;
    updates.push({
      ...targetFields,
      title: expectedTitle,
      type: 'Entrada',
      status: 'En revisión',
      area: source.area,
      tags: [...new Set([...(target.tags || []).filter((tag) => !['estructura', 'pendiente de contenido'].includes(tag)), 'contenido reorganizado dentro de la PWA'])],
      content: spec.content,
      contentBlocks: null,
      guideNodeId: spec.guideNodeId,
      customGuideNode: null,
      outlineScaffold: false,
      contentReviewState: 'pending',
      contentReviewNote: `Texto reorganizado desde ${sourceId}; verificar contenido y citas desde la PWA.`,
      groupObjectiveContentSplitMigration: migrationId,
      groupObjectiveContentSplitScaffoldBackup: target.groupObjectiveContentSplitScaffoldBackup || target,
      groupObjectiveContentSplitSourceId: sourceId,
      groupObjectiveContentSplitSourceHeading: spec.sourceHeading,
      updatedAt: now,
      localEditedAt: now,
      createdAt: target.createdAt || source.createdAt || now
    });
  }

  const archivedSource = {
    ...source,
    title: 'Respaldo de origen · Grupo objetivo · Story u61b7',
    status: 'Archivada',
    guideNodeId: null,
    customGuideNode: null,
    tags: [...new Set([...(source.tags || []), 'respaldo interno', 'contenido separado en el Atlas'])],
    groupObjectiveContentSplitMigration: migrationId,
    groupObjectiveContentSplitOriginalTitle: source.title,
    groupObjectiveContentSplitTargets: specs.map((spec) => spec.id),
    updatedAt: now,
    localEditedAt: now
  };
  await putEntriesAtomically([...updates, archivedSource]);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se distribuyó el contenido de ${sourceId} en ${updates.length} entradas del Atlas y se conservó el registro fuente archivado.`);
  return true;
}

async function resolvePresentOutlineScaffoldMarkers(sourceEntries, knownEntries) {
  const migrationId = 'resolve-present-outline-markers-from-pwa-content-2026-10-21-v1';
  const candidates = sourceEntries.filter((entry) => entry?.resolvedOutlineScaffold?.migrationId === migrationId);
  const groups = new Map();
  for (const incoming of candidates) {
    const markerId = incoming.resolvedOutlineScaffold.markerEntryId;
    if (!markerId) continue;
    groups.set(markerId, [...(groups.get(markerId) || []), incoming]);
  }
  let resolvedGroups = 0;
  for (const [markerId, incomingSources] of groups) {
    const evidence = incomingSources[0].resolvedOutlineScaffold;
    const markerSnapshot = evidence.markerSnapshot;
    const sourceIds = [...new Set(evidence.sourceEntryIds || [])];
    const completeSources = sourceIds.map((id) => incomingSources.find((entry) => entry.id === id));
    if (!markerSnapshot || markerSnapshot.id !== markerId || markerSnapshot.outlineScaffold !== true
      || !sourceIds.length || completeSources.some((entry) => !entry)) continue;
    const marker = knownEntries.get(markerId);
    const markerAlreadyDeleted = Boolean(atlasOrderState.deletedEntries?.[markerId]);
    if (marker && (marker.outlineScaffold !== true || marker.guideNodeId !== evidence.nodeId
      || marker.content !== markerSnapshot.content || marker.title !== markerSnapshot.title)) continue;
    if (!marker && !markerAlreadyDeleted) continue;
    const existingSources = completeSources.map((incoming) => knownEntries.get(incoming.id));
    let sourceEvidenceMatches = true;
    for (let index = 0; index < existingSources.length; index += 1) {
      const existing = existingSources[index];
      const hashMatches = existing?.content === completeSources[index].content
        && await sha256HexUtf8(existing.content) === completeSources[index].resolvedOutlineScaffold.sourceContentSha256;
      const splitQuestionMatches = markerId === 'atlas-outline-research-questions'
        && existing?.researchSectionSplitMigration === 'verified-research-question-objective-hierarchy-2026-10-19-v1'
        && new RegExp(`^0${index + 1}\\. Pregunta:\\s*\\n+`).test(existing.content || '')
        && !/0[12]\\. Objetivo:\\s*/.test(existing.content || '')
        && String(existing.content || '').trim().length >= 120;
      if (!existing || existing.guideNodeId !== evidence.nodeId
        || (!hashMatches && !splitQuestionMatches)) {
        sourceEvidenceMatches = false;
        break;
      }
    }
    if (!sourceEvidenceMatches) continue;
    if (existingSources.every((entry) => entry.resolvedOutlineScaffoldMigration === migrationId)) {
      if (markerAlreadyDeleted) continue;
    }
    const now = new Date().toISOString();
    const updatedSources = [];
    for (let index = 0; index < existingSources.length; index += 1) {
      const existing = existingSources[index];
      const incoming = completeSources[index];
      if (existing.resolvedOutlineScaffoldMigration === migrationId) {
        updatedSources.push(existing);
        continue;
      }
      updatedSources.push({
        ...existing,
        resolvedOutlineScaffold: {
          ...incoming.resolvedOutlineScaffold,
          sourceContentSha256: await sha256HexUtf8(existing.content),
          sourceContentEvidence: existing.researchSectionSplitMigration
            ? 'question-only-after-verified-split' : 'bundle-content-hash-match'
        },
        resolvedOutlineScaffoldSnapshot: {
          resolvedOutlineScaffold: existing.resolvedOutlineScaffold || null,
          mergedOutlineScaffoldBackup: existing.mergedOutlineScaffoldBackup || null,
          capturedAt: now
        },
        mergedOutlineScaffoldBackup: existing.mergedOutlineScaffoldBackup || markerSnapshot,
        resolvedOutlineScaffoldMigration: migrationId,
        updatedAt: now,
        localEditedAt: now
      });
    }
    await putEntriesAndDeleteAtomically(updatedSources, marker ? [markerId] : []);
    updatedSources.forEach((entry) => knownEntries.set(entry.id, entry));
    if (marker) knownEntries.delete(markerId);
    atlasOrderState.deletedEntries = { ...(atlasOrderState.deletedEntries || {}), [markerId]: atlasOrderState.deletedEntries?.[markerId] || now };
    atlasOrderState.entries = Object.fromEntries(Object.entries(atlasOrderState.entries || {})
      .map(([nodeId, ids]) => [nodeId, ids.filter((id) => id !== markerId)]));
    saveAtlasOrderState({ scheduleSync: false });
    resolvedGroups += 1;
  }
  if (resolvedGroups) {
    entries = await allEntries();
    if (githubSyncEnabled()) scheduleGitHubSync();
    console.info(`Se retiraron ${resolvedGroups} marcadores porque el contenido correspondiente ya está en la PWA; se conservaron como snapshots.`);
  }
  return resolvedGroups;
}

async function migrateAnnexMarkerCandidateReviews(sourceEntries, knownEntries) {
  const migrationId = 'annex-marker-sibling-content-audit-2026-10-21-v1';
  const updates = [];
  for (const incoming of sourceEntries) {
    const audit = incoming?.annexContentEvidenceAudit;
    if (audit?.migrationId !== migrationId || audit.reviewStatus !== 'same-node-candidate-not-confirmed') continue;
    const existing = knownEntries.get(incoming.id);
    const snapshot = audit.markerSnapshot;
    const candidate = knownEntries.get(audit.siblingEntryId);
    const incomingCandidate = sourceEntries.find(entry => entry?.id === audit.siblingEntryId);
    if (!existing || !snapshot || existing.annexContentEvidenceAudit?.migrationId === migrationId
      || existing.id !== snapshot.id || existing.title !== snapshot.title || existing.content !== snapshot.content
      || existing.guideNodeId !== snapshot.guideNodeId || existing.outlineScaffold !== true
      || existing.contentReviewState !== 'pending' || existing.contentReviewNote !== snapshot.contentReviewNote
      || !candidate || !incomingCandidate || candidate.guideNodeId !== audit.nodeId
      || candidate.title !== audit.siblingTitle || candidate.title !== incomingCandidate.title
      || candidate.content !== incomingCandidate.content) continue;
    if (await sha256HexUtf8(candidate.content) !== audit.siblingContentSha256) continue;
    updates.push({
      ...existing,
      contentReviewNote: incoming.contentReviewNote,
      annexContentEvidenceAudit: audit,
      annexContentEvidenceAuditSnapshot: incoming.annexContentEvidenceAuditSnapshot,
      updatedAt: new Date().toISOString(),
      localEditedAt: new Date().toISOString()
    });
  }
  if (!updates.length) return 0;
  await putEntriesAtomically(updates);
  updates.forEach(entry => knownEntries.set(entry.id, entry));
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se documentaron ${updates.length} candidatos de contenido en los marcadores de anexos; permanecen pendientes.`);
  return updates.length;
}

async function consolidateAliadoStrategicoScaffold() {
  const scaffoldId = 'atlas-outline-pgdg-7';
  const sourceId = 'idml-r1-u41a8';
  const migrationId = 'atlas-outline-consolidation-aliado-pgdg-7-v1';
  const expectedScaffoldText = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const current = await allEntries();
  const scaffold = current.find((entry) => entry.id === scaffoldId);
  const source = current.find((entry) => entry.id === sourceId);
  if (!scaffold || !source || scaffold.outlineScaffold !== true || scaffold.guideNodeId !== 'pgdg-7'
    || scaffold.title !== '2.4 · Aliado estratégico' || scaffold.content !== expectedScaffoldText
    || source.content !== 'ALIADO ESTRATÉGICO'
    || (source.guideNodeId && source.guideNodeId !== 'pgdg-7')) return false;

  const now = new Date().toISOString();
  const consolidated = {
    ...source,
    guideNodeId: 'pgdg-7',
    customGuideNode: null,
    contentReviewState: 'pending',
    contentReviewNote: 'La entrada de origen solo conserva el encabezado. Verificar e incorporar el contenido dentro de la PWA; no hay texto académico adicional en esta entrada.',
    outlineScaffold: false,
    aliadoEntryConsolidationMigration: migrationId,
    mergedOutlineScaffoldBackup: source.mergedOutlineScaffoldBackup || scaffold,
    updatedAt: now,
    localEditedAt: now
  };
  await putEntriesAndDeleteAtomically([consolidated], [scaffoldId]);
  atlasOrderState.deletedEntries = { ...(atlasOrderState.deletedEntries || {}), [scaffoldId]: now };
  atlasOrderState.entries = Object.fromEntries(Object.entries(atlasOrderState.entries || {})
    .map(([nodeId, ids]) => [nodeId, ids.filter((id) => id !== scaffoldId)]));
  saveAtlasOrderState({ scheduleSync: false });
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info('Se consolidó el registro duplicado de Aliado estratégico; el contenido sigue marcado como pendiente.');
  return true;
}

function clutterSectionHeading(line) {
  const match = String(line ?? '').trim().match(/^(4\.[1-5](?:\.\d+)?)\s+(.+)$/);
  return match ? { number: match[1], title: match[2].trim() } : null;
}

function normalizeFigureCaption(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es').replace(/[“”"'’.,:;!?()[\]{}]/g, '').replace(/\s+/g, ' ').trim();
}

function clutterSectionBlocks(body, figureRecords) {
  const blocks = [];
  const paragraphs = String(body ?? '').split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean);
  paragraphs.forEach((paragraph) => {
    const lines = paragraph.split(/\r?\n/);
    let textLines = [];
    const flushText = () => {
      const text = textLines.join('\n').trim();
      if (text) blocks.push({ type: 'paragraph', text });
      textLines = [];
    };
    lines.forEach((line) => {
      const normalizedLine = normalizeFigureCaption(line);
      const figureIndex = figureRecords.findIndex((record) => !record.used
        && normalizeFigureCaption(record.block.caption || record.block.alt || record.block.filename) === normalizedLine);
      if (figureIndex < 0) {
        textLines.push(line);
        return;
      }
      flushText();
      const record = figureRecords[figureIndex];
      record.used = true;
      blocks.push(record.block);
    });
    flushText();
  });
  return blocks;
}

async function splitClutterReferenceEntry() {
  const migrationId = 'clutter-reference-separation-v1';
  const currentEntries = await allEntries();
  const source = currentEntries.find((entry) => entry.id === 'idml-r1-u2b63');
  if (!source || source.contentSplitMigration === migrationId) return false;

  const sourceLines = String(source.content || '').split(/\r?\n/);
  const sections = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const heading = clutterSectionHeading(sourceLines[index]);
    if (!heading) continue;
    let end = index + 1;
    while (end < sourceLines.length && !clutterSectionHeading(sourceLines[end])) end += 1;
    sections.push({ ...heading, body: sourceLines.slice(index + 1, end).join('\n').trim() });
    index = end - 1;
  }

  const requiredNumbers = [
    '4.1', '4.1.1', '4.1.2', '4.1.3', '4.1.4', '4.1.5', '4.1.6',
    '4.2', '4.2.1', '4.2.2', '4.2.3',
    '4.3', '4.3.1', '4.3.2', '4.3.3',
    '4.4', '4.4.1', '4.4.2', '4.4.3',
    '4.5', '4.5.1', '4.5.2', '4.5.3', '4.5.4'
  ];
  const sectionsByNumber = new Map(sections.map((section) => [section.number, section]));
  if (requiredNumbers.some((number) => !sectionsByNumber.has(number))) {
    console.warn('Se conserva intacta la entrada 4.1: no se encontraron todos los encabezados esperados para separarla.');
    return false;
  }

  const bundled = bundledContentById.get(source.id);
  const localBlocks = Array.isArray(source.contentBlocks) ? source.contentBlocks : [];
  const bundledBlocks = Array.isArray(bundled?.contentBlocks) ? bundled.contentBlocks : [];
  const localFigureCount = localBlocks.filter((block) => block.type === 'figure').length;
  const bundledFigureCount = bundledBlocks.filter((block) => block.type === 'figure').length;
  const sourceBlocks = localFigureCount && localFigureCount === bundledFigureCount ? localBlocks : bundledBlocks;
  const figureRecords = sourceBlocks.flatMap((block, index) => {
    if (block.type !== 'figure' || typeof block.src !== 'string') return [];
    const figureId = block.figureId || `recovered:${source.id}:blocks:${index}:${block.filename || 'figura'}`;
    const citation = source.figureCitations?.[figureId] || block.citation || {};
    return [{
      used: false,
      sourceIndex: index,
      figureId,
      citation,
      block: { ...block, figureId }
    }];
  });

  const rootNodeIds = {
    '4.1': 'reference-clutter',
    '4.2': 'reference-disorganization',
    '4.3': 'reference-wellbeing',
    '4.4': 'reference-minimalism'
  };
  const rootEntryIds = {
    '4.1': source.id,
    '4.2': 'atlas-outline-reference-disorganization',
    '4.3': 'atlas-outline-reference-wellbeing',
    '4.4': 'atlas-outline-reference-minimalism',
    '4.5': 'atlas-clutter-source-4-5'
  };
  const existingById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const now = new Date().toISOString();
  const batch = [];

  sections.forEach((section) => {
    const isRoot = section.number.split('.').length === 2;
    const rootNumber = section.number.split('.').slice(0, 2).join('.');
    let id = rootEntryIds[rootNumber];
    if (!isRoot) id = `atlas-clutter-source-${section.number.replaceAll('.', '-')}`;
    if (!id) return;

    let parentId = null;
    let nodeId = null;
    let customGuideNode = null;
    if (rootNumber === '4.5') {
      nodeId = 'clutter-source-4-5';
      parentId = isRoot ? 'pgdg-4' : `clutter-source-${section.number.split('.').slice(0, -1).join('-')}`;
      customGuideNode = { id: nodeId, phaseId: 'investigacion', parentId, number: section.number, label: section.title };
    } else if (isRoot) {
      nodeId = rootNodeIds[rootNumber];
    } else {
      nodeId = `clutter-source-${section.number.replaceAll('.', '-')}`;
      const parentNumber = section.number.split('.').slice(0, -1).join('.');
      parentId = parentNumber === rootNumber
        ? rootNodeIds[rootNumber]
        : `clutter-source-${parentNumber.replaceAll('.', '-')}`;
      customGuideNode = { id: nodeId, phaseId: 'investigacion', parentId, number: section.number, label: section.title };
    }

    const targetId = isRoot && rootNumber === '4.1' ? source.id : id;
    const prior = existingById.get(targetId) || (targetId === source.id ? source : null);
    const sectionFigures = figureRecords.filter((record) => !record.used
      && Number(record.sourceIndex) >= 0);
    const contentBlocks = clutterSectionBlocks(section.body, sectionFigures);
    const figureCitations = {};
    contentBlocks.filter((block) => block.type === 'figure').forEach((block) => {
      const record = figureRecords.find((item) => item.figureId === block.figureId);
      if (record && Object.keys(record.citation).length) figureCitations[record.figureId] = record.citation;
    });
    const entry = {
      ...(prior || source),
      id: targetId,
      title: `${section.number} ${section.title}`,
      type: 'Entrada',
      status: prior?.outlineScaffold ? (source.status || 'En revisión') : (prior?.status || source.status || 'En revisión'),
      area: source.area || 'Origen IDML · Story u2b63',
      tags: [...new Set([
        ...(prior?.tags || []).filter((tag) => !['estructura', 'pendiente de contenido'].includes(tag)),
        'clutter', `sección ${section.number}`
      ])],
      content: section.body,
      contentBlocks,
      sourceMedia: [],
      images: isRoot && rootNumber === '4.1' ? (source.images || []) : (prior?.images || []),
      attachments: isRoot && rootNumber === '4.1' ? (source.attachments || []) : (prior?.attachments || []),
      figureCitations,
      guideNodeId: nodeId,
      customGuideNode,
      outlineScaffold: false,
      contentSplitMigration: migrationId,
      sourceSectionNumber: section.number,
      pwaCreated: true,
      localEditedAt: now,
      updatedAt: now,
      createdAt: prior?.createdAt || now
    };
    if (targetId === source.id) {
      entry.sourceSplitBackup = source.sourceSplitBackup || {
        title: source.title,
        type: source.type,
        area: source.area,
        tags: source.tags || [],
        content: source.content,
        contentBlocks: source.contentBlocks || sourceBlocks,
        sourceMedia: source.sourceMedia || [],
        images: source.images || [],
        attachments: source.attachments || [],
        figureCitations: source.figureCitations || {},
        guideNodeId: source.guideNodeId || null,
        customGuideNode: source.customGuideNode || null
      };
    } else if (prior && !prior.outlineScaffold && targetId !== source.id) {
      entry.previousAtlasEntryBackup = prior.previousAtlasEntryBackup || {
        title: prior.title,
        type: prior.type,
        area: prior.area,
        tags: prior.tags || [],
        content: prior.content,
        contentBlocks: prior.contentBlocks || null,
        sourceMedia: prior.sourceMedia || [],
        images: prior.images || [],
        attachments: prior.attachments || [],
        figureCitations: prior.figureCitations || {},
        guideNodeId: prior.guideNodeId || null,
        customGuideNode: prior.customGuideNode || null
      };
    }
    if (customGuideNode) entry.customGuideNode = customGuideNode;
    batch.push(entry);
    existingById.set(targetId, entry);
  });

  if (batch.length !== requiredNumbers.length || figureRecords.some((record) => !record.used)) {
    console.warn('Se conserva intacta la entrada 4.1: no se pudo preparar cada sección del Atlas.');
    return false;
  }

  const clutterScaffoldId = 'atlas-outline-reference-clutter';
  const scaffold = existingById.get(clutterScaffoldId);
  const deleteIds = scaffold?.outlineScaffold && scaffold.id !== source.id ? [clutterScaffoldId] : [];
  await putEntriesAndDeleteAtomically(batch, deleteIds);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se separaron ${batch.length} entradas de las secciones 4.1 a 4.5; ${figureRecords.length} figuras revisadas y conservadas.`);
  return true;
}

async function repairClutterAtlasHierarchy() {
  const currentEntries = await allEntries();
  const parentBySection = new Map([
    ['4.1', 'reference-clutter'],
    ['4.2', 'reference-disorganization'],
    ['4.3', 'reference-wellbeing'],
    ['4.4', 'reference-minimalism'],
    ['4.5', 'clutter-source-4-5']
  ]);
  currentEntries.forEach((entry) => {
    const number = entry.sourceSectionNumber;
    if (!number || !/^4\.[1-5](?:\.\d+)*$/.test(number)) return;
    const nodeId = entry.customGuideNode?.id || (number === '4.5' ? 'clutter-source-4-5' : parentBySection.get(number));
    if (nodeId) parentBySection.set(number, nodeId);
  });
  const updates = [];
  const now = new Date().toISOString();
  currentEntries.forEach((entry) => {
    const number = entry.sourceSectionNumber;
    if (!number || !entry.customGuideNode || !/^4\.[1-5](?:\.\d+)*$/.test(number)) return;
    const parts = number.split('.');
    const expectedParentId = parts.length === 2
      ? (number === '4.5' ? 'pgdg-4' : null)
      : parentBySection.get(parts.slice(0, -1).join('.'));
    if (!expectedParentId || entry.customGuideNode.parentId === expectedParentId) return;
    updates.push({
      ...entry,
      customGuideNode: { ...entry.customGuideNode, phaseId: 'investigacion', parentId: expectedParentId },
      localEditedAt: now,
      updatedAt: now
    });
  });
  if (!updates.length) return false;
  await putEntriesAndDeleteAtomically(updates);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se actualizaron ${updates.length} relaciones para respetar la jerarquía numérica del Atlas.`);
  return true;
}

async function splitClutterReferenceSubsections() {
  const currentEntries = await allEntries();
  const plans = [
    {
      number: '4.1.1',
      title: 'Tipos de Clutter',
      subsections: [
        ['a', 'Clutter emocional'],
        ['b', 'Clutter aspiracional'],
        ['c', 'Clutter de “algún día”'],
        ['d', 'Clutter físico'],
        ['e', 'Clutter digital y visual']
      ]
    },
    {
      number: '4.1.2',
      title: 'Origen de la problemática',
      subsections: [
        ['a', 'Factores de riesgo'],
        ['b', 'Cultura de consumo y modernidad líquida'],
        ['c', 'Procesos psicológicos: apego, aversión a la pérdida y procrastinación decisional'],
        ['d', 'Normas sociales, roles domésticos y aprendizaje vicario del consumo'],
        ['e', 'Contexto guatemalteco']
      ]
    },
    {
      number: '4.1.3',
      title: 'Efectos y consecuencias',
      subsections: [
        ['a', 'Efectos físicos'],
        ['b', 'Efectos en la salud mental'],
        ['c', 'Efectos comunitarios'],
        ['d', 'Efectos en otras áreas']
      ]
    },
    {
      number: '4.1.4',
      title: 'Salud mental y bienestar general',
      subsections: [
        ['1', 'Estrés cotidiano y sobrecarga de tareas'],
        ['2', 'Espacios saludables en el hogar'],
        ['3', 'Educación emocional y organización doméstica'],
        ['4', 'Trabajo, tiempo y autocuidado'],
        ['5', 'Estigma y búsqueda de ayuda psicológica']
      ],
      implicitParagraphs: [
        /^Altos niveles de estrés cotidiano/i,
        /^Déficit de espacios saludables en los hogares/i,
        /^Escasa educación en gestión emocional y organización doméstica/i,
        /^Condiciones laborales precarias y largas jornadas/i,
        /^Estigmatización de los trastornos mentales/i
      ],
      returnToParent: /^(El Ministerio de Salud Pública|En respuesta a esta problemática|En otras palabras|El Programa de las Naciones Unidas)/i
    }
  ];
  const now = new Date().toISOString();
  const batch = [];

  for (const plan of plans) {
    const migrationId = `clutter-reference-subsections-${plan.number.replaceAll('.', '-')}-v2`;
    const parentId = `atlas-clutter-source-${plan.number.replaceAll('.', '-')}`;
    const parent = currentEntries.find((entry) => entry.id === parentId);
    if (!parent || parent.clutterReferenceSubsectionsMigration === migrationId) continue;
    const sourceBlocks = Array.isArray(parent.contentBlocks) ? parent.contentBlocks : [];
    if (!sourceBlocks.length) continue;

    const groups = new Map([['parent', []], ...plan.subsections.map(([key]) => [key, []])]);
    let activeGroup = 'parent';
    let found = new Set();
    let paragraphLines = [];
    const flushParagraph = (block) => {
      const text = paragraphLines.join('\n').trim();
      if (text) groups.get(activeGroup).push({ ...block, text });
      paragraphLines = [];
    };
    sourceBlocks.forEach((block) => {
      if (block.type !== 'paragraph') {
        groups.get(activeGroup).push(block);
        return;
      }
      const lines = String(block.text || '').split(/\r?\n/);
      lines.forEach((line) => {
        const trimmed = line.trim();
        let subsectionIndex = -1;
        if (plan.implicitParagraphs) {
          if (plan.returnToParent?.test(trimmed)) {
            flushParagraph(block);
            activeGroup = 'parent';
            paragraphLines.push(line);
            return;
          }
          subsectionIndex = plan.implicitParagraphs.findIndex((pattern) => pattern.test(trimmed));
        } else {
          const match = trimmed.match(/^([a-e])\.\s*(.+)$/i);
          if (match) subsectionIndex = plan.subsections.findIndex(([key]) => key === match[1].toLowerCase());
        }
        if (subsectionIndex >= 0) {
          flushParagraph(block);
          activeGroup = plan.subsections[subsectionIndex][0];
          found.add(activeGroup);
          // The subsection label is now represented by the child entry title.
        } else {
          paragraphLines.push(line);
        }
      });
      flushParagraph(block);
    });

    const expectedKeys = plan.subsections.map(([key]) => key);
    if (expectedKeys.some((key) => !found.has(key) || !groups.get(key).some((block) => block.type === 'paragraph' && String(block.text || '').trim()))) {
      console.warn(`Se conserva ${plan.number}: faltan encabezados o contenido para separar sus subapartados.`);
      continue;
    }

    const citationMap = parent.figureCitations || {};
    const toContent = (blocks) => blocks.filter((block) => block.type === 'paragraph')
      .map((block) => String(block.text || '').trim()).filter(Boolean).join('\n\n');
    const citationsFor = (blocks) => Object.fromEntries(blocks
      .filter((block) => block.type === 'figure' && block.figureId && citationMap[block.figureId])
      .map((block) => [block.figureId, citationMap[block.figureId]]));
    const parentBlocks = groups.get('parent');
    batch.push({
      ...parent,
      content: toContent(parentBlocks),
      contentBlocks: parentBlocks,
      figureCitations: citationsFor(parentBlocks),
      clutterReferenceSubsectionsBackup: parent.clutterReferenceSubsectionsBackup || {
        content: parent.content,
        contentBlocks: parent.contentBlocks,
        figureCitations: parent.figureCitations || {}
      },
      clutterReferenceSubsectionsMigration: migrationId,
      localEditedAt: now,
      updatedAt: now
    });

    plan.subsections.forEach(([key, label], index) => {
      const childNumber = `${plan.number}.${index + 1}`;
      const nodeId = `clutter-source-${childNumber.replaceAll('.', '-')}`;
      const entryId = `atlas-clutter-source-${childNumber.replaceAll('.', '-')}`;
      const existing = currentEntries.find((entry) => entry.id === entryId);
      const contentBlocks = groups.get(key);
      batch.push({
        ...(existing || parent),
        id: entryId,
        title: label,
        type: 'Entrada',
        content: toContent(contentBlocks),
        contentBlocks,
        sourceMedia: [],
        images: [],
        attachments: [],
        guideNodeId: nodeId,
        customGuideNode: {
          id: nodeId,
          phaseId: 'investigacion',
          parentId: parent.customGuideNode?.id || `clutter-source-${plan.number.replaceAll('.', '-')}`,
          number: childNumber,
          label
        },
        sourceSectionNumber: childNumber,
        sourceSubsectionLetter: plan.implicitParagraphs ? null : key,
        sourceSubsectionParentNumber: plan.number,
        figureCitations: citationsFor(contentBlocks),
        pwaCreated: true,
        outlineScaffold: false,
        clutterReferenceSubsectionsMigration: migrationId,
        localEditedAt: now,
        updatedAt: now,
        createdAt: existing?.createdAt || now
      });
    });
  }

  if (!batch.length) return false;
  await putEntriesAtomically(batch);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se anidaron los conceptos identificados de 4.1.1 a 4.1.4 en ${batch.length} registros del Atlas.`);
  return true;
}

async function normalizeAtlasEntryTypes() {
  const currentEntries = await allEntries();
  const depthByNodeId = new Map();
  const visit = (nodes, depth = 1) => nodes.forEach((node) => {
    depthByNodeId.set(node.id, depth);
    visit(node.children ?? [], depth + 1);
  });
  orderedPhases().map(effectivePhase).filter((phase) => phase.id !== 'sin-clasificar').forEach((phase) => {
    visit(atlasNodesForPhase(phase));
  });
  const now = new Date().toISOString();
  const updates = currentEntries.filter((entry) => {
    const node = guideNodeForEntry(entry);
    if (normalizeEntryType(entry.type, entry.type) !== entry.type) return true;
    if (!node || (depthByNodeId.get(node.id) ?? 0) <= 1) return false;
    return entry.type === 'Nota' && Boolean(entry.customGuideNode || entry.sourceSectionNumber || entry.outlineScaffold);
  }).map((entry) => ({ ...entry, type: 'Entrada', localEditedAt: now, updatedAt: now }));
  if (!updates.length) return false;
  await putEntriesAtomically(updates);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se normalizaron ${updates.length} registros de contenido. Partes y capítulos permanecen como contenedores del Atlas.`);
  return true;
}

async function splitClutterPreventionSubsections() {
  const migrationId = 'clutter-prevention-subsections-v1';
  const currentEntries = await allEntries();
  const parent = currentEntries.find((entry) => entry.sourceSectionNumber === '4.1.5'
    || entry.id === 'atlas-clutter-source-4-1-5');
  if (!parent || parent.clutterSubsectionsMigration === migrationId) return false;

  const sectionLabels = new Map([
    ['a', 'Prevención del Clutter'],
    ['b', 'Abordaje psicológico'],
    ['c', 'Fortalecimiento del entorno físico'],
    ['conclusion', 'Conclusión de las intervenciones']
  ]);
  const sourceBlocks = Array.isArray(parent.contentBlocks) ? parent.contentBlocks : [];
  if (!sourceBlocks.length) return false;

  const groups = new Map([['parent', []], ...[...sectionLabels.keys()].map((key) => [key, []])]);
  let activeGroup = 'parent';
  let foundSubsections = 0;
  sourceBlocks.forEach((block) => {
    if (block.type !== 'paragraph') {
      groups.get(activeGroup).push(block);
      return;
    }
    let lines = [];
    const flush = () => {
      const text = lines.join('\n').trim();
      if (text) groups.get(activeGroup).push({ ...block, text });
      lines = [];
    };
    String(block.text || '').split(/\r?\n/).forEach((line) => {
      const heading = line.trim().match(/^([a-c])\.\s+(.+)$/i);
      if (heading && sectionLabels.has(heading[1].toLowerCase())) {
        flush();
        activeGroup = heading[1].toLowerCase();
        foundSubsections += 1;
      } else if (/^Conclusión de las intervenciones$/i.test(line.trim())) {
        flush();
        activeGroup = 'conclusion';
      } else {
        lines.push(line);
      }
    });
    flush();
  });
  if (foundSubsections !== 3 || [...sectionLabels.keys()].some((key) => !groups.get(key).length)) {
    console.warn('No se separó 4.1.5: no se reconocieron todos sus tres apartados y contenido.');
    return false;
  }

  const citationMap = parent.figureCitations || {};
  const toContent = (blocks) => blocks.filter((block) => block.type === 'paragraph')
    .map((block) => String(block.text || '').trim()).filter(Boolean).join('\n\n');
  const citationsFor = (blocks) => Object.fromEntries(blocks
    .filter((block) => block.type === 'figure' && block.figureId && citationMap[block.figureId])
    .map((block) => [block.figureId, citationMap[block.figureId]]));
  const now = new Date().toISOString();
  const batch = [{
    ...parent,
    content: toContent(groups.get('parent')),
    contentBlocks: groups.get('parent'),
    figureCitations: citationsFor(groups.get('parent')),
    clutterSubsectionsBackup: parent.clutterSubsectionsBackup || {
      content: parent.content,
      contentBlocks: parent.contentBlocks || null,
      figureCitations: parent.figureCitations || {}
    },
    clutterSubsectionsMigration: migrationId,
    localEditedAt: now,
    updatedAt: now
  }];

  [...sectionLabels.entries()].forEach(([letter, label], index) => {
    const nodeId = `clutter-source-4-1-5-${letter}`;
    const entryId = `atlas-clutter-source-4-1-5-${letter}`;
    const prior = currentEntries.find((entry) => entry.id === entryId);
    const contentBlocks = groups.get(letter);
    batch.push({
      ...(prior || parent),
      id: entryId,
      title: label,
      type: 'Nota',
      content: toContent(contentBlocks),
      contentBlocks,
      sourceMedia: [],
      images: [],
      attachments: [],
      guideNodeId: nodeId,
      customGuideNode: {
        id: nodeId,
        phaseId: 'investigacion',
        parentId: parent.customGuideNode?.id || 'clutter-source-4-1-5',
        number: `4.1.5.${index + 1}`,
        label
      },
      sourceSubsectionLetter: letter,
      figureCitations: citationsFor(contentBlocks),
      pwaCreated: true,
      outlineScaffold: false,
      clutterSubsectionsMigration: migrationId,
      localEditedAt: now,
      updatedAt: now,
      createdAt: prior?.createdAt || now
    });
  });

  await putEntriesAtomically(batch);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info('Se organizaron los apartados de 4.1.5 como nodos hijos y se conservaron sus figuras.');
  return true;
}

async function repairClutterPreventionSubsectionHierarchy() {
  const migrationId = 'clutter-prevention-subsections-hierarchy-v2';
  const currentEntries = await allEntries();
  const parent = currentEntries.find((entry) => entry.id === 'atlas-clutter-source-4-1-5');
  if (!parent) return false;

  const parentNodeId = parent.customGuideNode?.id || 'clutter-source-4-1-5';
  const subsections = [
    ['a', 'Prevención del Clutter'],
    ['b', 'Abordaje psicológico'],
    ['c', 'Fortalecimiento del entorno físico'],
    ['conclusion', 'Conclusión de las intervenciones']
  ];
  const now = new Date().toISOString();
  const updates = [];
  subsections.forEach(([letter, label], index) => {
    const id = `atlas-clutter-source-4-1-5-${letter}`;
    const entry = currentEntries.find((item) => item.id === id);
    if (!entry) return;
    const number = `4.1.5.${index + 1}`;
    const guideNodeId = `clutter-source-4-1-5-${letter}`;
    if (entry.clutterSubsectionsHierarchyMigration === migrationId
      && entry.guideNodeId === guideNodeId
      && entry.customGuideNode?.parentId === parentNodeId
      && entry.customGuideNode?.number === number
      && entry.sourceSectionNumber === number) return;
    updates.push({
      ...entry,
      guideNodeId,
      customGuideNode: {
        ...(entry.customGuideNode || {}),
        id: guideNodeId,
        phaseId: 'investigacion',
        parentId: parentNodeId,
        number,
        label
      },
      sourceSectionNumber: number,
      clutterSubsectionsHierarchyMigration: migrationId,
      localEditedAt: now,
      updatedAt: now
    });
  });
  if (!updates.length) return false;
  await putEntriesAtomically(updates);
  entries = await allEntries();
  if (githubSyncEnabled()) scheduleGitHubSync();
  console.info(`Se corrigió la jerarquía de ${updates.length} subapartados de 4.1.5.`);
  return true;
}

function registerLibraryEvents() {
  $('#new-entry-button').addEventListener('click', startNewEntry);
  entryList.addEventListener('focusin', (event) => {
    const focusedArticle = event.target.closest('.feed-entry');
    if (!focusedArticle || renderedEntryCount >= listEntrySnapshot.length) return;
    const renderedArticles = entryList.querySelectorAll('.feed-entry');
    if (focusedArticle !== renderedArticles[renderedArticles.length - 1]) return;
    // Keep the progressive reader navigable by keyboard when focus reaches its last rendered entry.
    appendEntryBatch(renderedEntryCount + ENTRY_RENDER_BATCH);
  });
  entryList.addEventListener('click', (event) => {
    const atlasLocationButton = event.target.closest('[data-atlas-locate]');
    if (atlasLocationButton) {
      showAtlasAtEntry(atlasLocationButton.dataset.atlasLocate);
      return;
    }
    const button = event.target.closest('[data-edit-entry]');
    if (!button) return;
    const entry = entries.find((item) => item.id === button.dataset.editEntry);
    const article = button.closest('.feed-entry');
    if (entry && article) openEntryEditor(article, entry);
  });
  $('#back-to-section').addEventListener('click', () => {
    if (entryOpenedFromAtlas) {
      showAtlasAtEntry(entryIdFromLocation() || selectedId);
      return;
    }
    clearEntryLocation();
    showEntryWorkspace = false;
    renderList();
  });
  $('#search-input').addEventListener('input', (event) => {
    clearEntryLocation();
    searchTerm = event.target.value;
    if (searchTerm) { showHomePage = false; showAtlasHome = false; showFigureCredits = false; showApaAudit = false; showEntryWorkspace = true; }
    renderList();
  });
  $('#status-filter').addEventListener('change', (event) => {
    clearEntryLocation();
    statusFilter = event.target.value;
    showHomePage = false;
    showAtlasHome = false;
    showFigureCredits = false;
    showApaAudit = false;
    showEntryWorkspace = true;
    renderList();
  });
}

function registerEvents() {
  setTheme(document.documentElement.dataset.theme, false);
  refreshGitHubSyncControl();
  registerAtlasDragEvents();
  $('#github-sync-button').addEventListener('click', toggleGitHubSync);
  $('#force-refresh-button').addEventListener('click', forceRefreshApplication);
  $('#apa-historical-snapshot').addEventListener('toggle', () => {
    if ($('#apa-historical-snapshot').open) void renderHistoricalApaSnapshot();
  });
  $('#topbar-atlas-link').addEventListener('click', (event) => {
    event.preventDefault();
    $('#nav-list [data-filter="atlas"]').click();
  });
  window.addEventListener('scroll', () => {
    const nearEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 700;
    if (showEntryWorkspace && nearEnd && renderedEntryCount < listEntrySnapshot.length) appendEntryBatch();
    syncReaderSequenceFromViewport();
  }, { passive: true });
  window.addEventListener('popstate', () => {
    if (entryIdFromLocation()) restoreEntryFromLocation();
    else if (!location.hash) restoreHomeFromLocation();
  });
  window.addEventListener('hashchange', () => {
    if (entryIdFromLocation()) restoreEntryFromLocation();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) reconcileRestoredReaderLocation(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileRestoredReaderLocation();
  });
  $('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#copy-figure-credits').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(figureCreditsPlainText());
      showToast('Listado de créditos copiado.');
    } catch (error) {
      showToast('No se pudo copiar automáticamente; descarga el archivo de texto.');
    }
  });
  $('#download-figure-credits').addEventListener('click', exportFigureCredits);
  $('#focus-search-button').addEventListener('click', () => {
    clearEntryLocation();
    showHomePage = false;
    showAtlasHome = false;
    showFigureCredits = false;
    showApaAudit = false;
    showEntryWorkspace = true;
    activeSection = null;
    activeFilter = 'all';
    renderList();
    $('#search-input').focus();
    $('#search-input').scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' });
  });
  $('#nav-list').addEventListener('click', (event) => {
    const entryButton = event.target.closest('[data-entry-id]');
    if (entryButton) {
      closeNavigation();
      openEntryFromAtlas(entryButton.dataset.entryId);
      return;
    }
    const sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      clearEntryLocation();
      atlasFocusEntryId = null;
      atlasFocusNeedsScroll = false;
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      entryOpenedFromAtlas = false;
      activeSection = activeSection === sectionButton.dataset.section ? null : sectionButton.dataset.section;
      showEntryWorkspace = false;
      activeFilter = 'all';
      sectionSearchTerm = '';
      $('#section-search').value = '';
      document.querySelectorAll('[data-filter]').forEach((item) => item.classList.remove('is-active'));
      renderList();
      const visible = filteredEntries();
      if (showEntryWorkspace && visible.length && !visible.some((entry) => entry.id === selectedId)) selectEntry(visible[0].id);
      return;
    }
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    clearEntryLocation();
    closeNavigation();
    document.querySelectorAll('.sidebar-more').forEach((menu) => { menu.open = false; });
    if (button.dataset.filter === 'search') {
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      showEntryWorkspace = true;
      activeSection = null;
      activeFilter = 'all';
      renderList();
      $('#search-input').focus();
      return;
    }
    showHomePage = button.dataset.filter === 'home';
    showAtlasHome = button.dataset.filter === 'atlas';
    showFigureCredits = button.dataset.filter === 'figure-credits';
    showApaAudit = button.dataset.filter === 'apa-audit';
    showEntryWorkspace = !showAtlasHome && !showHomePage && !showFigureCredits && !showApaAudit;
    activeSection = null;
    activeFilter = showAtlasHome || showHomePage ? 'all' : button.dataset.filter;
    if (showAtlasHome || showHomePage) {
      searchTerm = '';
      statusFilter = 'all';
      if ($('#search-input')) $('#search-input').value = '';
      if ($('#status-filter')) $('#status-filter').value = 'all';
    }
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('is-active', item === button));
    renderList();
    const visible = filteredEntries();
    if (visible.length && !visible.some((entry) => entry.id === selectedId)) selectEntry(visible[0].id);
    if (showHomePage) window.scrollTo(0, 0);
  });
  $('.main-area').addEventListener('click', (event) => {
    const deleteEntryButton = event.target.closest('[data-delete-entry]');
    if (deleteEntryButton) {
      event.preventDefault();
      event.stopPropagation();
      void deleteAtlasEntry(deleteEntryButton.dataset.deleteEntry);
      return;
    }
    const deletePhaseButton = event.target.closest('[data-delete-phase]');
    if (deletePhaseButton) {
      event.preventDefault();
      event.stopPropagation();
      void deleteAtlasChapter(deletePhaseButton.dataset.deletePhase);
      return;
    }
    const atlasFocusButton = event.target.closest('[data-atlas-focus-entry]');
    if (atlasFocusButton) {
      showAtlasAtEntry(atlasFocusButton.dataset.atlasFocusEntry);
      return;
    }
    const viewButton = event.target.closest('[data-filter]');
    if (viewButton) {
      const navButton = $(`#nav-list [data-filter="${viewButton.dataset.filter}"]`);
      navButton?.click();
      return;
    }
    const sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      clearEntryLocation();
      atlasFocusEntryId = null;
      atlasFocusNeedsScroll = false;
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      entryOpenedFromAtlas = false;
      activeSection = sectionButton.dataset.section;
      showEntryWorkspace = false;
      activeFilter = 'all';
      sectionSearchTerm = '';
      $('#section-search').value = '';
      document.querySelectorAll('[data-filter]').forEach((item) => item.classList.remove('is-active'));
      renderList();
      window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
      return;
    }
    const sequenceLink = event.target.closest('.reader-sequence-link[data-entry-id]');
    if (sequenceLink) {
      event.preventDefault();
      showEntryById(sequenceLink.dataset.entryId, { historyMode: 'push', openedFromAtlas: entryOpenedFromAtlas });
      return;
    }
    const outlineToggle = event.target.closest('.reader-outline-toggle[data-toggle-outline-node]');
    if (outlineToggle) {
      const item = outlineToggle.closest('.reader-outline-item');
      const children = item?.querySelector(':scope > .reader-outline-children');
      if (children) {
        children.hidden = !children.hidden;
        outlineToggle.setAttribute('aria-expanded', String(!children.hidden));
        const label = item.querySelector(':scope > .reader-outline-row .reader-phase-chapter-label')?.textContent || 'este apartado';
        outlineToggle.setAttribute('aria-label', `${children.hidden ? 'Desplegar' : 'Cerrar'} apartados de ${label}`);
      }
      return;
    }
    const chapterButton = event.target.closest('.reader-phase-chapter[data-guide-node-id]');
    if (chapterButton && !chapterButton.disabled) {
      const targetEntry = listEntrySnapshot.find((entry) => guideNodeForEntry(entry)?.id === chapterButton.dataset.guideNodeId);
      if (targetEntry) showEntryById(targetEntry.id, { historyMode: 'push', openedFromAtlas: entryOpenedFromAtlas });
      return;
    }
    const entryButton = event.target.closest('.atlas-entry-link[data-entry-id]');
    if (!entryButton) return;
    openEntryFromAtlas(entryButton.dataset.entryId);
  });
  const backToAtlas = () => {
    clearEntryLocation();
    atlasFocusEntryId = null;
    atlasFocusNeedsScroll = false;
    activeSection = null;
    showHomePage = false;
    showAtlasHome = true;
    showFigureCredits = false;
    showApaAudit = false;
    showEntryWorkspace = false;
    activeFilter = 'all';
    searchTerm = '';
    if ($('#search-input')) $('#search-input').value = '';
    renderList();
  };
  $('#back-to-atlas').addEventListener('click', backToAtlas);
  $('#back-to-sections').addEventListener('click', backToAtlas);
  $('#atlas-clear-focus').addEventListener('click', () => {
    atlasFocusEntryId = null;
    atlasFocusNeedsScroll = false;
    renderList();
  });
  $('#atlas-expand-all').addEventListener('click', () => setAtlasDisclosureState(true));
  $('#atlas-collapse-all').addEventListener('click', () => setAtlasDisclosureState(false));
  $('#section-search').addEventListener('input', (event) => {
    sectionSearchTerm = event.target.value;
    renderList();
  });
  const sidebar = document.querySelector('.sidebar');
  const workspace = document.querySelector('.workspace');
  const menuToggle = $('#menu-toggle');
  const desktopMenu = window.matchMedia('(min-width: 761px)');
  const syncSidebarMode = () => {
    sidebar.inert = true;
    sidebar.setAttribute('aria-hidden', 'true');
    if (desktopMenu.matches) {
      workspace.classList.add('sidebar-collapsed');
      sidebar.classList.add('is-open');
      $('#nav-scrim').hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Mostrar menú');
      menuToggle.textContent = '☰';
    } else {
      sidebar.classList.remove('is-open');
      workspace.classList.remove('sidebar-collapsed');
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Mostrar menú');
      menuToggle.textContent = '☰';
      $('#nav-scrim').hidden = true;
    }
  };
  syncSidebarMode();
  desktopMenu.addEventListener('change', syncSidebarMode);
  menuToggle.addEventListener('click', () => {
    if (desktopMenu.matches) {
      const collapsed = workspace.classList.toggle('sidebar-collapsed');
      const expanded = !collapsed;
      sidebar.inert = !expanded;
      sidebar.setAttribute('aria-hidden', String(!expanded));
      menuToggle.setAttribute('aria-expanded', String(expanded));
      menuToggle.setAttribute('aria-label', expanded ? 'Ocultar menú' : 'Mostrar menú');
      menuToggle.textContent = expanded ? '×' : '☰';
      return;
    }
    const expanded = sidebar.classList.toggle('is-open');
    sidebar.inert = !expanded;
    sidebar.setAttribute('aria-hidden', String(!expanded));
    menuToggle.setAttribute('aria-expanded', String(expanded));
    menuToggle.setAttribute('aria-label', expanded ? 'Ocultar menú' : 'Mostrar menú');
    menuToggle.textContent = expanded ? '×' : '☰';
    $('#nav-scrim').hidden = !expanded;
  });
  $('#nav-scrim').addEventListener('click', closeNavigation);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNavigation();
  });
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('es') === 'k') {
      event.preventDefault();
      clearEntryLocation();
      showHomePage = false;
      showAtlasHome = false;
      showFigureCredits = false;
      showApaAudit = false;
      showEntryWorkspace = true;
      activeSection = null;
      activeFilter = 'all';
      renderList();
      $('#search-input').focus();
      $('#search-input').select();
    }
  });
  $('#export-button').addEventListener('click', exportBackup);
  $('#export-project-button').addEventListener('click', exportFullProjectPackage);
  $('#download-historical-backup-button').addEventListener('click', downloadHistoricalPwaBackup);
  $('#import-button').addEventListener('click', () => $('#import-input').click());
  $('#review-content-corrections-button').addEventListener('click', reviewBundledContentCorrections);
  $('#import-input').addEventListener('change', async (event) => {
    if (event.target.files?.[0]) await importBackup(event.target.files[0]);
    event.target.value = '';
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#install-button').hidden = false;
  });
  $('#install-button').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#install-button').hidden = true;
  });
  const iosInstallHelp = $('#ios-install-help-button');
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (iosInstallHelp && isIos && !isStandalone) iosInstallHelp.hidden = false;
  iosInstallHelp?.addEventListener('click', () => {
    window.alert('Para agregar Clutter DEMO al inicio:\n1. Abre esta página en Safari.\n2. Toca Compartir (cuadro con flecha hacia arriba).\n3. Elige “Agregar a pantalla de inicio”.\n4. Confirma con “Agregar”.\n\nSi abriste el enlace desde otra app, primero ábrelo en Safari.');
  });
  $('#offline-download-button')?.addEventListener('click', () => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) {
      window.alert('La app todavía está preparando el modo sin conexión. Déjala abierta unos segundos y vuelve a intentarlo.');
      return;
    }
    offlineMediaCacheRequested = true;
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => { channel.port1.close(); offlineMediaCacheRequested = false; }, 600000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      offlineMediaCacheRequested = false;
      void refreshOfflineMediaStatus();
      const status = event.data;
      window.alert(status ? `Medios guardados para uso sin conexión: ${status.cached} de ${status.expected}. Mantén esta página abierta mientras termina.` : 'No se pudo completar la descarga offline.');
    };
    channel.port1.start();
    worker.postMessage({ type: 'CACHE_BUNDLED_MEDIA_OFFLINE' }, [channel.port2]);
  });
  window.addEventListener('online', () => {
    const state = $('#connection-state');
    if (state) state.textContent = 'En línea';
    if (githubSyncEnabled()) scheduleGitHubSync();
  });
  window.addEventListener('offline', () => refreshOfflineMediaStatus());
  window.addEventListener('online', () => refreshOfflineMediaStatus());
}

async function markKnownEmptyAtlasSectionsPending() {
  const migrationId = 'pwa-empty-reference-sections-pending-v1';
  const ids = new Set(['atlas-outline-reference-disorganization', 'atlas-outline-reference-wellbeing']);
  const currentEntries = await allEntries();
  const legacyScaffoldText = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de incorporar desde los documentos fuente. Esta entrada no contiene texto recuperado ni redactado.';
  const currentScaffoldText = 'Apartado estructural creado para mantener la jerarquía del Atlas.\n\nEl contenido académico está pendiente de verificación e incorporación en la PWA. Esta entrada no contiene texto académico recuperado ni redactado.';
  const updates = currentEntries.flatMap((entry) => {
    if (ids.has(entry.id) && !String(entry.content || '').trim()
      && (!Array.isArray(entry.contentBlocks) || entry.contentBlocks.length === 0)
      && entry.contentReviewMigration !== migrationId) {
      return [{
        ...entry,
        contentReviewState: 'pending',
        contentReviewNote: 'Contenido académico pendiente de incorporar y verificar dentro de la PWA.',
        contentReviewMigration: migrationId
      }];
    }
    if (entry.outlineScaffold === true && entry.content === legacyScaffoldText) {
      return [{
        ...entry,
        content: currentScaffoldText,
        contentReviewState: 'pending',
        contentReviewNote: 'Contenido académico pendiente de incorporar y verificar dentro de la PWA.',
        contentReviewMigration: migrationId
      }];
    }
    return [];
  });
  if (updates.length) await putEntriesAtomically(updates);
  return updates.length;
}

async function migrateIndependentProjectTaskRecords() {
  const migrationId = 'pwa-independent-task-records-v1';
  const records = new Map([
    ['eaa90adb-0f62-49dd-8159-4036ccfd26c7', { old: "1. Abrir una copia del INDD en InDesign y revisar páginas, vínculos, fuentes y texto desbordado.\n2. Exportar copias nuevas de IDML y PDF con nombres nuevos.\n3. Comparar las exportaciones con los originales del 31 de marzo.\n4. Confirmar los lineamientos vigentes de la carrera.\n5. Auditar citas y referencias con APA 7 cuando se confirme la versión base.\n6. Determinar qué capítulos, anexos y entregables siguen pendientes.", content: "Pendientes de cierre dentro de la PWA:\n1. Completar y verificar las entradas marcadas como pendientes en el Atlas; dejar cualquier dato no comprobado identificado para revisión.\n2. Adjudicar las citas y referencias desde el control APA de la PWA, confirmando qué fuente respalda cada afirmación.\n3. Completar la procedencia, los créditos y los permisos de las figuras; resolver las correspondencias marcadas como pendientes.\n4. Guardar en la PWA los lineamientos vigentes de la Facultad y registrar su fuente.\n5. Revisar los anexos y entregables pendientes señalados en las entradas del proyecto.\n6. Exportar el proyecto completo y comprobar su restauración y lectura sin conexión.\n\nLa biblioteca y el paquete exportado son la base de trabajo. Estos pendientes se resuelven dentro de la PWA; los archivos originales quedan como archivo histórico, no como dependencia operativa.", title: 'Pendientes de cierre en la PWA', status: 'En revisión', tags: ['pendientes', 'PWA', 'APA 7'] }],
    ['3f303b35-07c2-4c68-8b31-4af537da4800', { old: "El paquete preservado contiene 60 archivos. El PDF y el IDML del 31 de marzo de 2026 tienen 169 páginas. El INDD del 16 de abril es el candidato editable más reciente por fecha; una lectura estática halló títulos de capítulos, conclusiones y anexos, pero aún hay que abrirlo en InDesign para comprobar su integridad y maquetación.\n\nEl PDF e IDML incluyen planteamiento, objetivos, metodología, marco de referencia, propuesta, conclusiones, referencias y anexos con resultados del diagnóstico a 50 personas. Todavía no se ha elegido una versión base ni se ha reescrito el contenido.", content: "Antecedente de recuperación registrado el 16 de octubre de 2026. En ese momento se inventariaron 60 archivos y se anotó que el PDF/IDML del 31 de marzo tenía 169 páginas, mientras que el INDD del 16 de abril era el archivo editable más reciente por fecha. La lectura estática de entonces describió títulos y secciones visibles; no constituye validación vigente del contenido.\n\nEste registro se conserva como historial de procedencia. La PWA es ahora la base de trabajo: cualquier revisión pendiente se gestiona en sus entradas, referencias y créditos, sin requerir abrir, exportar ni comparar archivos PDF, IDML o INDD.", status: 'Archivada', tags: ['histórico', 'procedencia', 'PWA'] }]
  ]);
  const currentEntries = await allEntries();
  const updates = currentEntries.flatMap((entry) => {
    const record = records.get(entry.id);
    if (!record || entry.content !== record.old || entry.localEditedAt
      || entry.pwaIndependenceMigration === migrationId) return [];
    const { old, ...replacement } = record;
    return [{ ...entry, ...replacement, pwaIndependenceMigration: migrationId, updatedAt: new Date().toISOString() }];
  });
  if (updates.length) await putEntriesAtomically(updates);
  return updates.length;
}

async function init() {
  registerEvents();
  try {
    db = await openDatabase();
    entries = await allEntries();
    await mergeBundledProjectContent();
    await markKnownEmptyAtlasSectionsPending();
    await migrateIndependentProjectTaskRecords();
    await applyVerifiedSpellingCorrections();
    await applyVerifiedFigureCaptionCorrections();
    await splitResearchQuestionsAndObjectives();
    entries = await allEntries();
    await consolidateAliadoStrategicoScaffold();
    const scaffoldCount = await ensureAtlasSectionEntries();
    if (scaffoldCount) console.info(`Se crearon ${scaffoldCount} entradas estructurales para apartados vacíos del Atlas.`);
    await splitGroupObjectiveSourceEntry();
    await splitClutterReferenceEntry();
    await repairClutterAtlasHierarchy();
    await splitClutterReferenceSubsections();
    await splitClutterPreventionSubsections();
    await repairClutterPreventionSubsectionHierarchy();
    await normalizeAtlasEntryTypes();
    entries = await allEntries();
    describeBrowserStorage();
    entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (!restoreEntryFromLocation()) renderList();
    if (githubSyncEnabled()) syncGitHubNow();
  } catch (error) {
    showStorageError(error);
    const saveState = $('#entry-save-state');
    if (saveState) saveState.textContent = 'Almacenamiento no disponible';
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => refreshOfflineMediaStatus(registration))
      .catch((error) => console.warn('No se pudo activar el modo sin conexión:', error));
  }
}

init();

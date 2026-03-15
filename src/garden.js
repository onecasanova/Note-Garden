import * as d3 from 'd3';
import { open, message, ask } from '@tauri-apps/plugin-dialog';
import { readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { load } from '@tauri-apps/plugin-store';
import stopwords from './stopwords.json';

// ── Configuration ──
const TOP_N_WORDS = 20;
const MIN_WORD_LENGTH = 4;
const NODE_SIZE_RANGE = [10, 44];
const LABEL_SIZE_RANGE = [14, 25];

// ── Color palette (dark fills with bone stroke) ──
const colorScale = d3.scaleSequential(d3.interpolateRgbBasis([
  '#1a1a1a', '#1f2520', '#1a2a1e', '#202820', '#1e2222', '#1a1f1a'
]));

// ── State ──
let simulation, svg, container, tooltip, detailPanel;
let nodesData = [], linksData = [];
let noteContents = {}; // filename → full text

let store;
let gardens = [];
let activeGardenId = null;
let stopSet;
let contextMenuTargetId = null;

// ── Entry point ──
async function init() {
  stopSet = new Set(stopwords);

  // Initialize store
  store = await load('gardens.json', { autoSave: false });
  gardens = (await store.get('gardens')) || [];
  activeGardenId = (await store.get('activeGardenId')) || null;

  // Wire up event listeners
  document.getElementById('open-folder-btn').addEventListener('click', createNewGarden);
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
  document.getElementById('new-garden-btn').addEventListener('click', createNewGarden);

  // Context menu buttons — direct handlers to avoid event delegation issues
  document.querySelector('#context-menu [data-action="rename"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.querySelector('#context-menu [data-action="rename"]').addEventListener('click', (e) => {
    e.stopPropagation();
    onContextMenuAction('rename');
  });
  document.querySelector('#context-menu [data-action="delete"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.querySelector('#context-menu [data-action="delete"]').addEventListener('click', (e) => {
    e.stopPropagation();
    onContextMenuAction('delete');
  });
  // Hide context menu on any click outside
  document.addEventListener('click', hideContextMenu);

  initSidebarResize();
  renderGardenList();

  // Auto-restore last active garden
  if (activeGardenId) {
    const garden = gardens.find(g => g.id === activeGardenId);
    if (garden) {
      await loadGarden(garden);
      return;
    }
  }

  // No active garden — show welcome screen
  document.getElementById('welcome-screen').style.display = '';
  document.getElementById('app').style.display = 'none';
}

// ── Store persistence ──
async function saveStore() {
  await store.set('gardens', gardens);
  await store.set('activeGardenId', activeGardenId);
  await store.save();
}

// ── Garden management ──
async function createNewGarden() {
  const selectedFolder = await open({ directory: true, multiple: false });
  if (!selectedFolder) return;

  // Validate folder has .txt files
  let entries;
  try {
    entries = await readDir(selectedFolder);
  } catch {
    await message('Could not read the selected folder.', { title: 'Error', kind: 'error' });
    return;
  }

  const noteFiles = entries.filter(e => e.name && (e.name.endsWith('.txt') || e.name.endsWith('.md')));
  if (noteFiles.length === 0) {
    await message('No .txt or .md files found in the selected folder.', { title: 'Error', kind: 'error' });
    return;
  }

  // Use folder name as garden name (user can rename via sidebar)
  const name = selectedFolder.split('/').pop() || 'Untitled';

  // Create garden object
  const garden = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    folderPath: selectedFolder,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString()
  };

  gardens.push(garden);
  activeGardenId = garden.id;
  await saveStore();

  closeSidebar();
  await loadGarden(garden);
}

async function loadGarden(garden) {
  // Read .txt files from garden's folder
  let entries;
  try {
    entries = await readDir(garden.folderPath);
  } catch {
    await message(`Could not access folder:\n${garden.folderPath}\n\nIt may have been moved or deleted.`, { title: 'Error', kind: 'error' });
    return;
  }

  const noteFiles = entries.filter(e => e.name && (e.name.endsWith('.txt') || e.name.endsWith('.md')));
  if (noteFiles.length === 0) {
    await message('No .txt or .md files found in this folder.', { title: 'Error', kind: 'error' });
    return;
  }

  // Read all note files
  noteContents = {};
  const fileContents = await Promise.all(
    noteFiles.map(async entry => {
      const filePath = `${garden.folderPath}/${entry.name}`;
      const text = await readTextFile(filePath);
      noteContents[entry.name] = text;
      return { filename: entry.name, text };
    })
  );

  // Process text into graph data
  const { nodes, links } = buildGraph(fileContents, stopSet);
  nodesData = nodes;
  linksData = links;

  // Show graph UI, hide welcome screen
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Clear previous graph if re-loading
  d3.select('#graph-container').selectAll('*').remove();
  if (simulation) simulation.stop();

  setupDOM();
  renderGraph();

  // Update store
  garden.lastOpenedAt = new Date().toISOString();
  activeGardenId = garden.id;
  await saveStore();

  renderGardenList();
}

// ── Sidebar ──
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

// ── Sidebar resize ──
function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let isResizing = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    sidebar.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.min(Math.max(180, e.clientX), 600);
    sidebar.style.setProperty('--sidebar-width', newWidth + 'px');
  });

  window.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('resizing');
    document.body.style.cursor = '';
  });
}

function renderGardenList() {
  const list = document.getElementById('garden-list');
  list.innerHTML = '';

  // Sort by lastOpenedAt descending
  const sorted = [...gardens].sort((a, b) =>
    new Date(b.lastOpenedAt) - new Date(a.lastOpenedAt)
  );

  for (const garden of sorted) {
    const li = document.createElement('li');
    li.dataset.gardenId = garden.id;
    if (garden.id === activeGardenId) li.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'garden-name';
    nameSpan.textContent = garden.name;

    const pathSpan = document.createElement('span');
    pathSpan.className = 'garden-path';
    pathSpan.textContent = garden.folderPath;

    li.appendChild(nameSpan);
    li.appendChild(pathSpan);

    // Click to load (sidebar stays open — user closes it manually)
    li.addEventListener('click', () => {
      loadGarden(garden);
    });

    // Right-click for context menu
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, garden.id);
    });

    list.appendChild(li);
  }
}

// ── Context menu ──
function showContextMenu(event, gardenId) {
  event.stopPropagation();
  contextMenuTargetId = gardenId;

  const menu = document.getElementById('context-menu');
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.classList.add('visible');
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  menu.classList.remove('visible');
  contextMenuTargetId = null;
}

async function onContextMenuAction(action) {
  if (!action || !contextMenuTargetId) return;

  const gardenId = contextMenuTargetId;
  const garden = gardens.find(g => g.id === gardenId);
  hideContextMenu();

  if (!garden) return;

  if (action === 'rename') {
    startInlineRename(gardenId);
  } else if (action === 'delete') {
    const confirmed = await ask(`Delete "${garden.name}"?\n\nThis only removes it from the sidebar — your files are untouched.`, { title: 'Delete Garden', kind: 'warning' });
    if (confirmed) {
      gardens = gardens.filter(g => g.id !== gardenId);
      if (activeGardenId === gardenId) {
        activeGardenId = null;
        document.getElementById('welcome-screen').style.display = '';
        document.getElementById('app').style.display = 'none';
        d3.select('#graph-container').selectAll('*').remove();
        if (simulation) simulation.stop();
      }
      await saveStore();
      renderGardenList();
    }
  }
}

function startInlineRename(gardenId) {
  const listItems = document.querySelectorAll('#garden-list li');
  for (const li of listItems) {
    if (li.dataset.gardenId !== gardenId) continue;

    const nameSpan = li.querySelector('.garden-name');
    if (!nameSpan) continue;

    const garden = gardens.find(g => g.id === gardenId);
    if (!garden) continue;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = garden.name;

    nameSpan.replaceWith(input);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== garden.name) {
        garden.name = newName;
        await saveStore();
      }
      renderGardenList();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = garden.name; // revert
        input.blur();
      }
    });

    break;
  }
}

// ── Markdown Stripping ──
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')         // fenced code blocks
    .replace(/`[^`]+`/g, '')                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → keep text
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')         // italic
    .replace(/~~(.*?)~~/g, '$1')             // strikethrough
    .replace(/^>\s+/gm, '')                  // blockquotes
    .replace(/^[-*+]\s+/gm, '')              // unordered list markers
    .replace(/^\d+\.\s+/gm, '')              // ordered list markers
    .replace(/^---+$/gm, '')                 // horizontal rules
    .replace(/\n{3,}/g, '\n\n');             // collapse excess newlines
}

// ── Text Processing & Graph Construction ──
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= MIN_WORD_LENGTH);
}

function buildGraph(files, stopSet) {
  // Per-file word sets and global frequency
  const globalFreq = {};
  const fileWords = []; // array of { filename, wordSet }

  for (const { filename, text } of files) {
    const cleaned = filename.endsWith('.md') ? stripMarkdown(text) : text;
    const tokens = tokenize(cleaned).filter(w => !stopSet.has(w));
    const wordSet = new Set(tokens);

    // Count global frequency
    for (const token of tokens) {
      globalFreq[token] = (globalFreq[token] || 0) + 1;
    }

    fileWords.push({ filename, wordSet });
  }

  // Select top N words by frequency
  const sorted = Object.entries(globalFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N_WORDS);

  const topWords = new Set(sorted.map(d => d[0]));

  // Build nodes
  const freqExtent = d3.extent(sorted, d => d[1]);
  const sizeScale = d3.scaleLinear().domain(freqExtent).range(NODE_SIZE_RANGE);
  const labelScale = d3.scaleLinear().domain(freqExtent).range(LABEL_SIZE_RANGE);
  const colorNorm = d3.scaleLinear().domain(freqExtent).range([0, 1]);

  const nodes = sorted.map(([word, freq]) => ({
    id: word,
    freq,
    radius: sizeScale(freq),
    fontSize: labelScale(freq),
    color: colorScale(colorNorm(freq)),
    sources: fileWords
      .filter(f => f.wordSet.has(word))
      .map(f => f.filename)
  }));

  // Build edges: co-occurrence in same file
  const links = [];
  const nodeIds = nodes.map(n => n.id);

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const a = nodeIds[i];
      const b = nodeIds[j];

      // Count files where both words appear
      let coCount = 0;
      for (const { wordSet } of fileWords) {
        if (wordSet.has(a) && wordSet.has(b)) coCount++;
      }

      if (coCount > 0) {
        links.push({ source: a, target: b, weight: coCount });
      }
    }
  }

  return { nodes, links };
}

// ── DOM Setup ──
function setupDOM() {
  tooltip = d3.select('.tooltip');
  detailPanel = d3.select('.detail-panel');

  d3.select('.close-btn').on('click', () => {
    detailPanel.classed('open', false);
    clearHighlights();
  });

  // Close panel on background click
  d3.select('#graph-container').on('click', (event) => {
    if (event.target.tagName === 'svg' || event.target.classList.contains('zoom-layer')) {
      detailPanel.classed('open', false);
      clearHighlights();
    }
  });
}

// ── Graph Rendering ──
function renderGraph() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  svg = d3.select('#graph-container')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  // Zoom layer
  container = svg.append('g').attr('class', 'zoom-layer');

  const zoom = d3.zoom()
    .scaleExtent([0.3, 4])
    .on('zoom', (event) => container.attr('transform', event.transform));

  svg.call(zoom);

  // Links
  const link = container.append('g')
    .selectAll('line')
    .data(linksData)
    .join('line')
    .attr('class', 'link')
    .attr('stroke-width', d => d.weight * 1.2);

  // Node groups
  const node = container.append('g')
    .selectAll('g')
    .data(nodesData)
    .join('g')
    .attr('class', 'node-group');

  // Circles
  node.append('circle')
    .attr('class', 'node-circle')
    .attr('r', d => d.radius)
    .attr('fill', d => d.color)
    .attr('stroke', '#e8e0d4')
    .attr('stroke-width', 1.8)
    .on('mouseover', onNodeHover)
    .on('mousemove', onNodeMove)
    .on('mouseout', onNodeOut)
    .on('click', onNodeClick);

  // Labels
  node.append('text')
    .attr('class', 'node-label')
    .attr('font-size', d => d.fontSize)
    .text(d => d.id);

  // Force simulation
  simulation = d3.forceSimulation(nodesData)
    .force('link', d3.forceLink(linksData).id(d => d.id).distance(156).strength(d => d.weight * 0.15))
    .force('charge', d3.forceManyBody().strength(-375))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(d => d.radius + 22))
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

  // Drag setup on circles
  node.select('circle').call(drag(simulation));

  // Handle resize
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    svg.attr('width', w).attr('height', h);
    simulation.force('center', d3.forceCenter(w / 2, h / 2));
    simulation.alpha(0.3).restart();
  });
}

// ── Drag Behavior ──
function drag(sim) {
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

// ── Interactions ──
function onNodeHover(event, d) {
  // Highlight connected nodes
  const connectedIds = new Set();
  connectedIds.add(d.id);

  linksData.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (sid === d.id) connectedIds.add(tid);
    if (tid === d.id) connectedIds.add(sid);
  });

  d3.selectAll('.node-circle')
    .classed('dimmed', n => !connectedIds.has(n.id));
  d3.selectAll('.node-label')
    .classed('dimmed', n => !connectedIds.has(n.id));
  d3.selectAll('.link')
    .classed('dimmed', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return sid !== d.id && tid !== d.id;
    })
    .classed('highlighted', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return sid === d.id || tid === d.id;
    });

  // Tooltip content
  const sourcesHtml = d.sources.map(s =>
    `<span>${s.replace(/\.(txt|md)$/, '')}</span>`
  ).join('');

  tooltip.html(`
    <div class="word">${d.id}</div>
    <div class="freq">appears ${d.freq} time${d.freq > 1 ? 's' : ''}</div>
    <div class="sources">found in:${sourcesHtml}</div>
  `);

  tooltip.classed('visible', true);
}

function onNodeMove(event) {
  const pad = 16;
  let x = event.clientX + pad;
  let y = event.clientY + pad;

  const tooltipEl = tooltip.node();
  const rect = tooltipEl.getBoundingClientRect();

  if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - pad;

  tooltip.style('left', x + 'px').style('top', y + 'px');
}

function onNodeOut() {
  tooltip.classed('visible', false);
  clearHighlights();
}

function onNodeClick(event, d) {
  event.stopPropagation();

  const panel = d3.select('.detail-panel');
  panel.select('h2').text(d.id);

  const excerptsContainer = panel.select('.excerpts');
  excerptsContainer.html('');

  for (const filename of d.sources) {
    const rawText = noteContents[filename];
    const text = filename.endsWith('.md') ? stripMarkdown(rawText) : rawText;
    // Find sentences containing the word
    const sentences = text.split(/(?<=[.!?])\s+/);
    const relevant = sentences.filter(s =>
      s.toLowerCase().includes(d.id)
    );

    const excerpt = relevant.length > 0
      ? relevant.slice(0, 2).join(' ')
      : text.slice(0, 150) + '...';

    // Highlight the word in the excerpt
    const highlighted = excerpt.replace(
      new RegExp(`(${d.id})`, 'gi'),
      '<mark>$1</mark>'
    );

    const div = excerptsContainer.append('div').attr('class', 'excerpt');
    div.append('h3').text(filename.replace(/\.(txt|md)$/, ''));
    div.append('p').html(highlighted);
  }

  panel.classed('open', true);
}

function clearHighlights() {
  d3.selectAll('.node-circle').classed('dimmed', false);
  d3.selectAll('.node-label').classed('dimmed', false);
  d3.selectAll('.link').classed('dimmed', false).classed('highlighted', false);
}

// ── Start ──
init();

/**
 * Cloudflare Worker API for SolarTrack.
 * Serves /api/* from KV JSON storage and forwards everything else to static assets.
 */

const STORE_KEY = 'solartrack';
const bangkokDateKey = value => {
  if (!value) return '';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
};
const WAREHOUSE_PROJECT_NAME = 'คลังสินค้ากลาง (Central Warehouse)';
const DEFAULT_PROJECTS = [
  { id: 1, name: 'Solar Farm Lopburi Phase 2', location: 'ลพบุรี', target_capacity_kw: 5000 },
  { id: 2, name: 'Rooftop Factory Amata Chonburi', location: 'ชลบุรี', target_capacity_kw: 1200 },
  { id: 3, name: 'Floating Solar Ubon Ratchathani', location: 'อุบลราชธานี', target_capacity_kw: 3500 },
  { id: 4, name: WAREHOUSE_PROJECT_NAME, location: 'สมุทรปราการ', target_capacity_kw: 0 }
];
const DEFAULT_PROJECT_NAMES = [
  'Solar Farm Lopburi Phase 2',
  'Rooftop Factory Amata Chonburi',
  'Floating Solar Ubon Ratchathani',
  WAREHOUSE_PROJECT_NAME
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ success: false, error: err.message || String(err) }, err.status || 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...headers
    }
  });
}

function normalizeSharedSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const brands = [];
  const seen = new Set();
  if (Array.isArray(source.brands)) {
    for (const entry of source.brands) {
      const name = typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim();
      const wattage = Number(typeof entry === 'string' ? 550 : entry?.wattage);
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key) || !Number.isInteger(wattage) || wattage < 1 || wattage > 2000) continue;
      seen.add(key);
      brands.push({ name, wattage });
    }
  }
  return {
    defaultTechnician: typeof source.defaultTechnician === 'string' ? source.defaultTechnician : '',
    brands
  };
}

async function handleApi(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const store = new DataStore(env?.STORE);

  if (path === '/api/health' && method === 'GET') {
    const isKvBound = Boolean(env.STORE && typeof env.STORE.get === 'function' && typeof env.STORE.put === 'function');
    return json({
      status: 'ok',
      appName: 'Solar Panel Tracking API',
      timestamp: new Date().toISOString(),
      runtime: 'cloudflare-worker',
      storage: isKvBound ? 'kv' : 'memory'
    });
  }

  if (path === '/api/stats' && method === 'GET') {
    return json({ success: true, stats: await store.getStats() });
  }

  if (path === '/api/settings' && method === 'GET') {
    const data = await store.load();
    return json({ success: true, settings: data.settings || null });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const settings = normalizeSharedSettings(body?.settings);
    const data = await store.load();
    data.settings = settings;
    await store.save();
    return json({ success: true, settings });
  }

  if (path === '/api/panels' && method === 'GET') {
    const result = await store.getPanels({
      search: url.searchParams.get('search') || '',
      project: url.searchParams.get('project') || 'all',
      status: url.searchParams.get('status') || 'all',
      received_from: url.searchParams.get('received_from') || '',
      received_to: url.searchParams.get('received_to') || '',
      moved_from: url.searchParams.get('moved_from') || '',
      moved_to: url.searchParams.get('moved_to') || '',
      limit: url.searchParams.get('limit') || 50,
      offset: url.searchParams.get('offset') || 0
    });
    return json({ success: true, ...result });
  }

  if (path === '/api/panels' && method === 'POST') {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ success: false, error: 'Expected a panel object.' }, 400);
    }
    const isWarehouse = body.status === 'warehouse' || body.scanned_mode === 'warehouse';
    const serialNumber = typeof body.serial_number === 'string' ? body.serial_number.trim() : '';
    const projectName = typeof body.project_name === 'string' ? body.project_name.trim() : '';
    if (!serialNumber) {
      return json({ success: false, error: 'Serial number is required.' }, 400);
    }
    if (!isWarehouse && !projectName) {
      return json({ success: false, error: 'Project name is required.' }, 400);
    }
    return json(await store.savePanel({
      ...body,
      serial_number: serialNumber,
      project_name: isWarehouse ? WAREHOUSE_PROJECT_NAME : projectName,
      ...(isWarehouse ? { status: 'warehouse', scanned_mode: 'warehouse' } : {})
    }));
  }

  const panelMatch = path.match(/^\/api\/panels\/(.+)$/);
  if (panelMatch && method === 'GET') {
    const serial = decodeURIComponent(panelMatch[1]);
    const panel = await store.getPanelBySerial(serial);
    if (!panel) return json({ success: false, message: 'Panel not found' }, 404);
    return json({ success: true, panel });
  }
  if (panelMatch && method === 'DELETE') {
    const result = await store.deletePanel(decodeURIComponent(panelMatch[1]));
    return json(result);
  }

  if (path === '/api/projects' && method === 'GET') {
    return json({ success: true, projects: await store.getProjectsList() });
  }
  if (path === '/api/projects' && method === 'POST') {
    const body = await request.json();
    if (!body.name || !String(body.name).trim()) {
      return json({ success: false, error: 'Project name is required' }, 400);
    }
    return json(await store.createProject(body), 201);
  }

  const projectMatch = path.match(/^\/api\/projects\/(.+)$/);
  if (projectMatch && method === 'PUT') {
    const oldName = decodeURIComponent(projectMatch[1]);
    const body = await request.json();
    return json(await store.updateProject({ oldName, ...body }));
  }
  if (projectMatch && method === 'DELETE') {
    const name = decodeURIComponent(projectMatch[1]);
    const body = await request.json().catch(() => ({}));
    return json(await store.deleteProject({ name, action: body.action }));
  }

  if (path === '/api/equipment' && method === 'GET') {
    return json({ success: true, equipment: await store.getEquipmentCatalog() });
  }
  if (path === '/api/equipment' && method === 'POST') {
    return json(await store.saveEquipmentCatalogItem(await request.json()), 201);
  }

  if (path === '/api/tools' && method === 'GET') {
    return json({ success: true, ...(await store.getToolRegistry()) });
  }
  if (path === '/api/tools' && method === 'POST') {
    return json(await store.saveToolAsset(await request.json()), 201);
  }
  const toolPath = path.match(/^\/api\/tools\/(\d+)(?:\/(events))?$/);
  if (toolPath) {
    const [, toolId, eventsPath] = toolPath;
    if (!eventsPath && method === 'GET') return json({ success: true, ...(await store.getToolAsset(toolId)) });
    if (eventsPath && method === 'POST') return json(await store.createToolEvent(toolId, await request.json()), 201);
  }

  const equipmentIssuePath = path.match(/^\/api\/equipment\/issues(?:\/(\d+))?$/);
  if (equipmentIssuePath) {
    const issueId = equipmentIssuePath[1];
    if (!issueId && method === 'GET') {
      return json({ success: true, issues: await store.getEquipmentIssues() });
    }
    if (!issueId && method === 'POST') {
      return json(await store.saveEquipmentIssue(await request.json()), 201);
    }
    if (issueId && method === 'PUT') {
      return json(await store.saveEquipmentIssue(await request.json(), issueId));
    }
    if (issueId && method === 'DELETE') {
      return json(await store.deleteEquipmentIssue(issueId));
    }
  }

  const equipmentPath = path.match(/^\/api\/equipment\/(\d+)$/);
  if (equipmentPath) {
    const equipmentId = equipmentPath[1];
    if (method === 'PUT') {
      return json(await store.saveEquipmentCatalogItem(await request.json(), equipmentId));
    }
    if (method === 'DELETE') {
      return json(await store.deleteEquipmentCatalogItem(equipmentId));
    }
  }

  if (path === '/api/dongles' && method === 'GET') {
    return json({ success: true, dongles: await store.getDongleInventory() });
  }
  if (path === '/api/dongles/import' && method === 'POST') {
    return json(await store.addDongles((await request.json())?.dongles), 201);
  }

  const donglePath = path.match(/^\/api\/dongles\/(\d+)\/(issue|return|status)$/);
  if (donglePath && method === 'PUT') {
    const [, id, action] = donglePath;
    if (action === 'issue') {
      return json(await store.issueDongle(id, await request.json()));
    }
    if (action === 'status') {
      const body = await request.json().catch(() => ({}));
      return json(await store.setDongleStatus(id, body?.status));
    }
    return json(await store.returnDongleToStock(id));
  }

  if (path === '/api/database/info' && method === 'GET') {
    return json({ success: true, info: await store.getDatabaseInfo() });
  }
  if (path === '/api/database/batch-delete' && method === 'POST') {
    const { ids } = await request.json();
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return json({ success: false, error: 'No IDs provided' }, 400);
    }
    return json(await store.batchDeletePanels(ids));
  }
  if (path === '/api/database/batch-status' && method === 'POST') {
    const { ids, status } = await request.json();
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return json({ success: false, error: 'No IDs provided' }, 400);
    }
    if (!status) return json({ success: false, error: 'Status is required' }, 400);
    return json(await store.batchUpdateStatus(ids, status));
  }
  if (path === '/api/database/batch-project' && method === 'POST') {
    const { ids, projectName } = await request.json();
    if (!ids || !Array.isArray(ids) || ids.length === 0 || !projectName) {
      return json({ success: false, error: 'Invalid parameters' }, 400);
    }
    return json(await store.batchUpdateProject(ids, projectName));
  }
  if (path === '/api/database/seed' && method === 'POST') {
    return json(await store.seedDemoData());
  }
  if (path === '/api/database/clear' && method === 'POST') {
    return json(await store.clearAllPanels());
  }
  if (path === '/api/database/clear-selective' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return json(await store.clearPanelsSelective({ scope: body.scope || 'all', project: body.project || '' }));
  }
  if (path === '/api/database/import' && method === 'POST') {
    const { panels } = await request.json();
    if (!panels || !Array.isArray(panels)) {
      return json({ success: false, error: 'Expected array of panels' }, 400);
    }
    return json(await store.importPanels(panels));
  }
  if (path === '/api/database/backup' && method === 'GET') {
    const { data } = await store.getPanels({ limit: 50000 });
    const projects = await store.getProjectsList();
    const backupData = {
      app: 'SolarTrack Field Operations',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      projects,
      totalPanels: data.length,
      panels: data,
      dongles: await store.getDongleInventory()
    };
    const filename = `solartrack_backup_${new Date().toISOString().slice(0, 10)}.json`;
    return json(backupData, 200, { 'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*' });
  }
  if (path === '/api/database/projects-detail' && method === 'GET') {
    return json({ success: true, projects: await store.getProjectsFull() });
  }
  if (path === '/api/export/csv' && method === 'GET') {
    const { data } = await store.getPanels({ limit: 10000 });
    return csvResponse(data);
  }

  return json({ success: false, error: 'Not found' }, 404);
}

function csvResponse(data) {
  const headers = [
    'ID', 'Serial Number', 'Project Name', 'Inverter', 'String', 'Panel Index',
    'Brand/Model', 'Wattage (W)', 'Status', 'Technician', 'Latitude', 'Longitude',
    'Scan Mode', 'Notes', 'Last Updated'
  ];
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    return `"${String(val).replace(/"/g, '""')}"`;
  };
  const rows = data.map((p) => [
    p.id,
    escapeCsv(p.serial_number),
    escapeCsv(p.project_name),
    escapeCsv(p.inverter),
    escapeCsv(p.string_name),
    p.panel_index,
    escapeCsv(p.brand_model),
    p.wattage,
    escapeCsv(p.status),
    escapeCsv(p.technician_name),
    p.gps_lat || '',
    p.gps_lng || '',
    escapeCsv(p.scanned_mode),
    escapeCsv(p.notes),
    escapeCsv(p.updated_at || p.created_at)
  ].join(','));
  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const filename = `solar_panels_export_${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

function equipmentError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function dongleError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEquipmentIssue(payload, catalog, previousItems = []) {
  const projectName = typeof payload?.project_name === 'string' ? payload.project_name.trim() : '';
  const issuedAt = typeof payload?.issued_at === 'string' ? payload.issued_at.trim() : '';
  const issuedBy = typeof payload?.issued_by === 'string' ? payload.issued_by.trim() : '';
  const notes = typeof payload?.notes === 'string' ? payload.notes.trim() : '';
  if (!projectName || projectName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
    throw equipmentError('กรุณาเลือกโครงการหน้างาน');
  }
  const parsedDate = new Date(`${issuedAt}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
    throw equipmentError('กรุณาระบุวันที่เบิกให้ถูกต้อง');
  }
  if (!issuedBy) throw equipmentError('กรุณาระบุผู้เบิก');
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw equipmentError('กรุณาเพิ่มรายการอุปกรณ์อย่างน้อย 1 รายการ');
  }

  const items = payload.items.map((line) => {
    const itemId = Number(line?.equipment_id) || 0;
    const quantity = Number(line?.quantity);
    const equipment = catalog.find((entry) => Number(entry.id) === itemId);
    const previousItem = previousItems.find((entry) =>
      Number(entry.equipment_id) === itemId &&
      entry.name === line?.name &&
      (entry.unit || 'ชิ้น') === (line?.unit || 'ชิ้น')
    );
    const name = typeof line?.name === 'string' ? line.name.trim() : '';
    const unit = typeof line?.unit === 'string' ? line.unit.trim() : '';
    const resolvedName = name || previousItem?.name || equipment?.name || '';
    const resolvedUnit = unit || previousItem?.unit || equipment?.unit || 'ชิ้น';
    if (!resolvedName) throw equipmentError('กรุณาระบุชื่ออุปกรณ์ในรายการ');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
      throw equipmentError(`จำนวน "${resolvedName}" ต้องมากกว่า 0`);
    }
    return {
      equipment_id: itemId > 0 ? itemId : null,
      name: resolvedName,
      unit: resolvedUnit,
      quantity
    };
  });
  return { project_name: projectName, issued_at: issuedAt, issued_by: issuedBy, notes, items };
}

function normalizeDongleIssue(payload) {
  const projectName = typeof payload?.project_name === 'string' ? payload.project_name.trim() : '';
  const responsible = typeof payload?.responsible === 'string' ? payload.responsible.trim() : '';
  const issuedAt = typeof payload?.issued_at === 'string' ? payload.issued_at.trim() : '';
  const parsedDate = new Date(`${issuedAt}T00:00:00Z`);
  if (!projectName || projectName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
    throw dongleError('กรุณาเลือกโครงการหน้างาน');
  }
  if (!responsible) throw dongleError('กรุณาระบุผู้รับผิดชอบ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
    throw dongleError('กรุณาระบุวันที่เบิกให้ถูกต้อง');
  }
  return { project_name: projectName, responsible, issued_at: issuedAt };
}

let inMemoryStore = null;

class DataStore {
  constructor(kv) {
    this.kv = (kv && typeof kv.get === 'function' && typeof kv.put === 'function') ? kv : null;
    this.cache = null;
  }

  emptyStore() {
    return {
      panels: demoPanels(),
      projects: DEFAULT_PROJECTS.map((p) => ({ ...p })),
      equipmentCatalog: [],
      equipmentIssues: [],
      toolAssets: [],
      toolEvents: [],
      dongles: []
    };
  }

  async load() {
    if (this.cache) return this.cache;
    if (!this.kv) {
      if (!inMemoryStore) {
        inMemoryStore = this.emptyStore();
      }
      this.cache = inMemoryStore;
      if (!Array.isArray(this.cache.equipmentCatalog)) this.cache.equipmentCatalog = [];
      if (!Array.isArray(this.cache.equipmentIssues)) this.cache.equipmentIssues = [];
      if (!Array.isArray(this.cache.toolAssets)) this.cache.toolAssets = [];
      if (!Array.isArray(this.cache.toolEvents)) this.cache.toolEvents = [];
      if (!Array.isArray(this.cache.dongles)) this.cache.dongles = [];
      return this.cache;
    }
    let raw = null;
    try {
      raw = await this.kv.get(STORE_KEY);
    } catch (err) {
      console.error('Failed to get from KV:', err);
    }
    if (!raw) {
      this.cache = this.emptyStore();
      await this.save();
      return this.cache;
    }
    try {
      this.cache = JSON.parse(raw);
      if (!Array.isArray(this.cache.panels)) this.cache.panels = [];
      if (!Array.isArray(this.cache.projects)) this.cache.projects = DEFAULT_PROJECTS.map((p) => ({ ...p }));
      const needsEquipmentMigration = !Array.isArray(this.cache.equipmentCatalog) ||
        !Array.isArray(this.cache.equipmentIssues);
      const needsToolMigration = !Array.isArray(this.cache.toolAssets) || !Array.isArray(this.cache.toolEvents);
      const needsDongleMigration = !Array.isArray(this.cache.dongles);
      if (!Array.isArray(this.cache.equipmentCatalog)) this.cache.equipmentCatalog = [];
      if (!Array.isArray(this.cache.equipmentIssues)) this.cache.equipmentIssues = [];
      if (!Array.isArray(this.cache.toolAssets)) this.cache.toolAssets = [];
      if (!Array.isArray(this.cache.toolEvents)) this.cache.toolEvents = [];
      if (!Array.isArray(this.cache.dongles)) this.cache.dongles = [];
      if (needsEquipmentMigration || needsToolMigration || needsDongleMigration) await this.save();
    } catch {
      this.cache = this.emptyStore();
    }
    return this.cache;
  }

  async save() {
    if (this.kv && this.cache) {
      try {
        await this.kv.put(STORE_KEY, JSON.stringify(this.cache));
      } catch (err) {
        console.error('KV save error:', err);
      }
    }
  }

  async getStats() {
    const { panels } = await this.load();
    return {
      total: panels.length,
      warehouse: panels.filter((p) => p.status === 'warehouse').length,
      installing: panels.filter((p) => p.status === 'installing').length,
      installed: panels.filter((p) => p.status === 'installed').length,
      damaged: panels.filter((p) => p.status === 'damaged').length,
      projects: [...new Set(panels.map((p) => p.project_name))].filter(Boolean).length
    };
  }

  async getPanels(filters = {}) {
    const { search, project, status, received_from, received_to, moved_from, moved_to, limit = 50, offset = 0 } = filters;
    const { panels } = await this.load();
    let result = [...panels];
    if (search) {
      const q = String(search).toLowerCase();
      result = result.filter((p) =>
        (p.serial_number && p.serial_number.toLowerCase().includes(q)) ||
        (p.project_name && p.project_name.toLowerCase().includes(q)) ||
        (p.inverter && p.inverter.toLowerCase().includes(q)) ||
        (p.string_name && p.string_name.toLowerCase().includes(q)) ||
        (p.technician_name && p.technician_name.toLowerCase().includes(q))
      );
    }
    if (project && project !== 'all') result = result.filter((p) => p.project_name === project);
    if (status && status !== 'all') result = result.filter((p) => p.status === status);
    if (received_from) result = result.filter(p => bangkokDateKey(p.created_at) >= received_from);
    if (received_to) result = result.filter(p => bangkokDateKey(p.created_at) <= received_to);
    const movementDate = p => p.moved_at || (p.status !== 'warehouse' ? p.updated_at : '');
    if (moved_from) result = result.filter(p => bangkokDateKey(movementDate(p)) >= moved_from);
    if (moved_to) result = result.filter(p => bangkokDateKey(movementDate(p)) <= moved_to);
    result.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    const paginated = result.slice(Number(offset), Number(offset) + Number(limit));
    return { total: result.length, data: paginated };
  }

  async getPanelBySerial(serial) {
    const { panels } = await this.load();
    return panels.find((p) => p.serial_number.toLowerCase() === String(serial).toLowerCase()) || null;
  }

  async savePanel(panelData) {
    const memory = await this.load();
    const isWarehouse = panelData.status === 'warehouse' || panelData.scanned_mode === 'warehouse';
    const {
      serial_number,
      project_name = WAREHOUSE_PROJECT_NAME,
      inverter = '-',
      string_name = '-',
      panel_index = 0,
      brand_model = 'Standard Tier-1 Solar',
      wattage = 550,
      status = 'warehouse',
      technician_name = 'Field Tech',
      gps_lat = null,
      gps_lng = null,
      notes = '',
      scanned_mode = 'field'
    } = {
      ...panelData,
      project_name: isWarehouse ? WAREHOUSE_PROJECT_NAME : panelData.project_name,
      inverter: isWarehouse ? '-' : panelData.inverter,
      string_name: isWarehouse ? '-' : panelData.string_name,
      panel_index: isWarehouse ? 0 : panelData.panel_index,
      status: isWarehouse ? 'warehouse' : panelData.status,
      scanned_mode: isWarehouse ? 'warehouse' : panelData.scanned_mode
    };
    const now = new Date().toISOString();
    const idx = memory.panels.findIndex((p) => p.serial_number.toLowerCase() === serial_number.toLowerCase());
    let record;
    if (idx >= 0) {
      const current = memory.panels[idx];
      const movedAt = current.project_name !== project_name || (current.status === 'warehouse' && status !== 'warehouse')
        ? now
        : current.moved_at || null;
      record = {
        ...current,
        project_name,
        inverter,
        string_name,
        panel_index: Number(panel_index) || 0,
        brand_model,
        wattage: Number(wattage) || 550,
        status,
        technician_name,
        gps_lat: gps_lat ? Number(gps_lat) : memory.panels[idx].gps_lat,
        gps_lng: gps_lng ? Number(gps_lng) : memory.panels[idx].gps_lng,
        notes,
        scanned_mode,
        moved_at: movedAt,
        updated_at: now
      };
      memory.panels[idx] = record;
    } else {
      record = {
        id: memory.panels.length > 0 ? Math.max(...memory.panels.map((p) => p.id || 0)) + 1 : 1,
        serial_number: String(serial_number).trim(),
        project_name,
        inverter,
        string_name,
        panel_index: Number(panel_index) || 0,
        brand_model,
        wattage: Number(wattage) || 550,
        status,
        technician_name,
        gps_lat: gps_lat ? Number(gps_lat) : null,
        gps_lng: gps_lng ? Number(gps_lng) : null,
        notes,
        scanned_mode,
        created_at: now,
        moved_at: status === 'warehouse' ? null : now,
        updated_at: now
      };
      memory.panels.unshift(record);
    }
    await this.save();
    return { success: true, isUpdate: idx >= 0, data: record };
  }

  async getProjectsList() {
    const memory = await this.load();
    const fromProjects = (memory.projects || []).map((p) => p.name);
    const fromPanels = memory.panels.map((p) => p.project_name);
    return Array.from(new Set([WAREHOUSE_PROJECT_NAME, ...fromProjects, ...fromPanels])).filter(Boolean);
  }

  async createProject({ name, location = 'ภาคสนาม', target_capacity_kw = 0 }) {
    const memory = await this.load();
    const cleanName = String(name || '').trim();
    if (memory.projects.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error(`โครงการ "${cleanName}" มีอยู่ในระบบแล้ว`);
    }
    const newProj = {
      id: Date.now(),
      name: cleanName,
      location: String(location || 'ภาคสนาม').trim(),
      target_capacity_kw: Number(target_capacity_kw) || 0,
      created_at: new Date().toISOString()
    };
    memory.projects.push(newProj);
    await this.save();
    return { success: true, project: newProj };
  }

  async updateProject({ oldName, name, location = 'ภาคสนาม', target_capacity_kw = 0 }) {
    const memory = await this.load();
    const cleanOld = String(oldName || '').trim();
    const cleanNew = String(name || cleanOld).trim();
    let p = memory.projects.find((x) => x.name.toLowerCase() === cleanOld.toLowerCase());
    if (!p) {
      p = { id: Date.now(), name: cleanNew, location, target_capacity_kw };
      memory.projects.push(p);
    } else {
      p.name = cleanNew;
      p.location = location;
      p.target_capacity_kw = Number(target_capacity_kw) || 0;
    }
    if (cleanOld !== cleanNew) {
      memory.panels.forEach((pan) => {
        if (pan.project_name === cleanOld) pan.project_name = cleanNew;
      });
    }
    await this.save();
    return { success: true, project: p };
  }

  async deleteProject({ name, action = 'move_warehouse' }) {
    const memory = await this.load();
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      throw new Error('Project name is required');
    }
    if (cleanName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
      throw new Error(`ไม่สามารถลบ "${WAREHOUSE_PROJECT_NAME}" ซึ่งเป็นคลังสินค้าหลักของระบบได้`);
    }

    const lowerClean = cleanName.toLowerCase();
    memory.projects = (memory.projects || []).filter((p) => (p.name || '').trim().toLowerCase() !== lowerClean);

    if (action === 'delete_panels') {
      memory.panels = memory.panels.filter((p) => (p.project_name || '').trim().toLowerCase() !== lowerClean);
    } else {
      memory.panels.forEach((p) => {
        if ((p.project_name || '').trim().toLowerCase() === lowerClean) {
          p.project_name = WAREHOUSE_PROJECT_NAME;
          p.status = 'warehouse';
        }
      });
    }
    await this.save();
    return { success: true, message: `ลบโครงการ "${cleanName}" สำเร็จ` };
  }

  async deletePanel(id) {
    const memory = await this.load();
    const initialLen = memory.panels.length;
    memory.panels = memory.panels.filter((p) => String(p.id) !== String(id));
    await this.save();
    return { success: memory.panels.length < initialLen };
  }

  async batchDeletePanels(ids) {
    const memory = await this.load();
    const idArray = ids.map(Number).filter(Boolean);
    const initialLen = memory.panels.length;
    memory.panels = memory.panels.filter((p) => !idArray.includes(p.id));
    await this.save();
    return { success: true, count: initialLen - memory.panels.length };
  }

  async batchUpdateStatus(ids, status) {
    const memory = await this.load();
    const idArray = ids.map(Number).filter(Boolean);
    const now = new Date().toISOString();
    let count = 0;
    memory.panels.forEach((p) => {
      if (idArray.includes(p.id)) {
        if (p.status === 'warehouse' && status !== 'warehouse') p.moved_at = now;
        p.status = status;
        p.updated_at = now;
        count++;
      }
    });
    await this.save();
    return { success: true, count };
  }

  async batchUpdateProject(ids, projectName) {
    const memory = await this.load();
    const idArray = ids.map(Number).filter(Boolean);
    const now = new Date().toISOString();
    let count = 0;
    memory.panels.forEach((p) => {
      if (idArray.includes(p.id)) {
        if (p.project_name !== projectName) p.moved_at = now;
        p.project_name = projectName;
        p.updated_at = now;
        count++;
      }
    });
    await this.save();
    return { success: true, count };
  }

  async clearAllPanels() {
    const memory = await this.load();
    const count = memory.panels.length;
    memory.panels = [];
    await this.save();
    return { success: true, count };
  }

  async clearPanelsSelective({ scope, project }) {
    const memory = await this.load();
    const initialLen = memory.panels.length;
    if (scope === 'warehouse') memory.panels = memory.panels.filter((p) => p.status !== 'warehouse');
    else if (scope === 'installed') memory.panels = memory.panels.filter((p) => p.status !== 'installed' && p.status !== 'installing');
    else if (scope === 'damaged') memory.panels = memory.panels.filter((p) => p.status !== 'damaged');
    else if (scope === 'project' && project) memory.panels = memory.panels.filter((p) => p.project_name !== project);
    else memory.panels = [];
    await this.save();
    return { success: true, count: initialLen - memory.panels.length };
  }

  async seedDemoData() {
    const samples = demoPanels();
    const results = [];
    for (const p of samples) results.push(await this.savePanel(p));
    return { success: true, count: results.length };
  }

  async importPanels(panelsArray) {
    const valid = [];
    for (const p of panelsArray) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      const isWarehouse = p.status === 'warehouse' || p.scanned_mode === 'warehouse';
      if (typeof p.serial_number !== 'string' || !p.serial_number.trim() ||
        (!isWarehouse && (typeof p.project_name !== 'string' || !p.project_name.trim()))) continue;
      valid.push(await this.savePanel(p));
    }
    return { success: true, count: valid.length };
  }

  async getEquipmentCatalog() {
    const memory = await this.load();
    return [...memory.equipmentCatalog].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveEquipmentCatalogItem(payload, id = null) {
    const memory = await this.load();
    const cleanName = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const cleanUnit = typeof payload?.unit === 'string' ? payload.unit.trim() : '';
    if (!cleanName) throw equipmentError('กรุณาระบุชื่ออุปกรณ์');
    if (!cleanUnit) throw equipmentError('กรุณาระบุหน่วยนับ');

    const itemId = id === null ? null : Number(id);
    if (itemId !== null && (!Number.isSafeInteger(itemId) || itemId <= 0)) {
      throw equipmentError('รหัสอุปกรณ์ไม่ถูกต้อง');
    }
    const duplicate = memory.equipmentCatalog.find((item) =>
      item.name.toLowerCase() === cleanName.toLowerCase() && Number(item.id) !== itemId
    );
    if (duplicate) throw equipmentError(`มีอุปกรณ์ "${cleanName}" อยู่แล้ว`);

    const now = new Date().toISOString();
    let item = itemId === null
      ? null
      : memory.equipmentCatalog.find((entry) => Number(entry.id) === itemId);
    if (itemId !== null && !item) throw equipmentError('ไม่พบข้อมูลอุปกรณ์ที่ต้องการแก้ไข');
    if (item) {
      item.name = cleanName;
      item.unit = cleanUnit;
      item.updated_at = now;
    } else {
      const nextId = Math.max(Date.now(), ...memory.equipmentCatalog.map((entry) => Number(entry.id) + 1 || 0));
      item = { id: nextId, name: cleanName, unit: cleanUnit, created_at: now, updated_at: now };
      memory.equipmentCatalog.push(item);
    }
    await this.save();
    return { success: true, item };
  }

  async deleteEquipmentCatalogItem(id) {
    const memory = await this.load();
    const itemId = Number(id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw equipmentError('รหัสอุปกรณ์ไม่ถูกต้อง');
    const initialCount = memory.equipmentCatalog.length;
    memory.equipmentCatalog = memory.equipmentCatalog.filter((item) => Number(item.id) !== itemId);
    if (memory.equipmentCatalog.length === initialCount) throw equipmentError('ไม่พบข้อมูลอุปกรณ์');
    await this.save();
    return { success: true };
  }

  async getEquipmentIssues() {
    const memory = await this.load();
    return [...memory.equipmentIssues].sort((a, b) =>
      String(b.issued_at).localeCompare(String(a.issued_at)) || Number(b.id) - Number(a.id)
    );
  }

  async saveEquipmentIssue(payload, id = null) {
    const memory = await this.load();
    const issueId = id === null ? null : Number(id);
    if (issueId !== null && (!Number.isSafeInteger(issueId) || issueId <= 0)) {
      throw equipmentError('รหัสรายการเบิกไม่ถูกต้อง');
    }
    const previous = issueId === null
      ? null
      : memory.equipmentIssues.find((entry) => Number(entry.id) === issueId);
    if (issueId !== null && !previous) throw equipmentError('ไม่พบประวัติการเบิกที่ต้องการแก้ไข');
    const issue = normalizeEquipmentIssue(payload || {}, memory.equipmentCatalog, previous?.items || []);
    const now = new Date().toISOString();
    let record = previous;
    if (record) {
      Object.assign(record, issue, { updated_at: now });
    } else {
      const nextId = Math.max(Date.now(), ...memory.equipmentIssues.map((entry) => Number(entry.id) + 1 || 0));
      record = { id: nextId, ...issue, created_at: now, updated_at: now };
      memory.equipmentIssues.unshift(record);
    }
    await this.save();
    return { success: true, issue: record };
  }

  async deleteEquipmentIssue(id) {
    const memory = await this.load();
    const issueId = Number(id);
    if (!Number.isSafeInteger(issueId) || issueId <= 0) throw equipmentError('รหัสรายการเบิกไม่ถูกต้อง');
    const initialCount = memory.equipmentIssues.length;
    memory.equipmentIssues = memory.equipmentIssues.filter((issue) => Number(issue.id) !== issueId);
    if (memory.equipmentIssues.length === initialCount) throw equipmentError('ไม่พบประวัติการเบิก');
    await this.save();
    return { success: true };
  }

  async getToolRegistry() {
    const memory = await this.load();
    const tools = [...memory.toolAssets].sort((a, b) => String(a.asset_code).localeCompare(String(b.asset_code)));
    const recent = [...memory.toolEvents]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id))
      .slice(0, 12)
      .map(event => {
        const tool = memory.toolAssets.find(item => Number(item.id) === Number(event.tool_id));
        return { ...event, asset_code: tool?.asset_code || '', tool_name: tool?.name || '' };
      });
    return {
      tools,
      recent,
      stats: {
        total: tools.length,
        available: tools.filter(tool => tool.status === 'available').length,
        pending: tools.filter(tool => tool.status === 'pending_approval').length,
        borrowed: tools.filter(tool => tool.status === 'borrowed').length,
        repair: tools.filter(tool => ['maintenance', 'damaged', 'lost'].includes(tool.status)).length
      }
    };
  }

  async getToolAsset(id) {
    const memory = await this.load();
    const toolId = Number(id);
    if (!Number.isSafeInteger(toolId) || toolId <= 0) throw equipmentError('รหัสเครื่องมือไม่ถูกต้อง');
    const tool = memory.toolAssets.find(item => Number(item.id) === toolId);
    if (!tool) throw equipmentError('ไม่พบเครื่องมือ');
    const events = memory.toolEvents.filter(event => Number(event.tool_id) === toolId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
    return { tool, events };
  }

  async saveToolAsset(payload = {}, id = null) {
    const readText = key => typeof payload[key] === 'string' ? payload[key].trim() : '';
    const asset = {
      asset_code: readText('asset_code').toUpperCase(),
      name: readText('name'),
      category: readText('category'),
      brand: readText('brand'),
      model: readText('model'),
      serial_number: readText('serial_number'),
      location: readText('location'),
      condition_note: readText('condition_note'),
      purchase_date: readText('purchase_date')
    };
    if (!asset.name) throw equipmentError('กรุณาระบุชื่อเครื่องมือ');
    if (asset.purchase_date && !/^\d{4}-\d{2}-\d{2}$/.test(asset.purchase_date)) throw equipmentError('วันที่ซื้อไม่ถูกต้อง');
    const memory = await this.load();
    const toolId = id === null ? null : Number(id);
    if (toolId !== null && (!Number.isSafeInteger(toolId) || toolId <= 0)) throw equipmentError('รหัสเครื่องมือไม่ถูกต้อง');
    const nextId = Math.max(0, ...memory.toolAssets.map(item => Number(item.id) || 0)) + 1;
    const nextCode = Math.max(0, ...memory.toolAssets.map(item => Number(/^TL-(\d+)$/i.exec(String(item.asset_code || ''))?.[1]) || 0)) + 1;
    if (toolId === null && !asset.asset_code) asset.asset_code = `TL-${String(nextCode).padStart(4, '0')}`;
    if (toolId !== null && !asset.asset_code) asset.asset_code = memory.toolAssets.find(item => Number(item.id) === toolId)?.asset_code || '';
    const duplicate = memory.toolAssets.find(item => item.asset_code.toLowerCase() === asset.asset_code.toLowerCase() && Number(item.id) !== toolId);
    if (duplicate) throw equipmentError(`รหัสเครื่องมือ ${asset.asset_code} มีอยู่แล้ว`);
    let tool = toolId === null ? null : memory.toolAssets.find(item => Number(item.id) === toolId);
    if (toolId !== null && !tool) throw equipmentError('ไม่พบเครื่องมือ');
    const now = new Date().toISOString();
    if (tool) Object.assign(tool, asset, { updated_at: now });
    else {
      tool = { id: nextId, ...asset, status: 'available', current_holder: '', current_project: '', expected_return_at: '', created_at: now, updated_at: now };
      memory.toolAssets.push(tool);
      const eventId = Math.max(Date.now(), ...memory.toolEvents.map(event => Number(event.id) + 1 || 0));
      memory.toolEvents.push({ id: eventId, tool_id: tool.id, event_type: 'registered', title: 'ลงทะเบียนเครื่องมือ', actor: readText('actor'), project_name: '', detail: asset.condition_note, created_at: now });
    }
    await this.save();
    return { success: true, tool };
  }

  async createToolEvent(id, payload = {}) {
    const toolId = Number(id);
    const type = typeof payload.type === 'string' ? payload.type.trim() : '';
    const actor = typeof payload.actor === 'string' ? payload.actor.trim() : '';
    const requestedBy = typeof payload.requested_by === 'string' ? payload.requested_by.trim() : '';
    const projectName = typeof payload.project_name === 'string' ? payload.project_name.trim() : '';
    const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
    if (!Number.isSafeInteger(toolId) || toolId <= 0) throw equipmentError('รหัสเครื่องมือไม่ถูกต้อง');
    if (!actor) throw equipmentError('กรุณาระบุผู้รับผิดชอบ');
    const definitions = {
      checkout_request: { title: 'ส่งคำขอเบิก', from: ['available'], to: 'pending_approval' },
      approve: { title: 'อนุมัติการเบิก', from: ['pending_approval'], to: 'borrowed' },
      reject: { title: 'ปฏิเสธคำขอเบิก', from: ['pending_approval'], to: 'available' },
      return: { title: 'รับคืนเข้าคลัง', from: ['borrowed'], to: 'available' },
      maintenance: { title: 'ส่งซ่อมบำรุง', from: ['available', 'damaged'], to: 'maintenance' },
      repair_complete: { title: 'ปิดงานซ่อม', from: ['maintenance'], to: payload.mark_damaged ? 'damaged' : 'available' },
      damaged: { title: 'บันทึกชำรุด', from: ['available', 'borrowed'], to: 'damaged' },
      lost: { title: 'บันทึกสูญหาย', from: ['available', 'borrowed'], to: 'lost' },
      stocktake: { title: 'ตรวจนับสต็อก', from: ['available', 'pending_approval', 'borrowed', 'maintenance', 'damaged', 'lost'], to: null }
    };
    const definition = definitions[type];
    if (!definition) throw equipmentError('กิจกรรมเครื่องมือไม่ถูกต้อง');
    if (!['checkout_request', 'approve'].includes(type) && !detail) throw equipmentError('กรุณาระบุรายละเอียดกิจกรรม');
    if (type === 'checkout_request' && !requestedBy) throw equipmentError('กรุณาระบุชื่อผู้ขอเบิก');
    if (type === 'checkout_request' && requestedBy.toLocaleLowerCase() === actor.toLocaleLowerCase()) throw equipmentError('ผู้ขอเบิกและผู้บันทึกคำขอต้องเป็นคนละคน');
    if (type === 'checkout_request' && !projectName) throw equipmentError('กรุณาระบุโครงการหรือสถานที่ใช้งาน');
    const memory = await this.load();
    const tool = memory.toolAssets.find(item => Number(item.id) === toolId);
    if (!tool) throw equipmentError('ไม่พบเครื่องมือ');
    if (!definition.from.includes(tool.status)) throw equipmentError(`เปลี่ยนสถานะจาก ${tool.status} ไม่ได้`);
    const now = new Date().toISOString();
    const previousProject = tool.current_project;
    tool.status = type === 'stocktake' ? tool.status : definition.to;
    if (type === 'checkout_request') {
      tool.current_holder = requestedBy;
      tool.current_project = projectName;
      tool.expected_return_at = payload.expected_return_at || '';
    } else if (type === 'return' || ['repair_complete', 'damaged', 'lost', 'reject'].includes(type)) {
      tool.current_holder = '';
      tool.current_project = '';
      if (type === 'return') {
        tool.expected_return_at = '';
        tool.location = typeof payload.location === 'string' && payload.location.trim() ? payload.location.trim() : tool.location;
      }
      if (type === 'damaged' || type === 'lost' || type === 'reject') tool.expected_return_at = '';
      if (type === 'return' || type === 'repair_complete') tool.condition_note = detail || tool.condition_note;
    }
    tool.updated_at = now;
    const eventId = Math.max(Date.now(), ...memory.toolEvents.map(event => Number(event.id) + 1 || 0));
    const event = { id: eventId, tool_id: toolId, event_type: type, title: definition.title, actor, requested_by: requestedBy,
      project_name: projectName || previousProject || '', detail, created_at: now };
    memory.toolEvents.push(event);
    await this.save();
    return { success: true, tool, event };
  }

  async getDongleInventory() {
    const memory = await this.load();
    return [...memory.dongles].sort((a, b) =>
      String(a.status).localeCompare(String(b.status)) ||
      String(a.serial_number).localeCompare(String(b.serial_number), undefined, { sensitivity: 'base' })
    );
  }

  async addDongles(records) {
    if (!Array.isArray(records) || records.length === 0) {
      throw dongleError('กรุณาระบุ Serial Number อย่างน้อย 1 รายการ');
    }
    const cleanRecords = records.map((record) => ({
      serial_number: typeof record?.serial_number === 'string' ? record.serial_number.trim() : '',
      model: typeof record?.model === 'string' ? record.model.trim() : ''
    }));
    const seen = new Set();
    for (const record of cleanRecords) {
      if (!record.serial_number) throw dongleError('กรุณาระบุ Serial Number ให้ครบ');
      if (!record.model) throw dongleError('กรุณาระบุรุ่นดองเกิ้ล');
      const key = record.serial_number.toLowerCase();
      if (seen.has(key)) throw dongleError(`พบ SN ${record.serial_number} ซ้ำในรายการ`);
      seen.add(key);
    }

    const memory = await this.load();
    const existing = new Set(memory.dongles.map((item) => String(item.serial_number).toLowerCase()));
    const duplicate = cleanRecords.find((record) => existing.has(record.serial_number.toLowerCase()));
    if (duplicate) throw dongleError(`SN ${duplicate.serial_number} มีในสต๊อกแล้ว`, 409);

    const now = new Date().toISOString();
    const nextId = Math.max(Date.now(), ...memory.dongles.map((item) => Number(item.id) + 1 || 0));
    const created = cleanRecords.map((record, index) => ({
      id: nextId + index,
      ...record,
      status: 'warehouse',
      project_name: '',
      responsible: '',
      issued_at: '',
      created_at: now,
      updated_at: now
    }));
    memory.dongles.push(...created);
    await this.save();
    return { success: true, count: created.length };
  }

  async issueDongle(id, payload) {
    const dongleId = Number(id);
    if (!Number.isSafeInteger(dongleId) || dongleId <= 0) {
      throw dongleError('รหัสดองเกิ้ลไม่ถูกต้อง');
    }
    const issue = normalizeDongleIssue(payload || {});
    const memory = await this.load();
    const dongle = memory.dongles.find((item) => Number(item.id) === dongleId);
    if (!dongle) throw dongleError('ไม่พบข้อมูลดองเกิ้ล');
    if (dongle.status !== 'warehouse') {
      throw dongleError(`SN ${dongle.serial_number} ถูกเบิกไปแล้ว`, 409);
    }
    Object.assign(dongle, issue, { status: 'issued', updated_at: new Date().toISOString() });
    await this.save();
    return { success: true, dongle };
  }

  async returnDongleToStock(id) {
    const dongleId = Number(id);
    if (!Number.isSafeInteger(dongleId) || dongleId <= 0) {
      throw dongleError('รหัสดองเกิ้ลไม่ถูกต้อง');
    }
    const memory = await this.load();
    const dongle = memory.dongles.find((item) => Number(item.id) === dongleId);
    if (!dongle) throw dongleError('ไม่พบข้อมูลดองเกิ้ล');
    if (dongle.status !== 'issued') {
      throw dongleError(`SN ${dongle.serial_number} อยู่ในสต๊อกแล้ว`, 409);
    }
    dongle.status = 'warehouse';
    dongle.updated_at = new Date().toISOString();
    await this.save();
    return { success: true, dongle };
  }

  async setDongleStatus(id, nextStatus) {
    const dongleId = Number(id);
    if (!Number.isSafeInteger(dongleId) || dongleId <= 0) {
      throw dongleError('รหัสดองเกิ้ลไม่ถูกต้อง');
    }
    if (!['damaged', 'warehouse'].includes(nextStatus)) {
      throw dongleError('สถานะดองเกิ้ลไม่ถูกต้อง');
    }

    const allowedCurrentStatuses = nextStatus === 'damaged' ? ['warehouse', 'issued'] : ['damaged'];
    const memory = await this.load();
    const dongle = memory.dongles.find((item) => Number(item.id) === dongleId);
    if (!dongle) throw dongleError('ไม่พบข้อมูลดองเกิ้ล');
    if (!allowedCurrentStatuses.includes(dongle.status)) {
      throw dongleError(`ไม่สามารถเปลี่ยนสถานะ SN ${dongle.serial_number} จาก ${dongle.status} เป็น ${nextStatus} ได้`, 409);
    }

    dongle.status = nextStatus;
    dongle.updated_at = new Date().toISOString();
    await this.save();
    return { success: true, dongle };
  }

  async getDatabaseInfo() {
    const stats = await this.getStats();
    const isKvBound = Boolean(this.kv);
    let fileSizeBytes = 0;
    try {
      const raw = isKvBound ? await this.kv.get(STORE_KEY) : JSON.stringify(this.cache || {});
      fileSizeBytes = raw ? new TextEncoder().encode(raw).length : 0;
    } catch {
      fileSizeBytes = 0;
    }
    return {
      engine: isKvBound ? 'Cloudflare KV' : 'In-Memory (Fallback - No KV Bound)',
      filePath: isKvBound ? 'kv://STORE/solartrack' : 'in-memory (ephemeral)',
      fileName: 'solartrack',
      fileSizeBytes,
      fileSizeFormatted: (fileSizeBytes / 1024).toFixed(2) + ' KB',
      lastModified: new Date().toISOString(),
      stats,
      kv_bound: isKvBound
    };
  }

  async getProjectsFull() {
    const memory = await this.load();
    const projectsMap = {};
    (memory.projects || []).forEach((d) => {
      projectsMap[d.name] = {
        name: d.name,
        location: d.location || 'ภาคสนาม',
        target_capacity_kw: Number(d.target_capacity_kw) || 0,
        total_panels: 0,
        installed_panels: 0,
        warehouse_panels: 0,
        installing_panels: 0,
        damaged_panels: 0,
        total_wattage: 0
      };
    });
    if (!projectsMap[WAREHOUSE_PROJECT_NAME]) {
      projectsMap[WAREHOUSE_PROJECT_NAME] = {
        name: WAREHOUSE_PROJECT_NAME,
        location: 'สมุทรปราการ',
        target_capacity_kw: 0,
        total_panels: 0,
        installed_panels: 0,
        warehouse_panels: 0,
        installing_panels: 0,
        damaged_panels: 0,
        total_wattage: 0
      };
    }
    memory.panels.forEach((p) => {
      if (!projectsMap[p.project_name]) {
        projectsMap[p.project_name] = {
          name: p.project_name,
          location: 'ภาคสนาม',
          target_capacity_kw: 0,
          total_panels: 0,
          installed_panels: 0,
          warehouse_panels: 0,
          installing_panels: 0,
          damaged_panels: 0,
          total_wattage: 0
        };
      }
      const row = projectsMap[p.project_name];
      row.total_panels++;
      if (p.status === 'installed') row.installed_panels++;
      else if (p.status === 'warehouse') row.warehouse_panels++;
      else if (p.status === 'installing') row.installing_panels++;
      else if (p.status === 'damaged') row.damaged_panels++;
      row.total_wattage += Number(p.wattage) || 0;
    });
    return Object.values(projectsMap);
  }
}

function demoPanels() {
  return [
    { serial_number: 'LONGI-LR5-72HBD-550M-001', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 1, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installed', technician_name: 'สมชาย รักงาน', gps_lat: 14.80551, gps_lng: 100.65342, notes: 'Voc: 49.5V, Isc: 13.9A ผ่านเกณฑ์', scanned_mode: 'field' },
    { serial_number: 'LONGI-LR5-72HBD-550M-002', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 2, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installed', technician_name: 'สมชาย รักงาน', gps_lat: 14.80552, gps_lng: 100.65345, notes: 'เชื่อมต่อ MC4 แน่นหนา ไม่หลวม', scanned_mode: 'field' },
    { serial_number: 'LONGI-LR5-72HBD-550M-003', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 3, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installed', technician_name: 'สมชาย รักงาน', gps_lat: 14.80554, gps_lng: 100.65349, notes: 'ขัน Clamp ด้วยทอร์กประแจ 12 Nยทm', scanned_mode: 'field' },
    { serial_number: 'LONGI-LR5-72HBD-550M-004', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 4, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installing', technician_name: 'สมชาย รักงาน', gps_lat: 14.80556, gps_lng: 100.65352, notes: 'รอต่อหัว Connector', scanned_mode: 'field' },
    { serial_number: 'JINKO-JKM560N-72HL4-101', project_name: 'Rooftop Factory Amata Chonburi', inverter: 'INV-02', string_name: 'STR-03', panel_index: 1, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'installed', technician_name: 'วิชัย ช่างไฟ', gps_lat: 13.36112, gps_lng: 100.98471, notes: 'ติดตั้งบนราง Roof Clamp ไร้เจาะหลังคา', scanned_mode: 'field' },
    { serial_number: 'JINKO-JKM560N-72HL4-102', project_name: 'Rooftop Factory Amata Chonburi', inverter: 'INV-02', string_name: 'STR-03', panel_index: 2, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'installed', technician_name: 'วิชัย ช่างไฟ', gps_lat: 13.36115, gps_lng: 100.98475, notes: 'ร้อยท่อ Flex กันน้ำเรียบร้อย', scanned_mode: 'field' },
    { serial_number: 'JINKO-JKM560N-72HL4-103', project_name: 'Rooftop Factory Amata Chonburi', inverter: 'INV-02', string_name: 'STR-03', panel_index: 3, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'damaged', technician_name: 'วิชัย ช่างไฟ', gps_lat: 13.36118, gps_lng: 100.98480, notes: 'พบรอยแตกมุมกระจกด้านบน ส่งเคลมซัพพลายเออร์', scanned_mode: 'field' },
    { serial_number: 'TRINA-TSM-NEG19RC-580-001', project_name: 'Floating Solar Ubon Ratchathani', inverter: 'FL-INV-01', string_name: 'STR-01', panel_index: 1, brand_model: 'Trina Vertex N Dual-Glass', wattage: 580, status: 'installed', technician_name: 'เกียรติศักดิ์ วิศวกรทุ่น', gps_lat: 15.2281, gps_lng: 104.8562, notes: 'ทุ่นลอยยึดสมอแน่นหนา สายไฟกัน UV IP68', scanned_mode: 'field' },
    { serial_number: 'TRINA-TSM-NEG19RC-580-002', project_name: 'Floating Solar Ubon Ratchathani', inverter: 'FL-INV-01', string_name: 'STR-01', panel_index: 2, brand_model: 'Trina Vertex N Dual-Glass', wattage: 580, status: 'installed', technician_name: 'เกียรติศักดิ์ วิศวกรทุ่น', gps_lat: 15.2282, gps_lng: 104.8564, notes: 'ตรวจสอบจุดต่อสายดินกราวด์ผ่าน', scanned_mode: 'field' },
    { serial_number: 'WH-LONGI-550-PALLET-08', project_name: 'คลังสินค้ากลาง (Central Warehouse)', inverter: '-', string_name: '-', panel_index: 0, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'warehouse', technician_name: 'ประสิทธิ์ สโตร์แมน', gps_lat: 13.6899, gps_lng: 100.7501, notes: 'พาเลทที่ #08 สภาพกล่องสมบูรณ์ มีซีล QC ครบ', scanned_mode: 'warehouse' },
    { serial_number: 'WH-JINKO-560-PALLET-12', project_name: 'คลังสินค้ากลาง (Central Warehouse)', inverter: '-', string_name: '-', panel_index: 0, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'warehouse', technician_name: 'ประสิทธิ์ สโตร์แมน', gps_lat: 13.6899, gps_lng: 100.7501, notes: 'พาเลทที่ #12 ตรวจนับครบ 36 แผง', scanned_mode: 'warehouse' },
    { serial_number: 'WH-TRINA-580-PALLET-15', project_name: 'คลังสินค้ากลาง (Central Warehouse)', inverter: '-', string_name: '-', panel_index: 0, brand_model: 'Trina Vertex N Dual-Glass', wattage: 580, status: 'warehouse', technician_name: 'ประสิทธิ์ สโตร์แมน', gps_lat: 13.6899, gps_lng: 100.7501, notes: 'พาเลทที่ #15 รอเบิกจ่ายไปหน้างานลพบุรี', scanned_mode: 'warehouse' }
  ];
}

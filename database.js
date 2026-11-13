/**
 * Database Module for Solar Panel Tracking System
 * Uses SQLite (via sqlite3) with automatic in-memory/JSON fallback if sqlite3 is not installed.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.SOLARTRACK_DB_FILE || path.join(__dirname, 'solar_panels.db');
const JSON_FILE = process.env.SOLARTRACK_JSON_FILE || path.join(__dirname, 'solar_panels_store.json');
const WAREHOUSE_PROJECT_NAME = 'คลังสินค้ากลาง (Central Warehouse)';

function isWarehouseProject(name) {
  return String(name || '').trim().toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase();
}

function stockConflict(message) {
  const error = new Error(message);
  error.code = 'STOCK_CONFLICT';
  return error;
}

function equipmentError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

let db = null;
let useJsonStore = false;
let memoryStore = {
  panels: [],
  projects: [],
  equipmentCatalog: [],
  equipmentIssues: [],
  toolAssets: [],
  toolEvents: [],
  dongles: [],
  settings: null
};

function initDb() {
  return new Promise((resolve) => {
    try {
      const sqlite3 = require('sqlite3').verbose();
      db = new sqlite3.Database(DB_FILE, (err) => {
        if (err) {
          console.warn('⚠️ SQLite connection failed, switching to local JSON database:', err.message);
          useJsonFallback();
          resolve();
        } else {
          console.log('✅ SQLite Database connected:', DB_FILE);
          setupTables().then(resolve);
        }
      });
    } catch (e) {
      console.warn('⚠️ sqlite3 module not installed, using built-in JSON file store fallback.');
      useJsonFallback();
      resolve();
    }
  });
}

function useJsonFallback() {
  useJsonStore = true;
  if (fs.existsSync(JSON_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
      memoryStore = data;
      memoryStore.equipmentCatalog ||= [];
      memoryStore.equipmentIssues ||= [];
      memoryStore.toolAssets ||= [];
      memoryStore.toolEvents ||= [];
      memoryStore.dongles ||= [];
      memoryStore.settings ??= null;
      saveJsonStore();
    } catch (err) {
      console.error('Failed reading existing JSON file, initializing new store:', err);
      memoryStore = { panels: [], projects: [], equipmentCatalog: [], equipmentIssues: [], toolAssets: [], toolEvents: [], dongles: [], settings: null };
      saveJsonStore();
    }
  } else {
    memoryStore = { panels: [], projects: [], equipmentCatalog: [], equipmentIssues: [], toolAssets: [], toolEvents: [], dongles: [], settings: null };
    saveJsonStore();
  }
}

function saveJsonStore() {
  if (useJsonStore) {
    try {
      fs.writeFileSync(JSON_FILE, JSON.stringify(memoryStore, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed writing to JSON store:', err);
    }
  }
}

function setupTables() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS panels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          serial_number TEXT NOT NULL UNIQUE,
          project_name TEXT NOT NULL,
          inverter TEXT,
          string_name TEXT,
          panel_index INTEGER DEFAULT 0,
          brand_model TEXT,
          wattage INTEGER DEFAULT 550,
          status TEXT NOT NULL DEFAULT 'warehouse',
          technician_name TEXT,
          gps_lat REAL,
          gps_lng REAL,
          notes TEXT,
          scanned_mode TEXT DEFAULT 'warehouse',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          moved_at DATETIME
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          location TEXT,
          target_capacity_kw REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS equipment_catalog (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          unit TEXT NOT NULL DEFAULT 'ชิ้น',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS equipment_issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_name TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          issued_by TEXT NOT NULL,
          notes TEXT,
          items_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS tool_assets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
          name TEXT NOT NULL,
          category TEXT,
          brand TEXT,
          model TEXT,
          serial_number TEXT,
          location TEXT,
          status TEXT NOT NULL DEFAULT 'available',
          current_holder TEXT,
          current_project TEXT,
          expected_return_at TEXT,
          condition_note TEXT,
          purchase_date TEXT,
          photo TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS tool_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_id INTEGER NOT NULL REFERENCES tool_assets(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          title TEXT NOT NULL,
          actor TEXT,
          requested_by TEXT,
          project_name TEXT,
          detail TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS dongle_inventory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          serial_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
          model TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'warehouse',
          project_name TEXT,
          responsible TEXT,
          issued_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.get('SELECT COUNT(*) as count FROM panels', (err) => {
        if (err) return reject(err);
        if (useJsonStore) {
          memoryStore.equipmentCatalog ||= [];
          memoryStore.equipmentIssues ||= [];
          memoryStore.toolAssets ||= [];
          memoryStore.toolEvents ||= [];
          memoryStore.dongles ||= [];
          saveJsonStore();
          resolve();
          return;
        }
        const ensureToolAssetPhoto = () => db.all('PRAGMA table_info(tool_assets)', (assetPragmaErr, assetColumns) => {
          if (assetPragmaErr) return reject(assetPragmaErr);
          if (assetColumns.some(column => column.name === 'photo')) return resolve();
          db.run('ALTER TABLE tool_assets ADD COLUMN photo TEXT', alterErr => alterErr ? reject(alterErr) : resolve());
        });
        const ensureToolEventRequester = () => db.all('PRAGMA table_info(tool_events)', (eventPragmaErr, eventColumns) => {
          if (eventPragmaErr) return reject(eventPragmaErr);
          if (eventColumns.some(column => column.name === 'requested_by')) return ensureToolAssetPhoto();
          db.run('ALTER TABLE tool_events ADD COLUMN requested_by TEXT', alterErr => alterErr ? reject(alterErr) : ensureToolAssetPhoto());
        });
        db.all('PRAGMA table_info(panels)', (pragmaErr, columns) => {
          if (pragmaErr) return reject(pragmaErr);
          if (columns.some(column => column.name === 'moved_at')) return ensureToolEventRequester();
          db.run('ALTER TABLE panels ADD COLUMN moved_at DATETIME', alterErr => {
            if (alterErr) return reject(alterErr);
            ensureToolEventRequester();
          });
        });
      });
    });
  });
}

// ---------------- API Methods ----------------

function getStats() {
  if (useJsonStore) {
    const total = memoryStore.panels.length;
    const warehouse = memoryStore.panels.filter(p => p.status === 'warehouse').length;
    const installing = memoryStore.panels.filter(p => p.status === 'installing').length;
    const installed = memoryStore.panels.filter(p => p.status === 'installed').length;
    const damaged = memoryStore.panels.filter(p => p.status === 'damaged').length;
    const projects = [...new Set(memoryStore.panels
      .filter(p => p.status !== 'warehouse' && !isWarehouseProject(p.project_name))
      .map(p => p.project_name))].filter(Boolean).length;
    return Promise.resolve({ total, warehouse, installing, installed, damaged, projects });
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'warehouse' THEN 1 ELSE 0 END) as warehouse,
        SUM(CASE WHEN status = 'installing' THEN 1 ELSE 0 END) as installing,
        SUM(CASE WHEN status = 'installed' THEN 1 ELSE 0 END) as installed,
        SUM(CASE WHEN status = 'damaged' THEN 1 ELSE 0 END) as damaged,
        COUNT(DISTINCT CASE
          WHEN status != 'warehouse' AND LOWER(TRIM(project_name)) != LOWER(?) THEN project_name
        END) as projects
      FROM panels
    `;
    db.get(query, [WAREHOUSE_PROJECT_NAME], (err, row) => {
      if (err) return reject(err);
      resolve({
        total: row.total || 0,
        warehouse: row.warehouse || 0,
        installing: row.installing || 0,
        installed: row.installed || 0,
        damaged: row.damaged || 0,
        projects: row.projects || 0
      });
    });
  });
}

function getThaiDateBoundary(date, nextDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + (nextDay ? 1 : 0), -7)).toISOString().slice(0, 19).replace('T', ' ');
}

function getPanels(filters = {}) {
  const { search, project, status, received_from, received_to, moved_from, moved_to, limit = 50, offset = 0 } = filters;
  const receivedStart = getThaiDateBoundary(received_from);
  const receivedEnd = getThaiDateBoundary(received_to, true);
  const movedStart = getThaiDateBoundary(moved_from);
  const movedEnd = getThaiDateBoundary(moved_to, true);

  if (useJsonStore) {
    let result = [...memoryStore.panels];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        (p.serial_number && p.serial_number.toLowerCase().includes(q)) ||
        (p.project_name && p.project_name.toLowerCase().includes(q)) ||
        (p.inverter && p.inverter.toLowerCase().includes(q)) ||
        (p.string_name && p.string_name.toLowerCase().includes(q)) ||
        (p.technician_name && p.technician_name.toLowerCase().includes(q))
      );
    }
    if (project && project !== 'all') {
      result = result.filter(p => p.project_name === project);
    }
    if (status && status !== 'all') {
      result = result.filter(p => p.status === status);
    }
    const withinRange = (value, start, end) => {
      if (!start && !end) return true;
      if (!value) return false;
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) return false;
      return (!start || timestamp >= new Date(`${start.replace(' ', 'T')}Z`).getTime()) &&
        (!end || timestamp < new Date(`${end.replace(' ', 'T')}Z`).getTime());
    };
    if (receivedStart || receivedEnd) result = result.filter(p => withinRange(p.created_at, receivedStart, receivedEnd));
    if (movedStart || movedEnd) result = result.filter(p => withinRange(p.moved_at || (p.status !== 'warehouse' ? p.updated_at : null), movedStart, movedEnd));
    result.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    const paginated = result.slice(Number(offset), Number(offset) + Number(limit));
    return Promise.resolve({ total: result.length, data: paginated });
  }

  return new Promise((resolve, reject) => {
    let whereClause = [];
    let params = [];

    if (search) {
      whereClause.push(`(serial_number LIKE ? OR project_name LIKE ? OR inverter LIKE ? OR string_name LIKE ? OR technician_name LIKE ?)`);
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }
    if (project && project !== 'all') {
      whereClause.push(`project_name = ?`);
      params.push(project);
    }
    if (status && status !== 'all') {
      whereClause.push(`status = ?`);
      params.push(status);
    }
    if (receivedStart) {
      whereClause.push(`created_at >= ?`);
      params.push(receivedStart);
    }
    if (receivedEnd) {
      whereClause.push(`created_at < ?`);
      params.push(receivedEnd);
    }
    const movedAtExpr = `COALESCE(moved_at, CASE WHEN status != 'warehouse' THEN updated_at END)`;
    if (movedStart) {
      whereClause.push(`${movedAtExpr} >= ?`);
      params.push(movedStart);
    }
    if (movedEnd) {
      whereClause.push(`${movedAtExpr} < ?`);
      params.push(movedEnd);
    }

    const whereStr = whereClause.length ? `WHERE ${whereClause.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) as total FROM panels ${whereStr}`;
    db.get(countQuery, params, (err, countRow) => {
      if (err) return reject(err);

      const total = countRow.total;
      const dataQuery = `SELECT * FROM panels ${whereStr} ORDER BY id DESC LIMIT ? OFFSET ?`;
      db.all(dataQuery, [...params, Number(limit), Number(offset)], (err, rows) => {
        if (err) return reject(err);
        resolve({ total, data: rows });
      });
    });
  });
}

function getPanelBySerial(serial) {
  if (useJsonStore) {
    const found = memoryStore.panels.find(p => p.serial_number.toLowerCase() === serial.toLowerCase());
    return Promise.resolve(found || null);
  }

  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM panels WHERE LOWER(serial_number) = LOWER(?)', [serial], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function savePanel(panelData, { requireWarehouseStock = false } = {}) {
  const isWarehouse = panelData.status === 'warehouse' || panelData.scanned_mode === 'warehouse';
  if (requireWarehouseStock && panelData.status === 'warehouse' && panelData.scanned_mode !== 'warehouse') {
    return Promise.reject(stockConflict('กรุณาใช้โหมดรับเข้าคลังเพื่อบันทึกแผงเข้าสต๊อก'));
  }
  if (!isWarehouse && isWarehouseProject(panelData.project_name)) {
    return Promise.reject(stockConflict('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการปลายทาง'));
  }
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
  const replaceGps = isWarehouse || requireWarehouseStock;

  if (useJsonStore) {
    const idx = memoryStore.panels.findIndex(p => p.serial_number.toLowerCase() === serial_number.toLowerCase());
    if (requireWarehouseStock && !isWarehouse) {
      if (idx < 0) {
        return Promise.reject(stockConflict(`ไม่พบ SN ${serial_number} ในคลังสินค้า กรุณารับเข้าสต๊อกก่อนเบิกไปหน้างาน`));
      }
      const current = memoryStore.panels[idx];
      if (current.status !== 'warehouse') {
        return Promise.reject(stockConflict(`SN ${serial_number} ถูกเบิกไปแล้วที่ ${current.project_name} (สถานะ: ${current.status})`));
      }
      if (isWarehouseProject(project_name)) {
        return Promise.reject(stockConflict('กรุณาเลือกโครงการปลายทาง การเบิกแผงออกจากคลังต้องระบุหน้างาน'));
      }
    }

    let record;
    if (idx >= 0) {
      // Update existing
      const current = memoryStore.panels[idx];
      const movedAt = current.project_name !== project_name || (current.status === 'warehouse' && status !== 'warehouse')
        ? now
        : current.moved_at || null;
      record = {
        ...current,
        project_name,
        inverter,
        string_name,
        panel_index: Number(panel_index) || 0,
        brand_model: requireWarehouseStock && !isWarehouse ? memoryStore.panels[idx].brand_model : brand_model,
        wattage: requireWarehouseStock && !isWarehouse ? memoryStore.panels[idx].wattage : (Number(wattage) || 550),
        status,
        technician_name,
        gps_lat: replaceGps ? (gps_lat ? Number(gps_lat) : null) : (gps_lat ? Number(gps_lat) : memoryStore.panels[idx].gps_lat),
        gps_lng: replaceGps ? (gps_lng ? Number(gps_lng) : null) : (gps_lng ? Number(gps_lng) : memoryStore.panels[idx].gps_lng),
        notes,
        scanned_mode,
        moved_at: movedAt,
        updated_at: now
      };
      memoryStore.panels[idx] = record;
    } else {
      // Insert new
      record = {
        id: memoryStore.panels.length > 0 ? Math.max(...memoryStore.panels.map(p => p.id || 0)) + 1 : 1,
        serial_number: serial_number.trim(),
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
      memoryStore.panels.unshift(record);
    }
    saveJsonStore();
    return Promise.resolve({ success: true, isUpdate: idx >= 0, data: record });
  }

  return new Promise((resolve, reject) => {
    const checkQuery = 'SELECT id, status, project_name, brand_model, wattage FROM panels WHERE LOWER(serial_number) = LOWER(?)';
    db.get(checkQuery, [serial_number], (err, row) => {
      if (err) return reject(err);

      if (row) {
        if (requireWarehouseStock && !isWarehouse) {
          if (row.status !== 'warehouse') {
            return reject(stockConflict(`SN ${serial_number} ถูกเบิกไปแล้วที่ ${row.project_name} (สถานะ: ${row.status})`));
          }
          if (isWarehouseProject(project_name)) {
            return reject(stockConflict('กรุณาเลือกโครงการปลายทาง การเบิกแผงออกจากคลังต้องระบุหน้างาน'));
          }
        }

        // Update existing record
        const updateCondition = requireWarehouseStock && !isWarehouse
          ? 'WHERE id = ? AND status = ?'
          : 'WHERE id = ?';
        const updateQuery = `
          UPDATE panels SET
            project_name = ?,
            inverter = ?,
            string_name = ?,
            panel_index = ?,
            brand_model = ?,
            wattage = ?,
            status = ?,
            technician_name = ?,
            gps_lat = ${replaceGps ? '?' : 'COALESCE(?, gps_lat)'},
            gps_lng = ${replaceGps ? '?' : 'COALESCE(?, gps_lng)'},
            notes = ?,
            scanned_mode = ?,
            moved_at = CASE WHEN project_name != ? OR (status = 'warehouse' AND ? != 'warehouse') THEN CURRENT_TIMESTAMP ELSE moved_at END,
            updated_at = CURRENT_TIMESTAMP
          ${updateCondition}
        `;
        const updateValues = [
          project_name, inverter, string_name, Number(panel_index),
          requireWarehouseStock && !isWarehouse ? row.brand_model : brand_model,
          requireWarehouseStock && !isWarehouse ? row.wattage : Number(wattage),
          status, technician_name, gps_lat, gps_lng, notes, scanned_mode, project_name, status, row.id
        ];
        if (requireWarehouseStock && !isWarehouse) updateValues.push('warehouse');
        db.run(
          updateQuery,
          updateValues,
          function (err2) {
            if (err2) return reject(err2);
            if (requireWarehouseStock && !isWarehouse && this.changes === 0) {
              return reject(stockConflict(`SN ${serial_number} ถูกเบิกจากคลังไปแล้ว กรุณาตรวจสอบสถานะล่าสุด`));
            }
            db.get('SELECT * FROM panels WHERE id = ?', [row.id], (err3, updated) => {
              if (err3) return reject(err3);
              resolve({ success: true, isUpdate: true, data: updated });
            });
          }
        );
      } else {
        if (requireWarehouseStock && !isWarehouse) {
          return reject(stockConflict(`ไม่พบ SN ${serial_number} ในคลังสินค้า กรุณารับเข้าสต๊อกก่อนเบิกไปหน้างาน`));
        }
        // Insert new record
        const insertQuery = `
          INSERT INTO panels (
            serial_number, project_name, inverter, string_name, panel_index,
            brand_model, wattage, status, technician_name, gps_lat, gps_lng, notes, scanned_mode, created_at, updated_at, moved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CASE WHEN ? = 'warehouse' THEN NULL ELSE CURRENT_TIMESTAMP END)
        `;
        db.run(
          insertQuery,
          [serial_number.trim(), project_name, inverter, string_name, Number(panel_index), brand_model, Number(wattage), status, technician_name, gps_lat, gps_lng, notes, scanned_mode, status],
          function (err2) {
            if (err2) return reject(err2);
            db.get('SELECT * FROM panels WHERE id = ?', [this.lastID], (err3, inserted) => {
              if (err3) return reject(err3);
              resolve({ success: true, isUpdate: false, data: inserted });
            });
          }
        );
      }
    });
  });
}

function getProjectsList() {
  if (useJsonStore) {
    if (!memoryStore.projects) memoryStore.projects = [];
    const fromProjects = memoryStore.projects.map(p => p.name);
    const fromPanels = memoryStore.panels
      .filter(p => p.status !== 'warehouse')
      .map(p => p.project_name);
    const merged = Array.from(new Set([...fromProjects, ...fromPanels]))
      .filter(name => Boolean(name) && !isWarehouseProject(name));
    return Promise.resolve(merged);
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT DISTINCT name FROM (
        SELECT name FROM projects WHERE LOWER(TRIM(name)) != LOWER(?)
        UNION
        SELECT DISTINCT project_name as name FROM panels
        WHERE project_name IS NOT NULL AND project_name != ''
          AND status != 'warehouse'
          AND LOWER(TRIM(project_name)) != LOWER(?)
      )
    `;
    db.all(query, [WAREHOUSE_PROJECT_NAME, WAREHOUSE_PROJECT_NAME], (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(r => r.name).filter(name => Boolean(name) && !isWarehouseProject(name)));
    });
  });
}

function createProject({ name, location = 'ภาคสนาม', target_capacity_kw = 0 }) {
  const cleanName = (name || '').trim();
  if (!cleanName) return Promise.reject(new Error('Project name is required'));
  if (isWarehouseProject(cleanName)) return Promise.reject(new Error('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการ'));

  if (useJsonStore) {
    if (!memoryStore.projects) memoryStore.projects = [];
    const exists = memoryStore.projects.some(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (exists) return Promise.reject(new Error(`โครงการ "${cleanName}" มีอยู่ในระบบแล้ว`));

    const newProj = {
      id: Date.now(),
      name: cleanName,
      location: (location || 'ภาคสนาม').trim(),
      target_capacity_kw: Number(target_capacity_kw) || 0,
      created_at: new Date().toISOString()
    };
    memoryStore.projects.push(newProj);
    saveJsonStore();
    return Promise.resolve({ success: true, project: newProj });
  }

  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM projects WHERE LOWER(name) = LOWER(?)', [cleanName], (err, row) => {
      if (err) return reject(err);
      if (row) return reject(new Error(`โครงการ "${cleanName}" มีอยู่ในระบบแล้ว`));

      db.run(
        'INSERT INTO projects (name, location, target_capacity_kw, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [cleanName, (location || 'ภาคสนาม').trim(), Number(target_capacity_kw) || 0],
        function (err2) {
          if (err2) return reject(err2);
          resolve({
            success: true,
            project: { id: this.lastID, name: cleanName, location, target_capacity_kw: Number(target_capacity_kw) || 0 }
          });
        }
      );
    });
  });
}

function updateProject({ oldName, name, location = 'ภาคสนาม', target_capacity_kw = 0 }) {
  const cleanOld = (oldName || '').trim();
  const cleanNew = (name || cleanOld).trim();
  if (!cleanOld) return Promise.reject(new Error('Old project name is required'));
  if (!cleanNew) return Promise.reject(new Error('New project name is required'));
  if (isWarehouseProject(cleanOld) || isWarehouseProject(cleanNew)) {
    return Promise.reject(new Error('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการ'));
  }

  if (useJsonStore) {
    if (!memoryStore.projects) memoryStore.projects = [];
    let p = memoryStore.projects.find(x => x.name.toLowerCase() === cleanOld.toLowerCase());
    if (!p) {
      p = { id: Date.now(), name: cleanNew, location, target_capacity_kw };
      memoryStore.projects.push(p);
    } else {
      p.name = cleanNew;
      p.location = location;
      p.target_capacity_kw = Number(target_capacity_kw) || 0;
    }

    // Rename panels if name changed
    if (cleanOld !== cleanNew) {
      memoryStore.panels.forEach(pan => {
        if (pan.project_name === cleanOld) pan.project_name = cleanNew;
      });
    }
    saveJsonStore();
    return Promise.resolve({ success: true, project: p });
  }

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Upsert into projects table
      db.run(
        `INSERT INTO projects (name, location, target_capacity_kw, created_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET
           name = excluded.name,
           location = excluded.location,
           target_capacity_kw = excluded.target_capacity_kw`,
        [cleanNew, location, Number(target_capacity_kw) || 0],
        (err) => {
          if (err) return reject(err);

          // Update panels table if name changed
          if (cleanOld !== cleanNew) {
            db.run('UPDATE panels SET project_name = ? WHERE project_name = ?', [cleanNew, cleanOld], (err2) => {
              if (err2) return reject(err2);
              // Clean old project row if different
              db.run('DELETE FROM projects WHERE name = ?', [cleanOld], () => {});
              resolve({ success: true, project: { name: cleanNew, location, target_capacity_kw } });
            });
          } else {
            resolve({ success: true, project: { name: cleanNew, location, target_capacity_kw } });
          }
        }
      );
    });
  });
}

function deleteProject({ name, action = 'move_warehouse' }) {
  const cleanName = (name || '').trim();
  if (!cleanName) return Promise.reject(new Error('Project name is required'));
  if (cleanName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
    return Promise.reject(new Error(`ไม่สามารถลบ "${WAREHOUSE_PROJECT_NAME}" ซึ่งเป็นคลังสินค้าหลักของระบบได้`));
  }

  const lowerClean = cleanName.toLowerCase();

  if (useJsonStore) {
    if (!memoryStore.projects) memoryStore.projects = [];
    memoryStore.projects = memoryStore.projects.filter(p => (p.name || '').trim().toLowerCase() !== lowerClean);

    if (action === 'delete_panels') {
      memoryStore.panels = memoryStore.panels.filter(p => (p.project_name || '').trim().toLowerCase() !== lowerClean);
    } else {
      // Default: Move panels to Central Warehouse
      memoryStore.panels.forEach(p => {
        if ((p.project_name || '').trim().toLowerCase() === lowerClean) {
          p.project_name = WAREHOUSE_PROJECT_NAME;
          p.status = 'warehouse';
        }
      });
    }
    saveJsonStore();
    return Promise.resolve({ success: true, message: `ลบโครงการ "${cleanName}" สำเร็จ` });
  }

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      if (action === 'delete_panels') {
        db.run('DELETE FROM panels WHERE LOWER(TRIM(project_name)) = LOWER(?)', [cleanName]);
      } else {
        db.run(
          'UPDATE panels SET project_name = ?, status = ? WHERE LOWER(TRIM(project_name)) = LOWER(?)',
          [WAREHOUSE_PROJECT_NAME, 'warehouse', cleanName]
        );
      }

      db.run('DELETE FROM projects WHERE LOWER(TRIM(name)) = LOWER(?)', [cleanName], function (err) {
        if (err) return reject(err);
        resolve({ success: true, message: `ลบโครงการ "${cleanName}" สำเร็จ` });
      });
    });
  });
}

function deletePanel(id) {
  if (useJsonStore) {
    const initialLen = memoryStore.panels.length;
    memoryStore.panels = memoryStore.panels.filter(p => p.id !== Number(id));
    saveJsonStore();
    return Promise.resolve({ success: memoryStore.panels.length < initialLen });
  }

  return new Promise((resolve, reject) => {
    db.run('DELETE FROM panels WHERE id = ?', [id], function (err) {
      if (err) return reject(err);
      resolve({ success: this.changes > 0 });
    });
  });
}

function batchDeletePanels(ids) {
  const idArray = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (idArray.length === 0) return Promise.resolve({ success: true, count: 0 });

  if (useJsonStore) {
    const initialLen = memoryStore.panels.length;
    memoryStore.panels = memoryStore.panels.filter(p => !idArray.includes(p.id));
    saveJsonStore();
    return Promise.resolve({ success: true, count: initialLen - memoryStore.panels.length });
  }

  return new Promise((resolve, reject) => {
    const placeholders = idArray.map(() => '?').join(',');
    db.run(`DELETE FROM panels WHERE id IN (${placeholders})`, idArray, function (err) {
      if (err) return reject(err);
      resolve({ success: true, count: this.changes });
    });
  });
}

function batchUpdateStatus(ids, status) {
  const idArray = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (idArray.length === 0) return Promise.resolve({ success: true, count: 0 });

  const now = new Date().toISOString();

  if (useJsonStore) {
    let count = 0;
    memoryStore.panels.forEach(p => {
      if (idArray.includes(p.id)) {
        if (p.status === 'warehouse' && status !== 'warehouse') p.moved_at = now;
        p.status = status;
        p.updated_at = now;
        count++;
      }
    });
    saveJsonStore();
    return Promise.resolve({ success: true, count });
  }

  return new Promise((resolve, reject) => {
    const placeholders = idArray.map(() => '?').join(',');
    db.run(`UPDATE panels SET moved_at = CASE WHEN status = 'warehouse' AND ? != 'warehouse' THEN CURRENT_TIMESTAMP ELSE moved_at END, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [status, status, ...idArray], function (err) {
      if (err) return reject(err);
      resolve({ success: true, count: this.changes });
    });
  });
}

function batchUpdateProject(ids, projectName) {
  const idArray = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (idArray.length === 0) return Promise.resolve({ success: true, count: 0 });

  const now = new Date().toISOString();

  if (useJsonStore) {
    let count = 0;
    memoryStore.panels.forEach(p => {
      if (idArray.includes(p.id)) {
        if (p.project_name !== projectName) p.moved_at = now;
        p.project_name = projectName;
        p.updated_at = now;
        count++;
      }
    });
    saveJsonStore();
    return Promise.resolve({ success: true, count });
  }

  return new Promise((resolve, reject) => {
    const placeholders = idArray.map(() => '?').join(',');
    db.run(`UPDATE panels SET moved_at = CASE WHEN project_name != ? THEN CURRENT_TIMESTAMP ELSE moved_at END, project_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [projectName, projectName, ...idArray], function (err) {
      if (err) return reject(err);
      resolve({ success: true, count: this.changes });
    });
  });
}

function clearAllPanels() {
  if (useJsonStore) {
    const count = memoryStore.panels.length;
    memoryStore.panels = [];
    saveJsonStore();
    return Promise.resolve({ success: true, count });
  }

  return new Promise((resolve, reject) => {
    db.run('DELETE FROM panels', function (err) {
      if (err) return reject(err);
      resolve({ success: true, count: this.changes });
    });
  });
}

function clearPanelsSelective({ scope, project }) {
  if (useJsonStore) {
    const initialLen = memoryStore.panels.length;
    if (scope === 'warehouse') {
      memoryStore.panels = memoryStore.panels.filter(p => p.status !== 'warehouse');
    } else if (scope === 'installed') {
      memoryStore.panels = memoryStore.panels.filter(p => p.status !== 'installed' && p.status !== 'installing');
    } else if (scope === 'damaged') {
      memoryStore.panels = memoryStore.panels.filter(p => p.status !== 'damaged');
    } else if (scope === 'project' && project) {
      memoryStore.panels = memoryStore.panels.filter(p => p.project_name !== project);
    } else {
      memoryStore.panels = [];
    }
    saveJsonStore();
    return Promise.resolve({ success: true, count: initialLen - memoryStore.panels.length });
  }

  return new Promise((resolve, reject) => {
    let sql = 'DELETE FROM panels';
    let params = [];

    if (scope === 'warehouse') {
      sql += ' WHERE status = ?';
      params.push('warehouse');
    } else if (scope === 'installed') {
      sql += ' WHERE status IN (?, ?)';
      params.push('installed', 'installing');
    } else if (scope === 'damaged') {
      sql += ' WHERE status = ?';
      params.push('damaged');
    } else if (scope === 'project' && project) {
      sql += ' WHERE project_name = ?';
      params.push(project);
    }

    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ success: true, count: this.changes });
    });
  });
}

function seedDemoData() {
  const samplePanels = [
    // Lopburi Solar Farm - INV-01 STR-01
    {
      serial_number: 'LONGI-LR5-72HBD-550M-001',
      project_name: 'Solar Farm Lopburi Phase 2',
      inverter: 'INV-01',
      string_name: 'STR-01',
      panel_index: 1,
      brand_model: 'Longi Hi-MO 5 Bifacial',
      wattage: 550,
      status: 'installed',
      technician_name: 'สมชาย รักงาน',
      gps_lat: 14.80551,
      gps_lng: 100.65342,
      notes: 'Voc: 49.5V, Isc: 13.9A ผ่านเกณฑ์',
      scanned_mode: 'field'
    },
    {
      serial_number: 'LONGI-LR5-72HBD-550M-002',
      project_name: 'Solar Farm Lopburi Phase 2',
      inverter: 'INV-01',
      string_name: 'STR-01',
      panel_index: 2,
      brand_model: 'Longi Hi-MO 5 Bifacial',
      wattage: 550,
      status: 'installed',
      technician_name: 'สมชาย รักงาน',
      gps_lat: 14.80552,
      gps_lng: 100.65345,
      notes: 'เชื่อมต่อ MC4 แน่นหนา ไม่หลวม',
      scanned_mode: 'field'
    },
    {
      serial_number: 'LONGI-LR5-72HBD-550M-003',
      project_name: 'Solar Farm Lopburi Phase 2',
      inverter: 'INV-01',
      string_name: 'STR-01',
      panel_index: 3,
      brand_model: 'Longi Hi-MO 5 Bifacial',
      wattage: 550,
      status: 'installed',
      technician_name: 'สมชาย รักงาน',
      gps_lat: 14.80554,
      gps_lng: 100.65349,
      notes: 'ขัน Clamp ด้วยทอร์กประแจ 12 N·m',
      scanned_mode: 'field'
    },
    {
      serial_number: 'LONGI-LR5-72HBD-550M-004',
      project_name: 'Solar Farm Lopburi Phase 2',
      inverter: 'INV-01',
      string_name: 'STR-01',
      panel_index: 4,
      brand_model: 'Longi Hi-MO 5 Bifacial',
      wattage: 550,
      status: 'installing',
      technician_name: 'สมชาย รักงาน',
      gps_lat: 14.80556,
      gps_lng: 100.65352,
      notes: 'รอต่อหัว Connector',
      scanned_mode: 'field'
    },
    // Amata Rooftop Factory
    {
      serial_number: 'JINKO-JKM560N-72HL4-101',
      project_name: 'Rooftop Factory Amata Chonburi',
      inverter: 'INV-02',
      string_name: 'STR-03',
      panel_index: 1,
      brand_model: 'Jinko Tiger Neo N-Type',
      wattage: 560,
      status: 'installed',
      technician_name: 'วิชัย ช่างไฟ',
      gps_lat: 13.36112,
      gps_lng: 100.98471,
      notes: 'ติดตั้งบนราง Roof Clamp ไร้เจาะหลังคา',
      scanned_mode: 'field'
    },
    {
      serial_number: 'JINKO-JKM560N-72HL4-102',
      project_name: 'Rooftop Factory Amata Chonburi',
      inverter: 'INV-02',
      string_name: 'STR-03',
      panel_index: 2,
      brand_model: 'Jinko Tiger Neo N-Type',
      wattage: 560,
      status: 'installed',
      technician_name: 'วิชัย ช่างไฟ',
      gps_lat: 13.36115,
      gps_lng: 100.98475,
      notes: 'ร้อยท่อ Flex กันน้ำเรียบร้อย',
      scanned_mode: 'field'
    },
    {
      serial_number: 'JINKO-JKM560N-72HL4-103',
      project_name: 'Rooftop Factory Amata Chonburi',
      inverter: 'INV-02',
      string_name: 'STR-03',
      panel_index: 3,
      brand_model: 'Jinko Tiger Neo N-Type',
      wattage: 560,
      status: 'damaged',
      technician_name: 'วิชัย ช่างไฟ',
      gps_lat: 13.36118,
      gps_lng: 100.98480,
      notes: 'พบรอยแตกมุมกระจกด้านบน ส่งเคลมซัพพลายเออร์',
      scanned_mode: 'field'
    },
    // Floating Solar Ubon
    {
      serial_number: 'TRINA-TSM-NEG19RC-580-001',
      project_name: 'Floating Solar Ubon Ratchathani',
      inverter: 'FL-INV-01',
      string_name: 'STR-01',
      panel_index: 1,
      brand_model: 'Trina Vertex N Dual-Glass',
      wattage: 580,
      status: 'installed',
      technician_name: 'เกียรติศักดิ์ วิศวกรทุ่น',
      gps_lat: 15.2281,
      gps_lng: 104.8562,
      notes: 'ทุ่นลอยยึดสมอแน่นหนา สายไฟกัน UV IP68',
      scanned_mode: 'field'
    },
    {
      serial_number: 'TRINA-TSM-NEG19RC-580-002',
      project_name: 'Floating Solar Ubon Ratchathani',
      inverter: 'FL-INV-01',
      string_name: 'STR-01',
      panel_index: 2,
      brand_model: 'Trina Vertex N Dual-Glass',
      wattage: 580,
      status: 'installed',
      technician_name: 'เกียรติศักดิ์ วิศวกรทุ่น',
      gps_lat: 15.2282,
      gps_lng: 104.8564,
      notes: 'ตรวจสอบจุดต่อสายดินกราวด์ผ่าน',
      scanned_mode: 'field'
    },
    // Warehouse Inbound Stocks
    {
      serial_number: 'WH-LONGI-550-PALLET-08',
      project_name: 'คลังสินค้ากลาง (Central Warehouse)',
      inverter: '-',
      string_name: '-',
      panel_index: 0,
      brand_model: 'Longi Hi-MO 5 Bifacial',
      wattage: 550,
      status: 'warehouse',
      technician_name: 'ประสิทธิ์ สโตร์แมน',
      gps_lat: 13.6899,
      gps_lng: 100.7501,
      notes: 'พาเลทที่ #08 สภาพกล่องสมบูรณ์ มีซีล QC ครบ',
      scanned_mode: 'warehouse'
    },
    {
      serial_number: 'WH-JINKO-560-PALLET-12',
      project_name: 'คลังสินค้ากลาง (Central Warehouse)',
      inverter: '-',
      string_name: '-',
      panel_index: 0,
      brand_model: 'Jinko Tiger Neo N-Type',
      wattage: 560,
      status: 'warehouse',
      technician_name: 'ประสิทธิ์ สโตร์แมน',
      gps_lat: 13.6899,
      gps_lng: 100.7501,
      notes: 'พาเลทที่ #12 ตรวจนับครบ 36 แผง',
      scanned_mode: 'warehouse'
    },
    {
      serial_number: 'WH-TRINA-580-PALLET-15',
      project_name: 'คลังสินค้ากลาง (Central Warehouse)',
      inverter: '-',
      string_name: '-',
      panel_index: 0,
      brand_model: 'Trina Vertex N Dual-Glass',
      wattage: 580,
      status: 'warehouse',
      technician_name: 'ประสิทธิ์ สโตร์แมน',
      gps_lat: 13.6899,
      gps_lng: 100.7501,
      notes: 'พาเลทที่ #15 รอเบิกจ่ายไปหน้างานลพบุรี',
      scanned_mode: 'warehouse'
    }
  ];

  return Promise.all(samplePanels.map(p => savePanel(p)))
    .then(results => ({ success: true, count: results.length }));
}

async function importPanels(panelsArray, { requireWarehouseStock = false } = {}) {
  if (!Array.isArray(panelsArray)) return Promise.reject(new Error('Invalid import format: expected array'));
  const validPanels = panelsArray.map(p => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const isWarehouse = p.status === 'warehouse' || p.scanned_mode === 'warehouse';
    const serialNumber = typeof p.serial_number === 'string' ? p.serial_number.trim() : '';
    const projectName = typeof p.project_name === 'string' ? p.project_name.trim() : '';
    if (!serialNumber || (!isWarehouse && !projectName)) return null;
    return {
      ...p,
      serial_number: serialNumber,
      project_name: isWarehouse ? WAREHOUSE_PROJECT_NAME : projectName
    };
  }).filter(Boolean);

  if (requireWarehouseStock) {
    const seenSerials = new Set();
    for (const panel of validPanels) {
      const key = panel.serial_number.toLowerCase();
      if (seenSerials.has(key)) {
        throw stockConflict(`พบ SN ${panel.serial_number} ซ้ำในรายการเบิก`);
      }
      seenSerials.add(key);
      if (panel.status === 'warehouse' || panel.scanned_mode === 'warehouse') {
        throw stockConflict(`SN ${panel.serial_number} ในรายการเบิกต้องถูกตัดออกจากสต๊อกไปยังโครงการ`);
      }

      const current = await getPanelBySerial(panel.serial_number);
      if (!current) {
        throw stockConflict(`ไม่พบ SN ${panel.serial_number} ในคลังสินค้า กรุณารับเข้าสต๊อกก่อนเบิกไปหน้างาน`);
      }
      if (current.status !== 'warehouse') {
        throw stockConflict(`SN ${panel.serial_number} ถูกเบิกไปแล้วที่ ${current.project_name} (สถานะ: ${current.status})`);
      }
      if (isWarehouseProject(panel.project_name)) {
        throw stockConflict('กรุณาเลือกโครงการปลายทาง การเบิกแผงออกจากคลังต้องระบุหน้างาน');
      }
    }
  }

  const results = await Promise.all(validPanels.map(p => savePanel(p, { requireWarehouseStock })));
  return { success: true, count: results.filter(Boolean).length };
}

function getEquipmentCatalog() {
  if (useJsonStore) {
    memoryStore.equipmentCatalog ||= [];
    return Promise.resolve([...memoryStore.equipmentCatalog].sort((a, b) => a.name.localeCompare(b.name)));
  }
  return new Promise((resolve, reject) => {
    db.all('SELECT id, name, unit, created_at, updated_at FROM equipment_catalog ORDER BY name COLLATE NOCASE', (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function saveEquipmentCatalogItem({ id, name, unit = 'ชิ้น' }) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanUnit = typeof unit === 'string' ? unit.trim() : '';
  if (!cleanName) return Promise.reject(new Error('กรุณาระบุชื่ออุปกรณ์'));
  if (!cleanUnit) return Promise.reject(new Error('กรุณาระบุหน่วยนับ'));

  if (useJsonStore) {
    memoryStore.equipmentCatalog ||= [];
    const itemId = id ? Number(id) : null;
    const duplicate = memoryStore.equipmentCatalog.find(item =>
      item.name.toLowerCase() === cleanName.toLowerCase() && item.id !== itemId
    );
    if (duplicate) return Promise.reject(new Error(`มีอุปกรณ์ "${cleanName}" อยู่แล้ว`));
    const now = new Date().toISOString();
    let item = memoryStore.equipmentCatalog.find(entry => entry.id === itemId);
    if (id && !item) return Promise.reject(new Error('ไม่พบข้อมูลอุปกรณ์ที่ต้องการแก้ไข'));
    if (item) {
      item.name = cleanName;
      item.unit = cleanUnit;
      item.updated_at = now;
    } else {
      item = { id: Date.now(), name: cleanName, unit: cleanUnit, created_at: now, updated_at: now };
      memoryStore.equipmentCatalog.push(item);
    }
    saveJsonStore();
    return Promise.resolve({ success: true, item });
  }

  return new Promise((resolve, reject) => {
    if (id) {
      db.run(
        'UPDATE equipment_catalog SET name = ?, unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cleanName, cleanUnit, Number(id)],
        function (err) {
          if (err) return reject(err);
          if (!this.changes) return reject(new Error('ไม่พบข้อมูลอุปกรณ์ที่ต้องการแก้ไข'));
          db.get('SELECT id, name, unit, created_at, updated_at FROM equipment_catalog WHERE id = ?', [Number(id)], (getErr, item) => {
            if (getErr) return reject(getErr);
            resolve({ success: true, item });
          });
        }
      );
    } else {
      db.run(
        'INSERT INTO equipment_catalog (name, unit) VALUES (?, ?)',
        [cleanName, cleanUnit],
        function (err) {
          if (err) return reject(err);
          db.get('SELECT id, name, unit, created_at, updated_at FROM equipment_catalog WHERE id = ?', [this.lastID], (getErr, item) => {
            if (getErr) return reject(getErr);
            resolve({ success: true, item });
          });
        }
      );
    }
  });
}

function deleteEquipmentCatalogItem(id) {
  const itemId = Number(id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return Promise.reject(new Error('รหัสอุปกรณ์ไม่ถูกต้อง'));
  if (useJsonStore) {
    memoryStore.equipmentCatalog ||= [];
    const initialCount = memoryStore.equipmentCatalog.length;
    memoryStore.equipmentCatalog = memoryStore.equipmentCatalog.filter(item => item.id !== itemId);
    if (memoryStore.equipmentCatalog.length === initialCount) return Promise.reject(new Error('ไม่พบข้อมูลอุปกรณ์'));
    saveJsonStore();
    return Promise.resolve({ success: true });
  }
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM equipment_catalog WHERE id = ?', [itemId], function (err) {
      if (err) return reject(err);
      if (!this.changes) return reject(new Error('ไม่พบข้อมูลอุปกรณ์'));
      resolve({ success: true });
    });
  });
}

function normalizeEquipmentIssue(payload, catalog, previousItems = []) {
  const projectName = typeof payload.project_name === 'string' ? payload.project_name.trim() : '';
  const issuedAt = typeof payload.issued_at === 'string' ? payload.issued_at.trim() : '';
  const issuedBy = typeof payload.issued_by === 'string' ? payload.issued_by.trim() : '';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  if (!projectName || isWarehouseProject(projectName)) throw new Error('กรุณาเลือกโครงการหน้างาน');
  const parsedDate = new Date(`${issuedAt}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
    throw new Error('กรุณาระบุวันที่เบิกให้ถูกต้อง');
  }
  if (!issuedBy) throw new Error('กรุณาระบุผู้เบิก');
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error('กรุณาเพิ่มรายการอุปกรณ์อย่างน้อย 1 รายการ');
  const items = payload.items.map(line => {
    const itemId = Number(line?.equipment_id) || 0;
    const quantity = Number(line?.quantity);
    const equipment = catalog.find(entry => Number(entry.id) === itemId);
    const previousItem = previousItems.find(entry =>
      Number(entry.equipment_id) === itemId &&
      entry.name === line?.name &&
      (entry.unit || 'ชิ้น') === (line?.unit || 'ชิ้น')
    );
    const name = typeof line?.name === 'string' ? line.name.trim() : '';
    const unit = typeof line?.unit === 'string' ? line.unit.trim() : '';
    const resolvedName = name || previousItem?.name || equipment?.name || '';
    const resolvedUnit = unit || previousItem?.unit || equipment?.unit || 'ชิ้น';
    if (!resolvedName) throw new Error('กรุณาระบุชื่ออุปกรณ์ในรายการ');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
      throw new Error(`จำนวน "${resolvedName}" ต้องมากกว่า 0`);
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

async function getEquipmentIssues() {
  if (useJsonStore) {
    memoryStore.equipmentIssues ||= [];
    return [...memoryStore.equipmentIssues]
      .sort((a, b) => String(b.issued_at).localeCompare(String(a.issued_at)) || b.id - a.id);
  }
  return new Promise((resolve, reject) => {
    db.all('SELECT id, project_name, issued_at, issued_by, notes, items_json, created_at, updated_at FROM equipment_issues ORDER BY issued_at DESC, id DESC', (err, rows) => {
      if (err) return reject(err);
      try {
        resolve((rows || []).map(row => ({ ...row, items: JSON.parse(row.items_json) })));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function saveEquipmentIssue(payload, id = null) {
  const catalog = await getEquipmentCatalog();
  const issueId = id === null ? null : Number(id);
  if (issueId !== null && (!Number.isSafeInteger(issueId) || issueId <= 0)) {
    throw new Error('รหัสรายการเบิกไม่ถูกต้อง');
  }
  const previous = issueId === null
    ? null
    : (await getEquipmentIssues()).find(entry => Number(entry.id) === issueId);
  if (issueId !== null && !previous) throw new Error('ไม่พบประวัติการเบิกที่ต้องการแก้ไข');
  const issue = normalizeEquipmentIssue(payload || {}, catalog, previous?.items || []);

  if (useJsonStore) {
    memoryStore.equipmentIssues ||= [];
    let record = issueId === null ? null : memoryStore.equipmentIssues.find(entry => entry.id === issueId);
    const now = new Date().toISOString();
    if (record) {
      Object.assign(record, issue, { updated_at: now });
    } else {
      record = { id: Date.now(), ...issue, created_at: now, updated_at: now };
      memoryStore.equipmentIssues.push(record);
    }
    saveJsonStore();
    return { success: true, issue: record };
  }

  const itemsJson = JSON.stringify(issue.items);
  return new Promise((resolve, reject) => {
    const done = (err, resultId) => {
      if (err) return reject(err);
      db.get(
        'SELECT id, project_name, issued_at, issued_by, notes, items_json, created_at, updated_at FROM equipment_issues WHERE id = ?',
        [resultId],
        (getErr, row) => {
          if (getErr) return reject(getErr);
          if (!row) return reject(new Error('ไม่พบประวัติการเบิกที่บันทึก'));
          resolve({
            success: true,
            issue: { ...row, items: JSON.parse(row.items_json) }
          });
        }
      );
    };
    if (issueId === null) {
      db.run(
        'INSERT INTO equipment_issues (project_name, issued_at, issued_by, notes, items_json) VALUES (?, ?, ?, ?, ?)',
        [issue.project_name, issue.issued_at, issue.issued_by, issue.notes, itemsJson],
        function (err) { done(err, this.lastID); }
      );
    } else {
      db.run(
        'UPDATE equipment_issues SET project_name = ?, issued_at = ?, issued_by = ?, notes = ?, items_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [issue.project_name, issue.issued_at, issue.issued_by, issue.notes, itemsJson, issueId],
        function (err) {
          if (err) return reject(err);
          if (!this.changes) return reject(new Error('ไม่พบประวัติการเบิกที่ต้องการแก้ไข'));
          done(null, issueId);
        }
      );
    }
  });
}

function deleteEquipmentIssue(id) {
  const issueId = Number(id);
  if (!Number.isSafeInteger(issueId) || issueId <= 0) return Promise.reject(new Error('รหัสรายการเบิกไม่ถูกต้อง'));
  if (useJsonStore) {
    memoryStore.equipmentIssues ||= [];
    const initialCount = memoryStore.equipmentIssues.length;
    memoryStore.equipmentIssues = memoryStore.equipmentIssues.filter(issue => issue.id !== issueId);
    if (memoryStore.equipmentIssues.length === initialCount) return Promise.reject(new Error('ไม่พบประวัติการเบิก'));
    saveJsonStore();
    return Promise.resolve({ success: true });
  }
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM equipment_issues WHERE id = ?', [issueId], function (err) {
      if (err) return reject(err);
      if (!this.changes) return reject(new Error('ไม่พบประวัติการเบิก'));
      resolve({ success: true });
    });
  });
}

function normalizeToolAsset(payload = {}) {
  const text = (key) => typeof payload[key] === 'string' ? payload[key].trim() : '';
  const asset = {
    asset_code: text('asset_code').toUpperCase(),
    name: text('name'),
    category: text('category'),
    brand: text('brand'),
    model: text('model'),
    serial_number: text('serial_number'),
    location: text('location'),
    condition_note: text('condition_note'),
    purchase_date: text('purchase_date'),
    photo: text('photo')
  };
  if (!asset.name) throw equipmentError('กรุณาระบุชื่อเครื่องมือ');
  if (asset.photo && !/^data:image\/(png|jpe?g|webp);base64,/.test(asset.photo)) {
    throw equipmentError('รูปเครื่องมือไม่ถูกต้อง');
  }
  if (asset.photo && asset.photo.length > 3000000) {
    throw equipmentError('ไฟล์รูปใหญ่เกินไป (สูงสุดประมาณ 2MB)');
  }
  if (asset.purchase_date && !/^\d{4}-\d{2}-\d{2}$/.test(asset.purchase_date)) {
    throw equipmentError('วันที่ซื้อไม่ถูกต้อง');
  }
  return asset;
}

function formatToolAssetCode(id) {
  return `TL-${String(id).padStart(4, '0')}`;
}

function nextToolAssetSequence(tools) {
  return Math.max(0, ...(tools || []).map(tool => Number(/^TL-(\d+)$/i.exec(String(tool.asset_code || ''))?.[1]) || 0)) + 1;
}

function getToolRegistry() {
  if (useJsonStore) {
    memoryStore.toolAssets ||= [];
    memoryStore.toolEvents ||= [];
    const tools = [...memoryStore.toolAssets].sort((a, b) => String(a.asset_code).localeCompare(String(b.asset_code)));
    const events = [...memoryStore.toolEvents].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12);
    return Promise.resolve({
      tools,
      recent: events.map(event => ({
        ...event,
        asset_code: memoryStore.toolAssets.find(tool => Number(tool.id) === Number(event.tool_id))?.asset_code || '',
        tool_name: memoryStore.toolAssets.find(tool => Number(tool.id) === Number(event.tool_id))?.name || ''
      })),
      stats: {
        total: tools.length,
        available: tools.filter(tool => tool.status === 'available').length,
        pending: tools.filter(tool => tool.status === 'pending_approval').length,
        borrowed: tools.filter(tool => tool.status === 'borrowed').length,
        repair: tools.filter(tool => ['maintenance', 'damaged', 'lost'].includes(tool.status)).length
      }
    });
  }
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tool_assets ORDER BY asset_code COLLATE NOCASE', (toolsError, tools) => {
      if (toolsError) return reject(toolsError);
      db.all(`SELECT e.*, t.asset_code, t.name AS tool_name
        FROM tool_events e JOIN tool_assets t ON t.id = e.tool_id
        ORDER BY e.created_at DESC, e.id DESC LIMIT 12`, (eventsError, recent) => {
        if (eventsError) return reject(eventsError);
        const rows = tools || [];
        resolve({
          tools: rows,
          recent: recent || [],
          stats: {
            total: rows.length,
            available: rows.filter(tool => tool.status === 'available').length,
            pending: rows.filter(tool => tool.status === 'pending_approval').length,
            borrowed: rows.filter(tool => tool.status === 'borrowed').length,
            repair: rows.filter(tool => ['maintenance', 'damaged', 'lost'].includes(tool.status)).length
          }
        });
      });
    });
  });
}

async function getToolAsset(id) {
  const toolId = Number(id);
  if (!Number.isSafeInteger(toolId) || toolId <= 0) throw equipmentError('รหัสเครื่องมือไม่ถูกต้อง');
  if (useJsonStore) {
    memoryStore.toolAssets ||= [];
    memoryStore.toolEvents ||= [];
    const tool = memoryStore.toolAssets.find(item => Number(item.id) === toolId);
    if (!tool) throw equipmentError('ไม่พบเครื่องมือ');
    const events = memoryStore.toolEvents.filter(event => Number(event.tool_id) === toolId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
    return { tool, events };
  }
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM tool_assets WHERE id = ?', [toolId], (toolError, tool) => {
      if (toolError) return reject(toolError);
      if (!tool) return reject(equipmentError('ไม่พบเครื่องมือ'));
      db.all('SELECT * FROM tool_events WHERE tool_id = ? ORDER BY created_at DESC, id DESC', [toolId], (eventError, events) => {
        if (eventError) return reject(eventError);
        resolve({ tool, events: events || [] });
      });
    });
  });
}

async function saveToolAsset(payload, id = null) {
  const asset = normalizeToolAsset(payload || {});
  const toolId = id === null ? null : Number(id);
  if (toolId !== null && (!Number.isSafeInteger(toolId) || toolId <= 0)) throw equipmentError('รหัสเครื่องมือไม่ถูกต้อง');
  if (toolId !== null && !asset.photo) {
    asset.photo = typeof payload.existing_photo === 'string' ? payload.existing_photo.trim() : '';
  }
  if (useJsonStore) {
    memoryStore.toolAssets ||= [];
    memoryStore.toolEvents ||= [];
    const nextId = Math.max(0, ...memoryStore.toolAssets.map(item => Number(item.id) || 0)) + 1;
    if (toolId === null && !asset.asset_code) asset.asset_code = formatToolAssetCode(nextToolAssetSequence(memoryStore.toolAssets));
    if (toolId !== null && !asset.asset_code) {
      asset.asset_code = memoryStore.toolAssets.find(item => Number(item.id) === toolId)?.asset_code || '';
    }
    const duplicate = memoryStore.toolAssets.find(item => item.asset_code.toLowerCase() === asset.asset_code.toLowerCase() && Number(item.id) !== toolId);
    if (duplicate) throw equipmentError(`รหัสเครื่องมือ ${asset.asset_code} มีอยู่แล้ว`);
    const now = new Date().toISOString();
    let tool = toolId === null ? null : memoryStore.toolAssets.find(item => Number(item.id) === toolId);
    if (toolId !== null && !tool) throw equipmentError('ไม่พบเครื่องมือ');
    if (tool) Object.assign(tool, asset, { updated_at: now });
    else {
      tool = { id: nextId, ...asset, status: 'available', current_holder: '', current_project: '', expected_return_at: '', created_at: now, updated_at: now };
      memoryStore.toolAssets.push(tool);
      memoryStore.toolEvents.push({ id: Date.now() + 1, tool_id: tool.id, event_type: 'registered', title: 'ลงทะเบียนเครื่องมือ', actor: typeof payload.actor === 'string' ? payload.actor.trim() : '', project_name: '', detail: asset.condition_note, created_at: now });
    }
    saveJsonStore();
    return { success: true, tool };
  }
  return new Promise((resolve, reject) => {
    const finish = (err, savedId, isNew, autoCode = false) => {
      if (err) return reject(err);
      const loadTool = () => db.get('SELECT * FROM tool_assets WHERE id = ?', [savedId], (getError, tool) => {
        if (getError) return reject(getError);
        if (!tool) return reject(equipmentError('ไม่พบเครื่องมือที่บันทึก'));
        if (!isNew) return resolve({ success: true, tool });
        db.run('INSERT INTO tool_events (tool_id, event_type, title, actor, detail) VALUES (?, ?, ?, ?, ?)',
          [savedId, 'registered', 'ลงทะเบียนเครื่องมือ', typeof payload.actor === 'string' ? payload.actor.trim() : '', asset.condition_note],
          eventError => eventError ? reject(eventError) : resolve({ success: true, tool }));
      });
      if (autoCode) {
        const assignNextCode = () => db.all('SELECT asset_code FROM tool_assets WHERE id != ?', [savedId], (codeError, rows) => {
          if (codeError) return reject(codeError);
          const code = formatToolAssetCode(nextToolAssetSequence(rows || []));
          db.run('UPDATE tool_assets SET asset_code = ? WHERE id = ?', [code, savedId], updateError => {
            if (updateError?.code === 'SQLITE_CONSTRAINT') return assignNextCode();
            if (updateError) reject(updateError);
            else loadTool();
          });
        });
        assignNextCode();
      } else loadTool();
    };
    const values = [asset.asset_code || `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, asset.name, asset.category, asset.brand, asset.model, asset.serial_number,
      asset.location, asset.condition_note, asset.purchase_date, asset.photo];
    if (toolId === null) {
      db.run(`INSERT INTO tool_assets (asset_code, name, category, brand, model, serial_number, location, condition_note, purchase_date, photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values, function (error) {
        if (error) return reject(error.code === 'SQLITE_CONSTRAINT' ? equipmentError(`รหัสเครื่องมือ ${asset.asset_code} มีอยู่แล้ว`) : error);
        finish(null, this.lastID, true, !asset.asset_code);
      });
    } else {
      db.run(`UPDATE tool_assets SET asset_code=?, name=?, category=?, brand=?, model=?, serial_number=?, location=?, condition_note=?, purchase_date=?, photo=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [...values, toolId], function (error) {
          if (error) return reject(error.code === 'SQLITE_CONSTRAINT' ? equipmentError(`รหัสเครื่องมือ ${asset.asset_code} มีอยู่แล้ว`) : error);
          if (!this.changes) return reject(equipmentError('ไม่พบเครื่องมือ'));
          finish(null, toolId, false);
        });
    }
  });
}

async function createToolEvent(id, payload = {}) {
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
  if (['maintenance', 'repair_complete', 'damaged', 'lost', 'reject', 'stocktake'].includes(type) && !detail) {
    throw equipmentError('กรุณาระบุรายละเอียดกิจกรรม');
  }
  if (type === 'checkout_request' && !requestedBy) throw equipmentError('กรุณาระบุชื่อผู้ขอเบิก');
  if (type === 'checkout_request' && requestedBy.toLocaleLowerCase() === actor.toLocaleLowerCase()) throw equipmentError('ผู้ขอเบิกและผู้บันทึกคำขอต้องเป็นคนละคน');
  if (type === 'checkout_request' && !projectName) throw equipmentError('กรุณาระบุโครงการหรือสถานที่ใช้งาน');

  if (useJsonStore) {
    memoryStore.toolAssets ||= [];
    memoryStore.toolEvents ||= [];
    const tool = memoryStore.toolAssets.find(item => Number(item.id) === toolId);
    if (!tool) throw equipmentError('ไม่พบเครื่องมือ');
    if (!definition.from.includes(tool.status)) throw equipmentError(`เปลี่ยนสถานะจาก ${tool.status} ไม่ได้`);
    const now = new Date().toISOString();
    tool.status = type === 'stocktake' ? tool.status : definition.to;
    const previousProject = tool.current_project;
    tool.current_holder = type === 'checkout_request' ? requestedBy : (type === 'return' || ['repair_complete', 'damaged', 'lost', 'reject'].includes(type) ? '' : tool.current_holder);
    tool.current_project = type === 'checkout_request' ? projectName : (type === 'return' || ['repair_complete', 'damaged', 'lost', 'reject'].includes(type) ? '' : tool.current_project);
    tool.expected_return_at = type === 'checkout_request' ? (payload.expected_return_at || '') : (['return', 'damaged', 'lost', 'reject'].includes(type) ? '' : tool.expected_return_at);
    if (type === 'return') tool.location = payload.location?.trim() || tool.location;
    if (type === 'return' || type === 'repair_complete') tool.condition_note = detail || tool.condition_note;
    tool.updated_at = now;
    const event = { id: Date.now(), tool_id: toolId, event_type: type, title: definition.title, actor, requested_by: requestedBy, project_name: projectName || previousProject || '', detail, created_at: now };
    memoryStore.toolEvents.push(event);
    saveJsonStore();
    return { success: true, tool, event };
  }

  const current = await getToolAsset(toolId);
  if (!definition.from.includes(current.tool.status)) throw equipmentError(`เปลี่ยนสถานะจาก ${current.tool.status} ไม่ได้`);
  const nextStatus = type === 'stocktake' ? current.tool.status : definition.to;
  const nextHolder = type === 'checkout_request' ? requestedBy : (type === 'return' || ['repair_complete', 'damaged', 'lost', 'reject'].includes(type) ? null : current.tool.current_holder);
  const nextProject = type === 'checkout_request' ? projectName : (type === 'return' || ['repair_complete', 'damaged', 'lost', 'reject'].includes(type) ? null : current.tool.current_project);
  const expected = type === 'checkout_request' ? (payload.expected_return_at || null) : (['return', 'damaged', 'lost', 'reject'].includes(type) ? null : current.tool.expected_return_at);
  const location = type === 'return' ? (payload.location?.trim() || current.tool.location) : current.tool.location;
  const condition = ['return', 'repair_complete'].includes(type) && detail ? detail : current.tool.condition_note;
  return new Promise((resolve, reject) => {
    db.run(`UPDATE tool_assets SET status=?, current_holder=?, current_project=?, expected_return_at=?, location=?, condition_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [nextStatus, nextHolder, nextProject, expected, location, condition, toolId], updateError => {
        if (updateError) return reject(updateError);
        db.run('INSERT INTO tool_events (tool_id, event_type, title, actor, requested_by, project_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [toolId, type, definition.title, actor, requestedBy, projectName || current.tool.current_project || '', detail], async eventError => {
            if (eventError) return reject(eventError);
            try {
              const fresh = await getToolAsset(toolId);
              resolve({ success: true, ...fresh, event: fresh.events[0] });
            } catch (error) { reject(error); }
          });
      });
  });
}

function getDongleInventory() {
  if (useJsonStore) {
    memoryStore.dongles ||= [];
    return Promise.resolve([...memoryStore.dongles].sort((a, b) =>
      String(a.status).localeCompare(String(b.status)) || String(a.serial_number).localeCompare(String(b.serial_number))
    ));
  }
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, serial_number, model, status, project_name, responsible, issued_at, created_at, updated_at FROM dongle_inventory ORDER BY status, serial_number COLLATE NOCASE',
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

async function addDongles(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('กรุณาระบุ Serial Number อย่างน้อย 1 รายการ');
  }
  const cleanRecords = records.map(record => ({
    serial_number: typeof record?.serial_number === 'string' ? record.serial_number.trim() : '',
    model: typeof record?.model === 'string' ? record.model.trim() : ''
  }));
  const seen = new Set();
  for (const record of cleanRecords) {
    if (!record.serial_number) throw new Error('กรุณาระบุ Serial Number ให้ครบ');
    if (!record.model) throw new Error('กรุณาระบุรุ่นดองเกิ้ล');
    const key = record.serial_number.toLowerCase();
    if (seen.has(key)) throw new Error(`พบ SN ${record.serial_number} ซ้ำในรายการ`);
    seen.add(key);
  }

  if (useJsonStore) {
    memoryStore.dongles ||= [];
    const existing = new Set(memoryStore.dongles.map(item => item.serial_number.toLowerCase()));
    const duplicate = cleanRecords.find(record => existing.has(record.serial_number.toLowerCase()));
    if (duplicate) throw stockConflict(`SN ${duplicate.serial_number} มีในสต๊อกแล้ว`);
    const now = new Date().toISOString();
    const created = cleanRecords.map(record => ({
      id: Date.now() + memoryStore.dongles.length,
      ...record,
      status: 'warehouse',
      project_name: '',
      responsible: '',
      issued_at: '',
      created_at: now,
      updated_at: now
    }));
    memoryStore.dongles.push(...created);
    saveJsonStore();
    return { success: true, count: created.length };
  }

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', beginError => {
        if (beginError) return reject(beginError);
        let index = 0;
        const rollback = error => {
          db.run('ROLLBACK', rollbackError => reject(rollbackError || error));
        };
        const insertNext = () => {
          if (index >= cleanRecords.length) {
            db.run('COMMIT', commitError => {
              if (commitError) return rollback(commitError);
              resolve({ success: true, count: cleanRecords.length });
            });
            return;
          }
          const record = cleanRecords[index];
          db.run(
            'INSERT INTO dongle_inventory (serial_number, model) VALUES (?, ?)',
            [record.serial_number, record.model],
            error => {
              if (error) {
                if (error.code === 'SQLITE_CONSTRAINT') {
                  return rollback(stockConflict(`SN ${record.serial_number} มีในสต๊อกแล้ว`));
                }
                return rollback(error);
              }
              index++;
              insertNext();
            }
          );
        };
        insertNext();
      });
    });
  });
}

function normalizeDongleIssue(payload) {
  const projectName = typeof payload.project_name === 'string' ? payload.project_name.trim() : '';
  const responsible = typeof payload.responsible === 'string' ? payload.responsible.trim() : '';
  const issuedAt = typeof payload.issued_at === 'string' ? payload.issued_at.trim() : '';
  const parsedDate = new Date(`${issuedAt}T00:00:00Z`);
  if (!projectName || isWarehouseProject(projectName)) throw new Error('กรุณาเลือกโครงการหน้างาน');
  if (!responsible) throw new Error('กรุณาระบุผู้รับผิดชอบ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
    throw new Error('กรุณาระบุวันที่เบิกให้ถูกต้อง');
  }
  return { project_name: projectName, responsible, issued_at: issuedAt };
}

async function issueDongle(id, payload) {
  const dongleId = Number(id);
  if (!Number.isSafeInteger(dongleId) || dongleId <= 0) throw new Error('รหัสดองเกิ้ลไม่ถูกต้อง');
  const issue = normalizeDongleIssue(payload || {});
  if (useJsonStore) {
    memoryStore.dongles ||= [];
    const dongle = memoryStore.dongles.find(item => Number(item.id) === dongleId);
    if (!dongle) throw new Error('ไม่พบข้อมูลดองเกิ้ล');
    if (dongle.status !== 'warehouse') throw stockConflict(`SN ${dongle.serial_number} ถูกเบิกไปแล้ว`);
    Object.assign(dongle, issue, { status: 'issued', updated_at: new Date().toISOString() });
    saveJsonStore();
    return { success: true, dongle };
  }
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE dongle_inventory SET status = 'issued', project_name = ?, responsible = ?, issued_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'warehouse'",
      [issue.project_name, issue.responsible, issue.issued_at, dongleId],
      function (err) {
        if (err) return reject(err);
        if (!this.changes) {
          db.get('SELECT serial_number, status FROM dongle_inventory WHERE id = ?', [dongleId], (getError, row) => {
            if (getError) return reject(getError);
            if (!row) return reject(new Error('ไม่พบข้อมูลดองเกิ้ล'));
            reject(stockConflict(`SN ${row.serial_number} ถูกเบิกไปแล้ว`));
          });
          return;
        }
        db.get(
          'SELECT id, serial_number, model, status, project_name, responsible, issued_at, created_at, updated_at FROM dongle_inventory WHERE id = ?',
          [dongleId],
          (getError, dongle) => {
            if (getError) return reject(getError);
            resolve({ success: true, dongle });
          }
        );
      }
    );
  });
}

async function returnDongleToStock(id) {
  const dongleId = Number(id);
  if (!Number.isSafeInteger(dongleId) || dongleId <= 0) throw new Error('รหัสดองเกิ้ลไม่ถูกต้อง');
  if (useJsonStore) {
    memoryStore.dongles ||= [];
    const dongle = memoryStore.dongles.find(item => Number(item.id) === dongleId);
    if (!dongle) throw new Error('ไม่พบข้อมูลดองเกิ้ล');
    if (dongle.status !== 'issued') throw stockConflict(`SN ${dongle.serial_number} อยู่ในสต๊อกแล้ว`);
    dongle.status = 'warehouse';
    dongle.updated_at = new Date().toISOString();
    saveJsonStore();
    return { success: true, dongle };
  }
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE dongle_inventory SET status = 'warehouse', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'issued'",
      [dongleId],
      function (err) {
        if (err) return reject(err);
        if (!this.changes) {
          db.get('SELECT serial_number, status FROM dongle_inventory WHERE id = ?', [dongleId], (getError, row) => {
            if (getError) return reject(getError);
            if (!row) return reject(new Error('ไม่พบข้อมูลดองเกิ้ล'));
            reject(stockConflict(`SN ${row.serial_number} อยู่ในสต๊อกแล้ว`));
          });
          return;
        }
        db.get(
          'SELECT id, serial_number, model, status, project_name, responsible, issued_at, created_at, updated_at FROM dongle_inventory WHERE id = ?',
          [dongleId],
          (getError, dongle) => {
            if (getError) return reject(getError);
            resolve({ success: true, dongle });
          }
        );
      }
    );
  });
}

function normalizeAppSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('รูปแบบการตั้งค่าไม่ถูกต้อง');
  }

  const brands = [];
  const seen = new Set();
  for (const item of Array.isArray(input.brands) ? input.brands : []) {
    const name = typeof item === 'string' ? item.trim() : typeof item?.name === 'string' ? item.name.trim() : '';
    const wattage = Number(typeof item === 'object' && item ? item.wattage : 550);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    brands.push({ name, wattage: Number.isInteger(wattage) && wattage >= 1 && wattage <= 2000 ? wattage : 550 });
    seen.add(key);
  }

  return {
    defaultTechnician: typeof input.defaultTechnician === 'string' ? input.defaultTechnician : '',
    brands
  };
}

async function getAppSettings() {
  if (useJsonStore) {
    memoryStore.settings ??= null;
    return memoryStore.settings ? normalizeAppSettings(memoryStore.settings) : null;
  }

  return new Promise((resolve, reject) => {
    db.get("SELECT value FROM app_settings WHERE key = 'app'", (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      try {
        resolve(normalizeAppSettings(JSON.parse(row.value)));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function saveAppSettings(input) {
  const settings = normalizeAppSettings(input);
  if (useJsonStore) {
    memoryStore.settings = settings;
    saveJsonStore();
    return settings;
  }

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('app', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(settings)],
      err => err ? reject(err) : resolve(settings)
    );
  });
}

async function setDongleStatus(id, nextStatus) {
  const dongleId = Number(id);
  if (!Number.isSafeInteger(dongleId) || dongleId <= 0) throw new Error('รหัสดองเกิ้ลไม่ถูกต้อง');
  if (!['damaged', 'warehouse'].includes(nextStatus)) throw new Error('สถานะดองเกิ้ลไม่ถูกต้อง');

  const allowedCurrentStatuses = nextStatus === 'damaged' ? ['warehouse', 'issued'] : ['damaged'];
  if (useJsonStore) {
    memoryStore.dongles ||= [];
    const dongle = memoryStore.dongles.find(item => Number(item.id) === dongleId);
    if (!dongle) throw new Error('ไม่พบข้อมูลดองเกิ้ล');
    if (!allowedCurrentStatuses.includes(dongle.status)) {
      throw stockConflict(`ไม่สามารถเปลี่ยนสถานะ SN ${dongle.serial_number} จาก ${dongle.status} เป็น ${nextStatus} ได้`);
    }
    dongle.status = nextStatus;
    dongle.updated_at = new Date().toISOString();
    saveJsonStore();
    return { success: true, dongle };
  }

  const sourceCondition = nextStatus === 'damaged' ? "status IN ('warehouse', 'issued')" : "status = 'damaged'";
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE dongle_inventory SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${sourceCondition}`,
      [nextStatus, dongleId],
      function (err) {
        if (err) return reject(err);
        if (!this.changes) {
          db.get('SELECT serial_number, status FROM dongle_inventory WHERE id = ?', [dongleId], (getError, row) => {
            if (getError) return reject(getError);
            if (!row) return reject(new Error('ไม่พบข้อมูลดองเกิ้ล'));
            reject(stockConflict(`ไม่สามารถเปลี่ยนสถานะ SN ${row.serial_number} จาก ${row.status} เป็น ${nextStatus} ได้`));
          });
          return;
        }
        db.get(
          'SELECT id, serial_number, model, status, project_name, responsible, issued_at, created_at, updated_at FROM dongle_inventory WHERE id = ?',
          [dongleId],
          (getError, dongle) => {
            if (getError) return reject(getError);
            resolve({ success: true, dongle });
          }
        );
      }
    );
  });
}

function getDatabaseInfo() {
  const filePath = useJsonStore ? JSON_FILE : DB_FILE;
  let fileSizeBytes = 0;
  let lastModified = new Date().toISOString();

  if (fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      fileSizeBytes = stats.size;
      lastModified = stats.mtime.toISOString();
    } catch (e) {}
  }

  return getStats().then(stats => ({
    engine: useJsonStore ? 'JSON Store Fallback' : 'SQLite (sqlite3)',
    filePath,
    fileName: path.basename(filePath),
    fileSizeBytes,
    fileSizeFormatted: (fileSizeBytes / 1024).toFixed(2) + ' KB',
    lastModified,
    stats
  }));
}

function getProjectsFull() {
  return new Promise((resolve, reject) => {
    if (useJsonStore) {
      const projectsMap = {};

      (memoryStore.projects || []).forEach(d => {
        if (isWarehouseProject(d.name)) return;
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

      memoryStore.panels.forEach(p => {
        if (p.status === 'warehouse' || isWarehouseProject(p.project_name)) return;
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
        projectsMap[p.project_name].total_panels++;
        if (p.status === 'installed') projectsMap[p.project_name].installed_panels++;
        else if (p.status === 'warehouse') projectsMap[p.project_name].warehouse_panels++;
        else if (p.status === 'installing') projectsMap[p.project_name].installing_panels++;
        else if (p.status === 'damaged') projectsMap[p.project_name].damaged_panels++;
        projectsMap[p.project_name].total_wattage += (Number(p.wattage) || 0);
      });

      return resolve(Object.values(projectsMap));
    }

    const query = `
      SELECT
        p.name,
        COALESCE(p.location, 'ภาคสนาม') as location,
        COALESCE(p.target_capacity_kw, 0) as target_capacity_kw,
        COUNT(pan.id) as total_panels,
        SUM(CASE WHEN pan.status = 'installed' THEN 1 ELSE 0 END) as installed_panels,
        SUM(CASE WHEN pan.status = 'warehouse' THEN 1 ELSE 0 END) as warehouse_panels,
        SUM(CASE WHEN pan.status = 'installing' THEN 1 ELSE 0 END) as installing_panels,
        SUM(CASE WHEN pan.status = 'damaged' THEN 1 ELSE 0 END) as damaged_panels,
        SUM(COALESCE(pan.wattage, 0)) as total_wattage
      FROM (
        SELECT name, location, target_capacity_kw FROM projects
        WHERE LOWER(TRIM(name)) != LOWER(?)
        UNION
        SELECT DISTINCT project_name as name, 'ภาคสนาม' as location, 0 as target_capacity_kw FROM panels
        WHERE project_name IS NOT NULL AND project_name != ''
          AND status != 'warehouse'
          AND LOWER(TRIM(project_name)) != LOWER(?)
      ) p
      LEFT JOIN panels pan ON pan.project_name = p.name AND pan.status != 'warehouse'
      GROUP BY p.name
      ORDER BY total_panels DESC, p.name ASC
    `;

    db.all(query, [WAREHOUSE_PROJECT_NAME, WAREHOUSE_PROJECT_NAME], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

module.exports = {
  initDb,
  getStats,
  getPanels,
  getPanelBySerial,
  savePanel,
  getProjectsList,
  createProject,
  updateProject,
  deleteProject,
  deletePanel,
  batchDeletePanels,
  batchUpdateStatus,
  batchUpdateProject,
  clearAllPanels,
  clearPanelsSelective,
  seedDemoData,
  importPanels,
  getEquipmentCatalog,
  saveEquipmentCatalogItem,
  deleteEquipmentCatalogItem,
  getEquipmentIssues,
  saveEquipmentIssue,
  deleteEquipmentIssue,
  getToolRegistry,
  getToolAsset,
  saveToolAsset,
  createToolEvent,
  getDongleInventory,
  addDongles,
  issueDongle,
  returnDongleToStock,
  setDongleStatus,
  getAppSettings,
  saveAppSettings,
  getDatabaseInfo,
  getProjectsFull
};

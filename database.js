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

let db = null;
let useJsonStore = false;
let memoryStore = {
  panels: [],
  projects: [],
  equipmentCatalog: [],
  equipmentIssues: []
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
      saveJsonStore();
    } catch (err) {
      console.error('Failed reading existing JSON file, initializing new store:', err);
      memoryStore = { panels: [], projects: [], equipmentCatalog: [], equipmentIssues: [] };
      saveJsonStore();
    }
  } else {
    memoryStore = { panels: [], projects: [], equipmentCatalog: [], equipmentIssues: [] };
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
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

      db.get('SELECT COUNT(*) as count FROM panels', (err) => {
        if (err) return reject(err);
        if (useJsonStore) {
          memoryStore.equipmentCatalog ||= [];
          memoryStore.equipmentIssues ||= [];
          saveJsonStore();
        }
        resolve();
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

function getPanels(filters = {}) {
  const { search, project, status, limit = 50, offset = 0 } = filters;

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
      record = {
        ...memoryStore.panels[idx],
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
            updated_at = CURRENT_TIMESTAMP
          ${updateCondition}
        `;
        const updateValues = [
          project_name, inverter, string_name, Number(panel_index),
          requireWarehouseStock && !isWarehouse ? row.brand_model : brand_model,
          requireWarehouseStock && !isWarehouse ? row.wattage : Number(wattage),
          status, technician_name, gps_lat, gps_lng, notes, scanned_mode, row.id
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
            brand_model, wattage, status, technician_name, gps_lat, gps_lng, notes, scanned_mode, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        db.run(
          insertQuery,
          [serial_number.trim(), project_name, inverter, string_name, Number(panel_index), brand_model, Number(wattage), status, technician_name, gps_lat, gps_lng, notes, scanned_mode],
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
    db.run(`UPDATE panels SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [status, ...idArray], function (err) {
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
    db.run(`UPDATE panels SET project_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [projectName, ...idArray], function (err) {
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
    const itemId = Number(line?.equipment_id);
    const quantity = Number(line?.quantity);
    const equipment = catalog.find(entry => Number(entry.id) === itemId);
    const previousItem = previousItems.find(entry =>
      Number(entry.equipment_id) === itemId &&
      entry.name === line?.name &&
      (entry.unit || 'ชิ้น') === (line?.unit || 'ชิ้น')
    );
    if (!equipment && !previousItem) throw new Error('มีอุปกรณ์ในรายการที่ไม่พบในทะเบียน กรุณาเลือกใหม่');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
      throw new Error(`จำนวน "${previousItem?.name || equipment?.name}" ต้องมากกว่า 0`);
    }
    return {
      equipment_id: itemId,
      name: previousItem ? previousItem.name : equipment.name,
      unit: previousItem ? previousItem.unit : equipment.unit,
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
  getDatabaseInfo,
  getProjectsFull
};

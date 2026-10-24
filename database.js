/**
 * Database Module for Solar Panel Tracking System
 * Uses SQLite (via sqlite3) with automatic in-memory/JSON fallback if sqlite3 is not installed.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'solar_panels.db');
const JSON_FILE = path.join(__dirname, 'solar_panels_store.json');

let db = null;
let useJsonStore = false;
let memoryStore = {
  panels: [],
  projects: []
};

// Seed initial demo data for field testing
const SEED_PANELS = [
  {
    serial_number: 'LONGI-LR5-72HBD-550M-202401',
    project_name: 'Solar Farm Lopburi Phase 2',
    inverter: 'INV-01',
    string_name: 'STR-01',
    panel_index: 1,
    brand_model: 'Longi Hi-MO 5 Bifacial',
    wattage: 550,
    status: 'installed',
    technician_name: 'สมชาย รักงาน (Tech A)',
    gps_lat: 14.8055,
    gps_lng: 100.6534,
    notes: 'ติดตั้งโครงสร้างเรียบร้อย มุมเอียง 15 องศา',
    scanned_mode: 'field',
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 24).toISOString()
  },
  {
    serial_number: 'LONGI-LR5-72HBD-550M-202402',
    project_name: 'Solar Farm Lopburi Phase 2',
    inverter: 'INV-01',
    string_name: 'STR-01',
    panel_index: 2,
    brand_model: 'Longi Hi-MO 5 Bifacial',
    wattage: 550,
    status: 'installed',
    technician_name: 'สมชาย รักงาน (Tech A)',
    gps_lat: 14.8056,
    gps_lng: 100.6535,
    notes: 'ต่อสาย MC4 แน่นหนา วัด Voc ผ่านเกณฑ์',
    scanned_mode: 'field',
    created_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 20).toISOString()
  },
  {
    serial_number: 'JINKO-JKM560N-72HL4-202410',
    project_name: 'Rooftop Factory Amata Chonburi',
    inverter: 'INV-02',
    string_name: 'STR-05',
    panel_index: 1,
    brand_model: 'Jinko Tiger Neo N-Type',
    wattage: 560,
    status: 'installing',
    technician_name: 'วิชัย ช่างไฟ (Tech B)',
    gps_lat: 13.3611,
    gps_lng: 100.9847,
    notes: 'กำลังจัดสายลงราง Cable Tray',
    scanned_mode: 'field',
    created_at: new Date(Date.now() - 3600000 * 4).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 4).toISOString()
  },
  {
    serial_number: 'TRINA-TSM-NEG19RC.20-580M-01',
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
    notes: 'รับเข้าคลังพาเลทที่ #12 สภาพกล่องสมบูรณ์',
    scanned_mode: 'warehouse',
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 2).toISOString()
  }
];

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
    } catch (err) {
      console.error('Failed reading existing JSON file, initializing new store:', err);
      memoryStore.panels = [...SEED_PANELS];
      saveJsonStore();
    }
  } else {
    memoryStore.panels = [...SEED_PANELS];
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

      // Seed if empty
      db.get('SELECT COUNT(*) as count FROM panels', (err, row) => {
        if (!err && row.count === 0) {
          console.log('🌱 Seeding initial demo panels into SQLite...');
          const stmt = db.prepare(`
            INSERT INTO panels (
              serial_number, project_name, inverter, string_name, panel_index,
              brand_model, wattage, status, technician_name, gps_lat, gps_lng, notes, scanned_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          SEED_PANELS.forEach(p => {
            stmt.run(
              p.serial_number, p.project_name, p.inverter, p.string_name, p.panel_index,
              p.brand_model, p.wattage, p.status, p.technician_name, p.gps_lat, p.gps_lng, p.notes, p.scanned_mode, p.created_at, p.updated_at
            );
          });
          stmt.finalize();
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
    const projects = [...new Set(memoryStore.panels.map(p => p.project_name))].filter(Boolean).length;
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
        COUNT(DISTINCT project_name) as projects
      FROM panels
    `;
    db.get(query, (err, row) => {
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

function savePanel(panelData) {
  const {
    serial_number,
    project_name,
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
  } = panelData;

  const now = new Date().toISOString();

  if (useJsonStore) {
    const idx = memoryStore.panels.findIndex(p => p.serial_number.toLowerCase() === serial_number.toLowerCase());
    let record;
    if (idx >= 0) {
      // Update existing
      record = {
        ...memoryStore.panels[idx],
        project_name,
        inverter,
        string_name,
        panel_index: Number(panel_index) || 0,
        brand_model,
        wattage: Number(wattage) || 550,
        status,
        technician_name,
        gps_lat: gps_lat ? Number(gps_lat) : memoryStore.panels[idx].gps_lat,
        gps_lng: gps_lng ? Number(gps_lng) : memoryStore.panels[idx].gps_lng,
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
    const checkQuery = 'SELECT id FROM panels WHERE LOWER(serial_number) = LOWER(?)';
    db.get(checkQuery, [serial_number], (err, row) => {
      if (err) return reject(err);

      if (row) {
        // Update existing record
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
            gps_lat = COALESCE(?, gps_lat),
            gps_lng = COALESCE(?, gps_lng),
            notes = ?,
            scanned_mode = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `;
        db.run(
          updateQuery,
          [project_name, inverter, string_name, Number(panel_index), brand_model, Number(wattage), status, technician_name, gps_lat, gps_lng, notes, scanned_mode, row.id],
          function (err2) {
            if (err2) return reject(err2);
            db.get('SELECT * FROM panels WHERE id = ?', [row.id], (err3, updated) => {
              if (err3) return reject(err3);
              resolve({ success: true, isUpdate: true, data: updated });
            });
          }
        );
      } else {
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
    const fromPanels = memoryStore.panels.map(p => p.project_name);
    const merged = Array.from(new Set([...fromProjects, ...fromPanels])).filter(Boolean);
    return Promise.resolve(merged);
  }

  return new Promise((resolve, reject) => {
    const query = `
      SELECT DISTINCT name FROM (
        SELECT name FROM projects
        UNION
        SELECT DISTINCT project_name as name FROM panels WHERE project_name IS NOT NULL AND project_name != ''
      )
    `;
    db.all(query, (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(r => r.name).filter(Boolean));
    });
  });
}

function createProject({ name, location = 'ภาคสนาม', target_capacity_kw = 0 }) {
  const cleanName = (name || '').trim();
  if (!cleanName) return Promise.reject(new Error('Project name is required'));

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

  if (useJsonStore) {
    if (!memoryStore.projects) memoryStore.projects = [];
    memoryStore.projects = memoryStore.projects.filter(p => p.name.toLowerCase() !== cleanName.toLowerCase());

    if (action === 'delete_panels') {
      memoryStore.panels = memoryStore.panels.filter(p => p.project_name !== cleanName);
    } else {
      // Default: Move panels to Central Warehouse
      memoryStore.panels.forEach(p => {
        if (p.project_name === cleanName) {
          p.project_name = 'คลังสินค้ากลาง (Central Warehouse)';
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
        db.run('DELETE FROM panels WHERE project_name = ?', [cleanName]);
      } else {
        db.run(
          'UPDATE panels SET project_name = ?, status = ? WHERE project_name = ?',
          ['คลังสินค้ากลาง (Central Warehouse)', 'warehouse', cleanName]
        );
      }

      db.run('DELETE FROM projects WHERE name = ?', [cleanName], function (err) {
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

function importPanels(panelsArray) {
  if (!Array.isArray(panelsArray)) return Promise.reject(new Error('Invalid import format: expected array'));
  return Promise.all(panelsArray.map(p => {
    if (!p.serial_number || !p.project_name) return null;
    return savePanel(p);
  })).then(results => {
    const valid = results.filter(Boolean);
    return { success: true, count: valid.length };
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
        UNION
        SELECT DISTINCT project_name as name, 'ภาคสนาม' as location, 0 as target_capacity_kw FROM panels WHERE project_name IS NOT NULL AND project_name != ''
      ) p
      LEFT JOIN panels pan ON pan.project_name = p.name
      GROUP BY p.name
      ORDER BY total_panels DESC, p.name ASC
    `;

    db.all(query, (err, rows) => {
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
  getDatabaseInfo,
  getProjectsFull
};

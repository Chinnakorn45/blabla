/**
 * Express Server for Solar Panel Tracking System
 * RESTful API & Static Web Host
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const WAREHOUSE_PROJECT_NAME = 'คลังสินค้ากลาง (Central Warehouse)';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- API Routes ----------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    appName: 'Solar Panel Tracking API',
    timestamp: new Date().toISOString()
  });
});

// Summary Stats for Dashboard
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// List / Filter Panels
app.get('/api/panels', async (req, res) => {
  try {
    const { search, project, status, limit, offset } = req.query;
    const result = await db.getPanels({ search, project, status, limit, offset });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error listing panels:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check Panel by Serial (for duplicate check & auto-filling)
app.get('/api/panels/:serial', async (req, res) => {
  try {
    const serial = req.params.serial;
    const panel = await db.getPanelBySerial(serial);
    if (!panel) {
      return res.status(404).json({ success: false, message: 'Panel not found' });
    }
    res.json({ success: true, panel });
  } catch (err) {
    console.error('Error finding panel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save (Create or Update) Panel
app.post('/api/panels', async (req, res) => {
  try {
    const body = req.body || {};
    const serialNumber = typeof body.serial_number === 'string' ? body.serial_number.trim() : '';
    const isWarehouse = body.status === 'warehouse' || body.scanned_mode === 'warehouse';
    const projectName = isWarehouse
      ? WAREHOUSE_PROJECT_NAME
      : (typeof body.project_name === 'string' ? body.project_name.trim() : '');
    if (!serialNumber) {
      return res.status(400).json({ success: false, error: 'Serial number is required.' });
    }
    if (!projectName) {
      return res.status(400).json({ success: false, error: 'Project name is required.' });
    }

    const result = await db.savePanel({
      ...body,
      serial_number: serialNumber,
      project_name: projectName,
      ...(isWarehouse ? { status: 'warehouse', scanned_mode: 'warehouse' } : {})
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('Error saving panel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Panel
app.delete('/api/panels/:id', async (req, res) => {
  try {
    const result = await db.deletePanel(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Error deleting panel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Project list
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.getProjectsList();
    res.json({ success: true, projects });
  } catch (err) {
    console.error('Error fetching projects:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, location, target_capacity_kw } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Project name is required' });
    }
    const result = await db.createProject({ name, location, target_capacity_kw });
    res.status(201).json(result);
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update Project
app.put('/api/projects/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const { name, location, target_capacity_kw } = req.body;
    const result = await db.updateProject({ oldName, name, location, target_capacity_kw });
    res.json(result);
  } catch (err) {
    console.error('Error updating project:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete Project
app.delete('/api/projects/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const { action } = req.body || {};
    const result = await db.deleteProject({ name, action });
    res.json(result);
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- Database Management Endpoints ----------------

// Get Database Info & Metrics
app.get('/api/database/info', async (req, res) => {
  try {
    const info = await db.getDatabaseInfo();
    res.json({ success: true, info });
  } catch (err) {
    console.error('Error getting db info:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch Delete Panels
app.post('/api/database/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No IDs provided' });
    }
    const result = await db.batchDeletePanels(ids);
    res.json(result);
  } catch (err) {
    console.error('Error batch deleting:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch Update Status
app.post('/api/database/batch-status', async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No IDs provided' });
    }
    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }
    const result = await db.batchUpdateStatus(ids, status);
    res.json(result);
  } catch (err) {
    console.error('Error batch status update:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch Update Project
app.post('/api/database/batch-project', async (req, res) => {
  try {
    const { ids, projectName } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0 || !projectName) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' });
    }
    const result = await db.batchUpdateProject(ids, projectName);
    res.json(result);
  } catch (err) {
    console.error('Error batch project update:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Seed Sample Solar Farm Data
app.post('/api/database/seed', async (req, res) => {
  try {
    const result = await db.seedDemoData();
    res.json(result);
  } catch (err) {
    console.error('Error seeding data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clear All Data
app.post('/api/database/clear', async (req, res) => {
  try {
    const result = await db.clearAllPanels();
    res.json(result);
  } catch (err) {
    console.error('Error clearing database:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Selective Clear Data (by status, warehouse, installed, project)
app.post('/api/database/clear-selective', async (req, res) => {
  try {
    const { scope = 'all', project = '' } = req.body;
    const result = await db.clearPanelsSelective({ scope, project });
    res.json(result);
  } catch (err) {
    console.error('Error selective clear:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk Import Panels from JSON
app.post('/api/database/import', async (req, res) => {
  try {
    const { panels } = req.body;
    if (!panels || !Array.isArray(panels)) {
      return res.status(400).json({ success: false, error: 'Expected array of panels' });
    }
    const result = await db.importPanels(panels);
    res.json(result);
  } catch (err) {
    console.error('Error importing panels:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full JSON Backup Download
app.get('/api/database/backup', async (req, res) => {
  try {
    const { data } = await db.getPanels({ limit: 50000 });
    const projects = await db.getProjectsList();
    const backupData = {
      app: 'SolarTrack Field Operations',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      projects,
      totalPanels: data.length,
      panels: data
    };

    const filename = `solartrack_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backupData, null, 2));
  } catch (err) {
    console.error('Error generating backup:', err);
    res.status(500).send('Backup failed: ' + err.message);
  }
});

// Detailed Project Metrics
app.get('/api/database/projects-detail', async (req, res) => {
  try {
    const projects = await db.getProjectsFull();
    res.json({ success: true, projects });
  } catch (err) {
    console.error('Error getting project details:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// CSV Export for Field Reporting
app.get('/api/export/csv', async (req, res) => {
  try {
    const { data } = await db.getPanels({ limit: 10000 });
    
    // Header line
    const headers = [
      'ID',
      'Serial Number',
      'Project Name',
      'Inverter',
      'String',
      'Panel Index',
      'Brand/Model',
      'Wattage (W)',
      'Status',
      'Technician',
      'Latitude',
      'Longitude',
      'Scan Mode',
      'Notes',
      'Last Updated'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = data.map(p => [
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

    // UTF-8 BOM (\uFEFF) ensures Excel displays Thai characters properly
    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');

    const filename = `solar_panels_export_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting CSV:', err);
    res.status(500).send('Failed to export CSV: ' + err.message);
  }
});

// Helper: Get Local Network IP for Mobile Device Access
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Start Server
db.initDb().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIpAddresses();
    console.log('====================================================');
    console.log('☀️  SOLAR PANEL TRACKING SYSTEM (FIELD OPS) READY');
    console.log('====================================================');
    console.log(`💻 Local HTTP:   http://localhost:${PORT}`);
    if (ips.length > 0) {
      console.log(`📱 Mobile (Wi-Fi):`);
      ips.forEach(ip => console.log(`   ➜ http://${ip}:${PORT}`));
    }
    console.log('----------------------------------------------------');
    console.log('🔒 ทำไมเข้า https:// ตรงๆ ไม่ได้:');
    console.log(`   พอร์ต ${PORT} ทำงานด้วยโปรโตคอล http:// (ไม่ใช่ https://)`);
    console.log('   หากต้องการเปิดกล้องมือถือ ให้เลือก 1 วิธีด้านล่าง:');
    console.log('   1. รัน Tunnel สร้าง HTTPS ฟรีใน 5 วิ:');
    console.log('      ➜ npx localtunnel --port 3000');
    console.log('   2. หรือบน Android Chrome ปลดล็อก Wi-Fi IP:');
    console.log('      ➜ chrome://flags/#unsafely-treat-insecure-origin-as-secure');
    console.log('====================================================');
  });

  // Optional Native HTTPS if certificate files exist
  const certPath = path.join(__dirname, 'cert.pem');
  const keyPath = path.join(__dirname, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const https = require('https');
      const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
      https.createServer(httpsOptions, app).listen(3443, '0.0.0.0', () => {
        const ips = getLocalIpAddresses();
        console.log(`🔒 Native HTTPS Server is running on port 3443!`);
        console.log(`   ➜ https://localhost:3443`);
        ips.forEach(ip => console.log(`   ➜ https://${ip}:3443`));
      });
    } catch (e) {
      console.warn('Failed to start HTTPS listener:', e.message);
    }
  }
});

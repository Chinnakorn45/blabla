/**
 * SolarTrack - Field Operations Frontend Application
 * Handles manual panel entry, GPS capture, offline fallback, and UI transitions.
 */

const WAREHOUSE_PROJECT_NAME = 'คลังสินค้ากลาง (Central Warehouse)';

class SolarTrackingApp {
  constructor() {
    this.currentView = 'dashboard';
    this.currentMode = 'field'; // 'warehouse' | 'field'
    this.isMockMode = false;

    // Preserved fields for fast continuous string installation
    this.lastSaved = {
      project_name: '',
      inverter: '',
      string_name: '',
      panel_index: 0,
      technician_name: ''
    };

    this.filters = {
      search: '',
      project: 'all',
      status: 'all'
    };
    this.dashboardPage = 1;
    this.dashboardPageSize = 10;
    this.dashboardRecordsTotal = 0;

    // Database Studio state
    this.selectedIds = new Set();
    this.dbCurrentTab = 'records';
    this.dbFilters = {
      search: '',
      project: 'all',
      status: 'all',
      received_from: '',
      received_to: '',
      moved_from: '',
      moved_to: ''
    };
    this.cachedDbPanels = [];
    this.equipmentCatalog = [];
    this.equipmentIssues = [];
    this.dongles = [];
    this.fieldStockModalPanels = [];
    this.expandedEquipmentIssueIds = new Set();
    this.pendingConfirmation = null;
    this.confirmationReturnFocus = null;
    this.pendingFieldBulkSerials = [];
    this.fieldStockModalSelectedSerials = new Set();
    this.fieldStockModalSelectionInitialized = false;

    this.init();
  }

  async init() {
    this.bindEvents();
    await appSettings.syncWithServer();
    appSettings.updateBrandDatalist();
    window.addEventListener('focus', () => appSettings.refreshFromServer());
    await this.checkBackendConnectivity();
    await this.loadProjects();
    await this.loadDashboardData();
    this.refreshIcons();
  }

  bindEvents() {
    window.addEventListener('popstate', (e) => {
      if (this.currentView === 'scanner') {
        this.stopScannerAndReturn();
      }
    });

    [['input-brand', 'input-wattage'], ['pallet-brand', 'pallet-wattage']].forEach(([brandId, wattageId]) => {
      const brandInput = document.getElementById(brandId);
      const wattageInput = document.getElementById(wattageId);
      if (!brandInput || !wattageInput) return;
      const syncWattage = () => {
        const selectedBrand = appSettings.getBrandEntries().find(brand =>
          brand.name.toLocaleLowerCase() === brandInput.value.trim().toLocaleLowerCase()
        );
        wattageInput.value = selectedBrand ? String(selectedBrand.wattage) : '';
      };
      brandInput.addEventListener('change', syncWattage);
      brandInput.addEventListener('input', syncWattage);
    });

    const warehouseSerialInput = document.querySelector('#view-warehouse #input-serial');
    warehouseSerialInput?.addEventListener('input', () => {
      const normalizeSerials = value => value
        .split(/[\s,;，；]+/)
        .map(serial => serial.replace(/[^a-z0-9]/gi, ''))
        .filter(Boolean)
        .join('\n');
      const cursor = warehouseSerialInput.selectionStart;
      const normalized = normalizeSerials(warehouseSerialInput.value);
      if (normalized !== warehouseSerialInput.value) {
        const normalizedCursor = normalizeSerials(warehouseSerialInput.value.slice(0, cursor)).length;
        warehouseSerialInput.value = normalized;
        warehouseSerialInput.setSelectionRange(normalizedCursor, normalizedCursor);
      }

      const saveBtn = document.querySelector('#view-warehouse #btn-save-panel');
      if (saveBtn) saveBtn.disabled = !warehouseSerialInput.value.trim();
    });

    document.getElementById('field-stock-model')?.addEventListener('change', () => {
      this.pendingFieldBulkSerials = [];
      this.fieldStockModalSelectedSerials.clear();
      this.fieldStockModalSelectionInitialized = false;
      const serialField = document.querySelector('#view-field #input-serial');
      if (serialField) serialField.value = '';
      const saveBtn = document.querySelector('#view-field #btn-save-panel');
      if (saveBtn) saveBtn.disabled = true;
      this.updateFieldSelectionSummary();
    });

    document.getElementById('edit-project')?.addEventListener('change', () => this.syncEditPanelLocationStatus('project'));
    document.getElementById('edit-status')?.addEventListener('change', () => this.syncEditPanelLocationStatus('status'));

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.pendingConfirmation) {
        this.finishConfirmation(false);
      }
    });
  }

  refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // ---------------- Network & Connectivity ----------------

  async checkBackendConnectivity() {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        if (window.location.protocol === 'file:') {
          window.location.replace('http://localhost:3000/');
          return;
        }
        this.isMockMode = false;
        this.updateConnectionIndicator(true, 'เชื่อมต่อเซิร์ฟเวอร์');
        return;
      }
      throw new Error(`เซิร์ฟเวอร์ตอบกลับ HTTP ${res.status}`);
    } catch (e) {
      this.isMockMode = true;
      this.initLocalStorageMock();
      const openedFromFile = window.location.protocol === 'file:';
      this.updateConnectionIndicator(false, openedFromFile ? 'ยังไม่เชื่อมต่อเซิร์ฟเวอร์' : 'โหมดออฟไลน์ (Local DB)');
      this.showToast(
        openedFromFile
          ? 'กำลังเปิดจากไฟล์โดยตรง: เริ่มเซิร์ฟเวอร์ด้วย npm start แล้วเปิด http://localhost:3000 เพื่อใช้ฐานข้อมูลและรายชื่อโครงการ'
          : `เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (${e.message}) ระบบสลับไปใช้ Local Storage ชั่วคราว`,
        'warning'
      );
    }
  }

  updateConnectionIndicator(isOnline, text) {
    const el = document.getElementById('connection-status');
    const textEl = document.getElementById('connection-text');
    if (!el || !textEl) return;

    if (isOnline) {
      el.className = 'flex items-center gap-1.5 text-xs bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-full text-slate-300';
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span id="connection-text" class="text-[11px]">${text}</span>`;
    } else {
      el.className = 'flex items-center gap-1.5 text-xs bg-amber-950/70 border border-amber-800 px-2.5 py-1 rounded-full text-amber-300';
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span><span id="connection-text" class="text-[11px]">${text}</span>`;
    }
  }

  getDefaultBrand() {
    return appSettings.getDefaultBrand();
  }

  getDefaultWattage(brandModel = '') {
    const configuredWattage = brandModel
      ? appSettings.getWattageForBrand(brandModel)
      : appSettings.getDefaultWattage();
    if (brandModel && !configuredWattage) return 0;
    const wattage = Number(configuredWattage);
    return Number.isInteger(wattage) && wattage > 0 ? wattage : 550;
  }

  async postJson(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  }

  async requestJson(path, { method = 'GET', body } = {}) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  }

  async importPanels(panels, { requireWarehouseStock = false } = {}) {
    const result = await this.postJson('/api/database/import', { panels, requireWarehouseStock });
    if (result.count !== panels.length) {
      throw new Error(`Only ${result.count || 0} of ${panels.length} panels were saved`);
    }
    return result;
  }

  // ---------------- Mock Database (When Offline/Standalone) ----------------

  initLocalStorageMock() {
    if (!localStorage.getItem('solartrack_projects')) {
      localStorage.setItem('solartrack_projects', JSON.stringify([]));
    }
    if (!localStorage.getItem('solartrack_panels')) {
      localStorage.setItem('solartrack_panels', JSON.stringify([]));
    }
  }

  getMockPanels() {
    return JSON.parse(localStorage.getItem('solartrack_panels') || '[]');
  }

  getMockProjects() {
    try {
      const raw = localStorage.getItem('solartrack_projects');
      if (raw) return JSON.parse(raw).filter(project => project.name !== WAREHOUSE_PROJECT_NAME);
    } catch {}
    return [];
  }

  saveMockProjects(projects) {
    localStorage.setItem('solartrack_projects', JSON.stringify(projects));
  }

  saveMockPanel(panel, { requireWarehouseStock = false } = {}) {
    const list = this.getMockPanels();
    const idx = list.findIndex(p => p.serial_number.toLowerCase() === panel.serial_number.toLowerCase());
    const isWarehouse = panel.status === 'warehouse' || panel.scanned_mode === 'warehouse';
    if (!isWarehouse && panel.project_name === WAREHOUSE_PROJECT_NAME) {
      throw new Error('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการปลายทาง');
    }
    if (requireWarehouseStock && panel.status === 'warehouse' && panel.scanned_mode !== 'warehouse') {
      throw new Error('กรุณาใช้โหมดรับเข้าคลังเพื่อบันทึกแผงเข้าสต๊อก');
    }
    if (requireWarehouseStock && !isWarehouse) {
      if (idx < 0) {
        throw new Error(`ไม่พบ SN ${panel.serial_number} ในคลังสินค้า กรุณารับเข้าสต๊อกก่อนเบิกไปหน้างาน`);
      }
      const current = list[idx];
      if (current.status !== 'warehouse') {
        throw new Error(`SN ${panel.serial_number} ถูกเบิกไปแล้วที่ ${current.project_name} (สถานะ: ${this.translateStatus(current.status)})`);
      }
      if (panel.project_name === WAREHOUSE_PROJECT_NAME) {
        throw new Error('กรุณาเลือกโครงการปลายทาง การเบิกแผงออกจากคลังต้องระบุหน้างาน');
      }
    }

    const now = new Date().toISOString();
    let record;
    if (idx >= 0) {
      const current = list[idx];
      record = {
        ...current,
        ...panel,
        ...(requireWarehouseStock && !isWarehouse ? {
          brand_model: current.brand_model,
          wattage: current.wattage
        } : {}),
        updated_at: now
      };
      list[idx] = record;
    } else {
      record = {
        id: list.length > 0 ? Math.max(...list.map(p => p.id || 0)) + 1 : 1,
        ...panel,
        created_at: now,
        updated_at: now
      };
      list.unshift(record);
    }
    localStorage.setItem('solartrack_panels', JSON.stringify(list));
    return { success: true, isUpdate: idx >= 0, data: record };
  }

  // ---------------- Navigation & View Switching ----------------

  showView(viewId) {
    const views = ['dashboard', 'warehouse', 'field', 'form', 'success', 'database', 'settings', 'dongle', 'equipment'];
    views.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) {
        if (v === viewId) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });

    this.currentView = viewId;
    this.updateNavButtons(viewId);
    window.scrollTo(0, 0);
    this.refreshIcons();

    if (viewId === 'dashboard') {
      this.loadDashboardData();
    } else if (viewId === 'database') {
      this.loadDatabaseStudioData();
    } else if (viewId === 'dongle') {
      this.populateDbProjectDropdowns().then(() => this.loadDongleData());
    } else if (viewId === 'equipment') {
      this.populateDbProjectDropdowns().then(() => this.loadEquipmentData());
    } else if (viewId === 'settings') {
      appSettings.renderSettingsView();
    }
  }

  updateNavButtons(viewId) {
    const navDashboard = document.getElementById('nav-btn-dashboard');
    const navSettings = document.getElementById('nav-btn-settings');
    const navProjects = document.getElementById('nav-btn-projects');
    const activeClass = 'text-xs px-2.5 sm:px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 bg-amber-500 text-slate-950 font-bold shadow-xs';
    const inactiveClass = 'text-xs px-2.5 sm:px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 text-slate-300 hover:text-white';
    if (navDashboard) navDashboard.className = viewId === 'dashboard' ? activeClass : inactiveClass;
    if (navSettings) navSettings.className = viewId === 'settings' || (viewId === 'database' && this.dbCurrentTab !== 'projects') ? activeClass : inactiveClass;
    if (navProjects) navProjects.className = viewId === 'database' && this.dbCurrentTab === 'projects' ? activeClass : inactiveClass;
  }

  getFormElement(id, fallbackIds = []) {
    const viewRoot = document.getElementById(`view-${this.currentView}`) || document.body;
    const candidates = [id, ...fallbackIds];
    for (const candidate of candidates) {
      const el = viewRoot.querySelector(`#${CSS.escape(candidate)}`);
      if (el) return el;
    }
    for (const candidate of candidates) {
      const el = document.getElementById(candidate);
      if (el) return el;
    }
    return null;
  }

  setPageHeaderMode(mode) {
    const header = document.querySelector('#view-warehouse .page-header-dark, #view-field .page-header-dark');
    if (header) {
      header.classList.toggle('page-header-field', mode === 'field');
    }
  }

  startManualEntryMode(mode) {
    this.currentMode = mode;
    this.pendingFieldBulkSerials = [];
    this.fieldStockModalSelectedSerials.clear();
    this.fieldStockModalSelectionInitialized = false;
    this.updateFieldSelectionSummary();
    this.setPageHeaderMode(mode);
    this.showView(mode === 'warehouse' ? 'warehouse' : 'field');
    this.updateWarehouseStockDatalist();
    if (mode === 'field') {
      const modelSelect = document.getElementById('field-stock-model');
      if (modelSelect) modelSelect.value = '';
      this.loadFieldStockPanels().catch(error => {
        console.error('Unable to load stock models for field issue-out:', error);
        this.showToast(`โหลดรุ่นแผงในสต๊อกไม่สำเร็จ: ${error.message}`, 'error');
      });
    }

    const serialInput = this.getFormElement('input-serial');
    if (serialInput) {
      serialInput.value = '';
      if (mode === 'field') document.getElementById('field-stock-model')?.focus();
      else serialInput.focus();
    }

    const formTag = this.getFormElement('form-mode-tag');
    if (formTag) {
      const isWarehouse = mode === 'warehouse';
      formTag.textContent = isWarehouse ? 'โหมดรับเข้าคลัง' : 'โหมดติดตั้งหน้างาน';
      formTag.className = isWarehouse
        ? 'text-xs font-semibold px-2.5 py-1 rounded bg-emerald-500 text-slate-950'
        : 'text-xs font-semibold px-2.5 py-1 rounded bg-amber-500 text-slate-950';
    }

    this.prepareDataForm('');
  }

  // ---------------- Manual entry workflow ----------------

  async prepareDataForm(serialNumber, { brandModel = '' } = {}) {
    this.showView(this.currentMode === 'warehouse' ? 'warehouse' : 'field');

    const inputSerial = this.getFormElement('input-serial');
    if (inputSerial) inputSerial.value = serialNumber;

    const isWarehouse = this.currentMode === 'warehouse';
    this.setPageHeaderMode(isWarehouse ? 'warehouse' : 'field');
    const saveBtn = this.getFormElement('btn-save-panel');
    const alertEl = this.getFormElement('existing-panel-alert');
    const descEl = this.getFormElement('existing-panel-desc');
    const inputBrandForMode = this.getFormElement('input-brand');
    const inputWattageForMode = this.getFormElement('input-wattage');
    const panelSpecificationsForMode = this.getFormElement('field-panel-specifications');
    if (inputBrandForMode) inputBrandForMode.required = isWarehouse;
    if (inputWattageForMode) inputWattageForMode.required = isWarehouse;
    if (panelSpecificationsForMode) panelSpecificationsForMode.classList.toggle('hidden', !isWarehouse);
    if (!String(serialNumber).trim()) {
      if (alertEl) alertEl.classList.add('hidden');
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    const installFields = this.getFormElement('field-installation-fields');
    const warehouseBanner = this.getFormElement('warehouse-mode-banner');
    const titleText = this.getFormElement('form-title-text');
    const subtitleText = this.getFormElement('form-subtitle-text');
    const modeTag = this.getFormElement('form-mode-tag');
    const labelProject = this.getFormElement('label-project');
    const projectSelect = this.getFormElement('input-project');
    const projectWrapper = this.getFormElement('field-project-wrapper');
    const technicianFields = this.getFormElement('field-technician-gps');
    const inputBrand = this.getFormElement('input-brand');
    const labelBrand = this.getFormElement('label-brand');
    const inputWattage = this.getFormElement('input-wattage');
    const panelSpecifications = this.getFormElement('field-panel-specifications');
    if (inputBrand) inputBrand.required = isWarehouse;
    if (inputWattage) inputWattage.required = isWarehouse;
    if (panelSpecifications) panelSpecifications.classList.toggle('hidden', !isWarehouse);
    if (labelBrand) {
      labelBrand.innerHTML = `ยี่ห้อ / รุ่น (Brand & Model)${isWarehouse ? ' <span class="text-red-500">*</span>' : ''}`;
    }
    const warehouseStatusInput = document.querySelector('input[name="form-status"][value="warehouse"]');
    const warehouseStatusLabel = warehouseStatusInput?.closest('label');
    if (warehouseStatusLabel) warehouseStatusLabel.classList.toggle('hidden', !isWarehouse);
    if (saveBtn) saveBtn.disabled = !isWarehouse;

    if (isWarehouse) {
      if (projectWrapper) projectWrapper.classList.add('hidden');
      if (warehouseBanner) warehouseBanner.classList.remove('hidden');
      if (installFields) installFields.classList.add('hidden');
      if (technicianFields) technicianFields.classList.add('hidden');
      if (titleText) titleText.textContent = 'บันทึกรับแผงเข้าคลังสินค้า';
      if (subtitleText) subtitleText.textContent = 'กรอกรหัสแผงแล้วกดบันทึกได้ทันที ไม่ต้องกรอกข้อมูลเพิ่มเติม';
      if (modeTag) {
        modeTag.textContent = 'โหมดรับเข้าคลัง';
        modeTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-emerald-500 text-slate-950';
      }
      if (labelProject) labelProject.innerHTML = 'คลังสินค้าจัดเก็บ (Warehouse Destination) <span class="text-red-500">*</span>';
      if (saveBtn) {
        saveBtn.innerHTML = '<i data-lucide="package-check" class="w-4 h-4"></i> บันทึกรับเข้าคลังทันที';
        saveBtn.className = 'touch-press flex-[2] py-3 px-6 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white rounded-xl text-sm font-bold shadow-md';
      }

      this.setStatusRadio('warehouse');
    } else {
      if (projectWrapper) projectWrapper.classList.remove('hidden');
      if (warehouseBanner) warehouseBanner.classList.add('hidden');
      if (installFields) installFields.classList.remove('hidden');
      if (technicianFields) technicianFields.classList.remove('hidden');
      if (titleText) titleText.textContent = 'เบิกแผงจากสต๊อกไปหน้างาน';
      if (subtitleText) subtitleText.textContent = 'เลือกโครงการปลายทาง ระบบจะตัดแผง SN นี้ออกจากคลังกลาง';
      if (modeTag) {
        modeTag.textContent = 'โหมดติดตั้งหน้างาน';
        modeTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-amber-500 text-slate-950';
      }
      if (labelProject) labelProject.innerHTML = 'ชื่อโครงการ (Project Name) <span class="text-red-500">*</span>';
      if (saveBtn) {
        saveBtn.innerHTML = '<i data-lucide="package-minus" class="w-4 h-4"></i> ยืนยันเบิกไปหน้างาน';
        saveBtn.className = 'touch-press flex-[2] py-3 px-6 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-xl text-sm font-bold shadow-md';
      }
      if (projectSelect) {
        projectSelect.value = this.lastSaved.project_name === WAREHOUSE_PROJECT_NAME
          ? ''
          : this.lastSaved.project_name;
      }
      this.setStatusRadio('installed');
    }

    // Check if serial already exists
    let existing = null;
    let lookupError = null;
    try {
      if (this.isMockMode) {
        existing = this.getMockPanels().find(p => p.serial_number.toLowerCase() === serialNumber.toLowerCase());
      } else {
        const res = await fetch(`/api/panels/${encodeURIComponent(serialNumber)}`);
        if (res.ok) {
          const json = await res.json();
          existing = json.panel;
        } else if (res.status !== 404) {
          throw new Error(`ไม่สามารถตรวจสอบ SN ได้ (HTTP ${res.status})`);
        }
      }
    } catch (e) {
      console.warn('Error checking existing panel:', e);
      lookupError = e;
    }

    if (existing) {
      alertEl.classList.remove('hidden');
      const location = this.getPanelLocationLabel(existing);
      descEl.textContent = isWarehouse
        ? `พบ SN นี้ในระบบแล้ว (ตำแหน่ง: ${location}, สถานะ: ${this.translateStatus(existing.status)})`
        : existing.status === 'warehouse'
          ? 'พบแผง SN นี้ในสต๊อกกลาง สามารถเลือกโครงการเพื่อเบิกไปหน้างานได้'
          : `SN นี้ถูกเบิกไปที่ ${location} (${existing.inverter || '-'} / ${existing.string_name || '-'}), สถานะ: ${this.translateStatus(existing.status)} ไม่สามารถเบิกซ้ำได้`;

      if (!isWarehouse && existing.status !== 'warehouse' && existing.project_name) {
        this.getFormElement('input-project').value = existing.project_name;
      }
      this.getFormElement('input-index').value = existing.panel_index || '';
      const selectedBrand = (isWarehouse && brandModel) || existing.brand_model || '';
      this.getFormElement('input-brand').value = selectedBrand;
      const selectedWattage = isWarehouse && brandModel
        ? this.getDefaultWattage(brandModel)
        : (existing.wattage || this.getDefaultWattage(existing.brand_model));
      this.getFormElement('input-wattage').value = selectedWattage > 0 ? selectedWattage : '';
      this.getFormElement('input-technician').value = existing.technician_name || this.lastSaved.technician_name || '';
      this.getFormElement('input-notes').value = existing.notes || '';

      this.setStatusRadio(isWarehouse ? 'warehouse' : 'installing');
    } else {
      if (!isWarehouse) {
        alertEl.classList.remove('hidden');
        descEl.textContent = lookupError
          ? `ตรวจสอบ SN ไม่สำเร็จ (${lookupError.message}) จึงยังไม่สามารถเบิกแผงได้`
          : 'ไม่พบ SN นี้ในสต๊อกกลาง กรุณาบันทึกรับเข้าคลังก่อน แล้วจึงเบิกไปหน้างาน';
      } else {
        alertEl.classList.add('hidden');
      }
      this.getFormElement('input-brand').value = isWarehouse ? (brandModel || '') : this.getDefaultBrand();
      const selectedBrand = this.getFormElement('input-brand').value;
      const selectedWattage = selectedBrand ? this.getDefaultWattage(selectedBrand) : 0;
      this.getFormElement('input-wattage').value = selectedWattage > 0 ? selectedWattage : '';
      this.getFormElement('input-technician').value = appSettings.getDefaultTechnician();

      if (!isWarehouse) {
        if (this.lastSaved.project_name) {
          this.getFormElement('input-project').value = this.lastSaved.project_name;
        }
        if (this.lastSaved.technician_name) {
          this.getFormElement('input-technician').value = this.lastSaved.technician_name;
        }

        this.getFormElement('input-index').value = (this.lastSaved.panel_index || 0) + 1;
        this.setStatusRadio('installing');
      }
    }

    if (!isWarehouse && saveBtn) {
      saveBtn.disabled = Boolean(lookupError) || !existing || existing.status !== 'warehouse';
    } else if (saveBtn) {
      saveBtn.disabled = false;
    }

    if (!isWarehouse && this.currentMode === 'field') {
      this.captureGps(true);
    }

    this.refreshIcons();
  }

  setStatusRadio(value) {
    const radios = document.getElementsByName('form-status');
    radios.forEach(r => {
      r.checked = (r.value === value);
    });
  }

  getStatusRadio() {
    const radios = document.getElementsByName('form-status');
    for (const r of radios) {
      if (r.checked) return r.value;
    }
    return 'installed';
  }

  // ---------------- GPS Geolocation Capture ----------------

  captureGps(silent = false) {
    const latEl = this.getFormElement('input-lat');
    const lngEl = this.getFormElement('input-lng');

    if (!navigator.geolocation) {
      if (!silent) this.showToast('เบราว์เซอร์นี้ไม่รองรับ Geolocation', 'warning');
      return;
    }

    latEl.placeholder = 'กำลังค้นหา GPS...';
    lngEl.placeholder = 'กำลังค้นหา GPS...';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latEl.value = pos.coords.latitude.toFixed(6);
        lngEl.value = pos.coords.longitude.toFixed(6);
        if (!silent) this.showToast('บันทึกพิกัด GPS สำเร็จ', 'success');
      },
      (err) => {
        latEl.placeholder = 'Latitude';
        lngEl.placeholder = 'Longitude';
        if (!silent) this.showToast('ไม่สามารถดึงพิกัด GPS: ' + err.message, 'warning');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  // ---------------- Form Submit & Save ----------------

  async updateWarehouseStockDatalist(panels = null) {
    const datalist = document.getElementById('stock-panel-datalist');
    const manualDatalist = document.getElementById('manual-stock-panel-datalist');
    const targets = [datalist, manualDatalist].filter(Boolean);
    if (!targets.length) return;

    let source = panels;
    if (!Array.isArray(source)) {
      source = this.isMockMode ? this.getMockPanels() : [];
      if (!this.isMockMode) {
        try {
          const res = await fetch('/api/panels?status=warehouse&limit=10000');
          if (res.ok) {
            const json = await res.json();
            source = Array.isArray(json.data) ? json.data : [];
          }
        } catch (error) {
          console.warn('Unable to load warehouse stock list:', error);
          source = [];
        }
      }
    }

    const serials = [...new Set(
      (source || [])
        .filter(panel => panel && (panel.status === 'warehouse' || panel.project_name === WAREHOUSE_PROJECT_NAME) && String(panel.serial_number || '').trim())
        .map(panel => String(panel.serial_number).trim())
    )];

    const html = serials.map(serial => `<option value="${this.escapeHtml(serial)}"></option>`).join('');
    targets.forEach(target => {
      target.innerHTML = html;
    });
  }

  async handleFormSubmit(event) {
    event.preventDefault();

    const isWarehouse = this.currentMode === 'warehouse';
    const serialNumber = this.getFormElement('input-serial')?.value.trim() || '';
    const issueSerials = this.currentMode === 'field' && this.pendingFieldBulkSerials.length
      ? [...new Set(this.pendingFieldBulkSerials.filter(Boolean))]
      : [serialNumber].filter(Boolean);
    const targetSerials = isWarehouse
      ? serialNumber.split(/\r?\n/).map(serial => serial.trim()).filter(Boolean)
      : issueSerials;

    const projectName = isWarehouse
      ? WAREHOUSE_PROJECT_NAME
      : this.getFormElement('input-project')?.value.trim() || '';

    if (!targetSerials.length) {
      this.showToast('กรุณาระบุ Serial Number', 'error');
      return;
    }
    const seenSerials = new Set();
    for (const serial of targetSerials) {
      const key = serial.toLowerCase();
      if (seenSerials.has(key)) {
        this.showToast(`พบ Serial Number ซ้ำในรายการ: ${serial}`, 'error');
        return;
      }
      seenSerials.add(key);
    }
    if (!projectName) {
      this.showToast('กรุณาเลือกโครงการ', 'error');
      return;
    }
    const brandModel = this.getFormElement('input-brand')?.value.trim() || '';
    if (isWarehouse && !brandModel) {
      this.showToast('กรุณาเลือกรุ่นหรือยี่ห้อแผงก่อนรับเข้าคลัง', 'warning');
      this.getFormElement('input-brand')?.focus();
      return;
    }
    const fieldModel = !isWarehouse ? document.getElementById('field-stock-model')?.value || '' : '';
    if (!isWarehouse && !fieldModel) {
      this.showToast('กรุณาเลือกรุ่นแผงก่อนเลือก SN / Code', 'warning');
      document.getElementById('field-stock-model')?.focus();
      return;
    }
    const wattage = parseInt(this.getFormElement('input-wattage')?.value, 10);
    if (isWarehouse && (!Number.isInteger(wattage) || wattage < 1 || wattage > 2000)) {
      this.showToast('กรุณาระบุกำลังวัตต์ระหว่าง 1 ถึง 2000 Wp', 'warning');
      this.getFormElement('input-wattage')?.focus();
      return;
    }
    const selectedStockPanels = targetSerials.map(serial => {
      const panel = this.fieldStockModalPanels.find(item =>
        item.serial_number.toLowerCase() === serial.toLowerCase()
      );
      if (!isWarehouse && (!panel || String(panel.brand_model || '').toLowerCase() !== fieldModel.toLowerCase())) {
        return null;
      }
      return panel;
    });
    if (!isWarehouse && selectedStockPanels.some(panel => !panel)) {
      this.showToast('พบ SN ที่ไม่ตรงกับรุ่นแผงที่เลือก หรือไม่มีในสต๊อก กรุณาเลือกใหม่', 'error');
      return;
    }

    const saveBtn = this.getFormElement('btn-save-panel');
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="animate-spin inline-block mr-2">🌀</span> ${isWarehouse ? 'กำลังบันทึกรับเข้าคลัง...' : 'กำลังเบิกแผง...'} `;

    try {
      const payloads = targetSerials.map((serial, index) => ({
        serial_number: serial,
        project_name: projectName,
        inverter: '-',
        string_name: '-',
        panel_index: isWarehouse ? 0 : ((parseInt(this.getFormElement('input-index')?.value, 10) || 0) + index),
        brand_model: isWarehouse ? (brandModel || this.getDefaultBrand()) : selectedStockPanels[index].brand_model,
        wattage: isWarehouse ? wattage : (Number(selectedStockPanels[index].wattage) || wattage),
        status: isWarehouse ? 'warehouse' : 'installing',
        technician_name: this.getFormElement('input-technician')?.value.trim() || appSettings.getDefaultTechnician() || (isWarehouse ? 'Warehouse staff' : 'Field technician'),
        gps_lat: isWarehouse ? null : (parseFloat(this.getFormElement('input-lat')?.value) || null),
        gps_lng: isWarehouse ? null : (parseFloat(this.getFormElement('input-lng')?.value) || null),
        notes: this.getFormElement('input-notes')?.value.trim() || '',
        scanned_mode: this.currentMode
      }));

      let savedPayload = payloads[0];
      if (isWarehouse) {
        if (this.isMockMode) {
          for (const payload of payloads) this.saveMockPanel(payload);
        } else {
          await this.importPanels(payloads);
        }
      } else {
        for (const payload of payloads) {
          let result;
          if (this.isMockMode) {
            result = this.saveMockPanel(payload, { requireWarehouseStock: true });
          } else {
            result = await this.postJson('/api/panels', payload);
          }
          if (result && result.success !== false) {
            savedPayload = result.data || payload;
          } else {
            throw new Error(result && result.error ? result.error : 'Failed to save');
          }
        }
      }

      this.lastSaved = {
        project_name: savedPayload.project_name,
        inverter: savedPayload.inverter,
        string_name: savedPayload.string_name,
        panel_index: savedPayload.panel_index,
        technician_name: savedPayload.technician_name
      };

      if (this.currentMode === 'field' && this.pendingFieldBulkSerials.length) {
        this.pendingFieldBulkSerials = [];
        this.fieldStockModalSelectedSerials.clear();
        this.fieldStockModalSelectionInitialized = false;
        this.updateFieldSelectionSummary();
      }

      this.showSuccessView(savedPayload);
    } catch (err) {
      console.error('Save error:', err);
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      if (isWarehouse) {
        saveBtn.innerHTML = `<i data-lucide="package-check" class="w-4 h-4"></i> บันทึกรับเข้าคลังทันที`;
      } else {
        saveBtn.innerHTML = `<i data-lucide="package-minus" class="w-4 h-4"></i> ยืนยันเบิกไปหน้างาน`;
      }
      this.refreshIcons();
    }
  }

  showSuccessView(panel) {
    document.getElementById('success-serial').textContent = panel.serial_number;
    const isWarehouse = panel.status === 'warehouse';
    document.getElementById('success-project').textContent = this.getPanelLocationLabel(panel);
    document.getElementById('success-location').textContent = isWarehouse
      ? 'คลังสินค้า (สต๊อกพร้อมใช้งาน)'
      : `แผง #${panel.panel_index || 0}`;
    document.getElementById('success-tech').textContent = panel.technician_name || '-';

    const pill = document.getElementById('success-status-pill');
    pill.textContent = this.translateStatus(panel.status);
    pill.className = `inline-flex items-center font-bold px-2.5 py-0.5 rounded text-[11px] whitespace-nowrap ${this.getStatusBadgeClass(panel.status)}`;

    this.showView('success');
  }

  // ---------------- Dashboard Data & Table ----------------

  async loadDashboardData() {
    try {
      let stats, panelsData;
      if (this.isMockMode) {
        let all = this.getMockPanels();
        stats = {
          total: all.length,
          warehouse: all.filter(p => p.status === 'warehouse').length,
          installing: all.filter(p => p.status === 'installing').length,
          installed: all.filter(p => p.status === 'installed').length,
          damaged: all.filter(p => p.status === 'damaged').length,
          projects: [...new Set(all
            .filter(p => p.status !== 'warehouse' && p.project_name !== WAREHOUSE_PROJECT_NAME)
            .map(p => p.project_name))].filter(Boolean).length
        };
        if (this.filters.search) {
          const query = this.filters.search.toLowerCase();
          all = all.filter(panel => [panel.serial_number, panel.project_name, panel.inverter, panel.string_name, panel.technician_name]
            .some(value => String(value || '').toLowerCase().includes(query)));
        }
        if (this.filters.project !== 'all') all = all.filter(panel => panel.project_name === this.filters.project);
        if (this.filters.status !== 'all') all = all.filter(panel => panel.status === this.filters.status);
        all.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
        const total = all.length;
        const offset = (this.dashboardPage - 1) * this.dashboardPageSize;
        panelsData = { total, data: all.slice(offset, offset + this.dashboardPageSize) };
      } else {
        const query = new URLSearchParams({
          ...this.filters,
          limit: String(this.dashboardPageSize),
          offset: String((this.dashboardPage - 1) * this.dashboardPageSize)
        });
        const [statsRes, panelsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch(`/api/panels?${query.toString()}`)
        ]);
        stats = (await statsRes.json()).stats;
        panelsData = await panelsRes.json();
      }

      this.renderStats(stats);
      this.dashboardRecordsTotal = Number(panelsData.total) || 0;
      const pageCount = Math.max(1, Math.ceil(this.dashboardRecordsTotal / this.dashboardPageSize));
      if (this.dashboardPage > pageCount) {
        this.dashboardPage = pageCount;
        return this.loadDashboardData();
      }
      this.renderPanelsTable(panelsData.data, this.dashboardRecordsTotal);
      this.updateWarehouseStockDatalist();
    } catch (err) {
      console.error('Error loading dashboard data:', err);
    }
  }

  renderStats(stats) {
    if (!stats) return;
    document.getElementById('stat-total').textContent = (stats.total || 0).toLocaleString();
    document.getElementById('stat-warehouse').textContent = (stats.warehouse || 0).toLocaleString();
    document.getElementById('stat-installing').textContent = (stats.installing || 0).toLocaleString();
    document.getElementById('stat-installed').textContent = (stats.installed || 0).toLocaleString();
    document.getElementById('stat-projects').textContent = (stats.projects || 0).toLocaleString();
  }

  renderPanelsTable(panels, total = panels?.length || 0) {
    const tbody = document.getElementById('panels-table-body');
    const cardsContainer = document.getElementById('panels-cards-container');

    if (!panels || panels.length === 0) {
      const emptyHtml = `
        <div class="py-8 text-center text-slate-400 text-xs">
          <i data-lucide="inbox" class="w-7 h-7 mx-auto mb-1 text-slate-300"></i>
          ไม่พบข้อมูลแผงโซลาร์ตามเงื่อนไขที่เลือก
        </div>
      `;
      if (cardsContainer) cardsContainer.innerHTML = emptyHtml;
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="py-10 text-center text-slate-400">
              <i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
              ไม่พบข้อมูลแผงโซลาร์ตามเงื่อนไขที่เลือก
            </td>
          </tr>
        `;
      }
      this.renderDashboardPagination(total);
      this.refreshIcons();
      return;
    }

    if (cardsContainer) {
      cardsContainer.innerHTML = panels.map(p => {
        const timeStr = this.formatDateTime(p.updated_at || p.created_at);
        const statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${this.getStatusBadgeClass(p.status)}">${this.translateStatus(p.status)}</span>`;
        return `
          <div class="p-3.5 hover:bg-slate-50 transition flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono font-bold text-xs text-slate-900 truncate">${this.escapeHtml(p.serial_number)}</span>
              ${statusBadge}
            </div>
            <div class="text-xs text-slate-700 flex items-center gap-1.5">
              <i data-lucide="folder" class="w-3.5 h-3.5 text-amber-500 shrink-0"></i>
              <span class="truncate font-medium">${this.escapeHtml(this.getPanelLocationLabel(p))}</span>
            </div>
            <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100">
              <span class="font-mono text-slate-600">แผงที่ #${p.panel_index || 0} · ${Number(p.wattage) || 0} Wp</span>
              <div class="flex items-center gap-2">
                <span>${timeStr}</span>
                <button onclick="app.editPanelBySerial('${this.escapeHtml(p.serial_number)}')" class="p-1 hover:bg-slate-200 rounded text-slate-600" title="แก้ไข">
                  <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    if (tbody) {
      tbody.innerHTML = panels.map(p => {
        const timeStr = this.formatDateTime(p.updated_at || p.created_at);
        const statusBadge = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${this.getStatusBadgeClass(p.status)}">${this.translateStatus(p.status)}</span>`;
        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100">
            <td class="py-3 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">${this.escapeHtml(p.serial_number)}</td>
            <td class="py-3 px-4 font-medium whitespace-nowrap">${this.escapeHtml(this.getPanelLocationLabel(p))}</td>
            <td class="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">${this.escapeHtml(p.inverter || '-')} / ${this.escapeHtml(p.string_name || '-')} (#${p.panel_index || 0})</td>
            <td class="py-3 px-4 whitespace-nowrap">${statusBadge}</td>
            <td class="py-3 px-4 text-slate-600 whitespace-nowrap">${this.escapeHtml(p.technician_name || '-')}</td>
            <td class="py-3 px-4 text-right text-slate-400 text-[11px] whitespace-nowrap">${timeStr}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
              <button onclick="app.editPanelBySerial('${this.escapeHtml(p.serial_number)}')" class="p-1 hover:bg-slate-200 rounded text-slate-600 hover:text-slate-900 transition" title="แก้ไข">
                <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    this.renderDashboardPagination(total);
    this.refreshIcons();
  }

  renderDashboardPagination(total) {
    const container = document.getElementById('dashboard-pagination');
    if (!container) return;
    const pageCount = Math.max(1, Math.ceil(total / this.dashboardPageSize));
    const first = total ? (this.dashboardPage - 1) * this.dashboardPageSize + 1 : 0;
    const last = Math.min(this.dashboardPage * this.dashboardPageSize, total);
    container.innerHTML = `
      <div class="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
        <p class="text-xs text-slate-500">แสดง <strong class="text-slate-700">${first}–${last}</strong> จาก ${total.toLocaleString()} รายการ</p>
        <div class="flex items-center gap-2">
          <button type="button" onclick="app.changeDashboardPage(-1)" ${this.dashboardPage <= 1 ? 'disabled' : ''} class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
          <span class="min-w-16 text-center text-xs font-semibold text-slate-600">${this.dashboardPage} / ${pageCount}</span>
          <button type="button" onclick="app.changeDashboardPage(1)" ${this.dashboardPage >= pageCount ? 'disabled' : ''} class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
        </div>
      </div>`;
  }

  changeDashboardPage(direction) {
    const pageCount = Math.max(1, Math.ceil(this.dashboardRecordsTotal / this.dashboardPageSize));
    this.dashboardPage = Math.max(1, Math.min(pageCount, this.dashboardPage + direction));
    this.loadDashboardData();
  }

  handleFilterChange() {
    this.filters.search = document.getElementById('filter-search').value.trim();
    this.filters.project = document.getElementById('filter-project').value;
    this.filters.status = document.getElementById('filter-status').value;
    this.dashboardPage = 1;
    this.loadDashboardData();
  }

  // ---------------- Project Dropdown & Management ----------------

  async loadProjects() {
    let projects = [];
    try {
      if (this.isMockMode) {
        const savedProjects = this.getMockProjects().map(project => project.name);
        const panels = this.getMockPanels();
        const panelProjects = panels
          .filter(p => p.status !== 'warehouse' && p.project_name !== WAREHOUSE_PROJECT_NAME)
          .map(p => p.project_name);
        projects = Array.from(new Set([...savedProjects, ...panelProjects])).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        if (!res.ok) throw new Error(`โหลดรายชื่อโครงการไม่สำเร็จ (HTTP ${res.status})`);
        const data = await res.json();
        if (data.success === false) throw new Error(data.error || 'โหลดรายชื่อโครงการไม่สำเร็จ');
        projects = data.projects || [];
      }
    } catch (e) {
      console.warn('Failed loading projects:', e);
      projects = [];
      this.showToast(`โหลดรายชื่อโครงการไม่สำเร็จ: ${e.message}`, 'error');
    }

    this.cachedProjectsList = projects;

    const filterSelect = document.getElementById('filter-project');
    const formSelect = document.getElementById('input-project');
    const dbFilterSelect = document.getElementById('db-filter-project');
    const batchProjSelect = document.getElementById('batch-project-select');
    const clearProjSelect = document.getElementById('clear-target-project');
    const singleProjSelect = document.getElementById('manual-preset-project');
    const bulkProjSelect = document.getElementById('bulk-preset-project');

    const optionsHtml = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');

    if (filterSelect) {
      const currentVal = filterSelect.value;
      filterSelect.innerHTML = `<option value="all">ทุกโครงการ (${projects.length})</option>` + optionsHtml;
      if (currentVal && projects.includes(currentVal)) filterSelect.value = currentVal;
    }

    if (formSelect) {
      const currentVal = formSelect.value;
      formSelect.innerHTML = projects.length
        ? `<option value="">-- เลือกโครงการ --</option>` + optionsHtml
        : '<option value="">ยังไม่มีโครงการ - กดปุ่ม “โครงการใหม่” เพื่อเพิ่ม</option>';
      if (currentVal && projects.includes(currentVal)) formSelect.value = currentVal;
    }

    if (dbFilterSelect) {
      const currentVal = dbFilterSelect.value;
      dbFilterSelect.innerHTML = `<option value="all">ทุกโครงการ (${projects.length})</option>` + optionsHtml;
      if (currentVal && projects.includes(currentVal)) dbFilterSelect.value = currentVal;
    }

    if (batchProjSelect) {
      batchProjSelect.innerHTML = optionsHtml;
    }

    if (clearProjSelect) {
      clearProjSelect.innerHTML = optionsHtml;
    }

    if (singleProjSelect) {
      const currentVal = singleProjSelect.value;
      singleProjSelect.innerHTML = `<option value="">-- เลือกโครงการ --</option>` + optionsHtml;
      if (currentVal && projects.includes(currentVal)) singleProjSelect.value = currentVal;
    }

    if (bulkProjSelect) {
      const currentVal = bulkProjSelect.value;
      bulkProjSelect.innerHTML = `<option value="">-- เลือกโครงการ --</option>` + optionsHtml;
      if (currentVal && projects.includes(currentVal)) bulkProjSelect.value = currentVal;
    }
  }

  openNewProjectModal() {
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-location').value = '';
    document.getElementById('new-project-capacity').value = '';
    document.getElementById('modal-new-project').classList.remove('hidden');
    setTimeout(() => document.getElementById('new-project-name').focus(), 50);
    this.refreshIcons();
  }

  closeNewProjectModal() {
    document.getElementById('modal-new-project').classList.add('hidden');
  }

  async handleCreateProject(e) {
    e.preventDefault();
    const name = document.getElementById('new-project-name').value.trim();
    const location = document.getElementById('new-project-location').value.trim() || 'ภาคสนาม';
    const capacity = parseFloat(document.getElementById('new-project-capacity').value) || 0;

    if (!name) {
      this.showToast('กรุณาระบุชื่อโครงการ', 'error');
      return;
    }
    if (name.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
      this.showToast('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการ', 'error');
      return;
    }

    const btn = document.getElementById('btn-submit-new-project');
    if (btn) btn.disabled = true;

    try {
      if (this.isMockMode) {
        const projs = this.getMockProjects();
        if (projs.some(p => p.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`โครงการ "${name}" มีอยู่ในระบบแล้ว`);
        }
        projs.push({ id: Date.now(), name, location, target_capacity_kw: capacity });
        this.saveMockProjects(projs);
      } else {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, location, target_capacity_kw: capacity })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'สร้างโครงการไม่สำเร็จ');
        }
      }

      this.closeNewProjectModal();
      this.showToast(`🎉 เพิ่มโครงการ "${name}" สำเร็จ!`, 'success');

      await this.loadProjects();

      const formSelect = document.getElementById('input-project');
      if (formSelect) formSelect.value = name;

      await this.loadDbProjects();
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  openEditProjectModal(projectName) {
    const proj = (this.cachedProjects || []).find(p => p.name === projectName) || { name: projectName };
    document.getElementById('edit-project-old-name').value = projectName;
    document.getElementById('edit-project-name').value = projectName;
    document.getElementById('edit-project-location').value = proj.location || 'ภาคสนาม';
    document.getElementById('edit-project-capacity').value = proj.target_capacity_kw || '';

    document.getElementById('modal-edit-project').classList.remove('hidden');
    setTimeout(() => document.getElementById('edit-project-name').focus(), 50);
    this.refreshIcons();
  }

  closeEditProjectModal() {
    document.getElementById('modal-edit-project').classList.add('hidden');
  }

  async handleUpdateProject(e) {
    e.preventDefault();
    const oldName = document.getElementById('edit-project-old-name').value.trim();
    const newName = document.getElementById('edit-project-name').value.trim();
    const location = document.getElementById('edit-project-location').value.trim() || 'ภาคสนาม';
    const capacity = parseFloat(document.getElementById('edit-project-capacity').value) || 0;

    if (!newName) {
      this.showToast('กรุณาระบุชื่อโครงการ', 'error');
      return;
    }
    if (oldName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase() ||
        newName.toLowerCase() === WAREHOUSE_PROJECT_NAME.toLowerCase()) {
      this.showToast('คลังสินค้ากลางเป็นสต๊อก ไม่ใช่โครงการ', 'error');
      return;
    }

    const btn = document.getElementById('btn-submit-edit-project');
    if (btn) btn.disabled = true;

    try {
      if (this.isMockMode) {
        const projs = this.getMockProjects();
        const p = projs.find(x => x.name.toLowerCase() === oldName.toLowerCase());
        if (p) {
          p.name = newName;
          p.location = location;
          p.target_capacity_kw = capacity;
        } else {
          projs.push({ id: Date.now(), name: newName, location, target_capacity_kw: capacity });
        }
        this.saveMockProjects(projs);

        if (oldName !== newName) {
          let list = this.getMockPanels();
          list.forEach(pan => {
            if ((pan.project_name || '').trim().toLowerCase() === oldName.toLowerCase()) {
              pan.project_name = newName;
            }
          });
          localStorage.setItem('solartrack_panels', JSON.stringify(list));
        }
      } else {
        const res = await fetch(`/api/projects/${encodeURIComponent(oldName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, location, target_capacity_kw: capacity })
        });
        if (!res.ok) {
          if (oldName !== newName) {
            const panelsRes = await fetch(`/api/panels?project=${encodeURIComponent(oldName)}&limit=10000`);
            if (panelsRes.ok) {
              const panelsJson = await panelsRes.json();
              const targets = panelsJson.data || [];
              await Promise.all(targets.map(p => fetch('/api/panels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...p, project_name: newName })
              })));
            }
          }
        }
      }

      this.closeEditProjectModal();
      this.showToast(`✏️ แก้ไขโครงการ "${newName}" เรียบร้อยแล้ว`, 'success');
      await this.loadProjects();
      await this.loadDbProjects();
      await this.loadDbRecords();
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการแก้ไขโครงการ: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  openDeleteProjectModal(projectName, panelCount) {
    if (projectName === 'คลังสินค้ากลาง (Central Warehouse)') {
      this.showToast('ไม่สามารถลบคลังสินค้าหลักของระบบได้', 'warning');
      return;
    }
    document.getElementById('delete-project-name-hidden').value = projectName;
    document.getElementById('delete-project-name-display').textContent = projectName;
    document.getElementById('delete-project-count-display').textContent = panelCount || 0;

    const optContainer = document.getElementById('delete-project-options-container');
    if (panelCount === 0 && optContainer) {
      optContainer.classList.add('hidden');
    } else if (optContainer) {
      optContainer.classList.remove('hidden');
    }

    document.getElementById('modal-delete-project').classList.remove('hidden');
    this.refreshIcons();
  }

  closeDeleteProjectModal() {
    document.getElementById('modal-delete-project').classList.add('hidden');
  }

  async executeDeleteProject() {
    const name = document.getElementById('delete-project-name-hidden').value.trim();
    if (!name) return;

    const radios = document.getElementsByName('delete-project-action');
    let action = 'move_warehouse';
    for (const r of radios) {
      if (r.checked) {
        action = r.value;
        break;
      }
    }

    const btn = document.getElementById('btn-confirm-delete-project');
    if (btn) btn.disabled = true;

    if (name === 'คลังสินค้ากลาง (Central Warehouse)') {
      this.showToast('ไม่สามารถลบคลังสินค้าหลักของระบบได้', 'error');
      return;
    }

    try {
      if (this.isMockMode) {
        let projs = this.getMockProjects();
        projs = projs.filter(p => (p.name || '').trim().toLowerCase() !== name.toLowerCase());
        this.saveMockProjects(projs);

        let list = this.getMockPanels();
        if (action === 'delete_panels') {
          list = list.filter(p => (p.project_name || '').trim().toLowerCase() !== name.toLowerCase());
        } else {
          list.forEach(p => {
            if ((p.project_name || '').trim().toLowerCase() === name.toLowerCase()) {
              p.project_name = 'คลังสินค้ากลาง (Central Warehouse)';
              p.status = 'warehouse';
            }
          });
        }
        localStorage.setItem('solartrack_panels', JSON.stringify(list));
      } else {
        const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || errData.message || 'ลบโครงการไม่สำเร็จ');
        }
      }

      this.closeDeleteProjectModal();
      this.showToast(`🗑️ ลบโครงการ "${name}" เรียบร้อยแล้ว`, 'success');
      await this.loadProjects();
      await this.loadDbProjects();
      await this.loadDbRecords();
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการลบโครงการ: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------- Manual & Bulk Paste Entry ----------------

  async openManualEntryModal() {
    const isWarehouse = this.currentMode === 'warehouse';
    let projects = [];
    if (!isWarehouse) {
      try {
        if (this.isMockMode) {
          const savedProjects = this.getMockProjects().map(project => project.name);
          const panelProjects = this.getMockPanels()
            .filter(p => p.status !== 'warehouse' && p.project_name !== WAREHOUSE_PROJECT_NAME)
            .map(p => p.project_name);
          projects = Array.from(new Set([...savedProjects, ...panelProjects])).filter(Boolean);
        } else {
          const res = await fetch('/api/projects');
          if (!res.ok) throw new Error(`Unable to load projects (${res.status})`);
          const json = await res.json();
          projects = json.projects || [];
        }
      } catch (error) {
        console.error('Unable to load projects for manual entry:', error);
        this.showToast(`Unable to load projects: ${error.message}`, 'error');
        return;
      }
    }

    const optionsHtml = `<option value="">-- เลือกโครงการ --</option>` +
      projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');
    const singleProj = document.getElementById('manual-preset-project');
    const bulkProj = document.getElementById('bulk-preset-project');
    if (singleProj) {
      singleProj.innerHTML = optionsHtml;
      if (this.lastSaved.project_name && this.lastSaved.project_name !== WAREHOUSE_PROJECT_NAME) {
        singleProj.value = this.lastSaved.project_name;
      }
    }
    if (bulkProj) {
      bulkProj.innerHTML = optionsHtml;
      if (this.lastSaved.project_name && this.lastSaved.project_name !== WAREHOUSE_PROJECT_NAME) {
        bulkProj.value = this.lastSaved.project_name;
      }
    }

    if (this.lastSaved.panel_index) {
      document.getElementById('manual-preset-index').value = (this.lastSaved.panel_index || 0) + 1;
    }

    document.getElementById('manual-single-presets')?.classList.toggle('hidden', isWarehouse);
    document.getElementById('bulk-preset-fields')?.classList.toggle('hidden', isWarehouse);
    const brandSelector = document.getElementById('manual-brand-selector');
    const brandInput = document.getElementById('manual-panel-brand');
    if (brandSelector) brandSelector.classList.toggle('hidden', !isWarehouse);
    if (brandInput) {
      brandInput.required = isWarehouse;
      brandInput.value = '';
    }
    if (isWarehouse) {
      const bulkStatus = document.getElementById('bulk-preset-status');
      if (bulkStatus) bulkStatus.value = 'warehouse';
    }

    this.switchManualTab('single');
    this.updateWarehouseStockDatalist();
    document.getElementById('modal-manual').classList.remove('hidden');

    const inp = document.getElementById('manual-serial-input');
    inp.value = '';
    setTimeout(() => (isWarehouse ? brandInput : inp)?.focus(), 60);
    this.refreshIcons();
  }

  closeManualEntryModal() {
    document.getElementById('modal-manual').classList.add('hidden');
  }

  switchManualTab(tab) {
    const singleForm = document.getElementById('manual-form-single');
    const bulkForm = document.getElementById('manual-form-bulk');
    const btnSingle = document.getElementById('manual-tab-btn-single');
    const btnBulk = document.getElementById('manual-tab-btn-bulk');

    if (tab === 'single') {
      if (singleForm) singleForm.classList.remove('hidden');
      if (bulkForm) bulkForm.classList.add('hidden');
      if (btnSingle) btnSingle.className = 'flex-1 py-1.5 rounded-lg bg-white text-slate-900 shadow-xs flex items-center justify-center gap-1.5';
      if (btnBulk) btnBulk.className = 'flex-1 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1.5';
      const inp = document.getElementById('manual-serial-input');
      if (inp) setTimeout(() => inp.focus(), 50);
    } else {
      if (singleForm) singleForm.classList.add('hidden');
      if (bulkForm) bulkForm.classList.remove('hidden');
      if (btnBulk) btnBulk.className = 'flex-1 py-1.5 rounded-lg bg-white text-slate-900 shadow-xs flex items-center justify-center gap-1.5';
      if (btnSingle) btnSingle.className = 'flex-1 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1.5';
      const txt = document.getElementById('bulk-paste-input');
      if (txt) setTimeout(() => txt.focus(), 50);
    }
    this.refreshIcons();
  }

  async handleManualSubmit(e) {
    e.preventDefault();
    const serialInput = document.getElementById('manual-serial-input');
    const serial = serialInput.value.trim();
    if (!serial) return;

    const quickSaveCheck = document.getElementById('manual-quick-save');
    const isQuickSave = quickSaveCheck ? quickSaveCheck.checked : false;
    const isWarehouse = this.currentMode === 'warehouse';
    const brandModel = document.getElementById('manual-panel-brand')?.value.trim() || '';
    if (isWarehouse && !brandModel) {
      this.showToast('กรุณาเลือกรุ่นแผงก่อนกรอก SN รับเข้าคลัง', 'warning');
      document.getElementById('manual-panel-brand')?.focus();
      return;
    }
    if (isWarehouse && !appSettings.getWattageForBrand(brandModel)) {
      this.showToast('กรุณาเลือกรุ่นที่บันทึกไว้ เพื่อกำหนดกำลังวัตต์ให้แผง', 'warning');
      document.getElementById('manual-panel-brand')?.focus();
      return;
    }

    if (!isQuickSave) {
      this.closeManualEntryModal();
      this.prepareDataForm(serial, { brandModel });
      return;
    }

    const project = isWarehouse
      ? WAREHOUSE_PROJECT_NAME
      : (document.getElementById('manual-preset-project')?.value || '');
    if (!isWarehouse && !project) {
      this.showToast('กรุณาเลือกโครงการปลายทางก่อนเบิกแผง', 'warning');
      return;
    }
    const indexInput = document.getElementById('manual-preset-index');
    const currentIndex = isWarehouse ? 0 : (parseInt(indexInput?.value, 10) || 1);

    const payload = {
      serial_number: serial,
      project_name: project,
      inverter: '-',
      string_name: '-',
      panel_index: currentIndex,
      status: isWarehouse ? 'warehouse' : 'installed',
      brand_model: isWarehouse ? brandModel : this.getDefaultBrand(),
      wattage: isWarehouse
        ? appSettings.getWattageForBrand(brandModel)
        : this.getDefaultWattage(this.getDefaultBrand()),
      technician_name: this.lastSaved.technician_name || appSettings.getDefaultTechnician() || (isWarehouse ? 'Warehouse staff' : 'Field technician'),
      scanned_mode: this.currentMode || 'manual'
    };

    try {
      if (this.isMockMode) {
        this.saveMockPanel(payload, { requireWarehouseStock: !isWarehouse });
      } else {
        await this.postJson('/api/panels', payload);
      }

      if (!isWarehouse && indexInput) {
        const nextIndex = currentIndex + 1;
        indexInput.value = nextIndex;
        this.lastSaved.panel_index = currentIndex;
      }
      this.lastSaved.project_name = project;

      this.showToast(isWarehouse ? `📦 บันทึกรับเข้าคลัง [${serial}] สำเร็จ!` : `✅ บันทึกแผง #${currentIndex} [${serial}] สำเร็จ!`, 'success');

      serialInput.value = '';
      this.updateWarehouseStockDatalist();
      serialInput.focus();

      if (this.currentView === 'dashboard') {
        this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('บันทึกไม่สำเร็จ: ' + err.message, 'error');
    }
  }

  updateFieldSelectionSummary() {
    const el = document.getElementById('field-selected-stock-count');
    if (!el) return;
    const total = this.pendingFieldBulkSerials.length;
    el.textContent = total ? `${total} แผงที่เลือก` : '0 แผงที่เลือก';
    el.classList.toggle('text-amber-700', total > 0);
    el.classList.toggle('text-slate-500', total === 0);
  }

  async loadFieldStockPanels() {
    let panels;
    if (this.isMockMode) {
      panels = this.getMockPanels();
    } else {
      const result = await this.requestJson('/api/panels?status=warehouse&limit=10000');
      panels = Array.isArray(result.data) ? result.data : [];
    }

    this.fieldStockModalPanels = panels
      .filter(panel => panel && (panel.status === 'warehouse' || panel.project_name === WAREHOUSE_PROJECT_NAME))
      .sort((a, b) => String(a.serial_number || '').localeCompare(String(b.serial_number || '')));

    const modelSelect = document.getElementById('field-stock-model');
    if (modelSelect) {
      const selectedModel = modelSelect.value;
      const modelCounts = new Map();
      this.fieldStockModalPanels.forEach(panel => {
        const model = String(panel.brand_model || '').trim();
        if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
      });
      modelSelect.innerHTML = '<option value="">-- เลือกรุ่นแผง --</option>' +
        [...modelCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, count]) => `<option value="${this.escapeHtml(model)}">${this.escapeHtml(model)} (${count} แผง)</option>`)
          .join('');
      if (modelCounts.has(selectedModel)) modelSelect.value = selectedModel;
    }
  }

  async openFieldStockSelectorModal() {
    const modal = document.getElementById('modal-field-stock-select');
    if (!modal) return;

    const modelSelect = document.getElementById('field-stock-model');
    if (!modelSelect?.value) {
      this.showToast('กรุณาเลือกรุ่นแผงก่อนเลือก SN / Code', 'warning');
      modelSelect?.focus();
      return;
    }

    const list = document.getElementById('field-stock-modal-list');
    const emptyState = document.getElementById('field-stock-modal-empty');
    const searchInput = document.getElementById('field-stock-search');
    if (!list) return;

    try {
      await this.loadFieldStockPanels();
    } catch (error) {
      console.error('Unable to load stock list for field issue-out selector:', error);
      this.showToast(`โหลด SN ในสต๊อกไม่สำเร็จ: ${error.message}`, 'error');
      return;
    }

    if (!this.fieldStockModalSelectionInitialized) {
      this.fieldStockModalSelectedSerials = new Set(this.pendingFieldBulkSerials);
      this.fieldStockModalSelectionInitialized = true;
    }

    if (!this.fieldStockModalPanels.length) {
      list.innerHTML = '<div class="p-4 text-xs text-slate-500 text-center">ไม่มีแผงในคลังให้เลือก</div>';
      if (emptyState) emptyState.classList.add('hidden');
      if (searchInput) searchInput.value = '';
      modal.classList.remove('hidden');
      this.refreshIcons();
      return;
    }

    if (searchInput) searchInput.value = '';
    this.renderFieldStockModal();
    modal.classList.remove('hidden');
  }

  renderFieldStockModal() {
    const list = document.getElementById('field-stock-modal-list');
    const emptyState = document.getElementById('field-stock-modal-empty');
    const searchInput = document.getElementById('field-stock-search');
    if (!list || !Array.isArray(this.fieldStockModalPanels)) return;

    const query = (searchInput?.value || '').trim().toLowerCase();
    const selectedModel = document.getElementById('field-stock-model')?.value || '';
    const matchingModelPanels = this.fieldStockModalPanels.filter(panel =>
      String(panel.brand_model || '').trim().toLowerCase() === selectedModel.toLowerCase()
    );
    const visiblePanels = query
      ? matchingModelPanels.filter(panel => {
          const serial = String(panel.serial_number || '').trim().toLowerCase();
          const brand = String(panel.brand_model || '').trim().toLowerCase();
          const wattage = String(panel.wattage || '').trim().toLowerCase();
          return serial.includes(query) || brand.includes(query) || wattage.includes(query);
        })
      : matchingModelPanels;

    list.innerHTML = visiblePanels.map(panel => {
      const serial = String(panel.serial_number || '').trim();
      const brand = panel.brand_model || 'ไม่ระบุรุ่น';
      const wattage = panel.wattage ? `${panel.wattage} Wp` : '-';
      const checked = this.fieldStockModalSelectedSerials.has(serial) ? 'checked' : '';
      return `
        <label class="field-stock-item flex items-center justify-between gap-3 w-full p-2.5 rounded-xl border border-slate-200 hover:border-amber-300 hover:bg-amber-50 transition cursor-pointer" data-search="${this.escapeHtml(`${serial} ${brand} ${wattage}`.toLowerCase())}">
          <div class="flex items-center gap-3 min-w-0">
            <input type="checkbox" data-serial="${this.escapeHtml(serial)}" ${checked} onchange="app.toggleFieldStockModalSelection(this)" class="h-4 w-4 text-amber-500 rounded border-slate-300 focus:ring-amber-400">
            <div class="min-w-0">
              <div class="text-[11px] font-bold text-slate-900 font-mono truncate">${this.escapeHtml(serial)}</div>
              <div class="text-[10px] text-slate-500 truncate">${this.escapeHtml(brand)} • ${this.escapeHtml(wattage)}</div>
            </div>
          </div>
          <span class="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full">In Stock</span>
        </label>
      `;
    }).join('');

    if (emptyState) {
      const hasVisible = visiblePanels.length > 0;
      emptyState.classList.toggle('hidden', hasVisible);
      if (!hasVisible) {
        list.innerHTML = '';
      }
    }

    this.updateFieldStockModalSelectionCount();
    this.refreshIcons();
  }

  toggleFieldStockModalSelection(checkbox) {
    const serial = String(checkbox?.dataset.serial || '').trim();
    if (!serial) return;
    if (checkbox.checked) this.fieldStockModalSelectedSerials.add(serial);
    else this.fieldStockModalSelectedSerials.delete(serial);
    this.updateFieldStockModalSelectionCount();
  }

  updateFieldStockModalSelectionCount() {
    const count = document.getElementById('field-stock-modal-selected-count');
    if (count) count.textContent = `${this.fieldStockModalSelectedSerials.size} แผงที่เลือก`;
  }

  filterFieldStockModal() {
    this.renderFieldStockModal();
  }

  applyFieldStockSelection() {
    const modal = document.getElementById('modal-field-stock-select');
    const selected = [...this.fieldStockModalSelectedSerials];

    if (!selected.length) {
      this.showToast('กรุณาเลือกแผงจากคลังอย่างน้อย 1 รายการ', 'warning');
      return;
    }

    this.pendingFieldBulkSerials = selected;
    this.updateFieldSelectionSummary();
    const serialField = this.getFormElement('input-serial');
    if (serialField) serialField.value = selected.join('\n');
    const saveBtn = this.getFormElement('btn-save-panel');
    if (saveBtn) saveBtn.disabled = false;
    modal.classList.add('hidden');
    this.showToast(`เลือกแผงจากคลัง ${selected.length} รายการ พร้อมสำหรับเบิกไปหน้างาน`, 'success');
  }

  closeFieldStockSelectorModal() {
    const modal = document.getElementById('modal-field-stock-select');
    if (modal) modal.classList.add('hidden');
  }

  updateBulkPasteCount() {
    const raw = document.getElementById('bulk-paste-input').value;
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    document.getElementById('bulk-paste-count').textContent = lines.length;
  }

  async handleBulkPasteSubmit(e) {
    e.preventDefault();
    const raw = document.getElementById('bulk-paste-input').value;
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      this.showToast('กรุณาวางรายการ Serial Number อย่างน้อย 1 รายการ', 'warning');
      return;
    }

    const isWarehouse = this.currentMode === 'warehouse';
    const brandModel = document.getElementById('manual-panel-brand')?.value.trim() || '';
    if (isWarehouse && !brandModel) {
      this.showToast('กรุณาเลือกรุ่นแผงก่อนวางรายการ SN รับเข้าคลัง', 'warning');
      document.getElementById('manual-panel-brand')?.focus();
      return;
    }
    if (isWarehouse && !appSettings.getWattageForBrand(brandModel)) {
      this.showToast('กรุณาเลือกรุ่นที่บันทึกไว้ เพื่อกำหนดกำลังวัตต์ให้แผง', 'warning');
      document.getElementById('manual-panel-brand')?.focus();
      return;
    }
    const project = isWarehouse ? WAREHOUSE_PROJECT_NAME : document.getElementById('bulk-preset-project').value;
    if (!isWarehouse && !project) {
      this.showToast('กรุณาเลือกโครงการปลายทางก่อนบันทึก', 'warning');
      return;
    }
    const status = isWarehouse ? 'warehouse' : document.getElementById('bulk-preset-status').value;

    const btn = document.getElementById('btn-submit-bulk-paste');
    btn.disabled = true;
    btn.innerHTML = `กำลังบันทึก ${lines.length} แผง...`;

    const panelsToCreate = lines.map((serial, idx) => ({
      serial_number: serial,
      project_name: project,
      inverter: '-',
      string_name: '-',
      panel_index: isWarehouse ? 0 : idx + 1,
      brand_model: isWarehouse ? brandModel : this.getDefaultBrand(),
      wattage: isWarehouse
        ? appSettings.getWattageForBrand(brandModel)
        : this.getDefaultWattage(this.getDefaultBrand()),
      status: status,
      technician_name: appSettings.getDefaultTechnician() || 'Bulk import',
      notes: `นำเข้าพร้อมกัน ${lines.length} แผง`,
      scanned_mode: 'bulk-paste'
    }));

    try {
      if (this.isMockMode) {
        if (!isWarehouse) {
          const stock = this.getMockPanels();
          const serials = new Set();
          for (const panel of panelsToCreate) {
            const key = panel.serial_number.toLowerCase();
            if (serials.has(key)) throw new Error(`พบ SN ${panel.serial_number} ซ้ำในรายการเบิก`);
            serials.add(key);
            const current = stock.find(item => item.serial_number.toLowerCase() === key);
            if (!current) throw new Error(`ไม่พบ SN ${panel.serial_number} ในคลังสินค้า กรุณารับเข้าสต๊อกก่อนเบิกไปหน้างาน`);
            if (current.status !== 'warehouse') {
              throw new Error(`SN ${panel.serial_number} ถูกเบิกไปแล้วที่ ${current.project_name} (สถานะ: ${this.translateStatus(current.status)})`);
            }
          }
        }
        panelsToCreate.forEach(panel => this.saveMockPanel(panel, { requireWarehouseStock: !isWarehouse }));
      } else {
        await this.importPanels(panelsToCreate, { requireWarehouseStock: !isWarehouse });
      }

      this.closeManualEntryModal();
      this.showToast(`🎉 บันทึกแผงโซลาร์สำเร็จรวดเดียว ${lines.length} แผง!`, 'success');
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      } else if (this.currentView === 'database') {
        await this.loadDatabaseStudioData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> บันทึกทั้งหมดรวดเดียว`;
      this.refreshIcons();
    }
  }

  editPanelBySerial(serial) {
    this.prepareDataForm(serial);
  }

  // ---------------- Export CSV ----------------

  exportCsv() {
    if (this.isMockMode) {
      const data = this.getMockPanels();
      const headers = ['Serial Number', 'Project', 'Inverter', 'String', 'Index', 'Brand', 'Wattage', 'Status', 'Technician', 'Notes'];
      const rows = data.map(p => [
        `"${p.serial_number}"`,
        `"${p.project_name}"`,
        `"${p.inverter || ''}"`,
        `"${p.string_name || ''}"`,
        p.panel_index,
        `"${p.brand_model || ''}"`,
        p.wattage,
        `"${p.status}"`,
        `"${p.technician_name || ''}"`,
        `"${(p.notes || '').replace(/"/g, '""')}"`
      ].join(','));
      const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `solar_panels_local_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('ดาวน์โหลด CSV จาก Local DB สำเร็จ', 'success');
    } else {
      window.location.href = '/api/export/csv';
    }
  }

  async getProjectPanelsForExport(projectName) {
    let panels;
    if (this.isMockMode) {
      panels = this.getMockPanels().filter(panel => panel.project_name === projectName);
    } else {
      const query = new URLSearchParams({ project: projectName, limit: '50000' });
      const response = await fetch(`/api/panels?${query.toString()}`);
      const result = await response.json();
      if (!response.ok || result.success === false) {
        throw new Error(result.error || `โหลดข้อมูลโครงการไม่สำเร็จ (HTTP ${response.status})`);
      }
      panels = result.data || [];
    }
    return panels.sort((a, b) =>
      String(a.inverter || '').localeCompare(String(b.inverter || ''), 'th') ||
      String(a.string_name || '').localeCompare(String(b.string_name || ''), 'th') ||
      (Number(a.panel_index) || 0) - (Number(b.panel_index) || 0) ||
      String(a.serial_number || '').localeCompare(String(b.serial_number || ''), 'en')
    );
  }

  async exportProjectExcel(projectName) {
    if (!projectName) {
      this.showToast('ไม่พบชื่อโครงการสำหรับส่งออก', 'error');
      return;
    }

    try {
      const panels = await this.getProjectPanelsForExport(projectName);

      const models = new Map();
      panels.forEach(panel => {
        const model = panel.brand_model || 'ไม่ระบุรุ่น';
        const summary = models.get(model) || { count: 0, wattages: new Set() };
        summary.count++;
        summary.wattages.add(Number(panel.wattage) || 0);
        models.set(model, summary);
      });

      const modelRows = Array.from(models, ([model, summary]) => `
        <tr><td>${this.escapeHtml(model)}</td><td class="number">${summary.count}</td><td class="number">${Array.from(summary.wattages).sort((a, b) => a - b).join(' / ')} Wp</td></tr>
      `).join('');
      const panelRows = panels.map((panel, index) => `
        <tr>
          <td class="number">${index + 1}</td>
          <td class="serial">${this.escapeHtml(panel.serial_number || '')}</td>
          <td>${this.escapeHtml(panel.brand_model || 'ไม่ระบุรุ่น')}</td>
          <td class="number">${Number(panel.wattage) || 0}</td>
          <td class="serial">${this.escapeHtml(panel.inverter || '-')}</td>
          <td class="serial">${this.escapeHtml(panel.string_name || '-')}</td>
          <td>${this.escapeHtml(this.translateStatus(panel.status))}</td>
        </tr>
      `).join('');

      const exportedAt = new Date();
      const panelHeaderRow = 9 + models.size;
      const panelLastRow = panelHeaderRow + Math.max(panels.length, 1);
      const report = `<!DOCTYPE html>
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
        <head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>รายงานแผง</x:Name><x:WorksheetOptions><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>${panelHeaderRow}</x:SplitHorizontal><x:TopRowBottomPane>${panelHeaderRow}</x:TopRowBottomPane><x:AutoFilter x:Range="R${panelHeaderRow}C1:R${panelLastRow}C7"/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
        <style>
          body{font-family:Tahoma,Arial,sans-serif;color:#1e293b}
          table{border-collapse:collapse;width:100%;margin-bottom:18px}
          td,th{border:1px solid #dbe3ee;padding:8px 10px;font-size:10pt}
          .title{background:#0f172a;color:#fff;font-size:18pt;font-weight:bold;padding:16px}
          .subtitle{background:#1e293b;color:#cbd5e1;padding:8px 12px}
          .section{background:#f1f5f9;color:#0f172a;font-weight:bold;font-size:12pt;padding:10px}
          .label{background:#f8fafc;color:#64748b;font-weight:bold;width:18%}
          .value{font-weight:bold}
          .column-head{background:#0f766e;color:#fff;font-weight:bold}
          .number{text-align:right;mso-number-format:"0"}
          .serial{mso-number-format:"\\@"}
          .stripe{background:#f8fafc}
        </style></head>
        <body>
          <table>
            <tr><td colspan="3" class="title">รายงานแผงโซลาร์เซลล์ประจำโครงการ</td></tr>
            <tr><td colspan="3" class="subtitle">SolarTrack · ส่งออกเมื่อ ${this.escapeHtml(exportedAt.toLocaleString('th-TH'))}</td></tr>
            <tr><td class="label">โครงการ</td><td colspan="2" class="value">${this.escapeHtml(projectName)}</td></tr>
            <tr><td class="label">จำนวนแผง</td><td colspan="2" class="value">${panels.length.toLocaleString('th-TH')} แผง</td></tr>
            <tr><td class="label">จำนวนรุ่น</td><td colspan="2" class="value">${models.size.toLocaleString('th-TH')} รุ่น</td></tr>
            <tr><td colspan="3" class="section">สรุปยี่ห้อ / รุ่นแผง</td></tr>
            <tr class="column-head"><th>ยี่ห้อ / รุ่น</th><th>จำนวนแผง</th><th>กำลังต่อแผง</th></tr>
            ${modelRows || '<tr><td colspan="3">ยังไม่มีแผงในโครงการนี้</td></tr>'}
            <tr><td colspan="7" class="section">รายการ SN และข้อมูลแผง</td></tr>
            <tr class="column-head"><th>ลำดับ</th><th>Serial Number (SN)</th><th>ยี่ห้อ / รุ่น</th><th>กำลัง (Wp)</th><th>Inverter</th><th>String</th><th>สถานะ</th></tr>
            ${panelRows || '<tr><td colspan="7">ยังไม่มีรายการแผง</td></tr>'}
          </table>
        </body></html>`;

      const blob = new Blob(['\uFEFF', report], { type: 'application/vnd.ms-excel;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeName = projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\s+/g, '_') || 'project';
      link.href = url;
      link.download = `SolarTrack_${safeName}_${exportedAt.toISOString().slice(0, 10)}.xls`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.showToast(`ส่งออกรายงานโครงการ ${projectName} (${panels.length} แผง) เรียบร้อย`, 'success');
    } catch (error) {
      console.error('Project Excel export failed:', error);
      this.showToast(`ส่งออกรายงานไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  async exportProjectPdf(projectName) {
    if (!projectName) {
      this.showToast('ไม่พบชื่อโครงการสำหรับส่งออก', 'error');
      return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      this.showToast('เบราว์เซอร์บล็อกหน้าต่าง PDF กรุณาอนุญาตป๊อปอัปแล้วลองอีกครั้ง', 'warning');
      return;
    }

    printWindow.document.write('<!doctype html><html lang="th"><head><meta charset="utf-8"><title>กำลังเตรียมรายงาน</title></head><body style="font-family:sans-serif;padding:24px">กำลังเตรียมรายงาน PDF...</body></html>');
    printWindow.document.close();

    try {
      const panels = await this.getProjectPanelsForExport(projectName);
      const exportedAt = new Date();
      const safeName = projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\s+/g, '_') || 'project';
      const rows = panels.map((panel, index) => `
        <tr>
          <td class="number">${index + 1}</td>
          <td class="serial">${this.escapeHtml(panel.serial_number || '')}</td>
          <td>${this.escapeHtml(panel.brand_model || 'ไม่ระบุรุ่น')}</td>
          <td class="number">${Number(panel.wattage) || 0}</td>
          <td>${this.escapeHtml(this.translateStatus(panel.status))}</td>
        </tr>`).join('');

      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="th"><head><meta charset="utf-8"><title>SolarTrack_${this.escapeHtml(safeName)}_${exportedAt.toISOString().slice(0, 10)}</title>
        <style>
          @page{size:A4 portrait;margin:14mm}
          *{box-sizing:border-box}
          body{font-family:Tahoma,Arial,sans-serif;color:#172033;font-size:10pt;margin:0}
          h1{font-size:18pt;margin:0 0 5px}
          .meta{color:#64748b;font-size:9pt;margin-bottom:16px}
          .summary{display:flex;gap:10px;margin-bottom:18px}
          .summary div{border:1px solid #cbd5e1;border-radius:6px;padding:9px 12px;min-width:150px}
          .summary span{display:block;color:#64748b;font-size:8pt;margin-bottom:3px}
          .summary strong{font-size:13pt}
          table{width:100%;border-collapse:collapse}
          th,td{border:1px solid #cbd5e1;padding:6px 7px;text-align:left}
          th{background:#e2e8f0;font-weight:bold}
          tbody tr:nth-child(even){background:#f8fafc}
          .number{text-align:right;white-space:nowrap}
          .serial{font-family:Consolas,monospace;white-space:nowrap}
          thead{display:table-header-group}
          tr{break-inside:avoid}
          .empty{text-align:center;color:#64748b;padding:20px}
          @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
        </style></head><body>
          <h1>รายงานแผงโซลาร์เซลล์ประจำโครงการ</h1>
          <div class="meta">โครงการ: <strong>${this.escapeHtml(projectName)}</strong> · ส่งออกเมื่อ ${this.escapeHtml(exportedAt.toLocaleString('th-TH'))}</div>
          <div class="summary"><div><span>จำนวนแผง</span><strong>${panels.length.toLocaleString('th-TH')} แผง</strong></div><div><span>จำนวนรุ่น</span><strong>${new Set(panels.map(panel => panel.brand_model || 'ไม่ระบุรุ่น')).size.toLocaleString('th-TH')} รุ่น</strong></div></div>
          <table><thead><tr><th>ลำดับ</th><th>Serial Number (SN)</th><th>ยี่ห้อ / รุ่น</th><th>กำลัง (Wp)</th><th>สถานะ</th></tr></thead>
          <tbody>${rows || '<tr><td class="empty" colspan="5">ยังไม่มีข้อมูลแผงในโครงการนี้</td></tr>'}</tbody></table>
        </body></html>`);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 400);
      this.showToast(`เตรียมรายงาน PDF โครงการ ${projectName} แล้ว เลือกบันทึกเป็น PDF ในหน้าต่างพิมพ์`, 'success');
    } catch (error) {
      printWindow.close();
      console.error('Project PDF export failed:', error);
      this.showToast(`ส่งออกรายงาน PDF ไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  // ---------------- Helpers & Utilities ----------------

  getPanelLocationLabel(panel) {
    if (panel.status === 'warehouse') return 'คลังสินค้ากลาง (สต๊อก)';
    return panel.project_name === WAREHOUSE_PROJECT_NAME
      ? 'ไม่ระบุหน้างาน'
      : (panel.project_name || '-');
  }

  translateStatus(status) {
    switch (status) {
      case 'warehouse': return 'ในคลังสินค้า';
      case 'installing': return 'กำลังติดตั้ง';
      case 'installed': return 'ติดตั้งแล้ว';
      case 'damaged': return 'ชำรุด / เคลม';
      default: return status || '-';
    }
  }

  getStatusBadgeClass(status) {
    switch (status) {
      case 'warehouse': return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
      case 'installing': return 'bg-blue-100 text-blue-800 border border-blue-200';
      case 'installed': return 'bg-purple-100 text-purple-800 border border-purple-200';
      case 'damaged': return 'bg-rose-100 text-rose-800 border border-rose-200';
      default: return 'bg-slate-100 text-slate-800';
    }
  }

  formatDateTime(isoString) {
    if (!isoString) return '-';
    try {
      const d = this.parsePanelDate(isoString);
      if (Number.isNaN(d.getTime())) return '-';
      return d.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        day: '2-digit',
        month: 'short',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
  }

  parsePanelDate(value) {
    if (!value) return new Date(NaN);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    return new Date(normalized);
  }

  getBangkokDateKey(value) {
    const date = this.parsePanelDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const titles = {
      success: 'ดำเนินการสำเร็จ',
      error: 'เกิดข้อผิดพลาด',
      warning: 'กรุณาตรวจสอบ',
      info: 'แจ้งเตือน'
    };
    let icon = 'info';

    if (type === 'success') {
      icon = 'check-circle';
    } else if (type === 'error') {
      icon = 'alert-triangle';
    } else if (type === 'warning') {
      icon = 'alert-circle';
    }

    toast.className = `app-toast app-toast-${type} app-toast-enter`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    const iconWrap = document.createElement('span');
    iconWrap.className = 'app-toast-icon';
    iconWrap.innerHTML = `<i data-lucide="${icon}"></i>`;
    const content = document.createElement('span');
    content.className = 'app-toast-content';
    const title = document.createElement('strong');
    title.textContent = titles[type] || titles.info;
    const text = document.createElement('span');
    text.textContent = message;
    content.append(title, text);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-toast-close';
    close.setAttribute('aria-label', 'ปิดการแจ้งเตือน');
    close.innerHTML = '<i data-lucide="x"></i>';
    close.addEventListener('click', () => dismiss());
    toast.append(iconWrap, content, close);

    container.appendChild(toast);
    this.refreshIcons();

    requestAnimationFrame(() => toast.classList.remove('app-toast-enter'));
    const dismiss = () => {
      if (!toast.isConnected) return;
      toast.classList.add('app-toast-exit');
      setTimeout(() => toast.remove(), 220);
    };
    const timeout = setTimeout(dismiss, 4200);
    close.addEventListener('click', () => clearTimeout(timeout), { once: true });
  }

  confirmAction({ title, message, confirmText = 'ยืนยัน', tone = 'danger' }) {
    if (this.pendingConfirmation) this.finishConfirmation(false);
    const modal = document.getElementById('action-confirm-modal');
    const titleEl = document.getElementById('action-confirm-title');
    const messageEl = document.getElementById('action-confirm-message');
    const confirmButton = document.getElementById('action-confirm-submit');
    if (!modal || !titleEl || !messageEl || !confirmButton) {
      return Promise.reject(new Error('ไม่พบหน้าต่างยืนยันการทำรายการ'));
    }

    this.confirmationReturnFocus = document.activeElement;
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmButton.textContent = confirmText;
    confirmButton.className = `action-confirm-submit ${tone === 'danger' ? 'action-confirm-danger' : 'action-confirm-primary'}`;
    modal.classList.remove('hidden');
    this.refreshIcons();

    return new Promise(resolve => {
      this.pendingConfirmation = resolve;
      confirmButton.focus();
    });
  }

  finishConfirmation(confirmed) {
    if (!this.pendingConfirmation) return;
    const resolve = this.pendingConfirmation;
    this.pendingConfirmation = null;
    document.getElementById('action-confirm-modal')?.classList.add('hidden');
    if (this.confirmationReturnFocus instanceof HTMLElement && this.confirmationReturnFocus.isConnected) {
      this.confirmationReturnFocus.focus();
    }
    this.confirmationReturnFocus = null;
    resolve(confirmed);
  }

  // ==========================================
  // DATABASE STUDIO (DATABASE MANAGEMENT VIEW)
  // ==========================================

  showDbTab(tabName) {
    this.showView('database');
    this.switchDbTab(tabName);
  }

  openProjectManagement() {
    this.dbCurrentTab = 'projects';
    this.showView('database');
  }

  switchDbTab(tabName) {
    this.dbCurrentTab = tabName;
    const tabs = ['records', 'projects', 'tools'];

    tabs.forEach(t => {
      const pane = document.getElementById(`db-tab-${t}`);
      const btn = document.getElementById(`tab-btn-${t}`);
      if (pane) {
        if (t === tabName) {
          pane.classList.remove('hidden');
        } else {
          pane.classList.add('hidden');
        }
      }
      if (btn) {
        if (t === tabName) {
          btn.className = 'px-3.5 py-2 rounded-xl bg-slate-900 text-white flex items-center gap-1.5 transition shrink-0';
        } else {
          btn.className = 'px-3.5 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 flex items-center gap-1.5 transition shrink-0';
        }
      }
    });

    this.updateNavButtons(this.currentView);

    this.refreshIcons();

    if (tabName === 'records') {
      this.loadDbRecords();
    } else if (tabName === 'projects') {
      this.loadDbProjects();
    }
  }

  async loadDatabaseStudioData() {
    try {
      let info = null;
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        info = {
          engine: 'Local Storage (Mock DB)',
          fileName: 'localStorage.solartrack_panels',
          fileSizeFormatted: (JSON.stringify(panels).length / 1024).toFixed(2) + ' KB',
          lastModified: new Date().toISOString(),
          stats: {
            total: panels.length,
            installed: panels.filter(p => p.status === 'installed').length
          }
        };
      } else {
        try {
          const res = await fetch('/api/database/info');
          if (res.ok) {
            const json = await res.json();
            info = json.info;
          }
        } catch (fetchErr) {
          console.warn('API /database/info not found or failed, falling back to /api/stats');
        }

        if (!info) {
          try {
            const statsRes = await fetch('/api/stats');
            if (statsRes.ok) {
              const statsJson = await statsRes.json();
              info = {
                engine: 'SQLite (solar_panels.db)',
                fileName: 'solar_panels.db',
                fileSizeFormatted: 'คำนวณจาก API',
                lastModified: new Date().toISOString(),
                stats: statsJson.stats || { total: 0, installed: 0 }
              };
              this.showToast('💡 เพื่อเปิดใช้งานฟังก์ชันเต็ม กรุณา Restart เซิร์ฟเวอร์', 'info');
            }
          } catch (e2) {}
        }
      }

      if (info) {
        const engineBadge = document.getElementById('db-engine-badge');
        if (engineBadge) engineBadge.textContent = info.engine;
        document.getElementById('db-metric-total').textContent = (info.stats.total || 0).toLocaleString();
        document.getElementById('db-metric-size').textContent = info.fileSizeFormatted || '0 KB';
        document.getElementById('db-metric-installed').textContent = (info.stats.installed || 0).toLocaleString();
        document.getElementById('db-metric-time').textContent = this.formatDateTime(info.lastModified);
      }

      await this.populateDbProjectDropdowns();
      this.switchDbTab(this.dbCurrentTab || 'records');
    } catch (e) {
      console.warn('Error loading DB studio data:', e);
    }
  }

  async populateDbProjectDropdowns() {
    let projects = [];
    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        const savedProjects = this.getMockProjects().map(project => project.name);
        const panelProjects = panels
          .filter(p => p.status !== 'warehouse' && p.project_name !== WAREHOUSE_PROJECT_NAME)
          .map(p => p.project_name);
        projects = Array.from(new Set([...savedProjects, ...panelProjects])).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        const json = await res.json();
        projects = json.projects || [];
      }
    } catch (e) {
      projects = [];
    }

    const filterSelect = document.getElementById('db-filter-project');
    const batchSelect = document.getElementById('batch-project-select');
    const editSelect = document.getElementById('edit-project');
    const equipmentProjectOptions = document.getElementById('equipment-project-options');
    const dongleProjectSelect = document.getElementById('dongle-issue-project');

    const optionsHtml = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');

    if (filterSelect) {
      filterSelect.innerHTML = `<option value="all">ทุกโครงการ (${projects.length})</option>` + optionsHtml;
    }
    if (batchSelect) {
      batchSelect.innerHTML = `<option value="">-- เลือกโครงการปลายทาง --</option>` + optionsHtml;
    }
    if (editSelect) {
      editSelect.innerHTML = optionsHtml;
    }
    if (equipmentProjectOptions) equipmentProjectOptions.innerHTML = optionsHtml;
    if (dongleProjectSelect) {
      dongleProjectSelect.innerHTML = `<option value="">-- เลือกโครงการ --</option>` + optionsHtml;
    }
  }

  async loadEquipmentData() {
    try {
      if (this.isMockMode) {
        this.equipmentCatalog = JSON.parse(localStorage.getItem('solartrack_equipment_catalog') || '[]');
        this.equipmentIssues = JSON.parse(localStorage.getItem('solartrack_equipment_issues') || '[]');
      } else {
        const [catalogResult, issueResult] = await Promise.all([
          this.requestJson('/api/equipment'),
          this.requestJson('/api/equipment/issues')
        ]);
        this.equipmentCatalog = catalogResult.equipment || [];
        this.equipmentIssues = issueResult.issues || [];
      }

      this.renderEquipmentCatalog();
      this.renderEquipmentIssues();
      const lineContainer = document.getElementById('equipment-issue-lines');
      if (!document.getElementById('equipment-issue-id')?.value && lineContainer && !lineContainer.children.length) {
        this.renderEquipmentIssueLines([{}]);
      }
      const dateInput = document.getElementById('equipment-issue-date');
      if (dateInput && !dateInput.value) dateInput.value = this.getLocalDateInputValue();
      const issuedByInput = document.getElementById('equipment-issue-by');
      if (issuedByInput && !issuedByInput.value) issuedByInput.value = appSettings.getDefaultTechnician() || '';
      const dongleIssueDate = document.getElementById('dongle-issue-date');
      if (dongleIssueDate && !dongleIssueDate.value) dongleIssueDate.value = this.getLocalDateInputValue();
      const dongleIssueBy = document.getElementById('dongle-issue-by');
      if (dongleIssueBy && !dongleIssueBy.value) dongleIssueBy.value = appSettings.getDefaultTechnician() || '';
    } catch (error) {
      console.error('Unable to load equipment data:', error);
      this.showToast(`โหลดข้อมูลอุปกรณ์ไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  async loadDongleData() {
    try {
      if (this.isMockMode) {
        this.dongles = JSON.parse(localStorage.getItem('solartrack_dongles') || '[]');
      } else {
        const result = await this.requestJson('/api/dongles');
        this.dongles = result.dongles || [];
      }

      this.renderDongleInventory();
      const issueDate = document.getElementById('dongle-issue-date');
      if (issueDate && !issueDate.value) issueDate.value = this.getLocalDateInputValue();
      const issueBy = document.getElementById('dongle-issue-by');
      if (issueBy && !issueBy.value) issueBy.value = appSettings.getDefaultTechnician() || '';
    } catch (error) {
      console.error('Unable to load dongle inventory:', error);
      this.showToast(`โหลดสต๊อกดองเกิ้ลไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  getLocalDateInputValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  renderDongleInventory() {
    const container = document.getElementById('dongle-inventory-list');
    const dongleSelect = document.getElementById('dongle-issue-item');
    if (!container || !dongleSelect) return;

    const inStock = this.dongles.filter(dongle => dongle.status === 'warehouse');
    dongleSelect.innerHTML = `<option value="">${inStock.length ? '-- เลือกดองเกิ้ล --' : 'ไม่มีดองเกิ้ลในสต๊อก'}</option>` +
      inStock.map(dongle => `<option value="${Number(dongle.id)}">${this.escapeHtml(dongle.serial_number)} (${this.escapeHtml(dongle.model)})</option>`).join('');
    dongleSelect.disabled = inStock.length === 0;

    if (!this.dongles.length) {
      container.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">ยังไม่มีดองเกิ้ลในสต๊อก</div>';
      return;
    }

    const rows = this.dongles.map(dongle => {
      const isInStock = dongle.status === 'warehouse';
      return `
        <tr class="border-b border-slate-100 last:border-0">
          <td class="px-4 py-3 text-xs font-mono font-semibold text-slate-800">${this.escapeHtml(dongle.serial_number)}</td>
          <td class="px-4 py-3 text-xs text-slate-700">${this.escapeHtml(dongle.model)}</td>
          <td class="px-4 py-3">
            <span class="rounded-full px-2 py-1 text-[10px] font-bold ${isInStock ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}">${isInStock ? 'ในสต๊อก' : 'เบิกแล้ว'}</span>
          </td>
          <td class="px-4 py-3 text-xs text-slate-700">${this.escapeHtml(dongle.project_name || '-')}</td>
          <td class="px-4 py-3 text-xs text-slate-700">${this.escapeHtml(dongle.responsible || '-')}</td>
          <td class="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">${this.escapeHtml(dongle.issued_at || '-')}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            ${isInStock ? '-' : `<button type="button" onclick="app.returnDongleToStock(${Number(dongle.id)})" class="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">คืนเข้าสต๊อก</button>`}
          </td>
        </tr>`;
    }).join('');
    container.innerHTML = `
      <table class="w-full min-w-[760px] text-left">
        <thead class="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-4 py-3">Serial Number</th>
            <th class="px-4 py-3">รุ่น</th>
            <th class="px-4 py-3">สถานะ</th>
            <th class="px-4 py-3">โครงการล่าสุด</th>
            <th class="px-4 py-3">ผู้รับผิดชอบล่าสุด</th>
            <th class="px-4 py-3">วันที่เบิกล่าสุด</th>
            <th class="px-4 py-3 text-right">จัดการ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
    this.refreshIcons();
  }

  async addDonglesToStock(event) {
    event.preventDefault();
    const model = document.getElementById('dongle-model').value.trim();
    const serials = document.getElementById('dongle-serials').value
      .split(/\r?\n/).map(serial => serial.trim()).filter(Boolean);
    if (!model || !serials.length) {
      this.showToast('กรุณาระบุรุ่นและ Serial Number อย่างน้อย 1 รายการ', 'warning');
      return;
    }
    const seen = new Set();
    for (const serial of serials) {
      const key = serial.toLowerCase();
      if (seen.has(key)) {
        this.showToast(`พบ SN ${serial} ซ้ำในรายการ`, 'error');
        return;
      }
      seen.add(key);
    }

    try {
      if (this.isMockMode) {
        const existing = new Set(this.dongles.map(dongle => dongle.serial_number.toLowerCase()));
        const duplicate = serials.find(serial => existing.has(serial.toLowerCase()));
        if (duplicate) throw new Error(`SN ${duplicate} มีในสต๊อกแล้ว`);
        const now = new Date().toISOString();
        serials.forEach((serial, index) => this.dongles.push({
          id: Date.now() + index,
          serial_number: serial,
          model,
          status: 'warehouse',
          project_name: '',
          responsible: '',
          issued_at: '',
          created_at: now,
          updated_at: now
        }));
        localStorage.setItem('solartrack_dongles', JSON.stringify(this.dongles));
      } else {
        await this.requestJson('/api/dongles/import', {
          method: 'POST',
          body: { dongles: serials.map(serial_number => ({ serial_number, model })) }
        });
      }
      document.getElementById('dongle-stock-form').reset();
      await this.loadDongleData();
      this.showToast(`รับดองเกิ้ลเข้าสต๊อก ${serials.length} รายการแล้ว`, 'success');
    } catch (error) {
      this.showToast(`บันทึกรับดองเกิ้ลไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  async issueDongleFromStock(event) {
    event.preventDefault();
    const id = document.getElementById('dongle-issue-item').value;
    const payload = {
      project_name: document.getElementById('dongle-issue-project').value,
      responsible: document.getElementById('dongle-issue-by').value.trim(),
      issued_at: document.getElementById('dongle-issue-date').value
    };
    if (!id || !payload.project_name || !payload.responsible || !payload.issued_at) {
      this.showToast('กรุณาเลือก SN และกรอกโครงการ ผู้รับผิดชอบ และวันที่ให้ครบ', 'warning');
      return;
    }

    try {
      if (this.isMockMode) {
        const dongle = this.dongles.find(item => String(item.id) === id);
        if (!dongle) throw new Error('ไม่พบข้อมูลดองเกิ้ล');
        if (dongle.status !== 'warehouse') throw new Error(`SN ${dongle.serial_number} ถูกเบิกไปแล้ว`);
        Object.assign(dongle, payload, { status: 'issued', updated_at: new Date().toISOString() });
        localStorage.setItem('solartrack_dongles', JSON.stringify(this.dongles));
      } else {
        await this.requestJson(`/api/dongles/${encodeURIComponent(id)}/issue`, {
          method: 'PUT',
          body: payload
        });
      }
      document.getElementById('dongle-issue-item').value = '';
      await this.loadDongleData();
      this.showToast('บันทึกการเบิกดองเกิ้ลแล้ว', 'success');
    } catch (error) {
      this.showToast(`เบิกดองเกิ้ลไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  async returnDongleToStock(id) {
    const dongle = this.dongles.find(item => Number(item.id) === Number(id));
    if (!dongle || !await this.confirmAction({
      title: 'ยืนยันคืนดองเกิ้ลเข้าสต๊อก',
      message: `คืน SN ${dongle?.serial_number || ''} เข้าสต๊อกหรือไม่? ข้อมูลการเบิกล่าสุดจะยังแสดงอยู่`,
      confirmText: 'คืนเข้าสต๊อก'
    })) return;

    try {
      if (this.isMockMode) {
        if (dongle.status !== 'issued') throw new Error('ดองเกิ้ลรายการนี้อยู่ในสต๊อกแล้ว');
        dongle.status = 'warehouse';
        dongle.updated_at = new Date().toISOString();
        localStorage.setItem('solartrack_dongles', JSON.stringify(this.dongles));
      } else {
        await this.requestJson(`/api/dongles/${encodeURIComponent(id)}/return`, { method: 'PUT' });
      }
      await this.loadDongleData();
      this.showToast('คืนดองเกิ้ลเข้าสต๊อกแล้ว', 'success');
    } catch (error) {
      this.showToast(`คืนดองเกิ้ลไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  renderEquipmentCatalog() {
    const container = document.getElementById('equipment-catalog-list');
    if (!container) return;
    if (!this.equipmentCatalog.length) {
      container.innerHTML = '<div class="p-5 text-center text-xs text-slate-400">ยังไม่มีอุปกรณ์ในทะเบียน เพิ่มรายการได้จากช่องด้านบน</div>';
      this.refreshIcons();
      return;
    }
    container.innerHTML = this.equipmentCatalog.map(item => `
      <div class="px-4 py-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-800 truncate">${this.escapeHtml(item.name)}</div>
          <div class="text-[11px] text-slate-500">หน่วยนับ: ${this.escapeHtml(item.unit || 'ชิ้น')}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" onclick="app.editEquipmentCatalogItem(${Number(item.id)})" class="p-2 text-sky-700 hover:bg-sky-50 rounded-lg" aria-label="แก้ไข ${this.escapeHtml(item.name)}">
            <i data-lucide="pencil" class="w-4 h-4"></i>
          </button>
          <button type="button" onclick="app.deleteEquipmentCatalogItem(${Number(item.id)})" class="p-2 text-rose-600 hover:bg-rose-50 rounded-lg" aria-label="ลบ ${this.escapeHtml(item.name)}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    `).join('');
    this.refreshIcons();
  }

  renderEquipmentIssues() {
    const container = document.getElementById('equipment-issue-history');
    if (!container) return;
    const toggleAllButton = document.getElementById('equipment-toggle-details');
    if (!this.equipmentIssues.length) {
      if (toggleAllButton) toggleAllButton.classList.add('hidden');
      container.innerHTML = `
        <div class="p-8 text-center text-xs text-slate-400">
          <i data-lucide="clipboard-list" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          ยังไม่มีประวัติการเบิกอุปกรณ์
        </div>`;
      this.refreshIcons();
      return;
    }
    const issueIds = this.equipmentIssues.map(issue => Number(issue.id));
    const allExpanded = issueIds.every(id => this.expandedEquipmentIssueIds.has(id));
    for (const id of this.expandedEquipmentIssueIds) {
      if (!issueIds.includes(id)) this.expandedEquipmentIssueIds.delete(id);
    }
    if (toggleAllButton) {
      toggleAllButton.classList.remove('hidden');
      toggleAllButton.innerHTML = allExpanded
        ? '<i data-lucide="chevrons-down-up" class="w-3.5 h-3.5"></i><span>ซ่อนรายละเอียดทั้งหมด</span>'
        : '<i data-lucide="chevrons-down-up" class="w-3.5 h-3.5"></i><span>แสดงรายละเอียดทั้งหมด</span>';
    }
    const rows = this.equipmentIssues.map(issue => {
      const id = Number(issue.id);
      const expanded = this.expandedEquipmentIssueIds.has(id);
      const items = Array.isArray(issue.items) ? issue.items : [];
      const itemDetails = items.length
        ? `<div class="flex flex-wrap gap-2">${items.map(item => `
            <span class="inline-flex items-center gap-1.5 rounded-lg border border-sky-100 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
              <span class="font-semibold">${this.escapeHtml(item.name)}</span>
              <span class="text-sky-700">${this.escapeHtml(item.quantity)} ${this.escapeHtml(item.unit || 'ชิ้น')}</span>
            </span>`).join('')}</div>`
        : '<span class="text-xs text-slate-400">ไม่มีรายการอุปกรณ์</span>';
      return `
        <tr class="equipment-history-row">
          <td class="px-4 py-3 text-sm font-semibold text-slate-800">${this.escapeHtml(issue.project_name)}</td>
          <td class="px-4 py-3 whitespace-nowrap text-xs text-slate-600">${this.escapeHtml(issue.issued_at)}</td>
          <td class="px-4 py-3 text-sm text-slate-700">${this.escapeHtml(issue.issued_by)}</td>
          <td class="px-4 py-3 text-center">
            <span class="inline-flex min-w-8 justify-center rounded-full bg-violet-50 px-2 py-1 text-xs font-bold text-violet-700">${items.length}</span>
            <span class="ml-1 text-[11px] text-slate-500">รายการ</span>
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center justify-end gap-1 whitespace-nowrap">
              <button type="button" onclick="app.toggleEquipmentIssueDetails(${id})" class="equipment-history-action text-xs px-2.5 py-1.5 rounded-lg text-slate-700 hover:bg-slate-100 flex items-center gap-1" aria-expanded="${expanded}" aria-controls="equipment-issue-details-${id}">
                <i data-lucide="${expanded ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5"></i>${expanded ? 'ซ่อน' : 'แสดง'}
              </button>
              <button type="button" onclick="app.editEquipmentIssue(${id})" class="equipment-history-action text-xs px-2.5 py-1.5 rounded-lg text-sky-700 hover:bg-sky-50 flex items-center gap-1">
                <i data-lucide="pencil" class="w-3.5 h-3.5"></i>แก้ไข
              </button>
              <button type="button" onclick="app.deleteEquipmentIssue(${id})" class="equipment-history-action text-xs px-2.5 py-1.5 rounded-lg text-rose-600 hover:bg-rose-50 flex items-center gap-1">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>ลบ
              </button>
            </div>
          </td>
        </tr>
        <tr id="equipment-issue-details-${id}" class="equipment-history-details ${expanded ? '' : 'hidden'}">
          <td colspan="5" class="px-4 pb-4 pt-1">
            <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4 space-y-2.5">
              <h4 class="text-xs font-bold text-slate-700">รายการอุปกรณ์ที่เบิก</h4>
              ${itemDetails}
              ${issue.notes ? `<p class="border-t border-slate-200 pt-2 text-xs text-slate-600"><span class="font-semibold">หมายเหตุ:</span> ${this.escapeHtml(issue.notes)}</p>` : ''}
            </div>
          </td>
        </tr>`;
    }).join('');
    container.innerHTML = `
      <div class="equipment-history-table-scroll">
        <table class="equipment-history-table min-w-[760px] w-full text-left">
          <thead>
            <tr class="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
              <th class="px-4 py-3">โครงการ</th>
              <th class="px-4 py-3">วันที่เบิก</th>
              <th class="px-4 py-3">ผู้เบิก</th>
              <th class="px-4 py-3 text-center">อุปกรณ์</th>
              <th class="px-4 py-3 text-right">จัดการ</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">${rows}</tbody>
        </table>
      </div>`;
    this.refreshIcons();
  }

  toggleEquipmentIssueDetails(id) {
    const issueId = Number(id);
    if (this.expandedEquipmentIssueIds.has(issueId)) this.expandedEquipmentIssueIds.delete(issueId);
    else this.expandedEquipmentIssueIds.add(issueId);
    this.renderEquipmentIssues();
  }

  toggleAllEquipmentIssueDetails() {
    const allExpanded = this.equipmentIssues.length > 0 &&
      this.equipmentIssues.every(issue => this.expandedEquipmentIssueIds.has(Number(issue.id)));
    if (allExpanded) this.expandedEquipmentIssueIds.clear();
    else this.equipmentIssues.forEach(issue => this.expandedEquipmentIssueIds.add(Number(issue.id)));
    this.renderEquipmentIssues();
  }

  renderEquipmentIssueLines(items) {
    const container = document.getElementById('equipment-issue-lines');
    if (!container) return;
    const lines = Array.isArray(items) && items.length ? items : [{}];
    container.innerHTML = lines.map((line, index) => {
      const selectedId = line.equipment_id === undefined || line.equipment_id === null ? '' : String(line.equipment_id);
      const hasCatalogItem = this.equipmentCatalog.some(item => String(item.id) === selectedId);
      const selectedCatalogItem = this.equipmentCatalog.find(item => String(item.id) === selectedId);
      const needsSnapshotOption = selectedId && (!hasCatalogItem ||
        (line.name && line.name !== selectedCatalogItem.name) ||
        (line.unit && line.unit !== (selectedCatalogItem?.unit || 'ชิ้น')));
      const oldItemOption = needsSnapshotOption
        ? `<option value="${this.escapeHtml(selectedId)}" data-name="${this.escapeHtml(line.name || 'อุปกรณ์ที่ไม่มีในทะเบียน')}" data-unit="${this.escapeHtml(line.unit || 'ชิ้น')}" selected>${this.escapeHtml(line.name || 'อุปกรณ์ที่ไม่มีในทะเบียน')}${hasCatalogItem ? ' (ชื่อเดิมในประวัติ)' : ' (ไม่มีในทะเบียน)'}</option>`
        : '';
      const options = this.equipmentCatalog.filter(item => !(needsSnapshotOption && String(item.id) === selectedId)).map(item => `
        <option value="${Number(item.id)}" data-name="${this.escapeHtml(item.name)}" data-unit="${this.escapeHtml(item.unit || 'ชิ้น')}" ${String(item.id) === selectedId ? 'selected' : ''}>
          ${this.escapeHtml(item.name)} (${this.escapeHtml(item.unit || 'ชิ้น')})
        </option>`).join('');
      return `
        <div class="equipment-issue-line grid grid-cols-[minmax(0,1fr)_72px_72px_36px] sm:grid-cols-[minmax(0,1fr)_100px_110px_40px] gap-2 items-center">
          <select required aria-label="อุปกรณ์รายการ ${index + 1}" class="equipment-line-select w-full text-sm px-3 py-2.5 bg-white border border-slate-300 rounded-xl">
            <option value="">-- เลือกอุปกรณ์ --</option>${oldItemOption}${options}
          </select>
          <input type="number" min="0.01" step="any" required value="${this.escapeHtml(line.quantity ?? 1)}" aria-label="จำนวนรายการ ${index + 1}" placeholder="จำนวน" class="equipment-line-quantity w-full text-sm px-2 py-2.5 bg-white border border-slate-300 rounded-xl">
          <button type="button" onclick="app.removeEquipmentIssueLine(this)" class="w-10 h-10 rounded-xl text-rose-600 hover:bg-rose-50 flex items-center justify-center" aria-label="ลบรายการอุปกรณ์">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>`;
    }).join('');
    Array.from(container.querySelectorAll('.equipment-issue-line')).forEach((row, index) => {
      const select = row.querySelector('.equipment-line-select');
      const quantity = row.querySelector('.equipment-line-quantity');
      const line = lines[index] || {};
      const selectedOption = select?.options[select.selectedIndex];
      if (select) {
        select.required = false;
        select.classList.add('col-span-full');
        select.addEventListener('change', () => this.fillEquipmentIssueLine(select));
      }

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = line.name || selectedOption?.dataset.name || '';
      nameInput.placeholder = 'ชื่ออุปกรณ์';
      nameInput.setAttribute('aria-label', `ชื่ออุปกรณ์รายการ ${index + 1}`);
      nameInput.className = 'equipment-line-name min-w-0 w-full text-sm px-3 py-2.5 bg-white border border-slate-300 rounded-xl';
      if (select) select.insertAdjacentElement('afterend', nameInput);

      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.value = line.unit || selectedOption?.dataset.unit || 'ชิ้น';
      unitInput.placeholder = 'หน่วย';
      unitInput.setAttribute('aria-label', `หน่วยรายการ ${index + 1}`);
      unitInput.className = 'equipment-line-unit min-w-0 w-full text-sm px-2 py-2.5 bg-white border border-slate-300 rounded-xl';
      if (quantity) quantity.insertAdjacentElement('afterend', unitInput);
    });
    this.refreshIcons();
  }

  fillEquipmentIssueLine(select) {
    const option = select?.options[select.selectedIndex];
    const row = select?.closest('.equipment-issue-line');
    if (!row || !option?.value) return;
    row.querySelector('.equipment-line-name').value = option.dataset.name || '';
    row.querySelector('.equipment-line-unit').value = option.dataset.unit || 'ชิ้น';
  }

  addEquipmentIssueLine(item = {}) {
    const currentItems = Array.from(document.querySelectorAll('#equipment-issue-lines .equipment-issue-line')).map(row => {
      const select = row.querySelector('.equipment-line-select');
      return {
        equipment_id: select.value || null,
        name: row.querySelector('.equipment-line-name').value.trim(),
        unit: row.querySelector('.equipment-line-unit').value.trim(),
        quantity: row.querySelector('.equipment-line-quantity').value
      };
    });
    currentItems.push(item);
    this.renderEquipmentIssueLines(currentItems);
  }

  removeEquipmentIssueLine(button) {
    const rows = document.querySelectorAll('#equipment-issue-lines .equipment-issue-line');
    if (rows.length === 1) {
      this.showToast('ต้องมีรายการอุปกรณ์อย่างน้อย 1 รายการ', 'warning');
      return;
    }
    button.closest('.equipment-issue-line')?.remove();
  }

  async saveEquipmentCatalogItem(event) {
    event.preventDefault();
    const id = document.getElementById('equipment-catalog-id').value;
    const payload = {
      name: document.getElementById('equipment-catalog-name').value.trim(),
      unit: document.getElementById('equipment-catalog-unit').value.trim()
    };
    try {
      if (this.isMockMode) {
        const duplicate = this.equipmentCatalog.find(item =>
          item.name.toLowerCase() === payload.name.toLowerCase() && String(item.id) !== id
        );
        if (duplicate) throw new Error(`มีอุปกรณ์ "${payload.name}" อยู่แล้ว`);
        const now = new Date().toISOString();
        if (id) {
          const item = this.equipmentCatalog.find(entry => String(entry.id) === id);
          if (!item) throw new Error('ไม่พบข้อมูลอุปกรณ์ที่ต้องการแก้ไข');
          Object.assign(item, payload, { updated_at: now });
        } else {
          this.equipmentCatalog.push({ id: Date.now(), ...payload, created_at: now, updated_at: now });
        }
        localStorage.setItem('solartrack_equipment_catalog', JSON.stringify(this.equipmentCatalog));
      } else {
        await this.requestJson(id ? `/api/equipment/${encodeURIComponent(id)}` : '/api/equipment', {
          method: id ? 'PUT' : 'POST',
          body: { ...payload, ...(id ? { id } : {}) }
        });
      }
      document.getElementById('equipment-catalog-id').value = '';
      document.getElementById('equipment-catalog-name').value = '';
      document.getElementById('equipment-catalog-unit').value = 'ชิ้น';
      document.getElementById('equipment-catalog-submit-label').textContent = 'เพิ่มอุปกรณ์';
      await this.loadEquipmentData();
      this.showToast(id ? 'แก้ไขข้อมูลอุปกรณ์แล้ว' : 'เพิ่มอุปกรณ์แล้ว', 'success');
    } catch (error) {
      this.showToast(`บันทึกข้อมูลอุปกรณ์ไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  editEquipmentCatalogItem(id) {
    const item = this.equipmentCatalog.find(entry => Number(entry.id) === Number(id));
    if (!item) {
      this.showToast('ไม่พบข้อมูลอุปกรณ์ที่ต้องการแก้ไข', 'error');
      return;
    }
    document.getElementById('equipment-catalog-id').value = item.id;
    document.getElementById('equipment-catalog-name').value = item.name;
    document.getElementById('equipment-catalog-unit').value = item.unit || 'ชิ้น';
    document.getElementById('equipment-catalog-submit-label').textContent = 'บันทึกการแก้ไข';
    document.getElementById('equipment-catalog-name').focus();
  }

  async deleteEquipmentCatalogItem(id) {
    const item = this.equipmentCatalog.find(entry => Number(entry.id) === Number(id));
    if (!item || !await this.confirmAction({
      title: 'ยืนยันการลบอุปกรณ์',
      message: `ลบ "${item.name}" ออกจากทะเบียนหรือไม่? ประวัติการเบิกเดิมจะยังคงอยู่`,
      confirmText: 'ลบอุปกรณ์'
    })) return;
    try {
      if (this.isMockMode) {
        this.equipmentCatalog = this.equipmentCatalog.filter(entry => Number(entry.id) !== Number(id));
        localStorage.setItem('solartrack_equipment_catalog', JSON.stringify(this.equipmentCatalog));
      } else {
        await this.requestJson(`/api/equipment/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      await this.loadEquipmentData();
      this.showToast('ลบอุปกรณ์จากทะเบียนแล้ว ประวัติเดิมยังคงอยู่', 'success');
    } catch (error) {
      this.showToast(`ลบอุปกรณ์ไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  async saveEquipmentIssue(event) {
    event.preventDefault();
    const issueId = document.getElementById('equipment-issue-id').value;
    const rows = Array.from(document.querySelectorAll('#equipment-issue-lines .equipment-issue-line'));
    const items = rows.map(row => {
      const select = row.querySelector('.equipment-line-select');
      return {
        equipment_id: select.value || null,
        name: row.querySelector('.equipment-line-name').value.trim(),
        unit: row.querySelector('.equipment-line-unit').value.trim(),
        quantity: Number(row.querySelector('.equipment-line-quantity').value)
      };
    }).filter(item => item.name);
    if (!items.length || items.some(item => !item.unit || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      this.showToast('กรุณาเลือกอุปกรณ์และระบุจำนวนให้ครบทุกบรรทัด', 'warning');
      return;
    }
    const payload = {
      project_name: document.getElementById('equipment-issue-project').value,
      issued_at: document.getElementById('equipment-issue-date').value,
      issued_by: document.getElementById('equipment-issue-by').value.trim(),
      notes: document.getElementById('equipment-issue-notes').value.trim(),
      items
    };
    if (!payload.project_name || !payload.issued_at || !payload.issued_by) {
      this.showToast('กรุณากรอกโครงการ วันที่ และชื่อผู้เบิกให้ครบ', 'warning');
      return;
    }

    try {
      if (this.isMockMode) {
        const normalizedItems = items.map(line => {
          const catalogItem = line.equipment_id
            ? this.equipmentCatalog.find(item => String(item.id) === String(line.equipment_id))
            : null;
          const previousItem = issueId
            ? this.equipmentIssues.find(issue => String(issue.id) === issueId)?.items?.find(item =>
              String(item.equipment_id || '') === String(line.equipment_id || '') && item.name === line.name)
            : null;
          const name = line.name || previousItem?.name || catalogItem?.name || '';
          const unit = line.unit || previousItem?.unit || catalogItem?.unit || 'ชิ้น';
          if (!name) throw new Error('กรุณาระบุชื่ออุปกรณ์');
          return { equipment_id: line.equipment_id ? Number(line.equipment_id) : null, name, unit, quantity: line.quantity };
        });
        const now = new Date().toISOString();
        const existing = this.equipmentIssues.find(issue => String(issue.id) === issueId);
        const issue = { ...payload, items: normalizedItems, updated_at: now };
        if (existing) Object.assign(existing, issue);
        else this.equipmentIssues.unshift({ id: Date.now(), ...issue, created_at: now });
        localStorage.setItem('solartrack_equipment_issues', JSON.stringify(this.equipmentIssues));
      } else {
        await this.requestJson(issueId ? `/api/equipment/issues/${encodeURIComponent(issueId)}` : '/api/equipment/issues', {
          method: issueId ? 'PUT' : 'POST',
          body: payload
        });
      }
      this.cancelEquipmentIssueEdit();
      await this.loadEquipmentData();
      this.showToast(issueId ? 'แก้ไขประวัติการเบิกแล้ว' : 'บันทึกประวัติการเบิกแล้ว', 'success');
    } catch (error) {
      this.showToast(`บันทึกประวัติการเบิกไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  editEquipmentIssue(id) {
    const issue = this.equipmentIssues.find(entry => Number(entry.id) === Number(id));
    if (!issue) {
      this.showToast('ไม่พบประวัติการเบิกที่ต้องการแก้ไข', 'error');
      return;
    }
    document.getElementById('equipment-issue-id').value = issue.id;
    document.getElementById('equipment-issue-project').value = issue.project_name;
    document.getElementById('equipment-issue-date').value = issue.issued_at;
    document.getElementById('equipment-issue-by').value = issue.issued_by;
    document.getElementById('equipment-issue-notes').value = issue.notes || '';
    document.getElementById('equipment-issue-form-title').textContent = 'แก้ไขประวัติการเบิกอุปกรณ์';
    document.getElementById('btn-cancel-equipment-edit').classList.remove('hidden');
    this.renderEquipmentIssueLines(issue.items || []);
    document.getElementById('equipment-issue-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  cancelEquipmentIssueEdit() {
    const form = document.getElementById('equipment-issue-form');
    form?.reset();
    document.getElementById('equipment-issue-id').value = '';
    document.getElementById('equipment-issue-form-title').textContent = 'บันทึกเบิกอุปกรณ์ไปหน้างาน';
    document.getElementById('btn-cancel-equipment-edit').classList.add('hidden');
    document.getElementById('equipment-issue-date').value = this.getLocalDateInputValue();
    document.getElementById('equipment-issue-by').value = appSettings.getDefaultTechnician() || '';
    this.renderEquipmentIssueLines([{}]);
  }

  async deleteEquipmentIssue(id) {
    const issue = this.equipmentIssues.find(entry => Number(entry.id) === Number(id));
    if (!issue || !await this.confirmAction({
      title: 'ยืนยันการลบประวัติ',
      message: `ลบประวัติการเบิกของโครงการ "${issue.project_name}" วันที่ ${issue.issued_at} หรือไม่?`,
      confirmText: 'ลบประวัติ'
    })) return;
    try {
      if (this.isMockMode) {
        this.equipmentIssues = this.equipmentIssues.filter(entry => Number(entry.id) !== Number(id));
        localStorage.setItem('solartrack_equipment_issues', JSON.stringify(this.equipmentIssues));
      } else {
        await this.requestJson(`/api/equipment/issues/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      await this.loadEquipmentData();
      this.showToast('ลบประวัติการเบิกแล้ว', 'success');
    } catch (error) {
      this.showToast(`ลบประวัติการเบิกไม่สำเร็จ: ${error.message}`, 'error');
    }
  }

  handleDbFilterChange() {
    this.dbFilters.search = document.getElementById('db-filter-search').value.trim();
    this.dbFilters.project = document.getElementById('db-filter-project').value;
    this.dbFilters.status = document.getElementById('db-filter-status').value;
    this.dbFilters.received_from = document.getElementById('db-filter-received-from').value;
    this.dbFilters.received_to = document.getElementById('db-filter-received-to').value;
    this.dbFilters.moved_from = document.getElementById('db-filter-moved-from').value;
    this.dbFilters.moved_to = document.getElementById('db-filter-moved-to').value;
    this.loadDbRecords();
  }

  async loadDbRecords() {
    try {
      let panels = [];
      if (this.isMockMode) {
        panels = this.getMockPanels();
        if (this.dbFilters.search) {
          const q = this.dbFilters.search.toLowerCase();
          panels = panels.filter(p =>
            (p.serial_number && p.serial_number.toLowerCase().includes(q)) ||
            (p.project_name && p.project_name.toLowerCase().includes(q)) ||
            (p.inverter && p.inverter.toLowerCase().includes(q)) ||
            (p.string_name && p.string_name.toLowerCase().includes(q)) ||
            (p.technician_name && p.technician_name.toLowerCase().includes(q))
          );
        }
        if (this.dbFilters.project && this.dbFilters.project !== 'all') {
          panels = panels.filter(p => p.project_name === this.dbFilters.project);
        }
        if (this.dbFilters.status && this.dbFilters.status !== 'all') {
          panels = panels.filter(p => p.status === this.dbFilters.status);
        }
        if (this.dbFilters.received_from) panels = panels.filter(p => this.getBangkokDateKey(p.created_at) >= this.dbFilters.received_from);
        if (this.dbFilters.received_to) panels = panels.filter(p => this.getBangkokDateKey(p.created_at) <= this.dbFilters.received_to);
        const movedDate = panel => panel.moved_at || (panel.status !== 'warehouse' ? panel.updated_at : '');
        if (this.dbFilters.moved_from) panels = panels.filter(p => this.getBangkokDateKey(movedDate(p)) >= this.dbFilters.moved_from);
        if (this.dbFilters.moved_to) panels = panels.filter(p => this.getBangkokDateKey(movedDate(p)) <= this.dbFilters.moved_to);
      } else {
        const query = new URLSearchParams(this.dbFilters);
        const res = await fetch(`/api/panels?${query.toString()}&limit=200`);
        const json = await res.json();
        panels = json.data || [];
      }

      this.cachedDbPanels = panels;
      this.renderDbRecords(panels);
    } catch (e) {
      console.error('Failed loading DB records:', e);
    }
  }

  renderDbRecords(panels) {
    const tbody = document.getElementById('db-table-body');
    const cardsContainer = document.getElementById('db-cards-container');

    if (!panels || panels.length === 0) {
      const emptyHtml = `
        <div class="py-10 text-center text-slate-400 text-xs">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          ไม่พบรายการข้อมูลในฐานข้อมูลตามเงื่อนไขที่เลือก
        </div>
      `;
      if (cardsContainer) cardsContainer.innerHTML = emptyHtml;
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="11" class="py-10 text-center text-slate-400">
              <i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
              ไม่พบรายการข้อมูลในฐานข้อมูลตามเงื่อนไขที่เลือก
            </td>
          </tr>
        `;
      }
      this.updateBatchBar();
      this.refreshIcons();
      return;
    }

    if (cardsContainer) {
      cardsContainer.innerHTML = panels.map(p => {
        const isChecked = this.selectedIds.has(p.id) ? 'checked' : '';
        const statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${this.getStatusBadgeClass(p.status)}">${this.translateStatus(p.status)}</span>`;
        const receivedDate = this.formatDateTime(p.created_at);
        const movedDate = this.formatDateTime(p.moved_at || (p.status !== 'warehouse' ? p.updated_at : null));
        return `
          <div class="p-3.5 hover:bg-slate-50 transition flex items-start gap-3">
            <input type="checkbox" ${isChecked} onchange="app.toggleSelectRow(${p.id}, this.checked)" class="mt-1 rounded text-amber-500 focus:ring-amber-400">
            <div class="flex-1 min-w-0 space-y-1">
              <div class="flex items-center justify-between gap-1.5">
                <span class="font-mono font-bold text-xs text-slate-900 truncate">#${p.id} ${this.escapeHtml(p.serial_number)}</span>
                ${statusBadge}
              </div>
              <div class="text-xs text-slate-700 truncate font-medium flex items-center gap-1">
                <i data-lucide="folder" class="w-3 h-3 text-amber-500 shrink-0"></i>
                <span>${this.escapeHtml(this.getPanelLocationLabel(p))}</span>
              </div>
              <div class="text-[10px] text-slate-500">รับเข้า ${receivedDate} · ย้าย/จ่ายออก ${movedDate}</div>
              <div class="text-[11px] text-slate-500 flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
                <span class="truncate">${this.escapeHtml(p.brand_model || '-')} · ${Number(p.wattage) || 0} Wp</span>
                <div class="flex items-center gap-1.5">
                  <button onclick="app.openEditModal(${p.id})" class="p-1 hover:bg-slate-200 rounded text-slate-600" title="แก้ไข">
                    <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                  </button>
                  <button onclick="app.confirmDeletePanel(${p.id}, '${this.escapeHtml(p.serial_number)}')" class="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded" title="ลบ">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    if (tbody) {
      tbody.innerHTML = panels.map(p => {
        const isChecked = this.selectedIds.has(p.id) ? 'checked' : '';
        const statusBadge = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${this.getStatusBadgeClass(p.status)}">${this.translateStatus(p.status)}</span>`;
        const receivedDate = this.formatDateTime(p.created_at);
        const movedDate = this.formatDateTime(p.moved_at || (p.status !== 'warehouse' ? p.updated_at : null));
        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 ${isChecked ? 'bg-amber-50/50' : ''}">
            <td class="py-3 px-3 text-center">
              <input type="checkbox" ${isChecked} onchange="app.toggleSelectRow(${p.id}, this.checked)" class="rounded text-amber-500 focus:ring-amber-400">
            </td>
            <td class="py-3 px-3 font-mono text-slate-400 text-[11px]">${p.id}</td>
            <td class="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">${this.escapeHtml(p.serial_number)}</td>
            <td class="py-3 px-3 font-medium whitespace-nowrap">${this.escapeHtml(this.getPanelLocationLabel(p))}</td>
            <td class="py-3 px-3 font-mono text-slate-600 whitespace-nowrap">${this.escapeHtml(p.inverter || '-')} / ${this.escapeHtml(p.string_name || '-')} (#${p.panel_index || 0})</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${this.escapeHtml(p.brand_model || '-')} (${p.wattage || 550}W)</td>
            <td class="py-3 px-3 whitespace-nowrap">${statusBadge}</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${this.escapeHtml(p.technician_name || '-')}</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${receivedDate}</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${movedDate}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
              <div class="flex items-center justify-center gap-1">
                <button onclick="app.openEditModal(${p.id})" class="p-1 hover:bg-slate-200 rounded text-slate-600 hover:text-slate-900 transition" title="แก้ไข">
                  <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                </button>
                <button onclick="app.confirmDeletePanel(${p.id}, '${this.escapeHtml(p.serial_number)}')" class="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded transition" title="ลบ">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    const selectAllCheckbox = document.getElementById('db-select-all');
    if (selectAllCheckbox) {
      const allSelected = panels.length > 0 && panels.every(p => this.selectedIds.has(p.id));
      selectAllCheckbox.checked = allSelected;
    }

    this.updateBatchBar();
    this.refreshIcons();
  }

  toggleSelectAll(checked) {
    if (checked) {
      this.cachedDbPanels.forEach(p => this.selectedIds.add(p.id));
    } else {
      this.selectedIds.clear();
    }
    this.renderDbRecords(this.cachedDbPanels);
  }

  toggleSelectRow(id, checked) {
    if (checked) {
      this.selectedIds.add(id);
    } else {
      this.selectedIds.delete(id);
    }
    this.renderDbRecords(this.cachedDbPanels);
  }

  clearSelection() {
    this.selectedIds.clear();
    this.renderDbRecords(this.cachedDbPanels);
  }

  updateBatchBar() {
    const bar = document.getElementById('batch-action-bar');
    const countEl = document.getElementById('batch-selected-count');
    if (!bar || !countEl) return;

    const count = this.selectedIds.size;
    countEl.textContent = count;

    if (count > 0) {
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
  }

  async confirmBatchDelete() {
    const ids = Array.from(this.selectedIds);
    if (ids.length === 0) return;

    if (!await this.confirmAction({
      title: 'ยืนยันการลบแผง',
      message: `คุณกำลังจะลบแผงโซลาร์ ${ids.length} รายการออกจากฐานข้อมูล การดำเนินการนี้ไม่สามารถย้อนกลับได้`,
      confirmText: `ลบ ${ids.length} รายการ`
    })) {
      return;
    }

    try {
      if (this.isMockMode) {
        let panels = this.getMockPanels();
        panels = panels.filter(p => !ids.includes(p.id));
        localStorage.setItem('solartrack_panels', JSON.stringify(panels));
      } else {
        const res = await fetch('/api/database/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        if (!res.ok) {
          await Promise.all(ids.map(id => fetch(`/api/panels/${id}`, { method: 'DELETE' })));
        }
      }

      this.showToast(`ลบข้อมูล ${ids.length} รายการเรียบร้อยแล้ว`, 'success');
      this.selectedIds.clear();
      await this.loadDatabaseStudioData();
    } catch (e) {
      this.showToast('เกิดข้อผิดพลาดในการลบกลุ่ม: ' + e.message, 'error');
    }
  }

  openBatchStatusModal() {
    const count = this.selectedIds.size;
    if (count === 0) return;
    document.getElementById('batch-status-target-count').textContent = count;
    document.getElementById('modal-batch-status').classList.remove('hidden');
    this.refreshIcons();
  }

  closeBatchStatusModal() {
    document.getElementById('modal-batch-status').classList.add('hidden');
  }

  async handleBatchStatusSubmit(e) {
    e.preventDefault();
    const status = document.getElementById('batch-status-select').value;
    const ids = Array.from(this.selectedIds);

    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        panels.forEach(p => {
          if (ids.includes(p.id)) p.status = status;
        });
        localStorage.setItem('solartrack_panels', JSON.stringify(panels));
      } else {
        const res = await fetch('/api/database/batch-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, status })
        });
        if (!res.ok) {
          const targets = this.cachedDbPanels.filter(p => ids.includes(p.id));
          await Promise.all(targets.map(p => fetch('/api/panels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...p, status })
          })));
        }
      }

      this.closeBatchStatusModal();
      this.showToast(`อัปเดตสถานะ ${ids.length} รายการเป็น "${this.translateStatus(status)}" สำเร็จ`, 'success');
      this.selectedIds.clear();
      await this.loadDatabaseStudioData();
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    }
  }

  openBatchProjectModal() {
    const count = this.selectedIds.size;
    if (count === 0) return;
    document.getElementById('batch-project-target-count').textContent = count;
    this.populateDbProjectDropdowns();
    document.getElementById('modal-batch-project').classList.remove('hidden');
    this.refreshIcons();
  }

  closeBatchProjectModal() {
    document.getElementById('modal-batch-project').classList.add('hidden');
  }

  async handleBatchProjectSubmit(e) {
    e.preventDefault();
    const projectName = document.getElementById('batch-project-select').value;
    if (!projectName) {
      this.showToast('กรุณาเลือกโครงการปลายทาง', 'warning');
      return;
    }
    const ids = Array.from(this.selectedIds);

    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        panels.forEach(p => {
          if (ids.includes(p.id)) p.project_name = projectName;
        });
        localStorage.setItem('solartrack_panels', JSON.stringify(panels));
      } else {
        await fetch('/api/database/batch-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, projectName })
        });
      }

      this.closeBatchProjectModal();
      this.showToast(`ย้าย ${ids.length} แผงไปยังโครงการ "${projectName}" สำเร็จ`, 'success');
      this.selectedIds.clear();
      await this.loadDatabaseStudioData();
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    }
  }

  async openEditModal(id) {
    const cachedPanel = this.cachedDbPanels.find(p => Number(p.id) === Number(id));
    if (!cachedPanel) {
      this.showToast('ไม่พบข้อมูลแผง', 'error');
      return;
    }

    let panel = cachedPanel;
    if (this.isMockMode) {
      panel = this.getMockPanels().find(item => Number(item.id) === Number(id)) || cachedPanel;
    } else {
      try {
        const response = await fetch(`/api/panels/${encodeURIComponent(cachedPanel.serial_number)}`);
        const result = await response.json();
        if (!response.ok || !result.panel) {
          throw new Error(result.error || result.message || `HTTP ${response.status}`);
        }
        panel = result.panel;
      } catch (error) {
        this.showToast(`โหลดข้อมูลแผงไม่สำเร็จ: ${error.message}`, 'error');
        return;
      }
    }

    await this.populateDbProjectDropdowns();

    document.getElementById('edit-id').value = panel.id;
    document.getElementById('edit-serial').value = panel.serial_number;
    const editProject = document.getElementById('edit-project');
    const originalProject = panel.status === 'warehouse' || panel.project_name === WAREHOUSE_PROJECT_NAME
      ? WAREHOUSE_PROJECT_NAME
      : String(panel.project_name || '').trim();
    if (editProject && originalProject) {
      const hasOriginalProject = Array.from(editProject.options).some(option => option.value === originalProject);
      if (!hasOriginalProject) {
        const originalOption = document.createElement('option');
        originalOption.value = originalProject;
        originalOption.textContent = originalProject;
        editProject.add(originalOption);
      }
      editProject.value = originalProject;
    }
    document.getElementById('edit-inverter').value = panel.inverter || '';
    document.getElementById('edit-string').value = panel.string_name || '';
    document.getElementById('edit-index').value = panel.panel_index || 0;
    document.getElementById('edit-status').value = panel.status;
    document.getElementById('edit-wattage').value = panel.wattage || 550;
    document.getElementById('edit-brand').value = panel.brand_model || '';
    document.getElementById('edit-technician').value = panel.technician_name || '';
    document.getElementById('edit-notes').value = panel.notes || '';

    document.getElementById('modal-edit-panel').classList.remove('hidden');
    this.refreshIcons();
  }

  syncEditPanelLocationStatus(changedField) {
    const projectSelect = document.getElementById('edit-project');
    const statusSelect = document.getElementById('edit-status');
    if (!projectSelect || !statusSelect) return;

    const isWarehouseProject = project => String(project || '').trim() === WAREHOUSE_PROJECT_NAME;
    if (changedField === 'status' && statusSelect.value === 'warehouse') {
      if (!Array.from(projectSelect.options).some(option => option.value === WAREHOUSE_PROJECT_NAME)) {
        const warehouseOption = document.createElement('option');
        warehouseOption.value = WAREHOUSE_PROJECT_NAME;
        warehouseOption.textContent = WAREHOUSE_PROJECT_NAME;
        projectSelect.add(warehouseOption);
      }
      projectSelect.value = WAREHOUSE_PROJECT_NAME;
    } else if (changedField === 'status' && isWarehouseProject(projectSelect.value)) {
      const firstFieldProject = Array.from(projectSelect.options).find(option => option.value && !isWarehouseProject(option.value));
      if (firstFieldProject) projectSelect.value = firstFieldProject.value;
    }

    if (changedField === 'project') {
      statusSelect.value = isWarehouseProject(projectSelect.value) ? 'warehouse'
        : (statusSelect.value === 'warehouse' ? 'installing' : statusSelect.value);
    }
  }

  closeEditModal() {
    document.getElementById('modal-edit-panel').classList.add('hidden');
  }

  async handleSaveEditPanel(e) {
    e.preventDefault();
    const payload = {
      id: parseInt(document.getElementById('edit-id').value, 10),
      serial_number: document.getElementById('edit-serial').value,
      project_name: document.getElementById('edit-project').value,
      inverter: document.getElementById('edit-inverter').value.trim() || '-',
      string_name: document.getElementById('edit-string').value.trim() || '-',
      panel_index: parseInt(document.getElementById('edit-index').value, 10) || 0,
      status: document.getElementById('edit-status').value,
      wattage: parseInt(document.getElementById('edit-wattage').value, 10) || 550,
      brand_model: document.getElementById('edit-brand').value.trim() || 'Standard Tier-1 Solar',
      technician_name: document.getElementById('edit-technician').value.trim() || 'ช่างตรวจ',
      notes: document.getElementById('edit-notes').value.trim(),
      scanned_mode: 'database-edit'
    };

    try {
      if (this.isMockMode) {
        this.saveMockPanel(payload);
      } else {
        await this.postJson('/api/panels', payload);
      }

      this.closeEditModal();
      this.showToast(`แก้ไขข้อมูลแผง ${payload.serial_number} สำเร็จ`, 'success');
      await this.loadDatabaseStudioData();
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'error');
    }
  }

  async confirmDeletePanel(id, serial) {
    if (!await this.confirmAction({
      title: 'ยืนยันการลบแผง',
      message: `ลบแผง Serial Number ${serial} ออกจากฐานข้อมูลหรือไม่? การดำเนินการนี้ไม่สามารถย้อนกลับได้`,
      confirmText: 'ลบแผง'
    })) {
      return;
    }

    try {
      if (this.isMockMode) {
        let list = this.getMockPanels();
        list = list.filter(p => p.id !== id);
        localStorage.setItem('solartrack_panels', JSON.stringify(list));
      } else {
        await fetch(`/api/panels/${id}`, { method: 'DELETE' });
      }

      this.selectedIds.delete(id);
      this.showToast(`ลบแผง ${serial} สำเร็จ`, 'success');
      await this.loadDatabaseStudioData();
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการลบ: ' + err.message, 'error');
    }
  }

  async loadDbProjects() {
    const grid = document.getElementById('db-projects-grid');
    if (!grid) return;

    try {
      let projects = [];
      if (this.isMockMode) {
        const projs = this.getMockProjects();
        const panels = this.getMockPanels();
        const map = {};
        projs.forEach(p => {
          map[p.name] = {
            name: p.name,
            location: p.location || 'ภาคสนาม',
            target_capacity_kw: p.target_capacity_kw || 0,
            total_panels: 0,
            installed_panels: 0,
            warehouse_panels: 0,
            installing_panels: 0,
            damaged_panels: 0,
            total_wattage: 0
          };
        });
        panels.forEach(p => {
          if (p.status === 'warehouse' || p.project_name === WAREHOUSE_PROJECT_NAME) return;
          if (!map[p.project_name]) {
            map[p.project_name] = {
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
          map[p.project_name].total_panels++;
          if (p.status === 'installed') map[p.project_name].installed_panels++;
          else if (p.status === 'warehouse') map[p.project_name].warehouse_panels++;
          else if (p.status === 'installing') map[p.project_name].installing_panels++;
          else if (p.status === 'damaged') map[p.project_name].damaged_panels++;
          map[p.project_name].total_wattage += (p.wattage || 550);
        });
        projects = Object.values(map);
      } else {
        try {
          const res = await fetch('/api/database/projects-detail');
          if (res.ok) {
            const json = await res.json();
            projects = json.projects || [];
          }
        } catch (fetchErr) {
          console.warn('/api/database/projects-detail 404, calculating from /api/panels');
        }

        if (!projects || projects.length === 0) {
          try {
            const panelsRes = await fetch('/api/panels?limit=1000');
            if (panelsRes.ok) {
              const panelsJson = await panelsRes.json();
              const map = {};
              (panelsJson.data || []).forEach(p => {
                if (p.status === 'warehouse' || p.project_name === WAREHOUSE_PROJECT_NAME) return;
                if (!map[p.project_name]) {
                  map[p.project_name] = { name: p.project_name, total_panels: 0, installed_panels: 0, total_wattage: 0 };
                }
                map[p.project_name].total_panels++;
                if (p.status === 'installed') map[p.project_name].installed_panels++;
                map[p.project_name].total_wattage += (p.wattage || 550);
              });
              projects = Object.values(map);
            }
          } catch (e2) {}
        }
      }

      if (projects.length === 0) {
        grid.innerHTML = `
          <div class="col-span-full py-8 text-center text-slate-400 text-xs">
            <i data-lucide="folder" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
            ยังไม่มีข้อมูลโครงการในระบบ
          </div>
        `;
        this.refreshIcons();
        return;
      }

      this.cachedProjects = projects;

      grid.innerHTML = projects.map(proj => {
        const total = proj.total_panels || 0;
        const installed = proj.installed_panels || 0;
        const warehouse = proj.warehouse_panels || 0;
        const installing = proj.installing_panels || 0;
        const damaged = proj.damaged_panels || 0;
        const pct = total > 0 ? Math.round((installed / total) * 100) : 0;
        const kwp = ((proj.total_wattage || 0) / 1000).toFixed(1);
        const targetKwp = proj.target_capacity_kw ? Number(proj.target_capacity_kw).toFixed(1) : null;
        const locationText = proj.location || 'ภาคสนาม';

        return `
          <div class="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/90 shadow-sm hover:shadow-md transition space-y-3.5 flex flex-col justify-between">
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center space-x-2.5 min-w-0">
                  <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0">
                    <i data-lucide="folder-check" class="w-5 h-5"></i>
                  </div>
                  <div class="min-w-0 flex-1">
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 break-words" title="${this.escapeHtml(proj.name)}">${this.escapeHtml(proj.name)}</h4>
                    <div class="flex items-center gap-1.5 text-[11px] text-slate-500 flex-wrap mt-0.5">
                      <span class="inline-flex min-w-0 items-start gap-0.5 text-slate-600 break-words"><i data-lucide="map-pin" class="w-3 h-3 text-slate-400 shrink-0 mt-0.5"></i> <span class="min-w-0 break-words">${this.escapeHtml(locationText)}</span></span>
                      <span>โ€ข</span>
                      <span>ติดตั้งจริง: <strong class="text-slate-800">${kwp} kWp</strong></span>
                      ${targetKwp ? `<span class="text-slate-400 font-medium">/ เป้า ${targetKwp} kWp</span>` : ''}
                    </div>
                  </div>
                </div>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap shrink-0 ${pct >= 100 ? 'bg-emerald-100 text-emerald-800' : (pct > 0 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700')}">${pct}%</span>
              </div>

              <div class="space-y-1">
                <div class="flex flex-wrap justify-between gap-x-2 gap-y-0.5 text-[11px] text-slate-500 font-medium">
                  <span>ติดตั้งแล้ว: <strong class="text-slate-800">${installed}</strong> / ${total} แผง</span>
                  <span>${pct}% เสร็จสิ้น</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div class="bg-gradient-to-r from-amber-500 to-emerald-500 h-2 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
                </div>
              </div>

              <div class="grid grid-cols-4 gap-1.5 text-center text-[10px] pt-1">
                <div class="bg-emerald-50 text-emerald-800 p-1.5 rounded-lg border border-emerald-100">
                  <div class="font-bold text-xs">${warehouse}</div>
                  <div class="text-emerald-700/80">ในคลัง</div>
                </div>
                <div class="bg-blue-50 text-blue-800 p-1.5 rounded-lg border border-blue-100">
                  <div class="font-bold text-xs">${installing}</div>
                  <div class="text-blue-700/80">กำลังติด</div>
                </div>
                <div class="bg-purple-50 text-purple-800 p-1.5 rounded-lg border border-purple-100">
                  <div class="font-bold text-xs">${installed}</div>
                  <div class="text-purple-700/80">ติดตั้งแล้ว</div>
                </div>
                <div class="bg-rose-50 text-rose-800 p-1.5 rounded-lg border border-rose-100">
                  <div class="font-bold text-xs">${damaged}</div>
                  <div class="text-rose-700/80">ชำรุด</div>
                </div>
              </div>
            </div>

            <div class="pt-2 grid grid-cols-2 gap-2 border-t border-slate-100 text-xs">
              <button onclick="app.filterByProjectAndShow('${this.escapeHtml(proj.name)}')" class="touch-press col-span-2 min-w-0 py-2 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-lg flex items-center justify-center gap-1">
                <i data-lucide="eye" class="w-3.5 h-3.5 text-slate-500"></i> ดูแผง
              </button>
              <button onclick="app.exportProjectExcel(this.dataset.project)" data-project="${this.escapeHtml(proj.name)}" class="touch-press min-w-0 py-2 px-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-medium rounded-lg flex items-center justify-center gap-1 whitespace-nowrap">
                <i data-lucide="file-spreadsheet" class="w-3.5 h-3.5"></i> Excel
              </button>
              <button onclick="app.exportProjectPdf(this.dataset.project)" data-project="${this.escapeHtml(proj.name)}" class="touch-press min-w-0 py-2 px-2 bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium rounded-lg flex items-center justify-center gap-1 whitespace-nowrap">
                <i data-lucide="file-text" class="w-3.5 h-3.5"></i> PDF
              </button>
              <button onclick="app.openEditProjectModal('${this.escapeHtml(proj.name)}')" class="touch-press min-w-0 py-2 px-2 bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium rounded-lg flex items-center justify-center gap-1 whitespace-nowrap">
                <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> แก้ไข
              </button>
              ${proj.name === 'คลังสินค้ากลาง (Central Warehouse)' ? '' : `
              <button onclick="app.openDeleteProjectModal('${this.escapeHtml(proj.name)}', ${total})" class="touch-press min-w-0 py-2 px-2 bg-rose-50 hover:bg-rose-100 text-rose-600 font-medium rounded-lg flex items-center justify-center gap-1 whitespace-nowrap">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ลบ
              </button>
              `}
            </div>
          </div>
        `;
      }).join('');

      this.refreshIcons();
    } catch (e) {
      console.error('Failed loading DB projects:', e);
    }
  }

  filterByProjectAndShow(projectName) {
    this.dbFilters.project = projectName;
    const select = document.getElementById('db-filter-project');
    if (select) select.value = projectName;
    this.switchDbTab('records');
  }

  // ---------------- Tab 3: Maintenance Tools ----------------

  async downloadJsonBackup() {
    try {
      let data = null;
      if (this.isMockMode) {
        data = {
          app: 'SolarTrack Field Operations (Local Mock)',
          exportedAt: new Date().toISOString(),
          panels: this.getMockPanels(),
          dongles: JSON.parse(localStorage.getItem('solartrack_dongles') || '[]')
        };
      } else {
        try {
          const res = await fetch('/api/database/backup');
          if (res.ok) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `solartrack_backup_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.showToast('ดาวน์โหลด JSON Backup เรียบร้อย', 'success');
            return;
          }
        } catch (e) {}

        const panelsRes = await fetch('/api/panels?limit=10000');
        if (panelsRes.ok) {
          const json = await panelsRes.json();
          data = {
            app: 'SolarTrack Field Operations',
            exportedAt: new Date().toISOString(),
            panels: json.data || [],
            dongles: (await this.requestJson('/api/dongles')).dongles || []
          };
        }
      }

      if (data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `solartrack_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('ดาวน์โหลด JSON Backup เรียบร้อย', 'success');
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการดาวน์โหลด Backup: ' + err.message, 'error');
    }
  }

  handleImportJson() {
    const fileInput = document.getElementById('import-json-file');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      this.showToast('กรุณาเลือกไฟล์ JSON เพื่อนำเข้า', 'warning');
      return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const content = JSON.parse(e.target.result);
        const panels = Array.isArray(content) ? content : (content.panels || []);

        if (!Array.isArray(panels) || panels.length === 0) {
          throw new Error('ไม่พบรายการข้อมูลแผงโซลาร์ในไฟล์ JSON');
        }

        if (!await this.confirmAction({
          title: 'ยืนยันการนำเข้าข้อมูล',
          message: `ระบบจะนำเข้าข้อมูลแผง ${panels.length} รายการ ข้อมูล Serial Number ที่ซ้ำอาจถูกอัปเดต`,
          confirmText: `นำเข้า ${panels.length} รายการ`,
          tone: 'primary'
        })) {
          fileInput.value = '';
          return;
        }

        if (this.isMockMode) {
          const list = this.getMockPanels();
          panels.forEach(p => {
            const idx = list.findIndex(ex => ex.serial_number.toLowerCase() === p.serial_number.toLowerCase());
            if (idx >= 0) list[idx] = { ...list[idx], ...p };
            else list.push({ ...p, id: list.length + 1 });
          });
          localStorage.setItem('solartrack_panels', JSON.stringify(list));
        } else {
          const res = await fetch('/api/database/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panels })
          });
          if (!res.ok) {
            await Promise.all(panels.map(p => fetch('/api/panels', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p)
            })));
          }
        }

        fileInput.value = '';
        this.showToast(`นำเข้าข้อมูลแผงโซลาร์ ${panels.length} รายการสำเร็จ!`, 'success');
        await this.loadDatabaseStudioData();
      } catch (err) {
        this.showToast('เกิดข้อผิดพลาดในการอ่านไฟล์ JSON: ' + err.message, 'error');
      }
    };

    reader.readAsText(file);
  }

  async seedDemoDataset() {
    if (!await this.confirmAction({
      title: 'เพิ่มข้อมูลตัวอย่าง',
      message: 'ระบบจะเพิ่มข้อมูลตัวอย่างแผงโซลาร์เซลล์ลงในฐานข้อมูล ต้องการดำเนินการต่อหรือไม่?',
      confirmText: 'เพิ่มข้อมูลตัวอย่าง',
      tone: 'primary'
    })) {
      return;
    }

    try {
      if (this.isMockMode) {
        this.initLocalStorageMock();
      } else {
        const res = await fetch('/api/database/seed', { method: 'POST' });
        if (!res.ok) {
          const samplePanels = [
            { serial_number: 'LONGI-LR5-72HBD-550M-001', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 1, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installed', technician_name: 'สมชาย รักงาน', notes: 'ติดตั้งเรียบร้อย' },
            { serial_number: 'LONGI-LR5-72HBD-550M-002', project_name: 'Solar Farm Lopburi Phase 2', inverter: 'INV-01', string_name: 'STR-01', panel_index: 2, brand_model: 'Longi Hi-MO 5 Bifacial', wattage: 550, status: 'installed', technician_name: 'สมชาย รักงาน', notes: 'ติดตั้งเรียบร้อย' },
            { serial_number: 'JINKO-JKM560N-72HL4-101', project_name: 'Rooftop Factory Amata Chonburi', inverter: 'INV-02', string_name: 'STR-03', panel_index: 1, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'installing', technician_name: 'วิชัย ช่างไฟ', notes: 'กำลังติดตั้ง' },
            { serial_number: 'JINKO-JKM560N-72HL4-102', project_name: 'Rooftop Factory Amata Chonburi', inverter: 'INV-02', string_name: 'STR-03', panel_index: 2, brand_model: 'Jinko Tiger Neo N-Type', wattage: 560, status: 'installing', technician_name: 'วิชัย ช่างไฟ', notes: 'กำลังติดตั้ง' },
            { serial_number: 'TRINA-TSM-NEG19RC-580-001', project_name: 'Floating Solar Ubon Ratchathani', inverter: 'FL-INV-01', string_name: 'STR-01', panel_index: 1, brand_model: 'Trina Vertex N', wattage: 580, status: 'installed', technician_name: 'ชวนชื่น', notes: 'ติดตั้งบนพื้นที่น้ำ' },
            { serial_number: 'WH-LONGI-550-PALLET-08', project_name: 'คลังสินค้ากลาง (Central Warehouse)', inverter: '-', string_name: '-', panel_index: 0, brand_model: 'Longi', wattage: 550, status: 'warehouse', technician_name: 'เจ้าหน้าที่คลัง', notes: 'อยู่ในคลัง' }
          ];
          await Promise.all(samplePanels.map(p => fetch('/api/panels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
          })));
        }
      }

      this.showToast('เติมชุดข้อมูลทดสอบเรียบร้อยแล้��!', 'success');
      await this.loadDatabaseStudioData();
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการเติมข้อมูล: ' + err.message, 'error');
    }
  }

  async openClearOptionsModal() {
    await this.populateDbProjectDropdowns();

    const projectSelect = document.getElementById('clear-target-project');
    if (projectSelect) {
      let projects = [];
      try {
        if (this.isMockMode) {
          const panels = this.getMockPanels();
          projects = Array.from(new Set(panels
            .filter(p => p.status !== 'warehouse' && p.project_name !== WAREHOUSE_PROJECT_NAME)
            .map(p => p.project_name))).filter(Boolean);
        } else {
          const res = await fetch('/api/projects');
          const json = await res.json();
          projects = json.projects || [];
        }
      } catch (e) {
        projects = [];
      }
      if (projects.length === 0) {
        projectSelect.innerHTML = '<option value="">-- ไม่มีโครงการ --</option>';
      } else {
        projectSelect.innerHTML = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');
      }
    }

    const radios = document.getElementsByName('clear-scope-option');
    radios.forEach(r => {
      r.checked = (r.value === 'all');
    });

    const chk = document.getElementById('clear-confirm-checkbox');
    if (chk) chk.checked = false;

    const btn = document.getElementById('btn-submit-clear-options');
    if (btn) btn.disabled = true;

    this.onClearScopeChange();

    document.getElementById('modal-clear-options').classList.remove('hidden');
    this.refreshIcons();
  }

  closeClearOptionsModal() {
    document.getElementById('modal-clear-options').classList.add('hidden');
  }

  onClearScopeChange() {
    const radios = document.getElementsByName('clear-scope-option');
    let scope = 'all';
    for (const r of radios) {
      if (r.checked) {
        scope = r.value;
        break;
      }
    }

    const projectContainer = document.getElementById('clear-project-select-container');
    const previewText = document.getElementById('clear-impact-text');

    if (scope === 'project') {
      if (projectContainer) projectContainer.classList.remove('hidden');
      const prj = document.getElementById('clear-target-project')?.value || '';
      if (previewText) previewText.textContent = `📁 ระบบจะล้างข้อมูล: เฉพาะแผงในโครงการ "${prj || 'ที่เลือก'}"`;
    } else {
      if (projectContainer) projectContainer.classList.add('hidden');
      if (previewText) {
        if (scope === 'warehouse') {
          previewText.textContent = '📦 ระบบจะล้างข้อมูล: เฉพาะแผงในคลังสินค้า (สถานะ: ในคลัง) โดยไม่แตะโครงการอื่น';
        } else if (scope === 'installed') {
          previewText.textContent = '☀️ ระบบจะล้างข้อมูล: เฉพาะแผงที่ติดตั้งแล้ว (สถานะ: ติดตั้งแล้ว/กำลังติดตั้ง)';
        } else if (scope === 'damaged') {
          previewText.textContent = '⚠️ ระบบจะล้างข้อมูล: เฉพาะแผงที่ชำรุด / ส่งเคลม';
        } else {
          previewText.textContent = '🔴 ระบบจะล้างข้อมูล: แผงโซลาร์ทั้งหมดในระบบ 100%';
        }
      }
    }
  }

  onClearCheckboxToggle() {
    const chk = document.getElementById('clear-confirm-checkbox');
    const btn = document.getElementById('btn-submit-clear-options');
    if (btn) {
      btn.disabled = !(chk && chk.checked);
    }
  }

  async handleClearOptionsSubmit() {
    const chk = document.getElementById('clear-confirm-checkbox');
    if (!chk || !chk.checked) {
      this.showToast('กรุณากดยืนยันความเข้าใจก่อนล้างข้อมูล', 'warning');
      return;
    }

    const radios = document.getElementsByName('clear-scope-option');
    let scope = 'all';
    for (const r of radios) {
      if (r.checked) {
        scope = r.value;
        break;
      }
    }

    const project = document.getElementById('clear-target-project')?.value || '';

    const btn = document.getElementById('btn-submit-clear-options');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="animate-spin mr-1.5">🌀</span> กำลังล้างข้อมูล...`;
    }

    try {
      let deletedCount = 0;
      if (this.isMockMode) {
        let list = this.getMockPanels();
        const initialCount = list.length;
        if (scope === 'warehouse') {
          list = list.filter(p => p.status !== 'warehouse');
        } else if (scope === 'installed') {
          list = list.filter(p => p.status !== 'installed' && p.status !== 'installing');
        } else if (scope === 'damaged') {
          list = list.filter(p => p.status !== 'damaged');
        } else if (scope === 'project' && project) {
          list = list.filter(p => p.project_name !== project);
        } else {
          list = [];
        }
        deletedCount = initialCount - list.length;
        localStorage.setItem('solartrack_panels', JSON.stringify(list));
      } else {
        let clearedOnServer = false;
        try {
          const res = await fetch('/api/database/clear-selective', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, project })
          });
          if (res.ok) {
            const json = await res.json();
            if (json.success) {
              deletedCount = json.count || 0;
              clearedOnServer = true;
            }
          }
        } catch (fetchErr) {
          console.warn('/api/database/clear-selective failed or returned 404:', fetchErr);
        }

        if (!clearedOnServer) {
          if (scope === 'all') {
            try {
              const clearRes = await fetch('/api/database/clear', { method: 'POST' });
              if (clearRes.ok) {
                const clearJson = await clearRes.json().catch(() => ({}));
                deletedCount = clearJson.count || 0;
                clearedOnServer = true;
              }
            } catch (clearErr) {}
          }

          if (!clearedOnServer) {
            const panelsRes = await fetch('/api/panels?limit=10000');
            if (panelsRes.ok) {
              const panelsJson = await panelsRes.json();
              const allPanels = panelsJson.data || [];
              let targets = [];
              if (scope === 'warehouse') {
                targets = allPanels.filter(p => p.status === 'warehouse');
              } else if (scope === 'installed') {
                targets = allPanels.filter(p => p.status === 'installed' || p.status === 'installing');
              } else if (scope === 'damaged') {
                targets = allPanels.filter(p => p.status === 'damaged');
              } else if (scope === 'project' && project) {
                targets = allPanels.filter(p => p.project_name === project);
              } else {
                targets = allPanels;
              }

              deletedCount = targets.length;
              const chunkSize = 10;
              for (let i = 0; i < targets.length; i += chunkSize) {
                const chunk = targets.slice(i, i + chunkSize);
                await Promise.all(chunk.map(p => fetch(`/api/panels/${p.id}`, { method: 'DELETE' })));
              }
              clearedOnServer = true;
            }
          }
        }
      }

      this.closeClearOptionsModal();
      this.selectedIds.clear();

      let scopeLabel = 'ข้อมูลทั้งหมด';
      if (scope === 'warehouse') scopeLabel = 'แผงในคลังสินค้า';
      else if (scope === 'installed') scopeLabel = 'แผงที่ติดตั้งแล้ว';
      else if (scope === 'damaged') scopeLabel = 'แผงชำรุด/เคลม';
      else if (scope === 'project') scopeLabel = `โครงการ "${project}"`;

      this.showToast(`🗑️ ล้าง${scopeLabel}เรียบร้อยแล้ว (ลบออก ${deletedCount} รายการ)`, 'success');
      await this.loadDatabaseStudioData();
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการล้างข้อมูล: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="trash-2" class="w-4 h-4"></i> ยืนยันการล้างข้อมูล`;
        this.refreshIcons();
      }
    }
  }

  async confirmClearDatabase() {
    this.openClearOptionsModal();
  }

  async openPalletRangeModal() {
    document.getElementById('pallet-brand').value = '';
    document.getElementById('pallet-wattage').value = '';
    this.calculatePalletCount();
    document.getElementById('modal-pallet-range').classList.remove('hidden');
    this.refreshIcons();
  }

  closePalletRangeModal() {
    document.getElementById('modal-pallet-range').classList.add('hidden');
  }

  calculatePalletCount() {
    const start = parseInt(document.getElementById('pallet-start-num').value, 10) || 0;
    const end = parseInt(document.getElementById('pallet-end-num').value, 10) || 0;
    const count = Math.max(0, end - start + 1);
    const countEl = document.getElementById('pallet-calc-count');
    if (countEl) countEl.textContent = count;
  }

  async handlePalletRangeSubmit(e) {
    e.preventDefault();
    const start = parseInt(document.getElementById('pallet-start-num').value, 10);
    const end = parseInt(document.getElementById('pallet-end-num').value, 10);
    const brand = document.getElementById('pallet-brand').value.trim();
    const wattage = parseInt(document.getElementById('pallet-wattage').value, 10);

    if (!brand) {
      this.showToast('กรุณาเลือกรุ่นหรือยี่ห้อแผงก่อนรับเข้าคลัง', 'warning');
      document.getElementById('pallet-brand').focus();
      return;
    }
    if (!Number.isInteger(wattage) || wattage < 1 || wattage > 2000) {
      this.showToast('กรุณาระบุกำลังวัตต์ระหว่าง 1 ถึง 2000 Wp', 'warning');
      document.getElementById('pallet-wattage').focus();
      return;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      this.showToast('End serial must be a valid number greater than or equal to start serial.', 'error');
      return;
    }

    const totalPanels = end - start + 1;
    if (totalPanels <= 0 || totalPanels > 500) {
      this.showToast('A serial range must contain between 1 and 500 panels.', 'error');
      return;
    }
    if (totalPanels > 100) {
      if (!await this.confirmAction({
        title: 'ยืนยันการเพิ่มแผงจำนวนมาก',
        message: `ระบบจะสร้างแผงจำนวน ${totalPanels} รายการจากช่วง Serial ที่ระบุ`,
        confirmText: `เพิ่ม ${totalPanels} แผง`,
        tone: 'primary'
      })) return;
    }

    const submitBtn = document.getElementById('btn-submit-pallet-range');
    submitBtn.disabled = true;
    submitBtn.innerHTML = `กำลังบันทึก ${totalPanels} แผง...`;

    const paddingLength = document.getElementById('pallet-start-num').value.length;
    const panelsToCreate = [];

    for (let i = start; i <= end; i++) {
      const numStr = String(i).padStart(paddingLength, '0');
      const serial = numStr;

      panelsToCreate.push({
        serial_number: serial,
        project_name: WAREHOUSE_PROJECT_NAME,
        inverter: '-',
        string_name: '-',
        panel_index: 0,
        brand_model: brand,
        wattage: wattage,
        status: 'warehouse',
        technician_name: appSettings.getDefaultTechnician() || 'Warehouse staff',
        notes: `Generated from serial range ${start}-${end}`,
        scanned_mode: 'warehouse'
      });
    }

    try {
      if (this.isMockMode) {
        const list = this.getMockPanels();
        panelsToCreate.forEach(p => {
          const idx = list.findIndex(ex => ex.serial_number.toLowerCase() === p.serial_number.toLowerCase());
          if (idx >= 0) list[idx] = { ...list[idx], ...p };
          else list.push({ ...p, id: list.length + 1 });
        });
        localStorage.setItem('solartrack_panels', JSON.stringify(list));
      } else {
        await this.importPanels(panelsToCreate);
      }

      this.closePalletRangeModal();
      this.showToast(`สร้างและบันทึกพาเลทสำเร็จเรียบร้อย (${totalPanels} แผง)!`, 'success');
      if (this.currentView === 'dashboard') {
        await this.loadDashboardData();
      } else if (this.currentView === 'database') {
        await this.loadDatabaseStudioData();
      }
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการสร้างพาเลท: ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4"></i> บันทึกยกพาเลททันที`;
      this.refreshIcons();
    }
  }
}

let app;
window.addEventListener('DOMContentLoaded', () => {
  app = new SolarTrackingApp();
});

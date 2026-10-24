/**
 * SolarTrack - Field Operations Frontend Application
 * Handles barcode scanning, GPS capture, offline fallback, and UI transitions.
 */

class SolarTrackingApp {
  constructor() {
    this.currentView = 'dashboard';
    this.currentMode = 'field'; // 'warehouse' | 'field'
    this.html5QrCode = null;
    this.isScanning = false;
    this.isTorchOn = false;
    this.availableCameras = [];
    this.currentCameraIndex = 0;
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

    // Turbo Continuous Scan Mode (100+ Panels)
    this.isTurboMode = false;
    this.turboScanCount = 0;
    this.lastScannedSerial = '';
    this.lastScannedTime = 0;
    this.barcodeBuffer = '';
    this.barcodeBufferTime = 0;

    // Database Studio state
    this.selectedIds = new Set();
    this.dbCurrentTab = 'records';
    this.dbFilters = {
      search: '',
      project: 'all',
      status: 'all'
    };
    this.cachedDbPanels = [];

    this.init();
  }

  async init() {
    this.bindEvents();
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

    // Hardware Wireless Barcode Scanner Gun Support (HID Wedge Keyboard)
    // This must continue capturing scanner input even when an input field is focused,
    // because physical barcode guns send a fast burst of keystrokes and press Enter at the end.
    window.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      const isTextField = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
      const now = Date.now();

      // Ignore only modifier keys and navigation keys.
      if (!e.key || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Backspace'].includes(e.key)) {
        if (e.key === 'Backspace' && this.barcodeBuffer.length > 0) {
          this.barcodeBuffer = this.barcodeBuffer.slice(0, -1);
        }
        return;
      }

      // Barcode scanners send a burst of characters in rapid succession. Normal human typing is slower.
      const isPrintableKey = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
      const isLikelyScannerBurst = now - this.barcodeBufferTime < 80;

      // If the user is typing manually in a text field, don't hijack the input.
      // But if it is a rapid scanner burst, capture it anyway.
      if (isTextField && !isLikelyScannerBurst && !isPrintableKey && e.key !== 'Enter') {
        return;
      }

      if (now - this.barcodeBufferTime > 120 && this.barcodeBuffer.length > 0 && e.key !== 'Enter') {
        this.barcodeBuffer = '';
      }
      this.barcodeBufferTime = now;

      if (e.key === 'Enter') {
        if (this.barcodeBuffer.length >= 4) {
          const scannedCode = this.barcodeBuffer.trim();
          this.barcodeBuffer = '';
          this.handleHardwareScannerInput(scannedCode);
        } else {
          this.barcodeBuffer = '';
        }
      } else if (isPrintableKey) {
        this.barcodeBuffer += e.key;
      }
    }, true);
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
        this.isMockMode = false;
        this.updateConnectionIndicator(true, 'เชื่อมต่อเซิร์ฟเวอร์');
        return;
      }
      throw new Error('Non-200 response');
    } catch (e) {
      this.isMockMode = true;
      this.initLocalStorageMock();
      this.updateConnectionIndicator(false, 'โหมดออฟไลน์ (Local DB)');
      this.showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ระบบสลับไปใช้ Local Storage ชั่วคราว', 'warning');
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

  // ---------------- Mock Database (When Offline/Standalone) ----------------

  initLocalStorageMock() {
    if (!localStorage.getItem('solartrack_panels')) {
      const initialSeed = [
        {
          id: 1,
          serial_number: 'LONGI-LR5-72HBD-550M-202401',
          project_name: 'Solar Farm Lopburi Phase 2',
          inverter: 'INV-01',
          string_name: 'STR-01',
          panel_index: 1,
          brand_model: 'Longi Hi-MO 5 Bifacial',
          wattage: 550,
          status: 'installed',
          technician_name: 'สมชาย รักงาน',
          gps_lat: 14.8055,
          gps_lng: 100.6534,
          notes: 'ติดตั้งโครงสร้างเรียบร้อย',
          scanned_mode: 'field',
          updated_at: new Date().toISOString()
        },
        {
          id: 2,
          serial_number: 'JINKO-JKM560N-72HL4-202410',
          project_name: 'Rooftop Factory Amata Chonburi',
          inverter: 'INV-02',
          string_name: 'STR-05',
          panel_index: 1,
          brand_model: 'Jinko Tiger Neo N-Type',
          wattage: 560,
          status: 'installing',
          technician_name: 'วิชัย ช่างไฟ',
          gps_lat: 13.3611,
          gps_lng: 100.9847,
          notes: 'กำลังจัดสายลงราง',
          scanned_mode: 'field',
          updated_at: new Date().toISOString()
        },
        {
          id: 3,
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
          notes: 'รับเข้าคลังพาเลทที่ #12',
          scanned_mode: 'warehouse',
          updated_at: new Date().toISOString()
        }
      ];
      localStorage.setItem('solartrack_panels', JSON.stringify(initialSeed));
    }
  }

  getMockPanels() {
    return JSON.parse(localStorage.getItem('solartrack_panels') || '[]');
  }

  saveMockPanel(panel) {
    const list = this.getMockPanels();
    const idx = list.findIndex(p => p.serial_number.toLowerCase() === panel.serial_number.toLowerCase());
    const now = new Date().toISOString();
    let record;
    if (idx >= 0) {
      record = { ...list[idx], ...panel, updated_at: now };
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
    const views = ['dashboard', 'scanner', 'form', 'success', 'database'];
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.refreshIcons();

    if (viewId === 'dashboard') {
      this.loadDashboardData();
    } else if (viewId === 'database') {
      this.loadDatabaseStudioData();
    }
  }

  updateNavButtons(viewId) {
    const navDashboard = document.getElementById('nav-btn-dashboard');
    const navDatabase = document.getElementById('nav-btn-database');
    if (!navDashboard || !navDatabase) return;

    if (viewId === 'dashboard') {
      navDashboard.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 bg-amber-500 text-slate-950 font-bold shadow-xs';
      navDatabase.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 text-slate-300 hover:text-white';
    } else if (viewId === 'database') {
      navDatabase.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 bg-amber-500 text-slate-950 font-bold shadow-xs';
      navDashboard.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 text-slate-300 hover:text-white';
    } else {
      navDashboard.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 text-slate-300 hover:text-white';
      navDatabase.className = 'text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 text-slate-300 hover:text-white';
    }
  }

  startScanMode(mode) {
    this.currentMode = mode;
    const badge = document.getElementById('scanner-mode-badge');
    const formTag = document.getElementById('form-mode-tag');

    if (mode === 'warehouse') {
      if (badge) {
        badge.textContent = 'รับเข้าคลัง (Warehouse)';
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500 text-slate-950 uppercase';
      }
      if (formTag) {
        formTag.textContent = 'โหมดรับเข้าคลัง';
        formTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-emerald-500 text-slate-950';
      }
    } else {
      if (badge) {
        badge.textContent = 'ติดตั้งหน้างาน (Field)';
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500 text-slate-950 uppercase';
      }
      if (formTag) {
        formTag.textContent = 'โหมดติดตั้งหน้างาน';
        formTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-amber-500 text-slate-950';
      }
    }

    this.showView('scanner');
    this.startCameraScanner();
  }

  // ---------------- Camera & Barcode Scanner (html5-qrcode) ----------------

  async startCameraScanner() {
    if (this.isScanning) {
      await this.stopCameraScanner();
    }

    const readerEl = document.getElementById('reader');
    if (!readerEl) return;
    readerEl.innerHTML = '';

    try {
      this.html5QrCode = new Html5Qrcode("reader");

      // Query available cameras
      try {
        this.availableCameras = await Html5Qrcode.getCameras();
      } catch (camErr) {
        console.warn('Unable to enumerate cameras:', camErr);
      }

      // Scanner configuration for 1D Barcodes and 2D QR Codes
      const config = {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          // Responsive reticle: rectangular for 1D barcode & square for QR
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const qrboxWidth = Math.floor(viewfinderWidth * 0.85);
          const qrboxHeight = Math.floor(Math.min(minEdge * 0.75, 260));
          return { width: qrboxWidth, height: qrboxHeight };
        },
        aspectRatio: 1.3333,
        showTorchButtonIfSupported: true,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.UPC_A
        ]
      };

      const cameraSelection = this.availableCameras.length > 0
        ? this.availableCameras[this.currentCameraIndex % this.availableCameras.length].id
        : { facingMode: "environment" };

      await this.html5QrCode.start(
        cameraSelection,
        config,
        (decodedText, decodedResult) => {
          this.onScanSuccess(decodedText, decodedResult);
        },
        (errorMessage) => {
          // Scanner stream tick (suppressed)
        }
      );

      this.isScanning = true;
      this.isTorchOn = false;
      this.updateTorchUi();
    } catch (err) {
      console.error('Failed to start camera:', err);
      let errorMsg = 'ไม่สามารถเปิดกล้องได้: ' + (err.message || err);
      if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        errorMsg += ' (บราวเซอร์มือถือจำเป็นต้องใช้ HTTPS หรือ localhost ในการเข้าถึงกล้อง)';
      }
      this.showToast(errorMsg, 'error');
    }
  }

  async stopCameraScanner() {
    if (this.html5QrCode && this.isScanning) {
      try {
        await this.html5QrCode.stop();
        this.html5QrCode.clear();
      } catch (err) {
        console.warn('Error stopping scanner:', err);
      }
      this.isScanning = false;
    }
  }

  async stopScannerAndReturn() {
    await this.stopCameraScanner();
    this.showView('dashboard');
  }

  async switchCamera() {
    if (this.availableCameras.length < 2) {
      this.showToast('พบกล้องเพียงตัวเดียวบนอุปกรณ์นี้', 'info');
      return;
    }
    this.currentCameraIndex++;
    this.showToast('กำลังสลับกล้อง...', 'info');
    await this.startCameraScanner();
  }

  async toggleTorch() {
    if (!this.isScanning || !this.html5QrCode) {
      this.showToast('กรุณารอให้กล้องเปิดก่อน', 'warning');
      return;
    }

    try {
      this.isTorchOn = !this.isTorchOn;
      await this.html5QrCode.applyVideoConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });
      this.updateTorchUi();
      this.showToast(this.isTorchOn ? 'เปิดไฟฉายแล้ว' : 'ปิดไฟฉายแล้ว', 'info');
    } catch (err) {
      console.warn('Torch not supported or failed:', err);
      this.isTorchOn = false;
      this.updateTorchUi();
      this.showToast('อุปกรณ์หรือบราวเซอร์นี้ไม่รองรับการเปิดไฟฉาย', 'warning');
    }
  }

  updateTorchUi() {
    const btn = document.getElementById('btn-torch');
    if (!btn) return;
    if (this.isTorchOn) {
      btn.className = 'w-9 h-9 rounded-lg bg-amber-500 text-slate-950 flex items-center justify-center transition border border-amber-400';
    } else {
      btn.className = 'w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-400 flex items-center justify-center transition border border-slate-700';
    }
  }

  // ---------------- Audio & Haptic Feedback ----------------

  playBeep() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      // AudioContext fallback
    }

    // Haptic vibration feedback for mobile field workers
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }
  }

  // ---------------- Turbo Continuous Scanning Mode ----------------

  toggleTurboMode(checked) {
    this.isTurboMode = checked;
    const pill = document.getElementById('turbo-status-pill');
    const drawer = document.getElementById('turbo-preset-drawer');
    if (checked) {
      if (pill) {
        pill.classList.remove('hidden');
        pill.classList.add('flex');
      }
      this.populateTurboPresets();
      this.showToast('⚡ เปิดโหมดสแกนรัวต่อเนื่องแล้ว (ยิงรัว 100+ แผง ไม่ต้องแตะหน้าจอ)', 'success');
      if (drawer) drawer.classList.remove('hidden');
    } else {
      if (pill) {
        pill.classList.add('hidden');
        pill.classList.remove('flex');
      }
      if (drawer) drawer.classList.add('hidden');
      this.showToast('ปิดโหมดสแกนรัวต่อเนื่องแล้ว', 'info');
    }
  }

  toggleTurboPresetDrawer() {
    const drawer = document.getElementById('turbo-preset-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    this.populateTurboPresets();
  }

  async populateTurboPresets() {
    const select = document.getElementById('turbo-preset-project');
    if (!select || select.children.length > 0) return;

    let projects = [];
    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        projects = Array.from(new Set(panels.map(p => p.project_name))).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        const json = await res.json();
        projects = json.projects || [];
      }
    } catch (e) {
      projects = ['Solar Farm Lopburi Phase 2', 'Rooftop Factory Amata Chonburi'];
    }

    select.innerHTML = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');
    if (this.lastSaved.project_name) select.value = this.lastSaved.project_name;
    if (this.lastSaved.inverter) document.getElementById('turbo-preset-inverter').value = this.lastSaved.inverter;
    if (this.lastSaved.string_name) document.getElementById('turbo-preset-string').value = this.lastSaved.string_name;
  }

  async handleTurboScan(serialNumber) {
    const now = Date.now();
    if (this.lastScannedSerial === serialNumber && (now - this.lastScannedTime < 1800)) {
      return;
    }

    this.lastScannedSerial = serialNumber;
    this.lastScannedTime = now;
    this.playBeep();

    const isWarehouse = this.currentMode === 'warehouse';
    const projectSelect = document.getElementById('turbo-preset-project');
    const project = isWarehouse
      ? 'คลังสินค้ากลาง (Central Warehouse)'
      : ((projectSelect && projectSelect.value) || this.lastSaved.project_name || 'Solar Farm Lopburi Phase 2');
    const inverter = isWarehouse ? '-' : ((document.getElementById('turbo-preset-inverter')?.value.trim()) || 'INV-01');
    const stringName = isWarehouse ? '-' : ((document.getElementById('turbo-preset-string')?.value.trim()) || 'STR-01');
    const indexInput = document.getElementById('turbo-preset-index');
    const currentIndex = isWarehouse ? 0 : (parseInt(indexInput?.value, 10) || 1);
    const status = isWarehouse ? 'warehouse' : ((document.getElementById('turbo-preset-status')?.value) || 'installed');

    const payload = {
      serial_number: serialNumber,
      project_name: project,
      inverter: inverter,
      string_name: stringName,
      panel_index: currentIndex,
      status: status,
      brand_model: 'Standard Tier-1 Solar',
      wattage: 550,
      technician_name: this.lastSaved.technician_name || (isWarehouse ? 'เจ้าหน้าที่คลัง' : 'ช่างภาคสนาม'),
      scanned_mode: this.currentMode
    };

    try {
      if (this.isMockMode) {
        this.saveMockPanel(payload);
      } else {
        await fetch('/api/panels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      this.turboScanCount++;

      if (!isWarehouse && indexInput) {
        const nextIndex = currentIndex + 1;
        indexInput.value = nextIndex;
        const nextEl = document.getElementById('turbo-next-index');
        if (nextEl) nextEl.textContent = `#${nextIndex}`;
      }

      const countEl = document.getElementById('turbo-scan-count');
      if (countEl) countEl.textContent = this.turboScanCount;

      this.lastSaved.project_name = project;
      this.lastSaved.inverter = inverter;
      this.lastSaved.string_name = stringName;
      this.lastSaved.panel_index = currentIndex;

      const hudDetails = isWarehouse
        ? '📦 รับเข้าคลังสินค้ากลาง'
        : `${inverter} / ${stringName} (แผง #${currentIndex})`;
      this.showTurboHud(serialNumber, hudDetails, `#${this.turboScanCount}`);
    } catch (e) {
      console.error('Turbo save error:', e);
      this.showToast(`บันทึกไม่สำเร็จ: ${e.message}`, 'error');
    }
  }

  showTurboHud(serial, details, counterText) {
    const hud = document.getElementById('turbo-hud-overlay');
    if (!hud) return;
    document.getElementById('turbo-hud-serial').textContent = serial;
    document.getElementById('turbo-hud-details').textContent = details;
    document.getElementById('turbo-hud-counter').textContent = counterText;

    hud.classList.remove('hidden');
    clearTimeout(this.turboHudTimeout);
    this.turboHudTimeout = setTimeout(() => {
      hud.classList.add('hidden');
    }, 1600);
  }

  handleHardwareScannerInput(serial) {
    this.playBeep();
    if (this.currentView === 'scanner' && this.isTurboMode) {
      this.handleTurboScan(serial);
    } else {
      this.showToast(`🔫 ปืนยิงบาร์โค้ดอ่านค่า: ${serial}`, 'info');
      this.prepareDataForm(serial);
    }
  }

  // ---------------- Scan Handling & Form Populate ----------------

  async onScanSuccess(decodedText, decodedResult) {
    const cleanSerial = decodedText.trim();
    if (this.isTurboMode) {
      await this.handleTurboScan(cleanSerial);
      return;
    }

    this.playBeep();
    await this.stopCameraScanner();
    await this.prepareDataForm(cleanSerial);
  }

  async prepareDataForm(serialNumber) {
    this.showView('form');

    const inputSerial = document.getElementById('input-serial');
    inputSerial.value = serialNumber;

    const isWarehouse = this.currentMode === 'warehouse';
    const installFields = document.getElementById('field-installation-fields');
    const warehouseBanner = document.getElementById('warehouse-mode-banner');
    const titleText = document.getElementById('form-title-text');
    const subtitleText = document.getElementById('form-subtitle-text');
    const modeTag = document.getElementById('form-mode-tag');
    const labelProject = document.getElementById('label-project');
    const saveBtn = document.getElementById('btn-save-panel');
    const projectSelect = document.getElementById('input-project');

    if (isWarehouse) {
      if (warehouseBanner) warehouseBanner.classList.remove('hidden');
      if (installFields) installFields.classList.add('hidden');
      if (titleText) titleText.textContent = 'บันทึกรับแผงเข้าคลังสินค้า';
      if (subtitleText) subtitleText.textContent = 'ยิงบาร์โค้ดแล้วกดบันทึกได้ทันที ไม่ต้องกรอกข้อมูลเพิ่มเติม';
      if (modeTag) {
        modeTag.textContent = 'โหมดรับเข้าคลัง';
        modeTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-emerald-500 text-slate-950';
      }
      if (labelProject) labelProject.innerHTML = 'คลังสินค้าจัดเก็บ (Warehouse Destination) <span class="text-red-500">*</span>';
      if (saveBtn) {
        saveBtn.innerHTML = '<i data-lucide="package-check" class="w-4 h-4"></i> บันทึกรับเข้าคลังทันที';
        saveBtn.className = 'touch-press flex-[2] py-3 px-6 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white rounded-xl text-sm font-bold shadow-md';
      }

      if (projectSelect) {
        let found = false;
        for (let opt of projectSelect.options) {
          if (opt.value.includes('คลัง') || opt.value.toLowerCase().includes('warehouse')) {
            projectSelect.value = opt.value;
            found = true;
            break;
          }
        }
        if (!found) {
          const opt = new Option('คลังสินค้ากลาง (Central Warehouse)', 'คลังสินค้ากลาง (Central Warehouse)', true, true);
          projectSelect.add(opt);
          projectSelect.value = 'คลังสินค้ากลาง (Central Warehouse)';
        }
      }
      this.setStatusRadio('warehouse');
    } else {
      if (warehouseBanner) warehouseBanner.classList.add('hidden');
      if (installFields) installFields.classList.remove('hidden');
      if (titleText) titleText.textContent = 'บันทึกข้อมูลติดตั้งหน้างาน';
      if (subtitleText) subtitleText.textContent = 'กรอกรายละเอียดเพื่อบันทึกลงฐานข้อมูล';
      if (modeTag) {
        modeTag.textContent = 'โหมดติดตั้งหน้างาน';
        modeTag.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-amber-500 text-slate-950';
      }
      if (labelProject) labelProject.innerHTML = 'ชื่อโครงการ (Project Name) <span class="text-red-500">*</span>';
      if (saveBtn) {
        saveBtn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i> บันทึกข้อมูลแผงโซลาร์';
        saveBtn.className = 'touch-press flex-[2] py-3 px-6 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-xl text-sm font-bold shadow-md';
      }
      this.setStatusRadio('installed');
    }

    // Check if serial already exists
    let existing = null;
    try {
      if (this.isMockMode) {
        existing = this.getMockPanels().find(p => p.serial_number.toLowerCase() === serialNumber.toLowerCase());
      } else {
        const res = await fetch(`/api/panels/${encodeURIComponent(serialNumber)}`);
        if (res.ok) {
          const json = await res.json();
          existing = json.panel;
        }
      }
    } catch (e) {
      console.warn('Error checking existing panel:', e);
    }

    const alertEl = document.getElementById('existing-panel-alert');
    const descEl = document.getElementById('existing-panel-desc');

    if (existing) {
      alertEl.classList.remove('hidden');
      descEl.textContent = isWarehouse
        ? `แผงนี้มีประวัติในระบบแล้ว (โครงการเดิม: ${existing.project_name}, สถานะ: ${this.translateStatus(existing.status)})`
        : `แผงนี้ถูกบันทึกแล้วในโครงการ: ${existing.project_name} (${existing.inverter || '-'} / ${existing.string_name || '-'}), สถานะ: ${this.translateStatus(existing.status)}`;

      if (!isWarehouse && existing.project_name) {
        document.getElementById('input-project').value = existing.project_name;
      }
      document.getElementById('input-inverter').value = existing.inverter || '';
      document.getElementById('input-string').value = existing.string_name || '';
      document.getElementById('input-index').value = existing.panel_index || '';
      document.getElementById('input-brand').value = existing.brand_model || '';
      document.getElementById('input-wattage').value = existing.wattage || 550;
      document.getElementById('input-technician').value = existing.technician_name || this.lastSaved.technician_name || '';
      document.getElementById('input-notes').value = existing.notes || '';

      this.setStatusRadio(isWarehouse ? 'warehouse' : 'installed');
    } else {
      alertEl.classList.add('hidden');

      if (!isWarehouse) {
        if (this.lastSaved.project_name) {
          document.getElementById('input-project').value = this.lastSaved.project_name;
        }
        if (this.lastSaved.inverter) {
          document.getElementById('input-inverter').value = this.lastSaved.inverter;
        }
        if (this.lastSaved.string_name) {
          document.getElementById('input-string').value = this.lastSaved.string_name;
        }
        if (this.lastSaved.technician_name) {
          document.getElementById('input-technician').value = this.lastSaved.technician_name;
        }

        document.getElementById('input-index').value = (this.lastSaved.panel_index || 0) + 1;
        this.setStatusRadio('installed');
      }
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
    const latEl = document.getElementById('input-lat');
    const lngEl = document.getElementById('input-lng');

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

  async handleFormSubmit(event) {
    event.preventDefault();

    const isWarehouse = this.currentMode === 'warehouse';
    const serialNumber = document.getElementById('input-serial').value.trim();
    let projectName = document.getElementById('input-project').value.trim();

    if (isWarehouse && !projectName) {
      projectName = 'คลังสินค้ากลาง (Central Warehouse)';
    }

    if (!serialNumber) {
      this.showToast('กรุณาระบุ Serial Number', 'error');
      return;
    }
    if (!projectName) {
      this.showToast('กรุณาเลือกโครงการ', 'error');
      return;
    }

    const payload = {
      serial_number: serialNumber,
      project_name: projectName,
      inverter: isWarehouse ? '-' : (document.getElementById('input-inverter')?.value.trim() || '-'),
      string_name: isWarehouse ? '-' : (document.getElementById('input-string')?.value.trim() || '-'),
      panel_index: isWarehouse ? 0 : (parseInt(document.getElementById('input-index')?.value, 10) || 0),
      brand_model: document.getElementById('input-brand')?.value.trim() || 'Standard Tier-1 Solar',
      wattage: parseInt(document.getElementById('input-wattage')?.value, 10) || 550,
      status: isWarehouse ? 'warehouse' : this.getStatusRadio(),
      technician_name: document.getElementById('input-technician')?.value.trim() || (isWarehouse ? 'เจ้าหน้าที่คลัง' : 'ช่างหน้างาน'),
      gps_lat: isWarehouse ? null : (parseFloat(document.getElementById('input-lat')?.value) || null),
      gps_lng: isWarehouse ? null : (parseFloat(document.getElementById('input-lng')?.value) || null),
      notes: document.getElementById('input-notes')?.value.trim() || '',
      scanned_mode: this.currentMode
    };

    const saveBtn = document.getElementById('btn-save-panel');
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="animate-spin inline-block mr-2">🌀</span> กำลังบันทึก...`;

    try {
      let result;
      if (this.isMockMode) {
        result = this.saveMockPanel(payload);
      } else {
        const res = await fetch('/api/panels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        result = await res.json();
      }

      if (result.success) {
        this.lastSaved = {
          project_name: payload.project_name,
          inverter: payload.inverter,
          string_name: payload.string_name,
          panel_index: payload.panel_index,
          technician_name: payload.technician_name
        };

        this.showSuccessView(result.data || payload);
      } else {
        throw new Error(result.error || 'Failed to save');
      }
    } catch (err) {
      console.error('Save error:', err);
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      if (isWarehouse) {
        saveBtn.innerHTML = `<i data-lucide="package-check" class="w-4 h-4"></i> บันทึกรับเข้าคลังทันที`;
      } else {
        saveBtn.innerHTML = `<i data-lucide="save" class="w-4 h-4"></i> บันทึกข้อมูลแผงโซลาร์`;
      }
      this.refreshIcons();
    }
  }

  showSuccessView(panel) {
    document.getElementById('success-serial').textContent = panel.serial_number;
    document.getElementById('success-project').textContent = panel.project_name;
    const isWarehouse = panel.status === 'warehouse';
    document.getElementById('success-location').textContent = isWarehouse
      ? 'คลังสินค้า (สต๊อกพร้อมใช้งาน)'
      : `${panel.inverter || '-'} / ${panel.string_name || '-'} (แผง #${panel.panel_index || 0})`;
    document.getElementById('success-tech').textContent = panel.technician_name || '-';

    const pill = document.getElementById('success-status-pill');
    pill.textContent = this.translateStatus(panel.status);
    pill.className = `inline-flex items-center font-bold px-2.5 py-0.5 rounded text-[11px] whitespace-nowrap ${this.getStatusBadgeClass(panel.status)}`;

    this.showView('success');
  }

  scanNextPanel() {
    this.startScanMode(this.currentMode);
  }

  // ---------------- Dashboard Data & Table ----------------

  async loadDashboardData() {
    try {
      let stats, panelsData;
      if (this.isMockMode) {
        const all = this.getMockPanels();
        stats = {
          total: all.length,
          warehouse: all.filter(p => p.status === 'warehouse').length,
          installing: all.filter(p => p.status === 'installing').length,
          installed: all.filter(p => p.status === 'installed').length,
          damaged: all.filter(p => p.status === 'damaged').length,
          projects: [...new Set(all.map(p => p.project_name))].length
        };
        panelsData = { total: all.length, data: all };
      } else {
        const query = new URLSearchParams(this.filters);
        const [statsRes, panelsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch(`/api/panels?${query.toString()}`)
        ]);
        stats = (await statsRes.json()).stats;
        panelsData = await panelsRes.json();
      }

      this.renderStats(stats);
      this.renderPanelsTable(panelsData.data);
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

  renderPanelsTable(panels) {
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
              <span class="truncate font-medium">${this.escapeHtml(p.project_name)}</span>
            </div>
            <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100">
              <span class="font-mono text-slate-600">${this.escapeHtml(p.inverter || '-')} / ${this.escapeHtml(p.string_name || '-')} (#${p.panel_index || 0})</span>
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
            <td class="py-3 px-4 font-medium whitespace-nowrap">${this.escapeHtml(p.project_name)}</td>
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

    this.refreshIcons();
  }

  handleFilterChange() {
    this.filters.search = document.getElementById('filter-search').value.trim();
    this.filters.project = document.getElementById('filter-project').value;
    this.filters.status = document.getElementById('filter-status').value;
    this.loadDashboardData();
  }

  // ---------------- Project Dropdown & Management ----------------

  async loadProjects() {
    let projects = [];
    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        projects = Array.from(new Set(panels.map(p => p.project_name))).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        const data = await res.json();
        projects = data.projects || [];
      }
    } catch (e) {
      console.warn('Failed loading projects:', e);
      projects = [];
    }

    this.cachedProjectsList = projects;

    const filterSelect = document.getElementById('filter-project');
    const formSelect = document.getElementById('input-project');
    const dbFilterSelect = document.getElementById('db-filter-project');
    const batchProjSelect = document.getElementById('batch-project-select');
    const clearProjSelect = document.getElementById('clear-target-project');
    const palletProjSelect = document.getElementById('pallet-project');
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
      formSelect.innerHTML = `<option value="">-- เลือกโครงการ --</option>` + optionsHtml;
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

    if (palletProjSelect) {
      const currentVal = palletProjSelect.value;
      palletProjSelect.innerHTML = optionsHtml;
      if (currentVal && projects.includes(currentVal)) palletProjSelect.value = currentVal;
    }

    if (singleProjSelect) {
      const currentVal = singleProjSelect.value;
      singleProjSelect.innerHTML = optionsHtml;
      if (currentVal && projects.includes(currentVal)) singleProjSelect.value = currentVal;
    }

    if (bulkProjSelect) {
      const currentVal = bulkProjSelect.value;
      bulkProjSelect.innerHTML = optionsHtml;
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

    const btn = document.getElementById('btn-submit-new-project');
    if (btn) btn.disabled = true;

    try {
      if (this.isMockMode) {
        if (!this.mockProjects) this.mockProjects = [];
        this.mockProjects.push({ name, location, target_capacity_kw: capacity });
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

    const btn = document.getElementById('btn-submit-edit-project');
    if (btn) btn.disabled = true;

    try {
      if (this.isMockMode) {
        let list = this.getMockPanels();
        if (oldName !== newName) {
          list.forEach(p => {
            if (p.project_name === oldName) p.project_name = newName;
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

    try {
      if (this.isMockMode) {
        let list = this.getMockPanels();
        if (action === 'delete_panels') {
          list = list.filter(p => p.project_name !== name);
        } else {
          list.forEach(p => {
            if (p.project_name === name) {
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
          const panelsRes = await fetch(`/api/panels?project=${encodeURIComponent(name)}&limit=10000`);
          if (panelsRes.ok) {
            const panelsJson = await panelsRes.json();
            const targets = panelsJson.data || [];
            if (action === 'delete_panels') {
              await Promise.all(targets.map(p => fetch(`/api/panels/${p.id}`, { method: 'DELETE' })));
            } else {
              await Promise.all(targets.map(p => fetch('/api/panels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...p, project_name: 'คลังสินค้ากลาง (Central Warehouse)', status: 'warehouse' })
              })));
            }
          }
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
    this.wasScanningBeforeManual = this.isScanning;
    if (this.isScanning) {
      this.stopCameraScanner();
    }

    let projects = [];
    try {
      if (this.isMockMode) {
        projects = Array.from(new Set(this.getMockPanels().map(p => p.project_name))).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        const json = await res.json();
        projects = json.projects || [];
      }
    } catch (e) {
      projects = ['Solar Farm Lopburi Phase 2', 'Rooftop Factory Amata Chonburi'];
    }

    const optionsHtml = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');
    const singleProj = document.getElementById('manual-preset-project');
    const bulkProj = document.getElementById('bulk-preset-project');
    if (singleProj) {
      singleProj.innerHTML = optionsHtml;
      if (this.lastSaved.project_name) singleProj.value = this.lastSaved.project_name;
    }
    if (bulkProj) {
      bulkProj.innerHTML = optionsHtml;
      if (this.lastSaved.project_name) bulkProj.value = this.lastSaved.project_name;
    }

    if (this.lastSaved.inverter) {
      document.getElementById('manual-preset-inverter').value = this.lastSaved.inverter;
      document.getElementById('bulk-preset-inverter').value = this.lastSaved.inverter;
    }
    if (this.lastSaved.string_name) {
      document.getElementById('manual-preset-string').value = this.lastSaved.string_name;
      document.getElementById('bulk-preset-string').value = this.lastSaved.string_name;
    }
    if (this.lastSaved.panel_index) {
      document.getElementById('manual-preset-index').value = (this.lastSaved.panel_index || 0) + 1;
    }

    const isWarehouse = this.currentMode === 'warehouse';
    if (isWarehouse) {
      if (singleProj) {
        let found = false;
        for (let opt of singleProj.options) {
          if (opt.value.includes('คลัง') || opt.value.toLowerCase().includes('warehouse')) {
            singleProj.value = opt.value;
            found = true;
            break;
          }
        }
        if (!found) {
          const opt = new Option('คลังสินค้ากลาง (Central Warehouse)', 'คลังสินค้ากลาง (Central Warehouse)', true, true);
          singleProj.add(opt);
          singleProj.value = 'คลังสินค้ากลาง (Central Warehouse)';
        }
      }
      const bulkStatus = document.getElementById('bulk-preset-status');
      if (bulkStatus) bulkStatus.value = 'warehouse';
    }

    this.switchManualTab('single');
    document.getElementById('modal-manual').classList.remove('hidden');

    const inp = document.getElementById('manual-serial-input');
    inp.value = '';
    setTimeout(() => inp.focus(), 60);
    this.refreshIcons();
  }

  closeManualEntryModal() {
    document.getElementById('modal-manual').classList.add('hidden');
    if (this.currentView === 'scanner' && this.wasScanningBeforeManual) {
      this.startCameraScanner();
    }
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

    if (!isQuickSave) {
      this.closeManualEntryModal();
      this.prepareDataForm(serial);
      return;
    }

    this.playBeep();
    const isWarehouse = this.currentMode === 'warehouse';
    const project = isWarehouse
      ? (document.getElementById('manual-preset-project')?.value || 'คลังสินค้ากลาง (Central Warehouse)')
      : (document.getElementById('manual-preset-project')?.value || 'Solar Farm Lopburi Phase 2');
    const inverter = isWarehouse ? '-' : ((document.getElementById('manual-preset-inverter')?.value.trim()) || 'INV-01');
    const stringName = isWarehouse ? '-' : ((document.getElementById('manual-preset-string')?.value.trim()) || 'STR-01');
    const indexInput = document.getElementById('manual-preset-index');
    const currentIndex = isWarehouse ? 0 : (parseInt(indexInput?.value, 10) || 1);

    const payload = {
      serial_number: serial,
      project_name: project,
      inverter: inverter,
      string_name: stringName,
      panel_index: currentIndex,
      status: isWarehouse ? 'warehouse' : 'installed',
      brand_model: 'Standard Solar',
      wattage: 550,
      technician_name: this.lastSaved.technician_name || (isWarehouse ? 'เจ้าหน้าที่คลัง' : 'ช่างคีย์ข้อมูล'),
      scanned_mode: this.currentMode || 'manual'
    };

    try {
      if (this.isMockMode) {
        this.saveMockPanel(payload);
      } else {
        await fetch('/api/panels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      if (!isWarehouse && indexInput) {
        const nextIndex = currentIndex + 1;
        indexInput.value = nextIndex;
        this.lastSaved.panel_index = currentIndex;
      }
      this.lastSaved.project_name = project;

      this.showToast(isWarehouse ? `📦 บันทึกรับเข้าคลัง [${serial}] สำเร็จ!` : `✅ บันทึกแผง #${currentIndex} [${serial}] สำเร็จ!`, 'success');

      serialInput.value = '';
      serialInput.focus();

      if (this.currentView === 'dashboard') {
        this.loadDashboardData();
      }
    } catch (err) {
      this.showToast('บันทึกไม่สำเร็จ: ' + err.message, 'error');
    }
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

    const project = document.getElementById('bulk-preset-project').value;
    const inverter = document.getElementById('bulk-preset-inverter').value.trim() || 'INV-01';
    const stringName = document.getElementById('bulk-preset-string').value.trim() || 'STR-01';
    const status = document.getElementById('bulk-preset-status').value;

    const btn = document.getElementById('btn-submit-bulk-paste');
    btn.disabled = true;
    btn.innerHTML = `กำลังบันทึก ${lines.length} แผง...`;

    const panelsToCreate = lines.map((serial, idx) => ({
      serial_number: serial,
      project_name: project,
      inverter: inverter,
      string_name: stringName,
      panel_index: idx + 1,
      brand_model: 'Standard Solar',
      wattage: 550,
      status: status,
      technician_name: 'แปะรายการชุด',
      notes: `นำเข้าพร้อมกัน ${lines.length} แผง`,
      scanned_mode: 'bulk-paste'
    }));

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
        const res = await fetch('/api/database/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panels: panelsToCreate })
        });
        if (!res.ok) {
          for (let i = 0; i < panelsToCreate.length; i += 10) {
            await Promise.all(panelsToCreate.slice(i, i + 10).map(p => fetch('/api/panels', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p)
            })));
          }
        }
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

  // ---------------- Helpers & Utilities ----------------

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
      const d = new Date(isoString);
      return d.toLocaleDateString('th-TH', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
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
    let bg = 'bg-slate-900 text-white';
    let icon = 'info';

    if (type === 'success') {
      bg = 'bg-emerald-600 text-white';
      icon = 'check-circle';
    } else if (type === 'error') {
      bg = 'bg-rose-600 text-white';
      icon = 'alert-triangle';
    } else if (type === 'warning') {
      bg = 'bg-amber-600 text-white';
      icon = 'alert-circle';
    }

    toast.className = `${bg} px-4 py-3 rounded-xl shadow-xl flex items-center gap-2.5 text-xs font-medium transform transition-all duration-300 opacity-0 translate-y-2 pointer-events-auto`;
    toast.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 shrink-0"></i> <span>${this.escapeHtml(message)}</span>`;

    container.appendChild(toast);
    this.refreshIcons();

    setTimeout(() => {
      toast.classList.remove('opacity-0', 'translate-y-2');
    }, 10);

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ==========================================
  // DATABASE STUDIO (DATABASE MANAGEMENT VIEW)
  // ==========================================

  showDbTab(tabName) {
    this.showView('database');
    this.switchDbTab(tabName);
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
        projects = Array.from(new Set(panels.map(p => p.project_name))).filter(Boolean);
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
  }

  handleDbFilterChange() {
    this.dbFilters.search = document.getElementById('db-filter-search').value.trim();
    this.dbFilters.project = document.getElementById('db-filter-project').value;
    this.dbFilters.status = document.getElementById('db-filter-status').value;
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
            <td colspan="9" class="py-10 text-center text-slate-400">
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
                <span>${this.escapeHtml(p.project_name)}</span>
              </div>
              <div class="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-100">
                <span class="font-mono">${this.escapeHtml(p.inverter || '-')} / ${this.escapeHtml(p.string_name || '-')} (#${p.panel_index || 0})</span>
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
        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 ${isChecked ? 'bg-amber-50/50' : ''}">
            <td class="py-3 px-3 text-center">
              <input type="checkbox" ${isChecked} onchange="app.toggleSelectRow(${p.id}, this.checked)" class="rounded text-amber-500 focus:ring-amber-400">
            </td>
            <td class="py-3 px-3 font-mono text-slate-400 text-[11px]">${p.id}</td>
            <td class="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">${this.escapeHtml(p.serial_number)}</td>
            <td class="py-3 px-3 font-medium whitespace-nowrap">${this.escapeHtml(p.project_name)}</td>
            <td class="py-3 px-3 font-mono text-slate-600 whitespace-nowrap">${this.escapeHtml(p.inverter || '-')} / ${this.escapeHtml(p.string_name || '-')} (#${p.panel_index || 0})</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${this.escapeHtml(p.brand_model || '-')} (${p.wattage || 550}W)</td>
            <td class="py-3 px-3 whitespace-nowrap">${statusBadge}</td>
            <td class="py-3 px-3 text-slate-600 whitespace-nowrap">${this.escapeHtml(p.technician_name || '-')}</td>
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

    if (!confirm(`⚠️ คุณแน่ใจหรือไม่ที่จะลบแผงโซลาร์ที่เลือกจำนวน ${ids.length} รายการออกจากฐานข้อมูล?`)) {
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
    let panel = this.cachedDbPanels.find(p => p.id === id);
    if (!panel) {
      this.showToast('ไม่พบข้อมูลแผง', 'error');
      return;
    }

    await this.populateDbProjectDropdowns();

    document.getElementById('edit-id').value = panel.id;
    document.getElementById('edit-serial').value = panel.serial_number;
    document.getElementById('edit-project').value = panel.project_name;
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
      notes: document.getElementById('edit-notes').value.trim()
    };

    try {
      if (this.isMockMode) {
        this.saveMockPanel(payload);
      } else {
        const res = await fetch('/api/panels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        await res.json();
      }

      this.closeEditModal();
      this.showToast(`แก้ไขข้อมูลแผง ${payload.serial_number} สำเร็จ`, 'success');
      await this.loadDatabaseStudioData();
    } catch (err) {
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'error');
    }
  }

  async confirmDeletePanel(id, serial) {
    if (!confirm(`คุณต้องการลบแผง ${serial} (ID: ${id}) ออกจากฐานข้อมูลใช่หรือไม่?`)) {
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
        const panels = this.getMockPanels();
        const map = {};
        panels.forEach(p => {
          if (!map[p.project_name]) {
            map[p.project_name] = { name: p.project_name, total_panels: 0, installed_panels: 0, total_wattage: 0 };
          }
          map[p.project_name].total_panels++;
          if (p.status === 'installed') map[p.project_name].installed_panels++;
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
                  <div class="min-w-0">
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 truncate" title="${this.escapeHtml(proj.name)}">${this.escapeHtml(proj.name)}</h4>
                    <div class="flex items-center gap-1.5 text-[11px] text-slate-500 flex-wrap mt-0.5">
                      <span class="inline-flex items-center gap-0.5 text-slate-600"><i data-lucide="map-pin" class="w-3 h-3 text-slate-400"></i> ${this.escapeHtml(locationText)}</span>
                      <span>•</span>
                      <span>ติดตั้งจริง: <strong class="text-slate-800">${kwp} kWp</strong></span>
                      ${targetKwp ? `<span class="text-slate-400 font-medium">/ เป้า ${targetKwp} kWp</span>` : ''}
                    </div>
                  </div>
                </div>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap shrink-0 ${pct >= 100 ? 'bg-emerald-100 text-emerald-800' : (pct > 0 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700')}">${pct}%</span>
              </div>

              <div class="space-y-1">
                <div class="flex justify-between text-[11px] text-slate-500 font-medium">
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

            <div class="pt-2 flex items-center justify-between gap-1.5 border-t border-slate-100 text-xs">
              <button onclick="app.filterByProjectAndShow('${this.escapeHtml(proj.name)}')" class="touch-press flex-1 py-1.5 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-lg flex items-center justify-center gap-1">
                <i data-lucide="eye" class="w-3.5 h-3.5 text-slate-500"></i> ดูแผง
              </button>
              <button onclick="app.openEditProjectModal('${this.escapeHtml(proj.name)}')" class="touch-press py-1.5 px-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium rounded-lg flex items-center gap-1">
                <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> แก้ไข
              </button>
              <button onclick="app.openDeleteProjectModal('${this.escapeHtml(proj.name)}', ${total})" class="touch-press py-1.5 px-3 bg-rose-50 hover:bg-rose-100 text-rose-600 font-medium rounded-lg flex items-center gap-1">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ลบ
              </button>
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
          panels: this.getMockPanels()
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
            panels: json.data || []
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
    if (!confirm('ระบบจะเพิ่มข้อมูลตัวอย่างแผงโซลาร์เซลล์เพื่อความสะดวกในการใช้งาน คุณยืนยันหรือไม่?')) {
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
          projects = Array.from(new Set(panels.map(p => p.project_name))).filter(Boolean);
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
    let projects = [];
    try {
      if (this.isMockMode) {
        const panels = this.getMockPanels();
        projects = Array.from(new Set(panels.map(p => p.project_name))).filter(Boolean);
      } else {
        const res = await fetch('/api/projects');
        const json = await res.json();
        projects = json.projects || [];
      }
    } catch (e) {
      projects = [];
    }

    const select = document.getElementById('pallet-project');
    if (select) {
      select.innerHTML = projects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('');
      if (this.lastSaved.project_name) select.value = this.lastSaved.project_name;
    }

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
    const project = document.getElementById('pallet-project').value;
    const prefix = document.getElementById('pallet-prefix').value.trim();
    const start = parseInt(document.getElementById('pallet-start-num').value, 10);
    const end = parseInt(document.getElementById('pallet-end-num').value, 10);
    const inverter = document.getElementById('pallet-inverter').value.trim() || 'INV-01';
    const stringName = document.getElementById('pallet-string').value.trim() || 'STR-01';
    const status = document.getElementById('pallet-status').value;
    const brand = document.getElementById('pallet-brand').value.trim() || 'Standard Solar';
    const wattage = parseInt(document.getElementById('pallet-wattage').value, 10) || 550;

    if (end < start) {
      this.showToast('เลขสิ้นสุดต้องมากกว่าหรือเท่ากับเลขเริ่มต้น', 'error');
      return;
    }

    const totalPanels = end - start + 1;
    if (totalPanels > 500) {
      if (!confirm(`คุณกำลังจะสร้างแผงจำนวนมาก (${totalPanels} แผง) ยืนยันหรือไม่?`)) return;
    }

    const submitBtn = document.getElementById('btn-submit-pallet-range');
    submitBtn.disabled = true;
    submitBtn.innerHTML = `กำลังบันทึก ${totalPanels} แผง...`;

    const paddingLength = String(document.getElementById('pallet-start-num').value).length;
    const panelsToCreate = [];

    for (let i = start; i <= end; i++) {
      const numStr = String(i).padStart(paddingLength, '0');
      const serial = `${prefix}${numStr}`;
      const panelIndex = (i - start) + 1;

      panelsToCreate.push({
        serial_number: serial,
        project_name: project,
        inverter: inverter,
        string_name: stringName,
        panel_index: panelIndex,
        brand_model: brand,
        wattage: wattage,
        status: status,
        technician_name: 'ช่างพาเลท',
        notes: `สร้างอัตโนมัติจากช่วงรหัสพาเลท (#${start} - #${end})`,
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
        const res = await fetch('/api/database/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panels: panelsToCreate })
        });
        if (!res.ok) {
          const chunkSize = 10;
          for (let c = 0; c < panelsToCreate.length; c += chunkSize) {
            const chunk = panelsToCreate.slice(c, c + chunkSize);
            await Promise.all(chunk.map(p => fetch('/api/panels', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p)
            })));
          }
        }
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

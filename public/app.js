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

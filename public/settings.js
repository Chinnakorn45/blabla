/**
 * SolarTrack - Settings Manager
 * Handles persistent app settings via localStorage.
 */

const SETTINGS_KEY = 'solartrack_settings';

const DEFAULT_SETTINGS = {
  defaultBrand: '',
  defaultWattage: 550,
  defaultTechnician: '',
  brands: [] // saved brand list for quick select
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function getSetting(key) {
  return loadSettings()[key] ?? DEFAULT_SETTINGS[key];
}

function setSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  return saveSettings(settings);
}

// ── Settings UI Controller ──────────────────────────────────────────────────

class SettingsManager {
  constructor() {
    this.settings = loadSettings();
  }

  load() {
    this.settings = loadSettings();
    return this.settings;
  }

  save(updates) {
    this.settings = { ...this.settings, ...updates };
    saveSettings(this.settings);
  }

  getDefaultBrand() {
    return this.settings.defaultBrand || '';
  }

  getDefaultWattage() {
    return this.settings.defaultWattage || 550;
  }

  getDefaultTechnician() {
    return this.settings.defaultTechnician || '';
  }

  getBrands() {
    return this.settings.brands || [];
  }

  addBrand(brandName) {
    if (!brandName || !brandName.trim()) return;
    const brands = this.getBrands();
    const clean = brandName.trim();
    if (!brands.includes(clean)) {
      brands.push(clean);
      this.save({ brands });
    }
  }

  removeBrand(brandName) {
    const brands = this.getBrands().filter(b => b !== brandName);
    this.save({ brands });
  }

  /** Render the settings view into #view-settings */
  renderSettingsView() {
    this.load();
    const container = document.getElementById('settings-brand-list');
    const defaultBrandInput = document.getElementById('settings-default-brand');
    const defaultWattageInput = document.getElementById('settings-default-wattage');
    const defaultTechInput = document.getElementById('settings-default-tech');

    if (defaultBrandInput) defaultBrandInput.value = this.settings.defaultBrand || '';
    if (defaultWattageInput) defaultWattageInput.value = this.settings.defaultWattage || 550;
    if (defaultTechInput) defaultTechInput.value = this.settings.defaultTechnician || '';

    this.renderBrandList();
  }

  renderBrandList() {
    const container = document.getElementById('settings-brand-list');
    if (!container) return;
    const brands = this.getBrands();
    if (brands.length === 0) {
      container.innerHTML = '<p class="text-xs text-slate-400 text-center py-3">ยังไม่มียี่ห้อที่บันทึกไว้</p>';
      return;
    }
    container.innerHTML = brands.map(b => `
      <div class="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg border border-slate-200">
        <span class="text-xs font-medium text-slate-800 truncate">${b}</span>
        <button type="button" onclick="appSettings.removeBrandAndRefresh('${b.replace(/'/g, "\\'")}')"
          class="ml-2 text-rose-400 hover:text-rose-600 shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');
  }

  removeBrandAndRefresh(brandName) {
    this.removeBrand(brandName);
    this.renderBrandList();
    // If removed brand was default, clear default
    if (this.settings.defaultBrand === brandName) {
      this.save({ defaultBrand: '' });
      const el = document.getElementById('settings-default-brand');
      if (el) el.value = '';
    }
  }

  handleSaveDefaults() {
    const brand = document.getElementById('settings-default-brand')?.value.trim() || '';
    const wattage = parseInt(document.getElementById('settings-default-wattage')?.value, 10) || 550;
    const tech = document.getElementById('settings-default-tech')?.value.trim() || '';

    this.save({ defaultBrand: brand, defaultWattage: wattage, defaultTechnician: tech });

    // Auto-add brand to brand list if not empty and not already there
    if (brand) this.addBrand(brand);
    this.renderBrandList();

    // Show success feedback
    const btn = document.getElementById('btn-save-settings');
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = '✅ บันทึกแล้ว!';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1500);
    }
  }

  handleAddBrand() {
    const input = document.getElementById('settings-new-brand');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    this.addBrand(val);
    input.value = '';
    this.renderBrandList();

    // Update default brand datalist if exists
    this.updateBrandDatalist();
  }

  updateBrandDatalist() {
    const datalist = document.getElementById('brand-datalist');
    if (!datalist) return;
    const brands = this.getBrands();
    datalist.innerHTML = brands.map(b => `<option value="${b}">`).join('');
  }
}

// Global instance
const appSettings = new SettingsManager();


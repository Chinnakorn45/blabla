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
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      brands: Array.isArray(parsed.brands) ? parsed.brands.filter(b => typeof b === 'string' && b.trim()) : []
    };
  } catch (error) {
    console.warn('Unable to load saved settings:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.error('Unable to save settings:', error);
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
    const nextSettings = { ...this.settings, ...updates };
    if (!saveSettings(nextSettings)) return false;
    this.settings = nextSettings;
    return true;
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
    return Array.isArray(this.settings.brands) ? this.settings.brands : [];
  }

  addBrand(brandName) {
    if (!brandName || !brandName.trim()) return false;
    const brands = this.getBrands();
    const clean = brandName.trim();
    if (!brands.includes(clean)) {
      brands.push(clean);
      return this.save({ brands });
    }
    return true;
  }

  removeBrand(brandName) {
    const brands = this.getBrands().filter(b => b !== brandName);
    return this.save({ brands });
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
    this.updateBrandDatalist();
  }

  renderBrandList() {
    const container = document.getElementById('settings-brand-list');
    if (!container) return;
    const brands = this.getBrands();
    if (brands.length === 0) {
      container.innerHTML = '<p class="text-xs text-slate-400 text-center py-3">ยังไม่มียี่ห้อที่บันทึกไว้</p>';
      return;
    }
    container.replaceChildren();
    brands.forEach(brand => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg border border-slate-200';
      const name = document.createElement('span');
      name.className = 'text-xs font-medium text-slate-800 truncate';
      name.textContent = brand;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ml-2 text-rose-400 hover:text-rose-600 shrink-0';
      remove.setAttribute('aria-label', `Remove ${brand}`);
      remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener('click', () => this.removeBrandAndRefresh(brand));
      row.append(name, remove);
      container.appendChild(row);
    });
  }

  removeBrandAndRefresh(brandName) {
    const updates = { brands: this.getBrands().filter(b => b !== brandName) };
    if (this.settings.defaultBrand === brandName) updates.defaultBrand = '';
    if (!this.save(updates)) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
      return;
    }
    this.renderBrandList();
    this.updateBrandDatalist();
    const el = document.getElementById('settings-default-brand');
    if (el) el.value = this.settings.defaultBrand || '';
  }

  handleSaveDefaults() {
    const brand = document.getElementById('settings-default-brand')?.value.trim() || '';
    const wattage = parseInt(document.getElementById('settings-default-wattage')?.value, 10);
    const tech = document.getElementById('settings-default-tech')?.value.trim() || '';
    if (!Number.isInteger(wattage) || wattage < 1 || wattage > 2000) {
      if (typeof app !== 'undefined' && app) app.showToast('กำลังวัตต์ต้องอยู่ระหว่าง 1 ถึง 2000 Wp', 'warning');
      return;
    }

    const brands = this.getBrands();
    if (brand && !brands.includes(brand)) brands.push(brand);
    if (!this.save({ defaultBrand: brand, defaultWattage: wattage, defaultTechnician: tech, brands })) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
      return;
    }
    this.renderBrandList();
    this.updateBrandDatalist();

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
    if (!this.addBrand(val)) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกยี่ห้อได้', 'error');
      return;
    }
    input.value = '';
    this.renderBrandList();

    // Update default brand datalist if exists
    this.updateBrandDatalist();
    if (typeof app !== 'undefined' && app) app.showToast('เพิ่มยี่ห้อแล้ว', 'success');
  }

  updateBrandDatalist() {
    const datalist = document.getElementById('brand-datalist');
    if (!datalist) return;
    datalist.replaceChildren();
    this.getBrands().forEach(brand => {
      const option = document.createElement('option');
      option.value = brand;
      datalist.appendChild(option);
    });
  }
}

// Global instance
const appSettings = new SettingsManager();

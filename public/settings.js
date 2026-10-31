/**
 * SolarTrack - Settings Manager
 * Handles persistent app settings via localStorage.
 */

const SETTINGS_KEY = 'solartrack_settings';

const DEFAULT_SETTINGS = {
  defaultTechnician: '',
  brands: []
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const legacyWattage = Number(parsed.defaultWattage);
    const fallbackWattage = Number.isInteger(legacyWattage) && legacyWattage >= 1 && legacyWattage <= 2000
      ? legacyWattage
      : 550;
    const brands = [];
    const seen = new Set();
    const addBrand = (brand, wattage = fallbackWattage) => {
      const name = typeof brand === 'string' ? brand.trim() : '';
      const watts = Number(wattage);
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) return;
      brands.push({
        name,
        wattage: Number.isInteger(watts) && watts >= 1 && watts <= 2000 ? watts : fallbackWattage
      });
      seen.add(key);
    };

    if (Array.isArray(parsed.brands)) {
      parsed.brands.forEach(brand => {
        if (typeof brand === 'string') addBrand(brand);
        else if (brand && typeof brand === 'object') addBrand(brand.name, brand.wattage);
      });
    }
    if (typeof parsed.defaultBrand === 'string') {
      addBrand(parsed.defaultBrand, fallbackWattage);
    }

    return {
      defaultTechnician: typeof parsed.defaultTechnician === 'string' ? parsed.defaultTechnician : '',
      brands
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
    return '';
  }

  getDefaultWattage() {
    return 550;
  }

  getDefaultTechnician() {
    return this.settings.defaultTechnician || '';
  }

  getBrands() {
    return this.getBrandEntries().map(brand => brand.name);
  }

  getBrandEntries() {
    return Array.isArray(this.settings.brands) ? this.settings.brands : [];
  }

  getWattageForBrand(brandName) {
    const cleanName = String(brandName || '').trim();
    if (!cleanName) return null;
    const brand = this.getBrandEntries().find(entry =>
      entry.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase()
    );
    return brand?.wattage || null;
  }

  addBrand(brandName, wattage) {
    const clean = String(brandName || '').trim();
    const watts = Number(wattage);
    if (!clean || !Number.isInteger(watts) || watts < 1 || watts > 2000) return false;
    if (this.getBrandEntries().some(brand => brand.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) return false;
    return this.save({ brands: [...this.getBrandEntries(), { name: clean, wattage: watts }] });
  }

  updateBrandWattage(brandName, wattage) {
    const watts = Number(wattage);
    if (!Number.isInteger(watts) || watts < 1 || watts > 2000) return false;
    const brands = this.getBrandEntries().map(brand =>
      brand.name === brandName ? { ...brand, wattage: watts } : brand
    );
    return this.save({ brands });
  }

  removeBrand(brandName) {
    const brands = this.getBrandEntries().filter(brand => brand.name !== brandName);
    return this.save({ brands });
  }

  /** Render the settings view into #view-settings */
  renderSettingsView() {
    this.load();
    this.renderBrandList();
    this.updateBrandDatalist();
  }

  renderBrandList() {
    const container = document.getElementById('settings-brand-list');
    if (!container) return;
    const brands = this.getBrandEntries();
    if (brands.length === 0) {
      container.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center"><i data-lucide="tag" class="w-6 h-6 mx-auto mb-2 text-slate-400"></i><p class="text-sm font-semibold text-slate-600">ยังไม่มีรุ่นแผง</p><p class="text-xs text-slate-400 mt-1">เพิ่มยี่ห้อ/รุ่นพร้อมกำลังวัตต์ด้านบน</p></div>';
      if (typeof app !== 'undefined' && app) app.refreshIcons();
      return;
    }
    container.replaceChildren();
    brands.forEach(brand => {
      const row = document.createElement('div');
      row.className = 'grid grid-cols-[minmax(0,1fr)_112px_auto_auto] items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm';
      const name = document.createElement('span');
      name.className = 'min-w-0 text-sm font-semibold text-slate-800 truncate';
      name.textContent = brand.name;
      const wattageWrap = document.createElement('label');
      wattageWrap.className = 'relative';
      const wattage = document.createElement('input');
      wattage.type = 'number';
      wattage.min = '1';
      wattage.max = '2000';
      wattage.step = '1';
      wattage.value = String(brand.wattage);
      wattage.className = 'w-full rounded-lg border border-slate-300 bg-white py-2 pl-2 pr-9 text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500';
      wattage.setAttribute('aria-label', `กำลังวัตต์ของ ${brand.name}`);
      wattageWrap.append(wattage);
      const unit = document.createElement('span');
      unit.className = 'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400';
      unit.textContent = 'Wp';
      wattageWrap.append(unit);
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 hover:bg-blue-100';
      save.textContent = 'บันทึก';
      save.addEventListener('click', () => this.handleSaveBrandWattage(brand.name, wattage.value));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'grid h-9 w-9 place-items-center rounded-lg text-rose-500 hover:bg-rose-50 hover:text-rose-700';
      remove.setAttribute('aria-label', `ลบ ${brand.name}`);
      remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener('click', () => this.removeBrandAndRefresh(brand.name));
      row.append(name, wattageWrap, save, remove);
      container.appendChild(row);
    });
  }

  handleSaveBrandWattage(brandName, wattage) {
    const watts = Number(wattage);
    if (!Number.isInteger(watts) || watts < 1 || watts > 2000) {
      if (typeof app !== 'undefined' && app) app.showToast('กำลังวัตต์ต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 2000 Wp', 'warning');
      return;
    }
    if (!this.updateBrandWattage(brandName, wattage)) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกกำลังวัตต์ได้', 'error');
      return;
    }
    this.renderBrandList();
    this.updateBrandDatalist();
    if (typeof app !== 'undefined' && app) app.showToast(`บันทึกกำลังวัตต์ของ "${brandName}" แล้ว`, 'success');
  }

  async removeBrandAndRefresh(brandName) {
    if (typeof app === 'undefined' || !app || !await app.confirmAction({
      title: 'ยืนยันการลบยี่ห้อ/รุ่น',
      message: `ลบ "${brandName}" ออกจากรายการที่บันทึกไว้หรือไม่?`,
      confirmText: 'ลบรายการ'
    })) return;

    if (!this.removeBrand(brandName)) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
      return;
    }
    this.renderBrandList();
    this.updateBrandDatalist();
    app.showToast(`ลบ "${brandName}" ออกจากรายการแล้ว`, 'success');
  }

  handleAddBrand() {
    const input = document.getElementById('settings-new-brand');
    const wattageInput = document.getElementById('settings-new-wattage');
    if (!input || !wattageInput) return;
    const val = input.value.trim();
    const wattage = Number(wattageInput.value);
    if (!val) {
      if (typeof app !== 'undefined' && app) app.showToast('กรุณาระบุชื่อยี่ห้อหรือรุ่นแผง', 'warning');
      input.focus();
      return;
    }
    if (!Number.isInteger(wattage) || wattage < 1 || wattage > 2000) {
      if (typeof app !== 'undefined' && app) app.showToast('กรุณากำหนดกำลังวัตต์ระหว่าง 1 ถึง 2000 Wp', 'warning');
      wattageInput.focus();
      return;
    }
    if (this.getBrands().some(brand => brand.toLocaleLowerCase() === val.toLocaleLowerCase())) {
      if (typeof app !== 'undefined' && app) app.showToast(`"${val}" มีอยู่ในรายการแล้ว`, 'info');
      return;
    }
    if (!this.addBrand(val, wattage)) {
      if (typeof app !== 'undefined' && app) app.showToast('ไม่สามารถบันทึกยี่ห้อได้', 'error');
      return;
    }
    input.value = '';
    wattageInput.value = '';
    this.renderBrandList();
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

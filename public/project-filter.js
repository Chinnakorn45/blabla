(function () {
  const BUILT_IN_PROJECTS = new Set([
    'Solar Farm Lopburi Phase 2',
    'Rooftop Factory Amata Chonburi',
    'Floating Solar Ubon Ratchathani',
    'คลังสินค้ากลาง (Central Warehouse)'
  ]);

  function normalizeProjectName(value) {
    return String(value || '').trim();
  }

  function filterUserProjects(projects) {
    if (!Array.isArray(projects)) return [];

    const cleaned = [];
    const seen = new Set();

    projects.forEach((item) => {
      const name = normalizeProjectName(item);
      if (!name || BUILT_IN_PROJECTS.has(name)) return;
      if (seen.has(name)) return;
      seen.add(name);
      cleaned.push(name);
    });

    return cleaned;
  }

  function filterProjectEntries(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => {
      const name = normalizeProjectName(entry && entry.project_name ? entry.project_name : entry);
      return name && !BUILT_IN_PROJECTS.has(name);
    });
  }

  function refreshVisibleProjectFields() {
    const selects = [
      document.getElementById('filter-project'),
      document.getElementById('input-project'),
      document.getElementById('db-filter-project'),
      document.getElementById('batch-project-select'),
      document.getElementById('clear-target-project'),
      document.getElementById('pallet-project'),
      document.getElementById('manual-preset-project'),
      document.getElementById('bulk-preset-project'),
      document.getElementById('turbo-preset-project')
    ];

    selects.forEach((element) => {
      if (!element) return;
      const selected = element.value;
      const options = Array.from(element.options || []).filter((opt) => {
        const value = normalizeProjectName(opt.value);
        return value && !BUILT_IN_PROJECTS.has(value);
      });
      element.innerHTML = options.length
        ? options.map((opt) => `<option value="${opt.value}">${opt.textContent}</option>`).join('')
        : '<option value="">-- ไม่มีโครงการ --</option>';

      if (selected && !BUILT_IN_PROJECTS.has(normalizeProjectName(selected))) {
        element.value = selected;
      }
    });
  }

  function applyProjectFiltering() {
    if (!window.app) return;

    const originalLoadProjects = window.app.loadProjects?.bind(window.app);
    if (originalLoadProjects) {
      window.app.loadProjects = async function () {
        const result = await originalLoadProjects();
        if (Array.isArray(this.cachedProjectsList)) {
          this.cachedProjectsList = filterUserProjects(this.cachedProjectsList);
        }
        refreshVisibleProjectFields();
        return result;
      };
    }

    const originalPopulateDbProjectDropdowns = window.app.populateDbProjectDropdowns?.bind(window.app);
    if (originalPopulateDbProjectDropdowns) {
      window.app.populateDbProjectDropdowns = async function () {
        const result = await originalPopulateDbProjectDropdowns();
        refreshVisibleProjectFields();
        return result;
      };
    }

    const originalLoadDbProjects = window.app.loadDbProjects?.bind(window.app);
    if (originalLoadDbProjects) {
      window.app.loadDbProjects = async function () {
        const result = await originalLoadDbProjects();
        if (Array.isArray(this.cachedProjects)) {
          this.cachedProjects = this.cachedProjects.filter((proj) => {
            const name = normalizeProjectName(proj && proj.name ? proj.name : proj);
            return name && !BUILT_IN_PROJECTS.has(name);
          });
        }
        refreshVisibleProjectFields();
        return result;
      };
    }

    const originalInitLocalStorageMock = window.app.initLocalStorageMock?.bind(window.app);
    if (originalInitLocalStorageMock) {
      window.app.initLocalStorageMock = function () {
        const result = originalInitLocalStorageMock();
        const raw = JSON.parse(localStorage.getItem('solartrack_panels') || '[]');
        const cleaned = filterProjectEntries(raw).map((item) => ({ ...item, project_name: normalizeProjectName(item.project_name) }));
        if (cleaned.length !== raw.length) {
          localStorage.setItem('solartrack_panels', JSON.stringify(cleaned));
        }
        return result;
      };
    }
  }

  function waitForApp() {
    if (!window.app) {
      setTimeout(waitForApp, 200);
      return;
    }
    applyProjectFiltering();
    refreshVisibleProjectFields();
    setTimeout(() => {
      if (typeof window.app.loadProjects === 'function') {
        window.app.loadProjects();
      }
    }, 150);
  }

  waitForApp();
})();

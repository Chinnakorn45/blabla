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

  function isBuiltInProject(name) {
    return BUILT_IN_PROJECTS.has(normalizeProjectName(name));
  }

  function sanitizeProjectList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list
      .map(item => normalizeProjectName(item))
      .filter(value => {
        if (!value || isBuiltInProject(value) || seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  }

  function cleanProjectRecordList(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(item => {
      const name = normalizeProjectName(item && item.project_name ? item.project_name : item);
      if (item && typeof item === 'object' && item.status === 'warehouse') return true;
      return name && !isBuiltInProject(name);
    });
  }

  function removeBuiltInSelectOptions() {
    const selectorIds = [
      'filter-project',
      'input-project',
      'db-filter-project',
      'batch-project-select',
      'clear-target-project',
      'pallet-project',
      'manual-preset-project',
      'bulk-preset-project',
      'turbo-preset-project',
      'edit-project'
    ];

    selectorIds.forEach((id) => {
      const node = document.getElementById(id);
      if (!node) return;

      const selected = node.value;
      const filtered = Array.from(node.options || []).filter((opt) => {
        const v = normalizeProjectName(opt.value);
        return !!v && !isBuiltInProject(v);
      });

      node.innerHTML = filtered.length
        ? filtered.map((opt) => `<option value="${opt.value}">${opt.textContent}</option>`).join('')
        : '<option value="">-- ไม่มีโครงการ --</option>';

      if (selected && !isBuiltInProject(selected)) {
        node.value = selected;
      }
    });
  }

  function removeBuiltInProjectsFromStorage() {
    try {
      const localKey = 'solartrack_panels';
      const raw = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (!Array.isArray(raw)) return;

      const cleaned = cleanProjectRecordList(raw).map((item) => {
        if (typeof item === 'object' && item !== null && item.project_name) {
          return { ...item, project_name: normalizeProjectName(item.project_name) };
        }
        return item;
      });

      if (cleaned.length !== raw.length) {
        localStorage.setItem(localKey, JSON.stringify(cleaned));
      }
    } catch (e) {
      console.warn('project filter cleanup failed:', e);
    }
  }

  function patchProjectFiltering() {
    if (!window.app) {
      setTimeout(patchProjectFiltering, 180);
      return;
    }

    const originalLoadProjects = window.app.loadProjects?.bind(window.app);
    if (originalLoadProjects) {
      window.app.loadProjects = async function () {
        const result = await originalLoadProjects();
        if (Array.isArray(this.cachedProjectsList)) {
          this.cachedProjectsList = sanitizeProjectList(this.cachedProjectsList);
        }
        removeBuiltInSelectOptions();
        return result;
      };
    }

    const originalPopulateDbProjectDropdowns = window.app.populateDbProjectDropdowns?.bind(window.app);
    if (originalPopulateDbProjectDropdowns) {
      window.app.populateDbProjectDropdowns = async function () {
        const result = await originalPopulateDbProjectDropdowns();
        removeBuiltInSelectOptions();
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
            return !!name && !isBuiltInProject(name);
          });
        }
        removeBuiltInSelectOptions();
        return result;
      };
    }

    removeBuiltInProjectsFromStorage();
    removeBuiltInSelectOptions();
    setTimeout(() => {
      if (typeof window.app.loadProjects === 'function') {
        window.app.loadProjects();
      }
      if (typeof window.app.loadDbProjects === 'function') {
        window.app.loadDbProjects();
      }
    }, 150);
  }

  patchProjectFiltering();
})();

/* Tool register feature methods, loaded before the main app is initialized. */
Object.assign(SolarTrackingApp.prototype, {
  async loadEquipmentData() {
    try {
      if (this.isMockMode) {
        this.toolAssets = JSON.parse(localStorage.getItem('solartrack_tool_assets') || '[]');
        this.toolEvents = JSON.parse(localStorage.getItem('solartrack_tool_events') || '[]');
        const tools = this.toolAssets;
        this.toolRegistry = {
          tools,
          recent: this.toolEvents.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12).map(event => {
            const tool = tools.find(item => Number(item.id) === Number(event.tool_id));
            return { ...event, asset_code: tool?.asset_code || '', tool_name: tool?.name || '' };
          }),
          stats: {
            total: tools.length,
            available: tools.filter(tool => tool.status === 'available').length,
            pending: tools.filter(tool => tool.status === 'pending_approval').length,
            borrowed: tools.filter(tool => tool.status === 'borrowed').length,
            repair: tools.filter(tool => ['maintenance', 'damaged', 'lost'].includes(tool.status)).length
          }
        };
      } else {
        this.toolRegistry = await this.requestJson('/api/tools');
        this.toolAssets = this.toolRegistry.tools || [];
        this.toolEvents = this.toolRegistry.recent || [];
      }
      this.renderToolRegistry();
      const deepLinkToolId = new URLSearchParams(window.location.search).get('tool');
      if (deepLinkToolId && !this.openedToolDeepLink) {
        this.openedToolDeepLink = true;
        await this.openToolDetail(deepLinkToolId);
      }
    } catch (error) {
      console.error('Unable to load tool register:', error);
      this.showToast(`โหลดทะเบียนเครื่องมือไม่สำเร็จ: ${error.message}`, 'error');
    }
  },

  renderToolRegistry() {
    const rowsContainer = document.getElementById('tool-register-rows');
    if (!rowsContainer) return;
    const stats = this.toolRegistry?.stats || {};
    for (const [key, value] of Object.entries({ total: 'total', available: 'available', pending: 'pending', borrowed: 'borrowed', repair: 'repair' })) {
      const target = document.getElementById(`tool-stat-${key}`);
      if (target) target.textContent = String(stats[value] || 0);
    }
    const autoCodeField = document.getElementById('tool-auto-code');
    if (autoCodeField) autoCodeField.value = this.nextToolAssetCode();
    const query = (document.getElementById('tool-register-search')?.value || '').trim().toLocaleLowerCase();
    const status = document.getElementById('tool-register-status')?.value || 'all';
    const filtered = (this.toolAssets || []).filter(tool => {
      const searchable = [tool.asset_code, tool.name, tool.serial_number, tool.category, tool.location, tool.current_holder, tool.current_project]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || searchable.includes(query)) && (status === 'all' || tool.status === status);
    });
    rowsContainer.innerHTML = filtered.length ? filtered.map(tool => `
      <tr class="hover:bg-slate-50/80">
        <td class="px-4 py-3"><div class="text-xs font-bold text-slate-800">${this.escapeHtml(tool.asset_code)}</div><div class="mt-0.5 text-sm font-semibold text-slate-700">${this.escapeHtml(tool.name)}</div><div class="text-[11px] text-slate-500">${this.escapeHtml([tool.brand, tool.model, tool.serial_number].filter(Boolean).join(' · ') || 'ไม่มีข้อมูลรุ่น / Serial')}</div></td>
        <td class="px-4 py-3 text-xs text-slate-600">${this.escapeHtml(tool.category || '-')}</td>
        <td class="px-4 py-3 text-xs text-slate-600">${this.escapeHtml(tool.status === 'borrowed' ? tool.current_project || '-' : tool.location || '-')}<div class="mt-0.5 text-[11px] text-slate-400">${tool.status === 'borrowed' ? `ผู้ถือครอง: ${this.escapeHtml(tool.current_holder || '-')}` : 'สถานที่จัดเก็บ'}</div></td>
        <td class="px-4 py-3">${this.toolStatusPill(tool.status)}</td>
        <td class="px-4 py-3 text-right"><div class="flex justify-end gap-2"><button type="button" onclick="app.editToolAsset(${Number(tool.id)})" class="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-amber-50 hover:text-amber-700">แก้ไข</button><button type="button" onclick="app.openToolDetail(${Number(tool.id)})" class="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-violet-50 hover:text-violet-700">รายละเอียด</button></div></td>
      </tr>`).join('') : `<tr><td colspan="5" class="p-8 text-center text-xs text-slate-400">${this.toolAssets?.length ? 'ไม่พบเครื่องมือตามตัวกรอง' : 'ยังไม่มีเครื่องมือในทะเบียน กด “ลงทะเบียนเครื่องมือ” เพื่อเริ่มต้น'}</td></tr>`;
    const recentContainer = document.getElementById('tool-recent-activity');
    if (recentContainer) {
      const recent = this.toolRegistry?.recent || [];
      recentContainer.innerHTML = recent.length ? `<div class="ml-2 border-l-2 border-violet-100 pl-5">${recent.map(event => `
        <article class="relative pb-4 last:pb-0"><span class="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-violet-300 bg-white"></span>
          <div class="text-xs font-bold text-slate-800">${this.escapeHtml(event.title)}</div>
          <div class="mt-0.5 text-xs text-violet-700">${this.escapeHtml(event.asset_code)} · ${this.escapeHtml(event.tool_name)}</div>
          <div class="mt-0.5 text-[11px] text-slate-500">${this.escapeHtml(event.project_name || event.detail || '-')}</div>
          <div class="mt-0.5 text-[10px] text-slate-400">${this.formatToolDate(event.created_at)} · บันทึกโดย ${this.escapeHtml(event.actor || '-')}</div>
          ${event.requested_by ? `<div class="mt-0.5 text-[10px] text-slate-400">ผู้ขอเบิก ${this.escapeHtml(event.requested_by)}</div>` : ''}
        </article>`).join('')}</div>` : '<div class="py-8 text-center text-xs text-slate-400">ยังไม่มีกิจกรรม</div>';
    }
    this.refreshIcons();
  },

  toolStatusPill(status) {
    const labels = { available: 'พร้อมใช้งาน', pending_approval: 'รออนุมัติ', borrowed: 'อยู่หน้างาน', maintenance: 'กำลังซ่อม', damaged: 'ชำรุด', lost: 'สูญหาย' };
    const styles = { available: 'bg-emerald-50 text-emerald-700', pending_approval: 'bg-amber-50 text-amber-700', borrowed: 'bg-blue-50 text-blue-700', maintenance: 'bg-amber-50 text-amber-700', damaged: 'bg-rose-50 text-rose-700', lost: 'bg-slate-200 text-slate-700' };
    return `<span class="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles[status] || 'bg-slate-100 text-slate-600'}">${labels[status] || this.escapeHtml(status || 'ไม่ระบุ')}</span>`;
  },

  formatToolDate(value) {
    if (!value) return '-';
    const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? this.escapeHtml(value) : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  },

  nextToolAssetCode() {
    const nextSequence = Math.max(0, ...(this.toolAssets || []).map(tool => Number(/^TL-(\d+)$/i.exec(String(tool.asset_code || ''))?.[1]) || 0)) + 1;
    return `TL-${String(nextSequence).padStart(4, '0')}`;
  },

  toggleToolRegistration(force) {
    const panel = document.getElementById('tool-registration-panel');
    if (!panel) return;
    const shouldShow = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !shouldShow);
    if (shouldShow) {
      const autoCodeField = document.getElementById('tool-auto-code');
      if (autoCodeField) autoCodeField.value = this.nextToolAssetCode();
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },

  async editToolAsset(id) {
    const panel = document.getElementById('tool-registration-panel');
    if (!panel) return;
    try {
      let tool;
      if (this.isMockMode) {
        tool = (this.toolAssets || []).find(item => Number(item.id) === Number(id));
        if (!tool) throw new Error('ไม่พบเครื่องมือ');
      } else {
        const result = await this.requestJson(`/api/tools/${encodeURIComponent(id)}`);
        tool = result.tool;
      }
      this.editingToolId = Number(tool.id);
      const form = document.getElementById('tool-asset-form');
      const set = (name, value) => { const field = form?.elements?.[name]; if (field) field.value = value ?? ''; };
      set('name', tool.name);
      set('category', tool.category);
      set('location', tool.location);
      set('brand', tool.brand);
      set('model', tool.model);
      set('serial_number', tool.serial_number);
      set('purchase_date', tool.purchase_date);
      set('condition_note', tool.condition_note);
      set('actor', '');
      const autoCodeField = document.getElementById('tool-auto-code');
      if (autoCodeField) autoCodeField.value = tool.asset_code || '';
      const photoInput = form?.querySelector('input[name="photo"]');
      if (photoInput) photoInput.value = '';
      this.editingToolExistingPhoto = tool.photo || '';
      const wrap = document.getElementById('tool-photo-preview-wrap');
      const img = document.getElementById('tool-photo-preview');
      if (img && wrap) {
        if (tool.photo) {
          img.src = tool.photo;
          wrap.classList.remove('hidden');
        } else wrap.classList.add('hidden');
      }
      const header = panel.querySelector('h3');
      const submit = form?.querySelector('button[type="submit"]');
      if (header) header.textContent = `แก้ไขเครื่องมือ · ${tool.asset_code || tool.name}`;
      if (submit) submit.textContent = 'บันทึกการแก้ไข';
      const cancel = form?.querySelector('button[type="button"]');
      if (cancel) cancel.setAttribute('onclick', 'app.cancelToolEdit()');
      panel.classList.remove('hidden');
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      this.showToast(`เปิดหน้าแก้ไขไม่สำเร็จ: ${error.message}`, 'error');
    }
  },

  cancelToolEdit() {
    this.editingToolId = null;
    this.editingToolExistingPhoto = '';
    const form = document.getElementById('tool-asset-form');
    form?.reset();
    document.getElementById('tool-photo-preview-wrap')?.classList.add('hidden');
    const panel = document.getElementById('tool-registration-panel');
    const header = panel?.querySelector('h3');
    const submit = form?.querySelector('button[type="submit"]');
    if (header) header.textContent = 'ลงทะเบียนเครื่องมือใหม่';
    if (submit) submit.textContent = 'บันทึกทะเบียน';
    const cancel = form?.querySelector('button[type="button"]');
    if (cancel) cancel.setAttribute('onclick', 'app.toggleToolRegistration(false)');
    this.toggleToolRegistration(false);
  },

  async saveToolAsset(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    const editingId = this.editingToolId || null;
    try {
      const photo = await this.readToolPhotoFile(form);
      if (photo) payload.photo = photo;
      else delete payload.photo;
      if (editingId && this.editingToolExistingPhoto) payload.existing_photo = this.editingToolExistingPhoto;
      if (this.isMockMode) {
        this.toolAssets ||= [];
        this.toolEvents ||= [];
        const now = new Date().toISOString();
        if (editingId) {
          const tool = this.toolAssets.find(item => Number(item.id) === Number(editingId));
          if (!tool) throw new Error('ไม่พบเครื่องมือที่ต้องการแก้ไข');
          Object.assign(tool, {
            name: payload.name.trim(),
            category: payload.category || '',
            brand: payload.brand || '',
            model: payload.model || '',
            serial_number: payload.serial_number || '',
            location: payload.location || '',
            condition_note: payload.condition_note || '',
            purchase_date: payload.purchase_date || '',
            photo: photo || this.editingToolExistingPhoto || '',
            updated_at: now
          });
        } else {
          const nextId = Math.max(0, ...this.toolAssets.map(tool => Number(tool.id) || 0)) + 1;
          const assetCode = this.nextToolAssetCode();
          const tool = { id: nextId, ...payload, asset_code: assetCode, name: payload.name.trim(), status: 'available', current_holder: '', current_project: '', expected_return_at: '', created_at: now, updated_at: now };
          this.toolAssets.push(tool);
          this.toolEvents.push({ id: Date.now() + 1, tool_id: tool.id, event_type: 'registered', title: 'ลงทะเบียนเครื่องมือ', actor: payload.actor || '', detail: payload.condition_note || '', created_at: now });
        }
        localStorage.setItem('solartrack_tool_assets', JSON.stringify(this.toolAssets));
        localStorage.setItem('solartrack_tool_events', JSON.stringify(this.toolEvents));
      } else {
        await this.requestJson(editingId ? `/api/tools/${encodeURIComponent(editingId)}` : '/api/tools', {
          method: editingId ? 'PUT' : 'POST',
          body: payload
        });
      }
      const wasEditing = Boolean(editingId);
      this.editingToolId = null;
      this.editingToolExistingPhoto = '';
      form.reset();
      document.getElementById('tool-photo-preview-wrap')?.classList.add('hidden');
      const header = document.getElementById('tool-registration-panel')?.querySelector('h3');
      const submit = form.querySelector('button[type="submit"]');
      if (header) header.textContent = 'ลงทะเบียนเครื่องมือใหม่';
      if (submit) submit.textContent = 'บันทึกทะเบียน';
      const cancel = form.querySelector('button[type="button"]');
      if (cancel) cancel.setAttribute('onclick', 'app.toggleToolRegistration(false)');
      this.toggleToolRegistration(false);
      await this.loadEquipmentData();
      this.showToast(wasEditing ? 'บันทึกการแก้ไขเครื่องมือแล้ว' : 'ลงทะเบียนเครื่องมือแล้ว', 'success');
    } catch (error) {
      this.showToast(`บันทึกทะเบียนไม่สำเร็จ: ${error.message}`, 'error');
    }
  },

  previewToolPhoto(input) {
    const wrap = document.getElementById('tool-photo-preview-wrap');
    const img = document.getElementById('tool-photo-preview');
    if (!input || !input.files?.[0]) {
      wrap?.classList.add('hidden');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (img && wrap) {
        img.src = reader.result;
        wrap.classList.remove('hidden');
      }
    };
    reader.readAsDataURL(input.files[0]);
  },

  readToolPhotoFile(form) {
    return new Promise((resolve) => {
      const input = form.querySelector('input[name="photo"]');
      const file = input?.files?.[0];
      input.value = '';
      document.getElementById('tool-photo-preview-wrap')?.classList.add('hidden');
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          try {
            const maxSide = 1024;
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } catch {
            resolve(String(reader.result || '') || null);
          }
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  },

  async openToolDetail(id) {
    try {
      let result;
      if (this.isMockMode) {
        const tool = this.toolAssets.find(item => Number(item.id) === Number(id));
        if (!tool) throw new Error('ไม่พบเครื่องมือ');
        result = { tool, events: this.toolEvents.filter(item => Number(item.tool_id) === Number(id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) };
      } else result = await this.requestJson(`/api/tools/${encodeURIComponent(id)}`);
      this.selectedTool = result.tool;
      this.selectedToolEvents = result.events || [];
      this.renderToolDetail();
      const modal = document.getElementById('tool-detail-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      this.refreshIcons();
    } catch (error) {
      this.showToast(`เปิดรายละเอียดไม่สำเร็จ: ${error.message}`, 'error');
    }
  },

  renderToolDetail() {
    const tool = this.selectedTool;
    const title = document.getElementById('tool-detail-title');
    const content = document.getElementById('tool-detail-content');
    if (!tool || !content) return;
    title.textContent = `${tool.name} · ${tool.asset_code}`;
    const actions = this.qrToolMode
      ? (tool.status === 'available'
        ? [['checkout_request', 'ขอเบิก', 'arrow-up-right']]
        : tool.status === 'borrowed' ? [['return', 'คืนเครื่องมือ', 'corner-down-left']] : [])
      : tool.status === 'available'
      ? [['checkout_request', 'ขอเบิก', 'arrow-up-right'], ['maintenance', 'ส่งซ่อม', 'wrench'], ['damaged', 'แจ้งชำรุด', 'triangle-alert'], ['lost', 'แจ้งสูญหาย', 'circle-help']]
      : tool.status === 'pending_approval'
        ? [['approve', 'อนุมัติ', 'circle-check'], ['reject', 'ปฏิเสธ', 'circle-x']]
      : tool.status === 'borrowed'
        ? [['return', 'รับคืน', 'corner-down-left'], ['damaged', 'แจ้งชำรุด', 'triangle-alert'], ['lost', 'แจ้งสูญหาย', 'circle-help']]
        : tool.status === 'maintenance'
          ? [['repair_complete', 'ปิดงานซ่อม', 'circle-check']]
          : tool.status === 'damaged'
            ? [['maintenance', 'ส่งซ่อม', 'wrench']]
            : [];
    const detailCards = [
      ['หมวดหมู่', tool.category], ['ยี่ห้อ / รุ่น', [tool.brand, tool.model].filter(Boolean).join(' / ')],
      ['Serial Number', tool.serial_number], ['สถานที่จัดเก็บ', tool.location], ['วันที่ซื้อ', tool.purchase_date],
      ['สภาพ / หมายเหตุ', tool.condition_note]
    ];
    const photoBlock = tool.photo
      ? `<div class="mt-4"><div class="text-[10px] font-semibold text-slate-400">รูปเครื่องมือ</div><a href="${tool.photo}" target="_blank" rel="noopener" class="mt-2 block"><img src="${tool.photo}" alt="รูป ${this.escapeHtml(tool.asset_code)}" class="max-h-64 w-auto cursor-zoom-in rounded-xl border border-slate-200 bg-white object-contain shadow-sm"></a></div>`
      : '';
    content.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3">${this.toolStatusPill(tool.status)}<div class="flex flex-wrap gap-2">${this.qrToolMode ? '' : `<button type="button" onclick="app.editToolAsset(${Number(tool.id)}); app.closeToolDetail()" class="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-100"><i data-lucide="pencil" class="h-3.5 w-3.5"></i>แก้ไข / เปลี่ยนรูป</button><button type="button" onclick="app.toggleToolQr()" class="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-violet-50"><i data-lucide="qr-code" class="h-3.5 w-3.5"></i>QR Code</button>`}${actions.map(([type, label, icon]) => `<button type="button" onclick="app.openToolEventForm('${type}', ${Number(tool.id)})" class="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-violet-50 hover:text-violet-700"><i data-lucide="${icon}" class="h-3.5 w-3.5"></i>${label}</button>`).join('')}</div></div>
      <div id="tool-qr-content" class="mt-3 hidden rounded-xl border border-slate-200 bg-slate-50 p-4 text-center"><div id="tool-qr-code" class="mx-auto flex min-h-40 justify-center"></div><div class="mt-2 text-[11px] text-slate-500">สแกนเพื่อเปิดทะเบียนเครื่องมือนี้</div><button type="button" onclick="app.printToolQr()" class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700"><i data-lucide="printer" class="h-3.5 w-3.5"></i>พิมพ์สติกเกอร์ QR</button></div>
      ${['borrowed', 'pending_approval'].includes(tool.status) ? `<div class="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">${tool.status === 'pending_approval' ? 'ผู้ขอเบิก' : 'ผู้ถือครอง'}: <b>${this.escapeHtml(tool.current_holder || '-')}</b> · ${this.escapeHtml(tool.current_project || '-')} ${tool.expected_return_at ? `· กำหนดคืน ${this.escapeHtml(tool.expected_return_at)}` : ''}</div>` : ''}
      ${photoBlock}
      <div class="mt-4 grid grid-cols-2 gap-3">${detailCards.map(([label, value]) => `<div class="rounded-xl border border-slate-100 bg-slate-50 p-3"><div class="text-[10px] font-semibold text-slate-400">${label}</div><div class="mt-1 break-words text-xs font-medium text-slate-700">${this.escapeHtml(value || '-')}</div></div>`).join('')}</div>
      <div class="mt-5 border-t border-slate-100 pt-4"><h4 class="text-sm font-bold text-slate-800">ไทม์ไลน์เครื่องมือ</h4><div class="mt-3 ml-2 border-l-2 border-violet-100 pl-5">${this.selectedToolEvents.length ? this.selectedToolEvents.map(event => `<article class="relative pb-5 last:pb-0"><span class="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-violet-300 bg-white"></span><div class="flex flex-wrap items-center justify-between gap-2"><b class="text-xs text-slate-800">${this.escapeHtml(event.title)}</b><time class="text-[10px] text-slate-400">${this.formatToolDate(event.created_at)}</time></div>${event.project_name ? `<div class="mt-1 text-xs text-violet-700">${this.escapeHtml(event.project_name)}</div>` : ''}${event.detail ? `<div class="mt-1 whitespace-pre-wrap text-xs text-slate-600">${this.escapeHtml(event.detail)}</div>` : ''}${event.requested_by ? `<div class="mt-1 text-[10px] text-slate-500">ผู้ขอเบิก ${this.escapeHtml(event.requested_by)}</div>` : ''}<div class="mt-1 text-[10px] text-slate-400">บันทึกโดย ${this.escapeHtml(event.actor || '-')}</div></article>`).join('') : '<div class="py-4 text-xs text-slate-400">ยังไม่มีประวัติ</div>'}</div></div>`;
    this.refreshIcons();
  },

  closeToolDetail() {
    const modal = document.getElementById('tool-detail-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  },

  toggleToolQr() {
    const panel = document.getElementById('tool-qr-content');
    if (!panel) return;
    const show = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show);
    if (!show) return;
    const qrRoot = document.getElementById('tool-qr-code');
    if (!window.QRCode) {
      qrRoot.textContent = 'โหลดตัวสร้าง QR Code ไม่สำเร็จ';
      return;
    }
    qrRoot.innerHTML = '';
    const url = `${window.location.origin}${window.location.pathname}?tool=${encodeURIComponent(this.selectedTool.id)}&scan=1`;
    new window.QRCode(qrRoot, { text: url, width: 180, height: 180 });
  },

  printToolQr() {
    const tool = this.selectedTool;
    const qrRoot = document.getElementById('tool-qr-code');
    if (!tool || !qrRoot) return;
    const canvas = qrRoot.querySelector('canvas');
    const image = qrRoot.querySelector('img');
    const qrData = canvas?.toDataURL('image/png') || image?.src;
    if (!qrData) return this.showToast('ยังสร้าง QR Code ไม่สำเร็จ กรุณากดปุ่ม QR Code อีกครั้ง', 'warning');
    const printWindow = window.open('', '_blank', 'width=500,height=420');
    if (!printWindow) return this.showToast('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปสำหรับเว็บไซต์นี้', 'warning');
    const model = [tool.brand, tool.model].filter(Boolean).join(' ');
    printWindow.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ป้ายเครื่องมือ ${this.escapeHtml(tool.asset_code)}</title><style>@page{size:60mm 40mm;margin:0}*{box-sizing:border-box}body{margin:0;width:60mm;height:40mm;font-family:Arial,Tahoma,sans-serif;color:#111}.label{width:60mm;height:40mm;padding:3mm;display:grid;grid-template-columns:1fr 24mm;gap:2mm;align-items:center}.code{font-size:15pt;font-weight:800;letter-spacing:.3px}.name{font-size:10pt;font-weight:700;margin-top:1mm}.meta{font-size:7pt;color:#444;margin-top:1mm;word-break:break-word}.qr{width:24mm;height:24mm;object-fit:contain}@media screen{body{margin:16px auto;box-shadow:0 0 0 1px #ddd}.label{background:white}}</style></head><body><main class="label"><div><div class="code">${this.escapeHtml(tool.asset_code)}</div><div class="name">${this.escapeHtml(tool.name)}</div><div class="meta">${this.escapeHtml(model || tool.serial_number || 'เครื่องมือช่าง')}</div>${tool.serial_number ? `<div class="meta">S/N: ${this.escapeHtml(tool.serial_number)}</div>` : ''}</div><img class="qr" alt="QR ${this.escapeHtml(tool.asset_code)}" src="${qrData}"></main><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250))<\/script></body></html>`);
    printWindow.document.close();
    printWindow.focus();
  },

  openToolEventForm(type, id) {
    const tool = this.toolAssets.find(item => Number(item.id) === Number(id));
    if (!tool) return this.showToast('ไม่พบเครื่องมือ', 'error');
    this.pendingToolEvent = { type, id: Number(id) };
    const titles = { checkout_request: 'ส่งคำขอเบิกเครื่องมือ', approve: 'อนุมัติคำขอเบิก', reject: 'ปฏิเสธคำขอเบิก', return: 'บันทึกรับคืนเครื่องมือ', maintenance: 'เปิดงานซ่อมบำรุง', repair_complete: 'ปิดงานซ่อมบำรุง', damaged: 'แจ้งเครื่องมือชำรุด', lost: 'แจ้งเครื่องมือสูญหาย' };
    document.getElementById('tool-event-title').textContent = `${titles[type]} · ${tool.asset_code}`;
    const form = document.getElementById('tool-event-form');
    const actorLabel = type === 'checkout_request' ? 'ผู้บันทึกคำขอ' : type === 'approve' ? 'ผู้ดำเนินการอนุมัติ' : 'ผู้บันทึก / ผู้รับผิดชอบ';
    const commonActor = `<label class="text-xs font-semibold text-slate-700">${actorLabel} *<input name="actor" required value="${this.escapeHtml(appSettings.getDefaultTechnician() || '')}" placeholder="ชื่อผู้บันทึก" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label>`;
    let fields = commonActor;
    if (type === 'checkout_request') fields += `<label class="text-xs font-semibold text-slate-700">ผู้ขอเบิกเครื่องมือ *<input name="requested_by" required placeholder="ชื่อผู้ขอเบิก" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label><label class="text-xs font-semibold text-slate-700">โครงการ / สถานที่ใช้งาน *<input name="project_name" required placeholder="ระบุโครงการหรือหน้างาน" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label><label class="text-xs font-semibold text-slate-700">กำหนดคืน<input name="expected_return_at" type="date" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label><label class="text-xs font-semibold text-slate-700">หมายเหตุ<textarea name="detail" rows="2" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></textarea></label>`;
    else if (type === 'approve') fields += `<p class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">ผู้ขอเบิก: ${this.escapeHtml(tool.current_holder || '-')} · ${this.escapeHtml(tool.current_project || '-')}</p>`;
    else if (type === 'reject') fields += `<label class="text-xs font-semibold text-slate-700">เหตุผลที่ปฏิเสธ *<textarea name="detail" required rows="2" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></textarea></label>`;
    else if (type === 'return') fields += `<label class="text-xs font-semibold text-slate-700">นำกลับเก็บที่<input name="location" value="${this.escapeHtml(tool.location || '')}" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label><label class="text-xs font-semibold text-slate-700">สภาพหลังคืน / หมายเหตุ *<textarea name="detail" required rows="2" placeholder="สภาพปกติ หรือระบุสิ่งที่พบ" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></textarea></label>`;
    else if (type === 'repair_complete') fields += `<label class="text-xs font-semibold text-slate-700">รายละเอียดการซ่อม *<textarea name="detail" required rows="3" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></textarea></label><label class="flex items-center gap-2 text-xs text-rose-700"><input name="mark_damaged" type="checkbox" class="h-4 w-4 rounded border-slate-300"> ยังชำรุดหลังซ่อม</label>`;
    else fields += `<label class="text-xs font-semibold text-slate-700">รายละเอียด *<textarea name="detail" required rows="3" placeholder="ระบุอาการหรือรายละเอียด" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></textarea></label>`;
    fields += `<div class="mt-1 flex justify-end gap-2"><button type="button" onclick="app.closeToolEventForm()" class="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-600">ยกเลิก</button><button type="submit" class="rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-bold text-white">บันทึกกิจกรรม</button></div>`;
    form.innerHTML = fields;
    const modal = document.getElementById('tool-event-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  },

  closeToolEventForm() {
    const modal = document.getElementById('tool-event-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  },

  async saveToolEvent(event) {
    event.preventDefault();
    if (!this.pendingToolEvent) return;
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    payload.type = this.pendingToolEvent.type;
    payload.mark_damaged = Boolean(payload.mark_damaged);
    if (payload.type === 'checkout_request' && String(payload.requested_by || '').trim().toLocaleLowerCase() === String(payload.actor || '').trim().toLocaleLowerCase()) {
      this.showToast('ผู้ขอเบิกและผู้บันทึกคำขอต้องเป็นคนละคน', 'error');
      return;
    }
    try {
      if (this.isMockMode) {
        const tool = this.toolAssets.find(item => Number(item.id) === this.pendingToolEvent.id);
        const transitions = { checkout_request: ['available', 'pending_approval'], approve: ['pending_approval', 'borrowed'], reject: ['pending_approval', 'available'], return: ['borrowed', 'available'], maintenance: [['available', 'damaged'], 'maintenance'], repair_complete: ['maintenance', payload.mark_damaged ? 'damaged' : 'available'], damaged: [['available', 'borrowed'], 'damaged'], lost: [['available', 'borrowed'], 'lost'] };
        const [from, to] = transitions[payload.type] || [];
        if (!tool || !(Array.isArray(from) ? from : [from]).includes(tool.status)) throw new Error('สถานะเครื่องมือเปลี่ยนไปแล้ว กรุณาโหลดข้อมูลใหม่');
        const now = new Date().toISOString();
        const previousProject = tool.current_project;
        tool.status = to;
        if (payload.type === 'checkout_request') Object.assign(tool, { current_holder: payload.requested_by, current_project: payload.project_name, expected_return_at: payload.expected_return_at || '' });
        if (['return', 'repair_complete', 'damaged', 'lost', 'reject'].includes(payload.type)) Object.assign(tool, { current_holder: '', current_project: '', ...(payload.type === 'return' || payload.type === 'reject' || payload.type === 'damaged' || payload.type === 'lost' ? { expected_return_at: '', location: payload.location || tool.location } : {}) });
        if (payload.type === 'damaged' || payload.type === 'lost') tool.expected_return_at = '';
        if (['return', 'repair_complete'].includes(payload.type)) tool.condition_note = payload.detail || tool.condition_note;
        tool.updated_at = now;
        const event = { id: Date.now(), tool_id: tool.id, event_type: payload.type, title: ({ checkout_request: 'ส่งคำขอเบิก', approve: 'อนุมัติการเบิก', reject: 'ปฏิเสธคำขอเบิก', return: 'รับคืนเข้าคลัง', maintenance: 'ส่งซ่อมบำรุง', repair_complete: 'ปิดงานซ่อม', damaged: 'บันทึกชำรุด', lost: 'บันทึกสูญหาย' })[payload.type], actor: payload.actor, requested_by: payload.requested_by || '', project_name: payload.project_name || previousProject || '', detail: payload.detail || '', created_at: now };
        this.toolEvents.push(event);
        localStorage.setItem('solartrack_tool_assets', JSON.stringify(this.toolAssets));
        localStorage.setItem('solartrack_tool_events', JSON.stringify(this.toolEvents));
      } else await this.requestJson(`/api/tools/${this.pendingToolEvent.id}/events`, { method: 'POST', body: payload });
      const toolId = this.pendingToolEvent.id;
      const type = this.pendingToolEvent.type;
      this.pendingToolEvent = null;
      this.closeToolEventForm();
      await this.loadEquipmentData();
      await this.openToolDetail(toolId);
      this.showToast(({ checkout_request: 'ส่งคำขอเบิกแล้ว', approve: 'อนุมัติคำขอเบิกแล้ว', reject: 'ปฏิเสธคำขอเบิกแล้ว', return: 'บันทึกรับคืนเครื่องมือแล้ว', maintenance: 'เปิดงานซ่อมแล้ว', repair_complete: 'ปิดงานซ่อมแล้ว', damaged: 'บันทึกสถานะชำรุดแล้ว', lost: 'บันทึกสถานะสูญหายแล้ว' })[type], 'success');
    } catch (error) {
      this.showToast(`บันทึกกิจกรรมไม่สำเร็จ: ${error.message}`, 'error');
    }
  },

  openToolStocktake() {
    if (!this.toolAssets?.length) return this.showToast('ยังไม่มีเครื่องมือให้ตรวจนับ', 'warning');
    const form = document.getElementById('tool-stocktake-form');
    const date = this.getLocalDateInputValue();
    form.innerHTML = `
      <label class="text-xs font-semibold text-slate-700">ชื่อรอบตรวจนับ<input name="round" required value="ตรวจนับ ${date}" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label>
      <label class="text-xs font-semibold text-slate-700">ผู้ตรวจนับ *<input name="actor" required value="${this.escapeHtml(appSettings.getDefaultTechnician() || '')}" placeholder="ชื่อผู้ตรวจนับ" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal"></label>
      <div class="max-h-[48vh] space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-2">${this.toolAssets.map(tool => `<div class="grid grid-cols-[auto_minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 rounded-lg bg-slate-50 p-2.5"><input type="checkbox" aria-label="พบ ${this.escapeHtml(tool.asset_code)} หรือไม่" data-stocktake-found="${Number(tool.id)}" class="h-4 w-4 rounded border-slate-300"><span class="min-w-0"><b class="block truncate text-xs text-slate-800">${this.escapeHtml(tool.asset_code)} · ${this.escapeHtml(tool.name)}</b><span class="text-[10px] text-slate-500">${this.escapeHtml(tool.current_project || tool.location || '-')} · ${this.toolStatusPill(tool.status)}</span></span><input type="text" data-stocktake-note="${Number(tool.id)}" placeholder="สภาพ / หมายเหตุ" class="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px]"></div>`).join('')}</div>
      <div class="flex justify-end gap-2"><button type="button" onclick="app.closeToolStocktake()" class="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-600">ยกเลิก</button><button type="submit" class="rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-bold text-white">บันทึกผลตรวจนับ</button></div>`;
    const modal = document.getElementById('tool-stocktake-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    this.refreshIcons();
  },

  closeToolStocktake() {
    const modal = document.getElementById('tool-stocktake-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  },

  async saveToolStocktake(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const round = String(fields.get('round') || '').trim();
    const actor = String(fields.get('actor') || '').trim();
    const tools = this.toolAssets.map(tool => ({
      tool,
      found: Boolean(form.querySelector(`[data-stocktake-found="${Number(tool.id)}"]`)?.checked),
      note: form.querySelector(`[data-stocktake-note="${Number(tool.id)}"]`)?.value.trim() || ''
    }));
    try {
      for (const item of tools) {
        const detail = `${round} · ${item.found ? 'พบอุปกรณ์' : 'ไม่พบอุปกรณ์'}${item.note ? ` · ${item.note}` : ''}`;
        if (this.isMockMode) {
          this.toolEvents.push({ id: Date.now() + Math.floor(Math.random() * 1000), tool_id: item.tool.id, event_type: 'stocktake', title: 'ตรวจนับสต็อก', actor, project_name: round, detail, created_at: new Date().toISOString() });
        } else {
          await this.requestJson(`/api/tools/${encodeURIComponent(item.tool.id)}/events`, { method: 'POST', body: { type: 'stocktake', actor, project_name: round, detail } });
        }
      }
      if (this.isMockMode) localStorage.setItem('solartrack_tool_events', JSON.stringify(this.toolEvents));
      this.closeToolStocktake();
      await this.loadEquipmentData();
      this.showToast(`บันทึกผลตรวจนับ ${tools.length} รายการแล้ว`, 'success');
    } catch (error) {
      if (this.isMockMode) localStorage.setItem('solartrack_tool_events', JSON.stringify(this.toolEvents));
      this.showToast(`บันทึกผลตรวจนับไม่สำเร็จ: ${error.message}`, 'error');
    }
  }
});

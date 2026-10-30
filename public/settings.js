(() => {
  'use strict';
  const get = id => document.getElementById(id);
  const dialog = get('settings-dialog'), form = get('settings-form'), content = get('settings-content'), result = get('settings-result'), save = get('settings-save');
  const make = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  let settings, rows = new Map();
  const close = () => dialog.close();
  get('settings-close').onclick = close; get('settings-cancel').onclick = close;
  function render(data) {
    settings = data; rows = new Map(); content.replaceChildren();
    const scope = make('section', 'settings-section');
    scope.append(make('h3', '', 'Monitored root'), make('p', 'settings-help', 'Only sessions whose workspace is inside this folder appear. Harness stores can be elsewhere.'));
    const rootInput = make('input', 'settings-root'); rootInput.id = 'settings-root'; rootInput.type = 'text'; rootInput.value = data.root.saved || data.root.active; rootInput.autocomplete = 'off'; rootInput.required = true;
    const rootLabel = make('label', 'settings-label', 'Folder'); rootLabel.htmlFor = rootInput.id; scope.append(rootLabel, rootInput);
    scope.append(make('p', 'settings-meta', 'Active: ' + data.root.active + ' · ' + data.root.source));
    if (data.root.overridden) scope.append(make('p', 'settings-notice', 'A command-line root takes precedence. To use a saved root, restart from the launch folder shown below without a root argument.'));
    scope.append(make('p', 'settings-help', 'Settings are stored for the launch folder: ' + data.root.configRoot)); content.append(scope);
    for (const provider of data.providers) {
      const section = make('section', 'settings-section'); const heading = make('div', 'settings-provider-heading');
      heading.append(make('h3', '', provider.label)); const mode = make('select'); mode.setAttribute('aria-label', provider.label + ' storage mode');
      for (const [value, label] of [['auto','Automatic'],['custom','Custom paths'],['disabled','Disabled']]) { const option = make('option', '', label); option.value = value; mode.append(option); }
      mode.value = provider.saved === null ? 'auto' : provider.saved.length ? 'custom' : 'disabled'; heading.append(mode); section.append(heading);
      section.append(make('p', 'settings-meta', 'Currently using: ' + provider.source));
      const active = make('ul', 'settings-active');
      if (!provider.active.length) active.append(make('li', '', 'No active stores'));
      for (const entry of provider.active) { const item = make('li'); item.append(make('span', 'settings-path', entry.path), make('span', 'settings-path-status', { ready: 'Available', missing: 'Missing', unreadable: 'Unreadable', invalid: 'Invalid type' }[entry.status] || entry.status)); active.append(item); }
      section.append(active);
      if (provider.overridden) section.append(make('p', 'settings-notice', provider.flag + ' overrides saved paths for this launch. Remove it when restarting to apply your changes.'));
      const editor = make('div', 'settings-path-editor'), list = make('div', 'settings-path-list');
      const add = make('button', 'settings-add', '+ Add path'); add.type = 'button';
      const row = value => {
        const container = make('div', 'settings-path-row'), input = make('input'); input.type = 'text'; input.autocomplete = 'off'; input.value = value; input.setAttribute('aria-label', provider.label + ' storage path');
        const remove = make('button', '', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + provider.label + ' path'); remove.onclick = () => container.remove();
        container.append(input, remove); list.append(container); return input;
      };
      for (const value of provider.saved ?? provider.active.map(item => item.path)) row(value);
      add.onclick = () => row('').focus(); editor.append(list, add);
      const hint = make('p', 'settings-help', provider.id === 'opencode' ? 'Enter a database file or a directory containing opencode.db.' : 'Enter absolute directory paths.'); editor.append(hint); section.append(editor);
      function sync() { editor.hidden = mode.value !== 'custom'; }
      mode.onchange = () => { sync(); if (mode.value === 'custom' && !list.children.length) row(''); }; sync();
      rows.set(provider.key, { mode, list }); content.append(section);
    }
    content.append(make('p', 'settings-restart', 'Changes are saved locally and take effect after restarting the dashboard. Missing stores can be saved.'));
  }
  get('settings-open').onclick = async () => {
    dialog.showModal(); content.textContent = 'Loading settings…'; result.textContent = ''; save.disabled = true;
    try { const response = await fetch('/api/settings'); if (!response.ok) throw new Error('Settings could not be loaded.'); render(await response.json()); save.disabled = false; }
    catch (error) { content.textContent = error.message; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); result.textContent = ''; save.disabled = true;
    const root = get('settings-root').value.trim(), providers = {};
    for (const [key, entry] of rows) providers[key] = entry.mode.value === 'auto' ? null : entry.mode.value === 'disabled' ? [] : [...entry.list.querySelectorAll('input')].map(input => input.value.trim()).filter(Boolean);
    if ([...rows.values()].some(entry => entry.mode.value === 'custom' && ![...entry.list.querySelectorAll('input')].some(input => input.value.trim()))) { result.textContent = 'Enter at least one path, or select Disabled.'; save.disabled = false; return; }
    try {
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitoredRoot: root === settings.root.configRoot ? null : root, providers }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Settings could not be saved.');
      const unavailable = Object.values(data.statuses).flat().filter(item => item.status !== 'ready');
      result.textContent = 'Saved. Restart the dashboard to apply changes.' + (unavailable.length ? ` ${unavailable.length} path(s) are missing or unreadable.` : '');
    } catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  };
})();

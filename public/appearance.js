(function (root) {
  'use strict';
  const designs = [
    { id: 'modern', name: 'Modern', type: 'Agent network', description: 'A live delegation network with agent nodes and tool activity.' }
  ];
  const themes = [
    { id: 'rounded', name: 'Rounded', type: 'Standard', description: 'Soft corners, outlined labels, and rounded controls.' },
    { id: 'chamfered', name: 'Chamfered', type: 'Angular', description: 'Cut corners, angular controls, and solid activity labels.' },
    { id: 'terminal', name: 'Terminal', type: 'Dense', description: 'Monospaced type and square, compact controls.' },
    { id: 'flat', name: 'Flat', type: 'Industrial', description: 'Crisp rectangular surfaces, clear rules, and proportional type.' },
    { id: 'layered', name: 'Layered', type: 'Soft depth', description: 'Recessed graph canvas and gently elevated surfaces.' },
    { id: 'glass', name: 'Glass', type: 'Floating', description: 'Translucent navigation and overlays with solid agent cards.' }
  ];
  const colors = typeof module === 'object' && module.exports ? require('./color-themes') : root.agentobsColors;
  const legacy = {
    default: ['tree', 'rounded', 'dark'], chamfered: ['tree', 'chamfered', 'dark'],
    paper: ['tree', 'rounded', 'light'], terminal: ['tree', 'terminal', 'dark'],
    blueprint: ['tree', 'rounded', 'dark'], signal: ['signal', 'rounded', 'dark'], orbit: ['orbit', 'rounded', 'dark']
  };
  function normalizeAppearance(saved = {}) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    if (!Object.hasOwn(saved, 'design') && !Object.hasOwn(saved, 'colors')) {
      if (['flat', 'layered', 'glass'].includes(saved.theme)) return { design: 'modern', theme: saved.theme, colors: 'dark' };
      const [, theme, colors] = typeof saved.theme === 'string' && Object.hasOwn(legacy, saved.theme) ? legacy[saved.theme] : legacy.default;
      return { design: 'modern', theme, colors };
    }
    // Earlier split preferences classified these visual treatments as designs.
    // Move the treatment into Theme while retaining the user's color choice.
    if (['paper', 'terminal', 'blueprint'].includes(saved.design)) saved = { ...saved, theme: saved.design, design: 'tree' };
    return {
      design: 'modern',
      theme: themes.some(item => item.id === saved.theme) ? saved.theme : 'rounded',
      colors: colors.some(item => item.id === saved.colors) ? saved.colors : ['paper', 'quiet-light'].includes(saved.colors) ? 'light' : 'dark'
    };
  }
  const luminance = hex => hex.match(/[a-f\d]{2}/gi).map(byte => parseInt(byte, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ink = hex => luminance(hex) > .179 ? '#000000' : '#ffffff';
  function paletteVariables(id) {
    const p = colors.find(item => item.id === id) || colors.find(item => item.id === 'dark');
    return {
      '--dashboard-accent': p.accent, '--dashboard-muted': p.muted, '--dashboard-sidebar': p.sidebar,
      '--dashboard-card': p.card, '--dashboard-hover': 'color-mix(in srgb, var(--dashboard-accent) 9%, var(--dashboard-card))',
      '--dashboard-selected': 'color-mix(in srgb, var(--dashboard-accent) 16%, var(--dashboard-card))',
      '--vscode-editor-background': p.background, '--vscode-editorWidget-background': p.card,
      '--vscode-foreground': p.foreground, '--vscode-descriptionForeground': p.muted, '--vscode-panel-border': p.border,
      '--vscode-focusBorder': p.accent, '--vscode-input-background': p.input, '--vscode-button-secondaryBackground': 'var(--dashboard-selected)',
      '--vscode-testing-iconPassed': p.green, '--vscode-editorWarning-foreground': p.amber, '--vscode-testing-iconFailed': p.red,
      '--accent-ink': ink(p.accent), '--green-ink': ink(p.green), '--amber-ink': ink(p.amber), '--red-ink': ink(p.red), '--muted-ink': ink(p.muted),
      '--tool-lightness': luminance(p.background) > .4 ? '21%' : '88%'
    };
  }
  function applyAppearance(target, settings) {
    const { design, theme, colors: paletteId } = normalizeAppearance(settings);
    target.dataset.design = design; target.dataset.dashboardTheme = theme; target.dataset.colors = paletteId;
    const mode = luminance(colors.find(item => item.id === paletteId).background) > .4 ? 'light' : 'dark';
    target.dataset.theme = mode; target.style.colorScheme = mode;
    for (const [key, value] of Object.entries(paletteVariables(paletteId))) target.style.setProperty(key, value);
  }
  function createPicker(axis, entries, initial, onChoose) {
    const labelText = { design: 'Design', theme: 'Theme', colors: 'Colors' }[axis];
    const picker = document.createElement('div'); picker.className = 'theme-picker ' + axis + '-picker';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'toolbar-button appearance-toggle ' + axis + '-toggle';
    const caption = document.createElement('span'); caption.className = 'appearance-label'; caption.textContent = labelText + ': ';
    const selected = document.createElement('span'); selected.className = 'appearance-value';
    // Overlay the catalog labels in one hidden grid cell. Its intrinsic width
    // reserves the longest rendered name, including future catalog additions.
    const reserve = document.createElement('span'); reserve.className = 'appearance-value-reserve'; reserve.setAttribute('aria-hidden', 'true');
    for (const entry of entries) { const name = document.createElement('span'); name.textContent = entry.name; reserve.append(name); }
    const caret = document.createElement('span'); caret.className = 'appearance-caret'; caret.setAttribute('aria-hidden', 'true'); caret.textContent = '▾';
    trigger.append(caption, reserve, selected, caret);
    trigger.setAttribute('aria-label', 'Choose ' + axis); trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', axis + '-menu');
    const menu = document.createElement('div'); menu.id = axis + '-menu'; menu.className = 'theme-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', labelText);
    const label = document.createElement('div'); label.className = 'theme-menu-heading'; label.textContent = { design: 'ARRANGE THE WORK', theme: 'STYLE THE INTERFACE', colors: 'SET THE PALETTE' }[axis]; menu.append(label);
    let value = initial;
    const options = entries.map((entry, index) => {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'theme-option'; option.dataset[axis] = entry.id;
      option.setAttribute('role', 'menuitemradio'); option.setAttribute('aria-label', entry.name); option.setAttribute('aria-describedby', axis + '-description-' + entry.id);
      const swatch = document.createElement('span'); swatch.className = 'theme-swatch swatch-' + axis + ' swatch-' + entry.id; swatch.setAttribute('aria-hidden', 'true');
      if (axis === 'colors') { swatch.style.background = entry.background; swatch.style.color = entry.foreground; swatch.style.boxShadow = 'inset 5px 0 ' + entry.accent; swatch.textContent = 'Aa'; }
      const copy = document.createElement('span'); copy.className = 'theme-option-copy';
      const name = document.createElement('strong'); name.textContent = entry.name;
      const type = document.createElement('span'); type.className = 'theme-option-type'; type.textContent = entry.type;
      const description = document.createElement('small'); description.id = axis + '-description-' + entry.id; description.textContent = entry.description;
      copy.append(name, type, description); option.append(swatch, copy);
      option.onclick = () => { value = entry.id; update(value); close(); onChoose(entry.id); trigger.focus({ preventScroll: true }); };
      option.onkeydown = event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % entries.length : event.key === 'ArrowUp' ? (index + entries.length - 1) % entries.length : undefined;
        if (next !== undefined) { event.preventDefault(); options[next].focus(); }
      };
      menu.append(option); return option;
    });
    function place() {
      if (menu.hidden) return;
      const box = trigger.getBoundingClientRect(), width = Math.min(380, innerWidth - 32);
      menu.style.width = width + 'px'; menu.style.left = Math.max(16, Math.min(box.right - width, innerWidth - width - 16)) + 'px';
      const below = innerHeight - box.bottom - 24, above = box.top - 24;
      const upwards = below < 180 && above > below;
      menu.style.maxHeight = Math.max(100, Math.min(620, upwards ? above : below)) + 'px';
      menu.style.top = upwards ? 'auto' : box.bottom + 8 + 'px'; menu.style.bottom = upwards ? innerHeight - box.top + 8 + 'px' : 'auto';
    }
    function close() { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    function open() { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); place(); const current = options.find(option => option.dataset[axis] === value); current.focus({ preventScroll: true }); current.scrollIntoView({ block: 'nearest' }); }
    function update(next) {
      value = next; selected.textContent = entries.find(entry => entry.id === next).name;
      trigger.title = labelText + ': ' + entries.find(entry => entry.id === next).name;
      trigger.setAttribute('aria-description', 'Current: ' + entries.find(entry => entry.id === next).name);
      for (const option of options) option.setAttribute('aria-checked', String(option.dataset[axis] === next));
    }
    trigger.onclick = () => menu.hidden ? open() : close();
    trigger.onkeydown = event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } };
    picker.onkeydown = event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); } };
    picker.onfocusout = event => { if (!picker.contains(event.relatedTarget)) close(); };
    document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) close(); });
    window.addEventListener('resize', place); window.addEventListener('scroll', place, { passive: true });
    picker.append(trigger, menu); update(initial); close();
    return { element: picker, update };
  }
  const api = { designs, themes, colors, normalizeAppearance, paletteVariables, applyAppearance, createPicker };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.agentobsThemes = api;
})(globalThis);

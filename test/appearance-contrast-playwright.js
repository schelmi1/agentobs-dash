'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');
const { designs, themes, colors } = require('../public/appearance');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-contrast-'));
  const session = (id, extra = {}) => ({ id, currentTask: 'Review the agent workspace', cwd: root, provider: 'fixture', providerLabel: 'Codex', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString(), agentName: id, tokenUsage: { input: 12345, cachedInput: 4000, output: 800 }, ...extra });
  const adapter = { id: 'fixture', async scan() { return { sessions: [
    session('main', { currentTool: { id: 'exec', name: 'exec_command', label: 'Exec · npm', status: 'in_progress' }, toolHistory: [{ id: 'read', name: 'read', label: 'Read', status: 'completed' }] }),
    session('wait', { parentId: 'main', needsInput: true }),
    session('fail', { parentId: 'main', attentionState: 'failed' }),
    session('past', { status: 'completed' })
  ], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 30000 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    for (const design of designs) {
      await page.goto(url);
      await page.evaluate(id => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: id })), design.id);
      await page.reload(); await page.waitForSelector('.agent');
      assert.equal(await page.locator('html').getAttribute('data-design'), design.id);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of themes) for (const palette of colors) {
          const failures = await page.evaluate(({ design, theme, color }) => {
            window.agentobsThemes.applyAppearance(document.documentElement, { design, theme, colors: color });
            const selectors = ['.agent .task-title', '.modern-task', '.agent .status', '.thinking-pill', '.tool-badge', '.modern-action-text', '.modern-state', '.modern-call-title strong', '.summary-pill', '.metric > span', '.metric strong', '.workspace-trigger-label', '.toolbar-button', '.phase-label', '.modern-tokens', '.modern-node-id', '.modern-nav-label', '.modern-call-actor', '.modern-call-time', '.modern-provider-label'];
            const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
            canvas.width = canvas.height = 1;
            const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
            const over = (a, b) => { const alpha = a[3] / 255; return [0, 1, 2].map(i => a[i] * alpha + b[i] * (1 - alpha)); };
            const luminance = rgb => rgb.map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
            // Exercise every tool hue, including those absent from the fixture.
            const samples = document.createElement('div');
            Object.assign(samples.style, { position: 'fixed', left: '0', top: '0', width: '100%', display: 'flex', flexWrap: 'wrap', background: getComputedStyle(document.querySelector('.agent')).backgroundColor });
            for (let i = 0; i < 37; i++) {
              const badge = document.createElement('span'); badge.className = 'tool-badge tool-color-' + i; badge.textContent = 'Tool'; samples.append(badge);
              const current = badge.cloneNode(true); current.classList.add('is-current'); samples.append(current);
              if (design === 'modern') {
                const call = document.createElement('div'), title = document.createElement('span'), label = document.createElement('strong');
                call.className = 'modern-call tool-color-' + i; title.className = 'modern-call-title'; label.textContent = 'Tool'; title.append(label); call.append(title); samples.append(call);
              }
            }
            document.body.append(samples);
            const providerSamples = document.createElement('div');
            for (const provider of ['codex', 'copilot-vscode', 'claude-code', 'opencode']) {
              const label = document.createElement('span'); label.className = 'modern-eyebrow modern-provider-label'; label.dataset.provider = provider; label.textContent = provider; providerSamples.append(label);
            }
            document.querySelector('.modern-run-header')?.append(providerSamples);
            const failures = [];
            for (const badge of samples.querySelectorAll('.tool-badge:not(.is-current)')) {
              if (getComputedStyle(badge).color !== getComputedStyle(badge.nextElementSibling).color) failures.push({ selector: badge.className, contrast: 'current tool changed hue' });
            }
            for (const selector of selectors) for (const node of document.querySelectorAll(selector)) {
              const style = getComputedStyle(node), rect = node.getBoundingClientRect();
              if (!node.textContent.trim() || rect.width < 1 || rect.height < 1 || style.visibility !== 'visible' || node.closest('[hidden], :disabled, [aria-disabled=true]')) continue;
              const ancestors = []; for (let parent = node; parent; parent = parent.parentElement) ancestors.push(parent);
              if (ancestors.some(parent => Number(getComputedStyle(parent).opacity) < .99)) continue;
              let background = [255, 255, 255];
              for (const parent of ancestors.reverse()) background = over(rgba(getComputedStyle(parent).backgroundColor), background);
              const foreground = over(rgba(style.color), background), a = luminance(foreground), b = luminance(background);
              const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
              if (contrast < 4.5) failures.push({ selector, contrast: Math.round(contrast * 100) / 100 });
            }
            samples.remove(); providerSamples.remove(); return failures;
          }, { design: design.id, theme: theme.id, color: palette.id });
          assert.deepEqual(failures, [], `${design.name} / ${theme.name} / ${palette.name} / ${width}px`);
        }
      }
    }
    console.log(`PASS text contrast across ${designs.length} design, ${themes.length} themes, ${colors.length} palettes and desktop/phone fixtures`);
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

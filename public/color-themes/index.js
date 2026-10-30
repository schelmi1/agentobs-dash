(function (root) {
  'use strict';

  // Add palettes here; the picker, CSS variables and browser matrix use this list.
  const colors = [
    {
      id: 'dark', name: 'Dark',
      background: '#1f1f1f', sidebar: '#181818', card: '#252526',
      foreground: '#cccccc', muted: '#9d9d9d', border: '#2b2b2b',
      accent: '#4daafc', green: '#89d185', amber: '#cca700', red: '#f48771', input: '#313131'
    },
    {
      id: 'light', name: 'Light',
      background: '#ffffff', sidebar: '#f8f8f8', card: '#f3f3f3',
      foreground: '#3b3b3b', muted: '#616161', border: '#e5e5e5',
      accent: '#0059a5', green: '#2f7d2b', amber: '#895800', red: '#c72e2e', input: '#ffffff'
    },
    {
      id: 'dark-plus', name: 'Dark+',
      background: '#1e1e1e', sidebar: '#252526', card: '#252526',
      foreground: '#d4d4d4', muted: '#a0a0a0', border: '#454545',
      accent: '#4fc1ff', green: '#89d185', amber: '#cca700', red: '#f48771', input: '#3c3c3c'
    },
    {
      id: 'light-plus', name: 'Light+',
      background: '#ffffff', sidebar: '#f3f3f3', card: '#f8f8f8',
      foreground: '#333333', muted: '#616161', border: '#cecece',
      accent: '#005c9b', green: '#2f7d2b', amber: '#895800', red: '#c72e2e', input: '#ffffff'
    },
    {
      id: 'solarized-light', name: 'Solarized Light',
      description: 'Warm ivory surfaces with Solarized blue and olive accents.',
      background: '#fdf6e3', sidebar: '#eee8d5', card: '#f7f0e0',
      foreground: '#485c62', muted: '#50646a', border: '#d3cbb7',
      accent: '#17629a', green: '#657800', amber: '#876500', red: '#c12e2a', input: '#fffbf2'
    },
    {
      id: 'monokai', name: 'Monokai',
      description: 'Charcoal and olive surfaces with bright cyan, lime and pink accents.',
      background: '#272822', sidebar: '#1e1f1c', card: '#34352f',
      foreground: '#f8f8f2', muted: '#a6a395', border: '#494a41',
      accent: '#66d9ef', green: '#a6e22e', amber: '#e6db74', red: '#ff7299', input: '#414339'
    },
    {
      id: 'linux-mint', name: 'Linux Mint', type: 'Terminal',
      description: 'Mint-inspired charcoal surfaces, pale text and green highlights.',
      background: '#1e1e1e', sidebar: '#171a17', card: '#252925',
      foreground: '#e0e5dc', muted: '#aab7a3', border: '#3f493b',
      accent: '#9ccc65', green: '#8fd46b', amber: '#e5c76b', red: '#ef8585', input: '#2c332a'
    },
    {
      id: 'ubuntu', name: 'Ubuntu', type: 'Terminal',
      description: 'Warm charcoal with a hint of aubergine and Ubuntu-orange highlights.',
      // Lightened orange remains readable as interactive text on dark surfaces.
      background: '#211f20', sidebar: '#1b181a', card: '#2b282a',
      foreground: '#f5f5f5', muted: '#bcb5b8', border: '#4c4548',
      accent: '#ff9866', green: '#8bcf85', amber: '#e3ba66', red: '#ff827c', input: '#353033'
    }
  ].map(color => ({ type: 'VS Code', description: 'Adapted from VS Code’s built-in palette.', ...color }));

  if (typeof module === 'object' && module.exports) module.exports = colors;
  else root.agentobsColors = colors;
})(globalThis);

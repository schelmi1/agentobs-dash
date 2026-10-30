(function (root) {
  'use strict';
  const { element, button, reconcile } = root.agentobsDom;
  const elapsedSince = (iso) => {
    const timestamp = Date.parse(iso || '');
    if (!Number.isFinite(timestamp)) return 'Time unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    return Math.floor(seconds / 86400) + 'd';
  };
  const exactFormatter = new Intl.NumberFormat();
  const compactFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const exactCount = (count) => Number.isFinite(count) ? exactFormatter.format(count) : '—';
  const shortCount = (count) => Number.isFinite(count) ? compactFormatter.format(count).toLowerCase() : '—';
  const exactUsage = (usage) => 'Input: ' + exactCount(usage.input) + ' · Cached: ' + exactCount(usage.cachedInput) + ' · Output: ' + exactCount(usage.output);
  const bytes = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
  const toolDuration = tool => {
    const start = Date.parse(tool.startedAt || tool.timestamp || '');
    const end = tool.status === 'in_progress' ? Date.now() : Date.parse(tool.completedAt || '');
    const recorded = tool.status !== 'in_progress' ? tool.details?.durationMs : undefined;
    const milliseconds = Number.isFinite(recorded) ? recorded : Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
    if (milliseconds === undefined) return undefined;
    if (milliseconds < 1000) return Math.round(milliseconds) + ' ms';
    if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + 's';
    return Math.floor(milliseconds / 60000) + 'm ' + Math.floor((milliseconds % 60000) / 1000) + 's';
  };
  const failureLabels = { timeout: 'Timeout', permission: 'Permission denied', cancelled: 'Cancelled', process: 'Process failed', tool: 'Tool failed' };
  const toolResultSummary = (details = {}) => {
    const parts = [];
    if (details.testsPassed !== undefined && details.testsFailed !== undefined) {
      parts.push(exactCount(details.testsPassed) + ' passed', exactCount(details.testsFailed) + ' failed');
      if (details.testsSkipped) parts.push(exactCount(details.testsSkipped) + ' skipped');
    }
    if (details.matches !== undefined) parts.push(exactCount(details.matches) + ' matches' + (details.matchedFiles !== undefined ? ' in ' + exactCount(details.matchedFiles) + ' files' : ''));
    if (details.patchFiles !== undefined) parts.push('Patch scope: ' + exactCount(details.patchFiles) + (details.patchFiles === 1 ? ' file' : ' files'), '+' + exactCount(details.patchLinesAdded) + (details.patchLinesRemoved !== undefined ? ' −' + exactCount(details.patchLinesRemoved) : ''));
    if (details.linesRead !== undefined) parts.push(exactCount(details.linesRead) + ' lines read');
    if (details.bytesRead !== undefined) parts.push(bytes(details.bytesRead) + ' read');
    if (details.results !== undefined) parts.push(exactCount(details.results) + ' results');
    if (details.agentsStarted !== undefined) parts.push(exactCount(details.agentsStarted) + ' agents started');
    if (details.agentsFinished !== undefined) parts.push(exactCount(details.agentsFinished) + ' agents finished');
    if (details.failure && failureLabels[details.failure]) parts.push(failureLabels[details.failure]);
    if (!parts.length && details.outputBytes !== undefined) parts.push(exactCount(details.outputLines) + ' lines output', bytes(details.outputBytes));
    if (details.outputTruncated) parts.push('output truncated');
    return parts.join(' · ');
  };
  const toolColors = new Map(Object.entries({ exec: 0, exec_command: 0, read: 1, apply_patch: 2, view_image: 3, spawn_agent: 4, send_message: 5, wait_agent: 6, wait: 7, write_stdin: 8, request_user_input: 9, search_query: 10, web_search_call: 10, tool_search_call: 11, followup_task: 12, list_agents: 13, interrupt_agent: 14, request_user_input_async: 15 }));
  const execCommands = 'git rg npm pnpm yarn node npx sed find ls cat head tail curl docker python python3 cargo go make code'.split(' ');
  const toolColorClass = (tool) => {
    const name = String(tool.name || 'tool');
    const type = name.split('.').at(-1).toLowerCase();
    const command = ['exec', 'exec_command'].includes(type) ? tool.label?.split(' · ')[1]?.toLowerCase() : undefined;
    const commandIndex = execCommands.indexOf(command);
    // Exec aliases share the command's color, rather than one color for all commands.
    const color = commandIndex >= 0 ? 16 + commandIndex
      : toolColors.get(type) ?? [...name].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 16, 0);
    return 'tool-color-' + color;
  };
  const toolBadge = (tool, className = '', detailed = false) => {
    const name = String(tool.name || 'tool');
    const label = detailed && tool.details?.command ? (tool.label || name).split(' · ')[0] + ' · ' + tool.details.command : tool.label || name;
    const node = element('span', 'tool-badge ' + toolColorClass(tool) + (className ? ' ' + className : ''), label);
    node.title = name;
    return node;
  };
  function createViews({ getState, getUi, actions, elements, labels, badge, syncInspectorResizer }) {
    const { closeInspector } = actions;
    const { inspector, inspectorResizer, layout } = elements;
    const definitionList = (pairs) => {
      const list = element('dl', 'detail-list');
      for (const [label, value] of pairs) { list.append(element('dt', '', label), element('dd', '', value || '—')); }
      return list;
    };
    const renderInspector = () => {
      const state = getState(), ui = getUi();
      const agent = state.agents[ui.selected];
      inspector.hidden = !agent;
      inspectorResizer.hidden = !agent;
      layout.classList.toggle('has-inspector', Boolean(agent));
      document.body.classList.toggle('has-inspector', Boolean(agent));
      if (!agent) { reconcile(inspector, []); return; }
      const header = element('div', 'inspector-header', undefined, 'header');
      header.append(element('span', 'eyebrow', 'AGENT DETAILS'), button('Close ×', 'toolbar-button', closeInspector));
      const content = element('div', 'inspector-content', undefined, agent.id);
      const inspectorTitle = element('h2', '', agent.title); content.append(inspectorTitle);
      if (!['working', 'tool'].includes(agent.displayState)) content.append(badge(agent));
      content.append(element('p', 'inspector-phase' + (agent.phaseLabel === 'Thinking' ? ' thinking-pill' : ''), agent.phaseLabel));
      if (agent.progress) { content.append(element('h3', '', 'Latest update'), element('p', 'inspector-progress', agent.progress)); }
      const milestones = agent.activityTimeline.filter((event) => event.kind !== 'tool').slice(-8).reverse();
      if (milestones.length) {
        content.append(element('h3', '', 'Handoffs and milestones'));
        const timeline = element('ul', 'milestones');
        for (const event of milestones) {
          const entry = element('li'); entry.append(element('span', '', event.label));
          if (event.timestamp) entry.append(element('time', '', new Date(event.timestamp).toLocaleTimeString()));
          timeline.append(entry);
        }
        content.append(timeline);
      }
      if (agent.tokenUsage) {
        content.append(element('h3', '', 'Token usage'));
        const tokens = element('div', 'token-stats');
        for (const [label, value] of [['Input', agent.tokenUsage.input], ['Cached', agent.tokenUsage.cachedInput], ['Output', agent.tokenUsage.output]]) {
          const stat = element('div'); stat.append(element('span', '', label), element('strong', '', exactCount(value))); tokens.append(stat);
        }
        content.append(tokens);
      }
      content.append(element('h3', '', 'Tool history · ' + agent.toolHistory.length));
      if (!agent.toolHistory.length) content.append(element('p', 'secondary', 'No tool calls recorded yet.'));
      else {
        const tools = element('div', 'tool-history', undefined, 'tools');
        for (const [index, tool] of agent.toolHistory.slice().reverse().entries()) {
          const details = element('details', 'tool-entry', undefined, tool.id || tool.name + ':' + tool.timestamp + ':' + index);
          const line = element('summary');
          const info = tool.details || {};
          const toolStatus = { in_progress: 'Running', failed: 'Failed', cancelled: 'Cancelled', unknown: 'No result' }[tool.status] || (info.testsPassed > 0 && info.testsFailed === 0 ? 'Passed' : 'Done');
          const header = element('span', 'tool-summary-header');
          const metadata = element('span', 'tool-meta');
          const duration = toolDuration(tool);
          if (duration) { const time = element('span', 'tool-duration', duration); time.title = tool.status === 'in_progress' ? 'Elapsed time' : 'Duration'; metadata.append(time); }
          metadata.append(element('span', 'tool-state ' + (tool.status === 'failed' ? 'tool-failed' : toolStatus === 'Passed' ? 'tool-passed' : ''), toolStatus));
          header.append(toolBadge(tool, 'tool-name'), metadata); line.append(header);
          const resultSummary = toolResultSummary(info);
          if (resultSummary) line.append(element('span', 'tool-result-summary', resultSummary));
          const pairs = [
            ['Tool', tool.name], ['Outcome', toolStatus], [tool.status === 'in_progress' ? 'Elapsed' : 'Duration', duration],
            ['Started', tool.startedAt || tool.timestamp ? new Date(tool.startedAt || tool.timestamp).toLocaleString() : undefined],
            ['Finished', tool.completedAt ? new Date(tool.completedAt).toLocaleString() : undefined]
          ];
          if (info.command) pairs.push(['Command', info.command]);
          if (info.exitCode !== undefined) pairs.push(['Exit code', String(info.exitCode)]);
          if (info.failure && failureLabels[info.failure]) pairs.push(['Failure', failureLabels[info.failure]]);
          if (info.execution) pairs.push(['Execution', { elevated: 'Elevated permissions', default: 'Default permissions' }[info.execution]]);
          if (info.directoryScope) pairs.push(['Directory', { workspace: 'Session workspace', external: 'Outside session workspace' }[info.directoryScope]]);
          if (info.attempt !== undefined) pairs.push(['Attempt', String(info.attempt) + (info.maxAttempts !== undefined ? ' of ' + info.maxAttempts : '')]);
          if (info.testsTotal !== undefined) pairs.push(['Tests', exactCount(info.testsTotal)]);
          if (info.outputBytes !== undefined) pairs.push(['Output', exactCount(info.outputLines) + ' lines · ' + bytes(info.outputBytes) + (info.outputTruncated ? ' · truncated' : '')]);
          details.append(line, definitionList(pairs)); tools.append(details);
        }
        content.append(tools);
      }
      content.append(element('h3', '', 'Session'), definitionList([
        ['Agent', agent.name], ['Session', agent.shortId], ['Path', agent.agentPath], ['Workspace', agent.cwd],
        ['Last activity', agent.lastActivity ? new Date(agent.lastActivity).toLocaleString() : undefined]
      ]));
      content.append(element('h3', '', 'Transcript'), definitionList([
        ['Provider', agent.providerLabel || 'Codex'], ['Provider version', agent.transcript.version], ['Parser status', agent.transcript.supportLevel.replace('_', ' ')],
        ['Resolved by', agent.transcript.resolution]
      ]));
      if (agent.warning) content.append(element('p', 'warning', agent.warning));
      reconcile(inspector, [header, content]);
      requestAnimationFrame(syncInspectorResizer);
    };
    return { renderInspector };
  }
  root.agentobsViews = { createViews, toolColorClass };
})(globalThis);

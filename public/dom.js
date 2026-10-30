(function (root) {
  'use strict';
  const element = (tag, className, text, key) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (key !== undefined) node.dataset.key = key;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className, text);
    node.type = 'button'; node.onclick = action;
    return node;
  };
  // Retain keyed DOM nodes across polls, including focus, scroll and open tool details.
  const reconcile = (parent, nextChildren) => {
    const focused = document.activeElement;
    const previous = [...parent.childNodes];
    const keyed = new Map(previous.filter((node) => node.nodeType === 1 && node.dataset.key !== undefined).map((node) => [node.dataset.key, node]));
    const kept = new Set();
    nextChildren.forEach((next, index) => {
      const key = next.nodeType === 1 ? next.dataset.key : undefined;
      let current = key !== undefined ? keyed.get(key) : previous[index];
      if (current && (kept.has(current) || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || (key === undefined && current.nodeType === 1 && current.dataset.key !== undefined))) current = undefined;
      if (!current) current = next;
      else if (current.nodeType === 3) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      } else {
        for (const attribute of [...current.attributes]) {
          if (attribute.name !== 'open' && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        }
        for (const attribute of [...next.attributes]) {
          if (attribute.name !== 'open' && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        current.ontoggle = next.ontoggle;
        current.onclick = next.onclick;
        current.onkeydown = next.onkeydown;
        current.onchange = next.onchange;
        reconcile(current, [...next.childNodes]);
      }
      kept.add(current);
      if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
    });
    for (const node of previous) if (!kept.has(node)) node.remove();
    if (focused?.isConnected && parent.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };

  root.agentobsDom = { element, button, reconcile };
})(globalThis);

(function (root) {
  'use strict';
  // Own the panel's interaction lifecycle independently of card rendering.
  function createController({ inspector, map, resizer, background, onClose }) {
    const compact = matchMedia('(max-width: 760px)');
    let open = false, modal = false, opener, requestFocus = false;
    const closeButton = () => inspector.querySelector('.inspector-header button');
    const focusPanel = () => closeButton()?.focus({ preventScroll: true });
    const sync = () => {
      const nextOpen = !inspector.hidden, nextModal = nextOpen && compact.matches;
      for (const node of background) node.inert = nextModal;
      resizer.inert = nextModal;
      inspector.setAttribute('role', nextModal ? 'dialog' : 'complementary');
      if (nextModal) inspector.setAttribute('aria-modal', 'true'); else inspector.removeAttribute('aria-modal');
      document.body.classList.toggle('has-modal-inspector', nextModal);
      const focus = nextOpen && (requestFocus || nextModal && (!open || !modal));
      open = nextOpen; modal = nextModal; requestFocus = false;
      if (focus) focusPanel();
    };
    const keydown = event => {
      if (!open) return;
      if (modal && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); return; }
      if (!modal || event.key !== 'Tab') return;
      const controls = [...inspector.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[hidden], [inert]'));
      const first = controls[0], last = controls.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (active === first || !inspector.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !inspector.contains(active))) { event.preventDefault(); first.focus(); }
    };
    const focusin = event => { if (modal && !inspector.contains(event.target)) focusPanel(); };
    window.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    window.addEventListener('keydown', event => {
      if (open && !modal && event.key === 'Escape' && !event.defaultPrevented && !document.querySelector(':popover-open') && event.target.type !== 'search') onClose();
    });
    compact.addEventListener('change', sync);
    return {
      sync,
      opening(card, keyboard) { opener = card; requestFocus = Boolean(keyboard || compact.matches); },
      restoreFocus() {
        const target = opener?.isConnected && opener.getClientRects().length ? opener : map;
        if (target === map) map.tabIndex = -1;
        target.focus({ preventScroll: true }); opener = undefined;
      }
    };
  }
  root.agentobsInspector = { createController };
})(globalThis);

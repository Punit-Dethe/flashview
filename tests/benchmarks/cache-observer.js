(() => {
  const state = { started: performance.now(), completions: {} };
  window.__cacheBenchmark = state;
  const collect = () => {
    const live = new Set();
    for (const card of document.querySelectorAll('.document-row[data-file-id]')) {
      const id = card.dataset.fileId;
      live.add(id);
      // aria-valuenow rounds near-complete files up to 100. Only the explicit
      // class indicates the application's persisted-cache completion state.
      if (card.querySelector('.cache-ring.is-complete')) {
        state.completions[id] ??= performance.now() - state.started;
      } else {
        delete state.completions[id];
      }
    }
    for (const id of Object.keys(state.completions)) {
      if (!live.has(id)) delete state.completions[id];
    }
  };
  new MutationObserver(collect).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-file-id'],
  });
  collect();
})();

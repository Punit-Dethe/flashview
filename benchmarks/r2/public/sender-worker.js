/* Source hashing and upload stay off the UI thread. Never generates OS downloads. */
self.onmessage = async ({ data }) => {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  const tasks = [];
  try {
    const { file, pilot, token } = data;
    if (!(file instanceof File) || file.size < 1 || file.size > 200 * 1024 * 1024)
      throw Error('Choose a file between 1 byte and 200 MiB.');
    const hashBlockBytes = 8 * 1024 * 1024;
    const hashes = [];
    for (let offset = 0; offset < file.size; offset += hashBlockBytes) {
      const block = await file.slice(offset, offset + hashBlockBytes).arrayBuffer();
      hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', block)),
        value => value.toString(16).padStart(2, '0')).join(''));
      self.postMessage({ type: 'progress', stage: 'hashing', bytes: Math.min(offset + hashBlockBytes, file.size), total: file.size });
    }
    const hashingMs = performance.now() - started;
    const checked = async (url, options) => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw Error('Transfer request failed (' + response.status + '). Check the invitation, connection and test limits.');
      return response.json();
    };
    const admitted = await checked('/api/pilots/' + pilot + '/runs', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, hashes, hashBlockBytes }),
    });
    const uploadStarted = performance.now();
    const headers = { Authorization: 'Bearer ' + admitted.token };
    const base = '/api/runs/' + admitted.id;
    let nextPart = 1;
    let uploaded = 0;
    const count = Math.ceil(file.size / admitted.partBytes);
    self.postMessage({ type: 'progress', stage: 'uploading', bytes: 0, total: file.size });
    for (let lane = 0; lane < Math.min(4, count); lane++) tasks.push((async () => {
      for (;;) {
        const part = nextPart++;
        if (part > count || controller.signal.aborted) return;
        const bytes = file.slice((part - 1) * admitted.partBytes, part * admitted.partBytes);
        await checked(base + '/parts/' + part, { method: 'PUT', headers, body: bytes });
        uploaded += bytes.size;
        self.postMessage({ type: 'progress', stage: 'uploading', bytes: uploaded, total: file.size });
      }
    })());
    await Promise.all(tasks);
    self.postMessage({ type: 'progress', stage: 'committing', bytes: uploaded, total: file.size });
    await checked(base + '/complete', { method: 'POST', headers });
    self.postMessage({ type: 'result', ok: true, id: admitted.id, hashingMs,
      uploadMs: performance.now() - uploadStarted, elapsedMs: performance.now() - started });
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    self.postMessage({ type: 'result', ok: false, error: String(error?.message ?? error) });
  } finally {
    clearTimeout(timeout);
    self.close();
  }
};

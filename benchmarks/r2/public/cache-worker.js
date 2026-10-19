/* Benchmark receiver: private OPFS only, bounded 8 MiB verification buffers.
 * No rendering code, save picker, or download navigation is involved.
 */
self.onmessage = async ({ data }) => {
  let root;
  let writer;
  let reader;
  let result;
  let metadataRequests = 0;
  let originalRequests = 0;
  let succeeded = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), data.timeoutMs);
  const started = performance.now();
  const hashBytes = async bytes => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0'),
  ).join('');
  try {
    if (!navigator.storage?.getDirectory) throw Error('OPFS unavailable in this browser');
    root = await (await navigator.storage.getDirectory()).getDirectoryHandle('flashview-benchmark', { create: true });
    const handle = await root.getFileHandle(data.id, { create: true });
    writer = await handle.createSyncAccessHandle();
    writer.truncate(0);
    const headers = { Authorization: 'Bearer ' + data.token };
    const snapshot = async () => {
      metadataRequests++;
      const response = await fetch('/api/runs/' + data.id, { headers, signal: controller.signal });
      if (!response.ok) throw Error('Transfer state unavailable');
      const state = await response.json();
      if (state.state === 'deleting') throw Error('Transfer cancelled');
      return state;
    };
    const block = new Uint8Array(data.hashBlockBytes);
    let used = 0;
    let received = 0;
    let blockIndex = 0;
    let lastProgress = 0;
    const commitBlock = async () => {
      const bytes = block.subarray(0, used);
      if (await hashBytes(bytes) !== data.hashes[blockIndex++]) throw Error('Original SHA-256 mismatch');
      let written = 0;
      while (written < bytes.length) {
        const count = writer.write(bytes.subarray(written), { at: received - used + written });
        if (count <= 0) throw Error('Browser cache write made no progress');
        written += count;
      }
      writer.flush();
      used = 0;
      if (data.keepCache && performance.now() - lastProgress > 100) {
        self.postMessage({ type: 'progress', bytes: received, total: data.size });
        lastProgress = performance.now();
      }
    };
    const segmented = data.layout === 'segments';
    const sourceCount = segmented ? Math.ceil(data.size / data.partBytes) : 1;
    for (let part = 1; part <= sourceCount; part++) {
      if (segmented) {
        while (!(await snapshot()).parts.includes(part)) await new Promise(resolve => setTimeout(resolve, 250));
      }
      originalRequests++;
      const response = await fetch('/api/runs/' + data.id + '/file' + (segmented ? '?part=' + part : ''), {
        headers, signal: controller.signal,
      });
      const expectedLength = segmented ? Math.min(data.partBytes, data.size - (part - 1) * data.partBytes) : data.size;
      if (!response.ok || Number(response.headers.get('Content-Length')) !== expectedLength)
        throw Error('Original unavailable or unexpected size');
      reader = response.body.getReader();
      let sourceBytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sourceBytes += value.length;
        if (sourceBytes > expectedLength || received + value.length > data.size) throw Error('Original exceeds declared size');
        let offset = 0;
        while (offset < value.length) {
          const count = Math.min(block.length - used, value.length - offset);
          block.set(value.subarray(offset, offset + count), used);
          used += count; received += count; offset += count;
          if (used === block.length) await commitBlock();
        }
      }
      if (sourceBytes !== expectedLength) throw Error('Original is truncated');
      reader.releaseLock(); reader = null;
    }
    if (received !== data.size) throw Error('Original is truncated');
    if (used) await commitBlock();
    if (blockIndex !== data.hashes.length) throw Error('Invalid integrity manifest');
    if (segmented) {
      while ((await snapshot()).state !== 'ready') await new Promise(resolve => setTimeout(resolve, 250));
    }
    writer.close(); writer = null;
    const committedAtMs = performance.now() - started;
    // Read back persisted bytes, so an apparently successful write alone is
    // insufficient for the benchmark's independently verified completion.
    const file = await handle.getFile();
    if (file.size !== data.size) throw Error('Cached size differs from original');
    for (let offset = 0, index = 0; offset < file.size; offset += data.hashBlockBytes, index++) {
      if (await hashBytes(await file.slice(offset, offset + data.hashBlockBytes).arrayBuffer()) !== data.hashes[index])
        throw Error('Persisted browser cache SHA-256 mismatch');
    }
    result = { ok: true, bytes: received, committedAtMs, metadataRequests, originalRequests,
      verifiedAtMs: performance.now() - started, storage: 'private-opfs' };
    succeeded = true;
  } catch (error) {
    controller.abort();
    result = { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    try { writer?.close(); } catch { result = { ok: false, error: 'Browser cache close failed' }; succeeded = false; }
    // Automated runs discard their cache; manual tests retain verified files.
    // Partial or corrupt receipts are always removed.
    if (!succeeded || !data.keepCache) await root?.removeEntry(data.id).catch(() => {});
    self.postMessage(result);
    self.close();
  }
};
self.postMessage({ type: 'ready' });

// One ortho tile at a time: fetch, decode, hand the ImageBitmap back to web/ortho-clipmap.js. The clipmap draws from
// the main thread (the canvases are its), so the network and the WebP decode stay here and a slow tile never janks a
// frame. Messages: {jobs: [{key, url}]} in, {key, bytes, bmp} or {key, error} out, one per job, in order.
self.onmessage = async ({ data }) => {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  for (const job of jobs) {
    try {
      const response = await fetch(job.url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText || ''}`.trim());
      const buf = await response.arrayBuffer();
      // A zero-byte body is a broken deploy, not an empty tile: decode would throw and the clipmap would remember a
      // failure, which is exactly right.
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
      self.postMessage({ key: job.key, bytes: buf.byteLength, bmp }, [bmp]);
    } catch (e) {
      self.postMessage({ key: job.key, error: String((e && e.message) || e) });
    }
  }
};

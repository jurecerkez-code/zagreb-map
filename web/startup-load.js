// Work that must not compete with the city's first four packs. A failed optional layer reports its error
// and does not poison the next job. A named build job is registered at most once, even if two callers request it.
export function makeStartupQueue({ idle, order = null, onError = (error, key) => console.warn(`${key} did not load`, error) }) {
  if (typeof idle !== 'function') throw new TypeError('An idle scheduler is required');
  let released = false, reveal;
  const afterReveal = new Promise(resolve => { reveal = resolve; });
  let chain = afterReveal;
  const jobs = new Map(), pending = new Map();
  function schedule(key, work) {
    const deferred = pending.get(key);
    pending.delete(key);
    const result = chain.then(() => idle()).then(work);
    chain = result.catch(error => onError(error, key));
    result.then(deferred.resolve, deferred.reject);
  }
  return {
    add(key, work) {
      if (jobs.has(key)) return jobs.get(key);
      const deferred = Promise.withResolvers();
      jobs.set(key, deferred.promise);
      pending.set(key, deferred);
      deferred.work = work;
      if (released) schedule(key, work);
      return deferred.promise;
    },
    release() {
      if (!released) {
        released = true;
        const keys = order
          ? [...order.filter(key => pending.has(key)), ...[...pending.keys()].filter(key => !order.includes(key))]
          : [...pending.keys()];
        for (const key of keys) schedule(key, pending.get(key).work);
        reveal();
      }
      return Promise.allSettled([...jobs.values()]);
    },
    get released() { return released; },
  };
}

export const localRtAllowed = host => ['localhost', '127.0.0.1'].includes(String(host).toLowerCase());
export const buildInfoAllowed = host => String(host).toLowerCase() === 'jurecerkez-code.github.io';

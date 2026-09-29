import { useEffect, useState } from 'react';

// 宏观数据只在盘后同步时变化：同一页面内缓存 5 分钟，切换图表不重复请求
const cache = new Map(); // ds -> { at, promise }
const TTL = 5 * 60_000;

function fetchDataset(ds) {
  const hit = cache.get(ds);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = fetch(`/api/macro?ds=${ds}`).then((r) => r.json());
  cache.set(ds, { at: Date.now(), promise });
  promise.catch(() => cache.delete(ds));
  return promise;
}

/** 拉取一组数据集：返回 { data: { ds: rows }, error }；每 5 分钟自动刷新一次 */
export function useMacro(datasets) {
  const key = datasets.join(',');
  const [res, setRes] = useState({ key: null, data: null, error: null });

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all(datasets.map(fetchDataset))
      .then((list) => {
        if (!alive) return;
        const error = list.find((x) => x.error)?.error ?? null;
        setRes({ key, data: Object.fromEntries(list.map((x, i) => [datasets[i], x.rows ?? []])), error });
      })
      .catch((err) => alive && setRes({ key, data: null, error: err.message }));
    load();
    const t = setInterval(load, TTL);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 切换图表时不显示上一张图的数据
  return res.key === key ? res : { data: null, error: null };
}

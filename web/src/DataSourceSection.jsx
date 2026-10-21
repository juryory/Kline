import { useEffect, useState } from 'react';

export default function DataSourceSection({ canSwitch }) {
  const [info, setInfo] = useState(null);
  const [choice, setChoice] = useState('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch('/api/data-source');
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '读取数据源失败');
        if (alive) { setInfo(data); setChoice(data.source); }
      } catch (err) { if (alive) setError(err.message); }
    };
    load();
    window.addEventListener('kline-source-changed', load);
    return () => { alive = false; window.removeEventListener('kline-source-changed', load); };
  }, []);
  const apply = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/data-source', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: choice }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || '切换失败');
      setInfo(data);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <section>
    <h3>行情数据源</h3>
    <div className="param-row">
      <span className="param-name">当前数据源</span>
      <div className="param-inputs">
        <select aria-label="行情数据源" value={choice} disabled={!canSwitch || busy || !info}
          onChange={(e) => setChoice(e.target.value)}>
          {!['local', 'ifind'].includes(info?.source) && <option value={info?.source || ''}>{info?.source || '加载中'}</option>}
          {(info?.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="add" onClick={apply} disabled={!canSwitch || busy || !info || choice === info.source}>
          {busy ? '切换中…' : '切换'}
        </button>
      </div>
    </div>
    <p className="note">切换后立即生效并保存，服务器日常同步也使用所选数据源。切换本身不触发拉取。</p>
    <p className="note">iFinD：境内指数、行业、概念、ETF 支持日线和分时；个股仅日线。新数据写入独立库，缺失历史读取 Tushare 旧库，统一不复权。</p>
    <p className="note">宏观数据来自 iFinD 经济数据库，iFinD 没有的期数和指标用 Tushare 补。</p>
    <p className="note">同花顺概念排行：板块列表、成分股、涨停来自 iFinD（常规概念），不展示主力净额；申万一级排行仍读 Tushare。</p>
    <p className="note">期货、外汇（沪金、原油、美元指数等）只有日线；海外指数尚未启用。</p>
    {info && !info.ifindConfigured && <p className="note">尚未配置 iFinD 凭证：可以切换查看已有历史；服务器配置 IFIND_REFRESH_TOKEN 后才能同步新数据。</p>}
    {!canSwitch && <p className="note">切换数据源需要管理员账号。</p>}
    {error && <p className="param-error">{error}</p>}
  </section>;
}

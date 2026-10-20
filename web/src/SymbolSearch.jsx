import { useEffect, useState } from 'react';

const CATEGORY_LABEL = {
  THN: '同花顺概念', THI: '同花顺行业', THR: '同花顺地域', THS: '同花顺特色',
  THST: '同花顺风格', THTH: '同花顺主题', THBB: '同花顺宽基',
  FUT_CN: '国内期货', FUT_GL: '海外期货', FX: '外汇',
};

/**
 * 标的检索框（类似行情软件的"键盘精灵"）。
 * 支持代码 / 名称 / 拼音首字母 / 全拼，匹配规则在 server/symbols.js。
 * ↑↓ 选择，Enter 确认，Esc 取消。
 */
export default function SymbolSearch({ inputRef, query, setQuery, onSelect }) {
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((list) => { setResults(list); setActive(0); })
        .catch(() => {});
    }, 60);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const close = () => {
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };
  const choose = (s) => {
    if (!s) return;
    onSelect(s);
    close();
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法选词中
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <div className="search">
      <input
        ref={inputRef}
        value={query}
        placeholder="代码 / 名称 / 拼音，直接敲键盘即可"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      {open && query.trim() && (
        <ul>
          {results.length === 0 && <li className="empty">没有匹配的标的</li>}
          {results.map((s, i) => (
            <li
              key={s.code}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
            >
              <span className="code">{s.code}</span>
              <span className="name">{s.name}</span>
              <span className="type">{CATEGORY_LABEL[s.category] ?? (s.type === 'index' ? '指数' : '股票')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect } from 'react';
import { useLive } from './useLive.js';
import { contentSize, safeAreaFill, DEFAULT_SAFE_AREA } from '../../shared/settings.js';
import { renderUrl } from './auth.js';
import BroadcastPanel from './BroadcastPanel.jsx';
import RankPanel from './RankPanel.jsx';
import MacroPanel from './MacroPanel.jsx';

/**
 * vMix 浏览器源。画面尺寸由导播台「设置」决定（默认 966×320），
 * vMix 里浏览器源的宽高要和设置保持一致。
 */
export default function RenderPage({ preview }) {
  const { state, data, status, rank, hover, auth } = useLive(preview ? 'preview' : 'render');

  // 登录后直接打开 /render 是靠 Cookie 通过的，地址栏没有 key，复制到 vMix 会打不开：补上 ?key=
  useEffect(() => {
    if (preview || !auth?.renderKey || new URLSearchParams(location.search).has('key')) return;
    history.replaceState(null, '', renderUrl(auth.renderKey) + location.hash);
  }, [preview, auth?.renderKey]);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
  }, []);

  if (!state) return null;
  const { width, height } = state.settings.render;
  const safe = state.settings.safeArea;
  // 画面底色：K 线面板和两侧安全区外（直播时容易被裁掉，只铺底色，内容放在中间）用同一个颜色
  const fill = safeAreaFill(safe ?? DEFAULT_SAFE_AREA);
  // 安全区外靠内容一侧的边框：画在安全区外里面（最宽不超过安全区外），不占内容宽度
  const border = safe?.borderWidth ? `${Math.min(safe.borderWidth, safe.side)}px solid ${safe.borderColor}` : undefined;
  const side = (edge) => safe?.side ? (
    <div style={{ width: safe.side, height, flex: 'none', boxSizing: 'border-box', background: fill, [edge]: border }} />
  ) : null;

  // 最上方横边框：横跨 K 线和两侧安全区外，盖在画面上（不改变内容高度）
  const top = safe?.topWidth ? (
    <div style={{ position: 'absolute', left: 0, top: 0, width, height: safe.topWidth, background: safe.topColor, zIndex: 1 }} />
  ) : null;
  const { brand, headFont } = state.settings;

  // 导播"隐藏"时渐隐；导播台预览里保留半透明
  const opacity = state.visible ? 1 : preview ? 0.35 : 0;

  return (
    <div style={{
      position: 'relative', width, height, opacity, transition: 'opacity 400ms ease', display: 'flex', '--panel-bg': fill,
      ...(brand && { '--brand-size': brand.size, '--brand-color': brand.color }),
      ...(headFont && { '--font-name': headFont.name, '--font-price': headFont.price, '--font-pct': headFont.pct }),
    }}>
      {top}
      {side('borderRight')}
      <div style={{ width: contentSize(state.settings).width, height, flex: 'none' }}>
        {state.scene === 'rank' ? rank && <RankPanel rank={rank} state={state} />
          : state.scene === 'macro' ? <MacroPanel state={state} hover={hover} />
            : data && <BroadcastPanel data={data} state={state} status={status} />}
      </div>
      {side('borderLeft')}
    </div>
  );
}

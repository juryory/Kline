import { useEffect } from 'react';
import { useLive } from './useLive.js';
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

  // 导播"隐藏"时渐隐；导播台预览里保留半透明
  const opacity = state.visible ? 1 : preview ? 0.35 : 0;

  return (
    <div style={{ width, height, opacity, transition: 'opacity 400ms ease' }}>
      {state.scene === 'rank' ? rank && <RankPanel rank={rank} state={state} />
        : state.scene === 'macro' ? <MacroPanel state={state} hover={hover} />
          : data && <BroadcastPanel data={data} state={state} status={status} />}
    </div>
  );
}

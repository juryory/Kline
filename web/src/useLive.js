import { useCallback, useEffect, useRef, useState } from 'react';
import { withKey } from './auth.js';

/**
 * 连接后端 WebSocket，断线自动重连。
 * 断线期间保留最后一次的 state/data —— 渲染页不会因为网络抖动而黑屏。
 */
export function useLive(role) {
  const [state, setState] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [rank, setRank] = useState(null); // 上屏的板块排名
  const [hover, setHover] = useState(null); // 导播台宏观图的悬停位置 { scope, view, index }
  const [connected, setConnected] = useState(false);
  const [auth, setAuth] = useState(null);           // 本连接的身份 { role, user }
  const [authError, setAuthError] = useState(null); // 'unauthorized' | 'origin'：被服务端拒绝
  const wsRef = useRef(null);

  useEffect(() => {
    let closed = false;
    let timer;
    let retry = 0;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(withKey(`${proto}://${location.host}/ws?role=${role}`));
      wsRef.current = ws;

      ws.onopen = () => { retry = 0; setConnected(true); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'auth') { setAuth({ role: msg.role, user: msg.user }); setAuthError(null); }
        else if (msg.type === 'state') setState(msg.state);
        else if (msg.type === 'data') setData(msg);
        else if (msg.type === 'status') setStatus(msg);
        else if (msg.type === 'rank') setRank(msg);
        else if (msg.type === 'hover') setHover(msg);
      };
      ws.onerror = () => ws.close();
      ws.onclose = (e) => {
        setConnected(false);
        // 4401 未登录 / 已过期，4403 来源不允许：重连也没用，放慢重试（重新登录后会自动连上）
        const denied = e.code === 4401 ? 'unauthorized' : e.code === 4403 ? 'origin' : null;
        if (denied) setAuthError(denied);
        if (!closed) timer = setTimeout(connect, denied ? 10_000 : Math.min(500 * 2 ** retry++, 5000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [role]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, data, status, rank, hover, connected, send, auth, authError };
}

// 直播画面（vMix 浏览器源）的只读 key：/render?key=xxx，原样带给 WebSocket 和接口。
// 导播台靠登录 Cookie，同域名请求浏览器会自动带上，不需要这里处理。
const KEY = new URLSearchParams(location.search).get('key');

export const withKey = (url) => (KEY ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}` : url);

/** 直播画面地址：有 key 时带上，可直接贴进 vMix */
export const renderUrl = (key) => `${location.origin}/render${key ? `?key=${encodeURIComponent(key)}` : ''}`;

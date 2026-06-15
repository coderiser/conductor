import { PROTOCOL_VERSION } from './messages.js';

export function negotiateVersion(clientVersion: number): number {
  // 简单策略：取最小值
  return Math.min(clientVersion, PROTOCOL_VERSION);
}

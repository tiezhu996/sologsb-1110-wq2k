import type { BoardPair, PairReview, WoodBoard } from '../types/wood-board';

/** 由阴干年限推算含水率（%）：阴干越久含水率越低，收敛到 5% 左右 */
export function moisturePctOf(dryYears: number): number {
  const years = Number(dryYears) || 0;
  const pct = 14.5 - years * 1.15;
  return Number(Math.min(14.5, Math.max(5, pct)).toFixed(1));
}

/** 是否为可用板材：无裂纹且阴干 ≥ 3 年 */
export function boardUsable(board: WoodBoard): boolean {
  return board.defect !== '裂纹' && board.dryYears >= 3;
}

/** 换料容差：厚度差超过 2mm 或含水率差超过 1.5% 的配对先存为待定 */
export const SWAP_THICKNESS_TOLERANCE_MM = 2;
export const SWAP_MOISTURE_TOLERANCE_PCT = 1.5;

/** 换入新板与留存板是否超差（超差则配对存为待定，复核确认后才恢复） */
export function swapOutOfTolerance(incoming: WoodBoard, remaining: WoodBoard): boolean {
  const thicknessDiff = Math.abs(incoming.thicknessMm - remaining.thicknessMm);
  const moistureDiff = Math.abs(moisturePctOf(incoming.dryYears) - moisturePctOf(remaining.dryYears));
  return thicknessDiff > SWAP_THICKNESS_TOLERANCE_MM || moistureDiff > SWAP_MOISTURE_TOLERANCE_PCT;
}

/** 汇总配对两侧板材的复核状态：待定 > 待复核 > 正常 */
export function pairReviewOf(boards: Array<WoodBoard | undefined>): PairReview {
  const flags = boards.map((b) => b?.review ?? 'normal');
  if (flags.includes('pending')) return 'pending';
  if (flags.includes('review')) return 'review';
  return 'normal';
}

/** 面板与底板按琴号配对（琴号为空的在库板材不参与配对） */
export function pairBoards(boards: WoodBoard[]): BoardPair[] {
  const map = new Map<string, BoardPair>();
  boards.forEach((board) => {
    if (!board.guqinNo) return;
    const pair = map.get(board.guqinNo) ?? {
      guqinNo: board.guqinNo,
      species: board.species,
      moisturePct: 0,
      matched: false,
      review: 'normal' as PairReview,
    };
    if (board.part === '面板') {
      pair.panel = board;
    } else {
      pair.base = board;
    }
    map.set(board.guqinNo, pair);
  });

  return Array.from(map.values())
    .map((pair) => {
      const matched = Boolean(pair.panel && pair.base);
      const years = Math.max(pair.panel?.dryYears ?? 0, pair.base?.dryYears ?? 0);
      const review = pairReviewOf([pair.panel, pair.base]);
      return { ...pair, matched, review, moisturePct: moisturePctOf(years) };
    })
    .sort((a, b) => a.guqinNo.localeCompare(b.guqinNo));
}

/** 面板/底板厚度差（mm），差值过大需再刨削 */
export function thicknessGap(pair: BoardPair): number {
  if (!pair.panel || !pair.base) {
    return 0;
  }
  return Number(Math.abs(pair.panel.thicknessMm - pair.base.thicknessMm).toFixed(1));
}

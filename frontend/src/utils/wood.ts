import type { BoardPair, BoardStatus, WoodBoard } from '../types/wood-board';

/** 换料容差：新旧板厚度差超过 2mm 先存待定 */
export const SWAP_THICKNESS_TOLERANCE_MM = 2;
/** 换料容差：新旧板含水率差超过 1.5% 先存待定 */
export const SWAP_MOISTURE_TOLERANCE_PCT = 1.5;

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

/** 板材状态（旧数据无 status 字段时按琴号推导：有琴号为已配对，否则在库） */
export function boardStatusOf(board: WoodBoard): BoardStatus {
  return board.status ?? (board.guqinNo ? '已配对' : '在库');
}

/** 是否待确认（待复核 / 待定）：所在配对退出选材完成 */
export function boardPending(board: WoodBoard): boolean {
  const status = boardStatusOf(board);
  return status === '待复核' || status === '待定';
}

/** 面板与底板按琴号配对（在库板材不参与配对） */
export function pairBoards(boards: WoodBoard[]): BoardPair[] {
  const map = new Map<string, BoardPair>();
  boards.forEach((board) => {
    if (!board.guqinNo) return;
    const pair = map.get(board.guqinNo) ?? {
      guqinNo: board.guqinNo,
      species: board.species,
      moisturePct: 0,
      matched: false,
      needsReview: false,
      pendingNote: '',
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
      const pendingBoards = [pair.panel, pair.base].filter((b): b is WoodBoard => Boolean(b && boardPending(b)));
      return {
        ...pair,
        matched,
        moisturePct: moisturePctOf(years),
        needsReview: pendingBoards.length > 0,
        pendingNote: pendingBoards
          .map((b) => `${b.part}${b.boardNo}：${b.reviewNote ?? boardStatusOf(b)}`)
          .join('；'),
      };
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

/** 换料校验结果 */
export interface SwapVerdict {
  /** 是否超差：超差先存待定，确认后才恢复选材完成 */
  pending: boolean;
  /** 新旧板厚度差（mm） */
  thicknessDiff: number;
  /** 新旧板含水率差（%） */
  moistureDiff: number;
  /** 超差原因 */
  reasons: string[];
}

/** 换料校验：新板与被换下的旧板（同部位）比较厚度与含水率 */
export function swapVerdict(oldBoard: WoodBoard, newBoard: WoodBoard): SwapVerdict {
  const thicknessDiff = Number(Math.abs(newBoard.thicknessMm - oldBoard.thicknessMm).toFixed(1));
  const moistureDiff = Number(Math.abs(moisturePctOf(newBoard.dryYears) - moisturePctOf(oldBoard.dryYears)).toFixed(1));
  const reasons: string[] = [];
  if (thicknessDiff > SWAP_THICKNESS_TOLERANCE_MM) {
    reasons.push(`厚度差 ${thicknessDiff}mm 超过 ${SWAP_THICKNESS_TOLERANCE_MM}mm`);
  }
  if (moistureDiff > SWAP_MOISTURE_TOLERANCE_PCT) {
    reasons.push(`含水率差 ${moistureDiff}% 超过 ${SWAP_MOISTURE_TOLERANCE_PCT}%`);
  }
  return { pending: reasons.length > 0, thicknessDiff, moistureDiff, reasons };
}
